import type { SessionUser } from '../../shared/types';

interface UserChipProps {
  user: SessionUser | null;
  onLogout: () => void;
  /** 打开「修改密码」弹窗（两者都从 App 传进来，侧边栏底部与顶部条共用同一份） */
  onChangePassword: () => void;
}

/**
 * 「用户名 / 邮箱 + 退出」小块：侧边栏底部与「侧边栏关闭时的顶部条右上角」共用，
 * 免得两处各写一份。父元素需要是 flex 容器（`.row.gap` 之类），本块用 flex:1 吃掉剩余宽度。
 */
export function UserChip({ user, onLogout, onChangePassword }: UserChipProps) {
  return (
    <>
      <div className="user-meta">
        <div className="small user-name" title={user?.name || user?.email || '未登录'}>
          {user?.name || '未登录'}
        </div>
        <div className="small muted user-email" title={user?.email || ''}>
          {user?.email || ''}
        </div>
      </div>
      <button type="button" className="btn ghost small" title="修改密码" onClick={onChangePassword}>
        改密码
      </button>
      <button type="button" className="btn ghost small" onClick={onLogout}>
        退出
      </button>
    </>
  );
}
