import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  capacityBlockedHint,
  capacityRecordsSide,
  capacityRecordsUsageText,
  capacityStorageSide,
  capacityStorageUsageText,
  capacityTooltip,
  capacityUsageSummary,
} from '../../shared/capacity';
import type { DatabaseCapacity, DatabaseSummary, InboxMessage, SessionUser } from '../../shared/types';
import { ApiError } from '../api';
import { InboxButton } from './InboxButton';
import { UserChip } from './UserChip';

interface SidebarProps {
  appName: string;
  user: SessionUser | null;
  databases: DatabaseSummary[];
  activeId: string | null;
  /** 未读私信（收件箱左上角图标 + 红点数字） */
  inbox: InboxMessage[];
  inboxUnread: number;
  /** 是否展开（手机上是一个抽屉浮层） */
  open: boolean;
  /** 窄屏时用 ✕ 收起抽屉，而不是桌面端的 «（按钮样式见 styles.css 的 .collapse-btn） */
  narrow: boolean;
  onSelect: (id: string) => void;
  onCreate: (input: { name: string }) => Promise<void>;
  /** 收起侧边栏（手机端会同时移除遮罩层） */
  onClose: () => void;
  onLogout: () => void;
  /** 打开「修改密码」弹窗 */
  onChangePassword: () => void;
  /** 当前主区域是不是「用户管理」（管理员才有） */
  adminView: boolean;
  /** 打开用户管理（仅 `user.isAdmin` 时入口可见） */
  onOpenAdmin: () => void;
  /** 展开收件箱前刷新一次 */
  onInboxRefresh: () => void;
  /** 点开一条私信：已读 + 打开记录卡片并定位到那条备注 */
  onInboxSelect: (message: InboxMessage) => void;
  /** 轻提示（目前只有容量浮层里的「扩容」按钮用） */
  onToast: (message: string, kind?: 'info' | 'error') => void;
}

/** 容量浮层的宽度（与侧边栏同宽；窄屏按视口夹取，不会横向溢出） */
const CAPACITY_PANEL_WIDTH = 248;
/** 浮层离容量条 / 视口边缘的距离 */
const CAPACITY_PANEL_GAP = 8;
const CAPACITY_PANEL_MARGIN = 8;

/** 把坐标夹进 [min, max]；max 比 min 还小时以 min 为准（窄屏也不会算出负值） */
function clampToViewport(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 容量明细浮层：记录 / 附件各自的「已用 / 上限 / 剩余」+ 剩余条，右下角一个「扩容」按钮
 * （按钮还没接功能，点了只提示一句「开发中」）。
 *
 * 用 `createPortal` 挂到 body 上，两个原因：
 *   1. 侧边栏列表是滚动容器（`overflow: auto`），浮层放在行内会被裁掉；
 *   2. 手机上侧边栏抽屉是用 `transform` 滑入的，祖先带 transform 时里面的
 *      `position: fixed` 会改成相对抽屉定位 —— 只有挂在 body 上两处才都准。
 */
function CapacityPanel({
  name,
  capacity,
  anchor,
  onClose,
  onUpgrade,
}: {
  /** 表格名（浮层标题用） */
  name: string;
  capacity: DatabaseCapacity;
  /** 锚点：容量条本身，浮层按它的实时位置摆放 */
  anchor: HTMLElement;
  onClose: () => void;
  onUpgrade: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // 贴在容量条右侧、纵向对齐，再整体夹进视口；滚动或改窗口大小时跟着重算
  useLayoutEffect(() => {
    const place = () => {
      const box = panel.current;
      // 这一行被重新渲染没了（表格被删 / 列表刷新）：把浮层收起来，别悬在半空
      if (!box || !document.body.contains(anchor)) {
        onClose();
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const left = clampToViewport(
        rect.right + CAPACITY_PANEL_GAP,
        CAPACITY_PANEL_MARGIN,
        window.innerWidth - box.offsetWidth - CAPACITY_PANEL_MARGIN,
      );
      const top = clampToViewport(
        rect.top + rect.height / 2 - box.offsetHeight / 2,
        CAPACITY_PANEL_MARGIN,
        window.innerHeight - box.offsetHeight - CAPACITY_PANEL_MARGIN,
      );
      setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, onClose]);

  // 点浮层外面 / 按 Esc 收起（点容量条本身不算「外面」，开合交给容量条的点击处理）
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  const records = capacityRecordsSide(capacity);
  const storage = capacityStorageSide(capacity);
  return createPortal(
    <div
      ref={panel}
      className="capacity-pop"
      role="dialog"
      aria-label={`「${name}」容量使用情况`}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width: CAPACITY_PANEL_WIDTH,
        // 量完位置再显示，避免先闪一下再跳到锚点旁边
        visibility: pos ? 'visible' : 'hidden',
      }}
      /* 浮层虽然在 body 上，React 事件仍按组件树冒泡：不拦一下会连带选中这一行表格 */
      onClick={(event) => event.stopPropagation()}
    >
      <div className="capacity-pop-title">
        <span className="capacity-pop-name" title={name}>
          {name}
        </span>
        {capacity.atCapacity ? <span className="capacity-full-tag">已满</span> : null}
      </div>

      <div className="capacity-pop-item">
        <div className="capacity-pop-head">
          <span className="capacity-pop-label">记录</span>
          <span className="capacity-pop-value">{capacityRecordsUsageText(capacity)}</span>
        </div>
        <span className="capacity-pop-bar">
          <span className={`capacity-pop-fill ${records.level}`} style={{ width: `${records.remainingRatio * 100}%` }} />
        </span>
      </div>

      <div className="capacity-pop-item">
        <div className="capacity-pop-head">
          <span className="capacity-pop-label">附件</span>
          <span className="capacity-pop-value">{capacityStorageUsageText(capacity)}</span>
        </div>
        <span className="capacity-pop-bar">
          <span className={`capacity-pop-fill ${storage.level}`} style={{ width: `${storage.remainingRatio * 100}%` }} />
        </span>
      </div>

      <p className={`capacity-pop-note${capacity.atCapacity ? ' danger' : ''}`}>
        {capacity.atCapacity
          ? capacityBlockedHint(capacity)
          : '到上限后只能查看和查询：新增记录、复制记录与上传附件都会停用，删掉一些数据就能恢复'}
      </p>

      <div className="capacity-pop-foot">
        <span className="capacity-pop-note">不够用？</span>
        <span className="spacer" />
        <button type="button" className="btn primary small" title="扩容功能开发中，敬请期待" onClick={onUpgrade}>
          扩容
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 侧边栏里每张表的「剩余容量」双条：中间一道 0 刻度，左边是记录、右边是附件。
 *
 * 刻度画的是「还剩多少」：表里没数据时两条都是满的，记录 / 附件越用越多，
 * 两侧的剩余条就越短（用光就只剩中间那个 0）。某一侧剩余不足 20% 转深黄、
 * 用光转深红；整表（任一维度）到上限时行尾再挂一个「已满」标签。
 * 点一下弹出容量明细（见 `CapacityPanel`），悬停仍是 `title` 里的一行提示。
 * 这里只负责显示，拦增长由服务端（403 `capacity_exceeded`）和表格页负责。
 */
function CapacityMeter({
  name,
  capacity,
  onToast,
}: {
  name: string;
  capacity?: DatabaseCapacity;
  onToast: (message: string, kind?: 'info' | 'error') => void;
}) {
  // 浮层锚点：存元素本身，滚动时按它的实时位置重算（hook 得放在下面的提前 return 之前）
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  // 老标签页里可能是升级前拉到的旧会话数据（没有 capacity 字段），别让它把侧边栏搞崩
  if (!capacity) return null;
  const records = capacityRecordsSide(capacity);
  const storage = capacityStorageSide(capacity);

  /** 点 / 回车容量条：展开明细，再点一次收起（拦掉冒泡，别顺带切换表格） */
  const toggle = (event: React.SyntheticEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setAnchor(anchor ? null : event.currentTarget);
  };

  return (
    <>
      <span
        className={`capacity-meter${anchor ? ' open' : ''}`}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        aria-label={`容量：${capacityUsageSummary(capacity)}，点开查看明细`}
        title={capacityTooltip(capacity)}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') toggle(event);
        }}
      >
        {/* 左：记录剩余；右：附件剩余。两条都从中间的 0 往外算，剩余越少条越短 */}
        <span className={`capacity-side left ${records.level}`} aria-hidden="true">
          <span className="capacity-side-fill" style={{ width: `${records.remainingRatio * 100}%` }} />
        </span>
        <span className="capacity-zero" aria-hidden="true">
          0
        </span>
        <span className={`capacity-side right ${storage.level}`} aria-hidden="true">
          <span className="capacity-side-fill" style={{ width: `${storage.remainingRatio * 100}%` }} />
        </span>
      </span>
      {capacity.atCapacity ? <span className="capacity-full-tag">已满</span> : null}
      {anchor ? (
        <CapacityPanel
          name={name}
          capacity={capacity}
          anchor={anchor}
          onClose={close}
          onUpgrade={() => onToast('扩容功能还在开发中，敬请期待')}
        />
      ) : null}
    </>
  );
}

export function Sidebar({
  appName,
  user,
  databases,
  activeId,
  inbox,
  inboxUnread,
  open,
  narrow,
  onSelect,
  onCreate,
  onClose,
  onLogout,
  onChangePassword,
  adminView,
  onOpenAdmin,
  onInboxRefresh,
  onInboxSelect,
  onToast,
}: SidebarProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 只通过视图定向分享拿到的表格：只出现在「分享表格」里，不再混进「我的表格」 */
  const sharedDatabases = databases.filter((database) => database.viewScoped);
  const myDatabases = databases.filter((database) => !database.viewScoped);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await onCreate({ name: name.trim() });
      setName('');
      setCreating(false);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      className={`sidebar${open ? ' open' : ''}`}
      aria-hidden={!open}
      /* 收起时侧边栏滑出屏外，禁止键盘 Tab 聚焦到看不见的按钮 */
      inert={open ? undefined : true}
    >
      <div className="sidebar-head">
        <span className="brand">{appName}</span>
        {/* 左上角的收件箱：红点里的数字是未读私信条数 */}
        <InboxButton
          messages={inbox}
          unread={inboxUnread}
          onRefresh={onInboxRefresh}
          onSelect={onInboxSelect}
        />
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn collapse-btn"
          title="收起侧边栏"
          aria-label="收起侧边栏"
          onClick={onClose}
        >
          {narrow ? '✕' : '«'}
        </button>
      </div>

      <div className="sidebar-section">
        <div className="row">
          <span>我的表格</span>
          <span className="spacer" />
          <span className="small muted">{myDatabases.length ? myDatabases.length : ''}</span>
          <button type="button" className="icon-btn" title="新建表格" onClick={() => setCreating((prev) => !prev)}>
            ＋
          </button>
        </div>
      </div>

      {/* 新建表格固定落成空白表格（只有「名称」字段），不再让用户挑模板 */}
      {creating ? (
        <form onSubmit={submit} style={{ padding: '0 12px 8px' }}>
          <label className="field">
            <span>表格名称</span>
            <input
              className="input"
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：项目排期"
            />
          </label>
          {error ? <p className="error small">{error}</p> : null}
          <div className="row gap">
            <button className="btn primary small" type="submit" disabled={busy || !name.trim()}>
              {busy ? '创建中…' : '创建'}
            </button>
            <button className="btn ghost small" type="button" onClick={() => setCreating(false)}>
              取消
            </button>
          </div>
        </form>
      ) : null}

      <div className="sidebar-list">
        {myDatabases.length ? (
          myDatabases.map((database) => (
            <button
              key={database.id}
              type="button"
              className={`sidebar-item${database.id === activeId ? ' active' : ''}`}
              onClick={() => onSelect(database.id)}
              title={database.name}
            >
              <span>{database.icon || '📋'}</span>
              <span className="label">{database.name}</span>
              {/* 容量条：左边记录、右边附件，剩余快用完时变黄 / 变红；点开是明细浮层 */}
              <CapacityMeter name={database.name} capacity={database.capacity} onToast={onToast} />
              {database.locked ? (
                <span className="small muted" title="结构已锁定">
                  🔒
                </span>
              ) : null}
              {database.role !== 'owner' ? (
                <span className="small muted">{database.role === 'editor' ? '协作' : '只读'}</span>
              ) : null}
            </button>
          ))
        ) : (
          <p className="small muted" style={{ padding: '0 12px' }}>
            还没有表格，点击右上角 ＋ 新建。
          </p>
        )}
      </div>

      <div className="sidebar-section">
        <div className="row">
          <span>分享表格</span>
          <span className="spacer" />
          <span className="small muted">{sharedDatabases.length ? sharedDatabases.length : ''}</span>
        </div>
      </div>

      <div className="sidebar-list shared">
        {sharedDatabases.length ? (
          sharedDatabases.map((database) => (
            <button
              key={`shared-${database.id}`}
              type="button"
              className={`sidebar-item${database.id === activeId ? ' active' : ''}`}
              onClick={() => onSelect(database.id)}
              title={
                database.sharedViewNames.length
                  ? `分享视图：${database.sharedViewNames.join('、')}`
                  : database.name
              }
            >
              <span>🔗</span>
              <span className="label">{database.name}</span>
            </button>
          ))
        ) : (
          <p className="small muted" style={{ padding: '0 12px' }}>
            暂无他人分享给你的视图。
          </p>
        )}
      </div>

      {user?.isAdmin ? (
        <>
          <div className="sidebar-section">
            <div className="row">
              <span>管理</span>
            </div>
          </div>
          <div className="sidebar-list">
            <button
              type="button"
              className={`sidebar-item${adminView ? ' active' : ''}`}
              title="用户管理"
              onClick={onOpenAdmin}
            >
              <span>⚙️</span>
              <span className="label">用户管理</span>
            </button>
          </div>
        </>
      ) : null}

      <div className="sidebar-foot">
        <div className="row gap">
          <UserChip user={user} onLogout={onLogout} onChangePassword={onChangePassword} />
        </div>
      </div>
    </aside>
  );
}
