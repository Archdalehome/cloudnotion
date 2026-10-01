import { useState } from 'react';
import type { SessionUser } from '../../shared/types';
import { ApiError, api } from '../api';

interface AuthPageProps {
  appName: string;
  onAuthenticated: (user: SessionUser) => void;
}

export function AuthPage({ appName, onAuthenticated }: AuthPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result =
        mode === 'login'
          ? await api.login({ email: email.trim(), password })
          : await api.register({ email: email.trim(), password, name: name.trim() });
      onAuthenticated(result.user);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '请求失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="centered">
      <form className="auth-card" onSubmit={submit}>
        <h1>{appName}</h1>
        <p className="muted">{mode === 'login' ? '登录以继续你的表格' : '创建账号，开始搭建你的数据库'}</p>

        {mode === 'register' ? (
          <label className="field">
            <span>昵称</span>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="你的名字"
              autoComplete="nickname"
              required
            />
          </label>
        ) : null}

        <label className="field">
          <span>邮箱</span>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            // 手机键盘默认会首字母大写 / 自动更正，邮箱与密码都不需要
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </label>

        <label className="field">
          <span>密码</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 8 位"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            minLength={8}
            required
          />
        </label>

        {error ? <p className="error small">{error}</p> : null}

        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? '处理中…' : mode === 'login' ? '登录' : '注册'}
        </button>

        <p className="small muted" style={{ textAlign: 'center', marginTop: 12 }}>
          {mode === 'login' ? '还没有账号？' : '已经有账号了？'}
          <button
            type="button"
            className="btn ghost small"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError('');
            }}
          >
            {mode === 'login' ? '立即注册' : '去登录'}
          </button>
        </p>
      </form>
    </div>
  );
}
