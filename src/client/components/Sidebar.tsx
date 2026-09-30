import { useState } from 'react';
import type { DatabaseSummary, InboxMessage, SessionUser } from '../../shared/types';
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
  /** 窄屏时用 ✕ 收起抽屉，而不是桌面端的 « */
  narrow: boolean;
  onSelect: (id: string) => void;
  onCreate: (input: { name: string }) => Promise<void>;
  /** 收起侧边栏（手机端会同时移除遮罩层） */
  onClose: () => void;
  onLogout: () => void;
  /** 展开收件箱前刷新一次 */
  onInboxRefresh: () => void;
  /** 点开一条私信：已读 + 打开记录卡片并定位到那条备注 */
  onInboxSelect: (message: InboxMessage) => void;
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
  onInboxRefresh,
  onInboxSelect,
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
          className="icon-btn"
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

      <div className="sidebar-foot">
        <div className="row gap">
          <UserChip user={user} onLogout={onLogout} />
        </div>
      </div>
    </aside>
  );
}
