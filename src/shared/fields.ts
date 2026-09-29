/**
 * Field (property) type metadata and pure value helpers.
 * Shared by the Worker (validation / normalisation) and the client (rendering).
 */
import type {
  CellValue,
  DateValue,
  DateFormat,
  FieldType,
  FileValue,
  FilterOperator,
  NumberFormat,
  OptionColor,
  PropertyConfig,
  SelectOption,
} from './types';

export interface FieldTypeMeta {
  label: string;
  /** key resolved by the client icon registry */
  icon: string;
  defaultWidth: number;
  hasOptions: boolean;
  /** value is derived from row metadata, not editable */
  computed: boolean;
  groupable: boolean;
}

export const FIELD_META: Record<FieldType, FieldTypeMeta> = {
  text: { label: '文本', icon: 'text', defaultWidth: 220, hasOptions: false, computed: false, groupable: true },
  number: { label: '数字', icon: 'number', defaultWidth: 160, hasOptions: false, computed: false, groupable: false },
  select: { label: '单选', icon: 'select', defaultWidth: 170, hasOptions: true, computed: false, groupable: true },
  multi_select: { label: '多选', icon: 'multiSelect', defaultWidth: 200, hasOptions: true, computed: false, groupable: false },
  status: { label: '状态', icon: 'status', defaultWidth: 170, hasOptions: true, computed: false, groupable: true },
  date: { label: '日期', icon: 'calendar', defaultWidth: 170, hasOptions: false, computed: false, groupable: true },
  checkbox: { label: '复选框', icon: 'checkbox', defaultWidth: 110, hasOptions: false, computed: false, groupable: true },
  url: { label: '链接', icon: 'link', defaultWidth: 220, hasOptions: false, computed: false, groupable: false },
  email: { label: '邮箱', icon: 'mail', defaultWidth: 220, hasOptions: false, computed: false, groupable: false },
  phone: { label: '电话', icon: 'phone', defaultWidth: 180, hasOptions: false, computed: false, groupable: false },
  files: { label: '文件与媒体', icon: 'paperclip', defaultWidth: 240, hasOptions: false, computed: false, groupable: false },
  created_time: { label: '创建时间', icon: 'clock', defaultWidth: 175, hasOptions: false, computed: true, groupable: true },
  updated_time: { label: '最后编辑时间', icon: 'clock', defaultWidth: 175, hasOptions: false, computed: true, groupable: true },
  created_by: { label: '创建人', icon: 'user', defaultWidth: 150, hasOptions: false, computed: true, groupable: false },
  updated_by: { label: '最后编辑人', icon: 'user', defaultWidth: 150, hasOptions: false, computed: true, groupable: false },
};

/** Order used by the "new property" type picker. */
export const FIELD_TYPE_ORDER: FieldType[] = [
  'text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'checkbox',
  'url',
  'email',
  'phone',
  'files',
  'created_time',
  'updated_time',
  'created_by',
  'updated_by',
];

export const OPTION_COLORS: OptionColor[] = [
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
  'default',
];

export const COLOR_LABEL: Record<OptionColor, string> = {
  default: '默认',
  gray: '灰',
  brown: '棕',
  orange: '橙',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  purple: '紫',
  pink: '粉',
  red: '红',
};

export function defaultOptionColor(index: number): OptionColor {
  return OPTION_COLORS[index % (OPTION_COLORS.length - 1)];
}

export function defaultPropertyConfig(type: FieldType): PropertyConfig {
  switch (type) {
    case 'select':
    case 'multi_select':
      return {
        options: [
          { id: createId(), name: '选项 1', color: defaultOptionColor(0) },
          { id: createId(), name: '选项 2', color: defaultOptionColor(1) },
        ],
      };
    case 'status':
      return {
        options: [
          { id: createId(), name: '未开始', color: 'gray' },
          { id: createId(), name: '进行中', color: 'blue' },
          { id: createId(), name: '已完成', color: 'green' },
        ],
      };
    case 'number':
      return { format: 'plain', precision: 0 };
    case 'date':
      return { dateFormat: 'YYYY-MM-DD', includeTime: false };
    case 'created_time':
    case 'updated_time':
      return { dateFormat: 'YYYY-MM-DD', includeTime: true };
    default:
      return {};
  }
}

/* ---------------------------------------------------------------- operators */

export function operatorsForType(type: FieldType): { value: FilterOperator; label: string }[] {
  switch (type) {
    case 'select':
    case 'status':
      return [
        { value: 'is', label: '是' },
        { value: 'is_not', label: '不是' },
        { value: 'is_empty', label: '为空' },
        { value: 'is_not_empty', label: '不为空' },
      ];
    case 'multi_select':
      return [
        { value: 'contains', label: '包含' },
        { value: 'not_contains', label: '不包含' },
        { value: 'is_empty', label: '为空' },
        { value: 'is_not_empty', label: '不为空' },
      ];
    case 'number':
      return [
        { value: 'eq', label: '=' },
        { value: 'neq', label: '≠' },
        { value: 'gt', label: '>' },
        { value: 'lt', label: '<' },
        { value: 'gte', label: '≥' },
        { value: 'lte', label: '≤' },
        { value: 'is_empty', label: '为空' },
        { value: 'is_not_empty', label: '不为空' },
      ];
    case 'checkbox':
      return [
        { value: 'is_true', label: '已勾选' },
        { value: 'is_false', label: '未勾选' },
      ];
    case 'date':
    case 'created_time':
    case 'updated_time':
      return [
        { value: 'is', label: '是' },
        { value: 'before', label: '早于' },
        { value: 'after', label: '晚于' },
        { value: 'on_or_before', label: '早于或等于' },
        { value: 'on_or_after', label: '晚于或等于' },
        { value: 'is_empty', label: '为空' },
        { value: 'is_not_empty', label: '不为空' },
      ];
    case 'created_by':
    case 'updated_by':
      return [
        { value: 'is', label: '是' },
        { value: 'is_not', label: '不是' },
        { value: 'is_empty', label: '为空' },
        { value: 'is_not_empty', label: '不为空' },
      ];
    case 'files':
      return [
        { value: 'is_empty', label: '为空' },
        { value: 'is_not_empty', label: '不为空' },
      ];
    default:
      return [
        { value: 'contains', label: '包含' },
        { value: 'not_contains', label: '不包含' },
        { value: 'is', label: '是' },
        { value: 'is_not', label: '不是' },
        { value: 'is_empty', label: '为空' },
        { value: 'is_not_empty', label: '不为空' },
      ];
  }
}

/** Operator used by a freshly added filter row. */
export function defaultOperatorForType(type: FieldType): FilterOperator {
  return operatorsForType(type)[0].value;
}

export function operatorsNeedValue(operator: FilterOperator): boolean {
  return !['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(operator);
}

/**
 * 人员类字段（创建人 / 最后编辑人）的值来自行元数据而不是 `row.values`。
 */
export function isPersonType(type: FieldType): boolean {
  return type === 'created_by' || type === 'updated_by';
}

/**
 * 筛选条件里的特殊值：解析为「当前用户」。
 * 客户端解析为登录用户，视图定向分享时由 Worker 解析为访问者，公开分享页解析为表格所有者。
 */
export const CURRENT_USER_VALUE = '@me';

/** 新建筛选条件时的默认值：人员类字段默认就是「当前用户」，其它类型留空。 */
export function defaultFilterValueForType(type: FieldType): string {
  return isPersonType(type) ? CURRENT_USER_VALUE : '';
}

/* ------------------------------------------------------------- value helpers */

export function isEmptyValue(value: CellValue | undefined): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function dateValueToDate(value: unknown): Date | null {
  if (!value || typeof value !== 'object') return null;
  const start = (value as DateValue).start;
  if (!start) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    const [y, m, d] = start.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const parsed = new Date(start);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isOptionLike(value: unknown, options: SelectOption[]): value is SelectOption {
  return !!value && typeof value === 'object' && options.some((o) => o.id === (value as SelectOption).id);
}

/**
 * Coerce incoming data into the canonical shape of a field type.
 * Invalid input degrades to `null` instead of failing the request.
 */
export function normalizeCellValue(type: FieldType, value: unknown, config: PropertyConfig): CellValue {
  if (value === null || value === undefined || value === '') return null;
  switch (type) {
    case 'number': {
      const num = asNumber(value);
      return num === null ? null : num;
    }
    case 'checkbox':
      return value === true || value === 'true' || value === 1 || value === '1';
    case 'select':
    case 'status': {
      const options = config.options ?? [];
      if (isOptionLike(value, options)) return { ...(value as SelectOption) };
      if (typeof value === 'string') {
        const match = options.find((o) => o.name === value);
        return match ? { ...match } : null;
      }
      return null;
    }
    case 'multi_select': {
      const options = config.options ?? [];
      const list = Array.isArray(value) ? value : [value];
      const normalized = list
        .map((item) => {
          if (isOptionLike(item, options)) return { ...(item as SelectOption) };
          if (typeof item === 'string') {
            const match = options.find((o) => o.name === item);
            return match ? { ...match } : null;
          }
          return null;
        })
        .filter((v): v is SelectOption => v !== null);
      return normalized.length ? normalized : null;
    }
    case 'date': {
      if (typeof value === 'string') {
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return null;
        return {
          start: /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : parsed.toISOString(),
          end: null,
          includeTime: value.includes('T'),
        };
      }
      if (typeof value === 'object') {
        const raw = value as DateValue;
        if (!raw.start) return null;
        const parsed = new Date(raw.start);
        if (Number.isNaN(parsed.getTime())) return null;
        const result: DateValue = {
          start: /^\d{4}-\d{2}-\d{2}$/.test(raw.start) ? raw.start : parsed.toISOString(),
          end: null,
          includeTime: raw.includeTime ?? raw.start.includes('T'),
        };
        if (raw.end) {
          const endParsed = new Date(raw.end);
          if (!Number.isNaN(endParsed.getTime())) {
            result.end = /^\d{4}-\d{2}-\d{2}$/.test(raw.end) ? raw.end : endParsed.toISOString();
          }
        }
        return result;
      }
      return null;
    }
    case 'files': {
      if (!Array.isArray(value)) return null;
      const files = value
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const file = item as Partial<FileValue>;
          if (!file.id || !file.name) return null;
          return {
            id: String(file.id),
            name: String(file.name),
            size: Number(file.size ?? 0),
            mime: String(file.mime ?? 'application/octet-stream'),
          } satisfies FileValue;
        })
        .filter((v): v is FileValue => v !== null);
      return files.length ? files : null;
    }
    default:
      // text-ish types: text / url / email / phone
      return String(value).slice(0, 20000);
  }
}

/* --------------------------------------------------------------- formatting */

export function formatNumber(value: number, config: PropertyConfig): string {
  const format: NumberFormat = config.format ?? 'plain';
  const precision = config.precision ?? 0;
  if (format === 'percent') return `${(value * 100).toFixed(precision)}%`;
  if (format === 'currency') {
    const currency = config.currency ?? 'CNY';
    try {
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency,
        minimumFractionDigits: precision,
        maximumFractionDigits: precision,
      }).format(value);
    } catch {
      return `${currency} ${value.toFixed(precision)}`;
    }
  }
  if (format === 'comma') {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    }).format(value);
  }
  return value.toFixed(precision);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n: number) => String(n).padStart(2, '0');

export function formatPlainDate(value: DateValue | null | undefined): string {
  if (!value || !value.start) return '';
  const date = dateValueToDate(value);
  if (!date) return '';
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function formatDateValue(value: DateValue | null | undefined, config: PropertyConfig): string {
  if (!value || !value.start) return '';
  const date = dateValueToDate(value);
  if (!date) return '';
  const includeTime = value.includeTime ?? config.includeTime ?? false;
  const fmt: DateFormat = config.dateFormat ?? 'YYYY-MM-DD';
  const y = date.getUTCFullYear();
  const mo = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  let text: string;
  switch (fmt) {
    case 'DD/MM/YYYY':
      text = `${d}/${mo}/${y}`;
      break;
    case 'MMM D, YYYY':
      text = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${y}`;
      break;
    case 'YYYY年M月D日':
      text = `${y}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
      break;
    default:
      text = `${y}-${mo}-${d}`;
  }
  if (includeTime) text += ` ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  if (value.end) {
    const end = dateValueToDate({ start: value.end });
    if (end) text += ` → ${end.getUTCFullYear()}-${pad2(end.getUTCMonth() + 1)}-${pad2(end.getUTCDate())}`;
  }
  return text;
}

export function formatTimestamp(ts: number | null | undefined, config: PropertyConfig): string {
  if (!ts) return '';
  return formatDateValue({ start: new Date(ts).toISOString(), includeTime: true }, config);
}

export interface DisplayContext {
  /** user id -> display name */
  users?: Record<string, string>;
}

/** Human readable single-line representation of a cell (search, cards, ...). */
export function formatValueForDisplay(
  type: FieldType,
  value: CellValue | undefined,
  config: PropertyConfig,
  ctx: DisplayContext = {},
): string {
  if (isEmptyValue(value)) return '';
  switch (type) {
    case 'number':
      return formatNumber(value as number, config);
    case 'checkbox':
      return value ? '已勾选' : '未勾选';
    case 'select':
    case 'status':
      return (value as SelectOption).name;
    case 'multi_select':
      return (value as SelectOption[]).map((o) => o.name).join(', ');
    case 'date':
      return formatDateValue(value as DateValue, config);
    case 'files':
      return (value as FileValue[]).map((f) => f.name).join(', ');
    case 'created_by':
    case 'updated_by':
      return ctx.users?.[value as string] ?? '';
    default:
      return String(value);
  }
}

export interface RowLike {
  createdAt: number;
  updatedAt: number;
}

/** Value used for sorting / comparing two rows. */
export function comparableValue(
  type: FieldType,
  value: CellValue | undefined,
  row?: RowLike,
): number | string {
  if (type === 'created_time') return row?.createdAt ?? 0;
  if (type === 'updated_time') return row?.updatedAt ?? 0;
  if (isEmptyValue(value)) return '';
  switch (type) {
    case 'number':
      return value as number;
    case 'checkbox':
      return value ? 1 : 0;
    case 'select':
    case 'status':
      return (value as SelectOption).name;
    case 'multi_select':
      return (value as SelectOption[]).map((o) => o.name).join(', ');
    case 'date': {
      const date = dateValueToDate(value);
      return date ? date.getTime() : 0;
    }
    default:
      return String(value);
  }
}




export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
