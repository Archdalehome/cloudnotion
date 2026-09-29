/**
 * Client entry: session bootstrap, workspace shell (collapsible sidebar +
 * database page) and the public share route (`/share/:token`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DatabaseDetail, DatabaseSummary, SessionUser } from '../shared/types';
import { ApiError, api, type SessionPayload } from './api';
import { AuthPage } from './components/AuthPage';
import { DatabasePage } from './components/DatabasePage';
import { PublicPage } from './components/PublicPage';
import { Sidebar } from './components/Sidebar';

interface ToastItem {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

/** 侧边栏展开状态在本地记住（下次打开保持上次的选择） */
const SIDEBAR_KEY = 'cloudnotion.sidebar-open';
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

function summaryOf(detail: DatabaseDetail): DatabaseSummary {
  return {
    id: detail.id,
    name: detail.name,
    icon: detail.icon,
    description: detail.description,
    ownerId: detail.ownerId,
    role: detail.role,
    locked: detail.locked,
    sharedViewNames: detail.viewScoped ? detail.views.map((view) => view.name) : [],
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    rowCount: detail.total,
  };
}

export function App() {
  const shareToken = useMemo(shareTokenFromPath, []);
  const [booting, setBooting] = useState(!shareToken);
  const [appName, setAppName] = useState('CloudNotion');
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
    if (shareToken) return;
    let cancelled = false;
    setBooting(true);
    void bootstrapSession().finally(() => {
      if (!cancelled) setBooting(false);
    });
    return () => {
      cancelled = true;
    };
  }, [shareToken, bootstrapSession]);

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


  const refreshList = useCallback(async () => {
    try {
      const result = await api.listDatabases();
      setDatabases(result.databases);
    } catch {
      // the list refresh is best effort only
    }
  }, []);

  const createDatabase = useCallback(
    async ({ name, templateId }: { name: string; templateId: string }) => {
      const created = await api.createDatabase({ name, templateId });
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
  }, []);

  const reauthenticate = useCallback(
    (next: SessionUser) => {
      setUser(next);
      // 重新拉一次会话：拿到表格列表并自动打开第一张（手机端不必再手动展开侧边栏）
      setDetailError('');
      setDetailReloadKey((value) => value + 1);
      void bootstrapSession().then((payload) => {
        if (!payload?.user) {
          toast('登录状态未能保存：请允许浏览器使用 Cookie，并使用 https 地址访问后重试', 'error');
        }
      });
    },
    [bootstrapSession, toast],
  );


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
        open={sidebarOpen}
        narrow={narrow}
        onSelect={(id) => {
          setActiveId(id);
          // 手机上选完表格就收起抽屉，把屏幕还给表格
          if (narrow) setSidebarOpen(false);
        }}
        onCreate={createDatabase}
        onClose={() => setSidebar(false)}
        onLogout={() => void logout()}
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
            {narrow && detail ? <span className="muted small db-hint">{detail.name}</span> : null}
          </div>
        ) : null}

        {detail ? (
          <DatabasePage
            key={detail.id}
            database={detail}
            me={user}
            onToast={toast}
            onReloadList={() => void refreshList()}
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
