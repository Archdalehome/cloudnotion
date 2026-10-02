/**
 * /api/admin/* —— 用户管理（仅超级管理员）。
 *
 * 只有 `users.is_admin = 1` 的账号能访问，全部经过 `requireAdmin`：
 *   GET    /api/admin/users               注册用户列表（可按昵称 / 邮箱搜索、分页）
 *   PATCH  /api/admin/users/:id           修改某个用户的注册信息（昵称 / 邮箱）
 *   POST   /api/admin/users/:id/password  重置某个用户的密码（可指定，也可随机生成）
 *
 * 重置密码会让该用户在所有设备上立即下线，并尽力把新密码邮件通知给本人。
 */
import { hashPassword, requireAdmin, validatePasswordStrength } from '../auth';
import { loadAdminUser, loadAdminUsers } from '../admin';
import { passwordResetEmail, sendEmail, shouldEchoCode } from '../email';
import {
  asString,
  badRequest,
  conflict,
  json,
  normalizeEmail,
  notFound,
  readJson,
  sqlString,
  type SqlRow,
} from '../http';
import type { Route, RequestContext } from '../types';

/** 大小写字母 + 数字，去掉了容易看错的 I l 1 O 0 */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomIndex(max: number): number {
  const buffer = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  let value = 0;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0] ?? 0;
  } while (value >= limit);
  return value % max;
}

/** 生成一个满足强度要求（含字母与数字）的临时密码。 */
function generatePassword(length = 12): string {
  let password = '';
  for (let index = 0; index < length; index += 1) password += PASSWORD_ALPHABET[randomIndex(PASSWORD_ALPHABET.length)];
  if (!/\d/.test(password)) {
    const digit = String(randomIndex(10));
    const at = randomIndex(password.length);
    password = `${password.slice(0, at)}${digit}${password.slice(at + 1)}`;
  }
  return password;
}

async function listUsersHandler(ctx: RequestContext): Promise<Response> {
  await requireAdmin(ctx.request, ctx.env);
  const search = ctx.url.searchParams.get('search') ?? '';
  const limit = Number(ctx.url.searchParams.get('limit') ?? 50);
  const offset = Number(ctx.url.searchParams.get('offset') ?? 0);
  const { users, total } = await loadAdminUsers(ctx.env, { search, limit, offset });
  return json({ users, total, limit, offset, search });
}

async function updateUserHandler(ctx: RequestContext): Promise<Response> {
  const admin = await requireAdmin(ctx.request, ctx.env);
  const userId = ctx.params.id ?? '';
  const target = await ctx.env.DB.prepare('SELECT id, email, name FROM users WHERE id = ?')
    .bind(userId)
    .first<SqlRow>();
  if (!target) throw notFound('用户不存在');

  const body = await readJson(ctx.request);
  const nextName = body.name === undefined ? sqlString(target, 'name') : asString(body.name, '昵称', { required: true, max: 60 });

  let nextEmail = sqlString(target, 'email');
  if (body.email !== undefined) {
    nextEmail = normalizeEmail(body.email);
    if (nextEmail !== sqlString(target, 'email')) {
      const clash = await ctx.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
        .bind(nextEmail, userId)
        .first<SqlRow>();
      if (clash) throw conflict('该邮箱已被其它账号使用', 'email_exists');
    }
  }

  await ctx.env.DB.prepare('UPDATE users SET name = ?, email = ?, updated_at = ? WHERE id = ?')
    .bind(nextName, nextEmail, Date.now(), userId)
    .run();

  return json({ user: await loadAdminUser(ctx.env, userId), updatedSelf: admin.id === userId });
}

async function resetUserPasswordHandler(ctx: RequestContext): Promise<Response> {
  const admin = await requireAdmin(ctx.request, ctx.env);
  const userId = ctx.params.id ?? '';
  const target = await ctx.env.DB.prepare('SELECT id, email, name FROM users WHERE id = ?')
    .bind(userId)
    .first<SqlRow>();
  if (!target) throw notFound('用户不存在');

  const body = await readJson(ctx.request);
  const requested = body.password === undefined ? '' : asString(body.password, '新密码', { max: 200 });
  const password = requested || generatePassword();
  const problem = validatePasswordStrength(password);
  if (problem) throw badRequest(problem);

  await ctx.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(password, ctx.env), Date.now(), userId)
    .run();
  // 管理员重置密码多半是「账号被盗 / 用户忘了密码」，所有设备立即下线
  await ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();

  // 尽力把新密码发到用户邮箱；没配邮件服务时不发信，直接把密码回显给管理员
  const email = sqlString(target, 'email');
  let emailed = false;
  if (!shouldEchoCode(ctx.env, email)) {
    const delivery = await sendEmail(ctx.env, {
      ...passwordResetEmail(ctx.env, { name: sqlString(target, 'name'), password }),
      to: email,
    });
    emailed = delivery.ok;
  }

  return json({
    ok: true,
    password,
    emailed,
    sessionsRevoked: true,
    resetSelf: admin.id === userId,
    user: { id: userId, email, name: sqlString(target, 'name') },
  });
}

export const adminRoutes: Route[] = [
  { method: 'GET', path: '/api/admin/users', handler: listUsersHandler },
  { method: 'PATCH', path: '/api/admin/users/:id', handler: updateUserHandler },
  { method: 'POST', path: '/api/admin/users/:id/password', handler: resetUserPasswordHandler },
];
