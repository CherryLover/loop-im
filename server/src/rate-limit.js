// 登录接口的失败次数限流。单进程 + SQLite 的部署形态下，进程内滑动窗口就够用，
// 不值得为它引 redis 或第三方中间件。
//
// 只统计「失败」：成功登录会清空该主体的记录，正常用户不会被自己的成功登录拖近上限。
// 同时按邮箱和来源 IP 两个维度计数 —— 换 IP 撞同一个账号会被邮箱维度挡住，
// 单 IP 遍历不同账号会被 IP 维度挡住。

const WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000);
const MAX_FAILURES = Number(process.env.LOGIN_MAX_FAILURES || 10);

const buckets = new Map(); // key -> number[]（失败时间戳）

const prune = (list, now) => list.filter((t) => t > now - WINDOW_MS);

function hits(key, now) {
  const list = prune(buckets.get(key) || [], now);
  if (list.length) buckets.set(key, list);
  else buckets.delete(key);
  return list;
}

/** 还要等多少毫秒才能再试；0 表示当前没有被限。 */
export function retryAfterMs(keys, now = Date.now()) {
  let wait = 0;
  for (const key of keys) {
    const list = hits(key, now);
    if (list.length >= MAX_FAILURES) wait = Math.max(wait, list[0] + WINDOW_MS - now);
  }
  return wait;
}

export function recordFailure(keys, now = Date.now()) {
  for (const key of keys) {
    const list = hits(key, now);
    list.push(now);
    buckets.set(key, list);
  }
}

export function clearFailures(keys) {
  for (const key of keys) buckets.delete(key);
}

/** 测试用：把窗口清空，免得用例之间互相影响。 */
export const resetRateLimit = () => buckets.clear();

export const rateLimitConfig = { windowMs: WINDOW_MS, maxFailures: MAX_FAILURES };
