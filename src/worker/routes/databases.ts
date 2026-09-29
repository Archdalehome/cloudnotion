/** /api/databases* - create / read / update tables, members and share links. */
import { TEMPLATES, materializeTemplateProperties } from '../../shared/templates';
import type {
  DatabaseDetail,
  DatabaseSummary,
  Member,
  Property,
  Role,
  RowRecord,
  SelectOption,
  ViewDef,
} from '../../shared/types';
import { rowMatchesView } from '../../shared/viewFilter';
import { defaultViewConfig } from '../../shared/views';
import { requireDatabaseAccess, type DatabaseAccess } from '../access';
import { requireUser } from '../auth';
import {
  asEnum,
  asString,
  badRequest,
  conflict,
  forbidden,
  json,
  newId,
  normalizeEmail,
  notFound,
  randomToken,
  readJson,
  sqlNumber,
  sqlString,
  type SqlRow,
} from '../http';
import {
  databaseSummaryFromRow,
  memberFromRow,
  propertyFromRow,
  recordFromRow,
  shareFromRow,
  viewFromRow,
  viewShareFromRow,
} from '../mappers';
import type { Env, RequestContext, Route } from '../types';

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;
/** how many rows a view-only share scans before applying the view filters */
const SCOPED_ROW_SCAN = 5000;

export function clampLimit(url: URL): number {
  const raw = Number(url.searchParams.get('limit'));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(raw), MAX_PAGE_SIZE);
}

export function clampOffset(url: URL): number {
  const raw = Number(url.searchParams.get('offset'));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** All databases the user owns, has been invited to or received a view share for. */
export async function listDatabases(env: Env, userId: string): Promise<DatabaseSummary[]> {
  const [{ results }, { results: sharedRows }] = await Promise.all([
    env.DB.prepare(
      `SELECT d.id, d.name, d.icon, d.description, d.owner_id, d.is_locked, d.created_at, d.updated_at,
              u.name AS owner_name,
              (SELECT COUNT(*) FROM records r WHERE r.database_id = d.id AND r.is_archived = 0) AS record_count,
              CASE WHEN d.owner_id = ? THEN 'owner'
                   ELSE COALESCE(m.role, s.role, 'viewer') END AS role
         FROM databases d
         JOIN users u ON u.id = d.owner_id
         LEFT JOIN database_members m ON m.database_id = d.id AND m.user_id = ?
         LEFT JOIN (SELECT vs.database_id, MIN(vs.role) AS role FROM view_shares vs
                     WHERE vs.user_id = ? GROUP BY vs.database_id) s ON s.database_id = d.id
        WHERE d.is_archived = 0 AND (d.owner_id = ? OR m.id IS NOT NULL OR s.database_id IS NOT NULL)
        ORDER BY d.updated_at DESC`,
    )
      .bind(userId, userId, userId, userId)
      .all<SqlRow>(),
    env.DB.prepare(
      `SELECT vs.database_id, v.name AS view_name
         FROM view_shares vs JOIN views v ON v.id = vs.view_id
        WHERE vs.user_id = ?
        ORDER BY v.position ASC, vs.created_at ASC`,
    )
      .bind(userId)
      .all<SqlRow>(),
  ]);

  const sharedViewNames = new Map<string, string[]>();
  for (const row of sharedRows ?? []) {
    const databaseId = sqlString(row, 'database_id');
    const list = sharedViewNames.get(databaseId) ?? [];
    list.push(sqlString(row, 'view_name'));
    sharedViewNames.set(databaseId, list);
  }

  return (results ?? []).map((row) =>
    databaseSummaryFromRow(
      row,
      sqlString(row, 'role', 'viewer') as Role,
      sharedViewNames.get(sqlString(row, 'id')) ?? [],
    ),
  );
}

/** Union of the fields that the given (shared) views expose. */
function scopedProperties(properties: Property[], views: ViewDef[]): Property[] {
  if (!views.some((view) => view.config.visibleProperties)) return properties;
  const allowed = new Set<string>();
  for (const view of views) {
    for (const propertyId of view.config.visibleProperties ?? []) allowed.add(propertyId);
  }
  return properties.filter((property) => allowed.has(property.id));
}

/** Rows a view-scoped member may see: the union of every view they were given. */
export async function visibleRecords(
  env: Env,
  databaseId: string,
  viewIds: string[] | null,
  limit: number,
  offset: number,
): Promise<{ rows: RowRecord[]; total: number }> {
  if (!viewIds?.length) {
    const [rows, total] = await Promise.all([
      loadRecords(env, databaseId, limit, offset),
      countRecords(env, databaseId),
    ]);
    return { rows, total };
  }

  const [properties, views, scanned] = await Promise.all([
    loadProperties(env, databaseId),
    loadViews(env, databaseId, viewIds),
    loadRecords(env, databaseId, SCOPED_ROW_SCAN, 0),
  ]);
  if (!views.length) return { rows: [], total: 0 };

  const visibleProperties = scopedProperties(properties, views);
  const rows = scanned.filter((row) => views.some((view) => rowMatchesView(visibleProperties, row, view.config)));
  return { rows: rows.slice(offset, offset + limit), total: rows.length };
}

export async function loadProperties(env: Env, databaseId: string): Promise<Property[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM properties WHERE database_id = ? ORDER BY position ASC, created_at ASC',
  )
    .bind(databaseId)
    .all<SqlRow>();
  return (results ?? []).map(propertyFromRow);
}

export async function loadViews(env: Env, databaseId: string, viewIds?: string[] | null): Promise<ViewDef[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM views WHERE database_id = ? ORDER BY position ASC, created_at ASC',
  )
    .bind(databaseId)
    .all<SqlRow>();
  const views = (results ?? []).map(viewFromRow);
  if (!viewIds?.length) return views;
  return views.filter((view) => viewIds.includes(view.id));
}

export async function loadRecords(
  env: Env,
  databaseId: string,
  limit: number,
  offset: number,
): Promise<RowRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM records
      WHERE database_id = ? AND is_archived = 0
      ORDER BY position ASC, created_at ASC
      LIMIT ? OFFSET ?`,
  )
    .bind(databaseId, limit, offset)
    .all<SqlRow>();
  return (results ?? []).map(recordFromRow);
}

/** Single row by id (used by the record endpoints to echo the stored state). */
export async function loadRecord(env: Env, recordId: string): Promise<RowRecord | null> {
  const row = await env.DB.prepare('SELECT * FROM records WHERE id = ? AND is_archived = 0')
    .bind(recordId)
    .first<SqlRow>();
  return row ? recordFromRow(row) : null;
}

export interface CreateDatabaseOptions {
  name: string;
  icon: string;
  description: string;
  templateId: string;
}

export async function createDatabase(
  env: Env,
  userId: string,
  options: CreateDatabaseOptions,
): Promise<{ databaseId: string; properties: Property[]; views: ViewDef[] }> {
  const databaseId = newId();
  const now = Date.now();
  const defs = materializeTemplateProperties(options.templateId, () => newId());

  const statements = [
    env.DB.prepare(
      `INSERT INTO databases (id, owner_id, name, icon, description, is_archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    ).bind(databaseId, userId, options.name, options.icon, options.description, now, now),
  ];

  defs.forEach((def, index) => {
    statements.push(
      env.DB.prepare(
        `INSERT INTO properties (id, database_id, name, type, config, position, width, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        newId(),
        databaseId,
        def.name,
        def.type,
        JSON.stringify(def.config),
        (index + 1) * 1000,
        def.width,
        now,
        now,
      ),
    );
  });

  statements.push(
    env.DB.prepare(
      `INSERT INTO views (id, database_id, name, type, config, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      newId(),
      databaseId,
      '全部数据',
      'table',
      JSON.stringify(defaultViewConfig('table')),
      1000,
      now,
      now,
    ),
  );

  await env.DB.batch(statements);

  const properties = await loadProperties(env, databaseId);

  // templates that ship a status/select field also get a board view
  const groupProperty = properties.find((p) => p.type === 'status' || p.type === 'select');
  if (groupProperty) {
    const config = defaultViewConfig('board');
    config.groupBy = groupProperty.id;
    const viewId = newId();
    await env.DB.prepare(
      `INSERT INTO views (id, database_id, name, type, config, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(viewId, databaseId, '看板视图', 'board', JSON.stringify(config), 2000, now, now)
      .run();
  }

  return {
    databaseId,
    properties,
    views: await loadViews(env, databaseId),
  };
}

function findOption(property: Property | undefined, name: string): SelectOption | null {
  if (!property?.config.options) return null;
  return property.config.options.find((option) => option.name === name) ?? null;
}

/** Demo content created for every new account (mirrors Notion's onboarding page). */
export async function createStarterDatabase(env: Env, userId: string): Promise<void> {
  const { databaseId, properties } = await createDatabase(env, userId, {
    name: '我的第一个表格',
    icon: '🚀',
    description: '自动生成的示例数据，可随时编辑或删除',
    templateId: 'task',
  });

  const titleProperty = properties.find((p) => p.name === '任务名称');
  const statusProperty = properties.find((p) => p.name === '状态');
  const priorityProperty = properties.find((p) => p.name === '优先级');
  const dueProperty = properties.find((p) => p.name === '截止日期');
  const doneProperty = properties.find((p) => p.name === '已完成');
  if (!titleProperty) return;

  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  const samples: { title: string; status: string; priority: string; due: string; done: boolean }[] = [
    { title: '试用各类字段（文本 / 单选 / 日期 / 文件）', status: '进行中', priority: '高', due: day(1), done: false },
    { title: '邀请同事协作并设置权限', status: '未开始', priority: '中', due: day(3), done: false },
    { title: '在画廊视图中查看卡片效果', status: '已完成', priority: '低', due: day(-1), done: true },
  ];

  const now = Date.now();
  const statements = samples.map((sample, index) => {
    const values: Record<string, unknown> = {};
    const status = findOption(statusProperty, sample.status);
    const priority = findOption(priorityProperty, sample.priority);
    if (status) values[statusProperty!.id] = status;
    if (priority) values[priorityProperty!.id] = priority;
    values[titleProperty.id] = sample.title;
    if (dueProperty) values[dueProperty.id] = { start: sample.due, end: null, includeTime: false };
    if (doneProperty) values[doneProperty.id] = sample.done;
    return env.DB.prepare(
      `INSERT INTO records (id, database_id, "values", position, created_by, updated_by, is_archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).bind(newId(), databaseId, JSON.stringify(values), (index + 1) * 1000, userId, userId, now, now);
  });

  await env.DB.batch(statements);
}

export async function countRecords(env: Env, databaseId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM records WHERE database_id = ? AND is_archived = 0',
  )
    .bind(databaseId)
    .first<SqlRow>();
  return sqlNumber(row ?? {}, 'total');
}

export async function loadMembers(env: Env, databaseId: string): Promise<Member[]> {
  const [ownerRow, { results }] = await Promise.all([
    env.DB.prepare(
      `SELECT d.owner_id, d.created_at, u.email, u.name
         FROM databases d JOIN users u ON u.id = d.owner_id
        WHERE d.id = ?`,
    )
      .bind(databaseId)
      .first<SqlRow>(),
    env.DB.prepare(
      `SELECT m.*, u.email, u.name
       FROM database_members m JOIN users u ON u.id = m.user_id
      WHERE m.database_id = ?
      ORDER BY m.created_at ASC`,
    )
      .bind(databaseId)
      .all<SqlRow>(),
  ]);

  const members = (results ?? []).map(memberFromRow);
  if (!ownerRow) return members;

  // The owner is not stored in database_members but is always listed first
  // (their id is a virtual "owner:<databaseId>" handled by the member routes).
  return [
    {
      id: ownerMemberId(databaseId),
      databaseId,
      userId: sqlString(ownerRow, 'owner_id'),
      email: sqlString(ownerRow, 'email'),
      name: sqlString(ownerRow, 'name'),
      role: 'owner',
      createdAt: sqlNumber(ownerRow, 'created_at'),
    },
    ...members,
  ];
}

/** Virtual member id of the table owner (see loadMembers). */
export function ownerMemberId(databaseId: string): string {
  return `owner:${databaseId}`;
}

/** True for the virtual owner entry returned by {@link loadMembers}. */
function isOwnerMemberId(memberId: string): boolean {
  return memberId.startsWith('owner:');
}

export async function loadShares(env: Env, databaseId: string) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM shares WHERE database_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC',
  )
    .bind(databaseId, Date.now())
    .all<SqlRow>();
  return (results ?? []).map(shareFromRow);
}

/** Every view (定向分享) handed to an individual user, newest view first. */
export async function loadViewShares(env: Env, databaseId: string) {
  const { results } = await env.DB.prepare(
    `SELECT vs.*, v.name AS view_name, v.position AS view_position, u.email, u.name
       FROM view_shares vs
       JOIN views v ON v.id = vs.view_id
       JOIN users u ON u.id = vs.user_id
      WHERE vs.database_id = ?
      ORDER BY v.position ASC, vs.created_at ASC`,
  )
    .bind(databaseId)
    .all<SqlRow>();
  return (results ?? []).map(viewShareFromRow);
}

export async function buildDatabaseDetail(
  env: Env,
  databaseId: string,
  access: Pick<DatabaseAccess, 'role' | 'viewIds'>,
  url: URL,
): Promise<DatabaseDetail> {
  const row = await env.DB.prepare(
    `SELECT d.*, u.name AS owner_name
       FROM databases d JOIN users u ON u.id = d.owner_id
      WHERE d.id = ? AND d.is_archived = 0`,
  )
    .bind(databaseId)
    .first<SqlRow>();
  if (!row) throw notFound('表格不存在');

  const limit = clampLimit(url);
  const offset = clampOffset(url);
  const scoped = Boolean(access.viewIds?.length);
  const [allProperties, allViews, page, members, shares, viewShares] = await Promise.all([
    loadProperties(env, databaseId),
    loadViews(env, databaseId),
    visibleRecords(env, databaseId, access.viewIds, limit, offset),
    loadMembers(env, databaseId),
    loadShares(env, databaseId),
    loadViewShares(env, databaseId),
  ]);

  const views = scoped ? allViews.filter((view) => access.viewIds?.includes(view.id)) : allViews;
  const properties = scoped ? scopedProperties(allProperties, views) : allProperties;

  return {
    id: databaseId,
    name: sqlString(row, 'name'),
    icon: sqlString(row, 'icon', '📋'),
    description: sqlString(row, 'description'),
    ownerId: sqlString(row, 'owner_id'),
    role: access.role,
    locked: sqlNumber(row, 'is_locked') === 1,
    viewScoped: scoped,
    createdAt: sqlNumber(row, 'created_at'),
    updatedAt: sqlNumber(row, 'updated_at'),
    properties,
    views,
    members,
    shares,
    viewShares,
    rows: page.rows,
    total: page.total,
    hasMore: offset + page.rows.length < page.total,
  };
}

/** Synthetic access object for the just-created table of `ownerId`. */
export function ownerAccess(databaseId: string, ownerId: string): DatabaseAccess {
  return { databaseId, ownerId, role: 'owner', locked: false, viewIds: null };
}

export async function touchDatabase(env: Env, databaseId: string): Promise<void> {
  await env.DB.prepare('UPDATE databases SET updated_at = ? WHERE id = ?')
    .bind(Date.now(), databaseId)
    .run();
}

export { TEMPLATES };

/* ------------------------------------------------------------------ routes */

async function listHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const databases = await listDatabases(ctx.env, user.id);
  return json({
    databases,
    user,
    maxUploadMb: Number(ctx.env.MAX_UPLOAD_MB ?? 25),
    appName: ctx.env.APP_NAME ?? 'CloudNotion',
  });
}

async function createHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const body = await readJson(ctx.request);
  const name = asString(body.name, '表格名称', { required: true, max: 120 });
  const icon = asString(body.icon, '图标', { max: 8 }) || '📋';
  const description = asString(body.description, '描述', { max: 500 });
  const templateId = asString(body.templateId, '模板', { max: 40 }) || 'blank';
  if (!TEMPLATES.some((template) => template.id === templateId)) throw notFound('模板不存在');

  const created = await createDatabase(ctx.env, user.id, { name, icon, description, templateId });
  return json(await buildDatabaseDetail(ctx.env, created.databaseId, ownerAccess(created.databaseId, user.id), ctx.url), {
    status: 201,
  });
}

async function detailHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx.env, ctx.params.id, user, 'view');
  return json(await buildDatabaseDetail(ctx.env, ctx.params.id, access, ctx.url));
}

async function recordsPageHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx.env, ctx.params.id, user, 'view');
  const limit = clampLimit(ctx.url);
  const offset = clampOffset(ctx.url);
  const { rows, total } = await visibleRecords(ctx.env, ctx.params.id, access.viewIds, limit, offset);
  return json({ rows, total, hasMore: offset + rows.length < total });
}

async function updateHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx.env, ctx.params.id, user, 'edit');
  const body = await readJson(ctx.request);
  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    fields.push('name = ?');
    values.push(asString(body.name, '表格名称', { required: true, max: 120 }));
  }
  if (body.icon !== undefined) {
    fields.push('icon = ?');
    values.push(asString(body.icon, '图标', { max: 8 }));
  }
  if (body.description !== undefined) {
    fields.push('description = ?');
    values.push(asString(body.description, '描述', { max: 500 }));
  }
  if (body.locked !== undefined) {
    if (access.role !== 'owner') throw forbidden('只有所有者可以锁定或解锁表格');
    fields.push('is_locked = ?');
    values.push(body.locked ? 1 : 0);
  }
  if (!fields.length) return json(await buildDatabaseDetail(ctx.env, ctx.params.id, access, ctx.url));

  fields.push('updated_at = ?');
  values.push(Date.now(), ctx.params.id);
  await ctx.env.DB.prepare(`UPDATE databases SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
  return json(await buildDatabaseDetail(ctx.env, ctx.params.id, access, ctx.url));
}

async function deleteHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  await requireDatabaseAccess(ctx.env, ctx.params.id, user, 'manage');

  // purge the uploaded blobs from R2 before dropping the metadata
  const { results } = await ctx.env.DB.prepare('SELECT r2_key FROM files WHERE database_id = ?')
    .bind(ctx.params.id)
    .all<SqlRow>();
  const keys = (results ?? []).map((row) => sqlString(row, 'r2_key')).filter(Boolean);
  for (let i = 0; i < keys.length; i += 100) {
    await ctx.env.BUCKET.delete(keys.slice(i, i + 100));
  }

  await ctx.env.DB.prepare('DELETE FROM databases WHERE id = ?').bind(ctx.params.id).run();
  return json({ ok: true });
}

async function accessForMember(ctx: RequestContext, memberId: string) {
  const row = await ctx.env.DB.prepare('SELECT database_id FROM database_members WHERE id = ?')
    .bind(memberId)
    .first<SqlRow>();
  if (!row) throw notFound('成员不存在');
  const databaseId = sqlString(row, 'database_id');
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx.env, databaseId, user, 'manage');
  return { databaseId, access };
}

async function addMemberHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx.env, ctx.params.id, user, 'manage');
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  const role = asEnum(body.role ?? 'editor', ['editor', 'viewer'] as const, '角色');

  const target = await ctx.env.DB.prepare('SELECT id, email, name FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();
  if (!target) throw notFound('该邮箱尚未注册，请先让对方注册账号');

  const targetId = sqlString(target, 'id');
  if (targetId === access.ownerId) throw conflict('所有者已经拥有该表格');

  await ctx.env.DB.prepare(
    `INSERT INTO database_members (id, database_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (database_id, user_id) DO UPDATE SET role = excluded.role`,
  )
    .bind(newId(), ctx.params.id, targetId, role, Date.now())
    .run();

  await touchDatabase(ctx.env, ctx.params.id);
  return json({ members: await loadMembers(ctx.env, ctx.params.id) });
}

async function updateMemberHandler(ctx: RequestContext): Promise<Response> {
  if (isOwnerMemberId(ctx.params.id)) throw badRequest('不能修改所有者的权限');
  const { databaseId, access } = await accessForMember(ctx, ctx.params.id);
  const body = await readJson(ctx.request);
  const role = asEnum(body.role, ['editor', 'viewer'] as const, '角色');
  await ctx.env.DB.prepare(
    `UPDATE database_members SET role = ? WHERE id = ? AND database_id = ?`,
  )
    .bind(role, ctx.params.id, databaseId)
    .run();
  return json({ members: await loadMembers(ctx.env, databaseId), role: access.role });
}

async function removeMemberHandler(ctx: RequestContext): Promise<Response> {
  if (isOwnerMemberId(ctx.params.id)) throw badRequest('不能移除所有者');
  const { databaseId } = await accessForMember(ctx, ctx.params.id);
  await ctx.env.DB.prepare('DELETE FROM database_members WHERE id = ? AND database_id = ?')
    .bind(ctx.params.id, databaseId)
    .run();
  return json({ members: await loadMembers(ctx.env, databaseId) });
}

async function createShareHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  await requireDatabaseAccess(ctx.env, ctx.params.id, user, 'edit');
  const body = await readJson(ctx.request);
  const permission = asEnum(body.permission ?? 'view', ['view', 'edit'] as const, '权限');
  const days = Number(body.expiresInDays ?? 0);
  const expiresAt = Number.isFinite(days) && days > 0 ? Date.now() + days * 86_400_000 : null;

  const token = randomToken(24);
  await ctx.env.DB.prepare(
    `INSERT INTO shares (id, database_id, token, permission, created_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId(), ctx.params.id, token, permission, user.id, expiresAt, Date.now())
    .run();

  return json({ shares: await loadShares(ctx.env, ctx.params.id) }, { status: 201 });
}

async function deleteShareHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const row = await ctx.env.DB.prepare('SELECT database_id FROM shares WHERE id = ?')
    .bind(ctx.params.id)
    .first<SqlRow>();
  if (!row) throw notFound('分享链接不存在');
  const databaseId = sqlString(row, 'database_id');
  await requireDatabaseAccess(ctx.env, databaseId, user, 'edit');
  await ctx.env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(ctx.params.id).run();
  return json({ shares: await loadShares(ctx.env, databaseId) });
}

async function createViewShareHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx.env, ctx.params.id, user, 'manage');
  const body = await readJson(ctx.request);
  const viewId = asString(body.viewId, '视图', { required: true, max: 64 });
  const role = asEnum(body.role ?? 'viewer', ['viewer', 'editor'] as const, '角色');
  const email = normalizeEmail(body.email);

  const view = await ctx.env.DB.prepare('SELECT id FROM views WHERE id = ? AND database_id = ?')
    .bind(viewId, ctx.params.id)
    .first<SqlRow>();
  if (!view) throw notFound('视图不存在');

  const target = await ctx.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<SqlRow>();
  if (!target) throw notFound('该邮箱尚未注册，请先让对方注册账号');
  const targetId = sqlString(target, 'id');
  if (targetId === access.ownerId) throw conflict('所有者已经拥有该表格');

  await ctx.env.DB.prepare(
    `INSERT INTO view_shares (id, database_id, view_id, user_id, role, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (view_id, user_id) DO UPDATE SET role = excluded.role`,
  )
    .bind(newId(), ctx.params.id, viewId, targetId, role, user.id, Date.now())
    .run();

  await touchDatabase(ctx.env, ctx.params.id);
  return json({ viewShares: await loadViewShares(ctx.env, ctx.params.id) }, { status: 201 });
}

async function deleteViewShareHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const row = await ctx.env.DB.prepare('SELECT database_id FROM view_shares WHERE id = ?')
    .bind(ctx.params.id)
    .first<SqlRow>();
  if (!row) throw notFound('视图分享不存在');
  const databaseId = sqlString(row, 'database_id');
  await requireDatabaseAccess(ctx.env, databaseId, user, 'manage');
  await ctx.env.DB.prepare('DELETE FROM view_shares WHERE id = ?').bind(ctx.params.id).run();
  return json({ viewShares: await loadViewShares(ctx.env, databaseId) });
}

export const databaseRoutes: Route[] = [
  { method: 'GET', path: '/api/databases', handler: listHandler },
  { method: 'POST', path: '/api/databases', handler: createHandler },
  { method: 'GET', path: '/api/databases/:id', handler: detailHandler },
  { method: 'PATCH', path: '/api/databases/:id', handler: updateHandler },
  { method: 'DELETE', path: '/api/databases/:id', handler: deleteHandler },
  { method: 'GET', path: '/api/databases/:id/records', handler: recordsPageHandler },
  { method: 'POST', path: '/api/databases/:id/members', handler: addMemberHandler },
  { method: 'PATCH', path: '/api/members/:id', handler: updateMemberHandler },
  { method: 'DELETE', path: '/api/members/:id', handler: removeMemberHandler },
  { method: 'POST', path: '/api/databases/:id/shares', handler: createShareHandler },
  { method: 'DELETE', path: '/api/shares/:id', handler: deleteShareHandler },
  { method: 'POST', path: '/api/databases/:id/view-shares', handler: createViewShareHandler },
  { method: 'DELETE', path: '/api/view-shares/:id', handler: deleteViewShareHandler },
];




