/** 备注 / 私信上的时间显示（本地时间，不做时区换算）。 */

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD HH:mm` */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * 相对时间：1 分钟内「刚刚」→ 分钟 → 小时 → 天，超过一周显示具体时间。
 * 用于备注列表和私信列表，鼠标悬停时用 {@link formatDateTime} 显示精确时间。
 */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  if (diff < 7 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
  return formatDateTime(timestamp);
}
