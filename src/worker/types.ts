/** Worker environment bindings (see wrangler.jsonc). */
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  APP_NAME?: string;
  MAX_UPLOAD_MB?: string;
  ALLOW_SIGNUP?: string;
  /** Resend API Key（secret，`npx wrangler secret put RESEND_API_KEY`）；不配则注册确认码直接回显 */
  RESEND_API_KEY?: string;
  /** 发件人，例如 `CloudNotion <onboarding@resend.dev>`（用自备域名时改成自己的） */
  RESEND_FROM_EMAIL?: string;
  /** 超级管理员的登录邮箱：登录时会被自动创建 / 提升为管理员 */
  ADMIN_EMAIL?: string;
  /** 超级管理员初始密码（只用于「首次创建账号」；已存在时不会覆盖，除非 ADMIN_RESET_PASSWORD=true） */
  ADMIN_PASSWORD?: string;
  /** 设为 "true" 时用 ADMIN_PASSWORD 强制同步管理员密码（改完记得去掉） */
  ADMIN_RESET_PASSWORD?: string;
  /** 逗号分隔：这些域名的邮箱不真的发信，直接把确认码回显在响应里（给自动化测试用） */
  AUTH_ECHO_CODE_DOMAINS?: string;
  /** 确认码有效期（分钟），默认 15 */
  AUTH_CODE_TTL_MINUTES?: string;
}

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  /** 管理员：可以访问 /api/admin/* */
  isAdmin: boolean;
}

export type AccessLevel = 'view' | 'edit' | 'manage';

export interface RequestContext {
  request: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
  user: AuthedUser | null;
}

export type RouteHandler = (ctx: RequestContext) => Promise<Response> | Response;

export interface Route {
  method: string;
  /** e.g. `/api/databases/:id/records` */
  path: string;
  handler: RouteHandler;
}
