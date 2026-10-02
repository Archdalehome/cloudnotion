/**
 * 重置密码的结果卡片：把新的（临时）密码显示给管理员，方便手动转达。
 * 邮件服务可用时 Worker 也会把这个密码发给用户本人。
 */
import { useState } from 'react';

export interface ResetResult {
  user: { id: string; email: string; name: string };
  password: string;
  emailed: boolean;
}

interface ResetResultCardProps {
  result: ResetResult;
  onClose: () => void;
}

export function ResetResultCard({ result, onClose }: ResetResultCardProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="hint-box">
      <div className="row gap">
        <strong className="small">「{result.user.name || result.user.email}」的新密码</strong>
        <span className="spacer" />
        <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="row gap" style={{ marginTop: 6 }}>
        <code className="code-echo">{result.password}</code>
        <button type="button" className="btn ghost small" onClick={() => void copy()}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        {result.emailed
          ? '已把新密码发送到该用户邮箱，'
          : '邮件服务未配置（或收件人是测试域），请手动把新密码转达给用户，'}
        该账号的所有设备已下线，需要用新密码重新登录。
      </p>
    </div>
  );
}
