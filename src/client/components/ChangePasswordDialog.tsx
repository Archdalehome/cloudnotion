/**
 * 「修改密码」弹窗（登录后自助改密码）。
 *
 * 改成功后 Worker 会保留当前这台设备的会话、把其它设备的会话全部失效，
 * 所以这里只需要提示用户「其它设备需要重新登录」。
 */
import { useState } from 'react';
import { ApiError, api } from '../api';
import { Modal } from './Modal';

interface ChangePasswordDialogProps {
  onClose: () => void;
  onToast: (message: string, kind?: 'info' | 'error') => void;
}

export function ChangePasswordDialog({ onClose, onToast }: ChangePasswordDialogProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      setError('新密码至少 8 位，且需要同时包含字母和数字');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }

    setBusy(true);
    try {
      await api.changePassword({ currentPassword, newPassword });
      onToast('密码已更新，其它设备上的登录已失效');
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '修改失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="修改密码" onClose={onClose}>
      <form onSubmit={submit}>
        <label className="field">
          <span>当前密码</span>
          <input
            className="input"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            required
          />
        </label>

        <label className="field">
          <span>新密码</span>
          <input
            className="input"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="至少 8 位，含字母与数字"
            minLength={8}
            required
          />
        </label>

        <label className="field">
          <span>确认新密码</span>
          <input
            className="input"
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            minLength={8}
            required
          />
        </label>

        {error ? <p className="error small">{error}</p> : null}

        <div className="row gap" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy || !currentPassword || !newPassword}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
