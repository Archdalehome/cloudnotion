/**
 * 超级管理员账号的引导 + 用户列表查询。
 *
 * 管理员从环境变量来（`ADMIN_EMAIL` / `ADMIN_PASSWORD`），启动阶段不需要任何初始化动作：
 * 每次登录（以及带会话的 /api/session）都会调一次 `ensureAdminUser`，每个 isolate 只真正跑一次。
 *   - `ADMIN_EMAIL` 指定的账号不存在 → 用 `ADMIN_PASSWORD` 直接创建（已带 `is_admin = 1`）；
 *   - 已存在 → 提升为管理员；
 *   - `ADMIN_RESET_PASSWORD=true` 时用 `ADMIN_PASSWORD` 覆盖密码（改完记得去掉这个变量）。
 *
 * 密码只用于「首次创建」，之后请在界面上用「改密码」自行更换。
 */
import { hashPassword, validatePasswordStrength, verifyPassword } from './auth';
import { EMAIL_PATTERN, newId, sqlNullableNumber, sqlNumber, sqlString, type SqlRow } from './http';
import type { AdminUser } from '../shared/types';
import type { Env } from './types';

/** 用户列表一次最多返回多少条 */
const MAX_PAGE_SIZE = 100;

/** 环境变量里配置的管理员邮箱（不合法就当没配）。 */
export function adminEmailFrom(env: Env): string | null {
  const email = (env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  return email && EMAIL_PATTERN.test(email) ? email : null;
}

let bootstrap: { email: string; promise: Promise<void> } | null = null;

/** 让 `ADMIN_EMAIL` 指定的账号成为管理员（幂等；失败只记日志，不影响正常登录）。 */
export function ensureAdminUser(env: Env): Promise<void> {
  const email = adminEmailFrom(env);
  if (!email) return Promise.resolve();
  if (bootstrap?.email === email) return bootstrap.promise;

  const promise = bootstrapAdmin(env, email).catch((error) => {
    console.error('管理员账号引导失败:', error);
    if (bootstrap?.email === email) bootstrap = null; // 下次请求再试
  });
  bootstrap = { email, promise };
  return promise;
}

async function bootstrapAdmin(env: Env, email: string): Promise<void> {
  const desiredPassword = (env.ADMIN_PASSWORD ?? '').trim();
  const forceReset = (env.ADMIN_RESET_PASSWORD ?? '').toLowerCase() === 'true';
  const now = Date.now();

  const row = await env.DB.prepare('SELECT id, password_hash, is_admin FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();

  if (!row) {
    if (!desiredPassword) {
      console.warn(`管理员邮箱 ${email} 还没有账号，且未配置 ADMIN_PASSWORD，跳过自动创建`);
      return;
    }
    const problem = validatePasswordStrength(desiredPassword);
    if (problem) {
      console.warn(`ADMIN_PASSWORD 不符合密码要求（${problem}），跳过自动创建`);
      return;
    }
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, password_hash, created_at, updated_at, is_admin)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    )
      .bind(newId(), email, '管理员', await hashPassword(desiredPassword, env), now, now)
      .run();
    console.log(`已创建超级管理员账号 ${email}`);
    return;
  }

  const id = sqlString(row, 'id');
  if (sqlNumber(row, 'is_admin') !== 1) {
    await env.DB.prepare('UPDATE users SET is_admin = 1, updated_at = ? WHERE id = ?').bind(now, id).run();
    console.log(`已把 ${email} 提升为超级管理员`);
  }

  if (!forceReset || !desiredPassword) return;
  const problem = validatePasswordStrength(desiredPassword);
  if (problem) {
    console.warn(`ADMIN_PASSWORD 不符合密码要求（${problem}），跳过密码同步`);
    return;
  }
  if (await verifyPassword(desiredPassword, sqlString(row, 'password_hash'))) return;
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(desiredPassword, env), now, id)
    .run();
  console.log(`已按 ADMIN_PASSWORD 重置 ${email} 的密码（ADMIN_RESET_PASSWORD=true）`);
}

/* ------------------------------------------------------------ 用户列表查询 */

function adminUserFromRow(row: SqlRow): AdminUser {
  return {
    id: sqlString(row, 'id'),
    email: sqlString(row, 'email'),
    name: sqlString(row, 'name'),
    isAdmin: sqlNumber(row, 'is_admin') === 1,
    createdAt: sqlNumber(row, 'created_at'),
    updatedAt: sqlNumber(row, 'updated_at'),
    databaseCount: sqlNumber(row, 'database_count'),
    sharedCount: sqlNumber(row, 'shared_count'),
    lastSeenAt: sqlNullableNumber(row, 'last_seen_at'),
  };
}

/** 全部注册用户（可按昵称 / 邮箱搜索），管理员页面用。 */
export async function loadAdminUsers(
  env: Env,
  options: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ users: AdminUser[]; total: number }> {
  const search = (options.search ?? '').trim().slice(0, 60);
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), MAX_PAGE_SIZE);
  const offset = Math.max(Math.floor(options.offset ?? 0), 0);

  const filter = search ? 'WHERE (u.email LIKE ? OR u.name LIKE ?)' : '';
  const like = `%${search}%`;
  const binds = search ? [like, like] : [];

  const [countRow, { results }] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM users u ${filter}`)
      .bind(...binds)
      .first<SqlRow>(),
    env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.is_admin, u.created_at, u.updated_at,
              (SELECT COUNT(*) FROM databases d WHERE d.owner_id = u.id) AS database_count,
              (SELECT COUNT(*) FROM database_members m WHERE m.user_id = u.id) AS shared_count,
              (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
         FROM users u
         ${filter}
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(...binds, limit, offset)
      .all<SqlRow>(),
  ]);

  return { users: (results ?? []).map(adminUserFromRow), total: sqlNumber(countRow ?? {}, 'total') };
}

/** 单个用户（`PATCH /api/admin/users/:id` 的响应）。 */
export async function loadAdminUser(env: Env, userId: string): Promise<AdminUser | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.is_admin, u.created_at, u.updated_at,
            (SELECT COUNT(*) FROM databases d WHERE d.owner_id = u.id) AS database_count,
            (SELECT COUNT(*) FROM database_members m WHERE m.user_id = u.id) AS shared_count,
            (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
       FROM users u WHERE u.id = ?`,
  )
    .bind(userId)
    .first<SqlRow>();
  return row ? adminUserFromRow(row) : null;
}
