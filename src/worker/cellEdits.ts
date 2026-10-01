/**
 * 单元格级「限制编辑」：分享时勾选了「限制编辑」的访问者对每一格数据只有一次
 * 修改机会 —— 但第一次保存成功后的 `CELL_EDIT_GRACE_MS`（10 秒）内还允许重新
 * 输入 / 修改，给人一个「马上发现填错」的纠错窗口。
 *
 * - 只有带 `limit_edits = 1` 的分享才受限制：公开链接（shares）/ 视图定向分享
 *   （view_shares）在创建时勾选了「限制编辑」才算；
 * - 表格所有者、表格成员、以及没勾选「限制编辑」的分享都不受限制，
 *   也永远不会写入 `cell_edits`；
 * - 第一次保存成功后登记（`rememberCellEdits`，`created_at` 只写一次，重复登记
 *   被 UNIQUE 忽略），所以窗口始终从「第一次保存成功」的时刻固定往后数 10 秒，
 *   不会因为窗口内反复修改而延长；
 * - 窗口一过，同一个归属键再改这一格就会被拒绝（403），只能请表格所有者代改。
 */
import { CELL_EDIT_GRACE_MS, cellLockHint, cellLockKey, sameCellValue } from '../shared/fields';
import type { CellEditLocks, Property, RowValues } from '../shared/types';
import type { DatabaseAccess, ShareAccess } from './access';
import { forbidden, newId, sqlNumber, sqlString, type SqlRow } from './http';
import type { Env } from './types';

/** D1 单条 SQL 最多绑定 100 个参数：每行 6 列，因此一次最多写 10 行 */
const INSERT_CHUNK = 10;
/** IN (...) 查询的分片大小：1 个 database_id + 1 个 editor_key + N 个记录 id */
const SELECT_CHUNK = 90;

/**
 * 登录用户（视图定向分享的 editor）的归属键。
 * 表格所有者与表格成员返回 null（不受限制）。
 */
export function memberCellEditKey(
  access: Pick<DatabaseAccess, 'role' | 'userId' | 'limitCellEdits'>,
): string | null {
  if (access.role === 'owner' || !access.limitCellEdits) return null;
  return `user:${access.userId}`;
}

/**
 * 公开分享链接的归属键：同一个链接的所有访客共用这一次机会。
 * 没勾选「限制编辑」的链接返回 null（不受限制）。
 */
export function shareCellEditKey(share: Pick<ShareAccess, 'shareId' | 'limitEdits'>): string | null {
  return share.limitEdits ? `share:${share.shareId}` : null;
}

/**
 * 本次请求真正改动的字段 id。
 * 值没变（例如前端把整行原样提交回来）不算改动，不该消耗那次机会。
 */
export function changedPropertyIds(
  properties: Property[],
  current: RowValues,
  next: RowValues,
  incoming: unknown,
): string[] {
  if (!incoming || typeof incoming !== 'object') return [];
  const keys = new Set(Object.keys(incoming as Record<string, unknown>));
  return properties
    .filter((property) => keys.has(property.id) && !sameCellValue(current[property.id], next[property.id]))
    .map((property) => property.id);
}

/**
 * 访问者在这些记录里的单元格锁定状态：
 * - `lockedCells`：改过、且已经过了纠错窗口（彻底只读）的格子；
 * - `cellEditGrace`：还在纠错窗口内（可以继续修改）的格子 → 窗口截止时刻。
 * 两个列表里的键都是 `记录 id:字段 id`（见 `cellLockKey`）。
 */
export async function loadCellEditLocks(
  env: Env,
  databaseId: string,
  editorKey: string | null,
  recordIds: string[],
): Promise<CellEditLocks> {
  const locks: CellEditLocks = { lockedCells: [], cellEditGrace: {} };
  if (!editorKey || !recordIds.length) return locks;
  const now = Date.now();
  for (let index = 0; index < recordIds.length; index += SELECT_CHUNK) {
    const slice = recordIds.slice(index, index + SELECT_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT record_id, property_id, created_at FROM cell_edits
        WHERE database_id = ? AND editor_key = ? AND record_id IN (${slice.map(() => '?').join(', ')})`,
    )
      .bind(databaseId, editorKey, ...slice)
      .all<SqlRow>();
    for (const row of results ?? []) {
      const key = cellLockKey(sqlString(row, 'record_id'), sqlString(row, 'property_id'));
      // 第一次保存成功后的 10 秒内还能改：这一格只是「宽限中」，不算锁上
      const until = sqlNumber(row, 'created_at') + CELL_EDIT_GRACE_MS;
      if (until > now) locks.cellEditGrace[key] = until;
      else locks.lockedCells.push(key);
    }
  }
  return locks;
}

/**
 * 这些格子里只要有一个「改过且已经过了纠错窗口」就拒绝本次保存。
 * 还在 10 秒窗口内的格子照常放行（窗口从第一次保存成功算起，不会延长）；
 * `editorKey` 为 null（表格所有者 / 表格成员 / 不受限的分享）时直接放行。
 */
export async function assertCellsEditable(
  env: Env,
  databaseId: string,
  editorKey: string | null,
  recordId: string,
  propertyIds: string[],
  properties: Property[],
): Promise<void> {
  if (!editorKey || !propertyIds.length) return;
  const { results } = await env.DB.prepare(
    'SELECT property_id, created_at FROM cell_edits WHERE database_id = ? AND editor_key = ? AND record_id = ?',
  )
    .bind(databaseId, editorKey, recordId)
    .all<SqlRow>();
  if (!results?.length) return;

  const now = Date.now();
  const spent = new Set<string>();
  for (const row of results) {
    // 还在纠错窗口内：允许重新输入 / 修改
    if (sqlNumber(row, 'created_at') + CELL_EDIT_GRACE_MS > now) continue;
    spent.add(sqlString(row, 'property_id'));
  }
  const hitId = propertyIds.find((propertyId) => spent.has(propertyId));
  if (!hitId) return;

  const name = properties.find((property) => property.id === hitId)?.name ?? '该字段';
  throw forbidden(cellLockHint(name));
}

/**
 * 单个格子是否已经锁上（改过且过了纠错窗口）。
 * 文件上传这类绕过 PATCH 的入口用它，窗口内的上传同样放行。
 */
export async function isCellLocked(
  env: Env,
  databaseId: string,
  editorKey: string | null,
  recordId: string,
  propertyId: string,
): Promise<boolean> {
  if (!editorKey) return false;
  const row = await env.DB.prepare(
    `SELECT created_at FROM cell_edits
      WHERE database_id = ? AND editor_key = ? AND record_id = ? AND property_id = ?`,
  )
    .bind(databaseId, editorKey, recordId, propertyId)
    .first<SqlRow>();
  if (!row) return false;
  return sqlNumber(row, 'created_at') + CELL_EDIT_GRACE_MS <= Date.now();
}

/**
 * 记下这次改过的格子（幂等：重复登记会被 UNIQUE 约束忽略）。
 * `created_at` 只在第一次写入，所以纠错窗口始终从「第一次保存成功」的时刻起算，
 * 窗口内的反复修改不会把窗口往后推。
 */
export async function rememberCellEdits(
  env: Env,
  databaseId: string,
  editorKey: string | null,
  recordId: string,
  propertyIds: string[],
): Promise<void> {
  if (!editorKey || !propertyIds.length) return;
  const now = Date.now();
  for (let index = 0; index < propertyIds.length; index += INSERT_CHUNK) {
    const slice = propertyIds.slice(index, index + INSERT_CHUNK);
    const placeholders = slice.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    await env.DB.prepare(
      `INSERT OR IGNORE INTO cell_edits (id, database_id, record_id, property_id, editor_key, created_at)
       VALUES ${placeholders}`,
    )
      .bind(
        ...slice.flatMap((propertyId) => [
          newId(),
          databaseId,
          recordId,
          propertyId,
          editorKey,
          now,
        ]),
      )
      .run();
  }
}
