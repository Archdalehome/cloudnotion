/** Per-database permission resolution. */
import type { Role } from '../shared/types';
import { forbidden, notFound, sqlNumber, sqlString, type SqlRow } from './http';
import type { AccessLevel, AuthedUser, Env } from './types';

const LEVELS: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
const REQUIRED: Record<AccessLevel, number> = { view: 0, edit: 1, manage: 2 };

export interface DatabaseAccess {
  databaseId: string;
  ownerId: string;
  role: Role;
}

/**
 * Resolve the effective role of `userId` on `databaseId`.
 * Returns `null` when the user has no access at all (or database is gone).
 */
export async function resolveRole(
  env: Env,
  databaseId: string,
  userId: string,
): Promise<Role | null> {
  const row = await env.DB.prepare(
    `SELECT d.id, d.owner_id, m.role
       FROM databases d
       LEFT JOIN database_members m ON m.database_id = d.id AND m.user_id = ?
      WHERE d.id = ? AND d.is_archived = 0`,
  )
    .bind(userId, databaseId)
    .first<SqlRow>();
  if (!row) return null;
  if (sqlString(row, 'owner_id') === userId) return 'owner';
  const memberRole = sqlString(row, 'role');
  if (memberRole === 'editor' || memberRole === 'viewer') return memberRole;
  return null;
}

export async function requireDatabaseAccess(
  env: Env,
  databaseId: string,
  user: AuthedUser,
  level: AccessLevel = 'view',
): Promise<DatabaseAccess> {
  const row = await env.DB.prepare('SELECT owner_id, is_archived FROM databases WHERE id = ?')
    .bind(databaseId)
    .first<SqlRow>();
  if (!row || Number(row.is_archived ?? 0) === 1) throw notFound('表格不存在');
  const ownerId = sqlString(row, 'owner_id');
  const role = ownerId === user.id ? 'owner' : await resolveRole(env, databaseId, user.id);
  if (!role || LEVELS[role] < REQUIRED[level]) {
    throw forbidden('没有权限访问该表格');
  }
  return { databaseId, ownerId, role };
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

