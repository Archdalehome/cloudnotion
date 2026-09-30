/**
 * 单元格级「只能修改一次」：共享出来的可编辑用户对每一格数据只有一次修改机会。
 *
 * - 公开链接访客 / 被邀请的 editor / 视图定向分享的 editor 都要受限制；
 * - 表格所有者不受限制，也永远不会写入 `cell_edits`；
 * - 第一次保存成功后登记（`rememberCellEdits`），之后同一个归属键再改同一格即被拒绝。
 */
import { cellLockHint, cellLockKey, sameCellValue } from '../shared/fields';
import type { Property, RowValues } from '../shared/types';
import type { DatabaseAccess } from './access';
import { forbidden, newId, sqlString, type SqlRow } from './http';
import type { Env } from './types';

/** D1 单条 SQL 最多绑定 100 个参数：每行 6 列，因此一次最多写 10 行 */
const INSERT_CHUNK = 10;
/** IN (...) 查询的分片大小：1 个 database_id + 1 个 editor_key + N 个记录 id */
const SELECT_CHUNK = 90;

/** 登录用户（表格成员 / 视图定向分享）的归属键；表格所有者返回 null（不受限制）。 */
export function memberCellEditKey(access: Pick<DatabaseAccess, 'role' | 'userId'>): string | null {
  return access.role === 'owner' ? null : `user:${access.userId}`;
}

/** 公开分享链接的归属键：同一个链接的所有访客共用这一次机会。 */
export function shareCellEditKey(shareId: string): string {
  return `share:${shareId}`;
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

/** 访问者在这些记录里已经改过的格子（键为 `记录 id:字段 id`）。 */
export async function loadLockedCellKeys(
  env: Env,
  databaseId: string,
  editorKey: string | null,
  recordIds: string[],
): Promise<string[]> {
  if (!editorKey || !recordIds.length) return [];
  const keys: string[] = [];
  for (let index = 0; index < recordIds.length; index += SELECT_CHUNK) {
    const slice = recordIds.slice(index, index + SELECT_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT record_id, property_id FROM cell_edits
        WHERE database_id = ? AND editor_key = ? AND record_id IN (${slice.map(() => '?').join(', ')})`,
    )
      .bind(databaseId, editorKey, ...slice)
      .all<SqlRow>();
    for (const row of results ?? []) {
      keys.push(cellLockKey(sqlString(row, 'record_id'), sqlString(row, 'property_id')));
    }
  }
  return keys;
}

/**
 * 这些格子里只要有一个已经改过就拒绝本次保存。
 * `editorKey` 为 null（表格所有者）时直接放行。
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
    'SELECT property_id FROM cell_edits WHERE database_id = ? AND editor_key = ? AND record_id = ?',
  )
    .bind(databaseId, editorKey, recordId)
    .all<SqlRow>();
  if (!results?.length) return;

  const spent = new Set(results.map((row) => sqlString(row, 'property_id')));
  const hitId = propertyIds.find((propertyId) => spent.has(propertyId));
  if (!hitId) return;

  const name = properties.find((property) => property.id === hitId)?.name ?? '该字段';
  throw forbidden(cellLockHint(name));
}

/** 单个格子是否已经改过（文件上传这类绕过 PATCH 的入口用）。 */
export async function isCellLocked(
  env: Env,
  databaseId: string,
  editorKey: string | null,
  recordId: string,
  propertyId: string,
): Promise<boolean> {
  if (!editorKey) return false;
  const row = await env.DB.prepare(
    `SELECT 1 AS locked FROM cell_edits
      WHERE database_id = ? AND editor_key = ? AND record_id = ? AND property_id = ?`,
  )
    .bind(databaseId, editorKey, recordId, propertyId)
    .first<SqlRow>();
  return Boolean(row);
}

/** 记下这次改过的格子（幂等：重复登记会被 UNIQUE 约束忽略）。 */
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
