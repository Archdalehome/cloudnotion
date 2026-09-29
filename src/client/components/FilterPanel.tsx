/**
 * Multi-condition filter builder (全部满足 / 任意满足) used by the top
 * "＋ 新建筛选" button and by the "new view" form. The operator list comes from
 * the shared field metadata so the client and the worker stay in sync.
 */
import { createId, defaultOperatorForType, operatorsForType, operatorsNeedValue } from '../../shared/fields';
import type { FilterCondition, FilterOperator, Filters, Property } from '../../shared/types';

/** An empty filter set (used when creating a view without conditions). */
export function emptyFilters(): Filters {
  return { conjunction: 'and', conditions: [] };
}

/** A single "new" condition for the given property. */
export function newCondition(property: Property): FilterCondition {
  return {
    id: createId(),
    propertyId: property.id,
    operator: defaultOperatorForType(property.type),
    value: '',
  };
}

function valueEditor(
  property: Property,
  operator: FilterOperator,
  value: FilterCondition['value'],
  onChange: (next: string) => void,
) {
  if (!operatorsNeedValue(operator)) return null;
  if (property.type === 'select' || property.type === 'status' || property.type === 'multi_select') {
    return (
      <select className="input" value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>
        <option value="">选择…</option>
        {(property.config.options ?? []).map((option) => (
          <option key={option.id} value={option.name}>
            {option.name}
          </option>
        ))}
      </select>
    );
  }
  const inputType =
    property.type === 'number'
      ? 'number'
      : property.type === 'date' || property.type === 'created_time' || property.type === 'updated_time'
        ? 'date'
        : 'text';
  return (
    <input
      className="input"
      type={inputType}
      value={String(value ?? '')}
      placeholder="值"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export interface FilterPanelProps {
  properties: Property[];
  /** current conditions (missing value = no filters) */
  filters?: Filters | null;
  canEdit: boolean;
  onChange: (next: Filters) => void;
  /** label shown in front of the conjunction selector */
  header?: string;
}

export function FilterPanel({ properties, filters, canEdit, onChange, header = '条件关系' }: FilterPanelProps) {
  const conjunction: Filters['conjunction'] = filters?.conjunction === 'or' ? 'or' : 'and';
  const conditions = filters?.conditions ?? [];
  const propertyOf = (id: string) => properties.find((item) => item.id === id);

  const emit = (next: FilterCondition[], nextConjunction: Filters['conjunction'] = conjunction) =>
    onChange({ conjunction: nextConjunction, conditions: next });

  const patch = (id: string, changes: Partial<FilterCondition>) =>
    emit(conditions.map((condition) => (condition.id === id ? { ...condition, ...changes } : condition)));

  const add = () => {
    const property = properties[0];
    if (!property) return;
    emit([...conditions, newCondition(property)]);
  };

  const remove = (id: string) => emit(conditions.filter((condition) => condition.id !== id));

  return (
    <div>
      <div className="row gap" style={{ marginBottom: 8 }}>
        <span className="small muted">{header}</span>
        <select
          className="input"
          style={{ width: 96 }}
          value={conjunction}
          disabled={!canEdit}
          onChange={(event) => emit(conditions, event.target.value === 'or' ? 'or' : 'and')}
        >
          <option value="and">全部满足</option>
          <option value="or">任意满足</option>
        </select>
      </div>

      {conditions.map((condition) => {
        const property = propertyOf(condition.propertyId) ?? properties[0];
        if (!property) return null;
        return (
          <div className="filter-row" key={condition.id}>
            <select
              className="input"
              value={property.id}
              disabled={!canEdit}
              onChange={(event) => {
                const next = propertyOf(event.target.value);
                if (!next) return;
                patch(condition.id, {
                  propertyId: next.id,
                  operator: defaultOperatorForType(next.type),
                  value: '',
                });
              }}
            >
              {properties.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={condition.operator}
              disabled={!canEdit}
              onChange={(event) => patch(condition.id, { operator: event.target.value as FilterOperator })}
            >
              {operatorsForType(property.type).map((operator) => (
                <option key={operator.value} value={operator.value}>
                  {operator.label}
                </option>
              ))}
            </select>
            {valueEditor(property, condition.operator, condition.value, (next) => patch(condition.id, { value: next }))}
            <button
              type="button"
              className="icon-btn"
              title="删除条件"
              disabled={!canEdit}
              onClick={() => remove(condition.id)}
            >
              ✕
            </button>
          </div>
        );
      })}

      <div className="row gap">
        <button type="button" className="btn ghost small" onClick={add} disabled={!canEdit || !properties.length}>
          ＋ 添加条件
        </button>
        {conditions.length ? (
          <button type="button" className="btn ghost small" onClick={() => emit([])} disabled={!canEdit}>
            清空
          </button>
        ) : (
          <span className="small muted">暂无筛选条件</span>
        )}
      </div>
    </div>
  );
}
