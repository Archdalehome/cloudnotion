/**
 * The database workspace: header (rename / share), view tabs, and the active
 * view body (table / board / gallery). Owns every mutation for one database.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createId, defaultOperatorForType } from '../../shared/fields';
import type {
  CellValue,
  DatabaseDetail,
  FieldType,
  FileValue,
  Property,
  PropertyConfig,
  Role,
  RowRecord,
  SessionUser,
  ViewConfig,
  ViewDef,
  ViewType,
} from '../../shared/types';
import { ApiError, api } from '../api';
import { applyView, groupRows, visibleProperties } from '../lib/viewEngine';
import { BoardView, GalleryView } from './CardViews';
import type { UserNames } from './Cell';
import { PropertyDialog } from './PropertyDialog';
import { RecordDialog } from './RecordDialog';
import { SharePanel } from './SharePanel';
import { TableGrid } from './TableGrid';
import { ViewBar } from './ViewBar';

const PAGE_SIZE = 100;

export type ToastFn = (message: string, kind?: 'info' | 'error') => void;

const ROLE_LABEL: Record<Role, string> = { owner: '所有者', editor: '可编辑', viewer: '可查看' };

interface DatabasePageProps {
  database: DatabaseDetail;
  me: SessionUser | null;
  onToast: ToastFn;
  /** refresh the sidebar after renames / deletes */
  onReloadList: () => void;
  /** called after the database itself was deleted */
  onClose: () => void;
}

type PropertyDialogState = { mode: 'create'; afterId: string | null } | { mode: 'edit'; property: Property } | null;

export function DatabasePage({ database, me, onToast, onReloadList, onClose }: DatabasePageProps) {
  const [detail, setDetail] = useState<DatabaseDetail>(database);
  const [rows, setRows] = useState<RowRecord[]>(database.rows);
  const [total, setTotal] = useState(database.total);
  const [hasMore, setHasMore] = useState(database.hasMore);
  const [activeViewId, setActiveViewId] = useState<string | null>(database.views[0]?.id ?? null);
  const [propertyDialog, setPropertyDialog] = useState<PropertyDialogState>(null);
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(database.name);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setDetail(database);
    setRows(database.rows);
    setTotal(database.total);
    setHasMore(database.hasMore);
    setNameDraft(database.name);
    setActiveViewId((prev) =>
      prev && database.views.some((view) => view.id === prev) ? prev : database.views[0]?.id ?? null,
    );
  }, [database]);

  const { properties, views, members, shares } = detail;
  const role: Role = detail.role;
  const canEdit = role === 'owner' || role === 'editor';
  const isOwner = role === 'owner';

  const users = useMemo<UserNames>(() => {
    const map: UserNames = {};
    for (const member of members) map[member.userId] = member.name || member.email;
    if (me) map[me.id] = me.name || me.email;
    return map;
  }, [members, me]);

  const activeView: ViewDef | null = views.find((view) => view.id === activeViewId) ?? views[0] ?? null;
  const shownProperties = activeView ? visibleProperties(properties, activeView.config) : properties;
  const filtered = useMemo(
    () => (activeView ? applyView(properties, rows, activeView.config) : rows),
    [properties, rows, activeView],
  );
  const groups = useMemo(
    () => (activeView ? groupRows(properties, filtered, activeView.config) : []),
    [properties, filtered, activeView],
  );
  const openRow = openRowId ? rows.find((row) => row.id === openRowId) ?? null : null;

  const fail = useCallback(
    (cause: unknown, fallback: string) => {
      onToast(cause instanceof ApiError ? cause.message : fallback, 'error');
    },
    [onToast],
  );

  /** Re-fetch the first page (used after structural changes). */
  const reload = useCallback(async () => {
    try {
      const next = await api.getDatabase(detail.id, { limit: PAGE_SIZE });
      setDetail(next);
      setRows(next.rows);
      setTotal(next.total);
      setHasMore(next.hasMore);
    } catch (cause) {
      fail(cause, '刷新失败');
    }
  }, [detail.id, fail]);

  const replaceRow = useCallback((record: RowRecord) => {
    setRows((prev) => {
      const exists = prev.some((row) => row.id === record.id);
      const next = exists ? prev.map((row) => (row.id === record.id ? record : row)) : [...prev, record];
      return next.sort((a, b) => a.position - b.position);
    });
  }, []);

  /* ------------------------------------------------------------------- rows */

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const page = await api.rows(detail.id, { limit: PAGE_SIZE, offset: rows.length });
      setRows((prev) => [...prev, ...page.rows.filter((row) => !prev.some((item) => item.id === row.id))]);
      setTotal(page.total);
      setHasMore(page.hasMore);
    } catch (cause) {
      fail(cause, '加载更多失败');
    } finally {
      setLoadingMore(false);
    }
  };

  const createRow = async (preset?: Record<string, CellValue>) => {
    if (!canEdit) return;
    try {
      const result = await api.createRecord(detail.id, { values: { ...preset } });
      if (result.record) replaceRow(result.record);
      setTotal(result.total);
      onReloadList();
    } catch (cause) {
      fail(cause, '新建记录失败');
    }
  };

  const commitCell = async (row: RowRecord, property: Property, value: CellValue | undefined) => {
    if (!canEdit) return;
    // optimistic update, then replace with the authoritative record
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
      const result = await api.updateRecord(row.id, { values: { [property.id]: value ?? null } });
      if (result.record) replaceRow(result.record);
    } catch (cause) {
      fail(cause, '保存失败');
      replaceRow(row);
    }
  };

  const duplicateRows = async (targets: RowRecord[]) => {
    if (!canEdit || !targets.length) return;
    try {
      const result = await api.duplicateRecords(
        detail.id,
        targets.map((row) => row.id),
      );
      setRows((prev) => [...prev, ...result.records].sort((a, b) => a.position - b.position));
      setTotal(result.total);
      onReloadList();
    } catch (cause) {
      fail(cause, '复制失败');
    }
  };

  const deleteRows = async (targets: RowRecord[]) => {
    if (!canEdit || !targets.length) return;
    const ids = new Set(targets.map((row) => row.id));
    try {
      const result = await api.deleteRecords(detail.id, [...ids]);
      setRows((prev) => prev.filter((row) => !ids.has(row.id)));
      setTotal(result.total);
      if (openRowId && ids.has(openRowId)) setOpenRowId(null);
      onReloadList();
    } catch (cause) {
      fail(cause, '删除失败');
    }
  };

  const uploadFile = async (row: RowRecord, property: Property, file: File): Promise<FileValue> => {
    const result = await api.uploadFile(file, {
      databaseId: detail.id,
      recordId: row.id,
      propertyId: property.id,
    });
    return result.file;
  };

  /* ------------------------------------------------------------------ views */

  const patchView = async (viewId: string, patch: { name?: string; config?: ViewConfig }) => {
    try {
      const result = await api.updateView(viewId, patch);
      setDetail((prev) => ({ ...prev, views: result.views }));
    } catch (cause) {
      fail(cause, '视图更新失败');
    }
  };

  const updateActiveConfig = (patch: Partial<ViewConfig>) => {
    if (!activeView || !canEdit) return;
    void patchView(activeView.id, { config: { ...activeView.config, ...patch } });
  };

  const createView = async (type: ViewType) => {
    try {
      const result = await api.createView(detail.id, { type });
      setDetail((prev) => ({ ...prev, views: result.views }));
      setActiveViewId(result.viewId);
    } catch (cause) {
      fail(cause, '新建视图失败');
    }
  };

  const renameView = (viewId: string, name: string) => {
    void patchView(viewId, { name });
  };

  const deleteView = async (viewId: string) => {
    try {
      const result = await api.deleteView(viewId);
      setDetail((prev) => ({ ...prev, views: result.views }));
      if (activeViewId === viewId) setActiveViewId(result.views[0]?.id ?? null);
    } catch (cause) {
      fail(cause, '删除视图失败');
    }
  };

  const addSortFor = (property: Property, direction: 'asc' | 'desc') => {
    if (!activeView) return;
    const others = (activeView.config.sorts ?? []).filter((rule) => rule.propertyId !== property.id);
    updateActiveConfig({ sorts: [...others, { propertyId: property.id, direction }] });
  };

  const addFilterFor = (property: Property) => {
    if (!activeView) return;
    const conditions = activeView.config.filters?.conditions ?? [];
    void patchView(activeView.id, {
      config: {
        ...activeView.config,
        filters: {
          conjunction: activeView.config.filters?.conjunction ?? 'and',
          conditions: [
            ...conditions,
            {
              id: createId(),
              propertyId: property.id,
              operator: defaultOperatorForType(property.type),
              value: '',
            },
          ],
        },
      },
    });
  };

  const hideProperty = (property: Property) => {
    if (!activeView) return;
    const visible = (activeView.config.visibleProperties ?? properties.map((item) => item.id)).filter(
      (id) => id !== property.id,
    );
    updateActiveConfig({ visibleProperties: visible });
  };

  /* ------------------------------------------------------------- properties */

  const insertPosition = (afterId: string | null): number | undefined => {
    if (!afterId) return undefined;
    const index = properties.findIndex((property) => property.id === afterId);
    if (index < 0) return undefined;
    const current = properties[index];
    const next = properties[index + 1];
    return next ? (current.position + next.position) / 2 : current.position + 1000;
  };

  const submitProperty = async (input: { name: string; type: FieldType; config: PropertyConfig }) => {
    const state = propertyDialog;
    if (state?.mode === 'edit') {
      const result = await api.updateProperty(state.property.id, input);
      setDetail((prev) => ({ ...prev, properties: result.properties }));
      if (result.migrated) await reload();
      return;
    }
    const afterId = state?.mode === 'create' ? state.afterId : null;
    const result = await api.createProperty(detail.id, {
      ...input,
      position: insertPosition(afterId),
    });
    setDetail((prev) => ({ ...prev, properties: result.properties }));
  };

  const deleteProperty = async (property: Property) => {
    if (!window.confirm(`删除字段「${property.name}」？该字段的所有数据都会被移除。`)) return;
    try {
      const result = await api.deleteProperty(property.id);
      setDetail((prev) => ({ ...prev, properties: result.properties }));
      await reload();
    } catch (cause) {
      fail(cause, '删除字段失败');
    }
  };

  const resizeProperty = async (property: Property, width: number) => {
    setDetail((prev) => ({
      ...prev,
      properties: prev.properties.map((item) => (item.id === property.id ? { ...item, width } : item)),
    }));
    try {
      const result = await api.updateProperty(property.id, { width });
      setDetail((prev) => ({ ...prev, properties: result.properties }));
    } catch (cause) {
      fail(cause, '调整列宽失败');
    }
  };

  /* -------------------------------------------------------------- database */

  const renameDatabase = async (nextName: string) => {
    const name = nextName.trim();
    if (!name || name === detail.name) {
      setNameDraft(detail.name);
      return;
    }
    try {
      const next = await api.updateDatabase(detail.id, { name });
      setDetail((prev) => ({ ...prev, name: next.name }));
      onReloadList();
    } catch (cause) {
      setNameDraft(detail.name);
      fail(cause, '重命名失败');
    }
  };

  const changeIcon = async (icon: string) => {
    try {
      await api.updateDatabase(detail.id, { icon });
      setDetail((prev) => ({ ...prev, icon }));
      onReloadList();
    } catch (cause) {
      fail(cause, '图标更新失败');
    }
  };

  const deleteDatabase = async () => {
    if (!window.confirm(`确定删除表格「${detail.name}」？此操作不可恢复。`)) return;
    try {
      await api.deleteDatabase(detail.id);
      onReloadList();
      onClose();
    } catch (cause) {
      fail(cause, '删除表格失败');
    }
  };

  const applyMembers = (next: typeof members) => setDetail((prev) => ({ ...prev, members: next }));
  const applyShares = (next: typeof shares) => setDetail((prev) => ({ ...prev, shares: next }));

  /* ----------------------------------------------------------------- render */

  const boardGroupProperty = activeView?.config.groupBy
    ? properties.find((property) => property.id === activeView.config.groupBy) ?? null
    : null;

  return (
    <section className="workspace">
      <header className="topbar">
        <input
          className="icon-input"
          value={detail.icon}
          maxLength={4}
          title="图标"
          disabled={!canEdit}
          onChange={(event) => setDetail((prev) => ({ ...prev, icon: event.target.value }))}
          onBlur={(event) => void changeIcon(event.target.value.trim() || '📋')}
        />
        <input
          className="title-input"
          value={nameDraft}
          disabled={!canEdit}
          onChange={(event) => setNameDraft(event.target.value)}
          onBlur={() => void renameDatabase(nameDraft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          }}
        />
        <span className={`badge role-${role}`}>{ROLE_LABEL[role]}</span>
        <span className="spacer" />
        <span className="small muted">{members.length} 位成员 · {total} 条记录</span>
        <button type="button" className="btn ghost small" onClick={() => setShareOpen(true)}>
          分享与成员
        </button>
        {isOwner ? (
          <button type="button" className="btn ghost small danger" onClick={() => void deleteDatabase()}>
            删除表格
          </button>
        ) : null}
      </header>

      {activeView ? (
        <ViewBar
          views={views}
          active={activeView}
          properties={properties}
          canEdit={canEdit}
          total={total}
          rowCount={filtered.length}
          onSelectView={(id) => setActiveViewId(id)}
          onCreateView={(type) => void createView(type)}
          onRenameView={renameView}
          onDeleteView={(id) => void deleteView(id)}
          onUpdateConfig={updateActiveConfig}
        />
      ) : null}

      <div className="view-body">
        {activeView?.type === 'board' ? (
          <BoardView
            properties={properties}
            groups={groups}
            users={users}
            view={activeView}
            canEdit={canEdit}
            onOpen={(row) => setOpenRowId(row.id)}
            onCreateRow={(option) => {
              if (boardGroupProperty && option) void createRow({ [boardGroupProperty.id]: option });
              else void createRow();
            }}
            onMoveRow={(row, key) => {
              if (!boardGroupProperty) return;
              const group = groups.find((item) => item.key === key);
              if (!group) return;
              if (boardGroupProperty.type === 'checkbox') void commitCell(row, boardGroupProperty, key === 'true');
              else if (group.option) void commitCell(row, boardGroupProperty, group.option);
            }}
          />
        ) : activeView?.type === 'gallery' ? (
          <GalleryView
            properties={properties}
            rows={filtered}
            users={users}
            view={activeView}
            canEdit={canEdit}
            onOpen={(row) => setOpenRowId(row.id)}
            onCreateRow={() => void createRow()}
          />
        ) : (
          <TableGrid
            properties={shownProperties}
            rows={filtered}
            users={users}
            canEdit={canEdit}
            rowHeight={activeView?.config.rowHeight ?? 'short'}
            hasMore={hasMore}
            onLoadMore={() => void loadMore()}
            onCreateRow={() => void createRow()}
            onCommitCell={commitCell}
            uploadFile={uploadFile}
            onDuplicateRows={(targets) => void duplicateRows(targets)}
            onDeleteRows={(targets) => void deleteRows(targets)}
            onAddProperty={(afterId) => setPropertyDialog({ mode: 'create', afterId })}
            onEditProperty={(property) => setPropertyDialog({ mode: 'edit', property })}
            onDeleteProperty={(property) => void deleteProperty(property)}
            onHideProperty={hideProperty}
            onResizeProperty={(property, width) => void resizeProperty(property, width)}
            onSortProperty={addSortFor}
            onFilterProperty={addFilterFor}
          />
        )}

        {!activeView ? (
          <div className="empty-state">
            <p>该表格还没有视图。</p>
          </div>
        ) : null}
      </div>

      {propertyDialog ? (
        <PropertyDialog
          property={propertyDialog.mode === 'edit' ? propertyDialog.property : null}
          onClose={() => setPropertyDialog(null)}
          onSubmit={submitProperty}
        />
      ) : null}

      {openRow ? (
        <RecordDialog
          properties={properties}
          row={openRow}
          users={users}
          canEdit={canEdit}
          onClose={() => setOpenRowId(null)}
          onCommitCell={(property, value) => void commitCell(openRow, property, value)}
          uploadFile={(property, file) => uploadFile(openRow, property, file)}
          onDuplicate={() => void duplicateRows([openRow])}
          onDelete={() => void deleteRows([openRow])}
        />
      ) : null}

      {shareOpen ? (
        <SharePanel
          database={detail}
          canManage={isOwner}
          onClose={() => setShareOpen(false)}
          onToast={onToast}
          onMembers={applyMembers}
          onShares={applyShares}
        />
      ) : null}
    </section>
  );
}

