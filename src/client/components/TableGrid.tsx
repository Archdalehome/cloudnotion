import { useState } from 'react';
import { FIELD_META, cellLockKey } from '../../shared/fields';
import type { CellValue, FileValue, Property, RowRecord, ViewConfig } from '../../shared/types';
import { CellEditor, CellView, useCloseOnOutsideClick, type UserNames } from './Cell';
import { Popover } from './Popover';

type RowHeight = NonNullable<ViewConfig['rowHeight']>;

interface TableGridProps {
  properties: Property[];
  rows: RowRecord[];
  users: UserNames;
  canEdit: boolean;
  /** 表格未锁定时才可改字段结构（新增 / 移动 / 隐藏 / 锁定 / 删除字段、列宽） */
  canEditStructure: boolean;
  /** 当前视图未锁定时才可改视图配置（排序 / 筛选 / 隐藏字段） */
  canEditView: boolean;
  /** 定向分享的访客（viewScoped）不能勾选记录：行首方框只读 */
  selectable: boolean;
  rowHeight: RowHeight;
  hasMore: boolean;
  onLoadMore: () => void;
  onCreateRow: () => void;
  onCommitCell: (row: RowRecord, property: Property, value: CellValue | undefined) => void;
  uploadFile: (row: RowRecord, property: Property, file: File) => Promise<FileValue>;
  onDuplicateRows: (rows: RowRecord[]) => void;
  onDeleteRows: (rows: RowRecord[]) => void;
  onAddProperty: (afterId: string | null) => void;
  onEditProperty: (property: Property) => void;
  onDeleteProperty: (property: Property) => void;
  onHideProperty: (property: Property) => void;
  /** ← / → 调整该列在表格中的左右位置 */
  onMoveProperty: (property: Property, direction: 'left' | 'right') => void;
  /** 锁定 / 解锁字段（锁定后该字段的所有记录只读） */
  onTogglePropertyLock: (property: Property, locked: boolean) => void;
  onResizeProperty: (property: Property, width: number) => void;
  onSortProperty: (property: Property, direction: 'asc' | 'desc') => void;
  onFilterProperty: (property: Property) => void;
  /**
   * 当前访问者已经改过一次的格子（`记录 id:字段 id`）：共享给可编辑成员 / 公开链接时
   * 每个格子只有一次修改机会，改过的格子只读。所有者访问时为空集合。
   */
  lockedCells: ReadonlySet<string>;
  /** 双击一行打开记录卡片 */
  onOpenRecord: (row: RowRecord) => void;
}

function ColumnMenu({
  property,
  canEditView,
  canMoveLeft,
  canMoveRight,
  onEditProperty,
  onDeleteProperty,
  onHideProperty,
  onMoveProperty,
  onTogglePropertyLock,
  onSortProperty,
  onFilterProperty,
  onAddProperty,
  close,
}: {
  property: Property;
  /** 当前视图可改（未锁定）时才能排序 / 筛选 / 隐藏字段 */
  canEditView: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onEditProperty: (property: Property) => void;
  onDeleteProperty: (property: Property) => void;
  onHideProperty: (property: Property) => void;
  onMoveProperty: (property: Property, direction: 'left' | 'right') => void;
  onTogglePropertyLock: (property: Property, locked: boolean) => void;
  onSortProperty: (property: Property, direction: 'asc' | 'desc') => void;
  onFilterProperty: (property: Property) => void;
  onAddProperty: (afterId: string | null) => void;
  close: () => void;
}) {
  const run = (action: () => void) => () => {
    close();
    action();
  };
  return (
    <div>
      <button type="button" className="menu-item" onClick={run(() => onEditProperty(property))}>
        ✎ 编辑字段
      </button>
      <div className="menu-label">排序与筛选</div>
      <button
        type="button"
        className="menu-item"
        onClick={run(() => onSortProperty(property, 'asc'))}
        disabled={!canEditView}
      >
        ↑ 升序
      </button>
      <button
        type="button"
        className="menu-item"
        onClick={run(() => onSortProperty(property, 'desc'))}
        disabled={!canEditView}
      >
        ↓ 降序
      </button>
      <button
        type="button"
        className="menu-item"
        onClick={run(() => onFilterProperty(property))}
        disabled={!canEditView}
      >
        ⚲ 添加筛选
      </button>
      <div className="menu-label">字段</div>
      <button type="button" className="menu-item" onClick={run(() => onAddProperty(property.id))}>
        ＋ 在右侧插入
      </button>
      <div className="menu-row">
        <button
          type="button"
          className="menu-item center"
          title="该列左移一位"
          disabled={!canMoveLeft}
          onClick={run(() => onMoveProperty(property, 'left'))}
        >
          ←
        </button>
        <button
          type="button"
          className="menu-item center"
          title="该列右移一位"
          disabled={!canMoveRight}
          onClick={run(() => onMoveProperty(property, 'right'))}
        >
          →
        </button>
      </div>
      <button
        type="button"
        className="menu-item"
        onClick={run(() => onHideProperty(property))}
        disabled={!canEditView}
      >
        ⤫ 隐藏字段
      </button>
      <button
        type="button"
        className="menu-item"
        title={
          property.locked
            ? '解锁后该字段的记录才会恢复编辑 / 上传'
            : '锁定后该字段所有记录只能查看，不能编辑或上传'
        }
        onClick={run(() => onTogglePropertyLock(property, !property.locked))}
      >
        {property.locked ? '🔓 解锁字段' : '🔒 锁定字段'}
      </button>
      <button
        type="button"
        className="menu-item danger"
        title={property.locked ? '字段已锁定，请先解锁再删除' : `删除字段「${property.name}」`}
        onClick={run(() => onDeleteProperty(property))}
        disabled={property.locked}
      >
        🗑 删除字段
      </button>
    </div>
  );
}

export function TableGrid(props: TableGridProps) {
  const {
    properties,
    rows,
    users,
    canEdit,
    canEditStructure,
    canEditView,
    selectable,
    rowHeight,
    hasMore,
    onLoadMore,
    onCreateRow,
    onCommitCell,
    uploadFile,
    onDuplicateRows,
    onDeleteRows,
    onAddProperty,
    onResizeProperty,
    lockedCells,
    onOpenRecord,
  } = props;

  const [editing, setEditing] = useState<{ rowId: string; propertyId: string } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [widths, setWidths] = useState<Record<string, number>>({});

  // 点击单元格以外的任意位置即退出输入（日期 / 文件字段自动保存，没有「确认」按钮）
  useCloseOnOutsideClick(editing !== null, () => setEditing(null));

  const widthOf = (property: Property) => widths[property.id] ?? property.width;

  const startResize = (event: React.MouseEvent, property: Property) => {
    event.preventDefault();
    event.stopPropagation();
    if (!canEditStructure) return;
    const startX = event.clientX;
    const startWidth = widthOf(property);
    let current = startWidth;

    const onMove = (moveEvent: MouseEvent) => {
      current = Math.max(90, startWidth + moveEvent.clientX - startX);
      setWidths((prev) => ({ ...prev, [property.id]: current }));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setWidths((prev) => {
        const next = { ...prev };
        delete next[property.id];
        return next;
      });
      if (Math.round(current) !== startWidth) onResizeProperty(property, Math.round(current));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const toggleRow = (id: string) => {
    if (!selectable) return;
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  /**
   * 双击一行打开记录卡片。单击单元格已经会进入编辑态，所以打开卡片前必须先退出编辑，
   * 否则编辑框会和卡片同时出现。
   */
  const openRowCard = (event: React.MouseEvent<HTMLTableRowElement>, row: RowRecord) => {
    const target = event.target;
    // 行首的方框是勾选记录用的：双击它只是勾选 / 取消勾选，不打开卡片
    if (target instanceof HTMLElement && target.closest('.row-head')) return;
    setEditing(null);
    onOpenRecord(row);
  };

  const selectedRows = rows.filter((row) => selected.includes(row.id));
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;
  const totalWidth = properties.reduce((sum, property) => sum + widthOf(property), 44) + (canEditStructure ? 130 : 0);

  return (
    <div className="grid-wrap">
      {selectedRows.length || hasMore ? (
        <div className="grid-toolbar">
          {selectedRows.length ? (
            <>
              <span className="small muted">已选 {selectedRows.length} 条</span>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => onDuplicateRows(selectedRows)}
              >
                复制
              </button>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  onDeleteRows(selectedRows);
                  setSelected([]);
                }}
              >
                删除
              </button>
              <button type="button" className="btn ghost small" onClick={() => setSelected([])}>
                取消选择
              </button>
            </>
          ) : null}
          <span className="spacer" />
          {hasMore ? (
            <button type="button" className="btn small" onClick={onLoadMore}>
              加载更多
            </button>
          ) : null}
        </div>
      ) : null}

      <table className="grid" style={{ minWidth: totalWidth }}>
        <colgroup>
          <col style={{ width: 44 }} />
          {properties.map((property) => (
            <col key={property.id} style={{ width: widthOf(property) }} />
          ))}
          {canEditStructure ? <col style={{ width: 130 }} /> : null}
        </colgroup>
        <thead>
          <tr>
            <th className="row-head">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={!selectable}
                title={selectable ? '全选' : '当前视图不可勾选记录'}
                onChange={() => setSelected(allSelected ? [] : rows.map((row) => row.id))}
              />
            </th>
            {properties.map((property, index) => (
              <th key={property.id}>
                <div className="head">
                  {canEditStructure ? (
                    <span
                      className="name"
                      title={`${property.name} · ${FIELD_META[property.type].label}`}
                      onClick={() => props.onEditProperty(property)}
                    >
                      {property.name}
                    </span>
                  ) : (
                    <span
                      className="name static"
                      title={`${property.name} · ${FIELD_META[property.type].label}`}
                    >
                      {property.name}
                    </span>
                  )}
                  {property.locked ? (
                    <span className="lock-mark" title="该字段已锁定：所有记录只能查看，不能编辑或上传">
                      🔒
                    </span>
                  ) : null}
                  {canEditStructure ? (
                    <Popover label="▾" title={`${property.name} 字段菜单`}>
                      {(close) => (
                        <ColumnMenu
                          property={property}
                          canEditView={canEditView}
                          canMoveLeft={index > 0}
                          canMoveRight={index < properties.length - 1}
                          onEditProperty={props.onEditProperty}
                          onDeleteProperty={props.onDeleteProperty}
                          onHideProperty={props.onHideProperty}
                          onMoveProperty={props.onMoveProperty}
                          onTogglePropertyLock={props.onTogglePropertyLock}
                          onSortProperty={props.onSortProperty}
                          onFilterProperty={props.onFilterProperty}
                          onAddProperty={onAddProperty}
                          close={close}
                        />
                      )}
                    </Popover>
                  ) : null}
                  {canEditStructure ? (
                    <span className="resizer" onMouseDown={(event) => startResize(event, property)} />
                  ) : null}
                </div>
              </th>
            ))}
            {canEditStructure ? (
              <th className="add-col" onClick={() => onAddProperty(null)} title="新建字段">
                ＋ 字段
              </th>
            ) : null}
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={selected.includes(row.id) ? 'selected' : undefined}
              onDoubleClick={(event) => openRowCard(event, row)}
            >
              <td className="row-head">
                <input
                  type="checkbox"
                  checked={selected.includes(row.id)}
                  disabled={!selectable}
                  title={selectable ? '勾选该记录' : '当前视图不可勾选记录'}
                  onChange={() => toggleRow(row.id)}
                />
              </td>
              {properties.map((property) => {
                const isEditing = editing?.rowId === row.id && editing.propertyId === property.id;
                const editable = canEdit && !FIELD_META[property.type].computed && !property.locked;
                /** 共享的可编辑用户每个格子只有一次机会，已经用掉的格子只读 */
                const spent = lockedCells.has(cellLockKey(row.id, property.id));
                return (
                  <td
                    key={property.id}
                    className={`cell cell-view-cell row-height-${rowHeight}`}
                    data-editing-cell={isEditing ? 'true' : undefined}
                  >
                    {isEditing ? (
                      <CellEditor
                        property={property}
                        value={row.values[property.id]}
                        uploadFile={(file) => uploadFile(row, property, file)}
                        onCommit={(value) => {
                          setEditing(null);
                          onCommitCell(row, property, value);
                        }}
                        onAutoSave={(value) => onCommitCell(row, property, value)}
                        onCancel={() => setEditing(null)}
                      />
                    ) : (
                      <CellView
                        property={property}
                        row={row}
                        users={users}
                        editable={editable}
                        spent={spent}
                        onEdit={() => setEditing({ rowId: row.id, propertyId: property.id })}
                        onQuickChange={(value) => onCommitCell(row, property, value)}
                      />
                    )}
                  </td>
                );
              })}
              {canEditStructure ? (
                <td className="cell">
                  <div className="row gap" style={{ padding: '0 4px' }}>
                    <button
                      type="button"
                      className="icon-btn"
                      title="复制记录"
                      disabled={!canEdit}
                      onClick={() => onDuplicateRows([row])}
                    >
                      ⧉
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="删除记录"
                      disabled={!canEdit}
                      onClick={() => onDeleteRows([row])}
                    >
                      🗑
                    </button>
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
          {canEdit ? (
            <tr>
              <td className="row-head" />
              <td className="cell" colSpan={properties.length + (canEditStructure ? 1 : 0)}>
                <button type="button" className="btn ghost small" onClick={onCreateRow}>
                  ＋ 新建记录
                </button>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {!rows.length ? (
        <div className="empty-state">
          <p>还没有记录</p>
          {canEdit ? (
            <button type="button" className="btn primary" onClick={onCreateRow}>
              创建第一条记录
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

