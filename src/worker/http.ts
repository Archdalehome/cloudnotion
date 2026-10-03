/** Small helpers shared by all API routes. */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function badRequest(message: string, code = 'bad_request'): HttpError {
  return new HttpError(400, code, message);
}

export function unauthorized(message = '请先登录'): HttpError {
  return new HttpError(401, 'unauthorized', message);
}

export function forbidden(message = '没有权限执行该操作', code = 'forbidden'): HttpError {
  return new HttpError(403, code, message);
}

export function notFound(message = '资源不存在'): HttpError {
  return new HttpError(404, 'not_found', message);
}

export function conflict(message: string, code = 'conflict'): HttpError {
  return new HttpError(409, code, message);
}

export function tooManyRequests(message: string, code = 'too_many_requests'): HttpError {
  return new HttpError(429, code, message);
}

/** 依赖邮件服务的接口失败时用（Resend 拒收 / 网络异常 / 未配置发件人） */
export function badGateway(message: string, code = 'email_send_failed'): HttpError {
  return new HttpError(502, code, message);
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorToResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : '服务器内部错误';
  console.error('Unhandled error:', error);
  return json({ error: { code: 'internal_error', message } }, { status: 500 });
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw badRequest('请求体必须是 JSON');
  try {
    const body = (await request.json()) as T;
    if (body === null || typeof body !== 'object') throw new Error('expected object');
    return body;
  } catch {
    throw badRequest('JSON 解析失败');
  }
}

/* ---------------------------------------------------------------- cookies */

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (key === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

export interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

/* --------------------------------------------------------------- strings */

export function asString(
  value: unknown,
  field: string,
  opts: { max?: number; required?: boolean; trim?: boolean } = {},
): string {
  if (value === undefined || value === null) {
    if (opts.required) throw badRequest(`${field} 不能为空`);
    return '';
  }
  if (typeof value !== 'string') throw badRequest(`${field} 必须是字符串`);
  const text = opts.trim === false ? value : value.trim();
  if (opts.required && text === '') throw badRequest(`${field} 不能为空`);
  if (opts.max !== undefined && text.length > opts.max) {
    throw badRequest(`${field} 长度不能超过 ${opts.max}`);
  }
  return text;
}

export function asOptionalString(value: unknown, field: string, max = 2000): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, field, { max });
}

export function asNumberValue(value: unknown, field: string): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) throw badRequest(`${field} 必须是数字`);
  return num;
}

/**
 * 可选开关（例如分享时的「限制编辑」）：接受 true / false、1 / 0、'true' / 'false'。
 * `value` 缺省时返回 `fallback`（默认为关）。
 */
export function asFlag(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return fallback;
}

export function asEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw badRequest(`${field} 只能是 ${allowed.join(' / ')}`);
  }
  return value as T;
}

export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

export function parseJsonObject<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------- misc */

export function newId(): string {
  return crypto.randomUUID();
}

/** URL-safe random token. */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64UrlEncode(buffer);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64UrlDecode(text: string): Uint8Array {
  const normalized = text.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `position` for appended / inserted items (fractional indexing). */
export function positionBetween(previous: number | null, next: number | null): number {
  if (previous === null && next === null) return 1000;
  if (previous === null) return (next as number) - 1000;
  if (next === null) return previous + 1000;
  return (previous + next) / 2;
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: unknown): string {
  const email = asString(value, '邮箱', { required: true, max: 254 }).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw badRequest('邮箱格式不正确');
  return email;
}

/** D1 results come back as `Record<string, unknown>`; these helpers keep the code readable. */
export type SqlRow = Record<string, unknown>;

export function sqlString(row: SqlRow, key: string, fallback = ''): string {
  const value = row[key];
  return typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value);
}

export function sqlNumber(row: SqlRow, key: string, fallback = 0): number {
  const value = row[key];
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function sqlNullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 数字列上的 NULL（例如 `MAX(...)` 没有命中任何行）要保留成 null，而不是 0。 */
export function sqlNullableNumber(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}


