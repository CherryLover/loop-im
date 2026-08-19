import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clock, dayLabel, listTime, relativeTime } from './format';

const NOW = new Date('2026-08-19T14:30:00');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const minutesAgo = (n: number) => NOW.getTime() - n * 60_000;

describe('时间格式', () => {
  it('消息时间是零填充的 HH:MM', () => {
    expect(clock(new Date('2026-08-19T09:05:00').getTime())).toBe('09:05');
    expect(clock(new Date('2026-08-19T23:59:00').getTime())).toBe('23:59');
  });

  it('相对时间：刚刚 / 分钟 / 小时 / 昨天 / 日期', () => {
    expect(relativeTime(minutesAgo(0))).toBe('刚刚');
    expect(relativeTime(minutesAgo(6))).toBe('6 分钟前');
    expect(relativeTime(minutesAgo(150))).toBe('2 小时前');
    expect(relativeTime(new Date('2026-08-18T16:20:00').getTime())).toBe('昨天 16:20');
    expect(relativeTime(new Date('2026-08-01T10:00:00').getTime())).toBe('8月1日');
    expect(relativeTime(0)).toBe('—');
  });

  it('会话列表时间：今天给时刻，更早给日期', () => {
    expect(listTime(minutesAgo(30))).toBe('14:00');
    expect(listTime(new Date('2026-08-18T08:00:00').getTime())).toBe('昨天');
    expect(listTime(new Date('2026-08-10T08:00:00').getTime())).toBe('8/10');
  });

  it('日期分隔条', () => {
    expect(dayLabel(minutesAgo(10))).toBe('今天');
    expect(dayLabel(new Date('2026-08-18T08:00:00').getTime())).toBe('昨天');
    expect(dayLabel(new Date('2026-08-17T08:00:00').getTime())).toBe('8月17日');
  });
});
