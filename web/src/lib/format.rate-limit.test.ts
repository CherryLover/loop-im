// 被限流之后要能告诉用户「几点几分可以再发」。这个钟点必须在本地由
// retryAfterMs 换算，不能显示服务端算好的绝对时刻 —— 客户端的钟可能偏几分钟。
import { describe, expect, it } from 'vitest';
import { retryAtClock, withRetryHint } from './format';

const at = (h: number, m: number, s = 0) => new Date(2026, 0, 8, h, m, s).getTime();

describe('限流提示的时间换算', () => {
  it('按「此刻 + 还要等多久」算出钟点', () => {
    expect(retryAtClock(60_000, at(14, 30))).toBe('14:31');
    expect(retryAtClock(5 * 60_000, at(14, 30))).toBe('14:35');
  });

  it('不足一分钟也进位到下一分钟 —— 说了几点就必须真能发出去', () => {
    // 14:30:40 才放行，说「14:30」用户到点还是发不出去，只会觉得界面在骗人。
    expect(retryAtClock(40_000, at(14, 30))).toBe('14:31');
  });

  it('跨小时、跨天都对', () => {
    expect(retryAtClock(90_000, at(14, 59))).toBe('15:01');
    expect(retryAtClock(120_000, at(23, 59))).toBe('00:01');
  });

  it('客户端的钟偏了也不影响：钟点始终跟着本地时间走', () => {
    // 同一个 retryAfterMs，在两台差了两小时的机器上各自算出自己表上的时刻。
    expect(retryAtClock(60_000, at(9, 0))).toBe('09:01');
    expect(retryAtClock(60_000, at(11, 0))).toBe('11:01');
  });
});

describe('失败提示补上可再发的时间', () => {
  it('是限流时补上「几点几分后可以再发」', () => {
    expect(withRetryHint('消息发得太快了，请稍后再试', 60_000, at(14, 30)))
      .toBe('消息发得太快了，请稍后再试，14:31 后可以再发');
  });

  it('不是限流（没有 retryAfterMs）时原样返回', () => {
    expect(withRetryHint('网络错误', undefined, at(14, 30))).toBe('网络错误');
    expect(withRetryHint('网络错误', 0, at(14, 30))).toBe('网络错误');
  });
});
