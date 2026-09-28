import { useState } from 'react';
import { FIELD_META, createId, defaultOperatorForType, operatorsForType, operatorsNeedValue } from '../../shared/fields';
import { VIEW_TYPE_LABEL } from '../../shared/views';
import type {
  FilterCondition,
  FilterOperator,
  Property,
  SortRule,
  ViewConfig,
  ViewDef,
  ViewType,
} from '../../shared/types';
import { Popover } from './Popover';

interface ViewBarProps {
  views: ViewDef[];
  active: ViewDef;
  properties: Property[];
  canEdit: boolean;
  total: number;
  rowCount: number;
  onSelectView: (id: string) => void;
  onCreateView: (type: ViewType) => void;
  onRenameView: (id: string, name: string) => void;
  onDeleteView: (id: string) => void;
  onUpdateConfig: (patch: Partial<ViewConfig>) => void;
}

const VIEW_ICON: Record<ViewType, string> = { table: '▤', board: '▥', gallery: '▦' };

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

/**
 * Filter conditions grouped by property type; the operator list comes from the
 * shared field metadata so the client and worker stay in sync.
 */

function FilterPanel({
  properties,
  config,
  canEdit,
  onChange,
}: {
  properties: Property[];
  config: ViewConfig;
  canEdit: boolean;
  onChange: (next: ViewConfig['filters']) => void;
}) {
  const conditions = config.filters?.conditions ?? [];
  const propertyOf = (id: string) => properties.find((item) => item.id === id);

  const patch = (id: string, changes: Partial<FilterCondition>) => {
    onChange({
      conjunction: config.filters?.conjunction ?? 'and',
      conditions: conditions.map((condition) => (condition.id === id ? { ...condition, ...changes } : condition)),
    });
  };

  const add = () => {
    const property = properties[0];
    if (!property) return;
    onChange({
      conjunction: config.filters?.conjunction ?? 'and',
      conditions: [
        ...conditions,
        {
          id: createId(),
          propertyId: property.id,
          operator: defaultOperatorForType(property.type),
          value: '',
        },
      ],
    });
  };

  const remove = (id: string) => {
    onChange({
      conjunction: config.filters?.conjunction ?? 'and',
      conditions: conditions.filter((condition) => condition.id !== id),
    });
  };

  return (
    <div>
      <div className="row gap" style={{ marginBottom: 8 }}>
        <span className="small muted">条件关系</span>
        <select
          className="input"
          style={{ width: 96 }}
          value={config.filters?.conjunction ?? 'and'}
          disabled={!canEdit}
          onChange={(event) =>
            onChange({
              conjunction: event.target.value === 'or' ? 'or' : 'and',
              conditions,
            })
          }
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
          <button
            type="button"
            className="btn ghost small"
            onClick={() => onChange({ conjunction: config.filters?.conjunction ?? 'and', conditions: [] })}
            disabled={!canEdit}
          >
            清空
          </button>
        ) : (
          <span className="small muted">暂无筛选条件</span>
        )}
      </div>
    </div>
  );
}


function SortPanel({
  properties,
  config,
  canEdit,
  onChange,
}: {
  properties: Property[];
  config: ViewConfig;
  canEdit: boolean;
  onChange: (next: SortRule[]) => void;
}) {
  const sorts = config.sorts ?? [];

  const add = () => {
    const used = new Set(sorts.map((rule) => rule.propertyId));
    const property = properties.find((item) => !used.has(item.id)) ?? properties[0];
    if (!property) return;
    onChange([...sorts, { propertyId: property.id, direction: 'asc' }]);
  };

  return (
    <div>
      {sorts.map((rule, index) => (
        <div className="filter-row" key={`${rule.propertyId}-${index}`}>
          <select
            className="input"
            value={rule.propertyId}
            disabled={!canEdit}
            onChange={(event) =>
              onChange(sorts.map((item, i) => (i === index ? { ...item, propertyId: event.target.value } : item)))
            }
          >
            {properties.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <select
            className="input"
            style={{ width: 96 }}
            value={rule.direction}
            disabled={!canEdit}
            onChange={(event) =>
              onChange(
                sorts.map((item, i) =>
                  i === index ? { ...item, direction: event.target.value === 'desc' ? 'desc' : 'asc' } : item,
                ),
              )
            }
          >
            <option value="asc">升序</option>
            <option value="desc">降序</option>
          </select>
          <button
            type="button"
            className="icon-btn"
            title="删除排序"
            disabled={!canEdit}
            onClick={() => onChange(sorts.filter((_, i) => i !== index))}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="row gap">
        <button type="button" className="btn ghost small" onClick={add} disabled={!canEdit || !properties.length}>
          ＋ 添加排序
        </button>
        {sorts.length ? (
          <button type="button" className="btn ghost small" onClick={() => onChange([])} disabled={!canEdit}>
            清空
          </button>
        ) : (
          <span className="small muted">默认按手动顺序排列</span>
        )}
      </div>
    </div>
  );
}


function SettingsPanel({
  view,
  properties,
  canEdit,
  onChange,
}: {
  view: ViewDef;
  properties: Property[];
  canEdit: boolean;
  onChange: (patch: Partial<ViewConfig>) => void;
}) {
  const groupable = properties.filter((property) => FIELD_META[property.type].groupable);
  const visible = view.config.visibleProperties;

  const toggleVisible = (id: string) => {
    const current = visible ?? properties.map((property) => property.id);
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    onChange({ visibleProperties: next });
  };

  return (
    <div>
      <label className="field">
        <span>分组依据</span>
        <select
          className="input"
          value={view.config.groupBy ?? ''}
          disabled={!canEdit}
          onChange={(event) => onChange({ groupBy: event.target.value || null })}
        >
          <option value="">不分组</option>
          {groupable.map((property) => (
            <option key={property.id} value={property.id}>
              {property.name}
            </option>
          ))}
        </select>
      </label>

      {view.type === 'gallery' ? (
        <label className="field">
          <span>卡片大小</span>
          <select
            className="input"
            value={view.config.cardSize ?? 'medium'}
            disabled={!canEdit}
            onChange={(event) => onChange({ cardSize: event.target.value as NonNullable<ViewConfig['cardSize']> })}
          >
            <option value="small">小</option>
            <option value="medium">中</option>
            <option value="large">大</option>
          </select>
        </label>
      ) : (
        <label className="field">
          <span>行高</span>
          <select
            className="input"
            value={view.config.rowHeight ?? 'short'}
            disabled={!canEdit}
            onChange={(event) => onChange({ rowHeight: event.target.value as NonNullable<ViewConfig['rowHeight']> })}
          >
            <option value="short">紧凑</option>
            <option value="medium">中等</option>
            <option value="tall">宽松</option>
          </select>
        </label>
      )}

      {view.type === 'gallery' ? (
        <label className="field">
          <span>卡片预览字段</span>
          <select
            className="input"
            value={view.config.cardPreviewPropertyId ?? ''}
            disabled={!canEdit}
            onChange={(event) => onChange({ cardPreviewPropertyId: event.target.value || null })}
          >
            <option value="">无</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="field">
        <span>显示的字段</span>
        <div style={{ maxHeight: 200, overflow: 'auto' }}>
          {properties.map((property) => (
            <label key={property.id} className="row gap" style={{ padding: '2px 0' }}>
              <input
                type="checkbox"
                checked={!visible || visible.includes(property.id)}
                disabled={!canEdit}
                onChange={() => toggleVisible(property.id)}
              />
              <span>{property.name}</span>
            </label>
          ))}
        </div>
        {visible ? (
          <button
            type="button"
            className="btn ghost small"
            disabled={!canEdit}
            onClick={() => onChange({ visibleProperties: null })}
          >
            显示全部字段
          </button>
        ) : null}
      </div>
    </div>
  );
}


export function ViewBar({
  views,
  active,
  properties,
  canEdit,
  total,
  rowCount,
  onSelectView,
  onCreateView,
  onRenameView,
  onDeleteView,
  onUpdateConfig,
}: ViewBarProps) {
  const [draftName, setDraftName] = useState(active.name);
  const filterCount = active.config.filters?.conditions.length ?? 0;
  const sortCount = active.config.sorts?.length ?? 0;

  return (
    <div className="viewbar">
      {views.map((view) => (
        <button
          key={view.id}
          type="button"
          className={`tab${view.id === active.id ? ' active' : ''}`}
          onClick={() => {
            setDraftName(view.name);
            onSelectView(view.id);
          }}
        >
          <span>{VIEW_ICON[view.type]}</span>
          {view.name}
        </button>
      ))}

      <Popover label="＋" title="新建视图">
        {(close) => (
          <div>
            <div className="menu-label">视图类型</div>
            {(['table', 'board', 'gallery'] as ViewType[]).map((type) => (
              <button
                key={type}
                type="button"
                className="menu-item"
                onClick={() => {
                  onCreateView(type);
                  close();
                }}
              >
                <span>{VIEW_ICON[type]}</span>
                {VIEW_TYPE_LABEL[type]}
              </button>
            ))}
          </div>
        )}
      </Popover>

      <span className="spacer" />
      <span className="small muted">
        {rowCount === total ? `${total} 条记录` : `显示 ${rowCount} / 共 ${total} 条`}
      </span>

      <Popover label={`筛选${filterCount ? ` · ${filterCount}` : ''}`} wide>
        {() => (
          <FilterPanel
            properties={properties}
            config={active.config}
            canEdit={canEdit}
            onChange={(filters) => onUpdateConfig({ filters })}
          />
        )}
      </Popover>

      <Popover label={`排序${sortCount ? ` · ${sortCount}` : ''}`}>
        {() => (
          <SortPanel
            properties={properties}
            config={active.config}
            canEdit={canEdit}
            onChange={(sorts) => onUpdateConfig({ sorts })}
          />
        )}
      </Popover>

      <Popover label="设置" wide>
        {() => <SettingsPanel view={active} properties={properties} canEdit={canEdit} onChange={onUpdateConfig} />}
      </Popover>

      {canEdit ? (
        <Popover label="⋯" title="当前视图">
          {(close) => (
            <div>
              <div className="menu-label">重命名视图</div>
              <div className="row gap" style={{ padding: '0 8px 8px' }}>
                <input className="input" value={draftName} onChange={(event) => setDraftName(event.target.value)} />
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    const name = draftName.trim();
                    if (name && name !== active.name) onRenameView(active.id, name);
                    close();
                  }}
                >
                  保存
                </button>
              </div>
              <button
                type="button"
                className="menu-item danger"
                disabled={views.length <= 1}
                onClick={() => {
                  if (views.length > 1) onDeleteView(active.id);
                  close();
                }}
              >
                🗑 删除此视图
              </button>
            </div>
          )}
        </Popover>
      ) : null}
    </div>
  );
}

