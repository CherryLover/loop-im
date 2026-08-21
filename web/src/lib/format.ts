const pad = (n: number) => String(n).padStart(2, '0');

export const clock = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * 被限流之后「几点几分可以再发」。
 *
 * 参数是服务端给的**相对**毫秒，换算成钟点这一步必须在本地做：客户端的钟和
 * 服务端可能差几分钟，直接显示服务端算好的绝对时刻，用户对着自己的表看就是错的。
 * 用 `Date.now() + retryAfterMs`，显示出来的钟点和用户自己的表永远对得上。
 *
 * 不足一分钟也照样进位到下一分钟：说「14:30 可以再发」而实际 14:30:40 才放行，
 * 用户会以为界面骗人；宁可多等几十秒，也不要给一个到点还发不出去的时间。
 */
export const retryAtClock = (retryAfterMs: number, now = Date.now()) =>
  clock(Math.ceil((now + Math.max(0, retryAfterMs)) / 60000) * 60000);

/**
 * 给失败提示补上「几点几分可以再发」。不是限流（没有 retryAfterMs）时原样返回，
 * 所以调用方不用自己分支判断。
 */
export const withRetryHint = (text: string, retryAfterMs?: number, now = Date.now()) =>
  (typeof retryAfterMs === 'number' && retryAfterMs > 0
    ? `${text}，${retryAtClock(retryAfterMs, now)} 后可以再发`
    : text);

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

/**
 * 有 @ 我的未读时徽标换一套样式，视觉上从一堆普通未读里跳出来。
 *
 * 免打扰的会话反过来走弱化那一档：未读照算、徽标照显（免打扰不是不计未读，
 * 数字一个都不少），只是不再抢眼，@我 也不再升级成告警色 —— 用户明确说了
 * 「这个会话别吵我」，那就连 @ 一起安静下来。
 */
export const unreadBadgeClass = (mentions = 0, muted = false) =>
  (muted ? 'badge badge--muted' : mentions > 0 ? 'badge badge--mention' : 'badge');
