/**
 * /api/auth/* and GET /api/session
 *
 * 注册是两步的（邮箱确认码）：
 *   1. `POST /api/auth/register`        → 202 `{ pending: true, ... }`，只登记待确认的注册并发出 6 位确认码
 *   2. `POST /api/auth/register/verify` → 201 `{ user }`，校验确认码后才真正建账号并自动登录
 *   没收到邮件时可以 `POST /api/auth/register/resend` 重发（同一邮箱 60 秒一次）。
 */
import {
  assertSignupAllowed,
  clearedSessionCookie,
  createSession,
  currentSessionHash,
  destroySession,
  getCurrentUser,
  hashPassword,
  isSecureRequest,
  requireUser,
  sessionCookie,
  validatePasswordStrength,
  verifyPassword,
  SESSION_COOKIE,
} from '../auth';
import { ensureAdminUser } from '../admin';
import { emailFailure, sendEmail, shouldEchoCode, verificationCodeEmail } from '../email';
import { consumeSignupCode, issueSignupCode, resendSignupCode, type IssuedCode } from '../emailCodes';
import {
  asString,
  badRequest,
  conflict,
  getCookie,
  json,
  newId,
  normalizeEmail,
  readJson,
  sqlNumber,
  sqlString,
  unauthorized,
  type SqlRow,
} from '../http';
import type { Route, RequestContext, AuthedUser } from '../types';
import { createStarterDatabase, listDatabases } from './databases';

function sessionResponse(user: AuthedUser | null) {
  return { user };
}

/**
 * 发确认码：配了 `RESEND_API_KEY` 就真的发邮件；
 * 没配（本地开发）或收件人是保留测试域（`AUTH_ECHO_CODE_DOMAINS`，如 example.com）时，
 * 直接把确认码放在响应里回显，保证注册流程在任何环境都能走完。
 */
async function deliverSignupCode(
  ctx: RequestContext,
  email: string,
  name: string,
  issued: IssuedCode,
): Promise<Response> {
  const base = {
    email,
    ttlMinutes: issued.ttlMinutes,
    expiresInSeconds: Math.max(0, Math.round((issued.expiresAt - Date.now()) / 1000)),
  };

  if (shouldEchoCode(ctx.env, email)) {
    console.log(`[signup] ${email} 的确认码是 ${issued.code}（未发信：邮件服务未配置或测试域）`);
    return json({ pending: true, ...base, emailDelivered: false, devCode: issued.code }, { status: 202 });
  }

  const delivery = await sendEmail(ctx.env, {
    ...verificationCodeEmail(ctx.env, { code: issued.code, name, minutes: issued.ttlMinutes }),
    to: email,
  });
  if (!delivery.ok) emailFailure(delivery);
  return json({ pending: true, ...base, emailDelivered: true }, { status: 202 });
}

async function registerHandler(ctx: RequestContext): Promise<Response> {
  const env = ctx.env;
  assertSignupAllowed(env);
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  const password = asString(body.password, '密码', { required: true, max: 200 });
  const fallbackName = email.split('@')[0] || '用户';
  const name = asString(body.name, '昵称', { max: 60 }) || fallbackName;

  const problem = validatePasswordStrength(password);
  if (problem) throw badRequest(problem);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();
  if (existing) throw conflict('该邮箱已注册，请直接登录', 'email_exists');

  // 第一步只登记「待确认的注册」（昵称 + 已哈希的密码）并发确认码，
  // 确认之前 users 表里不会出现这个邮箱，也不会有半成品账号。
  const issued = await issueSignupCode(env, email, {
    name,
    passwordHash: await hashPassword(password, env),
  });
  return deliverSignupCode(ctx, email, name, issued);
}

async function verifyRegistrationHandler(ctx: RequestContext): Promise<Response> {
  const env = ctx.env;
  assertSignupAllowed(env);
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  const code = asString(body.code, '确认码', { required: true, max: 12 }).replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(code)) throw badRequest('确认码是 6 位数字', 'code_invalid');

  const pending = await consumeSignupCode(env, email, code);

  // 兜底：用户确认期间这个邮箱被别的请求注册掉了
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();
  if (existing) throw conflict('该邮箱已注册，请直接登录', 'email_exists');

  const userId = newId();
  const now = Date.now();
  const name = pending.name || email.split('@')[0] || '用户';
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, password_hash, created_at, updated_at, is_admin)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(userId, email, name, pending.passwordHash, now, now)
    .run();

  // give every new account a small starter table (like Notion's onboarding page)
  await createStarterDatabase(env, userId);

  const { token } = await createSession(env, userId);
  return json(
    { user: { id: userId, email, name, isAdmin: false }, emailVerified: true },
    { status: 201, headers: { 'set-cookie': sessionCookie(token, isSecureRequest(ctx.request)) } },
  );
}

async function resendRegistrationHandler(ctx: RequestContext): Promise<Response> {
  assertSignupAllowed(ctx.env);
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  const issued = await resendSignupCode(ctx.env, email);
  return deliverSignupCode(ctx, email, issued.name, issued);
}


async function loginHandler(ctx: RequestContext): Promise<Response> {
  const env = ctx.env;
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  const password = asString(body.password, '密码', { required: true, max: 200 });

  // ADMIN_EMAIL 指定的账号在这里被创建 / 提升为管理员（每个 isolate 只真正跑一次）
  await ensureAdminUser(env);

  const row = await env.DB.prepare('SELECT id, email, name, password_hash, is_admin FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();
  if (!row) throw unauthorized('邮箱或密码不正确');
  const ok = await verifyPassword(password, sqlString(row, 'password_hash'));
  if (!ok) throw unauthorized('邮箱或密码不正确');

  const userId = sqlString(row, 'id');
  const { token } = await createSession(env, userId);
  return json(
    {
      user: {
        id: userId,
        email: sqlString(row, 'email'),
        name: sqlString(row, 'name'),
        isAdmin: sqlNumber(row, 'is_admin') === 1,
      },
    },
    { headers: { 'set-cookie': sessionCookie(token, isSecureRequest(ctx.request)) } },
  );
}

async function logoutHandler(ctx: RequestContext): Promise<Response> {
  const token = getCookie(ctx.request, SESSION_COOKIE);
  if (token) await destroySession(ctx.env, token);
  return json({ ok: true }, { headers: { 'set-cookie': clearedSessionCookie(isSecureRequest(ctx.request)) } });
}

/** 登录后自助改密码：校验旧密码 → 换新哈希 → 其它设备的会话立即失效。 */
async function changePasswordHandler(ctx: RequestContext): Promise<Response> {
  const env = ctx.env;
  const user = await requireUser(ctx.request, env);
  const body = await readJson(ctx.request);
  const currentPassword = asString(body.currentPassword, '当前密码', { required: true, max: 200 });
  const newPassword = asString(body.newPassword, '新密码', { required: true, max: 200 });

  const problem = validatePasswordStrength(newPassword);
  if (problem) throw badRequest(problem);
  if (currentPassword === newPassword) throw badRequest('新密码不能与当前密码相同', 'password_unchanged');

  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id)
    .first<SqlRow>();
  if (!row) throw unauthorized();
  if (!(await verifyPassword(currentPassword, sqlString(row, 'password_hash')))) {
    throw badRequest('当前密码不正确', 'wrong_password');
  }

  const now = Date.now();
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(newPassword, env), now, user.id)
    .run();

  const keepHash = await currentSessionHash(ctx.request);
  await env.DB.prepare(
    keepHash
      ? 'DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'
      : 'DELETE FROM sessions WHERE user_id = ?',
  )
    .bind(...(keepHash ? [user.id, keepHash] : [user.id]))
    .run();

  return json({ ok: true, sessionsRevoked: true });
}

async function sessionHandler(ctx: RequestContext): Promise<Response> {
  // 管理员账号的引导只依赖环境变量，这里顺带跑一次，保证提升后重新加载页面就能看到「用户管理」
  await ensureAdminUser(ctx.env);

  const user = await getCurrentUser(ctx.request, ctx.env);
  if (!user) {
    return json({
      ...sessionResponse(null),
      databases: [],
      maxUploadMb: Number(ctx.env.MAX_UPLOAD_MB ?? 25),
      appName: ctx.env.APP_NAME ?? 'CloudNotion',
    });
  }
  const databases = await listDatabases(ctx.env, user.id);
  return json({
    ...sessionResponse(user),
    databases,
    maxUploadMb: Number(ctx.env.MAX_UPLOAD_MB ?? 25),
    appName: ctx.env.APP_NAME ?? 'CloudNotion',
  });
}

export const authRoutes: Route[] = [
  { method: 'POST', path: '/api/auth/register', handler: registerHandler },
  { method: 'POST', path: '/api/auth/register/verify', handler: verifyRegistrationHandler },
  { method: 'POST', path: '/api/auth/register/resend', handler: resendRegistrationHandler },
  { method: 'POST', path: '/api/auth/login', handler: loginHandler },
  { method: 'POST', path: '/api/auth/logout', handler: logoutHandler },
  { method: 'POST', path: '/api/auth/password', handler: changePasswordHandler },
  { method: 'GET', path: '/api/session', handler: sessionHandler },
];




