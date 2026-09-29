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
  /** structure lock: fields / views are read-only while true */
  locked: boolean;
  /** non-null when the user only sees a set of shared views */
  viewIds: string[] | null;
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
  const row = await env.DB.prepare('SELECT owner_id, is_archived, is_locked FROM databases WHERE id = ?')
    .bind(databaseId)
    .first<SqlRow>();
  if (!row || Number(row.is_archived ?? 0) === 1) throw notFound('表格不存在');
  const ownerId = sqlString(row, 'owner_id');
  const locked = sqlNumber(row, 'is_locked') === 1;

  if (ownerId === user.id) {
    return { databaseId, ownerId, userId: user.id, role: 'owner', locked, viewIds: null };
  }

  const member = await env.DB.prepare('SELECT role FROM database_members WHERE database_id = ? AND user_id = ?')
    .bind(databaseId, user.id)
    .first<SqlRow>();
  const memberRole = member ? sqlString(member, 'role') : '';
  if (memberRole === 'editor' || memberRole === 'viewer') {
    return { databaseId, ownerId, userId: user.id, role: memberRole, locked, viewIds: null };
  }

  // fall back to view level shares: the user may only see the shared views
  const rows = await env.DB.prepare('SELECT view_id, role FROM view_shares WHERE database_id = ? AND user_id = ?')
    .bind(databaseId, user.id)
    .all<SqlRow>();
  if (!rows.results?.length) throw forbidden('没有权限访问该表格');
  const role: Role = rows.results.some((item) => sqlString(item, 'role') === 'editor') ? 'editor' : 'viewer';
  if (LEVELS[role] < REQUIRED[level]) throw forbidden('没有权限访问该表格');
  return {
    databaseId,
    ownerId,
    userId: user.id,
    role,
    locked,
    viewIds: rows.results.map((item) => sqlString(item, 'view_id')).filter(Boolean),
  };
}

/** Structure (fields / views) may only change while the table is unlocked and fully shared. */
export function assertStructureEditable(access: DatabaseAccess): void {
  if (access.locked) throw forbidden('表格已锁定，字段与视图暂时无法修改');
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
}

/** Resolve a public share token (used by the read-only `/share/:token` pages). */
export async function resolveShareToken(env: Env, token: string): Promise<ShareAccess | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.id, s.database_id, s.permission, s.expires_at, d.is_archived
       FROM shares s JOIN databases d ON d.id = s.database_id
      WHERE s.token = ?`,
  )
    .bind(token)
    .first<SqlRow>();
  if (!row) return null;
  if (sqlNumber(row, 'is_archived') === 1) return null;
  const expiresAt = row.expires_at;
  if (expiresAt !== null && expiresAt !== undefined && sqlNumber(row, 'expires_at') < Date.now()) return null;
  return {
    shareId: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    permission: sqlString(row, 'permission', 'view') === 'edit' ? 'edit' : 'view',
  };
}

