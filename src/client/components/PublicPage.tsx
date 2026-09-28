/**
 * Read-only (or editable, when the share link allows it) public view of a
 * database. Reached through `/share/:token`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FIELD_META } from '../../shared/fields';
import type { CellValue, Property, PublicDatabaseResponse, RowRecord } from '../../shared/types';
import { ApiError, publicApi } from '../api';
import { applyView, visibleProperties } from '../lib/viewEngine';
import { CellEditor, CellView } from './Cell';

interface PublicPageProps {
  token: string;
}

export function PublicPage({ token }: PublicPageProps) {
  const [payload, setPayload] = useState<PublicDatabaseResponse | null>(null);
  const [rows, setRows] = useState<RowRecord[]>([]);
  const [error, setError] = useState('');
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ rowId: string; propertyId: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    publicApi
      .database(token, { limit: 200 })
      .then((data) => {
        if (cancelled) return;
        setPayload(data);
        setRows(data.rows);
        setActiveViewId(data.views[0]?.id ?? null);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : '分享链接无效或已过期');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const permission = payload?.database.permission ?? 'view';
  const canEdit = permission === 'edit';
  const properties = payload?.properties ?? [];
  const activeView = useMemo(
    () => payload?.views.find((view) => view.id === activeViewId) ?? payload?.views[0] ?? null,
    [payload, activeViewId],
  );
  const columns = activeView ? visibleProperties(properties, activeView.config) : properties;
  const filtered = useMemo(
    () => (activeView ? applyView(properties, rows, activeView.config) : rows),
    [properties, rows, activeView],
  );

  const commitCell = useCallback(
    async (row: RowRecord, property: Property, value: CellValue | undefined) => {
      if (!canEdit) return;
      setRows((prev) =>
        prev.map((item) => {
          if (item.id !== row.id) return item;
          const values = { ...item.values };
          if (value === undefined) delete values[property.id];
          else values[property.id] = value;
          return { ...item, values };
        }),
      );
      try {
        const result = await publicApi.updateRecord(token, row.id, { [property.id]: value ?? null });
        if (result.record) {
          setRows((prev) => prev.map((item) => (item.id === result.record!.id ? result.record! : item)));
        }
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : '保存失败');
        setRows((prev) => prev.map((item) => (item.id === row.id ? row : item)));
      }
    },
    [canEdit, token],
  );

  const createRow = useCallback(async () => {
    if (!canEdit) return;
    try {
      const result = await publicApi.createRecord(token, {});
      if (result.record) setRows((prev) => [...prev, result.record!]);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '新建失败');
    }
  }, [canEdit, token]);

  const deleteRow = useCallback(
    async (row: RowRecord) => {
      if (!canEdit) return;
      try {
        await publicApi.deleteRecord(token, row.id);
        setRows((prev) => prev.filter((item) => item.id !== row.id));
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : '删除失败');
      }
    },
    [canEdit, token],
  );


  if (error && !payload) {
    return (
      <div className="centered">
        <div className="empty-state">
          <h2>无法打开分享链接</h2>
          <p className="error">{error}</p>
        </div>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="centered">
        <p className="muted">正在载入…</p>
      </div>
    );
  }

  return (
    <div className="public-page">
      <header className="topbar">
        <span className="icon-input readonly">{payload.database.icon || '📋'}</span>
        <span className="title-static">{payload.database.name}</span>
        <span className={`badge ${canEdit ? 'role-editor' : 'role-viewer'}`}>{canEdit ? '可编辑' : '只读'}</span>
        <span className="spacer" />
        <span className="small muted">
          {filtered.length} / {payload.total} 条记录
        </span>
      </header>

      {payload.database.description ? <p className="muted small share-desc">{payload.database.description}</p> : null}
      {error ? <p className="error small share-desc">{error}</p> : null}

      {payload.views.length > 1 ? (
        <div className="viewbar">
          {payload.views.map((view) => (
            <button
              key={view.id}
              type="button"
              className={`tab${view.id === (activeView?.id ?? '') ? ' active' : ''}`}
              onClick={() => setActiveViewId(view.id)}
            >
              {view.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="grid-wrap">
        {canEdit ? (
          <div className="grid-toolbar">
            <button type="button" className="btn primary small" onClick={() => void createRow()}>
              ＋ 新建记录
            </button>
          </div>
        ) : null}

        <table className="grid">
          <thead>
            <tr>
              {columns.map((property) => (
                <th key={property.id}>
                  <div className="head">
                    <span className="name" title={FIELD_META[property.type].label}>
                      {property.name}
                    </span>
                  </div>
                </th>
              ))}
              {canEdit ? <th className="add-col" /> : null}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.id}>
                {columns.map((property) => {
                  const isEditing = editing?.rowId === row.id && editing.propertyId === property.id;
                  const editable = canEdit && !FIELD_META[property.type].computed;
                  return (
                    <td key={property.id} className="cell cell-view-cell row-height-short">
                      {isEditing ? (
                        <CellEditor
                          property={property}
                          value={row.values[property.id]}
                          onCommit={(value) => {
                            setEditing(null);
                            void commitCell(row, property, value);
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <CellView
                          property={property}
                          row={row}
                          users={{}}
                          editable={editable}
                          onEdit={() => setEditing({ rowId: row.id, propertyId: property.id })}
                          onQuickChange={(value) => void commitCell(row, property, value)}
                        />
                      )}
                    </td>
                  );
                })}
                {canEdit ? (
                  <td className="cell">
                    <button type="button" className="icon-btn" title="删除记录" onClick={() => void deleteRow(row)}>
                      🗑
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>

        {!filtered.length ? (
          <div className="empty-state">
            <p>还没有记录</p>
            {canEdit ? (
              <button type="button" className="btn primary" onClick={() => void createRow()}>
                创建第一条记录
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
