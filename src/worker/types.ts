/** Worker environment bindings (see wrangler.jsonc). */
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  APP_NAME?: string;
  MAX_UPLOAD_MB?: string;
  ALLOW_SIGNUP?: string;
}

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
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
