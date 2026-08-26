// 主题的「跟随系统」与「手动记忆」两种状态的边界。
//
// 这里锁的是一个已经真实发生过的 bug：旧版在每次加载时把「按系统算出来的初值」
// 写进 localStorage，等于替所有人做了一次手动选择——从第二次访问起，系统再怎么
// 切换深浅色，应用都纹丝不动，而且没有任何报错。所以这组用例的重点不是 toggle
// 能不能用，而是「没手动选过」这个状态必须一直保持住：加载不能写盘，系统切换要
// 实时跟上，旧格式的存量脏数据要被当作没选过。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTheme } from './theme';

const KEY = 'loop-im-theme';

// jsdom 的 matchMedia 不会触发 change 事件，这里用可控的替身：
// matches 用 getter 读当前值，change 监听器收进集合里由测试主动触发。
let systemDark = false;
const listeners = new Set<() => void>();

function setSystemDark(value: boolean) {
  systemDark = value;
  act(() => listeners.forEach((cb) => cb()));
}

beforeEach(() => {
  systemDark = false;
  listeners.clear();
  localStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return systemDark;
    },
    media: query,
    addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useTheme：跟随系统', () => {
  it('没手动选过时用系统的颜色，且不往 localStorage 写任何东西', () => {
    systemDark = true;
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('页面开着时系统切换深浅色，主题实时跟着变', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');

    setSystemDark(true);
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    setSystemDark(false);
    expect(result.current.theme).toBe('light');
  });

  it('第二次访问（重新挂载）依然跟随系统——这是旧 bug 唯一漏过的场景', () => {
    const first = renderHook(() => useTheme());
    expect(first.result.current.theme).toBe('light');
    first.unmount();

    systemDark = true;
    const second = renderHook(() => useTheme());
    expect(second.result.current.theme).toBe('dark');
  });
});

describe('useTheme：手动选择', () => {
  it('toggle 反转当前显示的颜色并落盘记忆', () => {
    systemDark = true;
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    expect(result.current.theme).toBe('light');
    expect(localStorage.getItem(KEY)).toBe('manual:light');
  });

  it('手动选过之后，系统切换不再影响', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    expect(result.current.theme).toBe('dark');

    setSystemDark(true);
    setSystemDark(false);
    expect(result.current.theme).toBe('dark');
  });

  it('手动选择在下次加载时还在', () => {
    const first = renderHook(() => useTheme());
    act(() => first.result.current.toggle());
    first.unmount();

    systemDark = true;
    const second = renderHook(() => useTheme());
    expect(second.result.current.theme).toBe('dark');
    expect(localStorage.getItem(KEY)).toBe('manual:dark');
  });
});

describe('useTheme：旧格式迁移', () => {
  it('旧版误写的裸 light/dark 被清掉，当作没选过', () => {
    localStorage.setItem(KEY, 'light');
    systemDark = true;
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('认不出的值同样清掉，不让脏数据把主题钉死', () => {
    localStorage.setItem(KEY, 'blue');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
