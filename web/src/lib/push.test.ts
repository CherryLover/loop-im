// Web Push 的前端一侧 + Service Worker 的 push / notificationclick。
//
// 这个文件锁的是三条**代价极不对称**的约束——违反了不会报错，只会安静地坏掉：
//
// 1. **收到推送必须弹通知，一次都不能省。** WebKit 会因为一次「没弹」永久吊销这台
//    设备的订阅，用户毫不知情，我们也收不到任何错误。所以 payload 坏掉、payload 为空、
//    角标 API 抛异常……每一条路都要有一条用例钉住「照样弹」。
// 2. **每次启动都要重新订阅。** iOS 没有 pushsubscriptionchange 事件，「本地存过就跳过」
//    这个看起来无害的优化，等于把「订阅失效」变成永久失效。
// 3. **关掉开关要真的退订并通知服务端**，否则服务端还在推，用户看到的是一个「已关闭」
//    的开关加一屏还在冒的通知。
//
// sw.js 是浏览器直接加载的普通脚本（在 public/ 下，不参与打包），没法 import。
// 这里用 `?raw` 把源码读进来，塞进一个假的 `self` 里跑——测的就是仓库里那一份源码，
// 一个字不差，而不是一份「照着它写的」复刻。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import swSource from '../../public/sw.js?raw';

vi.mock('./api', () => ({
  api: {
    pushConfig: vi.fn(),
    pushSubscribe: vi.fn(),
    pushUnsubscribe: vi.fn(),
  },
}));

import { api } from './api';
import {
  applyAppBadge, base64UrlToBytes, deviceId, ensurePushSubscription,
  notifyRegistration, primeServiceWorker, resetPushStateForTest, serializeSubscription,
  unsubscribePush,
} from './push';
import { notifyEnabledConfirmation, NOTIFY_ENABLED_TITLE } from './notify';

const mockApi = api as unknown as {
  pushConfig: ReturnType<typeof vi.fn>;
  pushSubscribe: ReturnType<typeof vi.fn>;
  pushUnsubscribe: ReturnType<typeof vi.fn>;
};

// ── 环境替身 ────────────────────────────────────────────────────────────────

/** jsdom 没有 navigator.serviceWorker，所以「不支持」是这里的**默认状态**。 */
function stubServiceWorker(value: unknown) {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value });
}

function clearServiceWorker() {
  // @ts-expect-error 测试要把这个属性整个拿掉，恢复 jsdom 的默认状态
  delete navigator.serviceWorker;
}

/** 一个够用的 PushSubscription 替身。 */
function fakeSubscription(endpoint = 'https://push.example/abc') {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'PUB-KEY', auth: 'AUTH-KEY' } }),
    getKey: () => null,
    unsubscribe: vi.fn(async () => true),
  };
}

/** 一个够用的 ServiceWorkerRegistration 替身。返回值刻意放宽成 unknown，
 *  各条用例才能用 mockResolvedValue 塞进各种畸形的订阅。 */
function fakeRegistration(over: Record<string, unknown> = {}) {
  const subscribe = vi.fn(async (_options?: Record<string, unknown>): Promise<unknown> => fakeSubscription());
  const getSubscription = vi.fn(async (): Promise<unknown> => null);
  return {
    showNotification: vi.fn(async (_title?: string, _options?: Record<string, unknown>) => undefined),
    pushManager: { subscribe, getSubscription },
    ...over,
  };
}

/** 装上 SW，并让 `navigator.serviceWorker.ready` 立刻给出这个 registration。 */
function readyWith(registration: unknown) {
  stubServiceWorker({ ready: Promise.resolve(registration) });
}

function stubNotificationPermission(permission: 'default' | 'granted' | 'denied') {
  vi.stubGlobal('Notification', class {
    static permission = permission;
    static requestPermission = vi.fn();
  });
}

beforeEach(() => {
  resetPushStateForTest();
  clearServiceWorker();
  window.localStorage.clear();
  mockApi.pushConfig.mockReset();
  mockApi.pushSubscribe.mockReset();
  mockApi.pushUnsubscribe.mockReset();
  mockApi.pushConfig.mockResolvedValue({ enabled: true, publicKey: 'BBBB' });
  mockApi.pushSubscribe.mockResolvedValue({ ok: true });
  mockApi.pushUnsubscribe.mockResolvedValue({});
  stubNotificationPermission('granted');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  clearServiceWorker();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── deviceId ────────────────────────────────────────────────────────────────

describe('deviceId：这台设备的稳定标识', () => {
  it('第一次生成并写进 localStorage，之后每次都返回同一个', () => {
    const first = deviceId();
    expect(first).toBeTruthy();
    expect(window.localStorage.getItem('loop-im-device')).toBe(first);
    expect(deviceId()).toBe(first);
  });

  it('localStorage 读写都抛（隐私模式）时照样给得出一个 id，不抛异常', () => {
    const store = window.localStorage;
    const boom = () => { throw new Error('隐私模式'); };
    vi.spyOn(store, 'getItem').mockImplementation(boom);
    vi.spyOn(store, 'setItem').mockImplementation(boom);
    // 退化成「每次启动算一台新设备」：多推一条，不会出错。这正是设计里认下的代价。
    expect(deviceId()).toBeTruthy();
    expect(() => deviceId()).not.toThrow();
  });

  it('crypto.randomUUID 缺席时退回自造的 id', () => {
    vi.stubGlobal('crypto', {});
    expect(deviceId()).toMatch(/^d_/);
  });
});

// ── base64url → 字节 ────────────────────────────────────────────────────────

describe('base64UrlToBytes：VAPID 公钥要变成 applicationServerKey 认的字节', () => {
  it('认 base64url 的 - _ 和缺失的填充', () => {
    // 'ab~' 的标准 base64 是 'YWJ+'，base64url 里 + 写成 -，且没有 = 填充。
    expect(Array.from(base64UrlToBytes('YWJ-'))).toEqual([97, 98, 126]);
    // 长度不是 4 的倍数 → 要自己补 '='
    expect(Array.from(base64UrlToBytes('YWJj'))).toEqual([97, 98, 99]);
    expect(Array.from(base64UrlToBytes('YQ'))).toEqual([97]);
  });
});

// ── serializeSubscription ───────────────────────────────────────────────────

describe('serializeSubscription：抠出服务端要的三个字段', () => {
  it('优先用 toJSON()', () => {
    expect(serializeSubscription(fakeSubscription() as unknown as PushSubscription)).toEqual({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'PUB-KEY', auth: 'AUTH-KEY' },
    });
  });

  it('toJSON 缺席时退回 getKey() 自己编码成 base64url', () => {
    const sub = {
      endpoint: 'https://push.example/xyz',
      getKey: (name: string) => new Uint8Array(name === 'auth' ? [1, 2, 3] : [255, 254]).buffer,
    };
    expect(serializeSubscription(sub as unknown as PushSubscription)).toEqual({
      endpoint: 'https://push.example/xyz',
      keys: { p256dh: '__4', auth: 'AQID' },
    });
  });

  it('拿不到密钥就返回 null —— 一条缺 key 的订阅上报上去只会让每次群发多一次注定失败的请求', () => {
    const sub = { endpoint: 'https://push.example/xyz', getKey: () => null };
    expect(serializeSubscription(sub as unknown as PushSubscription)).toBeNull();
  });
});

// ── 订阅流程 ────────────────────────────────────────────────────────────────

describe('ensurePushSubscription：拿公钥 → subscribe → 上报', () => {
  it('走通全程：公钥转成字节、userVisibleOnly 为 true、上报带 deviceId 和 endpoint', async () => {
    const reg = fakeRegistration();
    readyWith(reg);

    await expect(ensurePushSubscription()).resolves.toBe(true);

    expect(mockApi.pushConfig).toHaveBeenCalledTimes(1);
    const options = reg.pushManager.subscribe.mock.calls[0][0]!;
    // ⚠️ userVisibleOnly 必须是 true：承诺了每条推送都弹却不弹，WebKit 会永久吊销订阅。
    expect(options.userVisibleOnly).toBe(true);
    expect(Array.from(options.applicationServerKey as Uint8Array))
      .toEqual(Array.from(base64UrlToBytes('BBBB')));

    expect(mockApi.pushSubscribe).toHaveBeenCalledWith({
      deviceId: window.localStorage.getItem('loop-im-device'),
      subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'PUB-KEY', auth: 'AUTH-KEY' } },
    });
  });

  it('⚠️ 每次启动都重新订阅一次，绝不因为「上次订过」就跳过', async () => {
    // 这条是 iOS 没有 pushsubscriptionchange 事件的唯一补救：订阅失效时我们收不到
    // 任何通知，只能靠每次启动重来一遍。加一个「本地存过就跳过」的缓存会让这条失效，
    // 而且失效得毫无声息 —— 所以这里连着调三次，三次都得真的走到 subscribe。
    const reg = fakeRegistration();
    readyWith(reg);

    await ensurePushSubscription();
    await ensurePushSubscription();
    await ensurePushSubscription();

    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(3);
    expect(mockApi.pushSubscribe).toHaveBeenCalledTimes(3);
  });

  it('权限不是 granted 时**不**调 subscribe —— 它会直接 reject，还可能顺手弹一次权限框', async () => {
    const reg = fakeRegistration();
    readyWith(reg);
    stubNotificationPermission('default');

    await expect(ensurePushSubscription()).resolves.toBe(false);
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    expect(mockApi.pushConfig).not.toHaveBeenCalled();
  });

  it('权限被拒时同样不订阅', async () => {
    const reg = fakeRegistration();
    readyWith(reg);
    stubNotificationPermission('denied');
    await expect(ensurePushSubscription()).resolves.toBe(false);
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('浏览器根本没有 Notification（低于 iOS 16.4）时不订阅', async () => {
    const reg = fakeRegistration();
    readyWith(reg);
    vi.stubGlobal('Notification', undefined);
    await expect(ensurePushSubscription()).resolves.toBe(false);
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('服务端 enabled:false（没配 VAPID）时整条路径跳过，不拿 null 公钥去 subscribe', async () => {
    const reg = fakeRegistration();
    readyWith(reg);
    mockApi.pushConfig.mockResolvedValue({ enabled: false, publicKey: null });

    await expect(ensurePushSubscription()).resolves.toBe(false);
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    expect(mockApi.pushSubscribe).not.toHaveBeenCalled();
  });

  it('enabled 是 true 但公钥是空的，也要跳过（配了一半比没配更容易漏）', async () => {
    const reg = fakeRegistration();
    readyWith(reg);
    mockApi.pushConfig.mockResolvedValue({ enabled: true, publicKey: null });
    await expect(ensurePushSubscription()).resolves.toBe(false);
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('没有 serviceWorker（jsdom / 老浏览器 / 非安全上下文）时返回 false，不碰任何接口', async () => {
    await expect(ensurePushSubscription()).resolves.toBe(false);
    expect(mockApi.pushConfig).not.toHaveBeenCalled();
  });

  it('registration 没有 pushManager 时优雅降级', async () => {
    readyWith({ showNotification: vi.fn() });
    await expect(ensurePushSubscription()).resolves.toBe(false);
    expect(mockApi.pushConfig).not.toHaveBeenCalled();
  });

  it('subscribe 抛异常时返回 false 且不抛（页面不能崩）', async () => {
    const reg = fakeRegistration();
    reg.pushManager.subscribe.mockRejectedValue(new Error('AbortError: 推送服务不可用'));
    readyWith(reg);
    await expect(ensurePushSubscription()).resolves.toBe(false);
  });

  it('拿公钥的请求失败时返回 false 且不抛', async () => {
    readyWith(fakeRegistration());
    mockApi.pushConfig.mockRejectedValue(new Error('500'));
    await expect(ensurePushSubscription()).resolves.toBe(false);
  });

  it('上报请求失败时返回 false 且不抛（下次启动会再试）', async () => {
    readyWith(fakeRegistration());
    mockApi.pushSubscribe.mockRejectedValue(new Error('网络错误'));
    await expect(ensurePushSubscription()).resolves.toBe(false);
  });

  it('订阅缺 endpoint / 密钥时不上报', async () => {
    const reg = fakeRegistration();
    reg.pushManager.subscribe.mockResolvedValue({ endpoint: '', toJSON: () => ({}), getKey: () => null });
    readyWith(reg);
    await expect(ensurePushSubscription()).resolves.toBe(false);
    expect(mockApi.pushSubscribe).not.toHaveBeenCalled();
  });

  it('serviceWorker.ready 永远不结算时不会一直挂着 —— 超时后当作没有 SW', async () => {
    // ready 在**注册失败**时既不 resolve 也不 reject。没有这道超时，
    // 所有 await 它的地方都会静静地悬一辈子。
    vi.useFakeTimers();
    stubServiceWorker({ ready: new Promise(() => {}) });
    const pending = ensurePushSubscription();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBe(false);
    vi.useRealTimers();
  });
});

// ── 退订 ────────────────────────────────────────────────────────────────────

describe('unsubscribePush：关掉开关要真的退订 + 通知服务端', () => {
  it('两件事都做：本地 unsubscribe()，并把 endpoint 报给服务端删除', async () => {
    const sub = fakeSubscription();
    const reg = fakeRegistration();
    reg.pushManager.getSubscription.mockResolvedValue(sub);
    readyWith(reg);

    await unsubscribePush();

    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mockApi.pushUnsubscribe).toHaveBeenCalledWith('https://push.example/abc');
  });

  it('本地退订抛异常时，仍然通知服务端（否则服务端会继续往这台设备推）', async () => {
    const sub = fakeSubscription();
    sub.unsubscribe.mockRejectedValue(new Error('退订失败'));
    const reg = fakeRegistration();
    reg.pushManager.getSubscription.mockResolvedValue(sub);
    readyWith(reg);

    await expect(unsubscribePush()).resolves.toBeUndefined();
    expect(mockApi.pushUnsubscribe).toHaveBeenCalledWith('https://push.example/abc');
  });

  it('通知服务端失败也不抛 —— 服务端下次推过去会收到 410，自己会清掉', async () => {
    const sub = fakeSubscription();
    const reg = fakeRegistration();
    reg.pushManager.getSubscription.mockResolvedValue(sub);
    readyWith(reg);
    mockApi.pushUnsubscribe.mockRejectedValue(new Error('网络错误'));

    await expect(unsubscribePush()).resolves.toBeUndefined();
    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it('本来就没有订阅时什么都不做', async () => {
    const reg = fakeRegistration();
    readyWith(reg);
    await unsubscribePush();
    expect(mockApi.pushUnsubscribe).not.toHaveBeenCalled();
  });

  it('没有 serviceWorker 时安静返回', async () => {
    await expect(unsubscribePush()).resolves.toBeUndefined();
    expect(mockApi.pushUnsubscribe).not.toHaveBeenCalled();
  });

  it('读取现有订阅时抛异常也不炸', async () => {
    const reg = fakeRegistration();
    reg.pushManager.getSubscription.mockRejectedValue(new Error('读不到'));
    readyWith(reg);
    await expect(unsubscribePush()).resolves.toBeUndefined();
  });
});

// ── 角标 ────────────────────────────────────────────────────────────────────

describe('applyAppBadge：主屏图标上的未读数', () => {
  it('大于 0 调 setAppBadge，等于 0 调 clearAppBadge', () => {
    const setAppBadge = vi.fn(async () => {});
    const clearAppBadge = vi.fn(async () => {});
    Object.assign(navigator, { setAppBadge, clearAppBadge });
    try {
      applyAppBadge(7);
      expect(setAppBadge).toHaveBeenCalledWith(7);
      applyAppBadge(0);
      expect(clearAppBadge).toHaveBeenCalledTimes(1);
    } finally {
      // @ts-expect-error 清掉测试塞进去的属性
      delete navigator.setAppBadge;
      // @ts-expect-error 同上
      delete navigator.clearAppBadge;
    }
  });

  it('⚠️ 两个 API 都不存在时不抛 —— Badging 要 iOS 16.4+，桌面 Safari 至今没有', () => {
    expect('setAppBadge' in navigator).toBe(false);
    expect(() => applyAppBadge(3)).not.toThrow();
    expect(() => applyAppBadge(0)).not.toThrow();
  });

  it('API 存在但 reject（非独立模式下会这样）时也不抛', async () => {
    Object.assign(navigator, { setAppBadge: vi.fn(() => Promise.reject(new Error('拒绝'))) });
    try {
      expect(() => applyAppBadge(2)).not.toThrow();
      await Promise.resolve();
    } finally {
      // @ts-expect-error 清掉测试塞进去的属性
      delete navigator.setAppBadge;
    }
  });
});

// ── 通知的统一入口 ──────────────────────────────────────────────────────────

describe('notify.ts 统一到 showNotification', () => {
  it('拿到 registration 之后就走 registration.showNotification，不再 new Notification', async () => {
    const reg = fakeRegistration();
    readyWith(reg);
    await primeServiceWorker();
    expect(notifyRegistration()).toBe(reg);

    const constructed: string[] = [];
    vi.stubGlobal('Notification', class {
      static permission = 'granted';
      constructor(title: string) { constructed.push(title); }
    });

    expect(notifyEnabledConfirmation()).toBe(true);
    expect(reg.showNotification).toHaveBeenCalledTimes(1);
    expect(reg.showNotification.mock.calls[0][0]).toBe(NOTIFY_ENABLED_TITLE);
    // iOS 主屏 App 里 new Notification 根本不能用，所以有 SW 时必须走上面那条。
    expect(constructed).toEqual([]);
  });

  it('没有 registration（桌面浏览器还没就绪 / 压根没 SW）时退回构造函数', () => {
    expect(notifyRegistration()).toBeNull();
    const constructed: string[] = [];
    vi.stubGlobal('Notification', class {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(title: string) { constructed.push(title); }
    });

    expect(notifyEnabledConfirmation()).toBe(true);
    expect(constructed).toEqual([NOTIFY_ENABLED_TITLE]);
  });

  it('showNotification 同步抛时退回构造函数，不是直接失败', async () => {
    const reg = fakeRegistration({
      showNotification: vi.fn(() => { throw new Error('权限刚被撤'); }),
    });
    readyWith(reg);
    await primeServiceWorker();

    const constructed: string[] = [];
    vi.stubGlobal('Notification', class {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(title: string) { constructed.push(title); }
    });

    expect(notifyEnabledConfirmation()).toBe(true);
    expect(constructed).toEqual([NOTIFY_ENABLED_TITLE]);
  });
});

// ── sw.js：把仓库里那份源码真的跑起来 ───────────────────────────────────────

interface SwHarness {
  fire: (type: string, event: Record<string, unknown>) => Promise<void>;
  types: string[];
  showNotification: ReturnType<typeof vi.fn>;
  setAppBadge: ReturnType<typeof vi.fn>;
  clearAppBadge: ReturnType<typeof vi.fn>;
  matchAll: ReturnType<typeof vi.fn>;
  openWindow: ReturnType<typeof vi.fn>;
  order: string[];
}

/**
 * 把 public/sw.js 的源码塞进一个假的 `self` 里执行，把它注册的监听收集起来。
 *
 * 用 `new Function('self', src)` 而不是 import：sw.js 是浏览器直接加载的普通脚本
 * （不是模块，也不参与打包），`self` 是它唯一的全局入口。这样测到的就是仓库里那一份
 * 源码本身——线上跑的和这里跑的逐字节相同。
 */
function loadSw(over: Record<string, unknown> = {}): SwHarness {
  const listeners: Record<string, (event: unknown) => void> = {};
  const order: string[] = [];
  const showNotification = vi.fn(async (_title?: string, _options?: Record<string, unknown>) => {
    order.push('showNotification');
  });
  const setAppBadge = vi.fn(async (_count?: number) => { order.push('setAppBadge'); });
  const clearAppBadge = vi.fn(async () => { order.push('clearAppBadge'); });
  const matchAll = vi.fn(async (_query?: Record<string, unknown>): Promise<unknown[]> => []);
  const openWindow = vi.fn(async (_url?: string) => { order.push('openWindow'); return null; });

  const fakeSelf = {
    addEventListener: (type: string, handler: (event: unknown) => void) => { listeners[type] = handler; },
    skipWaiting: vi.fn(),
    registration: { showNotification },
    clients: { claim: vi.fn(), matchAll, openWindow },
    navigator: { setAppBadge, clearAppBadge },
    ...over,
  };

  new Function('self', swSource)(fakeSelf);

  return {
    types: Object.keys(listeners),
    order,
    showNotification,
    setAppBadge,
    clearAppBadge,
    matchAll,
    openWindow,
    fire: async (type, event) => {
      let waited: unknown = undefined;
      const handler = listeners[type];
      if (!handler) throw new Error(`sw.js 没有注册 ${type} 监听`);
      handler({ ...event, waitUntil: (p: unknown) => { waited = p; } });
      await waited;
    },
  };
}

/** 一个 PushEvent 的 data：json() 要么给出这个对象，要么按 throws 抛。 */
const pushData = (payload: unknown) => ({ json: () => payload });
const brokenData = { json: () => { throw new SyntaxError('Unexpected token < in JSON'); } };

describe('sw.js：push handler —— 收到就弹，没有任何一条不弹的分支', () => {
  it('只注册了 install / activate / push / notificationclick 四个监听', () => {
    expect(loadSw().types.sort()).toEqual(['activate', 'install', 'notificationclick', 'push']);
  });

  it('payload 正常：标题、正文、tag、conversationId 都照 payload 来', async () => {
    const sw = loadSw();
    await sw.fire('push', {
      data: pushData({
        title: '陈子航 · 发版协作',
        body: '明天的发版要不要提前？',
        tag: 'loop-im:c_abc123',
        conversationId: 'c_abc123',
      }),
    });

    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = sw.showNotification.mock.calls[0];
    expect(title).toBe('陈子航 · 发版协作');
    expect(options.body).toBe('明天的发版要不要提前？');
    expect(options.tag).toBe('loop-im:c_abc123');
    expect(options.data).toEqual({ conversationId: 'c_abc123' });
    // iOS 上自定义 actions 根本不显示（只有系统的「查看」），所以一个都不许有。
    expect(options.actions).toBeUndefined();
  });

  it('⚠️ payload 损坏（json() 抛）时**照样弹**一条兜底的', async () => {
    // 这条是整个文件里最重要的一条。在 push handler 里 return 一次，
    // 代价是这台设备的订阅被 WebKit 永久吊销 —— 用户毫不知情，我们也收不到任何错误。
    const sw = loadSw();
    await sw.fire('push', { data: brokenData });

    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = sw.showNotification.mock.calls[0];
    expect(title).toBe('Loop IM');
    expect(options.body).toBe('你有一条新消息');
    expect(options.tag).toBe('loop-im:fallback');
    expect(options.data).toEqual({ conversationId: null });
  });

  it('⚠️ event.data 是 null（推了一条空的）时照样弹', async () => {
    const sw = loadSw();
    await sw.fire('push', { data: null });
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    expect(sw.showNotification.mock.calls[0][0]).toBe('Loop IM');
  });

  it('⚠️ payload 是合法 JSON 但不是对象（数字 / 字符串 / null）时照样弹', async () => {
    for (const payload of [42, 'hello', null, []]) {
      const sw = loadSw();
      await sw.fire('push', { data: pushData(payload) });
      expect(sw.showNotification).toHaveBeenCalledTimes(1);
      expect(sw.showNotification.mock.calls[0][0]).toBe('Loop IM');
    }
  });

  it('⚠️ payload 里的字段是空串 / 非字符串时，逐个落到兜底，仍然只弹这一条', async () => {
    const sw = loadSw();
    await sw.fire('push', { data: pushData({ title: '', body: 123, tag: null, conversationId: 'c_9' }) });
    const [title, options] = sw.showNotification.mock.calls[0];
    expect(title).toBe('Loop IM');
    expect(options.body).toBe('你有一条新消息');
    // tag 缺席但有会话 id：按会话拼，保证和前台 notifyMessage 的 tag 一致（互相覆盖）。
    expect(options.tag).toBe('loop-im:c_9');
  });

  it('badge 排在 showNotification 之后 —— 顺序本身就是安全属性', async () => {
    const sw = loadSw();
    await sw.fire('push', { data: pushData({ title: 'x', body: 'y', badge: 7 }) });
    expect(sw.setAppBadge).toHaveBeenCalledWith(7);
    expect(sw.order).toEqual(['showNotification', 'setAppBadge']);
  });

  it('badge 为 0 时清掉角标', async () => {
    const sw = loadSw();
    await sw.fire('push', { data: pushData({ title: 'x', badge: 0 }) });
    expect(sw.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it('⚠️ Badging API 抛异常时，通知已经弹出去了，而且整条 waitUntil 不会 reject', async () => {
    const sw = loadSw();
    sw.setAppBadge.mockRejectedValue(new Error('不支持'));
    await expect(sw.fire('push', { data: pushData({ title: 'x', badge: 3 }) })).resolves.toBeUndefined();
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
  });

  it('⚠️ 连 self.navigator 都没有时也不炸，通知照弹', async () => {
    const sw = loadSw({ navigator: undefined });
    await sw.fire('push', { data: pushData({ title: 'x', badge: 3 }) });
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
  });
});

describe('sw.js：notificationclick 的降级链', () => {
  const clickEvent = (conversationId: string | null) => {
    const close = vi.fn();
    return { event: { notification: { close, data: { conversationId } } }, close };
  };

  it('有窗口开着：focus + postMessage，**不**碰 openWindow', async () => {
    const sw = loadSw();
    const client = { focus: vi.fn(async () => {}), postMessage: vi.fn() };
    sw.matchAll.mockResolvedValue([client]);

    const { event, close } = clickEvent('c_abc');
    await sw.fire('notificationclick', event);

    expect(close).toHaveBeenCalledTimes(1);
    expect(sw.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(client.postMessage).toHaveBeenCalledWith({ type: 'open-conversation', conversationId: 'c_abc' });
    // openWindow 在 Safari / iOS 上有「不报错也不做事」的已知问题，能不用就不用。
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('focus() 被拒时仍然 postMessage —— 窗口确实在，页面收得到就能跳', async () => {
    const sw = loadSw();
    const client = { focus: vi.fn(async () => { throw new Error('不允许聚焦'); }), postMessage: vi.fn() };
    sw.matchAll.mockResolvedValue([client]);

    await sw.fire('notificationclick', clickEvent('c_abc').event);
    expect(client.postMessage).toHaveBeenCalledWith({ type: 'open-conversation', conversationId: 'c_abc' });
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('postMessage 抛异常（页面正在卸载）时不炸', async () => {
    const sw = loadSw();
    const client = { focus: vi.fn(async () => {}), postMessage: vi.fn(() => { throw new Error('已卸载'); }) };
    sw.matchAll.mockResolvedValue([client]);
    await expect(sw.fire('notificationclick', clickEvent('c_abc').event)).resolves.toBeUndefined();
  });

  it('一个窗口都没有：才用 openWindow 兜底，带上会话 id', async () => {
    const sw = loadSw();
    sw.matchAll.mockResolvedValue([]);
    await sw.fire('notificationclick', clickEvent('c_abc').event);
    expect(sw.openWindow).toHaveBeenCalledWith('/?c=c_abc');
  });

  it('没有会话 id（兜底通知）时 openWindow 只开首页', async () => {
    const sw = loadSw();
    sw.matchAll.mockResolvedValue([]);
    await sw.fire('notificationclick', clickEvent(null).event);
    expect(sw.openWindow).toHaveBeenCalledWith('/');
  });

  it('matchAll 抛异常时落到 openWindow，不是整个失败', async () => {
    const sw = loadSw();
    sw.matchAll.mockRejectedValue(new Error('拿不到窗口列表'));
    await sw.fire('notificationclick', clickEvent('c_1').event);
    expect(sw.openWindow).toHaveBeenCalledWith('/?c=c_1');
  });

  it('openWindow 抛异常时也不炸（iOS 上它本来就不保证有用）', async () => {
    const sw = loadSw();
    sw.matchAll.mockResolvedValue([]);
    sw.openWindow.mockRejectedValue(new Error('没反应'));
    await expect(sw.fire('notificationclick', clickEvent('c_1').event)).resolves.toBeUndefined();
  });

  it('连 openWindow 都不存在时安静收场 —— 点不动最多是回不到那个会话', async () => {
    const sw = loadSw({ clients: { claim: vi.fn(), matchAll: vi.fn(async () => []) } });
    await expect(sw.fire('notificationclick', clickEvent('c_1').event)).resolves.toBeUndefined();
  });

  it('通知的 data 整个缺席时不抛', async () => {
    const sw = loadSw();
    sw.matchAll.mockResolvedValue([]);
    const close = vi.fn();
    await sw.fire('notificationclick', { notification: { close, data: null } });
    expect(sw.openWindow).toHaveBeenCalledWith('/');
  });
});
