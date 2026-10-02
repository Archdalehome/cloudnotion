/**
 * 视图定向分享面板：把一个视图（含它的筛选与可见字段）分享给别人。
 *
 * 目标邮箱已经注册 → 直接加一条视图分享；
 * 目标邮箱还没注册 → 弹确认框，确认后发送邀请链接，对方点链接
 * （`/invite/<token>`）填昵称 + 密码即完成注册，并自动获得这条视图分享。
 * 成员管理与公开链接已从界面上移除，这里只保留「视图定向分享」。
 */
import { useState } from 'react';
import type { DatabaseDetail, Role, ViewDef, ViewInviteInfo, ViewShare } from '../../shared/types';
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
  /** 刚发出的「邀请未注册用户」结果：邮件没真发出去时会把链接回显在这里 */
  const [invite, setInvite] = useState<ViewInviteInfo | null>(null);

  const run = async (
    action: () => Promise<void>,
    fallback: string,
    /** 返回 true 表示这个错误已经处理过，不用再弹默认的错误提示 */
    onError?: (cause: unknown) => Promise<boolean> | boolean,
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      if (onError && (await onError(cause))) return;
      onToast(cause instanceof ApiError ? cause.message : fallback, 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 定向分享：只把某一个视图（含其筛选与可见字段）分享给指定账号。
   *
   * 目标邮箱还没注册时服务端返回 `email_not_registered`：这里弹一个确认框，
   * 确认后带 `invite: true` 再调一次，把邀请链接发到对方邮箱
   * （对方点链接填昵称 + 密码即完成注册，并自动获得这条视图分享）。
   */
  const addViewShare = () => {
    const target = viewEmail.trim();
    if (busy || !target || !viewId) return;
    const payload = {
      viewId,
      email: target,
      role: viewRole,
      // 可查看的分享本来就不能改，「限制编辑」只随「可编辑」一起提交
      limitEdits: viewRole === 'editor' && viewLimitEdits,
    };
    return run(
      async () => {
        const result = await api.createViewShare(database.id, payload);
        onViewShares(result.viewShares);
        setViewEmail('');
        setInvite(null);
        onToast(viewRole === 'editor' && viewLimitEdits ? '视图已定向分享（限制编辑）' : '视图已定向分享');
      },
      '视图分享失败',
      async (cause) => {
        if (!(cause instanceof ApiError) || cause.code !== 'email_not_registered') return false;
        const confirmed = window.confirm(
          `「${target}」还没有注册账号。\n\n要发送邀请链接吗？对方点开邮件里的链接，填昵称和密码即可完成注册，并自动看到这个视图。`,
        );
        if (!confirmed) return true;
        try {
          const invited = await api.createViewShare(database.id, { ...payload, invite: true });
          onViewShares(invited.viewShares);
          setViewEmail('');
          setInvite(invited.invite ?? null);
          onToast(
            invited.invite?.emailDelivered
              ? `邀请链接已发送到 ${target}`
              : `邀请链接已生成（未发邮件），请把链接发给 ${target}`,
          );
        } catch (nested) {
          onToast(nested instanceof ApiError ? nested.message : '发送邀请失败', 'error');
        }
        return true;
      },
    );
  };

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
          invite={invite}
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
  /** 刚发出的邀请（未注册邮箱）：邮件没发出去时把链接回显在这里 */
  invite: ViewInviteInfo | null;
  busy: boolean;
  onView: (value: string) => void;
  onEmail: (value: string) => void;
  onRole: (value: 'editor' | 'viewer') => void;
  onLimitEdits: (value: boolean) => void;
  onAdd: () => void;
  onRemove: (share: ViewShare) => void;
}

/** 视图定向分享：把单个视图（含筛选与字段可见性）分享给某个账号，或邀请其注册。 */
function ShareViews({
  views,
  viewShares,
  viewId,
  email,
  role,
  limitEdits,
  invite,
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
                  {share.limitEdits ? ' · 限制编辑（输入后 10 秒内可改，之后只读）' : ''}
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

      {/* 对方邮箱还没注册：确认后服务端会把邀请链接发过去，这里说明一下当前状态 */}
      {invite ? (
        <div className="field" style={{ marginTop: 10 }}>
          <span>
            {invite.emailDelivered
              ? `邀请邮件已发送到 ${invite.email}，${invite.ttlDays} 天内有效。`
              : `邮件服务未配置，请把下面的邀请链接发给 ${invite.email}（${invite.ttlDays} 天内有效）。`}
          </span>
          {invite.inviteUrl ? (
            <input
              className="input"
              readOnly
              value={invite.inviteUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
          ) : null}
          <span className="small muted">对方点开链接填昵称和密码即完成注册，并自动获得这个视图的分享。</span>
        </div>
      ) : null}

      {role === 'editor' ? (
        <label className="row gap" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={limitEdits}
            disabled={busy}
            onChange={(event) => onLimitEdits(event.target.checked)}
          />
          <span className="small">
            限制编辑：被分享者可以反复输入，但每次保存后 10 秒内还能继续修改，之后该格子只能查看（把内容清空则视为没有输入过，不受限制）
          </span>
        </label>
      ) : null}
    </div>
  );
}
