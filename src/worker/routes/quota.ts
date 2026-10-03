/**
 * /api/quota - 表格名额（还能再添加几张表格）。
 *
 * 侧边栏底部那句「你有 N 个表格可以添加」和说明弹窗都用它。口径与
 * `src/shared/quota.ts` 保持一致：
 *   - 已用 = 自己拥有的、未归档的表格数；
 *   - 已分享 = 视图定向分享 + 公开链接分享 + 表格协作者，各算一次；
 *   - 已购买：购买功能还没上线，先恒为 0（等服务端记购买后再接进来）。
 */
import { tableQuotaOf } from '../../shared/quota';
import type { TableQuota } from '../../shared/types';
import { requireUser } from '../auth';
import { json, sqlNumber, type SqlRow } from '../http';
import type { Env, RequestContext, Route } from '../types';

/** 算一个账号当前的名额（会话下发与 `/api/quota` 共用） */
export async function loadTableQuota(env: Env, userId: string): Promise<TableQuota> {
  const row =
    (await env.DB
      .prepare(
        `SELECT
       (SELECT COUNT(*) FROM databases
         WHERE owner_id = ? AND is_archived = 0) AS used,
       (SELECT COUNT(*) FROM shares s JOIN databases d ON d.id = s.database_id
         WHERE d.owner_id = ? AND d.is_archived = 0) AS link_shares,
       (SELECT COUNT(*) FROM view_shares v JOIN databases d ON d.id = v.database_id
         WHERE d.owner_id = ? AND d.is_archived = 0) AS view_shares,
       (SELECT COUNT(*) FROM database_members m JOIN databases d ON d.id = m.database_id
         WHERE d.owner_id = ? AND d.is_archived = 0) AS members`,
      )
      .bind(userId, userId, userId, userId)
      .first<SqlRow>()) ?? {};

  return tableQuotaOf({
    used: sqlNumber(row, 'used'),
    shared: sqlNumber(row, 'link_shares') + sqlNumber(row, 'view_shares') + sqlNumber(row, 'members'),
    purchased: 0,
  });
}

async function quotaHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  return json({ quota: await loadTableQuota(ctx.env, user.id) });
}

export const quotaRoutes: Route[] = [{ method: 'GET', path: '/api/quota', handler: quotaHandler }];
