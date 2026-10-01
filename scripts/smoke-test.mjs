#!/usr/bin/env node
/**
 * End-to-end smoke test for CloudNotion.
 *
 * Runs against a live Worker - either `npm run dev` / `npm run preview`
 * (http://127.0.0.1:8787) or a deployed URL:
 *
 *   node scripts/smoke-test.mjs
 *   BASE_URL=https://cloudnotion.example.workers.dev node scripts/smoke-test.mjs
 *
 * It registers a throw-away account and walks the critical path: session ->
 * create table -> add field -> records (create/update/duplicate/delete) ->
 * views -> share links -> public read + edit -> members -> notes + @mention
 * inbox -> file upload -> cleanup. Exit code is 1 when any check fails.
 */
const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'Smoke1test';

let cookie = '';
const checks = [];

function section(title) {
  console.log(`\n${title}`);
}

function check(name, ok, detail = '') {
  checks.push({ name, ok });
  if (ok) console.log(`  ok   ${name}${detail ? `  (${detail})` : ''}`);
  else console.error(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
}

function storeCookies(response) {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
  for (const item of raw) {
    const pair = String(item).split(';')[0];
    if (pair) cookie = pair;
  }
}

async function call(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.cookie !== false && cookie) headers.cookie = cookie;

  let body;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
    redirect: 'manual',
  });
  if (options.cookie !== false) storeCookies(response);

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, ok: response.ok, data, headers: response.headers };
}

async function waitForServer(attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function textOf(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** 与 `src/shared/fields.ts` 的 `CELL_EDIT_GRACE_MS` 保持一致：单元格纠错窗口 10 秒 */
const CELL_EDIT_GRACE_MS = 10_000;

/** 等一次单元格纠错窗口过期（多留 1.2 秒余量，避免边界抖动） */
function waitForGraceWindow() {
  return new Promise((resolve) => setTimeout(resolve, CELL_EDIT_GRACE_MS + 1_200));
}

async function main() {
  section(`CloudNotion smoke test -> ${BASE}`);
  const alive = await waitForServer();
  if (!check('worker reachable (/api/health)', alive)) {
    console.error('\nStart the worker first: npm run dev');
    process.exitCode = 1;
    return;
  }

  const health = await call('/api/health');
  check('health payload', health.data?.ok === true, `${health.data?.app ?? ''}`);

  // ---------------------------------------------------------------- account
  section('account');
  const email = `smoke+${Date.now()}@example.com`;
  const registered = await call('/api/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, name: 'Smoke Tester' },
  });
  if (!check('register', registered.status === 201 && registered.data?.user?.email === email, `status=${registered.status}`)) {
    if (registered.status === 403) console.error('   (signup is disabled: ALLOW_SIGNUP="false")');
    process.exitCode = 1;
    return;
  }

  const session = await call('/api/session');
  const starterCount = session.data?.databases?.length ?? 0;
  check('session carries the new user', session.data?.user?.email === email);
  check('starter table created', starterCount >= 1, `${starterCount} table(s)`);
  check('session exposes app meta', typeof session.data?.appName === 'string' && typeof session.data?.maxUploadMb === 'number');

  // ------------------------------------------------------------- table + fields
  section('tables and fields');
  const created = await call('/api/databases', {
    method: 'POST',
    body: { name: 'Smoke 表格', templateId: 'task' },
  });
  const databaseId = created.data?.id;
  if (!check('create table from template', created.status === 201 && Boolean(databaseId), `status=${created.status}`)) {
    process.exitCode = 1;
    return;
  }
  check('template fields materialised', (created.data?.properties?.length ?? 0) >= 4, `${created.data?.properties?.length ?? 0} fields`);
  check(
    'default view created',
    (created.data?.views ?? []).some((view) => view.type === 'table'),
    `${created.data?.views?.length ?? 0} view(s): ${(created.data?.views ?? []).map((view) => view.type).join('/')}`,
  );
  check('role is owner', created.data?.role === 'owner', textOf(created.data?.role));
  check('members include the owner', (created.data?.members?.length ?? 0) === 1);

  // 新建表格不再让用户挑模板：不传 templateId 时应当落成「空白表格」（只有一个「名称」字段）
  const blankTable = await call('/api/databases', { method: 'POST', body: { name: '空白表格' } });
  const blankFields = blankTable.data?.properties ?? [];
  check(
    'table created without templateId is blank',
    blankTable.status === 201 && blankFields.length === 1 && blankFields[0]?.name === '名称',
    `status=${blankTable.status} fields=${blankFields.map((property) => property.name).join('/')}`,
  );
  if (blankTable.data?.id) {
    const removedBlank = await call(`/api/databases/${blankTable.data.id}`, { method: 'DELETE' });
    check('cleanup the blank table', removedBlank.status === 200, `status=${removedBlank.status}`);
  }

  const titleProperty = (created.data.properties ?? []).find((property) => property.type === 'text');
  const statusProperty = (created.data.properties ?? []).find((property) => property.type === 'select');
  const checkProperty = (created.data.properties ?? []).find((property) => property.type === 'checkbox');
  // 任务模板里的「状态」是 status 类型字段：新建记录默认落到「录入中」
  const stateProperty = (created.data.properties ?? []).find((property) => property.type === 'status');

  const added = await call(`/api/databases/${databaseId}/properties`, {
    method: 'POST',
    body: { name: '数量', type: 'number', config: { format: 'plain', precision: 0 } },
  });
  const numberProperty = (added.data?.properties ?? []).find((property) => property.name === '数量');
  check('add number field', Boolean(numberProperty), `fields=${added.data?.properties?.length ?? 0}`);

  const renamed = await call(`/api/properties/${numberProperty?.id}`, {
    method: 'PATCH',
    body: { name: '数量(件)' },
  });
  check(
    'rename field',
    (renamed.data?.properties ?? []).some((property) => property.name === '数量(件)'),
  );
  check('field width persisted', (renamed.data?.properties ?? []).some((property) => property.width > 0));

  // ------------------------------------------------------------------ records
  section('records');
  const first = await call(`/api/databases/${databaseId}/records`, {
    method: 'POST',
    body: { values: { [titleProperty.id]: '第一条记录', [numberProperty?.id]: 3 } },
  });
  const firstId = first.data?.record?.id;
  check('create record', first.status === 201 && Boolean(firstId), `status=${first.status}`);

  const listed = await call(`/api/databases/${databaseId}/rows?limit=50`);
  check('list rows', listed.data?.total === 1 && listed.data?.rows?.length === 1, `total=${listed.data?.total}`);

  const patched = await call(`/api/records/${firstId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '第一条记录（改）', [numberProperty?.id]: 5 } },
  });
  check(
    'update record',
    patched.data?.record?.values?.[titleProperty.id] === '第一条记录（改）',
    textOf(patched.data?.record?.values?.[numberProperty?.id]),
  );

  const bulk = await call(`/api/databases/${databaseId}/records/bulk`, {
    method: 'POST',
    body: { records: [{ [titleProperty.id]: '批量 A' }, { [titleProperty.id]: '批量 B' }] },
  });
  check('bulk create', bulk.status === 201 && (bulk.data?.records?.length ?? 0) === 2, `total=${bulk.data?.total}`);
  if (statusProperty && checkProperty) {
    const statusOption = statusProperty.config?.options?.[0];
    const flags = await call(`/api/records/${firstId}`, {
      method: 'PATCH',
      body: { values: { [statusProperty.id]: statusOption?.name, [checkProperty.id]: true } },
    });
    const values = flags.data?.record?.values ?? {};
    check(
      'select + checkbox round-trip',
      values[statusProperty.id]?.name === statusOption?.name && values[checkProperty.id] === true,
      textOf(values[checkProperty.id]),
    );
  }

  const duplicated = await call(`/api/databases/${databaseId}/records/duplicate`, {
    method: 'POST',
    body: { recordIds: [firstId] },
  });
  check('duplicate record', duplicated.status === 201 && (duplicated.data?.records?.length ?? 0) === 1);

  const bulkDelete = await call(`/api/databases/${databaseId}/records/delete`, {
    method: 'POST',
    body: { recordIds: (bulk.data?.records ?? []).map((record) => record.id) },
  });
  check('bulk delete', bulkDelete.data?.deleted === 2, `total=${bulkDelete.data?.total}`);

  // -------------------------------------------- 状态默认值（新建 → 录入中）
  section('status defaults (录入中)');
  const rowsWithStatus = await call(`/api/databases/${databaseId}/rows?limit=50`);
  const firstRow = (rowsWithStatus.data?.rows ?? []).find((row) => row.id === firstId);
  check(
    'new record defaults its status field to 录入中',
    Boolean(stateProperty) && firstRow?.values?.[stateProperty.id]?.name === '录入中',
    `status=${textOf(firstRow?.values?.[stateProperty?.id])}`,
  );

  const detailWithStatus = await call(`/api/databases/${databaseId}`);
  const statusWithDefault = (detailWithStatus.data?.properties ?? []).find((property) => property.id === stateProperty?.id);
  check(
    '「录入中」is appended to the status field options',
    (statusWithDefault?.config?.options ?? []).some((option) => option.name === '录入中'),
    `options=${textOf((statusWithDefault?.config?.options ?? []).map((option) => option.name))}`,
  );

  const explicitStatus = await call(`/api/databases/${databaseId}/records`, {
    method: 'POST',
    body: { values: { [titleProperty.id]: '显式状态', [stateProperty?.id]: '进行中' } },
  });
  check(
    'an explicitly provided status value is kept',
    explicitStatus.data?.record?.values?.[stateProperty?.id]?.name === '进行中',
    `status=${textOf(explicitStatus.data?.record?.values?.[stateProperty?.id])}`,
  );
  const explicitStatusId = explicitStatus.data?.record?.id;
  if (explicitStatusId) {
    const explicitRemoved = await call(`/api/records/${explicitStatusId}`, { method: 'DELETE' });
    check('cleanup the explicit status row', explicitRemoved.data?.ok === true, `status=${explicitRemoved.status}`);
  }

  // -------------------------------------------------------------------- views
  section('views');
  const baseView = (created.data.views ?? [])[0];
  const newView = await call(`/api/databases/${databaseId}/views`, {
    method: 'POST',
    body: { name: '看板', type: 'board', config: { groupBy: statusProperty?.id } },
  });
  const boardViewId = newView.data?.viewId;
  check('create board view', newView.status === 201 && Boolean(boardViewId), `status=${newView.status}`);

  // 前端「＋ 新建视图」不再传 type：后端应当默认落成表格视图
  const defaultTypeView = await call(`/api/databases/${databaseId}/views`, {
    method: 'POST',
    body: { name: '默认类型视图' },
  });
  const defaultTypeRow = (defaultTypeView.data?.views ?? []).find(
    (view) => view.id === defaultTypeView.data?.viewId,
  );
  check(
    'view created without a type stays a table view',
    defaultTypeView.status === 201 && defaultTypeRow?.type === 'table',
    `status=${defaultTypeView.status} type=${defaultTypeRow?.type}`,
  );
  if (defaultTypeRow) {
    const removedDefaultType = await call(`/api/views/${defaultTypeRow.id}`, { method: 'DELETE' });
    check('delete the default type view', removedDefaultType.status === 200, `status=${removedDefaultType.status}`);
  }

  // 「必须满足」块：第 1 条是块头（不写关系），第 2 条用 conjunction: 'and' 另起一块
  const patchedView = await call(`/api/views/${baseView.id}`, {
    method: 'PATCH',
    body: {
      config: {
        filters: {
          conjunction: 'and',
          conditions: [
            { propertyId: titleProperty.id, operator: 'contains', value: '第一条' },
            { propertyId: titleProperty.id, operator: 'is_not_empty', conjunction: 'and' },
          ],
        },
      },
    },
  });
  const savedConditions = patchedView.data?.views?.find((view) => view.id === baseView.id)?.config?.filters?.conditions ?? [];
  check('save view filters', savedConditions.length === 2, JSON.stringify(savedConditions));
  check(
    'save per-condition conjunction',
    savedConditions[0]?.conjunction === undefined && savedConditions[1]?.conjunction === 'and',
    JSON.stringify(savedConditions.map((condition) => condition.conjunction)),
  );

  // a view created from the "＋ 新建视图" form carries name + multi conditions + lock
  const lockedView = await call(`/api/databases/${databaseId}/views`, {
    method: 'POST',
    body: {
      name: '锁定视图',
      type: 'table',
      config: {
        filters: {
          conjunction: 'or',
          conditions: [
            { propertyId: titleProperty.id, operator: 'contains', value: '第一' },
            { propertyId: titleProperty.id, operator: 'is_not_empty', conjunction: 'or' },
          ],
        },
      },
      locked: true,
    },
  });
  const lockedViewId = lockedView.data?.viewId;
  const lockedRow = (lockedView.data?.views ?? []).find((view) => view.id === lockedViewId);
  check(
    'create locked view with multi-condition filters',
    lockedView.status === 201 &&
      lockedRow?.name === '锁定视图' &&
      lockedRow?.locked === true &&
      lockedRow?.config?.filters?.conjunction === 'or' &&
      lockedRow?.config?.filters?.conditions?.[1]?.conjunction === 'or' &&
      (lockedRow?.config?.filters?.conditions ?? []).length === 2,
    `status=${lockedView.status} locked=${lockedRow?.locked} conditions=${lockedRow?.config?.filters?.conditions?.length ?? 0}`,
  );

  const renameLocked = await call(`/api/views/${lockedViewId}`, { method: 'PATCH', body: { name: '不允许改名' } });
  check(
    'locked view rejects rename',
    renameLocked.status === 403,
    `status=${renameLocked.status} err=${renameLocked.data?.error?.message ?? ''}`,
  );

  const unlockView = await call(`/api/views/${lockedViewId}`, { method: 'PATCH', body: { locked: false } });
  const unlockedRow = (unlockView.data?.views ?? []).find((view) => view.id === lockedViewId);
  check('unlock view', unlockView.status === 200 && unlockedRow?.locked === false, `status=${unlockView.status}`);

  const deleteLocked = await call(`/api/views/${lockedViewId}`, { method: 'DELETE' });
  check(
    'delete the previously locked view',
    deleteLocked.status === 200 && (deleteLocked.data?.views ?? []).every((view) => view.id !== lockedViewId),
    `status=${deleteLocked.status}`,
  );

  // ----------------------------- 表级锁定已移除（locked 参数被忽略，结构始终可改）
  section('table lock removed');
  const ignoredLock = await call(`/api/databases/${databaseId}`, {
    method: 'PATCH',
    body: { locked: true },
  });
  check(
    'table lock parameter is ignored',
    ignoredLock.status === 200 && ignoredLock.data?.locked === false,
    `status=${ignoredLock.status} locked=${ignoredLock.data?.locked}`,
  );

  const probeField = await call(`/api/databases/${databaseId}/properties`, {
    method: 'POST',
    body: { name: '锁定参数已忽略', type: 'text' },
  });
  check(
    'structure stays editable after locked=true',
    probeField.status === 201,
    `status=${probeField.status}`,
  );

  const probeProperty = (probeField.data?.properties ?? []).find(
    (property) => property.name === '锁定参数已忽略',
  );
  const removedProbe = probeProperty
    ? await call(`/api/properties/${probeProperty.id}`, { method: 'DELETE' })
    : null;
  check('cleanup the probe field', removedProbe === null || removedProbe.status === 200, `status=${removedProbe?.status}`);

  const viewsBefore = (patchedView.data?.views ?? []).length;
  const removedView = await call(`/api/views/${boardViewId}`, { method: 'DELETE' });
  check(
    'delete view',
    Array.isArray(removedView.data?.views) &&
      removedView.data.views.length === viewsBefore - 1 &&
      removedView.data.views.every((view) => view.id !== boardViewId),
    `viewId=${boardViewId} views=${viewsBefore}->${removedView.data?.views?.length ?? 0} status=${removedView.status} err=${removedView.data?.error?.message ?? ''}`,
  );

  // ------------------------------------------------ 字段锁定 + 列移动
  section('field lock + column order');
  const lockedField = await call(`/api/properties/${titleProperty.id}`, {
    method: 'PATCH',
    body: { locked: true },
  });
  check(
    'lock a field',
    lockedField.status === 200 &&
      lockedField.data?.property?.locked === true &&
      (lockedField.data?.properties ?? []).some(
        (property) => property.id === titleProperty.id && property.locked === true,
      ),
    `status=${lockedField.status}`,
  );

  const blockedCell = await call(`/api/records/${firstId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '锁定后不应写入' } },
  });
  check('locked field refuses a cell update', blockedCell.status === 400, `status=${blockedCell.status}`);

  const afterBlocked = await call(`/api/databases/${databaseId}/rows?limit=50`);
  check(
    'locked field keeps its stored value',
    (afterBlocked.data?.rows ?? []).find((row) => row.id === firstId)?.values?.[titleProperty.id] ===
      '第一条记录（改）',
  );

  const otherCell = await call(`/api/records/${firstId}`, {
    method: 'PATCH',
    body: { values: { [numberProperty?.id]: 11 } },
  });
  check('unlocked fields stay editable', otherCell.status === 200, `status=${otherCell.status}`);

  const lockedForm = new FormData();
  lockedForm.set('file', new Blob(['locked'], { type: 'text/plain' }), 'locked.txt');
  lockedForm.set('databaseId', databaseId);
  lockedForm.set('recordId', firstId);
  lockedForm.set('propertyId', titleProperty.id);
  const blockedUpload = await call('/api/files', { method: 'POST', form: lockedForm });
  check('locked field refuses uploads', blockedUpload.status === 403, `status=${blockedUpload.status}`);

  // ← / →：交换相邻两列的 position 即可调整顺序
  const [firstField, secondField] = renamed.data?.properties ?? [];
  await call(`/api/properties/${firstField.id}`, { method: 'PATCH', body: { position: secondField.position } });
  const swapped = await call(`/api/properties/${secondField.id}`, {
    method: 'PATCH',
    body: { position: firstField.position },
  });
  const swappedOrder = (swapped.data?.properties ?? []).map((property) => property.id);
  check(
    'move column left/right swaps the order',
    swappedOrder[0] === secondField.id && swappedOrder[1] === firstField.id,
    swappedOrder.slice(0, 2).join(' -> '),
  );

  const unlockedField = await call(`/api/properties/${titleProperty.id}`, {
    method: 'PATCH',
    body: { locked: false },
  });
  const restored = await call(`/api/records/${firstId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '第一条记录（改）' } },
  });
  check(
    'unlock a field restores editing',
    unlockedField.data?.property?.locked === false && restored.status === 200,
    `status=${restored.status}`,
  );

  // ------------------------------------------------------------ sharing
  section('sharing');
  const shareView = await call(`/api/databases/${databaseId}/shares`, {
    method: 'POST',
    body: { permission: 'view', expiresInDays: 7 },
  });
  const viewToken = (shareView.data?.shares ?? [])[0]?.token;
  check('create read-only link', Boolean(viewToken), `shares=${shareView.data?.shares?.length ?? 0}`);

  const shareEdit = await call(`/api/databases/${databaseId}/shares`, {
    method: 'POST',
    body: { permission: 'edit', limitEdits: true },
  });
  const editShareRow = (shareEdit.data?.shares ?? []).find((share) => share.permission === 'edit');
  const editToken = editShareRow?.token;
  check(
    'create editable link with 限制编辑',
    Boolean(editToken) && editShareRow?.limitEdits === true,
    `limitEdits=${editShareRow?.limitEdits}`,
  );

  const publicRead = await call(`/api/public/${viewToken}`, { cookie: false });
  check(
    'public read without a session',
    publicRead.data?.database?.permission === 'view' &&
      publicRead.data?.database?.limitEdits === false &&
      (publicRead.data?.rows?.length ?? 0) >= 1,
    `rows=${publicRead.data?.rows?.length ?? 0} limitEdits=${publicRead.data?.database?.limitEdits}`,
  );

  const publicWrite = await call(`/api/public/${viewToken}/records`, {
    method: 'POST',
    cookie: false,
    body: { values: { [titleProperty.id]: '只读链接不应写入' } },
  });
  check('read-only link refuses writes', publicWrite.status === 403, `status=${publicWrite.status}`);

  const publicEdit = await call(`/api/public/${editToken}/records`, {
    method: 'POST',
    cookie: false,
    body: { values: { [titleProperty.id]: '来自公开链接' } },
  });
  const publicRecordId = publicEdit.data?.record?.id;
  check('editable link creates a row', publicEdit.status === 201 && Boolean(publicRecordId), `status=${publicEdit.status}`);

  const publicPatch = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: '公开链接已更新' } },
  });
  check('editable link updates a row', publicPatch.data?.record?.values?.[titleProperty.id] === '公开链接已更新');

  // 每格一次机会，但第一次保存成功后的 10 秒内还能改回来（纠错窗口）
  const publicSecondEdit = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: '窗口内改回来' } },
  });
  check(
    'a cell stays editable inside the 10s grace window',
    publicSecondEdit.status === 200 &&
      publicSecondEdit.data?.record?.values?.[titleProperty.id] === '窗口内改回来',
    `status=${publicSecondEdit.status} err=${publicSecondEdit.data?.error?.message ?? ''}`,
  );
  check(
    'the PATCH payload opens a window instead of locking the cell',
    Number(publicSecondEdit.data?.cellEditGrace?.[`${publicRecordId}:${titleProperty.id}`]) > Date.now() &&
      (publicSecondEdit.data?.lockedCells ?? []).length === 0,
    `cellEditGrace=${textOf(publicSecondEdit.data?.cellEditGrace)} lockedCells=${textOf(publicSecondEdit.data?.lockedCells)}`,
  );

  // 窗口从第一次保存成功算起，不因窗口内的修改而延长：等满 10 秒再改就该被拒
  await waitForGraceWindow();
  const publicAfterGraceEdit = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: '窗口已过，应被拒绝' } },
  });
  check(
    'once the grace window closes the same cell is refused',
    publicAfterGraceEdit.status === 403,
    `status=${publicAfterGraceEdit.status} err=${publicAfterGraceEdit.data?.error?.message ?? ''}`,
  );

  // 提交的值没变不算改动，不会白白消耗那次机会（这一格的窗口已经关了也一样放行）
  const publicNoopEdit = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: '窗口内改回来' } },
  });
  check(
    'an unchanged value does not spend the one-shot chance',
    publicNoopEdit.status === 200,
    `status=${publicNoopEdit.status} err=${publicNoopEdit.data?.error?.message ?? ''}`,
  );

  const publicOtherCell = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [numberProperty?.id]: 11 } },
  });
  check(
    'a different cell is still editable',
    publicOtherCell.status === 200 && publicOtherCell.data?.record?.values?.[numberProperty?.id] === 11,
    `status=${publicOtherCell.status} err=${publicOtherCell.data?.error?.message ?? ''}`,
  );

  const publicAfterEdits = await call(`/api/public/${editToken}`, { cookie: false });
  const lockedAfterEdits = publicAfterEdits.data?.lockedCells ?? [];
  const graceAfterEdits = publicAfterEdits.data?.cellEditGrace ?? {};
  check(
    'the public payload locks the spent cell and keeps the fresh one in its window',
    lockedAfterEdits.includes(`${publicRecordId}:${titleProperty.id}`) &&
      Number(graceAfterEdits[`${publicRecordId}:${numberProperty?.id}`]) > Date.now() &&
      !Object.keys(graceAfterEdits).includes(`${publicRecordId}:${titleProperty.id}`),
    `lockedCells=${textOf(lockedAfterEdits)} cellEditGrace=${textOf(Object.keys(graceAfterEdits))}`,
  );

  // 没勾选「限制编辑」的可编辑链接：同一个格子可以反复修改，也不会有锁定标记
  const shareIdsBeforeFree = new Set((shareEdit.data?.shares ?? []).map((item) => item.id));
  const freeLink = await call(`/api/databases/${databaseId}/shares`, {
    method: 'POST',
    body: { permission: 'edit' },
  });
  const freeShare = (freeLink.data?.shares ?? []).find((item) => !shareIdsBeforeFree.has(item.id));
  check(
    'an editable link without 限制编辑',
    freeLink.status === 201 && freeShare?.permission === 'edit' && freeShare?.limitEdits === false,
    `limitEdits=${freeShare?.limitEdits}`,
  );

  const freeFirstEdit = await call(`/api/public/${freeShare?.token}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: '不限制编辑（第一次）' } },
  });
  const freeSecondEdit = await call(`/api/public/${freeShare?.token}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: '不限制编辑（第二次）' } },
  });
  check(
    'the same cell stays editable when 限制编辑 is off',
    freeFirstEdit.status === 200 &&
      freeSecondEdit.status === 200 &&
      freeSecondEdit.data?.record?.values?.[titleProperty.id] === '不限制编辑（第二次）',
    `first=${freeFirstEdit.status} second=${freeSecondEdit.status} err=${freeSecondEdit.data?.error?.message ?? ''}`,
  );

  const freePayload = await call(`/api/public/${freeShare?.token}`, { cookie: false });
  check(
    'an unlimited edit link reports no locked cells and no grace window',
    freePayload.data?.database?.limitEdits === false &&
      (freePayload.data?.lockedCells ?? []).length === 0 &&
      Object.keys(freePayload.data?.cellEditGrace ?? {}).length === 0,
    `limitEdits=${freePayload.data?.database?.limitEdits} lockedCells=${textOf(freePayload.data?.lockedCells)} cellEditGrace=${textOf(freePayload.data?.cellEditGrace)}`,
  );

  if (freeShare) {
    const removedFreeLink = await call(`/api/shares/${freeShare.id}`, { method: 'DELETE' });
    check(
      'cleanup the unlimited edit link',
      removedFreeLink.status === 200 && (removedFreeLink.data?.shares ?? []).every((item) => item.id !== freeShare.id),
      `status=${removedFreeLink.status}`,
    );
  }

  // 换一条编辑链接：同一个格子又拿到一次机会（按链接区分归属）
  const shareIdsBefore = new Set((shareEdit.data?.shares ?? []).map((item) => item.id));
  if (freeShare) shareIdsBefore.add(freeShare.id);
  const shareEdit2 = await call(`/api/databases/${databaseId}/shares`, {
    method: 'POST',
    body: { permission: 'edit', limitEdits: true },
  });
  const editShare2 = (shareEdit2.data?.shares ?? []).find((item) => !shareIdsBefore.has(item.id));
  const secondLinkEdit = await call(`/api/public/${editShare2?.token}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: '另一条链接还能改一次' } },
  });
  check(
    'another edit link gets its own one-shot chance',
    secondLinkEdit.status === 200,
    `status=${secondLinkEdit.status} err=${secondLinkEdit.data?.error?.message ?? ''}`,
  );

  // 表格所有者不受「只能改一次」限制，也看不到锁定标记
  const ownerEditsSpentCell = await call(`/api/records/${publicRecordId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '所有者不受限制' } },
  });
  check(
    'the owner may edit a spent cell',
    ownerEditsSpentCell.status === 200 && ownerEditsSpentCell.data?.record?.values?.[titleProperty.id] === '所有者不受限制',
    `status=${ownerEditsSpentCell.status}`,
  );
  const ownerRows = await call(`/api/databases/${databaseId}/rows?limit=50`);
  check(
    'the owner sees no locked cells',
    Array.isArray(ownerRows.data?.lockedCells) && ownerRows.data.lockedCells.length === 0,
    `lockedCells=${textOf(ownerRows.data?.lockedCells)}`,
  );

  if (editShare2) {
    const removedSecondLink = await call(`/api/shares/${editShare2.id}`, { method: 'DELETE' });
    check(
      'cleanup the second edit link',
      (removedSecondLink.data?.shares ?? []).length === 2,
      `shares=${removedSecondLink.data?.shares?.length ?? 0}`,
    );
  }

  const publicDelete = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'DELETE',
    cookie: false,
  });
  check('editable link deletes a row', publicDelete.data?.ok === true);

  const badToken = await call('/api/public/not-a-real-token', { cookie: false });
  check('unknown share token is rejected', badToken.status === 404, `status=${badToken.status}`);


  // ------------------------------------------------------------------ members
  section('members');
  // members can only be invited once they have an account, so create one first
  const memberEmail = `smoke-member+${Date.now()}@example.com`;
  const collaborator = await call('/api/auth/register', {
    cookie: false,
    method: 'POST',
    body: { email: memberEmail, password: PASSWORD, name: 'Smoke Collaborator' },
  });
  check(
    'second account for collaboration',
    collaborator.status === 201 && collaborator.data?.user?.email === memberEmail,
    `status=${collaborator.status}`,
  );

  const invited = await call(`/api/databases/${databaseId}/members`, {
    method: 'POST',
    body: { email: memberEmail, role: 'viewer' },
  });
  const member = (invited.data?.members ?? []).find((item) => item.email === memberEmail);
  check(
    'invite member by email',
    invited.status === 200 && member?.role === 'viewer',
    `members=${invited.data?.members?.length ?? 0} err=${invited.data?.error?.message ?? ''}`,
  );

  const promoted = await call(`/api/members/${member?.id}`, { method: 'PATCH', body: { role: 'editor' } });
  check(
    'change member role',
    (promoted.data?.members ?? []).some((item) => item.email === memberEmail && item.role === 'editor'),
    `status=${promoted.status}`,
  );

  const ownerEntry = (promoted.data?.members ?? []).find((item) => item.role === 'owner');
  check('members list the owner', Boolean(ownerEntry));
  if (ownerEntry) {
    const ownerEdit = await call(`/api/members/${ownerEntry.id}`, { method: 'PATCH', body: { role: 'editor' } });
    check('owner role cannot be changed', ownerEdit.status === 400, `status=${ownerEdit.status}`);
  }

  // ------------------------------------------------ notes + @提醒私信（收件箱）
  section('notes + inbox');
  const notesMemberId = collaborator.data?.user?.id;
  const notesOwnerCookie = cookie;

  const anonNote = await call(`/api/records/${firstId}/notes`, {
    cookie: false,
    method: 'POST',
    body: { body: '匿名备注' },
  });
  check('anonymous visitors cannot add notes', anonNote.status === 401, `status=${anonNote.status}`);

  const mentioned = await call(`/api/records/${firstId}/notes`, {
    method: 'POST',
    body: { body: '这行数据请你确认一下 @Smoke Collaborator', mentions: [notesMemberId] },
  });
  const mentionedNote = (mentioned.data?.notes ?? []).find((note) => note.body.includes('@Smoke Collaborator'));
  check(
    'add a note with an @mention',
    mentioned.status === 201 &&
      mentionedNote?.authorName === 'Smoke Tester' &&
      mentionedNote?.mentions?.length === 1 &&
      mentionedNote.mentions[0].userId === notesMemberId,
    `status=${mentioned.status} notes=${mentioned.data?.notes?.length ?? 0} mentions=${mentionedNote?.mentions?.length ?? 0}`,
  );

  const selfNote = await call(`/api/records/${firstId}/notes`, {
    method: 'POST',
    body: { body: '只给自己看的备注 @Smoke Tester', mentions: [registered.data?.user?.id, 'user-not-here'] },
  });
  const selfNotes = selfNote.data?.notes ?? [];
  const selfNoteRow = selfNotes[selfNotes.length - 1];
  check(
    'nobody is messaged for @自己 / @表格外的人',
    selfNote.status === 201 && (selfNoteRow?.mentions ?? []).length === 0,
    `mentions=${selfNoteRow?.mentions?.length ?? 0}`,
  );
  check('notes come back with the record', selfNotes.length === 2, `notes=${selfNotes.length}`);

  const notesDetail = await call(`/api/databases/${databaseId}`);
  check(
    'database detail carries the notes',
    (notesDetail.data?.notes ?? []).some((note) => note.id === mentionedNote?.id),
    `notes=${notesDetail.data?.notes?.length ?? 0}`,
  );

  const notesRows = await call(`/api/databases/${databaseId}/rows?limit=50`);
  check(
    'paged rows carry the notes of their records',
    (notesRows.data?.notes ?? []).some((note) => note.id === mentionedNote?.id),
    `notes=${notesRows.data?.notes?.length ?? 0}`,
  );

  // 单条记录同步（记录卡片打开时刷新用）：一条记录 = 值 + 备注 + 已用掉的格子
  const recordDetail = (notesDetail.data?.rows ?? []).find((row) => row.id === firstId);
  const synced = await call(`/api/records/${firstId}`);
  check(
    'a single record can be synced on its own',
    synced.status === 200 &&
      synced.data?.record?.id === firstId &&
      synced.data?.record?.values?.[titleProperty.id] === recordDetail?.values?.[titleProperty.id] &&
      Array.isArray(synced.data?.lockedCells) &&
      synced.data.lockedCells.length === 0 &&
      (synced.data?.notes ?? []).some((note) => note.id === mentionedNote?.id),
    `status=${synced.status} notes=${synced.data?.notes?.length ?? 0}`,
  );

  const syncedMissing = await call('/api/records/record-does-not-exist');
  const syncedAnon = await call(`/api/records/${firstId}`, { cookie: false });
  check(
    'syncing a record needs a session and a real record',
    syncedMissing.status === 404 && syncedAnon.status === 401,
    `missing=${syncedMissing.status} anon=${syncedAnon.status}`,
  );

  // 备注只增不改：没有修改 / 删除备注的接口（路径存在但方法不允许）
  const editNote = await call(`/api/records/${firstId}/notes`, { method: 'PATCH', body: { body: '改一下' } });
  const dropNote = await call(`/api/records/${firstId}/notes`, { method: 'DELETE' });
  check(
    'notes cannot be edited or deleted',
    editNote.status === 405 && dropNote.status === 405,
    `patch=${editNote.status} delete=${dropNote.status}`,
  );

  const ownerInbox = await call('/api/inbox');
  check(
    'the author never messages themselves',
    ownerInbox.data?.unread === 0 && (ownerInbox.data?.messages ?? []).length === 0,
    `unread=${ownerInbox.data?.unread ?? 0}`,
  );

  await call('/api/auth/login', { method: 'POST', body: { email: memberEmail, password: PASSWORD } });
  const memberInbox = await call('/api/inbox');
  const inboxRow = (memberInbox.data?.messages ?? []).find((item) => item.noteId === mentionedNote?.id);
  const firstTitle = (notesDetail.data?.rows ?? []).find((row) => row.id === firstId)?.values?.[titleProperty.id];
  check(
    'the mentioned member gets an inbox message',
    memberInbox.status === 200 && memberInbox.data?.unread === 1 && Boolean(inboxRow),
    `unread=${memberInbox.data?.unread ?? 0} messages=${memberInbox.data?.messages?.length ?? 0}`,
  );
  check(
    'the inbox message points back at the record',
    inboxRow?.databaseId === databaseId &&
      inboxRow?.recordId === firstId &&
      inboxRow?.authorName === 'Smoke Tester' &&
      inboxRow?.recordTitle === firstTitle &&
      Boolean(inboxRow?.databaseName),
    `title=${textOf(inboxRow?.recordTitle ?? '')}`,
  );

  // 私信说的「有人 @ 了你」必须能在这条记录的同步结果里看到（这就是卡片点开时的内容）
  const memberSynced = await call(`/api/records/${firstId}`);
  check(
    'the mentioned member syncs the fresh note with the record',
    memberSynced.status === 200 &&
      (memberSynced.data?.notes ?? []).some((note) => note.id === mentionedNote?.id),
    `status=${memberSynced.status} notes=${memberSynced.data?.notes?.length ?? 0}`,
  );

  const anonInbox = await call('/api/inbox', { cookie: false });
  check('the inbox needs a session', anonInbox.status === 401, `status=${anonInbox.status}`);

  const consumed = await call(`/api/inbox/${inboxRow?.id}/read`, { method: 'POST' });
  check(
    'opening a message marks it read',
    consumed.status === 200 && consumed.data?.unread === 0,
    `unread=${consumed.data?.unread ?? ''}`,
  );
  const afterRead = await call('/api/inbox');
  check(
    'the inbox is empty once everything is read',
    afterRead.data?.unread === 0 && (afterRead.data?.messages ?? []).length === 0,
    `messages=${afterRead.data?.messages?.length ?? 0}`,
  );

  cookie = notesOwnerCookie;
  const notMine = await call(`/api/inbox/${inboxRow?.id}/read`, { method: 'POST' });
  check('another account cannot read my message', notMine.status === 404, `status=${notMine.status}`);

  const removedMember = await call(`/api/members/${member?.id}`, { method: 'DELETE' });
  check(
    'remove member',
    removedMember.data?.members?.length === 1 && (removedMember.data?.members ?? []).every((item) => item.role === 'owner'),
    `members=${removedMember.data?.members?.length ?? 0}`,
  );

  const revoked = await call(`/api/shares/${shareView.data.shares[0].id}`, { method: 'DELETE' });
  check('revoke share link', Array.isArray(revoked.data?.shares) && revoked.data.shares.length === 1);

  // ------------------------------------------------------------- view shares
  section('view shares');
  const viewShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: baseView.id, email: memberEmail, role: 'viewer' },
  });
  const viewShareRow = (viewShare.data?.viewShares ?? []).find((item) => item.email === memberEmail);
  check(
    'share a single view with a member',
    viewShare.status === 201 &&
      viewShareRow?.viewId === baseView.id &&
      viewShareRow?.viewName === baseView.name &&
      viewShareRow?.role === 'viewer',
    `status=${viewShare.status} viewShares=${viewShare.data?.viewShares?.length ?? 0} err=${viewShare.data?.error?.message ?? ''}`,
  );

  const unknownViewShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: baseView.id, email: `nobody+${Date.now()}@example.com`, role: 'viewer' },
  });
  check('view share needs a registered account', unknownViewShare.status === 404, `status=${unknownViewShare.status}`);

  const missingViewShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: 'view-not-found', email: memberEmail, role: 'viewer' },
  });
  check('view share needs an existing view', missingViewShare.status === 404, `status=${missingViewShare.status}`);

  const detailWithViewShare = await call(`/api/databases/${databaseId}`);
  check(
    'database detail exposes view shares',
    (detailWithViewShare.data?.viewShares ?? []).some((item) => item.id === viewShareRow?.id),
    `viewShares=${detailWithViewShare.data?.viewShares?.length ?? 0}`,
  );

  // 可 @ 名单覆盖「定向分享的访客」：所有者能 @ 到被分享者（哪怕对方不是表格成员）
  const mentionables = detailWithViewShare.data?.mentionables ?? [];
  check(
    'the @ candidate list covers view-share guests',
    mentionables.some((item) => item.userId === notesMemberId),
    `mentionables=${mentionables.length}`,
  );

  const ownerToGuest = await call(`/api/records/${firstId}/notes`, {
    method: 'POST',
    body: { body: '定向分享的视图也请看一下 @Smoke Collaborator', mentions: [notesMemberId] },
  });
  const ownerToGuestNote = (ownerToGuest.data?.notes ?? []).find((note) =>
    note.body.startsWith('定向分享的视图也请看一下'),
  );
  check(
    'the owner can @ a view-share guest',
    ownerToGuest.status === 201 &&
      (ownerToGuestNote?.mentions ?? []).some((item) => item.userId === notesMemberId),
    `status=${ownerToGuest.status} mentions=${ownerToGuestNote?.mentions?.length ?? 0}`,
  );

  const removeViewShare = await call(`/api/view-shares/${viewShareRow?.id}`, { method: 'DELETE' });
  check(
    'revoke view share',
    removeViewShare.status === 200 && (removeViewShare.data?.viewShares ?? []).every((item) => item.id !== viewShareRow?.id),
    `status=${removeViewShare.status} err=${removeViewShare.data?.error?.message ?? ''}`,
  );

  // a view-scoped guest only sees the shared view and cannot touch the structure
  const ownerCookie = cookie;
  const reShareView = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: baseView.id, email: memberEmail, role: 'viewer' },
  });
  check('re-share the view with the member', reShareView.status === 201, `status=${reShareView.status}`);

  const guestLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email: memberEmail, password: PASSWORD },
  });
  check('login as the shared member', guestLogin.status === 200, `status=${guestLogin.status}`);

  const scoped = await call(`/api/databases/${databaseId}`);
  check(
    'view scoped guest sees only the shared view',
    scoped.status === 200 &&
      scoped.data?.viewScoped === true &&
      (scoped.data?.views ?? []).length === 1 &&
      scoped.data.views[0].id === baseView.id &&
      Array.isArray(scoped.data?.rows),
    `status=${scoped.status} views=${scoped.data?.views?.length ?? 0} rows=${scoped.data?.rows?.length ?? 0}`,
  );

  // 列表接口也要标出「被分享」：前端据此把表格放进侧边栏的「分享表格」而不是「我的表格」
  const guestList = await call('/api/databases');
  const guestRow = (guestList.data?.databases ?? []).find((item) => item.id === databaseId);
  check(
    'view scoped guest list flags the table as shared',
    guestRow?.viewScoped === true && (guestRow?.sharedViewNames ?? []).includes(baseView.name),
    `viewScoped=${guestRow?.viewScoped} views=${JSON.stringify(guestRow?.sharedViewNames ?? [])}`,
  );

  const guestSession = await call('/api/session');
  const sessionRow = (guestSession.data?.databases ?? []).find((item) => item.id === databaseId);
  check('session list flags the shared table too', sessionRow?.viewScoped === true, `viewScoped=${sessionRow?.viewScoped}`);

  const scopedWrite = await call(`/api/databases/${databaseId}/records`, { method: 'POST', body: { values: {} } });
  check('view scoped viewer cannot write', scopedWrite.status === 403, `status=${scopedWrite.status}`);

  const scopedStructure = await call(`/api/databases/${databaseId}/properties`, {
    method: 'POST',
    body: { name: '越权字段', type: 'text' },
  });
  check('view scoped viewer cannot change the structure', scopedStructure.status === 403, `status=${scopedStructure.status}`);

  // 反向：被定向分享的访客也能 @ 所有者（备注 @ 不再是表格成员的专属能力）
  const guestVisibleRecordId = (scoped.data?.rows ?? [])[0]?.id ?? firstId;
  const guestToOwner = await call(`/api/records/${guestVisibleRecordId}/notes`, {
    method: 'POST',
    body: { body: '收到，这边也确认了 @Smoke Tester', mentions: [registered.data?.user?.id] },
  });
  const guestToOwnerNote = (guestToOwner.data?.notes ?? []).find((note) =>
    note.body.startsWith('收到，这边也确认了'),
  );
  check(
    'a view-share guest can @ the owner',
    guestToOwner.status === 201 &&
      (guestToOwnerNote?.mentions ?? []).some((item) => item.userId === registered.data?.user?.id),
    `status=${guestToOwner.status} mentions=${guestToOwnerNote?.mentions?.length ?? 0}`,
  );

  cookie = ownerCookie;
  const ownerFromGuest = await call('/api/inbox');
  check(
    'the owner gets an inbox message from the view-share guest',
    (ownerFromGuest.data?.messages ?? []).some((item) => item.noteId === guestToOwnerNote?.id),
    `messages=${ownerFromGuest.data?.messages?.length ?? 0}`,
  );

  // promote the same share to editor: the guest may then edit the shared view's rows
  cookie = ownerCookie;
  await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: baseView.id, email: memberEmail, role: 'editor' },
  });
  await call('/api/auth/login', { method: 'POST', body: { email: memberEmail, password: PASSWORD } });
  const guestRecord = await call(`/api/databases/${databaseId}/records`, {
    method: 'POST',
    body: { values: { [titleProperty.id]: '视图分享写入' } },
  });
  check('editor view share may write', guestRecord.status === 201, `status=${guestRecord.status}`);
  if (guestRecord.data?.record?.id) await call(`/api/records/${guestRecord.data.record.id}`, { method: 'DELETE' });
  cookie = ownerCookie;
  const ownerList = await call('/api/databases');
  const ownerRow = (ownerList.data?.databases ?? []).find((item) => item.id === databaseId);
  check('own table is not flagged as shared', ownerRow?.viewScoped === false, `viewScoped=${ownerRow?.viewScoped}`);
  const cleanupViewShare = await call(`/api/view-shares/${(reShareView.data?.viewShares ?? [])[0]?.id}`, { method: 'DELETE' });
  check('cleanup the view share', cleanupViewShare.status === 200, `status=${cleanupViewShare.status}`);

  // ------------------------------------------------- 人员类筛选（当前用户）
  section('people filters (当前用户)');
  const peopleField = await call(`/api/databases/${databaseId}/properties`, {
    method: 'POST',
    body: { name: '创建人', type: 'created_by' },
  });
  const createdByProperty = (peopleField.data?.properties ?? []).find((property) => property.type === 'created_by');
  check(
    'add a 创建人 field',
    peopleField.status === 201 && Boolean(createdByProperty),
    `status=${peopleField.status}`,
  );

  const ownerId = registered.data?.user?.id;
  const memberId = collaborator.data?.user?.id;

  const meView = await call(`/api/databases/${databaseId}/views`, {
    method: 'POST',
    body: {
      name: '我创建的',
      type: 'table',
      config: {
        filters: {
          conjunction: 'and',
          conditions: [{ propertyId: createdByProperty?.id, operator: 'is', value: '@me' }],
        },
      },
    },
  });
  const meViewId = meView.data?.viewId;
  const meCondition = ((meView.data?.views ?? []).find((view) => view.id === meViewId)?.config?.filters?.conditions ?? [])[0];
  check(
    'view keeps the 「当前用户」condition',
    meView.status === 201 && meCondition?.value === '@me' && meCondition?.operator === 'is',
    `status=${meView.status} value=${meCondition?.value}`,
  );

  const meShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: meViewId, email: memberEmail, role: 'viewer' },
  });
  check('share the 「当前用户」view with the member', meShare.status === 201, `status=${meShare.status}`);

  await call('/api/auth/login', { method: 'POST', body: { email: memberEmail, password: PASSWORD } });
  const guestMeView = await call(`/api/databases/${databaseId}`);
  check(
    '@me resolves to the visitor, not the table owner',
    guestMeView.status === 200 && (guestMeView.data?.rows ?? []).length === 0,
    `status=${guestMeView.status} rows=${guestMeView.data?.rows?.length ?? 0}`,
  );

  // promote the same share so the guest may add a row of their own
  // 「限制编辑」在分享时勾选：勾上之后被分享者每个格子只有一次输入机会
  cookie = ownerCookie;
  const meEditorShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: meViewId, email: memberEmail, role: 'editor', limitEdits: true },
  });
  const meEditorRow = (meEditorShare.data?.viewShares ?? []).find((item) => item.email === memberEmail);
  check(
    'promote the 「当前用户」view share to editor（限制编辑）',
    meEditorShare.status === 201 && meEditorRow?.role === 'editor' && meEditorRow?.limitEdits === true,
    `status=${meEditorShare.status} limitEdits=${meEditorRow?.limitEdits}`,
  );

  await call('/api/auth/login', { method: 'POST', body: { email: memberEmail, password: PASSWORD } });
  const mine = await call(`/api/databases/${databaseId}/records`, {
    method: 'POST',
    body: { values: { [titleProperty.id]: '@me 自建记录' } },
  });
  const mineId = mine.data?.record?.id;
  check('guest writes through the shared view', mine.status === 201 && Boolean(mineId), `status=${mine.status}`);

  const guestMine = await call(`/api/databases/${databaseId}`);
  const mineRow = (guestMine.data?.rows ?? []).find((row) => row.id === mineId);
  check(
    '「当前用户」view shows exactly the visitor own row',
    (guestMine.data?.rows ?? []).length === 1 && mineRow?.createdBy === memberId,
    `rows=${guestMine.data?.rows?.length ?? 0} createdBy=${mineRow?.createdBy ?? ''} member=${memberId ?? ''}`,
  );

  // 共享出来的 editor（视图定向分享）勾了「限制编辑」时每格只有一次修改机会，
  // 但第一次保存成功后的 10 秒内还能改回来（纠错窗口）
  const guestCellEdit = await call(`/api/records/${mineId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '@me 自建记录（改）' } },
  });
  check(
    'a shared editor may edit a cell once',
    guestCellEdit.status === 200,
    `status=${guestCellEdit.status} err=${guestCellEdit.data?.error?.message ?? ''}`,
  );

  const guestCellEditAgain = await call(`/api/records/${mineId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '@me 自建记录（窗口内改回来）' } },
  });
  check(
    'a shared editor may still correct the cell inside the grace window',
    guestCellEditAgain.status === 200 &&
      guestCellEditAgain.data?.record?.values?.[titleProperty.id] === '@me 自建记录（窗口内改回来）' &&
      Number(guestCellEditAgain.data?.cellEditGrace?.[`${mineId}:${titleProperty.id}`]) > Date.now(),
    `status=${guestCellEditAgain.status} err=${guestCellEditAgain.data?.error?.message ?? ''}`,
  );

  // 窗口一过这一格彻底只读：再改被拒，列表里也列进 lockedCells
  await waitForGraceWindow();
  const guestCellEditExpired = await call(`/api/records/${mineId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '@me 自建记录（窗口已过）' } },
  });
  check(
    'a shared editor cannot edit the same cell twice after the window closed',
    guestCellEditExpired.status === 403,
    `status=${guestCellEditExpired.status} err=${guestCellEditExpired.data?.error?.message ?? ''}`,
  );

  const guestRows = await call(`/api/databases/${databaseId}/rows?limit=50`);
  const guestGraceKeys = Object.keys(guestRows.data?.cellEditGrace ?? {});
  check(
    'the guest rows payload marks the spent cell',
    (guestRows.data?.lockedCells ?? []).includes(`${mineId}:${titleProperty.id}`) &&
      !guestGraceKeys.includes(`${mineId}:${titleProperty.id}`),
    `lockedCells=${textOf(guestRows.data?.lockedCells)} cellEditGrace=${textOf(guestGraceKeys)}`,
  );

  check(
    'the guest detail reports the 限制编辑 flag',
    guestMine.data?.limitCellEdits === true,
    `limitCellEdits=${guestMine.data?.limitCellEdits}`,
  );

  // 同一个视图 + 同一个账号重新分享，这次不勾「限制编辑」：限制立刻取消
  cookie = ownerCookie;
  const relaxedShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: meViewId, email: memberEmail, role: 'editor' },
  });
  const relaxedRow = (relaxedShare.data?.viewShares ?? []).find((item) => item.email === memberEmail);
  check(
    'turn 限制编辑 off for the same view share',
    relaxedShare.status === 201 && relaxedRow?.role === 'editor' && relaxedRow?.limitEdits === false,
    `status=${relaxedShare.status} limitEdits=${relaxedRow?.limitEdits}`,
  );

  await call('/api/auth/login', { method: 'POST', body: { email: memberEmail, password: PASSWORD } });
  const relaxedDetail = await call(`/api/databases/${databaseId}`);
  check(
    'the guest is no longer restricted',
    relaxedDetail.data?.limitCellEdits === false && (relaxedDetail.data?.lockedCells ?? []).length === 0,
    `limitCellEdits=${relaxedDetail.data?.limitCellEdits} lockedCells=${textOf(relaxedDetail.data?.lockedCells)}`,
  );

  const guestCellEditThird = await call(`/api/records/${mineId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '@me 自建记录（不限制编辑后）' } },
  });
  check(
    'without 限制编辑 the guest may edit the same cell again',
    guestCellEditThird.status === 200,
    `status=${guestCellEditThird.status} err=${guestCellEditThird.data?.error?.message ?? ''}`,
  );

  // 「不是当前用户」= 别人创建的记录（表格所有者创建的那条依然在）
  cookie = ownerCookie;
  const othersView = await call(`/api/databases/${databaseId}/views`, {
    method: 'POST',
    body: {
      name: '别人创建的',
      type: 'table',
      config: {
        filters: {
          conjunction: 'and',
          conditions: [{ propertyId: createdByProperty?.id, operator: 'is_not', value: '@me' }],
        },
      },
    },
  });
  const othersShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: othersView.data?.viewId, email: memberEmail, role: 'viewer' },
  });
  check('share the 「不是当前用户」view', othersShare.status === 201, `status=${othersShare.status}`);

  await call('/api/auth/login', { method: 'POST', body: { email: memberEmail, password: PASSWORD } });
  const guestOthers = await call(`/api/databases/${databaseId}`);
  const othersRows = guestOthers.data?.rows ?? [];
  check(
    '「不是当前用户」keeps the rows created by others',
    othersRows.length >= 2 && othersRows.some((row) => row.id === firstId && row.createdBy === ownerId),
    `rows=${othersRows.length} ownerRows=${othersRows.filter((row) => row.createdBy === ownerId).length}`,
  );

  check(
    'shared user resolves names for rows created by others',
    guestOthers.data?.people?.[ownerId] === 'Smoke Tester',
    `name=${guestOthers.data?.people?.[ownerId] ?? ''}`,
  );

  cookie = ownerCookie;
  const peopleShares = othersShare.data?.viewShares ?? [];
  let revokedPeopleShares = 0;
  for (const item of peopleShares) {
    const removed = await call(`/api/view-shares/${item.id}`, { method: 'DELETE' });
    if (removed.status === 200) revokedPeopleShares += 1;
  }
  check(
    'revoke the people filter view shares',
    peopleShares.length > 0 && revokedPeopleShares === peopleShares.length,
    `${revokedPeopleShares}/${peopleShares.length} view share(s)`,
  );

  // ----------------------------------- 创建人姓名解析（被分享但非成员的访问者）
  section('creator names (创建人)');
  const ownerDetail = await call(`/api/databases/${databaseId}`);
  const sharedRow = (ownerDetail.data?.rows ?? []).find((row) => row.id === mineId);
  check(
    'the shared user is not a table member',
    (ownerDetail.data?.members ?? []).every((item) => item.userId !== memberId),
    `members=${ownerDetail.data?.members?.length ?? 0}`,
  );
  check(
    'owner resolves the name of a row a shared user created',
    sharedRow?.createdBy === memberId && ownerDetail.data?.people?.[memberId] === 'Smoke Collaborator',
    `createdBy=${sharedRow?.createdBy ?? ''} name=${ownerDetail.data?.people?.[memberId] ?? ''}`,
  );
  check(
    'owner rows resolve the owner name',
    ownerDetail.data?.people?.[ownerId] === 'Smoke Tester',
    `name=${ownerDetail.data?.people?.[ownerId] ?? ''}`,
  );

  const sharesBefore = new Set(
    ((await call(`/api/databases/${databaseId}/shares`)).data?.shares ?? []).map((item) => item.id),
  );
  const namesShare = await call(`/api/databases/${databaseId}/shares`, {
    method: 'POST',
    body: { permission: 'view' },
  });
  const namesToken = (namesShare.data?.shares ?? []).find((item) => !sharesBefore.has(item.id))?.token;
  const publicNames = await call(`/api/public/${namesToken}`, { cookie: false });
  check(
    'public payload resolves creator names',
    Boolean(namesToken) &&
      publicNames.data?.people?.[memberId] === 'Smoke Collaborator' &&
      publicNames.data?.people?.[ownerId] === 'Smoke Tester',
    `owner=${publicNames.data?.people?.[ownerId] ?? ''} guest=${publicNames.data?.people?.[memberId] ?? ''}`,
  );

  // ------------------------------------------------------- live sync（多人协作）
  section('live sync (增量同步)');
  // 打开表格时下发的 `rev` 就是客户端一开始的游标
  const detailWithRev = await call(`/api/databases/${databaseId}`);
  check(
    'table detail carries the version cursor',
    typeof detailWithRev.data?.rev === 'number',
    `rev=${detailWithRev.data?.rev}`,
  );

  // 第一次请求（游标 0）要能拿到一个可用的版本号：客户端就是拿它当起点的
  const syncStart = await call(`/api/databases/${databaseId}/changes?since=0`);
  check(
    'changes starts with a version cursor',
    syncStart.status === 200 &&
      typeof syncStart.data?.rev === 'number' &&
      Array.isArray(syncStart.data?.rows) &&
      Array.isArray(syncStart.data?.deleted),
    `rev=${syncStart.data?.rev}`,
  );

  let syncCursor = syncStart.data?.rev ?? 0;
  const liveRow = await call(`/api/databases/${databaseId}/records`, {
    method: 'POST',
    body: { values: { [titleProperty.id]: '实时同步测试' } },
  });
  const liveRowId = liveRow.data?.record?.id;
  check('create row for live sync', liveRow.status === 201 && Boolean(liveRowId));

  const createdDelta = await call(`/api/databases/${databaseId}/changes?since=${syncCursor}`);
  check(
    'new row lands in the delta',
    createdDelta.data?.reset === false &&
      (createdDelta.data?.rows ?? []).some((row) => row.id === liveRowId) &&
      createdDelta.data?.rev > syncCursor,
    `rev=${createdDelta.data?.rev}`,
  );

  syncCursor = createdDelta.data?.rev ?? syncCursor;
  await call(`/api/records/${liveRowId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '实时同步测试（改）' } },
  });
  const patchedDelta = await call(`/api/databases/${databaseId}/changes?since=${syncCursor}`);
  const patchedRow = (patchedDelta.data?.rows ?? []).find((row) => row.id === liveRowId);
  check(
    'updated cell lands in the delta',
    patchedDelta.data?.reset === false && patchedRow?.values?.[titleProperty.id] === '实时同步测试（改）',
    `${patchedRow?.values?.[titleProperty.id] ?? '(none)'}`,
  );

  syncCursor = patchedDelta.data?.rev ?? syncCursor;
  await call(`/api/records/${liveRowId}/notes`, { method: 'POST', body: { body: '实时同步备注' } });
  const noteDelta = await call(`/api/databases/${databaseId}/changes?since=${syncCursor}`);
  check(
    'new note lands in the delta',
    noteDelta.data?.reset === false && (noteDelta.data?.notes ?? []).some((note) => note.recordId === liveRowId),
  );

  syncCursor = noteDelta.data?.rev ?? syncCursor;
  const idleDelta = await call(`/api/databases/${databaseId}/changes?since=${syncCursor}`);
  check(
    'idle delta stays empty',
    idleDelta.data?.reset === false &&
      (idleDelta.data?.rows ?? []).length === 0 &&
      (idleDelta.data?.deleted ?? []).length === 0 &&
      idleDelta.data?.rev >= syncCursor,
    `rev=${idleDelta.data?.rev}`,
  );

  syncCursor = idleDelta.data?.rev ?? syncCursor;
  await call(`/api/records/${liveRowId}`, { method: 'DELETE' });
  const deletedDelta = await call(`/api/databases/${databaseId}/changes?since=${syncCursor}`);
  check(
    'deleted row lands in the delta',
    deletedDelta.data?.reset === false &&
      (deletedDelta.data?.deleted ?? []).includes(liveRowId) &&
      !(deletedDelta.data?.rows ?? []).some((row) => row.id === liveRowId),
  );

  // 结构改动（字段改名 / 视图配置）会让客户端整表重载：reset=true
  syncCursor = deletedDelta.data?.rev ?? syncCursor;
  await call(`/api/properties/${titleProperty.id}`, {
    method: 'PATCH',
    body: { name: `${titleProperty.name} ✓` },
  });
  const schemaDelta = await call(`/api/databases/${databaseId}/changes?since=${syncCursor}`);
  check('structural change asks for a reload', schemaDelta.data?.reset === true, `reset=${schemaDelta.data?.reset}`);

  // 客户端收到 reset 后会整表重载一次，并以新详情里的 rev 作为新游标：
  // 之后应该又能正常拿到增量（字段名改回去也是一次结构改动，所以先改回再取游标）
  await call(`/api/properties/${titleProperty.id}`, { method: 'PATCH', body: { name: titleProperty.name } });
  const reloadedDetail = await call(`/api/databases/${databaseId}`);
  const healthyDelta = await call(`/api/databases/${databaseId}/changes?since=${reloadedDetail.data?.rev ?? 0}`);
  check(
    'delta is healthy again after the reload',
    typeof reloadedDetail.data?.rev === 'number' && healthyDelta.data?.reset === false,
    `reset=${healthyDelta.data?.reset}`,
  );

  // 公开链接一侧也在轮询同一个增量接口（表格里的改动会出现在公开页上）
  const publicSync = await call(`/api/public/${editToken}/changes?since=0`, { cookie: false });
  check(
    'public changes endpoint',
    publicSync.status === 200 && typeof publicSync.data?.rev === 'number',
    `rev=${publicSync.data?.rev}`,
  );

  const publicLive = await call(`/api/databases/${databaseId}/records`, {
    method: 'POST',
    body: { values: { [titleProperty.id]: '公开页也能看到' } },
  });
  const publicLiveId = publicLive.data?.record?.id;
  const publicDelta = await call(`/api/public/${editToken}/changes?since=${publicSync.data?.rev ?? 0}`, {
    cookie: false,
  });
  check(
    'table edit reaches the public page',
    (publicDelta.data?.rows ?? []).some((row) => row.id === publicLiveId),
    `${(publicDelta.data?.rows ?? []).length} row(s)`,
  );
  if (publicLiveId) await call(`/api/records/${publicLiveId}`, { method: 'DELETE' });

  const syncAnon = await call(`/api/databases/${databaseId}/changes`, { cookie: false });
  check('changes requires a session', syncAnon.status === 401, `status=${syncAnon.status}`);
  const syncGone = await call('/api/databases/database-does-not-exist/changes');
  check('changes 404 for an unknown table', syncGone.status === 404, `status=${syncGone.status}`);
  const syncBadToken = await call('/api/public/not-a-real-token/changes', { cookie: false });
  check('public changes 404 for a bad token', syncBadToken.status === 404, `status=${syncBadToken.status}`);


  // -------------------------------------------------------------------- files
  section('files');
  const form = new FormData();
  form.set('file', new Blob(['cloudnotion smoke test'], { type: 'text/plain' }), 'smoke.txt');
  form.set('databaseId', databaseId);
  const uploaded = await call('/api/files', { method: 'POST', form });
  const fileId = uploaded.data?.file?.id;
  check('upload file to R2', uploaded.status === 201 && Boolean(fileId), `status=${uploaded.status}`);

  if (fileId) {
    const download = await fetch(`${BASE}/api/files/${fileId}`, { headers: { cookie } });
    const text = await download.text();
    check('download file', download.ok && text === 'cloudnotion smoke test', `status=${download.status}`);
  }

  // ------------------------------------------------------------------ cleanup
  section('cleanup');
  const deletedDatabase = await call(`/api/databases/${databaseId}`, { method: 'DELETE' });
  check('delete table', deletedDatabase.data?.ok === true);

  const finalSession = await call('/api/session');
  check(
    'table list no longer contains it',
    (finalSession.data?.databases ?? []).every((item) => item.id !== databaseId),
    `${finalSession.data?.databases?.length ?? 0} table(s) left`,
  );

  const loggedOut = await call('/api/auth/logout', { method: 'POST' });
  check('logout', loggedOut.data?.ok === true);
  const afterLogout = await call('/api/session');
  check('session cleared', afterLogout.data?.user === null);

  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${'-'.repeat(52)}`);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.error('failing checks:');
    for (const item of failed) console.error(`  - ${item.name}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error('\nsmoke test crashed:', error);
  process.exitCode = 1;
});


