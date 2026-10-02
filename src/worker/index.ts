/**
 * CloudNotion worker entry point.
 *
 * `/api/*` is handled here (see `run_worker_first` in wrangler.jsonc); every
 * other request falls through to the static asset store which serves the Vite
 * build from `./dist` with a single-page-application fallback.
 */
import { getCurrentUser, purgeExpiredSessions } from './auth';
import { errorToResponse, json } from './http';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { databaseRoutes } from './routes/databases';
import { fileRoutes } from './routes/files';
import { noteRoutes } from './routes/notes';
import { propertyRoutes } from './routes/properties';
import { publicRoutes } from './routes/public';
import { recordRoutes } from './routes/records';
import { viewRoutes } from './routes/views';
import type { Env, RequestContext, Route, RouteHandler } from './types';

const API_ROUTES: Route[] = [
  ...authRoutes,
  ...adminRoutes,
  ...databaseRoutes,
  ...propertyRoutes,
  ...recordRoutes,
  ...noteRoutes,
  ...viewRoutes,
  ...fileRoutes,
  ...publicRoutes,
];

interface CompiledRoute {
  method: string;
  regexp: RegExp;
  keys: string[];
  handler: RouteHandler;
}

function compile(route: Route): CompiledRoute {
  const keys: string[] = [];
  const pattern = route.path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { method: route.method, regexp: new RegExp(`^${pattern}/?$`), keys, handler: route.handler };
}

const COMPILED_ROUTES = API_ROUTES.map(compile);

interface Match {
  route: CompiledRoute;
  params: Record<string, string>;
}

function matchRoute(method: string, pathname: string): { match: Match | null; otherMethod: boolean } {
  let otherMethod = false;
  for (const route of COMPILED_ROUTES) {
    const found = route.regexp.exec(pathname);
    if (!found) continue;
    if (route.method !== method) {
      otherMethod = true;
      continue;
    }
    const params: Record<string, string> = {};
    route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(found[index + 1] ?? '');
    });
    return { match: { route, params }, otherMethod };
  }
  return { match: null, otherMethod };
}

function withSecurityHeaders(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('x-served-by', env.APP_NAME ?? 'CloudNotion');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/api/health') {
      return json({ ok: true, app: env.APP_NAME ?? 'CloudNotion', time: Date.now() });
    }

    const { match, otherMethod } = matchRoute(request.method.toUpperCase(), url.pathname);
    if (!match) {
      if (otherMethod) {
        return json(
          { error: { code: 'method_not_allowed', message: `${request.method} 不被该接口支持` } },
          { status: 405 },
        );
      }
      return json({ error: { code: 'not_found', message: '接口不存在' } }, { status: 404 });
    }

    const user = await getCurrentUser(request, env);
    const ctx: RequestContext = {
      request,
      env,
      url,
      params: match.params,
      user,
    };
    return await match.route.handler(ctx);
  } catch (error) {
    return errorToResponse(error);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // cheap house-keeping without blocking the response
      if (Math.random() < 0.05) {
        ctx.waitUntil(purgeExpiredSessions(env).catch(() => undefined));
      }
      const response = await handleApi(request, env);
      return withSecurityHeaders(response, env);
    }

    // static assets (Vite build) with SPA fallback handled by the platform
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};
