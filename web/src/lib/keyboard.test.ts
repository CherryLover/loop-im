import { afterEach, describe, expect, it } from 'vitest';
import { startKeyboardInsetTracking } from './keyboard';

/**
 * jsdom 没有 visualViewport，正好从两头测：不装 → 必须优雅地什么都不做；
 * 手工装一个假的 → 验证「钉底边」的算法、scale 安全阀和清理。
 */

class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  scale = 1;
}

const vvBottom = () => document.documentElement.style.getPropertyValue('--vv-bottom');

afterEach(() => {
  delete (window as { visualViewport?: unknown }).visualViewport;
  document.documentElement.style.removeProperty('--vv-bottom');
});

describe('软键盘可视底边追踪', () => {
  it('没有 visualViewport 的环境：不写变量、不报错', () => {
    const stop = startKeyboardInsetTracking();
    expect(vvBottom()).toBe('');
    stop();
  });

  it('底边 = offsetTop + height，键盘的起收和系统的上推都跟着钉', () => {
    const vv = new FakeViewport();
    (window as unknown as { visualViewport: FakeViewport }).visualViewport = vv;

    // 装载那一刻就得写一次（此刻可能已经处于键盘弹起态）。
    const stop = startKeyboardInsetTracking();
    expect(vvBottom()).toBe('800px');

    // 键盘占掉 336px：iOS 上表现为 visualViewport 变矮 + 整页被系统上推 20px，
    // 可视底边 = 20 + 444。两个字段同一次事件里读，不存在过期失配。
    vv.height = 444;
    vv.offsetTop = 20;
    vv.dispatchEvent(new Event('resize'));
    expect(vvBottom()).toBe('464px');

    // 系统把上推又收回去：底边跟着回到键盘上沿。
    vv.offsetTop = 0;
    vv.dispatchEvent(new Event('scroll'));
    expect(vvBottom()).toBe('444px');

    // 键盘收起，恢复整屏。
    vv.height = 800;
    vv.dispatchEvent(new Event('resize'));
    expect(vvBottom()).toBe('800px');

    stop();
  });

  it('整页放大（scale > 1）时摘掉变量、完全不干预', () => {
    const vv = new FakeViewport();
    (window as unknown as { visualViewport: FakeViewport }).visualViewport = vv;

    const stop = startKeyboardInsetTracking();
    expect(vvBottom()).toBe('800px');

    // 双指放大到 2 倍：vv.height 变小是缩放造成的，不是键盘，绝不能跟着缩 .app。
    vv.scale = 2;
    vv.height = 400;
    vv.dispatchEvent(new Event('resize'));
    expect(vvBottom()).toBe('');

    // 缩回 1 倍：恢复追踪。
    vv.scale = 1;
    vv.height = 800;
    vv.dispatchEvent(new Event('resize'));
    expect(vvBottom()).toBe('800px');

    stop();
  });

  it('停止追踪：变量摘掉，后续事件不再生效', () => {
    const vv = new FakeViewport();
    (window as unknown as { visualViewport: FakeViewport }).visualViewport = vv;

    const stop = startKeyboardInsetTracking();
    vv.height = 500;
    vv.dispatchEvent(new Event('resize'));
    expect(vvBottom()).toBe('500px');

    stop();
    expect(vvBottom()).toBe('');
    vv.height = 400;
    vv.dispatchEvent(new Event('resize'));
    expect(vvBottom()).toBe('');
  });
});
