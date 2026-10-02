/** 管理员修改某个用户的注册信息（昵称 / 邮箱）。 */
import { useState } from 'react';
import type { AdminUser } from '../../shared/types';
import { ApiError, api } from '../api';
import { Modal } from './Modal';

interface EditUserDialogProps {
  user: AdminUser;
  onClose: () => void;
  onToast: (message: string, kind?: 'info' | 'error') => void;
  onSaved: (user: AdminUser) => void;
}

export function EditUserDialog({ user, onClose, onToast, onSaved }: EditUserDialogProps) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const changed = name.trim() !== user.name || email.trim().toLowerCase() !== user.email;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api.adminUpdateUser(user.id, { name: name.trim(), email: email.trim() });
      onSaved(result.user);
      onToast(result.updatedSelf ? '你自己的注册信息已更新' : '用户注册信息已更新');
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="编辑用户" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="small muted" style={{ marginTop: 0 }}>
          {user.isAdmin ? '管理员账号' : '普通账号'} · 拥有 {user.databaseCount} 张表格，协作 {user.sharedCount} 张
        </p>

        <label className="field">
          <span>昵称</span>
          <input
            className="input"
            value={name}
            maxLength={60}
            required
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label className="field">
          <span>登录邮箱</span>
          <input
            className="input"
            type="email"
            value={email}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        {error ? <p className="error small">{error}</p> : null}

        <div className="row gap" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy || !changed || !name.trim()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
