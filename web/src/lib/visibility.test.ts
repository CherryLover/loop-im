/**
 * 页面可见性上报。这个模块是「切后台后立刻发的消息收不到推送」那个真机 bug 的修法：
 * 服务端不再从 SSE 连接的存在去推断页面状态，改由页面自己报。
 *
 * 所以这里锁的每一条都是**不报错但会安静坏掉**的那一类：
 * - 少报一次「我切后台了」→ 服务端以为你还在前台 → 那台设备漏推（这就是原 bug）；
 * - 少报一次「我回前台了」→ 多收一条推送，只是打扰（安全的那一侧）；
 * - 去重去过头 → 同上的第一条；完全不去重 → 切一次窗口打三四个请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: { pushVisibility: vi.fn() } }));

import { api } from './api';
import { deviceId } from './push';
import {
  documentVisible, pageStreamId, reportVisibility, resetVisibilityForTest, startVisibilityReporting,
} from './visibility';

const pushVisibility = (api as unknown as { pushVisibility: ReturnType<typeof vi.fn> }).pushVisibility;

/** 把 document.visibilityState 钉成给定值，并（可选）触发一次 visibilitychange。 */
function setVisibility(state: 'visible' | 'hidden', { fire = false } = {}) {
  vi.spyOn(Object.getPrototypeOf(document), 'visibilityState' as never, 'get').mockReturnValue(state as never);
  if (fire) document.dispatchEvent(new Event('visibilitychange'));
}

const lastPayload = () => pushVisibility.mock.calls.at(-1)?.[0];

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetVisibilityForTest();
  window.localStorage.clear();
  pushVisibility.mockReset().mockResolvedValue({ ok: true, connections: 1 });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetVisibilityForTest();
});

describe('pageStreamId：这台设备上的哪一个页面', () => {
  it('同一次页面加载里问多少次都是同一个值', () => {
    expect(pageStreamId()).toBe(pageStreamId());
    expect(pageStreamId()).toBeTruthy();
  });

  it('**不写 localStorage** —— 它代表页面，不代表设备', () => {
    // 存进去的话，同一台机器上两个标签页会拿到同一个 streamId，服务端就分不开它们了，
    // 于是乙切走时那句「我在后台」会把甲的「我在前台」盖掉 —— 人正看着甲，手机照样冒推送。
    const id = pageStreamId();
    expect(Object.values({ ...window.localStorage })).not.toContain(id);
    expect(window.localStorage.getItem('loop-im-device')).not.toBe(id);
  });

  it('和 deviceId 不是同一个东西', () => {
    expect(pageStreamId()).not.toBe(deviceId());
  });
});

describe('reportVisibility：报什么、怎么去重', () => {
  it('报的是 deviceId + streamId + visible 三样，一样都不能少', () => {
    reportVisibility(true);
    expect(pushVisibility).toHaveBeenCalledTimes(1);
    expect(lastPayload()).toEqual({ deviceId: deviceId(), streamId: pageStreamId(), visible: true });
  });

  it('同一个状态连报两次只打一个请求（visibilitychange 在某些浏览器上会连发）', () => {
    reportVisibility(false);
    reportVisibility(false);
    reportVisibility(false);
    expect(pushVisibility).toHaveBeenCalledTimes(1);
  });

  it('状态真的变了就一定要发 —— 去重不能把「我切后台了」吃掉', () => {
    // 这一发是整条链路上最要紧的一发：吃掉它，服务端就一直以为这台设备在前台，
    // 那台设备从此漏推，而且没有任何报错。
    reportVisibility(true);
    reportVisibility(false);
    expect(pushVisibility).toHaveBeenCalledTimes(2);
    expect(lastPayload().visible).toBe(false);
  });

  it('force 能穿过去重 —— SSE 重连之后必须重报一遍', () => {
    // 服务端把可见性挂在**连接**上，换了一条连接就是一张白纸（默认按后台算）。
    // 本地状态没变，只有 force 能把它再报上去。
    reportVisibility(true);
    reportVisibility(true, { force: true });
    expect(pushVisibility).toHaveBeenCalledTimes(2);
  });

  it('上报失败会把去重记忆清掉，下一次同样的状态还会再报一遍', async () => {
    pushVisibility.mockRejectedValueOnce(new Error('网络抖了'));
    reportVisibility(false);
    await Promise.resolve();
    await Promise.resolve();

    reportVisibility(false);          // 状态没变，但上一发失败了，必须重发
    expect(pushVisibility).toHaveBeenCalledTimes(2);
  });

  it('上报失败不抛、不打断调用方，只 warn 一句', async () => {
    pushVisibility.mockRejectedValueOnce(new Error('网络抖了'));
    expect(() => reportVisibility(true)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
  });

  it('api 当场同步抛（模块没接上之类）也不往外冒', () => {
    pushVisibility.mockImplementationOnce(() => { throw new Error('炸了'); });
    expect(() => reportVisibility(true)).not.toThrow();
  });

  it('不返回 Promise —— 这是发射后不管，调用方不该 await 它', () => {
    expect(reportVisibility(true)).toBeUndefined();
  });
});

describe('documentVisible', () => {
  it('visibilityState 是 hidden 时是 false', () => {
    setVisibility('hidden');
    expect(documentVisible()).toBe(false);
  });

  it('visibilityState 是 visible 时是 true', () => {
    setVisibility('visible');
    expect(documentVisible()).toBe(true);
  });
});

describe('startVisibilityReporting：挂监听 + 立刻报一次', () => {
  it('一挂上就报当前状态 —— 不报的话服务端默认按后台算，开着页面也照收推送', () => {
    setVisibility('visible');
    const stop = startVisibilityReporting();
    try {
      expect(pushVisibility).toHaveBeenCalledTimes(1);
      expect(lastPayload().visible).toBe(true);
    } finally {
      stop();
    }
  });

  it('切到后台时报 false —— 这一发就是本次修复的核心', () => {
    setVisibility('visible');
    const stop = startVisibilityReporting();
    try {
      setVisibility('hidden', { fire: true });
      expect(lastPayload()).toEqual({ deviceId: deviceId(), streamId: pageStreamId(), visible: false });
    } finally {
      stop();
    }
  });

  it('切回前台时报 true —— 少了它，回到前台还在收推送', () => {
    setVisibility('visible');
    const stop = startVisibilityReporting();
    try {
      setVisibility('hidden', { fire: true });
      setVisibility('visible', { fire: true });
      expect(lastPayload().visible).toBe(true);
      expect(pushVisibility).toHaveBeenCalledTimes(3);   // 挂载 + 切走 + 切回
    } finally {
      stop();
    }
  });

  it('返回的函数能把监听摘干净', () => {
    setVisibility('visible');
    startVisibilityReporting()();
    pushVisibility.mockClear();
    setVisibility('hidden', { fire: true });
    expect(pushVisibility).not.toHaveBeenCalled();
  });
});
