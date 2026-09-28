/** /api/auth/* and GET /api/session */
import {
  assertSignupAllowed,
  clearedSessionCookie,
  createSession,
  destroySession,
  getCurrentUser,
  hashPassword,
  sessionCookie,
  validatePasswordStrength,
  verifyPassword,
  SESSION_COOKIE,
} from '../auth';
import {
  asString,
  badRequest,
  conflict,
  getCookie,
  json,
  newId,
  normalizeEmail,
  readJson,
  sqlString,
  unauthorized,
  type SqlRow,
} from '../http';
import type { Route, RequestContext } from '../types';
import { createStarterDatabase, listDatabases } from './databases';

function sessionResponse(user: { id: string; email: string; name: string } | null) {
  return { user };
}

async function registerHandler(ctx: RequestContext): Promise<Response> {
  const env = ctx.env;
  assertSignupAllowed(env);
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  const password = asString(body.password, '密码', { required: true, max: 200 });
  const fallbackName = email.split('@')[0];
  const name = asString(body.name, '昵称', { max: 60 }) || fallbackName;

  const problem = validatePasswordStrength(password);
  if (problem) throw badRequest(problem);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();
  if (existing) throw conflict('该邮箱已注册，请直接登录', 'email_exists');

  const userId = newId();
  const now = Date.now();
  const passwordHash = await hashPassword(password, env);
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(userId, email, name, passwordHash, now, now)
    .run();

  // give every new account a small starter table (like Notion's onboarding page)
  await createStarterDatabase(env, userId);

  const { token } = await createSession(env, userId);
  const response = json(
    { user: { id: userId, email, name } },
    { status: 201, headers: { 'set-cookie': sessionCookie(token) } },
  );
  return response;
}

async function loginHandler(ctx: RequestContext): Promise<Response> {
  const env = ctx.env;
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  const password = asString(body.password, '密码', { required: true, max: 200 });

  const row = await env.DB.prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();
  if (!row) throw unauthorized('邮箱或密码不正确');
  const ok = await verifyPassword(password, sqlString(row, 'password_hash'));
  if (!ok) throw unauthorized('邮箱或密码不正确');

  const userId = sqlString(row, 'id');
  const { token } = await createSession(env, userId);
  return json(
    { user: { id: userId, email: sqlString(row, 'email'), name: sqlString(row, 'name') } },
    { headers: { 'set-cookie': sessionCookie(token) } },
  );
}

async function logoutHandler(ctx: RequestContext): Promise<Response> {
  const token = getCookie(ctx.request, SESSION_COOKIE);
  if (token) await destroySession(ctx.env, token);
  return json({ ok: true }, { headers: { 'set-cookie': clearedSessionCookie() } });
}

async function sessionHandler(ctx: RequestContext): Promise<Response> {
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
  { method: 'POST', path: '/api/auth/login', handler: loginHandler },
  { method: 'POST', path: '/api/auth/logout', handler: logoutHandler },
  { method: 'GET', path: '/api/session', handler: sessionHandler },
];



