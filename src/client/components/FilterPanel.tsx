/**
 * Multi-condition filter builder（「必须满足」块 + 块内「任意满足」）used by the top
 * "＋ 新建筛选" button and by the "new view" form.
 *
 * 结构：可以加任意多个「必须满足」块（块之间是「且」），每个块里可以加任意多条
 * 「任意满足」（块里命中任意一条就算这块通过）。视图级 `conjunction` 只作为老数据的
 * 缺省值保留，块头 / 块内关系都写在条件自己身上（见 shared/viewFilter.ts）。
 * The operator list comes from the shared field metadata so the client and the worker
 * stay in sync. 人员类字段（创建人 / 最后编辑人）的值支持「当前用户」，筛选时解析为登录用户。
 */
import {
  CURRENT_USER_VALUE,
  createId,
  defaultFilterValueForType,
  defaultOperatorForType,
  isPersonType,
  operatorsForType,
  operatorsNeedValue,
} from '../../shared/fields';
import type { FilterCondition, FilterOperator, Filters, Property } from '../../shared/types';
import { flattenFilterBlocks, groupFilterConditions } from '../../shared/viewFilter';
import type { Conjunction } from '../../shared/viewFilter';

/** userId -> 显示名（用于「创建人」等人员类筛选） */
export type FilterUserNames = Record<string, string>;

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
    value: defaultFilterValueForType(property.type),
  };
}

function valueEditor(
  property: Property,
  operator: FilterOperator,
  value: FilterCondition['value'],
  users: FilterUserNames,
  onChange: (next: string) => void,
) {
  if (!operatorsNeedValue(operator)) return null;
  if (isPersonType(property.type)) {
    const current = String(value ?? '');
    const members = Object.entries(users)
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return (
      <select
        className="input"
        value={current}
        title="「当前用户（我）」= 打开这个视图的人：登录后是本人，公开链接是表格所有者"
        onChange={(event) => onChange(event.target.value)}
      >
        <option value={CURRENT_USER_VALUE}>当前用户（我）</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name}
          </option>
        ))}
        {current && current !== CURRENT_USER_VALUE && !users[current] ? (
          <option value={current}>已离开的成员</option>
        ) : null}
      </select>
    );
  }
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
  /** 面板顶部的标题（「必须满足块 / 任意满足」的说明文字跟在标题下面） */
  header?: string;
  /** userId -> 显示名，人员类字段（创建人 / 最后编辑人）的候选值 */
  users?: FilterUserNames;
}

export function FilterPanel({
  properties,
  filters,
  canEdit,
  onChange,
  header = '筛选条件',
  users = {},
}: FilterPanelProps) {
  const conjunction: Filters['conjunction'] = filters?.conjunction === 'or' ? 'or' : 'and';
  const conditions = filters?.conditions ?? [];
  const propertyOf = (id: string) => properties.find((item) => item.id === id);
  /** 「必须满足」块：块之间是「且」，块里是「任意满足」（或） */
  const blocks = groupFilterConditions(conditions, conjunction);
  const canAdd = canEdit && properties.length > 0;

  /** 视图级关系只作为老数据的缺省值保留，关系都写进条件自己身上 */
  const emitBlocks = (next: FilterCondition[][]) => onChange({ conjunction, conditions: flattenFilterBlocks(next) });

  const patch = (id: string, changes: Partial<FilterCondition>) =>
    emitBlocks(blocks.map((block) => block.map((item) => (item.id === id ? { ...item, ...changes } : item))));

  /** 往第 blockIndex 块里再加一条「任意满足」（命中任意一条就算这块通过） */
  const addToBlock = (blockIndex: number) => {
    const property = properties[0];
    if (!property) return;
    emitBlocks(
      blocks.map((block, index) =>
        index === blockIndex ? [...block, { ...newCondition(property), conjunction: 'or' as Conjunction }] : block,
      ),
    );
  };

  /** 新开一个「必须满足」块：它与前面的所有块之间是「且」 */
  const addBlock = () => {
    const property = properties[0];
    if (!property) return;
    emitBlocks([...blocks, [{ ...newCondition(property), conjunction: 'and' as Conjunction }]]);
  };

  const removeCondition = (id: string) =>
    emitBlocks(blocks.map((block) => block.filter((item) => item.id !== id)).filter((block) => block.length));

  const removeBlock = (blockIndex: number) => emitBlocks(blocks.filter((_, index) => index !== blockIndex));

  return (
    <div className="filter-panel">
      <div className="filter-head">
        <span className="small muted">{header}</span>
        <span className="small muted">
          可以加多个「必须满足」块（块之间是且）；每个块里加多条「任意满足」，命中任意一条就算这一块通过
        </span>
      </div>

      {blocks.map((block, blockIndex) => (
        <div className="filter-block" key={block[0]?.id ?? `block-${blockIndex}`}>
          {block.map((condition, index) => {
            const property = propertyOf(condition.propertyId) ?? properties[0];
            if (!property) return null;
            return (
              <div className="filter-row" key={condition.id}>
                <span
                  className={`filter-link${index === 0 ? ' head' : ''}`}
                  title={
                    index === 0
                      ? '这一条起一个新的「必须满足」块：与前面的块之间是「且」'
                      : '这一条与同块内其它条件是「任意满足」：命中任意一条就算这块通过'
                  }
                >
                  {index === 0 ? '必须满足' : '任意满足'}
                </span>
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
                      value: defaultFilterValueForType(next.type),
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
                {valueEditor(property, condition.operator, condition.value, users, (next) =>
                  patch(condition.id, { value: next }),
                )}
                <button
                  type="button"
                  className="icon-btn"
                  title="删除条件"
                  disabled={!canEdit}
                  onClick={() => removeCondition(condition.id)}
                >
                  ✕
                </button>
              </div>
            );
          })}

          <div className="filter-block-foot">
            <button
              type="button"
              className="btn ghost small"
              disabled={!canAdd}
              onClick={() => addToBlock(blockIndex)}
            >
              ＋ 添加任意满足
            </button>
            {blocks.length > 1 ? (
              <button
                type="button"
                className="btn ghost small"
                title="删除这一块（连同块里的条件）"
                disabled={!canEdit}
                onClick={() => removeBlock(blockIndex)}
              >
                删除该块
              </button>
            ) : null}
          </div>
        </div>
      ))}

      <div className="row gap">
        <button type="button" className="btn ghost small" disabled={!canAdd} onClick={addBlock}>
          ＋ 添加必须满足块
        </button>
        {conditions.length ? (
          <button type="button" className="btn ghost small" disabled={!canEdit} onClick={() => emitBlocks([])}>
            清空
          </button>
        ) : (
          <span className="small muted">暂无筛选条件</span>
        )}
      </div>
    </div>
  );
}
