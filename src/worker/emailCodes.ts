/**
 * 邮件确认码（`email_codes` 表）。
 *
 * 注册是**两步**的：
 *   1. `POST /api/auth/register` 只把待确认的注册信息（昵称 + 已哈希的密码）挂在一条确认码记录上，
 *      同时把 6 位数字确认码发到邮箱；
 *   2. 用户把确认码填回 `POST /api/auth/register/verify`，这里校验通过后才由调用方真正插入 users 行。
 *
 * 所以没确认完的注册不会占用邮箱，也不会在管理员看到的用户列表里留下半成品账号。
 * 只存 `sha256(purpose:email:code)`，不存明文；同一邮箱 60 秒内只能发一次，
 * 单码最多试 5 次（超过即作废，防暴力猜码）。
 */
import { badRequest, newId, parseJsonObject, sha256Hex, sqlNumber, sqlString, tooManyRequests, type SqlRow } from './http';
import type { Env } from './types';

export type EmailCodePurpose = 'signup';

/** 待确认的注册信息（密码已经是 PBKDF2 哈希，不是明文） */
export interface PendingSignup {
  name: string;
  passwordHash: string;
}

export interface IssuedCode {
  code: string;
  expiresAt: number;
  ttlMinutes: number;
}

const DEFAULT_TTL_MINUTES = 15;
const MAX_ATTEMPTS = 5;
/** 同一邮箱两次发码的最小间隔（前端也按这个数字显示重发倒计时） */
export const RESEND_COOLDOWN_MS = 60_000;
const CODE_DIGITS = 6;

export function codeTtlMinutes(env: Env): number {
  const parsed = Number(env.AUTH_CODE_TTL_MINUTES);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 24 * 60 ? Math.floor(parsed) : DEFAULT_TTL_MINUTES;
}

/** 6 位数字确认码（避开 `Math.random`，并对 1e6 取模保证均匀）。 */
export function generateCode(): string {
  const buffer = new Uint32Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0] ?? 0;
  } while (value >= 4_000_000_000);
  return String(value % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
}

async function codeHash(email: string, purpose: EmailCodePurpose, code: string): Promise<string> {
  return sha256Hex(`${purpose}:${email}:${code}`);
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

/** 当前邮箱上仍然有效的那条确认码（没有就返回 null）。 */
async function activeCodeRow(env: Env, email: string, purpose: EmailCodePurpose): Promise<SqlRow | null> {
  return env.DB.prepare(
    `SELECT * FROM email_codes
      WHERE email = ? AND purpose = ? AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(email, purpose)
    .first<SqlRow>();
}

function payloadOf(row: SqlRow): PendingSignup {
  const payload = parseJsonObject<PendingSignup>(row.payload, { name: '', passwordHash: '' });
  if (!payload.passwordHash) throw badRequest('注册信息已失效，请重新提交注册', 'no_pending_signup');
  return { name: payload.name ?? '', passwordHash: payload.passwordHash };
}

/** 发一条新的注册确认码；同一邮箱 60 秒内重复发会被 429 挡掉。 */
export async function issueSignupCode(env: Env, email: string, payload: PendingSignup): Promise<IssuedCode> {
  const now = Date.now();
  const existing = await activeCodeRow(env, email, 'signup');
  if (existing && sqlNumber(existing, 'expires_at') > now) {
    const waitMs = RESEND_COOLDOWN_MS - (now - sqlNumber(existing, 'created_at'));
    if (waitMs > 0) {
      throw tooManyRequests(`确认码刚刚发过，请 ${Math.ceil(waitMs / 1000)} 秒后再试`, 'code_cooldown');
    }
  }

  // 同邮箱的旧确认码一律作废（改过邮箱再来一遍的情况也不会串号）
  await env.DB.prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ?').bind(email, 'signup').run();

  const code = generateCode();
  const ttlMinutes = codeTtlMinutes(env);
  const expiresAt = now + ttlMinutes * 60_000;
  await env.DB.prepare(
    `INSERT INTO email_codes (id, email, purpose, code_hash, payload, attempts, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
  )
    .bind(newId(), email, 'signup', await codeHash(email, 'signup', code), JSON.stringify(payload), now, expiresAt)
    .run();

  // 顺手清掉别的邮箱的过期记录，省得表一直长
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM email_codes WHERE expires_at < ?').bind(now - 24 * 60 * 60 * 1000).run();
  }

  return { code, expiresAt, ttlMinutes };
}

/** 重发确认码：沿用上一次提交的注册信息（昵称 / 密码哈希）。 */
export async function resendSignupCode(env: Env, email: string): Promise<IssuedCode & { name: string }> {
  const row = await activeCodeRow(env, email, 'signup');
  if (!row || sqlNumber(row, 'expires_at') < Date.now()) {
    throw badRequest('没有待确认的注册，请重新填写注册信息', 'no_pending_signup');
  }
  const payload = payloadOf(row);
  const issued = await issueSignupCode(env, email, payload);
  return { ...issued, name: payload.name };
}

/** 校验确认码，成功即作废并返回待确认的注册信息。 */
export async function consumeSignupCode(env: Env, email: string, code: string): Promise<PendingSignup> {
  const now = Date.now();
  const row = await activeCodeRow(env, email, 'signup');
  if (!row) throw badRequest('没有待确认的注册，请重新提交注册信息', 'no_pending_signup');

  const id = sqlString(row, 'id');
  if (sqlNumber(row, 'expires_at') < now) {
    await env.DB.prepare('DELETE FROM email_codes WHERE id = ?').bind(id).run();
    throw badRequest('确认码已过期，请重新发送', 'code_expired');
  }

  const attempts = sqlNumber(row, 'attempts');
  if (attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare('DELETE FROM email_codes WHERE id = ?').bind(id).run();
    throw badRequest('确认码错误次数过多，请重新发送', 'code_locked');
  }

  const expected = sqlString(row, 'code_hash');
  if (!timingSafeEqual(expected, await codeHash(email, 'signup', code))) {
    await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').bind(id).run();
    const left = MAX_ATTEMPTS - attempts - 1;
    throw badRequest(
      left > 0 ? `确认码不正确，还可以再试 ${left} 次` : '确认码错误次数过多，请重新发送',
      'code_mismatch',
    );
  }

  await env.DB.prepare('UPDATE email_codes SET consumed_at = ? WHERE id = ?').bind(now, id).run();
  return payloadOf(row);
}
