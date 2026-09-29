/**
 * Shared row filtering engine.
 *
 * Lives in `shared/` because both sides need it: the client applies a view to
 * the rows it loaded, while the worker has to apply the same rules to build the
 * row set of a view-only share (see `routes/databases.ts`).
 */
import { CURRENT_USER_VALUE, dateValueToDate, formatValueForDisplay, isEmptyValue, isPersonType } from './fields';
import type {
  CellValue,
  FilterCondition,
  FilterOperator,
  Property,
  RowRecord,
  SelectOption,
  ViewConfig,
} from './types';

/**
 * 求值筛选条件时可用的上下文。
 * `viewerId` 用来解析「当前用户」（{@link CURRENT_USER_VALUE}）：客户端是登录用户，
 * 视图定向分享是访问者，公开分享页是表格所有者。
 */
export interface FilterContext {
  viewerId?: string | null;
}

export function dateishProperty(property: Property): boolean {
  return property.type === 'date' || property.type === 'created_time' || property.type === 'updated_time';
}

export function timestampOf(property: Property, row: RowRecord, raw: CellValue | undefined): number | null {
  if (property.type === 'created_time') return row.createdAt;
  if (property.type === 'updated_time') return row.updatedAt;
  const date = dateValueToDate(raw);
  return date ? date.getTime() : null;
}

export function textOf(property: Property, raw: CellValue | undefined): string {
  return formatValueForDisplay(property.type, raw, property.config);
}

/** 人员类字段（创建人 / 最后编辑人）的实际取值：行元数据里的用户 id。 */
export function personIdOf(property: Property, row: RowRecord): string {
  if (property.type === 'created_by') return row.createdBy ?? '';
  if (property.type === 'updated_by') return row.updatedBy ?? '';
  return '';
}

/** 把条件里的值解析成用户 id（`@me` -> 当前访问者）。 */
export function resolvePersonTarget(value: FilterCondition['value'], ctx: FilterContext = {}): string {
  const raw = String(value ?? '');
  if (raw !== CURRENT_USER_VALUE) return raw;
  return ctx.viewerId ?? '';
}

function compareDate(operator: FilterOperator, left: number, target: number): boolean {
  switch (operator) {
    case 'is':
      return left === target;
    case 'before':
      return left < target;
    case 'after':
      return left > target;
    case 'on_or_before':
      return left <= target;
    case 'on_or_after':
      return left >= target;
    default:
      return false;
  }
}

export function matchesCondition(
  property: Property,
  condition: FilterCondition,
  row: RowRecord,
  ctx: FilterContext = {},
): boolean {
  const raw = row.values[property.id];
  const operator = condition.operator;

  // 人员类字段：值来自行元数据，且支持「当前用户」这个特殊值
  if (isPersonType(property.type)) {
    const actual = personIdOf(property, row);
    if (operator === 'is_empty') return !actual;
    if (operator === 'is_not_empty') return !!actual;
    const target = resolvePersonTarget(condition.value, ctx);
    // 没有「当前用户」可比（例如未登录的公开访客）时只有「不是」成立
    if (!target) return operator === 'is_not';
    return operator === 'is_not' ? actual !== target : actual === target;
  }

  // 创建时间 / 最后编辑时间：同样来自行元数据
  if (property.type === 'created_time' || property.type === 'updated_time') {
    const left = timestampOf(property, row, raw);
    if (operator === 'is_empty') return left === null;
    if (operator === 'is_not_empty') return left !== null;
    const target = new Date(String(condition.value ?? '')).getTime();
    if (left === null || Number.isNaN(target)) return false;
    return compareDate(operator, left, target);
  }

  const empty = isEmptyValue(raw);

  if (operator === 'is_empty') return empty;
  if (operator === 'is_not_empty') return !empty;
  if (operator === 'is_true') return raw === true;
  if (operator === 'is_false') return raw !== true;
  if (empty) return operator === 'is_not' || operator === 'neq' || operator === 'not_contains';

  if (property.type === 'select' || property.type === 'status') {
    const name = (raw as SelectOption | undefined)?.name ?? '';
    const target = String(condition.value ?? '');
    return operator === 'is_not' ? name !== target : name === target;
  }

  if (property.type === 'multi_select') {
    const names = ((raw as SelectOption[] | undefined) ?? []).map((option) => option.name);
    const has = names.includes(String(condition.value ?? ''));
    return operator === 'not_contains' ? !has : has;
  }

  if (property.type === 'number') {
    const left = typeof raw === 'number' ? raw : Number(raw);
    const right = Number(condition.value);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    switch (operator) {
      case 'eq':
        return left === right;
      case 'neq':
        return left !== right;
      case 'gt':
        return left > right;
      case 'lt':
        return left < right;
      case 'gte':
        return left >= right;
      case 'lte':
        return left <= right;
      default:
        return false;
    }
  }

  if (dateishProperty(property)) {
    const left = timestampOf(property, row, raw);
    const target = new Date(String(condition.value ?? '')).getTime();
    if (left === null || Number.isNaN(target)) return false;
    return compareDate(operator, left, target);
  }

  if (property.type === 'checkbox') {
    const checked = raw === true;
    return operator === 'is_not' || operator === 'neq' ? !checked : checked;
  }

  const text = textOf(property, raw).toLowerCase();
  const target = String(condition.value ?? '').toLowerCase();
  switch (operator) {
    case 'is':
      return text === target;
    case 'is_not':
      return text !== target;
    case 'not_contains':
      return !text.includes(target);
    default:
      return text.includes(target);
  }
}

/** Apply the view's conditions (all / any) to a list of rows. */
export function filterRows(
  properties: Property[],
  rows: RowRecord[],
  config: ViewConfig,
  ctx: FilterContext = {},
): RowRecord[] {
  const conditions = config.filters?.conditions ?? [];
  if (!conditions.length) return rows;
  const byId = new Map(properties.map((property) => [property.id, property]));
  const conjunction = config.filters?.conjunction === 'or' ? 'or' : 'and';

  return rows.filter((row) => {
    const results = conditions.map((condition) => {
      const property = byId.get(condition.propertyId);
      return property ? matchesCondition(property, condition, row, ctx) : true;
    });
    return conjunction === 'or' ? results.some(Boolean) : results.every(Boolean);
  });
}

/** Keep a single row (used by the worker for view-only shares). */
export function rowMatchesView(
  properties: Property[],
  row: RowRecord,
  config: ViewConfig,
  ctx: FilterContext = {},
): boolean {
  return filterRows(properties, [row], config, ctx).length > 0;
}
