import type { InboxMessage } from '../../shared/types';
import { formatDateTime, formatRelativeTime } from '../lib/time';
import { Popover } from './Popover';

interface InboxButtonProps {
  /** 未读私信，按时间倒序 */
  messages: InboxMessage[];
  /** 未读条数：就是红点里的数字，为 0 时红点消失（inbox 图标保留） */
  unread: number;
  /** 展开面板前刷新一次 */
  onRefresh: () => void;
  /** 点开某条私信（已读 + 打开对应记录卡片并定位到那条备注） */
  onSelect: (message: InboxMessage) => void;
}

/**
 * 左上角的收件箱（inbox）标志 + 右上角红点。
 *
 * 红点里的数字是未读私信条数：点开一条私信就 -1，归零后红点消失、图标保留。
 * 私信来自别人在备注里 @ 你（见 RecordDialog 的备注输入框）。
 */
export function InboxButton({ messages, unread, onRefresh, onSelect }: InboxButtonProps) {
  const title = unread ? `收件箱：${unread} 条未读私信` : '收件箱';
  return (
    <Popover
      label={
        <span className="inbox-trigger" role="img" aria-label="收件箱">
          {/* 灰色单色图标：跟随 currentColor，不再用彩色 emoji，避免在侧边栏里抢眼 */}
          <svg
            className="inbox-icon"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M22 12h-6l-2 3h-4l-2-3H2" />
            <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
          </svg>
          {unread > 0 ? <span className="inbox-dot">{unread > 99 ? '99+' : unread}</span> : null}
        </span>
      }
      title={title}
      wide
      align="left"
      onOpen={onRefresh}
    >
      {(close) => (
        <div className="inbox-panel">
          <div className="row gap">
            <strong className="small">收件箱</strong>
            <span className="spacer" />
            <span className="small muted">{unread ? `${unread} 条未读` : '没有未读'}</span>
          </div>
          {messages.length ? (
            <div className="inbox-list">
              {messages.map((message) => (
                <button
                  type="button"
                  key={message.id}
                  className="inbox-item"
                  title="打开这条私信所在的记录，并定位到这条备注"
                  onClick={() => {
                    close();
                    onSelect(message);
                  }}
                >
                  <span className="inbox-item-top">
                    <span className="inbox-item-title">
                      {message.databaseIcon} {message.recordTitle || '未命名记录'}
                    </span>
                    <span className="small muted" title={formatDateTime(message.createdAt)}>
                      {formatRelativeTime(message.createdAt)}
                    </span>
                  </span>
                  <span className="inbox-item-body">{message.body}</span>
                  <span className="small muted">
                    {message.authorName || '未知用户'} 在「{message.databaseName}」的备注里 @ 了你
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>
              还没有私信。别人在备注里 @ 你时，会在这里出现。
            </p>
          )}
        </div>
      )}
    </Popover>
  );
}
