/** Password hashing (PBKDF2-SHA256 via WebCrypto) and cookie based sessions. */
import {
  base64UrlDecode,
  base64UrlEncode,
  forbidden,
  getCookie,
  newId,
  randomToken,
  serializeCookie,
  sha256Hex,
  sqlNumber,
  sqlString,
  unauthorized,
  type SqlRow,
} from './http';
import type { AuthedUser, Env } from './types';

export const SESSION_COOKIE = 'cn_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_ITERATIONS = 100_000;

function iterationsFrom(env: Env): number {
  const raw = (env as unknown as Record<string, unknown>).PASSWORD_ITERATIONS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : DEFAULT_ITERATIONS;
}

/* -------------------------------------------------------------- passwords */

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Format: `pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>` */
export async function hashPassword(password: string, env: Env): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iterations = iterationsFrom(env);
  const hash = await derive(password, salt, iterations);
  return ['pbkdf2', 'sha256', String(iterations), toBase64(salt), toBase64(hash)].join('$');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[2]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  try {
    const hash = await derive(password, fromBase64(parts[3]), iterations);
    return constantTimeEqual(toBase64(hash), parts[4]);
  } catch {
    return false;
  }
}

export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return '密码至少需要 8 个字符';
  if (password.length > 200) return '密码过长';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return '密码需同时包含字母和数字';
  return null;
}

/* --------------------------------------------------------------- sessions */

export async function createSession(
  env: Env,
  userId: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId(), userId, tokenHash, now, expiresAt, now)
    .run();
  return { token, expiresAt };
}

export async function destroySession(env: Env, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export async function getCurrentUser(request: Request, env: Env): Promise<AuthedUser | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.name
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<SqlRow>();
  if (!row) return null;
  const expiresAt = sqlNumber(row, 'expires_at');
  if (!expiresAt || expiresAt < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sqlString(row, 'session_id')).run();
    return null;
  }
  return {
    id: sqlString(row, 'id'),
    email: sqlString(row, 'email'),
    name: sqlString(row, 'name'),
  };
}

export async function requireUser(request: Request, env: Env): Promise<AuthedUser> {
  const user = await getCurrentUser(request, env);
  if (!user) throw unauthorized();
  return user;
}

export function sessionCookie(token: string): string {
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  });
}

export function clearedSessionCookie(): string {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0, httpOnly: true, secure: true, sameSite: 'Lax' });
}

/* ---------------------------------------------------------------- helpers */

export function assertSignupAllowed(env: Env): void {
  const allow = (env.ALLOW_SIGNUP ?? 'true').toLowerCase();
  if (allow === 'false') throw forbidden('注册功能已关闭，请联系管理员');
}

/** House-keeping: drop expired sessions (called from the worker entry point). */
export async function purgeExpiredSessions(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
}


export { base64UrlDecode, base64UrlEncode };
