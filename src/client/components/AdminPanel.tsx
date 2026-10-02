/**
 * 用户管理（超级管理员的「后台」页面）。
 *
 * 只做三件事：查看全部注册用户、修改注册信息（昵称 / 邮箱）、重置密码。
 * 权限在服务端（`/api/admin/*` 全部走 `requireAdmin`），这里只是入口的显隐。
 */
import { useCallback, useEffect, useState } from 'react';
import type { AdminUser, SessionUser } from '../../shared/types';
import { ApiError, api } from '../api';
import { EditUserDialog } from './EditUserDialog';
import { ResetResultCard, type ResetResult } from './ResetResultCard';

interface AdminPanelProps {
  me: SessionUser | null;
  onToast: (message: string, kind?: 'info' | 'error') => void;
  /** 改了自己的资料 / 重置了自己的密码之后，让 App 重新拉一次会话 */
  onReloadSession: () => void;
}

const PAGE_SIZE = 50;

/** 列表里的时间统一按本地时区显示 */
export function formatTime(value: number | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function AdminPanel({ me, onToast, onReloadSession }: AdminPanelProps) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [busyId, setBusyId] = useState('');
  const [reset, setReset] = useState<ResetResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await api.adminListUsers({ search, limit: PAGE_SIZE, offset });
      setUsers(payload.users);
      setTotal(payload.total);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '用户列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [search, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetPassword = async (user: AdminUser) => {
    if (!window.confirm(`确定要重置「${user.name || user.email}」的密码吗？该账号所有设备都会立即下线。`)) return;
    setBusyId(user.id);
    try {
      const result = await api.adminResetUserPassword(user.id);
      setReset({ user: result.user, password: result.password, emailed: result.emailed });
      if (result.resetSelf) {
        onToast('已重置你自己的密码，请用新密码重新登录');
        onReloadSession();
      } else {
        onToast(result.emailed ? '已重置密码，新密码已发送到该用户邮箱' : '已重置密码');
      }
    } catch (cause) {
      onToast(cause instanceof ApiError ? cause.message : '重置密码失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="admin-panel">
      <div className="admin-head">
        <h2 className="page-title">用户管理</h2>
        <span className="small muted">
          共 {total} 个注册账号{search ? `（匹配「${search}」）` : ''}
        </span>
        <span className="spacer" />
        <form
          className="row gap"
          onSubmit={(event) => {
            event.preventDefault();
            setOffset(0);
            setSearch(draft.trim());
          }}
        >
          <input
            className="input"
            value={draft}
            placeholder="搜索昵称或邮箱"
            onChange={(event) => setDraft(event.target.value)}
            style={{ width: 180 }}
          />
          <button className="btn" type="submit">
            搜索
          </button>
          {search ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setDraft('');
                setSearch('');
                setOffset(0);
              }}
            >
              清除
            </button>
          ) : null}
        </form>
        <button type="button" className="btn ghost small" onClick={() => void load()} disabled={loading}>
          刷新
        </button>
      </div>

      {error ? <p className="error small">{error}</p> : null}
      {loading ? <p className="muted small">加载中…</p> : null}
      {reset ? <ResetResultCard result={reset} onClose={() => setReset(null)} /> : null}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>用户</th>
              <th>角色</th>
              <th>表格</th>
              <th>注册时间</th>
              <th>最近登录</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <div className="row gap">
                    <div className="avatar small-avatar">{(user.name || user.email).slice(0, 1).toUpperCase()}</div>
                    <div style={{ minWidth: 0 }}>
                      <div className="user-name">
                        {user.name || '（未填昵称）'}
                        {user.id === me?.id ? <span className="tag accent">我</span> : null}
                      </div>
                      <div className="small muted">{user.email}</div>
                    </div>
                  </div>
                </td>
                <td>
                  {user.isAdmin ? <span className="tag accent">管理员</span> : <span className="small muted">普通用户</span>}
                </td>
                <td className="small muted">
                  拥有 {user.databaseCount} · 协作 {user.sharedCount}
                </td>
                <td className="small muted">{formatTime(user.createdAt)}</td>
                <td className="small muted">{formatTime(user.lastSeenAt)}</td>
                <td>
                  <div className="row gap">
                    <button type="button" className="btn ghost small" onClick={() => setEditing(user)}>
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      disabled={busyId === user.id}
                      onClick={() => void resetPassword(user)}
                    >
                      {busyId === user.id ? '处理中…' : '重置密码'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && users.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted small">
                  没有匹配的用户
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {pages > 1 ? (
        <div className="row gap">
          <button
            type="button"
            className="btn ghost small"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            上一页
          </button>
          <span className="small muted">
            第 {page} / {pages} 页
          </span>
          <button
            type="button"
            className="btn ghost small"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            下一页
          </button>
        </div>
      ) : null}

      {editing ? (
        <EditUserDialog
          user={editing}
          onClose={() => setEditing(null)}
          onToast={onToast}
          onSaved={(updated) => {
            setUsers((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
            if (updated.id === me?.id) onReloadSession();
          }}
        />
      ) : null}
    </section>
  );
}
