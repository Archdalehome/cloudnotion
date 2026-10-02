/**
 * Thin typed wrapper around the CloudNotion JSON API.
 * Session handling relies on the HttpOnly cookie, hence `credentials: 'same-origin'`.
 */
import type {
  AdminPasswordResetResponse,
  AdminUserListResponse,
  CellEditLocks,
  DatabaseChanges,
  DatabaseDetail,
  DatabaseSummary,
  FieldType,
  InboxResponse,
  Property,
  PropertyConfig,
  PublicDatabaseResponse,
  RecordNote,
  RegistrationPending,
  RowRecord,
  RowValues,
  SessionUser,
  ViewConfig,
  ViewDef,
  ViewType,
} from '../shared/types';

export interface SessionPayload {
  user: SessionUser | null;
  databases: DatabaseSummary[];
  maxUploadMb: number;
  appName: string;
}

export interface RecordsPage extends CellEditLocks {
  rows: RowRecord[];
  total: number;
  hasMore: boolean;
  /** 这一页记录上的备注（备注只增不改，可以直接合并进本地列表） */
  notes: RecordNote[];
}

/** 单条记录的最新状态：记录卡片打开 / 定时同步用（比整表分页轻） */
export interface RecordSync extends CellEditLocks {
  record: RowRecord;
  /** 这条记录上的备注，按 `createdAt` 升序 */
  notes: RecordNote[];
}

export interface UploadResult {
  file: { id: string; name: string; size: number; mime: string };
  url: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    signal: options.signal,
  };
  if (options.form) {
    init.body = options.form;
  } else if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { 'content-type': 'application/json' };
  }

  const response = await fetch(path, init);
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const envelope = payload as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      response.status,
      envelope?.error?.code ?? 'request_failed',
      envelope?.error?.message ?? `请求失败（${response.status}）`,
    );
  }
  return payload as T;
}

const json = <T,>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> =>
  request<T>(path, { method, body, signal });

export const api = {
  session: (signal?: AbortSignal) => json<SessionPayload>('/api/session', 'GET', undefined, signal),
  /** 注册第一步：只登记待确认的注册并发确认码，账号要等 `verifyRegistration` 之后才存在 */
  register: (body: { email: string; password: string; name: string }) =>
    json<RegistrationPending>('/api/auth/register', 'POST', body),
  /** 注册第二步：填确认码，成功即返回已登录用户 */
  verifyRegistration: (body: { email: string; code: string }) =>
    json<{ user: SessionUser; emailVerified: true }>('/api/auth/register/verify', 'POST', body),
  /** 重新发送注册确认码（同一邮箱 60 秒一次） */
  resendRegistrationCode: (body: { email: string }) =>
    json<RegistrationPending>('/api/auth/register/resend', 'POST', body),
  login: (body: { email: string; password: string }) => json<{ user: SessionUser }>('/api/auth/login', 'POST', body),
  logout: () => json<{ ok: true }>('/api/auth/logout', 'POST'),
  /** 登录后自助改密码（其它设备的会话会立即失效） */
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    json<{ ok: true; sessionsRevoked: boolean }>('/api/auth/password', 'POST', body),

  /* -------------------------------------------------------------- 管理后台 */
  adminListUsers: (params?: { search?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.search) query.set('search', params.search);
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.offset !== undefined) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query}` : '';
    return json<AdminUserListResponse>(`/api/admin/users${suffix}`, 'GET');
  },
  adminUpdateUser: (id: string, body: { name?: string; email?: string }) =>
    json<{ user: AdminUserListResponse['users'][number]; updatedSelf: boolean }>(
      `/api/admin/users/${encodeURIComponent(id)}`,
      'PATCH',
      body,
    ),
  adminResetUserPassword: (id: string, body: { password?: string } = {}) =>
    json<AdminPasswordResetResponse>(`/api/admin/users/${encodeURIComponent(id)}/password`, 'POST', body),

  listDatabases: () => json<{ databases: DatabaseSummary[] }>('/api/databases', 'GET'),
  createDatabase: (body: { name: string; icon?: string; description?: string; templateId?: string }) =>
    json<DatabaseDetail>('/api/databases', 'POST', body),
  getDatabase: (id: string, params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.offset !== undefined) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query}` : '';
    return json<DatabaseDetail>(`/api/databases/${id}${suffix}`, 'GET');
  },
  updateDatabase: (id: string, body: { name?: string; icon?: string; description?: string }) =>
    json<DatabaseDetail>(`/api/databases/${id}`, 'PATCH', body),
  deleteDatabase: (id: string) => json<{ ok: true }>(`/api/databases/${id}`, 'DELETE'),
  rows: (id: string, params: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    return json<RecordsPage>(`/api/databases/${id}/records?${query}`, 'GET');
  },

  /**
   * 增量同步：只取「比 `since` 新的改动」（改过的行 / 删掉的行 / 新备注 / 已用掉的格子）。
   * 表格页开着的时候每隔几秒轮询一次，别人改的单元格不用刷新页面就会出现。
   */
  changes: (id: string, since: number) =>
    json<DatabaseChanges>(`/api/databases/${id}/changes?since=${Math.max(0, Math.floor(since))}`, 'GET'),

  createProperty: (
    databaseId: string,
    body: { name: string; type: FieldType; config?: PropertyConfig; width?: number; position?: number; locked?: boolean },
  ) => json<{ properties: Property[]; propertyId: string }>(`/api/databases/${databaseId}/properties`, 'POST', body),
  updateProperty: (
    id: string,
    body: {
      name?: string;
      type?: FieldType;
      config?: PropertyConfig;
      width?: number;
      position?: number;
      locked?: boolean;
    },
  ) => json<{ property: Property; properties: Property[]; migrated: number }>(`/api/properties/${id}`, 'PATCH', body),
  deleteProperty: (id: string) => json<{ properties: Property[] }>(`/api/properties/${id}`, 'DELETE'),

  createRecord: (databaseId: string, body: { values?: RowValues; afterId?: string | null }) =>
    json<{ record: RowRecord | null; total: number }>(`/api/databases/${databaseId}/records`, 'POST', body),
  bulkCreateRecords: (databaseId: string, body: { records: RowValues[]; afterId?: string | null }) =>
    json<{ records: RowRecord[]; total: number }>(`/api/databases/${databaseId}/records/bulk`, 'POST', body),
  duplicateRecords: (databaseId: string, recordIds: string[]) =>
    json<{ records: RowRecord[]; total: number }>(`/api/databases/${databaseId}/records/duplicate`, 'POST', {
      recordIds,
    }),
  deleteRecords: (databaseId: string, recordIds: string[]) =>
    json<{ deleted: number; total: number }>(`/api/databases/${databaseId}/records/delete`, 'POST', { recordIds }),
  /**
   * 保存一个单元格 / 一整行。受限访问者（勾了「限制编辑」的分享）的响应里还会带上
   * 这一行的锁定状态：`cellEditGrace` 给出本次改动的格子 10 秒计时窗口的截止时刻，
   * 客户端据此显示「还能再改几秒」。
   */
  updateRecord: (id: string, body: { values?: RowValues; position?: number }) =>
    json<{ record: RowRecord | null; total: number } & CellEditLocks>(`/api/records/${id}`, 'PATCH', body),
  deleteRecord: (id: string) => json<{ ok: true; total: number }>(`/api/records/${id}`, 'DELETE'),

  /**
   * 单条记录的最新状态（值 + 备注 + 已用掉的格子）。
   * 记录卡片打开时用它刷新：别人刚加的备注 / 刚改的值会立刻出现在卡片上。
   */
  syncRecord: (recordId: string) => json<RecordSync>(`/api/records/${recordId}`, 'GET'),

  /** 添加备注（备注只能新增，不能修改 / 删除） */
  addNote: (recordId: string, body: { body: string; mentions?: string[] }) =>
    json<{ notes: RecordNote[] }>(`/api/records/${recordId}/notes`, 'POST', body),

  /** 收件箱：别人在备注里 @ 我留下的私信（未读） */
  inbox: (signal?: AbortSignal) => json<InboxResponse>('/api/inbox', 'GET', undefined, signal),
  /** 点开一条私信 → 已读（未读数 -1） */
  readInboxMessage: (mentionId: string) =>
    json<{ unread: number }>(`/api/inbox/${encodeURIComponent(mentionId)}/read`, 'POST'),

  createView: (
    databaseId: string,
    body: { name?: string; type: ViewType; config?: ViewConfig; copyOfViewId?: string; locked?: boolean },
  ) => json<{ views: ViewDef[]; viewId: string }>(`/api/databases/${databaseId}/views`, 'POST', body),
  updateView: (id: string, body: { name?: string; type?: ViewType; config?: ViewConfig; locked?: boolean; position?: number }) =>
    json<{ views: ViewDef[] }>(`/api/views/${id}`, 'PATCH', body),
  deleteView: (id: string) => json<{ views: ViewDef[] }>(`/api/views/${id}`, 'DELETE'),

  createViewShare: (
    databaseId: string,
    body: { viewId: string; email: string; role: 'editor' | 'viewer'; limitEdits?: boolean },
  ) =>
    json<{ viewShares: DatabaseDetail['viewShares'] }>(`/api/databases/${databaseId}/view-shares`, 'POST', body),
  deleteViewShare: (id: string) =>
    json<{ viewShares: DatabaseDetail['viewShares'] }>(`/api/view-shares/${id}`, 'DELETE'),

  addMember: (databaseId: string, body: { email: string; role: 'editor' | 'viewer' }) =>
    json<{ members: DatabaseDetail['members'] }>(`/api/databases/${databaseId}/members`, 'POST', body),
  updateMember: (id: string, role: 'editor' | 'viewer') =>
    json<{ members: DatabaseDetail['members'] }>(`/api/members/${id}`, 'PATCH', { role }),
  removeMember: (id: string) => json<{ members: DatabaseDetail['members'] }>(`/api/members/${id}`, 'DELETE'),

  createShare: (databaseId: string, body: { permission: 'view' | 'edit'; expiresInDays?: number; limitEdits?: boolean }) =>
    json<{ shares: DatabaseDetail['shares'] }>(`/api/databases/${databaseId}/shares`, 'POST', body),
  deleteShare: (id: string) => json<{ shares: DatabaseDetail['shares'] }>(`/api/shares/${id}`, 'DELETE'),

  uploadFile: (
    file: File,
    target: { databaseId?: string; recordId?: string; propertyId?: string; token?: string },
  ) => {
    const form = new FormData();
    form.set('file', file);
    for (const [key, value] of Object.entries(target)) {
      if (value) form.set(key, value);
    }
    return request<UploadResult>('/api/files', { method: 'POST', form });
  },
  fileUrl: (id: string, download = false) => `/api/files/${id}${download ? '?download=1' : ''}`,
};

export const publicApi = {
  database: (token: string, params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.offset !== undefined) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query}` : '';
    return json<PublicDatabaseResponse>(`/api/public/${encodeURIComponent(token)}${suffix}`, 'GET');
  },
  /** 公开链接页的增量同步（同一套增量逻辑，只是访问权来自分享 token） */
  changes: (token: string, since: number) =>
    json<DatabaseChanges>(
      `/api/public/${encodeURIComponent(token)}/changes?since=${Math.max(0, Math.floor(since))}`,
      'GET',
    ),
  createRecord: (token: string, values: RowValues) =>
    json<{ record: RowRecord | null }>(`/api/public/${encodeURIComponent(token)}/records`, 'POST', { values }),
  /** 公开链接页保存单元格：响应里的 `cellEditGrace` 给出 10 秒计时窗口的截止时刻 */
  updateRecord: (token: string, recordId: string, values: RowValues) =>
    json<{ record: RowRecord | null } & CellEditLocks>(
      `/api/public/${encodeURIComponent(token)}/records/${recordId}`,
      'PATCH',
      { values },
    ),
  deleteRecord: (token: string, recordId: string) =>
    json<{ ok: true }>(`/api/public/${encodeURIComponent(token)}/records/${recordId}`, 'DELETE'),
};
