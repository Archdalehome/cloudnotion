/**
 * Thin typed wrapper around the CloudNotion JSON API.
 * Session handling relies on the HttpOnly cookie, hence `credentials: 'same-origin'`.
 */
import type {
  DatabaseDetail,
  DatabaseSummary,
  FieldType,
  Property,
  PropertyConfig,
  PublicDatabaseResponse,
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

export interface RecordsPage {
  rows: RowRecord[];
  total: number;
  hasMore: boolean;
  /** 当前访问者已经改过一次的格子（`记录 id:字段 id`）；所有者恒为空 */
  lockedCells: string[];
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
  register: (body: { email: string; password: string; name: string }) =>
    json<{ user: SessionUser }>('/api/auth/register', 'POST', body),
  login: (body: { email: string; password: string }) => json<{ user: SessionUser }>('/api/auth/login', 'POST', body),
  logout: () => json<{ ok: true }>('/api/auth/logout', 'POST'),

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
  updateDatabase: (id: string, body: { name?: string; icon?: string; description?: string; locked?: boolean }) =>
    json<DatabaseDetail>(`/api/databases/${id}`, 'PATCH', body),
  deleteDatabase: (id: string) => json<{ ok: true }>(`/api/databases/${id}`, 'DELETE'),
  rows: (id: string, params: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    return json<RecordsPage>(`/api/databases/${id}/records?${query}`, 'GET');
  },

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
  updateRecord: (id: string, body: { values?: RowValues; position?: number }) =>
    json<{ record: RowRecord | null; total: number }>(`/api/records/${id}`, 'PATCH', body),
  deleteRecord: (id: string) => json<{ ok: true; total: number }>(`/api/records/${id}`, 'DELETE'),

  createView: (
    databaseId: string,
    body: { name?: string; type: ViewType; config?: ViewConfig; copyOfViewId?: string; locked?: boolean },
  ) => json<{ views: ViewDef[]; viewId: string }>(`/api/databases/${databaseId}/views`, 'POST', body),
  updateView: (id: string, body: { name?: string; type?: ViewType; config?: ViewConfig; locked?: boolean; position?: number }) =>
    json<{ views: ViewDef[] }>(`/api/views/${id}`, 'PATCH', body),
  deleteView: (id: string) => json<{ views: ViewDef[] }>(`/api/views/${id}`, 'DELETE'),

  createViewShare: (databaseId: string, body: { viewId: string; email: string; role: 'editor' | 'viewer' }) =>
    json<{ viewShares: DatabaseDetail['viewShares'] }>(`/api/databases/${databaseId}/view-shares`, 'POST', body),
  deleteViewShare: (id: string) =>
    json<{ viewShares: DatabaseDetail['viewShares'] }>(`/api/view-shares/${id}`, 'DELETE'),

  addMember: (databaseId: string, body: { email: string; role: 'editor' | 'viewer' }) =>
    json<{ members: DatabaseDetail['members'] }>(`/api/databases/${databaseId}/members`, 'POST', body),
  updateMember: (id: string, role: 'editor' | 'viewer') =>
    json<{ members: DatabaseDetail['members'] }>(`/api/members/${id}`, 'PATCH', { role }),
  removeMember: (id: string) => json<{ members: DatabaseDetail['members'] }>(`/api/members/${id}`, 'DELETE'),

  createShare: (databaseId: string, body: { permission: 'view' | 'edit'; expiresInDays?: number }) =>
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
  createRecord: (token: string, values: RowValues) =>
    json<{ record: RowRecord | null }>(`/api/public/${encodeURIComponent(token)}/records`, 'POST', { values }),
  updateRecord: (token: string, recordId: string, values: RowValues) =>
    json<{ record: RowRecord | null }>(`/api/public/${encodeURIComponent(token)}/records/${recordId}`, 'PATCH', {
      values,
    }),
  deleteRecord: (token: string, recordId: string) =>
    json<{ ok: true }>(`/api/public/${encodeURIComponent(token)}/records/${recordId}`, 'DELETE'),
};
