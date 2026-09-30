/**
 * View tabs + the view level toolbar (设置 / 分享 / ⋯).
 * Filter conditions are edited from the "＋ 新建筛选" button rendered above the
 * view body (see DatabasePage) and from the "＋ 新建视图" form below.
 */
import { useState } from 'react';
import { FIELD_META } from '../../shared/fields';
import { VIEW_TYPE_LABEL } from '../../shared/views';
import type { Filters, Property, ViewConfig, ViewDef, ViewType } from '../../shared/types';
import { FilterPanel, emptyFilters, type FilterUserNames } from './FilterPanel';
import { Popover } from './Popover';

/** Payload of the "＋ 新建视图" form: 自定义名称 / 筛选 / 锁定 / 定向分享. */
export interface NewViewInput {
  /** 恒为 'table'：UI 上不再让用户选视图类型（见 NEW_VIEW_TYPE） */
  type: ViewType;
  name: string;
  filters: Filters;
  locked: boolean;
  /** 定向分享（可选）：role = 'editor' 时可以额外勾选「限制编辑」 */
  share?: { email: string; role: 'editor' | 'viewer'; limitEdits?: boolean };
}

interface ViewBarProps {
  views: ViewDef[];
  active: ViewDef;
  properties: Property[];
  /** userId -> 显示名，用于「创建人」等人员类筛选条件 */
  users?: FilterUserNames;
  /** the active view may be renamed / reconfigured / deleted (false once locked) */
  canEdit: boolean;
  /** may lock / unlock the active view (owner or editor of an unlocked table) */
  canUnlock: boolean;
  /** owner only actions: 该视图的定向分享 */
  canManage: boolean;
  total: number;
  rowCount: number;
  onSelectView: (id: string) => void;
  onCreateView: (input: NewViewInput) => void;
  onRenameView: (id: string, name: string) => void;
  onDeleteView: (id: string) => void;
  onUpdateConfig: (patch: Partial<ViewConfig>) => void;
  onLockView: (id: string, locked: boolean) => void;
  onShareView: (id: string) => void;
}

const VIEW_ICON: Record<ViewType, string> = { table: '▤', board: '▥', gallery: '▦' };

/** 新建视图固定为表格类型：表单里不再提供类型选择，避免误建看板 / 画廊视图 */
const NEW_VIEW_TYPE: ViewType = 'table';

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

/** "＋ 新建视图" form: name, conditions, lock and optional view share. 类型固定为表格。 */
function NewViewForm({
  properties,
  users,
  canShare,
  onCancel,
  onSubmit,
}: {
  properties: Property[];
  /** userId -> 显示名，用于「创建人」等人员类筛选条件 */
  users: FilterUserNames;
  canShare: boolean;
  onCancel: () => void;
  onSubmit: (input: NewViewInput) => void;
}) {
  const [name, setName] = useState('');
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [locked, setLocked] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('viewer');
  /** 「限制编辑」：只随「可编辑」的定向分享一起提交 */
  const [limitEdits, setLimitEdits] = useState(false);

  return (
    <div>
      <label className="field">
        <span>视图名称</span>
        <input
          className="input"
          value={name}
          autoFocus
          placeholder={`默认：${VIEW_TYPE_LABEL[NEW_VIEW_TYPE]}视图`}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      {/* 新建视图不再选类型：固定为表格类型 */}
      <div className="field">
        <span>视图类型</span>
        <div className="row gap" style={{ alignItems: 'center' }}>
          <span className="badge">
            {VIEW_ICON[NEW_VIEW_TYPE]} {VIEW_TYPE_LABEL[NEW_VIEW_TYPE]}
          </span>
          <span className="small muted">新建视图固定为表格类型</span>
        </div>
      </div>

      <div className="menu-label">筛选条件</div>
      <FilterPanel properties={properties} users={users} filters={filters} canEdit onChange={setFilters} />

      <label className="row gap" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={locked} onChange={(event) => setLocked(event.target.checked)} />
        <span>锁定该视图（锁定后不可重命名、改配置或删除）</span>
      </label>

      {canShare ? (
        <>
          <div className="menu-label">定向分享（可选）</div>
          <div className="row gap">
            <input
              className="input"
              type="email"
              placeholder="对方邮箱"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <select
              className="input"
              style={{ width: 110 }}
              value={role}
              onChange={(event) => setRole(event.target.value as 'editor' | 'viewer')}
            >
              <option value="viewer">可查看</option>
              <option value="editor">可编辑</option>
            </select>
          </div>
          <p className="small muted">被分享者只能看到这一个视图及其中的数据。</p>
          {role === 'editor' ? (
            <label className="row gap" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={limitEdits}
                onChange={(event) => setLimitEdits(event.target.checked)}
              />
              <span className="small">
                限制编辑：被分享者对每个格子只有一次输入机会，改过之后该格子只能查看
              </span>
            </label>
          ) : null}
        </>
      ) : null}

      <div className="row gap" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn primary small"
          onClick={() =>
            onSubmit({
              type: NEW_VIEW_TYPE,
              name: name.trim(),
              filters,
              locked,
              share: canShare && email.trim() ? { email: email.trim(), role, limitEdits: role === 'editor' && limitEdits } : undefined,
            })
          }
        >
          创建视图
        </button>
        <button type="button" className="btn ghost small" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

export function ViewBar({
  views,
  active,
  properties,
  users = {},
  canEdit,
  canUnlock,
  canManage,
  total,
  rowCount,
  onSelectView,
  onCreateView,
  onRenameView,
  onDeleteView,
  onUpdateConfig,
  onLockView,
  onShareView,
}: ViewBarProps) {
  const [draftName, setDraftName] = useState(active.name);
  const filterCount = active.config.filters?.conditions.length ?? 0;

  return (
    <div className="viewbar">
      {views.map((view) => (
        <button
          key={view.id}
          type="button"
          className={`tab${view.id === active.id ? ' active' : ''}`}
          title={view.locked ? `${view.name}（已锁定）` : view.name}
          onClick={() => {
            setDraftName(view.name);
            onSelectView(view.id);
          }}
        >
          {VIEW_ICON[view.type]} {view.name}
          {view.locked ? <span className="small muted"> 🔒</span> : null}
        </button>
      ))}

      <Popover label="＋" title="新建视图" wide disabled={!canEdit}>
        {(close) => (
          <NewViewForm
            properties={properties}
            users={users}
            canShare={canManage}
            onCancel={close}
            onSubmit={(input) => {
              onCreateView(input);
              close();
            }}
          />
        )}
      </Popover>

      <span className="spacer" />
      {active.locked ? (
        <span className="badge" title="视图已锁定：名称、筛选与删除均不可修改，可在 ⋯ 中解锁">
          🔒 视图已锁定
        </span>
      ) : null}
      <span className="small muted">
        {rowCount === total ? `${total} 条记录` : `显示 ${rowCount} / 共 ${total} 条`}
        {filterCount ? ` · 筛选 ${filterCount}` : ''}
      </span>

      <Popover label="设置" wide disabled={!canEdit}>
        {() => <SettingsPanel view={active} properties={properties} canEdit={canEdit} onChange={onUpdateConfig} />}
      </Popover>

      {canManage ? (
        <button
          type="button"
          className="btn ghost small"
          title="把当前视图定向分享给指定成员"
          onClick={() => onShareView(active.id)}
        >
          分享
        </button>
      ) : null}

      {canEdit || (active.locked && canUnlock) ? (
        <Popover label="⋯" title={active.locked ? '当前视图（已锁定）' : '当前视图'}>
          {(close) => (
            <div>
              {canEdit ? (
                <>
                  <div className="menu-label">重命名视图</div>
                  <div className="row gap" style={{ padding: '0 8px 8px' }}>
                    <input
                      className="input"
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                    />
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
                </>
              ) : (
                <div className="menu-label">视图已锁定，解锁后才能改名、调整筛选或删除</div>
              )}
              <button
                type="button"
                className="menu-item"
                disabled={!canUnlock}
                onClick={() => {
                  if (!canUnlock) return;
                  onLockView(active.id, !active.locked);
                  close();
                }}
              >
                {active.locked ? '🔓 解锁视图' : '🔒 锁定视图'}
              </button>
              {canManage ? (
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    onShareView(active.id);
                    close();
                  }}
                >
                  🔗 分享此视图
                </button>
              ) : null}
              {canEdit ? (
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
              ) : null}
            </div>
          )}
        </Popover>
      ) : null}
    </div>
  );
}



