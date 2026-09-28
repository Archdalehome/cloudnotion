/**
 * Client-side view engine: applies a saved view (filters, sorts, grouping,
 * visible columns) to the rows returned by the API.
 */
import { comparableValue, dateValueToDate, isEmptyValue, formatValueForDisplay } from '../../shared/fields';
import type { CellValue, FilterCondition, Property, RowRecord, SelectOption, ViewConfig } from '../../shared/types';

function dateish(property: Property): boolean {
  return property.type === 'date' || property.type === 'created_time' || property.type === 'updated_time';
}

function timestampOf(property: Property, row: RowRecord, raw: CellValue | undefined): number | null {
  if (property.type === 'created_time') return row.createdAt;
  if (property.type === 'updated_time') return row.updatedAt;
  const date = dateValueToDate(raw);
  return date ? date.getTime() : null;
}

function textOf(property: Property, raw: CellValue | undefined): string {
  return formatValueForDisplay(property.type, raw, property.config);
}

function matchesCondition(property: Property, condition: FilterCondition, row: RowRecord): boolean {
  const raw = row.values[property.id];
  const empty = isEmptyValue(raw);
  const operator = condition.operator;

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

  if (dateish(property)) {
    const left = timestampOf(property, row, raw);
    const target = new Date(String(condition.value ?? '')).getTime();
    if (left === null || Number.isNaN(target)) return false;
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

export function filterRows(properties: Property[], rows: RowRecord[], config: ViewConfig): RowRecord[] {
  const conditions = config.filters?.conditions ?? [];
  if (!conditions.length) return rows;
  const byId = new Map(properties.map((property) => [property.id, property]));
  const conjunction = config.filters?.conjunction === 'or' ? 'or' : 'and';

  return rows.filter((row) => {
    const results = conditions.map((condition) => {
      const property = byId.get(condition.propertyId);
      return property ? matchesCondition(property, condition, row) : true;
    });
    return conjunction === 'or' ? results.some(Boolean) : results.every(Boolean);
  });
}

export function sortRows(properties: Property[], rows: RowRecord[], config: ViewConfig): RowRecord[] {
  const rules = config.sorts ?? [];
  if (!rules.length) return rows;
  const byId = new Map(properties.map((property) => [property.id, property]));
  const active = rules.filter((rule) => byId.has(rule.propertyId));
  if (!active.length) return rows;

  return [...rows].sort((a, b) => {
    for (const rule of active) {
      const property = byId.get(rule.propertyId)!;
      const left = comparableValue(property.type, a.values[property.id], a);
      const right = comparableValue(property.type, b.values[property.id], b);
      let delta = 0;
      if (typeof left === 'number' && typeof right === 'number') delta = left - right;
      else delta = String(left).localeCompare(String(right), 'zh-CN');
      if (delta !== 0) return rule.direction === 'desc' ? -delta : delta;
    }
    return a.position - b.position;
  });
}

/** Filter + sort in one pass (filter first, then order). */
export function applyView(properties: Property[], rows: RowRecord[], config: ViewConfig): RowRecord[] {
  return sortRows(properties, filterRows(properties, rows, config), config);
}

export function visibleProperties(properties: Property[], config: ViewConfig): Property[] {
  const visible = config.visibleProperties;
  if (!visible) return properties;
  const set = new Set(visible);
  return properties.filter((property) => set.has(property.id));
}

export interface RowGroup {
  key: string;
  label: string;
  option: SelectOption | null;
  rows: RowRecord[];
}

function groupKeyOf(property: Property, row: RowRecord): { key: string; label: string; option: SelectOption | null } {
  const raw = row.values[property.id];
  if (property.type === 'select' || property.type === 'status') {
    const option = (raw as SelectOption | undefined) ?? null;
    return option ? { key: option.id, label: option.name, option } : { key: '__empty__', label: '未分组', option: null };
  }
  if (property.type === 'checkbox') {
    return raw === true
      ? { key: 'true', label: '已勾选', option: null }
      : { key: 'false', label: '未勾选', option: null };
  }
  if (dateish(property)) {
    const stamp = timestampOf(property, row, raw);
    if (stamp === null) return { key: '__empty__', label: '未分组', option: null };
    const iso = new Date(stamp).toISOString().slice(0, 10);
    return { key: iso, label: iso, option: null };
  }
  const text = textOf(property, raw);
  return text ? { key: text, label: text, option: null } : { key: '__empty__', label: '未分组', option: null };
}

/** Group rows by the view's groupBy property (board columns / table grouping). */
export function groupRows(properties: Property[], rows: RowRecord[], config: ViewConfig): RowGroup[] {
  const property = config.groupBy ? properties.find((item) => item.id === config.groupBy) : undefined;
  if (!property) return [{ key: '__all__', label: '全部', option: null, rows }];

  const buckets = new Map<string, RowGroup>();
  const order: string[] = [];
  const optionBased = property.type === 'select' || property.type === 'status';

  if (optionBased) {
    for (const option of property.config.options ?? []) {
      buckets.set(option.id, { key: option.id, label: option.name, option, rows: [] });
      order.push(option.id);
    }
  }

  for (const row of rows) {
    const { key, label, option } = groupKeyOf(property, row);
    if (!buckets.has(key)) {
      buckets.set(key, { key, label, option, rows: [] });
      order.push(key);
    }
    buckets.get(key)!.rows.push(row);
  }

  const groups = order.map((key) => buckets.get(key)!);
  // keep empty option columns (so a board still shows every status) but hide
  // empty dynamic groups such as "未分组"
  return optionBased ? groups : groups.filter((group) => group.rows.length > 0);
}
