/**
 * 记录备注（评论）+ @提醒私信的读写。
 *
 * 备注只能新增，不能修改 / 删除：这里没有 update / delete 语句，
 * `routes/notes.ts` 也只暴露一个 POST。
 * 备注里 @ 到的人会在收件箱里收到一条私信（`note_mentions`），读掉之后未读数 -1。
 */
import { FIELD_META, formatValueForDisplay } from '../shared/fields';
import type {
  CellValue,
  InboxMessage,
  Member,
  NoteMention,
  Property,
  RecordNote,
  RowValues,
} from '../shared/types';
import { parseJsonObject, sqlNullableString, sqlNumber, sqlString, type SqlRow } from './http';
import { propertyFromRow } from './mappers';
import type { Env } from './types';

/** 分片绑定参数，永远不超过 D1 / SQLite 的变量上限 */
const CHUNK = 100;
/** 收件箱一次最多返回多少条未读私信（红点数字仍按实际未读数） */
export const INBOX_LIMIT = 50;

/**
 * 可以被 @ 的人里角色越高越靠前。
 * 同一个人可能既被邀请成成员、又被定向分享，去重时保留权限更高的角色。
 */
const ROLE_RANK: Record<Member['role'], number> = { owner: 3, editor: 2, viewer: 1 };

function sliceList<T>(items: T[], size = CHUNK): T[][] {
  const slices: T[][] = [];
  for (let index = 0; index < items.length; index += size) slices.push(items.slice(index, index + size));
  return slices;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** `users.name` 为空时退回邮箱，避免界面上出现空白作者。 */
function nameOf(row: SqlRow, prefix: string): string {
  return sqlString(row, `${prefix}name`) || sqlString(row, `${prefix}email`);
}

function noteFromRow(row: SqlRow): RecordNote {
  const authorId = sqlNullableString(row, 'author_id');
  return {
    id: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    recordId: sqlString(row, 'record_id'),
    body: sqlString(row, 'body'),
    authorId,
    authorName: authorId ? nameOf(row, 'author_') : '已注销用户',
    mentions: [],
    createdAt: sqlNumber(row, 'created_at'),
  };
}

/**
 * 备注 + 它们的 @对象，按 `createdAt` 升序。
 * 只查传入的记录 id，看不到的记录不会泄露。
 */
export async function loadNotes(env: Env, recordIds: string[]): Promise<RecordNote[]> {
  const ids = [...new Set(recordIds)].filter(Boolean);
  if (!ids.length) return [];

  const notes: RecordNote[] = [];
  const noteIds: string[] = [];
  for (const slice of sliceList(ids)) {
    const { results } = await env.DB.prepare(
      `SELECT n.*, u.name AS author_name, u.email AS author_email
         FROM notes n
         LEFT JOIN users u ON u.id = n.author_id
        WHERE n.record_id IN (${placeholders(slice.length)})
        ORDER BY n.created_at ASC`,
    )
      .bind(...slice)
      .all<SqlRow>();
    for (const row of results ?? []) {
      notes.push(noteFromRow(row));
      noteIds.push(sqlString(row, 'id'));
    }
  }

  const mentions = new Map<string, NoteMention[]>();
  for (const slice of sliceList(noteIds)) {
    const { results } = await env.DB.prepare(
      `SELECT m.note_id, m.user_id, u.name, u.email
         FROM note_mentions m
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.note_id IN (${placeholders(slice.length)})`,
    )
      .bind(...slice)
      .all<SqlRow>();
    for (const row of results ?? []) {
      const noteId = sqlString(row, 'note_id');
      const list = mentions.get(noteId) ?? [];
      list.push({ userId: sqlString(row, 'user_id'), name: nameOf(row, '') || '未知用户' });
      mentions.set(noteId, list);
    }
  }
  for (const note of notes) note.mentions = mentions.get(note.id) ?? [];

  // 分片查询后再统一排序，保证跨分片也是时间升序
  notes.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return notes;
}

/** 可以被 @ 的人：所有者 + 表格成员 + 视图定向分享的访客。 */
export async function mentionableUsers(env: Env, databaseId: string): Promise<Member[]> {
  const { results } = await env.DB.prepare(
    `SELECT d.owner_id AS user_id, u.email AS email, u.name AS name, 'owner' AS role, d.created_at AS created_at
       FROM databases d JOIN users u ON u.id = d.owner_id
      WHERE d.id = ?
     UNION ALL
     SELECT m.user_id, u.email, u.name, m.role, m.created_at
       FROM database_members m JOIN users u ON u.id = m.user_id
      WHERE m.database_id = ?
     UNION ALL
     SELECT vs.user_id, u.email, u.name, vs.role, vs.created_at
       FROM view_shares vs JOIN users u ON u.id = vs.user_id
      WHERE vs.database_id = ?`,
  )
    .bind(databaseId, databaseId, databaseId)
    .all<SqlRow>();

  const byUser = new Map<string, Member>();
  for (const row of results ?? []) {
    const userId = sqlString(row, 'user_id');
    if (!userId) continue;
    const raw = sqlString(row, 'role');
    const role: Member['role'] = raw === 'owner' || raw === 'editor' ? raw : 'viewer';
    const seen = byUser.get(userId);
    if (seen && ROLE_RANK[seen.role] >= ROLE_RANK[role]) continue;
    byUser.set(userId, {
      // 合成的成员 id：前端只把它当成 @ 候选，不会拿去改角色 / 移除成员
      id: `mention:${userId}`,
      databaseId,
      userId,
      email: sqlString(row, 'email'),
      name: sqlString(row, 'name'),
      role,
      createdAt: sqlNumber(row, 'created_at'),
    });
  }

  return [...byUser.values()].sort(
    (a, b) =>
      ROLE_RANK[b.role] - ROLE_RANK[a.role] || (a.name || a.email).localeCompare(b.name || b.email),
  );
}

/**
 * 可以被 @ 的人（{@link mentionableUsers}）的 id 集合，供添加备注时校验。
 * 前端候选名单与服务端校验用的是同一份数据，因此所有者和各个被分享者之间可以互相 @。
 */
export async function mentionableUserIds(env: Env, databaseId: string): Promise<Set<string>> {
  return new Set((await mentionableUsers(env, databaseId)).map((member) => member.userId));
}

/** 未读私信条数（就是红点里的数字）。 */
export async function unreadMentionCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total
       FROM note_mentions m
       JOIN notes n ON n.id = m.note_id
       JOIN databases d ON d.id = m.database_id
       JOIN records r ON r.id = m.record_id
      WHERE m.user_id = ? AND m.read_at IS NULL`,
  )
    .bind(userId)
    .first<SqlRow>();
  return sqlNumber(row ?? {}, 'total');
}

/** 表格的「标题字段」：第一个文本字段，没有文本字段时退回第一个非计算字段。 */
async function loadTitleProperties(env: Env, databaseIds: string[]): Promise<Map<string, Property>> {
  const ids = [...new Set(databaseIds)].filter(Boolean);
  const grouped = new Map<string, Property[]>();
  for (const slice of sliceList(ids)) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM properties
        WHERE database_id IN (${placeholders(slice.length)})
        ORDER BY database_id ASC, position ASC, created_at ASC`,
    )
      .bind(...slice)
      .all<SqlRow>();
    for (const row of results ?? []) {
      const property = propertyFromRow(row);
      const list = grouped.get(property.databaseId) ?? [];
      list.push(property);
      grouped.set(property.databaseId, list);
    }
  }

  const titles = new Map<string, Property>();
  for (const [databaseId, list] of grouped) {
    const property =
      list.find((item) => item.type === 'text') ?? list.find((item) => !FIELD_META[item.type].computed) ?? list[0];
    if (property) titles.set(databaseId, property);
  }
  return titles;
}

/** 收件箱列表里显示的记录标题（表格可能不止一个，需要按 database_id 分别解析）。 */
export async function loadRecordTitles(
  env: Env,
  records: { databaseId: string; recordId: string; values: RowValues }[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (!records.length) return titles;
  const properties = await loadTitleProperties(
    env,
    records.map((record) => record.databaseId),
  );
  for (const record of records) {
    const property = properties.get(record.databaseId);
    if (!property) continue;
    titles.set(
      `${record.databaseId}:${record.recordId}`,
      formatValueForDisplay(property.type, record.values[property.id] as CellValue | undefined, property.config),
    );
  }
  return titles;
}

/** 当前用户的未读私信（按时间倒序），供收件箱面板展示。 */
export async function loadInboxMessages(env: Env, userId: string): Promise<InboxMessage[]> {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.note_id, m.database_id, m.record_id, m.created_at,
            n.body, d.name AS database_name, d.icon AS database_icon,
            u.name AS author_name, u.email AS author_email,
            r."values" AS record_values
       FROM note_mentions m
       JOIN notes n ON n.id = m.note_id
       JOIN databases d ON d.id = m.database_id
       JOIN records r ON r.id = m.record_id
       LEFT JOIN users u ON u.id = n.author_id
      WHERE m.user_id = ? AND m.read_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT ?`,
  )
    .bind(userId, INBOX_LIMIT)
    .all<SqlRow>();

  const rows = results ?? [];
  const titles = await loadRecordTitles(
    env,
    rows.map((row) => ({
      databaseId: sqlString(row, 'database_id'),
      recordId: sqlString(row, 'record_id'),
      values: parseJsonObject<RowValues>(row.record_values, {}),
    })),
  );

  return rows.map((row) => {
    const databaseId = sqlString(row, 'database_id');
    const recordId = sqlString(row, 'record_id');
    const author = sqlString(row, 'author_name') || sqlString(row, 'author_email');
    return {
      id: sqlString(row, 'id'),
      noteId: sqlString(row, 'note_id'),
      databaseId,
      databaseName: sqlString(row, 'database_name'),
      databaseIcon: sqlString(row, 'database_icon', '📋'),
      recordId,
      recordTitle: titles.get(`${databaseId}:${recordId}`) ?? '',
      authorName: author || '已注销用户',
      body: sqlString(row, 'body'),
      createdAt: sqlNumber(row, 'created_at'),
    };
  });
}
