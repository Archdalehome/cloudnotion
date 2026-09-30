/** Per-database permission resolution. */
import type { Role } from '../shared/types';
import { forbidden, notFound, sqlNumber, sqlString, type SqlRow } from './http';
import type { AccessLevel, AuthedUser, Env } from './types';

const LEVELS: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
const REQUIRED: Record<AccessLevel, number> = { view: 0, edit: 1, manage: 2 };

export interface DatabaseAccess {
  databaseId: string;
  ownerId: string;
  /** 请求者（用于解析筛选里的「当前用户」） */
  userId: string;
  role: Role;
  /** non-null when the user only sees a set of shared views */
  viewIds: string[] | null;
  /**
   * 「限制编辑」：只有分享时勾选了这个开关的访问者，对每个格子才只有一次修改机会。
   * 表格所有者、表格成员、以及没勾选「限制编辑」的分享都是 false（可以反复修改）。
   */
  limitCellEdits: boolean;
}

/**
 * Resolve the effective role of `userId` on `databaseId`.
 * Returns `null` when the user has no access at all (or database is gone).
 * Members first, then view level shares (定向分享) as a fallback.
 */
export async function resolveRole(
  env: Env,
  databaseId: string,
  userId: string,
): Promise<Role | null> {
  const row = await env.DB.prepare(
    `SELECT d.id, d.owner_id, m.role,
            (SELECT vs.role FROM view_shares vs
              WHERE vs.database_id = d.id AND vs.user_id = ? LIMIT 1) AS share_role
       FROM databases d
       LEFT JOIN database_members m ON m.database_id = d.id AND m.user_id = ?
      WHERE d.id = ? AND d.is_archived = 0`,
  )
    .bind(userId, userId, databaseId)
    .first<SqlRow>();
  if (!row) return null;
  if (sqlString(row, 'owner_id') === userId) return 'owner';
  const memberRole = sqlString(row, 'role');
  if (memberRole === 'editor' || memberRole === 'viewer') return memberRole;
  const shareRole = sqlString(row, 'share_role');
  if (shareRole === 'editor') return 'editor';
  if (shareRole === 'viewer') return 'viewer';
  return null;
}

/** Ids of the views (定向分享) that were individually shared with `userId`. */
export async function sharedViewIds(env: Env, databaseId: string, userId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT view_id FROM view_shares WHERE database_id = ? AND user_id = ?',
  )
    .bind(databaseId, userId)
    .all<SqlRow>();
  return (results ?? []).map((row) => sqlString(row, 'view_id')).filter(Boolean);
}

export async function requireDatabaseAccess(
  env: Env,
  databaseId: string,
  user: AuthedUser,
  level: AccessLevel = 'view',
): Promise<DatabaseAccess> {
  // 表级锁定（is_locked）功能已移除：字段与视图结构只由访问权与定向分享决定
  const row = await env.DB.prepare('SELECT owner_id, is_archived FROM databases WHERE id = ?')
    .bind(databaseId)
    .first<SqlRow>();
  if (!row || Number(row.is_archived ?? 0) === 1) throw notFound('表格不存在');
  const ownerId = sqlString(row, 'owner_id');

  if (ownerId === user.id) {
    return { databaseId, ownerId, userId: user.id, role: 'owner', viewIds: null, limitCellEdits: false };
  }

  const member = await env.DB.prepare('SELECT role FROM database_members WHERE database_id = ? AND user_id = ?')
    .bind(databaseId, user.id)
    .first<SqlRow>();
  const memberRole = member ? sqlString(member, 'role') : '';
  if (memberRole === 'editor' || memberRole === 'viewer') {
    // 表格成员不受「限制编辑」约束：那是分享链接 / 视图分享上的开关
    return { databaseId, ownerId, userId: user.id, role: memberRole, viewIds: null, limitCellEdits: false };
  }

  // fall back to view level shares: the user may only see the shared views
  const rows = await env.DB.prepare('SELECT view_id, role, limit_edits FROM view_shares WHERE database_id = ? AND user_id = ?')
    .bind(databaseId, user.id)
    .all<SqlRow>();
  if (!rows.results?.length) throw forbidden('没有权限访问该表格');
  const role: Role = rows.results.some((item) => sqlString(item, 'role') === 'editor') ? 'editor' : 'viewer';
  if (LEVELS[role] < REQUIRED[level]) throw forbidden('没有权限访问该表格');
  const editShares = rows.results.filter((item) => sqlString(item, 'role') === 'editor');
  // 只要有一个可编辑的视图分享没勾选「限制编辑」，这个用户就不受限制
  const limitCellEdits = editShares.length > 0 && editShares.every((item) => sqlNumber(item, 'limit_edits') === 1);
  return {
    databaseId,
    ownerId,
    userId: user.id,
    role,
    viewIds: rows.results.map((item) => sqlString(item, 'view_id')).filter(Boolean),
    limitCellEdits,
  };
}

/** Structure (fields / views) may only change for a fully shared table (定向分享除外). */
export function assertStructureEditable(access: DatabaseAccess): void {
  if (access.viewIds) throw forbidden('当前为视图定向分享，无法修改表格结构');
}

/** Verify that a view is inside the set of views a view-scoped member may touch. */
export function assertViewEditable(access: DatabaseAccess, viewId: string): void {
  if (access.viewIds && !access.viewIds.includes(viewId)) throw forbidden('没有权限修改该视图');
}

/** Load the owning database of a property and verify access. */
export async function accessForProperty(
  env: Env,
  propertyId: string,
  user: AuthedUser,
  level: AccessLevel,
): Promise<DatabaseAccess & { propertyId: string }> {
  const row = await env.DB.prepare('SELECT database_id FROM properties WHERE id = ?')
    .bind(propertyId)
    .first<SqlRow>();
  if (!row) throw notFound('字段不存在');
  const databaseId = sqlString(row, 'database_id');
  const access = await requireDatabaseAccess(env, databaseId, user, level);
  return { ...access, propertyId };
}

/** Load the owning database of a record and verify access. */
export async function accessForRecord(
  env: Env,
  recordId: string,
  user: AuthedUser,
  level: AccessLevel,
): Promise<DatabaseAccess & { recordId: string }> {
  const row = await env.DB.prepare('SELECT database_id FROM records WHERE id = ? AND is_archived = 0')
    .bind(recordId)
    .first<SqlRow>();
  if (!row) throw notFound('记录不存在');
  const databaseId = sqlString(row, 'database_id');
  const access = await requireDatabaseAccess(env, databaseId, user, level);
  return { ...access, recordId };
}

/** Load the owning database of a view and verify access. */
export async function accessForView(
  env: Env,
  viewId: string,
  user: AuthedUser,
  level: AccessLevel,
): Promise<DatabaseAccess & { viewId: string }> {
  const row = await env.DB.prepare('SELECT database_id FROM views WHERE id = ?')
    .bind(viewId)
    .first<SqlRow>();
  if (!row) throw notFound('视图不存在');
  const databaseId = sqlString(row, 'database_id');
  const access = await requireDatabaseAccess(env, databaseId, user, level);
  return { ...access, viewId };
}

/** Load the owning database of a share and verify access. */
export async function accessForShare(
  env: Env,
  shareId: string,
  user: AuthedUser,
  level: AccessLevel = 'manage',
): Promise<DatabaseAccess & { shareId: string }> {
  const row = await env.DB.prepare('SELECT database_id FROM shares WHERE id = ?')
    .bind(shareId)
    .first<SqlRow>();
  if (!row) throw notFound('分享链接不存在');
  const databaseId = sqlString(row, 'database_id');
  const access = await requireDatabaseAccess(env, databaseId, user, level);
  return { ...access, shareId };
}

export function canEdit(role: Role): boolean {
  return LEVELS[role] >= REQUIRED.edit;
}

export function isOwner(role: Role): boolean {
  return role === 'owner';
}

/* --------------------------------------------------------------- share links */

export interface ShareAccess {
  shareId: string;
  databaseId: string;
  permission: 'view' | 'edit';
  /** 创建链接时勾选了「限制编辑」：访客对每个格子只有一次修改机会 */
  limitEdits: boolean;
}

/** Resolve a public share token (used by the read-only `/share/:token` pages). */
export async function resolveShareToken(env: Env, token: string): Promise<ShareAccess | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.id, s.database_id, s.permission, s.limit_edits, s.expires_at, d.is_archived
       FROM shares s JOIN databases d ON d.id = s.database_id
      WHERE s.token = ?`,
  )
    .bind(token)
    .first<SqlRow>();
  if (!row) return null;
  if (sqlNumber(row, 'is_archived') === 1) return null;
  const expiresAt = row.expires_at;
  if (expiresAt !== null && expiresAt !== undefined && sqlNumber(row, 'expires_at') < Date.now()) return null;
  const permission: 'view' | 'edit' = sqlString(row, 'permission', 'view') === 'edit' ? 'edit' : 'view';
  return {
    shareId: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    permission,
    // 只读链接本来就不能改，「限制编辑」只对可编辑链接有意义
    limitEdits: permission === 'edit' && sqlNumber(row, 'limit_edits') === 1,
  };
}

