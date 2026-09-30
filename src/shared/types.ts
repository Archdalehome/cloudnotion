/**
 * Shared data model types - used by both the Worker (API) and the client (SPA).
 */

/* ------------------------------------------------------------------ fields */

export type FieldType =
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'files'
  | 'created_time'
  | 'updated_time'
  | 'created_by'
  | 'updated_by';

export type OptionColor =
  | 'default'
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red';

export interface SelectOption {
  id: string;
  name: string;
  color: OptionColor;
}

export type NumberFormat = 'plain' | 'comma' | 'percent' | 'currency';
export type DateFormat = 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MMM D, YYYY' | 'YYYY年M月D日';

/** Per-type settings, persisted as JSON on the property record. */
export interface PropertyConfig {
  /** select / multi_select / status */
  options?: SelectOption[];
  /** number */
  format?: NumberFormat;
  currency?: string;
  precision?: number;
  /** date / created_time / updated_time */
  dateFormat?: DateFormat;
  includeTime?: boolean;
}

export interface Property {
  id: string;
  databaseId: string;
  name: string;
  type: FieldType;
  config: PropertyConfig;
  position: number;
  width: number;
  /** 字段锁定：锁定后该字段的所有记录只读（不能编辑 / 上传），内容照常显示 */
  locked: boolean;
  createdAt: number;
  updatedAt: number;
}

/* -------------------------------------------------------------------- rows */

export interface DateValue {
  /** ISO date (`YYYY-MM-DD`) or ISO datetime string */
  start: string;
  end?: string | null;
  /** true when the value carries a time part */
  includeTime?: boolean;
}

export interface FileValue {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export type CellValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | DateValue
  | FileValue[]
  | SelectOption
  | SelectOption[];

export type RowValues = Record<string, CellValue>;

export interface RowRecord {
  id: string;
  databaseId: string;
  values: RowValues;
  position: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------- views */

export type ViewType = 'table' | 'board' | 'gallery';

export type FilterOperator =
  | 'contains'
  | 'not_contains'
  | 'is'
  | 'is_not'
  | 'is_empty'
  | 'is_not_empty'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'before'
  | 'after'
  | 'on_or_before'
  | 'on_or_after'
  | 'is_true'
  | 'is_false';

export interface FilterCondition {
  id: string;
  propertyId: string;
  operator: FilterOperator;
  value?: string | number | boolean | string[] | null;
}

export interface Filters {
  conjunction: 'and' | 'or';
  conditions: FilterCondition[];
}

export interface SortRule {
  propertyId: string;
  direction: 'asc' | 'desc';
}

export interface ViewConfig {
  filters: Filters;
  sorts: SortRule[];
  /** property id used to group rows (board view / table grouping) */
  groupBy?: string | null;
  /** null = all properties visible */
  visibleProperties?: string[] | null;
  rowHeight?: 'short' | 'medium' | 'tall';
  cardSize?: 'small' | 'medium' | 'large';
  cardPreviewPropertyId?: string | null;
}

export interface ViewDef {
  id: string;
  databaseId: string;
  name: string;
  type: ViewType;
  config: ViewConfig;
  /** locked views cannot be renamed / reconfigured / deleted */
  locked: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------- sharing / members */

export type Role = 'owner' | 'editor' | 'viewer';

export interface Member {
  id: string;
  databaseId: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  createdAt: number;
}

export interface Share {
  id: string;
  databaseId: string;
  token: string;
  permission: 'view' | 'edit';
  /**
   * 创建链接时勾选的「限制编辑」：可编辑链接的访客对每个格子只有一次修改机会。
   * 只读链接恒为 false（本来就不能改）。
   */
  limitEdits: boolean;
  createdAt: number;
  expiresAt: number | null;
}

/** A single view (its filters + visible fields) shared with one registered user. */
export interface ViewShare {
  id: string;
  databaseId: string;
  viewId: string;
  viewName: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  /**
   * 分享时勾选的「限制编辑」：被分享者（role = 'editor'）对每个格子只有一次修改机会。
   * 可查看的分享恒为 false（本来就不能改）。
   */
  limitEdits: boolean;
  createdAt: number;
}

/* -------------------------------------------------------------- databases */

export interface DatabaseSummary {
  id: string;
  name: string;
  icon: string;
  description: string;
  ownerId: string;
  ownerName?: string;
  role: Role;
  /** true when an owner locked the table structure (fields / views read-only) */
  locked: boolean;
  /** true when access comes from view shares only - 「分享表格」而不是「我的表格」 */
  viewScoped: boolean;
  /** names of the views that were shared with the current user (定向分享) */
  sharedViewNames: string[];
  createdAt: number;
  updatedAt: number;
  rowCount?: number;
}

export interface DatabaseDetail {
  id: string;
  name: string;
  icon: string;
  description: string;
  ownerId: string;
  role: Role;
  /** structure lock: fields / views cannot be changed while true */
  locked: boolean;
  /** true when access comes from view shares only - rows/views are scoped */
  viewScoped: boolean;
  createdAt: number;
  updatedAt: number;
  properties: Property[];
  views: ViewDef[];
  members: Member[];
  shares: Share[];
  viewShares: ViewShare[];
  rows: RowRecord[];
  total: number;
  hasMore: boolean;
  /**
   * 当前访问者「已经改过一次」的单元格（键为 `记录 id:字段 id`）。
   * 只有分享时勾选了「限制编辑」的访问者才有内容：前端据此把这些格子显示成只读。
   * 表格所有者、表格成员、以及没勾选「限制编辑」的分享拿到的永远是空数组。
   */
  lockedCells: string[];
  /** 当前访问者是否受「限制编辑」约束（每个格子只能改一次） */
  limitCellEdits: boolean;
  /**
   * 记录元数据（创建人 / 最后编辑人）里出现过的用户 id → 显示名。
   * 定向分享的访问者不是表格成员，只有这份映射才能显示「创建人」的姓名。
   */
  people: Record<string, string>;
}

/* ----------------------------------------------------------------- users */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/* -------------------------------------------------------------- transport */

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export interface AuthResponse {
  user: SessionUser;
}

export interface DatabaseListResponse {
  databases: DatabaseSummary[];
  user: SessionUser;
  maxUploadMb: number;
}

export interface PublicDatabaseResponse {
  database: {
    id: string;
    name: string;
    icon: string;
    description: string;
    permission: 'view' | 'edit';
    /** 创建链接时勾选的「限制编辑」：每个格子只能改一次 */
    limitEdits: boolean;
    /** 表格所有者（公开链接里「当前用户」筛选解析为这个人） */
    ownerId: string;
    ownerName: string;
  };
  properties: Property[];
  views: ViewDef[];
  rows: RowRecord[];
  total: number;
  hasMore: boolean;
  /** 记录元数据（创建人 / 最后编辑人）里出现过的用户 id → 显示名 */
  people: Record<string, string>;
  /**
   * 通过该分享链接「已经改过一次」的单元格（键为 `记录 id:字段 id`）。
   * 链接勾选了「限制编辑」时才有内容，前端据此显示只读。
   */
  lockedCells: string[];
}
