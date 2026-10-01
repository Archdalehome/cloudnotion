/**
 * /api/records/:id/notes - 记录备注（评论）
 * /api/inbox*           - @提醒私信（收件箱）
 *
 * 备注只能新增：这里没有修改 / 删除备注的接口，也没有对应的 SQL。
 */
import { accessForRecord } from '../access';
import { requireUser } from '../auth';
import { logChanges } from '../changes';
import { asString, badRequest, json, newId, notFound, readJson, sqlString, type SqlRow } from '../http';
import { loadInboxMessages, loadNotes, mentionableUserIds, unreadMentionCount } from '../notes';
import type { RequestContext, Route } from '../types';

/** 单条备注的最大长度（字符） */
const MAX_NOTE_LENGTH = 2000;

/**
 * 添加备注。请求体：
 *   { body: string, mentions?: string[] }   // mentions 是被 @ 到的用户 id
 * 只有对该表格有访问权的人会被 @ 到，也不会给自己发私信。
 */
async function createNoteHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await accessForRecord(ctx.env, ctx.params.id, user, 'view');
  const body = await readJson(ctx.request);
  const text = asString(body.body, '备注内容', { required: true, max: MAX_NOTE_LENGTH });
  const requested = Array.isArray(body.mentions) ? body.mentions.map(String) : [];
  if (requested.length > 50) throw badRequest('单条备注最多 @ 50 个人');

  const allowed = await mentionableUserIds(ctx.env, access.databaseId);
  const targets = [...new Set(requested)].filter((id) => id !== user.id && allowed.has(id));

  const noteId = newId();
  const now = Date.now();
  const statements = [
    ctx.env.DB.prepare(
      `INSERT INTO notes (id, database_id, record_id, author_id, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(noteId, access.databaseId, access.recordId, user.id, text, now),
  ];
  for (const targetId of targets) {
    statements.push(
      ctx.env.DB.prepare(
        `INSERT OR IGNORE INTO note_mentions (id, note_id, database_id, record_id, user_id, read_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      ).bind(newId(), noteId, access.databaseId, access.recordId, targetId, now),
    );
  }
  await ctx.env.DB.batch(statements);
  // 新备注：别人开着的记录卡片不用刷新就会出现（备注只增不改，合并即可）
  await logChanges(ctx.env, access.databaseId, 'note', [access.recordId]);

  return json({ notes: await loadNotes(ctx.env, [access.recordId]) }, { status: 201 });
}

/** 未读私信列表 + 红点里的数字。 */
async function inboxHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const [messages, unread] = await Promise.all([
    loadInboxMessages(ctx.env, user.id),
    unreadMentionCount(ctx.env, user.id),
  ]);
  return json({ messages, unread });
}

/** 点开一条私信 → 标记已读（数量 -1），返回剩下的未读数。 */
async function readMentionHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const row = await ctx.env.DB.prepare('SELECT id FROM note_mentions WHERE id = ? AND user_id = ?')
    .bind(ctx.params.id, user.id)
    .first<SqlRow>();
  if (!row) throw notFound('私信不存在');
  await ctx.env.DB.prepare('UPDATE note_mentions SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL')
    .bind(Date.now(), sqlString(row, 'id'), user.id)
    .run();
  return json({ unread: await unreadMentionCount(ctx.env, user.id) });
}

export const noteRoutes: Route[] = [
  { method: 'GET', path: '/api/inbox', handler: inboxHandler },
  { method: 'POST', path: '/api/inbox/:id/read', handler: readMentionHandler },
  { method: 'POST', path: '/api/records/:id/notes', handler: createNoteHandler },
];
