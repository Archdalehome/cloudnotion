/**
 * 视图定向分享面板：把一个视图（含它的筛选与可见字段）分享给某个已注册账号。
 * 成员管理与公开链接已从界面上移除，这里只保留「视图定向分享」。
 */
import { useState } from 'react';
import type { DatabaseDetail, Role, ViewDef, ViewShare } from '../../shared/types';
import { ApiError, api } from '../api';
import { Modal } from './Modal';

interface SharePanelProps {
  database: DatabaseDetail;
  /** owner only：非所有者的表格看得到「分享」入口才渲染表单（服务端同样会拒绝） */
  canManage: boolean;
  /** preselected view when opened from the "分享" button of a view */
  focusViewId?: string | null;
  onClose: () => void;
  onToast: (message: string, kind?: 'info' | 'error') => void;
  onViewShares: (shares: ViewShare[]) => void;
}

const ROLE_LABEL: Record<Role, string> = { owner: '所有者', editor: '可编辑', viewer: '可查看' };

export function SharePanel({
  database,
  canManage,
  focusViewId,
  onClose,
  onToast,
  onViewShares,
}: SharePanelProps) {
  const [viewId, setViewId] = useState(focusViewId ?? database.views[0]?.id ?? '');
  const [viewEmail, setViewEmail] = useState('');
  const [viewRole, setViewRole] = useState<'editor' | 'viewer'>('viewer');
  /** 「限制编辑」：只对「可编辑」的分享有意义，默认不限制 */
  const [viewLimitEdits, setViewLimitEdits] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      onToast(cause instanceof ApiError ? cause.message : fallback, 'error');
    } finally {
      setBusy(false);
    }
  };

  /** 定向分享：只把某一个视图（含其筛选与可见字段）分享给指定账号。 */
  const addViewShare = () =>
    run(async () => {
      const target = viewEmail.trim();
      if (!target || !viewId) return;
      const result = await api.createViewShare(database.id, {
        viewId,
        email: target,
        role: viewRole,
        // 可查看的分享本来就不能改，「限制编辑」只随「可编辑」一起提交
        limitEdits: viewRole === 'editor' && viewLimitEdits,
      });
      onViewShares(result.viewShares);
      setViewEmail('');
      onToast(viewRole === 'editor' && viewLimitEdits ? '视图已定向分享（限制编辑）' : '视图已定向分享');
    }, '视图分享失败');

  const removeViewShare = (share: ViewShare) =>
    run(async () => {
      const result = await api.deleteViewShare(share.id);
      onViewShares(result.viewShares);
      onToast('已取消该视图分享');
    }, '移除视图分享失败');

  return (
    <Modal title="视图定向分享" onClose={onClose} wide>
      {canManage ? (
        <ShareViews
          views={database.views}
          viewShares={database.viewShares}
          viewId={viewId}
          email={viewEmail}
          role={viewRole}
          limitEdits={viewLimitEdits}
          busy={busy}
          onView={setViewId}
          onEmail={setViewEmail}
          onRole={setViewRole}
          onLimitEdits={setViewLimitEdits}
          onAdd={addViewShare}
          onRemove={removeViewShare}
        />
      ) : (
        <p className="small muted">只有表格所有者可以配置视图定向分享。</p>
      )}
    </Modal>
  );
}

interface ShareViewsProps {
  views: ViewDef[];
  viewShares: ViewShare[];
  viewId: string;
  email: string;
  role: 'editor' | 'viewer';
  /** 分享时是否勾选「限制编辑」（仅 role === 'editor' 时提交） */
  limitEdits: boolean;
  busy: boolean;
  onView: (value: string) => void;
  onEmail: (value: string) => void;
  onRole: (value: 'editor' | 'viewer') => void;
  onLimitEdits: (value: boolean) => void;
  onAdd: () => void;
  onRemove: (share: ViewShare) => void;
}

/** 视图定向分享：把单个视图（含筛选与字段可见性）分享给某个已注册账号。 */
function ShareViews({
  views,
  viewShares,
  viewId,
  email,
  role,
  limitEdits,
  busy,
  onView,
  onEmail,
  onRole,
  onLimitEdits,
  onAdd,
  onRemove,
}: ShareViewsProps) {
  return (
    <div className="form-section">
      <h4>视图定向分享</h4>
      <p className="small muted">被分享者只会看到这一个视图及其中的数据，其他视图与不可见字段不会暴露。</p>

      <div className="center-list">
        {viewShares.length ? (
          viewShares.map((share) => (
            <div className="row gap" key={share.id}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="small">
                  {share.viewName} · {share.email}
                </div>
                <div className="small muted">
                  {share.name ? `${share.name} · ` : ''}
                  {ROLE_LABEL[share.role]}
                  {share.limitEdits ? ' · 限制编辑（每个格子只能改一次）' : ''}
                </div>
              </div>
              <button type="button" className="btn ghost small" disabled={busy} onClick={() => onRemove(share)}>
                取消分享
              </button>
            </div>
          ))
        ) : (
          <p className="small muted">还没有视图定向分享。</p>
        )}
      </div>

      <form
        className="row gap"
        style={{ marginTop: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          onAdd();
        }}
      >
        <select className="input" style={{ width: 150 }} value={viewId} onChange={(event) => onView(event.target.value)}>
          {views.map((view) => (
            <option key={view.id} value={view.id}>
              {view.name}
            </option>
          ))}
        </select>
        <input
          className="input"
          type="email"
          placeholder="对方邮箱"
          value={email}
          onChange={(event) => onEmail(event.target.value)}
        />
        <select
          className="input"
          style={{ width: 110 }}
          value={role}
          onChange={(event) => onRole(event.target.value as 'editor' | 'viewer')}
        >
          <option value="viewer">可查看</option>
          <option value="editor">可编辑</option>
        </select>
        <button className="btn primary small" type="submit" disabled={busy || !email.trim() || !viewId}>
          分享视图
        </button>
      </form>

      {role === 'editor' ? (
        <label className="row gap" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={limitEdits}
            disabled={busy}
            onChange={(event) => onLimitEdits(event.target.checked)}
          />
          <span className="small">
            限制编辑：被分享者对每个格子只有一次输入机会，改过之后该格子只能查看
          </span>
        </label>
      ) : null}
    </div>
  );
}
