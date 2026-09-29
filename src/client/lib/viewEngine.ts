/**
 * Client-side view engine: applies a saved view (filters, sorts, grouping,
 * visible columns) to the rows returned by the API. Row filtering itself lives
 * in src/shared/viewFilter.ts so the client and the worker agree on it.
 */
import { comparableValue } from '../../shared/fields';
import type { Property, RowRecord, SelectOption, ViewConfig } from '../../shared/types';
import { dateishProperty, filterRows, textOf, timestampOf, type FilterContext } from '../../shared/viewFilter';

export { filterRows };
export type { FilterContext };
/** Order rows by the view's sort rules (stable, falls back to `position`). */
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
export function applyView(
  properties: Property[],
  rows: RowRecord[],
  config: ViewConfig,
  ctx: FilterContext = {},
): RowRecord[] {
  return sortRows(properties, filterRows(properties, rows, config, ctx), config);
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
  if (dateishProperty(property)) {
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
