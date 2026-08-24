// SSE 订阅层：事件名到回调的分发。整个 useStream 之前没有测试，
// 这一轮又新加了 read 事件，事件名拼错的话前端会安静地什么都不做。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStream, type StreamHandlers } from './useStream';
import { clearToken, setToken } from './api';
import { deviceId } from './push';

type Listener = (e: MessageEvent) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Listener[]>();
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), fn]);
  }

  close() { this.closed = true; }

  /** 模拟服务端推来一个事件。 */
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) || []) fn({ data: JSON.stringify(data) } as MessageEvent);
  }
}

const latest = () => FakeEventSource.instances.at(-1)!;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  setToken('tok-abc');
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

const mount = (handlers: StreamHandlers = {}, enabled = true) =>
  renderHook(() => useStream(enabled, handlers));

describe('连接', () => {
  it('把凭据放进查询串（EventSource 不能自定义请求头）', () => {
    mount();
    expect(latest().url).toMatch(/^\/api\/stream\?token=tok-abc(&|$)/);
  });

  it('凭据里的特殊字符会被转义', () => {
    setToken('a/b c');
    mount();
    expect(latest().url).toMatch(/^\/api\/stream\?token=a%2Fb%20c(&|$)/);
  });

  /**
   * device：这条 SSE 是哪台设备连的。服务端的推送判定按**设备**算在线，而不是按人 ——
   * 桌面挂着网页的时候，手机上那台照样该响，而那正是最需要手机响的时候。
   *
   * 这条单拎出来断言，是因为漏掉这个参数**不会报任何错**：服务端会把所有连接都当成
   * 「没有设备标识」，于是谁都不算在线、连你正在用的那台也一起推。合并这一批时它就漏了
   * —— useStream.ts 没有分配给任何一个任务包，六个包各自全绿，谁都没碰它。
   */
  it('带上 device：推送判定要靠它区分「这个人在线」和「这个人的这一台在线」', () => {
    mount();
    const device = new URL(latest().url, 'http://x').searchParams.get('device');
    expect(device, 'SSE 没有带 device，服务端会把所有设备都当离线').toBeTruthy();
    expect(device).toBe(deviceId());
  });

  it('device 也要转义 —— 它来自 localStorage，不能假定内容安全', () => {
    window.localStorage.setItem('loop-im-device', 'a/b c');
    mount();
    expect(latest().url).toContain('device=a%2Fb%20c');
  });

  it('没有凭据时不连', () => {
    clearToken();
    mount();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('enabled 为 false 时不连', () => {
    mount({}, false);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('卸载时关闭连接', () => {
    const { unmount } = mount();
    const es = latest();
    unmount();
    expect(es.closed).toBe(true);
  });
});

describe('事件分发', () => {
  it('read 事件带出会话、成员和已读位置', () => {
    const onRead = vi.fn();
    mount({ onRead });
    latest().emit('read', { conversationId: 'c1', userId: 'u_chen', lastReadAt: 1_700_000_000_000 });
    expect(onRead).toHaveBeenCalledWith('c1', 'u_chen', 1_700_000_000_000);
  });

  it('message 事件解包出 message 本身', () => {
    const onMessage = vi.fn();
    mount({ onMessage });
    latest().emit('message', { message: { id: 'm1', body: '你好' } });
    expect(onMessage).toHaveBeenCalledWith({ id: 'm1', body: '你好' });
  });

  it('ai-typing 事件带出会话与状态', () => {
    const onTyping = vi.fn();
    mount({ onTyping });
    latest().emit('ai-typing', { conversationId: 'c1', typing: true });
    expect(onTyping).toHaveBeenCalledWith('c1', true);
  });

  it('presence 事件带出成员与在线状态', () => {
    const onPresence = vi.fn();
    mount({ onPresence });
    latest().emit('presence', { userId: 'u_chen', online: false });
    expect(onPresence).toHaveBeenCalledWith('u_chen', false);
  });

  it('user-created 与 user-updated 都走同一个回调', () => {
    const onUserChanged = vi.fn();
    mount({ onUserChanged });
    latest().emit('user-updated', { user: { id: 'u_a' } });
    latest().emit('user-created', { user: { id: 'u_b' } });
    expect(onUserChanged).toHaveBeenCalledTimes(2);
  });

  it('reaction 事件带出会话、消息和整份聚合', () => {
    const onReaction = vi.fn();
    const reactions = [{ emoji: '👍', count: 1, users: [{ id: 'u_chen', name: '陈子航' }], mine: false }];
    mount({ onReaction });
    latest().emit('reaction', { conversationId: 'c1', messageId: 'm1', reactions });
    expect(onReaction).toHaveBeenCalledWith('c1', 'm1', reactions);
  });

  it('没有提供对应回调时收到事件也不会报错', () => {
    mount({});
    expect(() => latest().emit('read', { conversationId: 'c1', userId: 'u', lastReadAt: 1 })).not.toThrow();
  });

  it('回调更新后用的是最新那个，不会连着旧闭包', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ h }) => useStream(true, h), { initialProps: { h: { onRead: first } } });
    rerender({ h: { onRead: second } });

    latest().emit('read', { conversationId: 'c1', userId: 'u', lastReadAt: 1 });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    // 而且不该为了换回调重新建连接
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
