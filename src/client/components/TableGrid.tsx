import { useState } from 'react';
import { FIELD_META } from '../../shared/fields';
import type { CellValue, FileValue, Property, RowRecord, ViewConfig } from '../../shared/types';
import { CellEditor, CellView, type UserNames } from './Cell';
import { Popover } from './Popover';

type RowHeight = NonNullable<ViewConfig['rowHeight']>;

interface TableGridProps {
  properties: Property[];
  rows: RowRecord[];
  users: UserNames;
  canEdit: boolean;
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
  onResizeProperty: (property: Property, width: number) => void;
  onSortProperty: (property: Property, direction: 'asc' | 'desc') => void;
  onFilterProperty: (property: Property) => void;
}

function ColumnMenu({
  property,
  canEdit,
  onEditProperty,
  onDeleteProperty,
  onHideProperty,
  onSortProperty,
  onFilterProperty,
  onAddProperty,
  close,
}: {
  property: Property;
  canEdit: boolean;
  onEditProperty: (property: Property) => void;
  onDeleteProperty: (property: Property) => void;
  onHideProperty: (property: Property) => void;
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
      <button type="button" className="menu-item" onClick={run(() => onEditProperty(property))} disabled={!canEdit}>
        ✎ 编辑字段
      </button>
      <button
        type="button"
        className="menu-item"
        onClick={run(() => onSortProperty(property, 'asc'))}
        disabled={!canEdit}
      >
        ↑ 升序
      </button>
      <button
        type="button"
        className="menu-item"
        onClick={run(() => onSortProperty(property, 'desc'))}
        disabled={!canEdit}
      >
        ↓ 降序
      </button>
      <button type="button" className="menu-item" onClick={run(() => onFilterProperty(property))} disabled={!canEdit}>
        ⚲ 添加筛选
      </button>
      <div className="menu-label">字段</div>
      <button type="button" className="menu-item" onClick={run(() => onAddProperty(property.id))} disabled={!canEdit}>
        ＋ 在右侧插入
      </button>
      <button type="button" className="menu-item" onClick={run(() => onHideProperty(property))} disabled={!canEdit}>
        ⤫ 隐藏字段
      </button>
      <button
        type="button"
        className="menu-item danger"
        onClick={run(() => onDeleteProperty(property))}
        disabled={!canEdit}
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
  } = props;

  const [editing, setEditing] = useState<{ rowId: string; propertyId: string } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [widths, setWidths] = useState<Record<string, number>>({});

  const widthOf = (property: Property) => widths[property.id] ?? property.width;

  const startResize = (event: React.MouseEvent, property: Property) => {
    event.preventDefault();
    event.stopPropagation();
    if (!canEdit) return;
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
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const selectedRows = rows.filter((row) => selected.includes(row.id));
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;
  const totalWidth = properties.reduce((sum, property) => sum + widthOf(property), 44) + 130;

  return (
    <div className="grid-wrap">
      <div className="grid-toolbar">
        <button type="button" className="btn primary small" onClick={onCreateRow} disabled={!canEdit}>
          ＋ 新建记录
        </button>
        {selectedRows.length ? (
          <>
            <span className="small muted">已选 {selectedRows.length} 条</span>
            <button type="button" className="btn ghost small" onClick={() => onDuplicateRows(selectedRows)}>
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

      <table className="grid" style={{ minWidth: totalWidth }}>
        <colgroup>
          <col style={{ width: 44 }} />
          {properties.map((property) => (
            <col key={property.id} style={{ width: widthOf(property) }} />
          ))}
          <col style={{ width: 130 }} />
        </colgroup>
        <thead>
          <tr>
            <th className="row-head">
              <input
                type="checkbox"
                checked={allSelected}
                title="全选"
                onChange={() => setSelected(allSelected ? [] : rows.map((row) => row.id))}
              />
            </th>
            {properties.map((property) => (
              <th key={property.id}>
                <div className="head">
                  <span
                    className="name"
                    title={`${property.name} · ${FIELD_META[property.type].label}`}
                    onClick={() => props.onEditProperty(property)}
                  >
                    {property.name}
                  </span>
                  <Popover label="▾">
                    {(close) => (
                      <ColumnMenu
                        property={property}
                        canEdit={canEdit}
                        onEditProperty={props.onEditProperty}
                        onDeleteProperty={props.onDeleteProperty}
                        onHideProperty={props.onHideProperty}
                        onSortProperty={props.onSortProperty}
                        onFilterProperty={props.onFilterProperty}
                        onAddProperty={onAddProperty}
                        close={close}
                      />
                    )}
                  </Popover>
                  <span className="resizer" onMouseDown={(event) => startResize(event, property)} />
                </div>
              </th>
            ))}
            <th className="add-col" onClick={() => onAddProperty(null)} title="新建字段">
              ＋ 字段
            </th>
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={selected.includes(row.id) ? 'selected' : undefined}>
              <td className="row-head">
                <input type="checkbox" checked={selected.includes(row.id)} onChange={() => toggleRow(row.id)} />
              </td>
              {properties.map((property) => {
                const isEditing = editing?.rowId === row.id && editing.propertyId === property.id;
                const editable = canEdit && !FIELD_META[property.type].computed;
                return (
                  <td key={property.id} className={`cell cell-view-cell row-height-${rowHeight}`}>
                    {isEditing ? (
                      <CellEditor
                        property={property}
                        value={row.values[property.id]}
                        uploadFile={(file) => uploadFile(row, property, file)}
                        onCommit={(value) => {
                          setEditing(null);
                          onCommitCell(row, property, value);
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    ) : (
                      <CellView
                        property={property}
                        row={row}
                        users={users}
                        editable={editable}
                        onEdit={() => setEditing({ rowId: row.id, propertyId: property.id })}
                        onQuickChange={(value) => onCommitCell(row, property, value)}
                      />
                    )}
                  </td>
                );
              })}
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
            </tr>
          ))}
          {canEdit ? (
            <tr>
              <td className="row-head" />
              <td className="cell" colSpan={properties.length + 1}>
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

