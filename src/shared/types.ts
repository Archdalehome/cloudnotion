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
  /**
   * 这条条件与前一条的关系：`and` = 这条**另起一个「必须满足」块**（与前面的块取交集），
   * `or` = 这条与**同一块**里前面的条件是「任意满足」（命中任意一条即可）。
   * 省略时退回视图级的 {@link Filters.conjunction}（老视图 / 老接口的数据兼容）。
   * 求值见 shared/viewFilter.ts 的 groupFilterConditions / filterRows。
   */
  conjunction?: 'and' | 'or';
}

export interface Filters {
  /**
   * 视图级关系：只对**没有** {@link FilterCondition.conjunction} 的条件生效（老视图兼容）。
   * 界面上每条条件都可选「必须满足 / 任意满足」：多个「必须满足」块之间是「且」，
   * 每个块里的多条「任意满足」是「或」。
   */
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
   * 创建链接时勾选的「限制编辑」：可编辑链接的访客输入不限次数，
   * 但每次保存后要等 10 秒这一格才会锁上（清空则视为没输入过）。
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
   * 分享时勾选的「限制编辑」：被分享者（role = 'editor'）输入不限次数，
   * 但每次保存后要等 10 秒这一格才会锁上（清空则视为没输入过）。
   * 可查看的分享恒为 false（本来就不能改）。
   */
  limitEdits: boolean;
  createdAt: number;
}

/* ---------------------------------------------------------------- notes */

/** 备注里被 @ 到的人（备注正文里的 `@名字` 与它一一对应）。 */
export interface NoteMention {
  userId: string;
  name: string;
}

/**
 * 一条记录备注（评论）。备注只能新增，不能修改 / 删除。
 */
export interface RecordNote {
  id: string;
  databaseId: string;
  recordId: string;
  body: string;
  authorId: string | null;
  authorName: string;
  /** 备注里 @ 到的人；会给每人各发一条私信 */
  mentions: NoteMention[];
  createdAt: number;
}

/**
 * 收件箱里的一条私信：别人在备注里 @ 了你。
 * 点开后 `read_at` 被写入，未读数 -1；归零后红点消失。
 */
export interface InboxMessage {
  id: string;
  noteId: string;
  databaseId: string;
  databaseName: string;
  databaseIcon: string;
  recordId: string;
  /** 记录标题（表格第一个文本字段的值），用于在列表里识别记录 */
  recordTitle: string;
  authorName: string;
  /** 备注正文（列表里截断显示） */
  body: string;
  createdAt: number;
}

export interface InboxResponse {
  /** 未读私信，按时间倒序（点开即从列表里消失） */
  messages: InboxMessage[];
  /** 未读私信条数，就是红点里的数字 */
  unread: number;
}

/* --------------------------------------------------------------- cell lock */

/**
 * 单元格级「限制编辑」的当前状态：只读的格子 + 还在计时窗口内的格子。
 *
 * 只有勾选了「限制编辑」的访问者（公开分享链接 / 视图定向分享）才有内容：
 * - 每次保存成功都会开始 / 刷新 10 秒计时窗口（`CELL_EDIT_GRACE_MS`），窗口内想改
 *   多少遍都行；
 * - 窗口一过，只要这一格还有内容就只读（列进 `lockedCells`），只能请表格所有者代改；
 * - 窗口内把内容清空 = 没输入过：这两个列表里都不会出现这一格。
 *
 * 表格所有者、表格成员、以及没勾选「限制编辑」的分享拿到的永远是空的。
 */
export interface CellEditLocks {
  /** 保存过、计时窗口已过、且现在仍有内容的格子（只读）：键为 `记录 id:字段 id` */
  lockedCells: string[];
  /**
   * 还在 10 秒计时窗口内的格子：键为 `记录 id:字段 id`，值为窗口截止时刻（epoch ms）。
   * 客户端据此倒计时（窗口一到该格自动变只读）；服务端始终是权威判断。
   */
  cellEditGrace: Record<string, number>;
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
  /** 表级锁定功能已移除，恒为 false（保留字段以兼容旧数据 / 旧客户端） */
  locked: boolean;
  /** true when access comes from view shares only - 「分享表格」而不是「我的表格」 */
  viewScoped: boolean;
  /** names of the views that were shared with the current user (定向分享) */
  sharedViewNames: string[];
  createdAt: number;
  updatedAt: number;
  rowCount?: number;
}

export interface DatabaseDetail extends CellEditLocks {
  id: string;
  name: string;
  icon: string;
  description: string;
  ownerId: string;
  role: Role;
  /** 表级锁定功能已移除，恒为 false（保留字段以兼容旧数据 / 旧客户端） */
  locked: boolean;
  /** true when access comes from view shares only - rows/views are scoped */
  viewScoped: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * 服务端当前的改动版本号（多人协作增量同步的游标）。
   * 打开表格时先记下它，之后每隔几秒带 `?since=<rev>` 轮询
   * `GET /api/databases/:id/changes`，只拿别人刚改的格子 / 刚加的备注。
   */
  rev: number;
  properties: Property[];
  views: ViewDef[];
  members: Member[];
  shares: Share[];
  viewShares: ViewShare[];
  /**
   * 可以被 @ 提醒的人：表格所有者 + 表格成员 + 定向分享的访客。
   * 备注输入框的 @ 候选名单和后端校验用的是同一份数据，
   * 所以所有者和各个被分享者之间都能互相 @（公开链接的匿名访客没有身份，不在此列）。
   */
  mentionables: Member[];
  rows: RowRecord[];
  total: number;
  hasMore: boolean;
  /**
   * 当前这一页记录上的备注（评论），按 `createdAt` 升序。
   * 备注只能新增，不能修改 / 删除（服务端没有对应的接口）。
   */
  notes: RecordNote[];
  /** 当前访问者是否受「限制编辑」约束（输入不限次数，保存后 10 秒这一格才锁上） */
  limitCellEdits: boolean;
  /**
   * 记录元数据（创建人 / 最后编辑人）里出现过的用户 id → 显示名。
   * 定向分享的访问者不是表格成员，只有这份映射才能显示「创建人」的姓名。
   */
  people: Record<string, string>;
}

/**
 * 增量同步的返回体：自客户端手上的 `rev` 之后的改动。
 *
 * 前端在表格页开着的时候每隔几秒轮询一次（`?since=<rev>`），
 * 只把「有更新的单元格 / 新记录 / 被删掉的行 / 新备注」合并进本地状态，
 * 所以别人改数据不用刷新页面就能看到，也不用整表重拉。
 */
export interface DatabaseChanges extends CellEditLocks {
  /** 服务端当前的版本号：下次请求带上它，就只看更新的改动 */
  rev: number;
  /**
   * true = 攒了太多改动（或日志已被清理），这一轮不带增量，
   * 客户端应该整表重载一次并以新数据的 `rev` 作为游标。
   */
  reset: boolean;
  /** 值 / 顺序有变化的记录（已删掉的不在其中） */
  rows: RowRecord[];
  /** 被删除的记录 id */
  deleted: string[];
  /** 这些记录上新加的备注（备注只增不改，可以直接合并） */
  notes: RecordNote[];
  /** 行元数据里出现过的用户 id → 显示名（别人的改动可能带来本地没有的姓名） */
  people: Record<string, string>;
  /** 表格当前的记录总数 */
  total: number;
}

/* ----------------------------------------------------------------- users */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  /** 管理员（超级用户）：客户端据此显示「用户管理」入口 */
  isAdmin: boolean;
}

/**
 * 注册第一步（`POST /api/auth/register`）的响应：账号还没建好，等用户填确认码。
 * `devCode` 只在「邮件服务未配置」或「收件人是保留测试域」时出现，方便本地开发 / 自动化测试。
 */
export interface RegistrationPending {
  pending: true;
  email: string;
  /** 确认码有效期（分钟） */
  ttlMinutes: number;
  /** 距离过期还有多少秒 */
  expiresInSeconds: number;
  /** 是否真的把确认码发出去了 */
  emailDelivered: boolean;
  /** 仅在没发信时返回：把确认码直接回显出来 */
  devCode?: string;
}

/** 管理员用户列表里的一行（GET /api/admin/users）。 */
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  createdAt: number;
  updatedAt: number;
  /** 自己拥有的表格数 */
  databaseCount: number;
  /** 被邀请协作的表格数 */
  sharedCount: number;
  /** 最近一次会话时间（从没登录过则为 null） */
  lastSeenAt: number | null;
}

export interface AdminUserListResponse {
  users: AdminUser[];
  total: number;
  limit: number;
  offset: number;
  search: string;
}

/** 管理员重置密码的响应：`password` 是新的（临时）密码，直接展示给管理员。 */
export interface AdminPasswordResetResponse {
  ok: true;
  user: { id: string; email: string; name: string };
  password: string;
  /** 是否已经把新密码邮件发给了用户 */
  emailed: boolean;
  /** 该用户的所有会话是否已被清理 */
  sessionsRevoked: boolean;
  /** 重置的是不是管理员自己的账号（自己的会话也会失效，需要重新登录） */
  resetSelf: boolean;
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

export interface PublicDatabaseResponse extends CellEditLocks {
  database: {
    id: string;
    name: string;
    icon: string;
    description: string;
    permission: 'view' | 'edit';
    /** 创建链接时勾选的「限制编辑」：输入不限次数，保存后 10 秒这一格才锁上 */
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
  /**
   * 服务端当前的改动版本号（增量同步游标）：公开链接页也每隔几秒带
   * `?since=<rev>` 轮询 `/api/public/:token/changes`，别人改的格子自己出现。
   */
  rev: number;
  /** 记录元数据（创建人 / 最后编辑人）里出现过的用户 id → 显示名 */
  people: Record<string, string>;
}
