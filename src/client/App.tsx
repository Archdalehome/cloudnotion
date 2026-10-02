/**
 * Client entry: session bootstrap, workspace shell (collapsible sidebar +
 * database page) and the public share route (`/share/:token`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DatabaseDetail, DatabaseSummary, InboxMessage, InboxResponse, SessionUser } from '../shared/types';
import { ApiError, api, type SessionPayload } from './api';
import { AdminPanel } from './components/AdminPanel';
import { AuthPage } from './components/AuthPage';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import { DatabasePage } from './components/DatabasePage';
import { InboxButton } from './components/InboxButton';
import { InvitePage } from './components/InvitePage';
import { PublicPage } from './components/PublicPage';
import { Sidebar } from './components/Sidebar';
import { UserChip } from './components/UserChip';

interface ToastItem {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

/** 私信（@提醒）的轮询间隔：改备注的人不少，60 秒足够及时又不费流量 */
const INBOX_POLL_MS = 60_000;
const EMPTY_INBOX: InboxResponse = { messages: [], unread: 0 };

/** 点开私信后要打开的位置：某张表格的某条记录里的某条备注 */
interface InboxTarget {
  databaseId: string;
  recordId: string;
  noteId: string;
}

/** 侧边栏展开状态在本地记住（下次打开保持上次的选择） */
const SIDEBAR_KEY = 'qafield.sidebar-open';
/** 窄屏断点，必须与 styles.css 里的媒体查询保持一致 */
const NARROW_QUERY = '(max-width: 900px)';

function isNarrowViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

/**
 * 侧边栏初始状态：手机 / 平板上默认收起（抽屉会盖住表格），宽屏默认展开，
 * 除非用户上次手动收起过。
 */
function initialSidebarOpen(): boolean {
  if (isNarrowViewport()) return false;
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) !== 'false';
  } catch {
    // 隐私模式下 localStorage 不可用，退化为默认展开
    return true;
  }
}

/** `/share/<token>` is served by the SPA fallback, everything else is the app. */
function shareTokenFromPath(): string | null {
  const match = /^\/share\/([^/]+)\/?$/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/** `/invite/<token>`：视图分享邀请链接，受邀人在这里填昵称 + 密码完成注册。 */
function inviteTokenFromPath(): string | null {
  const match = /^\/invite\/([^/]+)\/?$/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function summaryOf(detail: DatabaseDetail): DatabaseSummary {
  return {
    id: detail.id,
    name: detail.name,
    icon: detail.icon,
    description: detail.description,
    ownerId: detail.ownerId,
    role: detail.role,
    locked: detail.locked,
    viewScoped: detail.viewScoped,
    sharedViewNames: detail.viewScoped ? detail.views.map((view) => view.name) : [],
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    rowCount: detail.total,
  };
}

export function App() {
  const shareToken = useMemo(shareTokenFromPath, []);
  const inviteToken = useMemo(inviteTokenFromPath, []);
  const [booting, setBooting] = useState(!shareToken && !inviteToken);
  const [appName, setAppName] = useState('Qafield');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [databases, setDatabases] = useState<DatabaseSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DatabaseDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const [narrow, setNarrow] = useState(isNarrowViewport);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  /** 收件箱：别人在备注里 @ 我的未读私信（红点里的数字就是 messages 的条数） */
  const [inbox, setInbox] = useState<InboxResponse>(EMPTY_INBOX);
  /** 点开私信后要打开的记录 / 备注；由 DatabasePage 消费后清空 */
  const [inboxTarget, setInboxTarget] = useState<InboxTarget | null>(null);
  /** 主区域是否停在「用户管理」页（只有管理员进得去，服务端另有校验） */
  const [adminView, setAdminView] = useState(false);
  /** 「修改密码」弹窗 */
  const [changingPassword, setChangingPassword] = useState(false);
  /** 邀请页已经处理完（注册成功 / 点了「去登录」）：回到正常的登录或工作区 */
  const [inviteDone, setInviteDone] = useState(false);

  const toast = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, kind }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((item) => item.id !== id)), 3200);
  }, []);

  /* ------------------------------------------------- 侧边栏展开 / 收起控制 */

  const setSidebar = useCallback((next: boolean) => {
    setSidebarOpen(next);
    try {
      window.localStorage.setItem(SIDEBAR_KEY, String(next));
    } catch {
      // 隐私模式下存不下也没关系，本次会话内依然生效
    }
  }, []);

  const narrowRef = useRef(isNarrowViewport());

  useEffect(() => {
    const sync = () => {
      const next = isNarrowViewport();
      const changed = narrowRef.current !== next;
      narrowRef.current = next;
      setNarrow(next);
      // 宽窄屏切换时给出合理默认：手机收起抽屉，切回宽屏重新展开
      if (changed) setSidebarOpen(!next);
    };
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
    };
  }, []);

  /* ----------------------------------------------------------- 会话与数据 */

  /**
   * 拉取会话（用户 + 表格列表）并自动打开第一张表格。
   * 登录成功后同样会走这里：手机上不必再手动展开侧边栏才有内容。
   */
  const bootstrapSession = useCallback(async (): Promise<SessionPayload | null> => {
    try {
      const payload = await api.session();
      setAppName(payload.appName);
      setUser(payload.user);
      setDatabases(payload.databases);
      if (payload.user && payload.databases.length) {
        setActiveId((prev) =>
          prev && payload.databases.some((item) => item.id === prev) ? prev : payload.databases[0].id,
        );
      }
      return payload;
    } catch {
      setUser(null);
      setDatabases([]);
      return null;
    }
  }, []);

  useEffect(() => {
    // 公开分享页 / 邀请页自己取数据，不需要会话与表格列表
    if (shareToken || inviteToken) return;
    let cancelled = false;
    setBooting(true);
    void bootstrapSession().finally(() => {
      if (!cancelled) setBooting(false);
    });
    return () => {
      cancelled = true;
    };
  }, [shareToken, inviteToken, bootstrapSession]);

  /** 不是管理员（或退出登录）时，把主区域从「用户管理」收回来 */
  useEffect(() => {
    if (!user?.isAdmin) setAdminView(false);
  }, [user]);

  useEffect(() => {
    if (!activeId) {
      setDetail(null);
      setDetailError('');
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError('');
    api
      .getDatabase(activeId, { limit: 100 })
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((cause) => {
        if (cancelled) return;
        setDetail(null);
        const expired = cause instanceof ApiError && cause.status === 401;
        const message = expired
          ? '登录状态已失效，请重新登录'
          : cause instanceof ApiError
            ? cause.message
            : '加载表格失败，请检查网络后重试';
        setDetailError(message);
        if (expired) setUser(null);
        toast(message, 'error');
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, toast, detailReloadKey]);

  /* ------------------------------------------------------------- 收件箱 */

  const refreshInbox = useCallback(async () => {
    if (!user) return;
    try {
      setInbox(await api.inbox());
    } catch {
      // 未登录 / 网络抖动时保持现状，下一轮轮询会再试
    }
  }, [user]);

  // 登录后立刻拉一次，之后轮询；切回标签页时也顺手刷新一次
  useEffect(() => {
    if (!user) {
      setInbox(EMPTY_INBOX);
      return;
    }
    void refreshInbox();
    const timer = window.setInterval(() => void refreshInbox(), INBOX_POLL_MS);
    const onFocus = () => void refreshInbox();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [user, refreshInbox]);

  /**
   * 点开一条私信：本地先把红点数字 -1（服务端同时标记已读），
   * 再打开这条私信对应的记录卡片，并定位到那条备注。
   */
  const openInboxMessage = useCallback(
    async (message: InboxMessage) => {
      setInbox((prev) => ({
        unread: Math.max(0, prev.unread - 1),
        messages: prev.messages.filter((item) => item.id !== message.id),
      }));
      try {
        const result = await api.readInboxMessage(message.id);
        setInbox((prev) => ({ ...prev, unread: result.unread }));
      } catch {
        // 标记已读失败也照样打开（下一轮轮询会把未读数同步回来）
      }
      setInboxTarget({ databaseId: message.databaseId, recordId: message.recordId, noteId: message.noteId });
      setActiveId(message.databaseId);
      // 手机上先收起抽屉，露出刚打开的记录卡片
      if (narrow) setSidebar(false);
    },
    [narrow, setSidebar],
  );

  const clearInboxTarget = useCallback(() => setInboxTarget(null), []);

  const refreshList = useCallback(async () => {
    try {
      const result = await api.listDatabases();
      setDatabases(result.databases);
    } catch {
      // the list refresh is best effort only
    }
  }, []);

  const createDatabase = useCallback(
    /** 新建表格固定走「空白表格」模板（不传 templateId 时后端就是 blank），不再让用户挑选模板 */
    async ({ name }: { name: string }) => {
      const created = await api.createDatabase({ name });
      setDatabases((prev) => [summaryOf(created), ...prev.filter((item) => item.id !== created.id)]);
      setDetail(created);
      setActiveId(created.id);
      if (narrow) setSidebarOpen(false);
      toast(`已创建「${created.name}」`);
    },
    [narrow, toast],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // ignore: the local session is cleared either way
    }
    setUser(null);
    setDatabases([]);
    setActiveId(null);
    setDetail(null);
    setDetailError('');
    setInbox(EMPTY_INBOX);
    setInboxTarget(null);
    setAdminView(false);
    setChangingPassword(false);
  }, []);

  const reauthenticate = useCallback(
    (next: SessionUser) => {
      setUser(next);
      // 重新拉一次会话：拿到表格列表并自动打开第一张（手机端不必再手动展开侧边栏）
      setDetailError('');
      setDetailReloadKey((value) => value + 1);
      void bootstrapSession().then((payload) => {
        if (!payload?.user) {
          toast('登录状态未能保存：请检查浏览器是否允许使用 Cookie（无痕模式或「阻止所有 Cookie」会导致无法登录）', 'error');
        }
      });
    },
    [bootstrapSession, toast],
  );


  // 受邀人通过邮件里的 /invite/<token> 打开：填昵称 + 密码完成注册后直接进工作区
  if (inviteToken && !inviteDone && !user) {
    return (
      <InvitePage
        token={inviteToken}
        onAuthenticated={(next) => {
          setInviteDone(true);
          reauthenticate(next);
        }}
        onGoToLogin={() => setInviteDone(true)}
      />
    );
  }

  if (shareToken) return <PublicPage token={shareToken} />;

  if (booting) {
    return (
      <div className="centered">
        <p className="muted">正在载入 {appName}…</p>
      </div>
    );
  }

  if (!user) return <AuthPage appName={appName} onAuthenticated={reauthenticate} />;

  return (
    <div className={`app-shell${sidebarOpen ? '' : ' sidebar-collapsed'}${narrow ? ' narrow' : ''}`}>
      <Sidebar
        appName={appName}
        user={user}
        databases={databases}
        activeId={activeId}
        inbox={inbox.messages}
        inboxUnread={inbox.unread}
        open={sidebarOpen}
        narrow={narrow}
        onSelect={(id) => {
          setActiveId(id);
          // 从「用户管理」切回表格
          setAdminView(false);
          // 手机上选完表格就收起抽屉，把屏幕还给表格
          if (narrow) setSidebarOpen(false);
        }}
        onCreate={createDatabase}
        onClose={() => setSidebar(false)}
        onLogout={() => void logout()}
        onChangePassword={() => setChangingPassword(true)}
        adminView={adminView}
        onOpenAdmin={() => {
          setAdminView(true);
          // 手机上点完就收起抽屉，把屏幕让给用户列表
          if (narrow) setSidebarOpen(false);
        }}
        onInboxRefresh={() => void refreshInbox()}
        onInboxSelect={(message) => void openInboxMessage(message)}
      />

      {narrow && sidebarOpen ? (
        <div className="sidebar-backdrop" role="presentation" onClick={() => setSidebar(false)} />
      ) : null}

      <main className="main">
        {narrow || !sidebarOpen ? (
          <div className="app-bar">
            <button
              type="button"
              className="icon-btn sidebar-toggle"
              title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
              aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
              aria-expanded={sidebarOpen}
              onClick={() => setSidebar(!sidebarOpen)}
            >
              {sidebarOpen ? '«' : '☰'}
            </button>
            <span className="brand">{appName}</span>
            {/* 侧边栏收起时，收件箱标志挪到顶部条（看不到侧边栏左上角的那个） */}
            {!sidebarOpen ? (
              <InboxButton
                messages={inbox.messages}
                unread={inbox.unread}
                onRefresh={() => void refreshInbox()}
                onSelect={(message) => void openInboxMessage(message)}
              />
            ) : null}
            {narrow && detail ? <span className="muted small db-hint">{detail.name}</span> : null}
            <span className="spacer" />
            {/* 侧边栏收起时看不到侧边栏里的「用户管理」入口，这里补一个 */}
            {!sidebarOpen && user.isAdmin ? (
              <button
                type="button"
                className="icon-btn"
                title="用户管理"
                aria-label="用户管理"
                onClick={() => setAdminView((prev) => !prev)}
              >
                ⚙️
              </button>
            ) : null}
            {/* 侧边栏收起时侧边栏底部看不见了，把「用户名 · 邮箱 · 改密码 · 退出」挪到右上角 */}
            {!sidebarOpen ? (
              <div className="row gap app-bar-user">
                <UserChip
                  user={user}
                  onLogout={() => void logout()}
                  onChangePassword={() => setChangingPassword(true)}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {adminView ? (
          <AdminPanel me={user} onToast={toast} onReloadSession={() => void bootstrapSession()} />
        ) : detail ? (
          <DatabasePage
            key={detail.id}
            database={detail}
            me={user}
            onToast={toast}
            onReloadList={() => void refreshList()}
            inboxTarget={
              inboxTarget && inboxTarget.databaseId === detail.id
                ? { recordId: inboxTarget.recordId, noteId: inboxTarget.noteId }
                : null
            }
            onInboxTargetHandled={clearInboxTarget}
            onClose={() => {
              setActiveId(null);
              setDetail(null);
            }}
          />
        ) : detailLoading ? (
          <div className="centered">
            <p className="muted">正在载入表格…</p>
          </div>
        ) : detailError ? (
          <div className="centered">
            <div className="empty-state">
              <h2>无法加载表格</h2>
              <p className="error">{detailError}</p>
              <div className="empty-actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => setDetailReloadKey((value) => value + 1)}
                >
                  重试
                </button>
                {!sidebarOpen ? (
                  <button type="button" className="btn" onClick={() => setSidebar(true)}>
                    打开表格列表
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="centered">
            <div className="empty-state">
              <h2>{appName}</h2>
              <p className="muted">从左侧选择一个表格，或点击 ＋ 新建一个。</p>
              {!sidebarOpen ? (
                <div className="empty-actions">
                  <button type="button" className="btn" onClick={() => setSidebar(true)}>
                    打开表格列表
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </main>

      {changingPassword ? (
        <ChangePasswordDialog onClose={() => setChangingPassword(false)} onToast={toast} />
      ) : null}

      {toasts.length ? (
        <div className="toasts">
          {toasts.map((item) => (
            <div key={item.id} className={`toast ${item.kind}`}>
              {item.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
