// 未读徽标的文案与样式选择：普通未读和「有人 @ 我」必须能分开。
import { describe, expect, it } from 'vitest';
import { unreadAriaLabel, unreadBadgeClass } from './format';

describe('unreadAriaLabel', () => {
  it('没有 @ 我时保持原来的说法', () => {
    expect(unreadAriaLabel(3)).toBe('3 条未读');
    expect(unreadAriaLabel(3, 0)).toBe('3 条未读');
  });

  it('有 @ 我时把这一档说出来，读屏才听得见差别', () => {
    expect(unreadAriaLabel(5, 2)).toBe('5 条未读，其中 2 条 @ 我');
    expect(unreadAriaLabel(1, 1)).toBe('1 条未读，其中 1 条 @ 我');
  });
});

describe('unreadBadgeClass', () => {
  it('没有 @ 我就是普通徽标', () => {
    expect(unreadBadgeClass()).toBe('badge');
    expect(unreadBadgeClass(0)).toBe('badge');
  });

  it('有 @ 我时加一层高亮样式，而不是换掉基础样式', () => {
    expect(unreadBadgeClass(1)).toBe('badge badge--mention');
  });
});
