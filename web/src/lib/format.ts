const pad = (n: number) => String(n).padStart(2, '0');

export const clock = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 刚刚 / N 分钟前 / N 小时前 / 昨天 HH:MM / M月D日 */
export function relativeTime(ts: number) {
  if (!ts) return '—';
  const now = new Date();
  const then = new Date(ts);
  const mins = Math.floor((now.getTime() - ts) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  if (sameDay(now, then)) return `${Math.floor(mins / 60)} 小时前`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(yesterday, then)) return `昨天 ${clock(ts)}`;
  return `${then.getMonth() + 1}月${then.getDate()}日`;
}

/** Conversation list timestamps: HH:MM today, 昨天, otherwise a date. */
export function listTime(ts: number) {
  if (!ts) return '';
  const now = new Date();
  const then = new Date(ts);
  if (sameDay(now, then)) return clock(ts);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(yesterday, then)) return '昨天';
  return `${then.getMonth() + 1}/${then.getDate()}`;
}

export const dayLabel = (ts: number) => {
  const now = new Date();
  const then = new Date(ts);
  if (sameDay(now, then)) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(yesterday, then)) return '昨天';
  return `${then.getMonth() + 1}月${then.getDate()}日`;
};

/** 未读徽标上的数字：超过 99 就用 99+，免得把图标撑变形。 */
export const unreadLabel = (n: number) => (n > 99 ? '99+' : String(n));

/**
 * 未读徽标的无障碍名称。「有人 @ 我」只靠高亮颜色区分，读屏用户是感知不到的，
 * 所以名称里也要把这一档说出来；没有 @ 时保持原来的说法不变。
 */
export const unreadAriaLabel = (unread: number, mentions = 0) =>
  (mentions > 0 ? `${unread} 条未读，其中 ${mentions} 条 @ 我` : `${unread} 条未读`);

/** 有 @ 我的未读时徽标换一套样式，视觉上从一堆普通未读里跳出来。 */
export const unreadBadgeClass = (mentions = 0) => (mentions > 0 ? 'badge badge--mention' : 'badge');
