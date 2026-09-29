/**
 * Client entry: session bootstrap, workspace shell (sidebar + database page)
 * and the public share route (`/share/:token`).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DatabaseDetail, DatabaseSummary, SessionUser } from '../shared/types';
import { ApiError, api } from './api';
import { AuthPage } from './components/AuthPage';
import { DatabasePage } from './components/DatabasePage';
import { PublicPage } from './components/PublicPage';
import { Sidebar } from './components/Sidebar';

interface ToastItem {
  id: number;
  message: string;
  kind: 'info' | 'error';
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
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, kind }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((item) => item.id !== id)), 3200);
  }, []);

  useEffect(() => {
    if (shareToken) return;
    let cancelled = false;
    api
      .session()
      .then((payload) => {
        if (cancelled) return;
        setAppName(payload.appName);
        setUser(payload.user);
        setDatabases(payload.databases);
        if (payload.user && payload.databases.length) setActiveId(payload.databases[0].id);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shareToken]);

  useEffect(() => {
    if (!activeId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    api
      .getDatabase(activeId, { limit: 100 })
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((cause) => {
        if (cancelled) return;
        setDetail(null);
        toast(cause instanceof ApiError ? cause.message : '加载表格失败', 'error');
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, toast]);

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
      toast(`已创建「${created.name}」`);
    },
    [toast],
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
  }, []);

  const reauthenticate = useCallback(
    (next: SessionUser) => {
      setUser(next);
      void refreshList();
    },
    [refreshList],
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
    <div className="app-shell">
      <Sidebar
        appName={appName}
        user={user}
        databases={databases}
        activeId={activeId}
        onSelect={(id) => setActiveId(id)}
        onCreate={createDatabase}
        onLogout={() => void logout()}
      />

      <main className="main">
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
        ) : (
          <div className="centered">
            <div className="empty-state">
              <h2>{appName}</h2>
              <p className="muted">从左侧选择一个表格，或点击 ＋ 新建一个。</p>
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
