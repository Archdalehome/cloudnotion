/** Members + public share links + view level sharing panel (owner only for management actions). */
import { useState } from 'react';
import type { DatabaseDetail, Member, Role, Share, ViewDef, ViewShare } from '../../shared/types';
import { ApiError, api } from '../api';
import { Modal } from './Modal';

interface SharePanelProps {
  database: DatabaseDetail;
  canManage: boolean;
  /** preselected view when opened from the "分享" button of a view */
  focusViewId?: string | null;
  onClose: () => void;
  onToast: (message: string, kind?: 'info' | 'error') => void;
  onMembers: (members: Member[]) => void;
  onShares: (shares: Share[]) => void;
  onViewShares: (shares: ViewShare[]) => void;
}

const ROLE_LABEL: Record<Role, string> = { owner: '所有者', editor: '可编辑', viewer: '可查看' };

function shareLink(token: string): string {
  return `${window.location.origin}/share/${token}`;
}

export function SharePanel({
  database,
  canManage,
  focusViewId,
  onClose,
  onToast,
  onMembers,
  onShares,
  onViewShares,
}: SharePanelProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [permission, setPermission] = useState<'view' | 'edit'>('view');
  const [expiresInDays, setExpiresInDays] = useState('0');
  const [viewId, setViewId] = useState(focusViewId ?? database.views[0]?.id ?? '');
  const [viewEmail, setViewEmail] = useState('');
  const [viewRole, setViewRole] = useState<'editor' | 'viewer'>('viewer');
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

  const addMember = () =>
    run(async () => {
      const target = email.trim();
      if (!target) return;
      const result = await api.addMember(database.id, { email: target, role });
      onMembers(result.members);
      setEmail('');
      onToast('成员已添加');
    }, '添加成员失败');

  const changeMemberRole = (member: Member, next: 'editor' | 'viewer') =>
    run(async () => {
      const result = await api.updateMember(member.id, next);
      onMembers(result.members);
    }, '修改权限失败');

  const removeMember = (member: Member) =>
    run(async () => {
      const result = await api.removeMember(member.id);
      onMembers(result.members);
    }, '移除成员失败');

  const createShare = () =>
    run(async () => {
      const days = Number(expiresInDays);
      const result = await api.createShare(database.id, {
        permission,
        expiresInDays: Number.isFinite(days) && days > 0 ? days : undefined,
      });
      onShares(result.shares);
    }, '生成分享链接失败');

  const removeShare = (share: Share) =>
    run(async () => {
      const result = await api.deleteShare(share.id);
      onShares(result.shares);
    }, '删除分享链接失败');

  /** 定向分享：只把某一个视图（含其筛选与可见字段）分享给指定账号。 */
  const addViewShare = () =>
    run(async () => {
      const target = viewEmail.trim();
      if (!target || !viewId) return;
      const result = await api.createViewShare(database.id, { viewId, email: target, role: viewRole });
      onViewShares(result.viewShares);
      setViewEmail('');
      onToast('视图已定向分享');
    }, '视图分享失败');

  const removeViewShare = (share: ViewShare) =>
    run(async () => {
      const result = await api.deleteViewShare(share.id);
      onViewShares(result.viewShares);
      onToast('已取消该视图分享');
    }, '移除视图分享失败');

  const copy = async (token: string) => {
    const link = shareLink(token);
    try {
      await navigator.clipboard.writeText(link);
      onToast('链接已复制');
    } catch {
      onToast(link, 'info');
    }
  };

  return (
    <Modal title="分享与成员" onClose={onClose} wide>
      <ShareMembers
        members={database.members}
        canManage={canManage}
        busy={busy}
        email={email}
        role={role}
        onEmail={setEmail}
        onRole={setRole}
        onAdd={addMember}
        onChangeRole={changeMemberRole}
        onRemove={removeMember}
      />
      {canManage ? (
        <ShareLinks
          shares={database.shares}
          busy={busy}
          permission={permission}
          expiresInDays={expiresInDays}
          onPermission={setPermission}
          onExpires={setExpiresInDays}
          onCreate={createShare}
          onRemove={removeShare}
          onCopy={copy}
        />
      ) : null}
      {canManage ? (
        <ShareViews
          views={database.views}
          viewShares={database.viewShares}
          viewId={viewId}
          email={viewEmail}
          role={viewRole}
          busy={busy}
          onView={setViewId}
          onEmail={setViewEmail}
          onRole={setViewRole}
          onAdd={addViewShare}
          onRemove={removeViewShare}
        />
      ) : null}
    </Modal>
  );
}

interface ShareMembersProps {
  members: Member[];
  canManage: boolean;
  busy: boolean;
  email: string;
  role: 'editor' | 'viewer';
  onEmail: (value: string) => void;
  onRole: (value: 'editor' | 'viewer') => void;
  onAdd: () => void;
  onChangeRole: (member: Member, role: 'editor' | 'viewer') => void;
  onRemove: (member: Member) => void;
}

function ShareMembers({
  members,
  canManage,
  busy,
  email,
  role,
  onEmail,
  onRole,
  onAdd,
  onChangeRole,
  onRemove,
}: ShareMembersProps) {
  return (
    <div className="form-section">
      <h4>成员</h4>
      <div className="center-list">
        {members.map((member) => (
          <div className="row gap" key={member.id}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div>{member.name || member.email}</div>
              <div className="small muted">{member.email}</div>
            </div>
            {canManage && member.role !== 'owner' ? (
              <>
                <select
                  className="input"
                  style={{ width: 110 }}
                  value={member.role}
                  onChange={(event) => onChangeRole(member, event.target.value as 'editor' | 'viewer')}
                >
                  <option value="editor">可编辑</option>
                  <option value="viewer">可查看</option>
                </select>
                <button type="button" className="btn ghost small" onClick={() => onRemove(member)}>
                  移除
                </button>
              </>
            ) : (
              <span className="badge">{ROLE_LABEL[member.role]}</span>
            )}
          </div>
        ))}
      </div>

      {canManage ? (
        <form
          className="row gap"
          style={{ marginTop: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            onAdd();
          }}
        >
          <input
            className="input"
            type="email"
            placeholder="成员邮箱"
            value={email}
            onChange={(event) => onEmail(event.target.value)}
          />
          <select
            className="input"
            style={{ width: 110 }}
            value={role}
            onChange={(event) => onRole(event.target.value as 'editor' | 'viewer')}
          >
            <option value="editor">可编辑</option>
            <option value="viewer">可查看</option>
          </select>
          <button className="btn primary small" type="submit" disabled={busy || !email.trim()}>
            添加
          </button>
        </form>
      ) : null}
    </div>
  );
}

interface ShareLinksProps {
  shares: Share[];
  busy: boolean;
  permission: 'view' | 'edit';
  expiresInDays: string;
  onPermission: (value: 'view' | 'edit') => void;
  onExpires: (value: string) => void;
  onCreate: () => void;
  onRemove: (share: Share) => void;
  onCopy: (token: string) => void;
}

function ShareLinks({
  shares,
  busy,
  permission,
  expiresInDays,
  onPermission,
  onExpires,
  onCreate,
  onRemove,
  onCopy,
}: ShareLinksProps) {
  return (
    <div className="form-section">
      <h4>公开链接</h4>
      <div className="center-list">
        {shares.length ? (
          shares.map((share) => (
            <div className="row gap" key={share.id}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="small" style={{ wordBreak: 'break-all' }}>
                  {shareLink(share.token)}
                </div>
                <div className="small muted">
                  {share.permission === 'edit' ? '可编辑' : '只读'}
                  {share.expiresAt
                    ? ` · ${new Date(share.expiresAt).toLocaleDateString('zh-CN')} 过期`
                    : ' · 永久有效'}
                </div>
              </div>
              <button type="button" className="btn ghost small" onClick={() => onCopy(share.token)}>
                复制
              </button>
              <button type="button" className="btn ghost small" onClick={() => onRemove(share)}>
                删除
              </button>
            </div>
          ))
        ) : (
          <p className="small muted">还没有分享链接。</p>
        )}
      </div>

      <div className="row gap" style={{ marginTop: 12 }}>
        <select
          className="input"
          style={{ width: 120 }}
          value={permission}
          onChange={(event) => onPermission(event.target.value as 'view' | 'edit')}
        >
          <option value="view">只读</option>
          <option value="edit">可编辑</option>
        </select>
        <select
          className="input"
          style={{ width: 140 }}
          value={expiresInDays}
          onChange={(event) => onExpires(event.target.value)}
        >
          <option value="0">永久有效</option>
          <option value="7">7 天后过期</option>
          <option value="30">30 天后过期</option>
          <option value="90">90 天后过期</option>
        </select>
        <button type="button" className="btn primary small" disabled={busy} onClick={onCreate}>
          生成链接
        </button>
      </div>
    </div>
  );
}


interface ShareViewsProps {
  views: ViewDef[];
  viewShares: ViewShare[];
  viewId: string;
  email: string;
  role: 'editor' | 'viewer';
  busy: boolean;
  onView: (value: string) => void;
  onEmail: (value: string) => void;
  onRole: (value: 'editor' | 'viewer') => void;
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
  busy,
  onView,
  onEmail,
  onRole,
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
    </div>
  );
}
