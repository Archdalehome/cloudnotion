/**
 * The database workspace: header (rename / share), view tabs, and the active
 * view body (table / board / gallery). Owns every mutation for one database.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createId, cellLockHint, cellLockKey, defaultFilterValueForType, defaultOperatorForType, sameCellValue } from '../../shared/fields';
import type {
  CellValue,
  DatabaseDetail,
  FieldType,
  FileValue,
  Property,
  PropertyConfig,
  RecordNote,
  Role,
  RowRecord,
  SessionUser,
  ViewConfig,
  ViewDef,
  ViewShare,
} from '../../shared/types';
import { defaultViewConfig } from '../../shared/views';
import { ApiError, api } from '../api';
import { applyView, groupRows, visibleProperties } from '../lib/viewEngine';
import { BoardView, GalleryView } from './CardViews';
import type { UserNames } from './Cell';
import { FilterPanel } from './FilterPanel';
import { Popover } from './Popover';
import { PropertyDialog } from './PropertyDialog';
import { RecordDialog } from './RecordDialog';
import { SharePanel } from './SharePanel';
import { TableGrid } from './TableGrid';
import { ViewBar, type NewViewInput } from './ViewBar';

const PAGE_SIZE = 100;
/** 从私信跳转时，记录不一定落在第一页：最多把整表拉回来这么多条（服务端上限） */
const MAX_FETCH = 1000;

export type ToastFn = (message: string, kind?: 'info' | 'error') => void;

const ROLE_LABEL: Record<Role, string> = { owner: '所有者', editor: '可编辑', viewer: '可查看' };

interface DatabasePageProps {
  database: DatabaseDetail;
  me: SessionUser | null;
  onToast: ToastFn;
  /** refresh the sidebar after renames / deletes */
  onReloadList: () => void;
  /**
   * 从收件箱点开私信时带过来的位置：打开这条记录卡片并定位到那条备注。
   * 由本组件消费后调用 `onInboxTargetHandled` 清空（避免重复打开）。
   */
  inboxTarget?: { recordId: string; noteId: string } | null;
  onInboxTargetHandled: () => void;
  /** called after the database itself was deleted */
  onClose: () => void;
}

type PropertyDialogState = { mode: 'create'; afterId: string | null } | { mode: 'edit'; property: Property } | null;

export function DatabasePage({
  database,
  me,
  onToast,
  onReloadList,
  inboxTarget,
  onInboxTargetHandled,
  onClose,
}: DatabasePageProps) {
  const [detail, setDetail] = useState<DatabaseDetail>(database);
  const [rows, setRows] = useState<RowRecord[]>(database.rows);
  const [total, setTotal] = useState(database.total);
  const [hasMore, setHasMore] = useState(database.hasMore);
  const [activeViewId, setActiveViewId] = useState<string | null>(database.views[0]?.id ?? null);
  const [propertyDialog, setPropertyDialog] = useState<PropertyDialogState>(null);
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  /** 从私信点进来时要定位（滚动 + 高亮）的备注 id */
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareViewId, setShareViewId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(database.name);
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * 当前访问者已经改过一次的格子（`记录 id:字段 id`）。
   * 只有分享时勾选了「限制编辑」的访问者才有内容（每格只能改一次，改过的格子只读）；
   * 表格所有者 / 表格成员 / 未勾选「限制编辑」的分享永远是空集合。
   */
  const [lockedCells, setLockedCells] = useState<ReadonlySet<string>>(
    () => new Set(database.lockedCells ?? []),
  );

  useEffect(() => {
    setDetail(database);
    setRows(database.rows);
    setTotal(database.total);
    setHasMore(database.hasMore);
    setLockedCells(new Set(database.lockedCells ?? []));
    setNameDraft(database.name);
    setActiveViewId((prev) =>
      prev && database.views.some((view) => view.id === prev) ? prev : database.views[0]?.id ?? null,
    );
  }, [database]);

  const { properties, views, members } = detail;
  const role: Role = detail.role;
  const canEdit = role === 'owner' || role === 'editor';
  const isOwner = role === 'owner';
  /** 表格锁定：字段与视图结构不可修改 */
  const structureLocked = detail.locked;
  /** 仅通过视图定向分享获得的访问权（只能看到被分享的视图） */
  const viewScoped = detail.viewScoped;
  const canEditStructure = canEdit && !structureLocked && !viewScoped;

  const users = useMemo<UserNames>(() => {
    // 行元数据（创建人 / 最后编辑人）里的用户可能只是被定向分享的访客，不在成员列表中
    const map: UserNames = { ...detail.people };
    for (const member of members) map[member.userId] = member.name || member.email;
    if (me) map[me.id] = me.name || me.email;
    return map;
  }, [detail.people, members, me]);

  const activeView: ViewDef | null = views.find((view) => view.id === activeViewId) ?? views[0] ?? null;
  /** 当前视图可改名 / 改配置 / 删除 */
  const viewEditable = canEditStructure && !!activeView && !activeView.locked;
  const filterCount = activeView?.config.filters?.conditions.length ?? 0;
  const shownProperties = activeView ? visibleProperties(properties, activeView.config) : properties;
  /** 筛选上下文：把「当前用户」解析为登录用户 */
  const filterContext = useMemo(() => ({ viewerId: me?.id ?? null }), [me]);
  const filtered = useMemo(
    () => (activeView ? applyView(properties, rows, activeView.config, filterContext) : rows),
    [properties, rows, activeView, filterContext],
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

  /** 把服务端返回的「已改过一次的格子」并进本地状态（只会增加，不会凭空移除） */
  const mergeLockedCells = useCallback((keys: string[] | undefined) => {
    if (!keys?.length) return;
    setLockedCells((prev) => {
      const next = new Set(prev);
      for (const key of keys) next.add(key);
      return next;
    });
  }, []);

  /** Re-fetch the first page (used after structural changes). */
  const reload = useCallback(async () => {
    try {
      const next = await api.getDatabase(detail.id, { limit: PAGE_SIZE });
      setDetail(next);
      setRows(next.rows);
      setTotal(next.total);
      setHasMore(next.hasMore);
      mergeLockedCells(next.lockedCells);
    } catch (cause) {
      fail(cause, '刷新失败');
    }
  }, [detail.id, fail, mergeLockedCells]);

  const replaceRow = useCallback((record: RowRecord) => {
    setRows((prev) => {
      const exists = prev.some((row) => row.id === record.id);
      const next = exists ? prev.map((row) => (row.id === record.id ? record : row)) : [...prev, record];
      return next.sort((a, b) => a.position - b.position);
    });
  }, []);

  /* --------------------------------------------------------------- notes */

  /** 备注里可以 @ 的人：表格成员去掉自己（自己不需要给自己发私信） */
  const mentionCandidates = useMemo(
    () => members.filter((member) => member.userId !== me?.id),
    [members, me],
  );

  /** 把服务端返回的备注并进本地状态（服务端返回的是按记录分组的完整备注列表） */
  const mergeNotes = useCallback((incoming: RecordNote[]) => {
    if (!incoming.length) return;
    setDetail((prev) => {
      const byRecord = new Map<string, RecordNote[]>();
      for (const note of incoming) {
        const list = byRecord.get(note.recordId) ?? [];
        list.push(note);
        byRecord.set(note.recordId, list);
      }
      return {
        ...prev,
        notes: [...prev.notes.filter((note) => !byRecord.has(note.recordId)), ...incoming],
      };
    });
  }, []);

  /** 添加备注（只能新增，不能修改 / 删除）；@ 到的人会收到私信 */
  const addNote = async (row: RowRecord, body: string, mentions: string[]) => {
    try {
      const result = await api.addNote(row.id, { body, mentions });
      mergeNotes(result.notes);
      const names = members.filter((member) => mentions.includes(member.userId)).map((member) => member.name);
      onToast(names.length ? `备注已添加，已提醒 ${names.join('、')}` : '备注已添加');
    } catch (cause) {
      fail(cause, '备注添加失败');
      // 抛回输入框：保留草稿并把错误显示在输入框旁边
      throw cause;
    }
  };

  /**
   * 收件箱私信：打开对应的记录卡片，并定位到那条备注。
   * 记录不一定在当前这一页（例如从别的表格点进来），那时先把表格整页拉回来。
   */
  useEffect(() => {
    if (!inboxTarget) return;
    const { recordId, noteId } = inboxTarget;
    const locate = () => {
      setOpenRowId(recordId);
      setFocusNoteId(noteId);
      onInboxTargetHandled();
    };
    if (rows.some((row) => row.id === recordId)) {
      locate();
      return;
    }

    let cancelled = false;
    api
      .getDatabase(detail.id, { limit: MAX_FETCH })
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setRows(next.rows);
        setTotal(next.total);
        setHasMore(next.hasMore);
        mergeLockedCells(next.lockedCells);
        if (next.rows.some((row) => row.id === recordId)) setOpenRowId(recordId);
        else onToast('这条私信对应的记录已被删除', 'error');
        setFocusNoteId(noteId);
        onInboxTargetHandled();
      })
      .catch((cause) => {
        if (cancelled) return;
        fail(cause, '打开私信对应的记录失败');
        onInboxTargetHandled();
      });
    return () => {
      cancelled = true;
    };
  }, [inboxTarget, rows, detail.id, fail, mergeLockedCells, onInboxTargetHandled, onToast]);


  /* ------------------------------------------------------------------- rows */

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const page = await api.rows(detail.id, { limit: PAGE_SIZE, offset: rows.length });
      setRows((prev) => [...prev, ...page.rows.filter((row) => !prev.some((item) => item.id === row.id))]);
      setTotal(page.total);
      setHasMore(page.hasMore);
      mergeLockedCells(page.lockedCells);
      mergeNotes(page.notes);
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
    if (property.locked) {
      onToast(`字段「${property.name}」已锁定，无法修改`, 'error');
      return;
    }
    const cellKey = cellLockKey(row.id, property.id);
    // 勾选了「限制编辑」的分享每格只有一次机会：已经改过的格子只读，这里再挡一次
    // （例如在另一个标签页里刚改过同一个格子）
    if (lockedCells.has(cellKey)) {
      onToast(cellLockHint(property.name), 'error');
      return;
    }
    // 值没变就不发请求，也不消耗那一次机会（与服务端的判断保持一致）
    if (sameCellValue(row.values[property.id], value)) return;
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
      // 只有勾选了「限制编辑」的访问者改过之后这个格子才锁上
      // （所有者 / 表格成员 / 未勾选的分享可以反复修改）
      if (detail.limitCellEdits) mergeLockedCells([cellKey]);
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
    if (property.locked) throw new Error(`字段「${property.name}」已锁定，无法上传文件`);
    // 文件字段属于这个格子的值：勾选了「限制编辑」时改过一次之后也不允许再上传
    // （服务端同样会拒绝）
    if (lockedCells.has(cellLockKey(row.id, property.id))) {
      throw new Error(cellLockHint(property.name));
    }
    const result = await api.uploadFile(file, {
      databaseId: detail.id,
      recordId: row.id,
      propertyId: property.id,
    });
    return result.file;
  };

  /* ------------------------------------------------------------------ views */

  const patchView = async (viewId: string, patch: { name?: string; config?: ViewConfig; locked?: boolean }) => {
    try {
      const result = await api.updateView(viewId, patch);
      setDetail((prev) => ({ ...prev, views: result.views }));
    } catch (cause) {
      fail(cause, '视图更新失败');
    }
  };

  const updateActiveConfig = (patch: Partial<ViewConfig>) => {
    if (!activeView || !viewEditable) return;
    void patchView(activeView.id, { config: { ...activeView.config, ...patch } });
  };

  /** 新建视图：自定义名称 + 筛选条件 + 锁定 + 可选定向分享。 */
  const createView = async (input: NewViewInput) => {
    if (!canEditStructure) return;
    try {
      const result = await api.createView(detail.id, {
        type: input.type,
        name: input.name || undefined,
        config: { ...defaultViewConfig(input.type), filters: input.filters },
        locked: input.locked,
      });
      setDetail((prev) => ({ ...prev, views: result.views }));
      setActiveViewId(result.viewId);

      if (input.share) {
        try {
          const shared = await api.createViewShare(detail.id, {
            viewId: result.viewId,
            email: input.share.email,
            role: input.share.role,
            limitEdits: input.share.limitEdits,
          });
          setDetail((prev) => ({ ...prev, viewShares: shared.viewShares }));
          onToast(
            input.share.limitEdits
              ? `视图已定向分享给 ${input.share.email}（限制编辑）`
              : `视图已定向分享给 ${input.share.email}`,
          );
        } catch (cause) {
          fail(cause, '视图分享失败');
        }
      }
      onReloadList();
    } catch (cause) {
      fail(cause, '新建视图失败');
    }
  };

  const renameView = (viewId: string, name: string) => {
    if (!viewEditable) return;
    void patchView(viewId, { name });
  };

  const lockView = (viewId: string, locked: boolean) => {
    if (!canEditStructure) return;
    void patchView(viewId, { locked });
  };

  const lockTable = async (locked: boolean) => {
    if (!isOwner) return;
    try {
      const next = await api.updateDatabase(detail.id, { locked });
      setDetail((prev) => ({ ...prev, locked: next.locked }));
      onToast(locked ? '表格已锁定，字段与视图不可修改' : '表格已解锁');
      onReloadList();
    } catch (cause) {
      fail(cause, locked ? '锁定表格失败' : '解锁表格失败');
    }
  };

  const deleteView = async (viewId: string) => {
    if (!viewEditable) return;
    try {
      const result = await api.deleteView(viewId);
      setDetail((prev) => ({ ...prev, views: result.views }));
      if (activeViewId === viewId) setActiveViewId(result.views[0]?.id ?? null);
    } catch (cause) {
      fail(cause, '删除视图失败');
    }
  };

  const addSortFor = (property: Property, direction: 'asc' | 'desc') => {
    if (!activeView || !viewEditable) return;
    const others = (activeView.config.sorts ?? []).filter((rule) => rule.propertyId !== property.id);
    updateActiveConfig({ sorts: [...others, { propertyId: property.id, direction }] });
  };

  const addFilterFor = (property: Property) => {
    if (!activeView || !viewEditable) return;
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
              // 人员类字段默认「当前用户」，加完就能看到自己创建的记录
              value: defaultFilterValueForType(property.type),
            },
          ],
        },
      },
    });
  };

  const hideProperty = (property: Property) => {
    if (!activeView || !viewEditable) return;
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

  /** ← / →（表头字段菜单）：与相邻的可见列交换 position，实现左右移动 */
  const moveProperty = async (property: Property, direction: 'left' | 'right') => {
    if (!canEditStructure) return;
    // 以「当前视图里能看到的列」为参照，隐藏列不参与移动
    const list = shownProperties.some((item) => item.id === property.id) ? shownProperties : properties;
    const index = list.findIndex((item) => item.id === property.id);
    const neighbour = index < 0 ? undefined : list[index + (direction === 'left' ? -1 : 1)];
    if (!neighbour) return;
    // position 是浮点索引，交换两列的值即可；两列 position 相同时给一个偏移
    const samePosition = property.position === neighbour.position;
    const nextPosition = neighbour.position + (samePosition ? (direction === 'left' ? -1 : 1) : 0);
    try {
      await api.updateProperty(property.id, { position: nextPosition });
      const result = await api.updateProperty(neighbour.id, { position: property.position });
      setDetail((prev) => ({ ...prev, properties: result.properties }));
    } catch (cause) {
      fail(cause, '调整列顺序失败');
      await reload();
    }
  };

  /** 🔒 锁定字段 / 🔓 解锁字段：锁定后该字段的所有记录只读 */
  const togglePropertyLock = async (property: Property, locked: boolean) => {
    if (!canEditStructure) return;
    try {
      const result = await api.updateProperty(property.id, { locked });
      setDetail((prev) => ({ ...prev, properties: result.properties }));
      onToast(
        locked ? `字段「${property.name}」已锁定，记录只能查看` : `字段「${property.name}」已解锁`,
      );
    } catch (cause) {
      fail(cause, locked ? '锁定字段失败' : '解锁字段失败');
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

  const applyViewShares = (next: ViewShare[]) => setDetail((prev) => ({ ...prev, viewShares: next }));

  /* ----------------------------------------------------------------- render */

  const boardGroupProperty = activeView?.config.groupBy
    ? properties.find((property) => property.id === activeView.config.groupBy) ?? null
    : null;

  return (
    <section className="workspace">
      {/* 定向分享的访客（viewScoped）只能看被分享的视图：隐藏「表格名称」这一整行顶部栏 */}
      {!viewScoped ? (
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
          {structureLocked ? (
            <span className="badge" title="表格结构已锁定">
              🔒 已锁定
            </span>
          ) : null}
          <span className="spacer" />
          <span className="small muted">{members.length} 位成员 · {total} 条记录</span>
          {isOwner ? (
            <button type="button" className="btn ghost small danger" onClick={() => void deleteDatabase()}>
              删除表格
            </button>
          ) : null}
        </header>
      ) : null}

      {activeView ? (
        <ViewBar
          views={views}
          active={activeView}
          properties={properties}
          users={users}
          canEdit={viewEditable}
          canUnlock={canEditStructure}
          canManage={isOwner && !viewScoped}
          structureLocked={structureLocked}
          total={total}
          rowCount={filtered.length}
          onSelectView={(id) => setActiveViewId(id)}
          onCreateView={(input) => void createView(input)}
          onRenameView={renameView}
          onDeleteView={(id) => void deleteView(id)}
          onUpdateConfig={updateActiveConfig}
          onLockView={lockView}
          onLockTable={(locked) => void lockTable(locked)}
          onShareView={(id) => {
            setShareViewId(id);
            setShareOpen(true);
          }}
        />
      ) : null}

      <div className="view-body">
        {/* 定向分享的访客（viewScoped）看不到「＋ 新建筛选」这一整行 */}
        {activeView && !viewScoped ? (
          <div className="view-toolbar">
            <Popover
              label="＋ 新建筛选"
              title={viewEditable ? '为该视图添加筛选条件（可多条件组合）' : '当前视图不可修改筛选条件'}
              variant="primary"
              wide
              align="left"
              disabled={!viewEditable}
            >
              {() => (
                <FilterPanel
                  properties={properties}
                  users={users}
                  filters={activeView.config.filters}
                  canEdit={viewEditable}
                  onChange={(next) => updateActiveConfig({ filters: next })}
                />
              )}
            </Popover>
            {filterCount ? (
              <span className="small muted">
                {`${activeView.config.filters?.conjunction === 'or' ? '任意满足' : '全部满足'} ${filterCount} 个条件 · 命中 ${filtered.length} 条`}
              </span>
            ) : (
              <span className="small muted">为「{activeView.name}」添加多个筛选条件，支持「全部满足 / 任意满足」</span>
            )}
          </div>
        ) : null}
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
            canEditStructure={canEditStructure}
            canEditView={viewEditable}
            selectable={!viewScoped}
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
            onMoveProperty={(property, direction) => void moveProperty(property, direction)}
            onTogglePropertyLock={(property, locked) => void togglePropertyLock(property, locked)}
            onResizeProperty={(property, width) => void resizeProperty(property, width)}
            onSortProperty={addSortFor}
            onFilterProperty={addFilterFor}
            lockedCells={lockedCells}
            onOpenRecord={(row) => setOpenRowId(row.id)}
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
          notes={detail.notes.filter((note) => note.recordId === openRow.id)}
          mentionCandidates={mentionCandidates}
          focusNoteId={focusNoteId}
          onClose={() => {
            setOpenRowId(null);
            setFocusNoteId(null);
          }}
          onCommitCell={(property, value) => void commitCell(openRow, property, value)}
          uploadFile={(property, file) => uploadFile(openRow, property, file)}
          onAddNote={(body, mentions) => addNote(openRow, body, mentions)}
          lockedCells={lockedCells}
        />
      ) : null}

      {shareOpen ? (
        <SharePanel
          database={detail}
          canManage={isOwner && !viewScoped}
          focusViewId={shareViewId}
          onClose={() => {
            setShareOpen(false);
            setShareViewId(null);
          }}
          onToast={onToast}
          onViewShares={applyViewShares}
        />
      ) : null}
    </section>
  );
}

