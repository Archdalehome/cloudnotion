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
 * views -> share links -> public read + edit -> members -> file upload ->
 * cleanup. Exit code is 1 when any check fails.
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

  const titleProperty = (created.data.properties ?? []).find((property) => property.type === 'text');
  const statusProperty = (created.data.properties ?? []).find((property) => property.type === 'select');
  const checkProperty = (created.data.properties ?? []).find((property) => property.type === 'checkbox');

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

  // -------------------------------------------------------------------- views
  section('views');
  const baseView = (created.data.views ?? [])[0];
  const newView = await call(`/api/databases/${databaseId}/views`, {
    method: 'POST',
    body: { name: '看板', type: 'board', config: { groupBy: statusProperty?.id } },
  });
  const boardViewId = newView.data?.viewId;
  check('create board view', newView.status === 201 && Boolean(boardViewId), `status=${newView.status}`);

  const patchedView = await call(`/api/views/${baseView.id}`, {
    method: 'PATCH',
    body: { config: { filters: { conjunction: 'and', conditions: [{ propertyId: titleProperty.id, operator: 'contains', value: '第一条' }] } } },
  });
  const savedConditions = patchedView.data?.views?.find((view) => view.id === baseView.id)?.config?.filters?.conditions ?? [];
  check('save view filters', savedConditions.length === 1, JSON.stringify(savedConditions[0] ?? {}));

  const viewsBefore = (patchedView.data?.views ?? []).length;
  const removedView = await call(`/api/views/${boardViewId}`, { method: 'DELETE' });
  check(
    'delete view',
    Array.isArray(removedView.data?.views) &&
      removedView.data.views.length === viewsBefore - 1 &&
      removedView.data.views.every((view) => view.id !== boardViewId),
    `viewId=${boardViewId} views=${viewsBefore}->${removedView.data?.views?.length ?? 0} status=${removedView.status} err=${removedView.data?.error?.message ?? ''}`,
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
    body: { permission: 'edit' },
  });
  const editToken = (shareEdit.data?.shares ?? []).find((share) => share.permission === 'edit')?.token;
  check('create editable link', Boolean(editToken));

  const publicRead = await call(`/api/public/${viewToken}`, { cookie: false });
  check(
    'public read without a session',
    publicRead.data?.database?.permission === 'view' && (publicRead.data?.rows?.length ?? 0) >= 1,
    `rows=${publicRead.data?.rows?.length ?? 0}`,
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

  const removedMember = await call(`/api/members/${member?.id}`, { method: 'DELETE' });
  check(
    'remove member',
    removedMember.data?.members?.length === 1 && (removedMember.data?.members ?? []).every((item) => item.role === 'owner'),
    `members=${removedMember.data?.members?.length ?? 0}`,
  );

  const revoked = await call(`/api/shares/${shareView.data.shares[0].id}`, { method: 'DELETE' });
  check('revoke share link', Array.isArray(revoked.data?.shares) && revoked.data.shares.length === 1);

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


