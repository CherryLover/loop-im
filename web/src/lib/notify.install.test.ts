// 通知状态机的 'needs-install' 那一档：iOS 上「先添加到主屏幕」。
//
// 为什么值得单开一个文件（而不是塞进 notifications.test.tsx）：这一档的难点全在
// **环境探测**上——两个 API（window.matchMedia、navigator.standalone）在 jsdom 里
// 压根不存在，iPadOS 的 UA 又和桌面 Mac 一模一样。这些组合要是用 AppShell 整体渲染
// 去覆盖，既慢，又看不出到底是哪一条判据在起作用。所以这里直接对着三个函数打，
// 界面上那句话由 notifications.test.tsx 负责。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isIosWebKit, isStandaloneDisplay, notifyPermission } from './notify';

// 真机抓下来的 UA，别改成简写——第 2 条判据靠的就是「iPadOS 和 Mac 长得一模一样」。
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_IPAD_LEGACY = 'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1';
/** iPadOS 13+ 的默认 UA。和 UA_MAC 逐字节相同，这正是那条坑。 */
const UA_IPADOS_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const UA_MAC = UA_IPADOS_DESKTOP;
const UA_ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
const UA_WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
/**
 * jsdom 自己的 UA，在任何桩装上去之前抓下来。
 * 特意用真货而不是随便编一个字符串：它长这样
 * `Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/30.0.1`——
 * **里面有 AppleWebKit**。谁要是把 isIosWebKit 写成认 "AppleWebKit"，
 * 整个测试套件自己就会先变红。
 */
const UA_JSDOM = navigator.userAgent;

interface Env {
  ua?: string;
  /** Mac / iPad 之争唯一的区分点。不给就当这个 API 不存在（jsdom 就是这样）。 */
  maxTouchPoints?: number;
  /** iOS 的私有属性。不给就当这个属性不存在，而不是 false。 */
  standalone?: boolean;
  /** window.matchMedia 存不存在；存在时 (display-mode: standalone) 的结果。 */
  displayModeStandalone?: boolean;
  /** matchMedia 直接抛（个别老 WebKit 遇到不认识的媒体特性就这样）。 */
  matchMediaThrows?: boolean;
}

/**
 * 造一个环境。**没传的字段一律当作「这个 API 不存在」**，不是 false——
 * jsdom 的默认状态就是全都不存在，这个默认值直接把「jsdom 下不能崩」那条覆盖掉了。
 */
function env(over: Env = {}) {
  const nav: Record<string, unknown> = { userAgent: over.ua ?? UA_JSDOM };
  if (over.maxTouchPoints !== undefined) nav.maxTouchPoints = over.maxTouchPoints;
  if (over.standalone !== undefined) nav.standalone = over.standalone;
  vi.stubGlobal('navigator', nav);

  if (over.matchMediaThrows) {
    vi.stubGlobal('matchMedia', () => { throw new Error('unknown media feature'); });
  } else if (over.displayModeStandalone !== undefined) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('display-mode: standalone') && over.displayModeStandalone === true,
      media: query,
    }));
  }
  // displayModeStandalone / matchMediaThrows 都不给 → 不装 matchMedia，
  // 保持 jsdom 原样（typeof window.matchMedia === 'undefined'）。
}

/** 有 Notification（值本身不重要，只要 typeof 不是 'undefined'）。 */
const withNotification = (permission: NotificationPermission = 'default') =>
  vi.stubGlobal('Notification', { permission });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isStandaloneDisplay —— 两个 API 都要认，都要能不存在', () => {
  it('jsdom：matchMedia 和 navigator.standalone 都不存在时返回 false，且不抛', () => {
    env();
    expect(typeof window.matchMedia).toBe('undefined');
    expect((window.navigator as { standalone?: boolean }).standalone).toBeUndefined();
    expect(() => isStandaloneDisplay()).not.toThrow();
    expect(isStandaloneDisplay()).toBe(false);
  });

  it('display-mode: standalone 命中 → true（标准路，Android / 桌面 / iOS 16.4+）', () => {
    env({ displayModeStandalone: true });
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('有 matchMedia 但 display-mode 不匹配（普通标签页）→ false', () => {
    env({ displayModeStandalone: false });
    expect(isStandaloneDisplay()).toBe(false);
  });

  it('老 iOS：只有 navigator.standalone === true，没有 matchMedia → 仍要认出来', () => {
    // 这一条是「两条路都要认」的正身：只留标准媒体查询的话，老 iOS 会被判成没装。
    env({ ua: UA_IPAD_LEGACY, standalone: true });
    expect(typeof window.matchMedia).toBe('undefined');
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('navigator.standalone === false（iOS 标签页里它是 false，不是缺失）→ 回落到媒体查询', () => {
    env({ ua: UA_IPHONE, standalone: false, displayModeStandalone: false });
    expect(isStandaloneDisplay()).toBe(false);
  });

  it('navigator.standalone 是 false 但媒体查询说 standalone → 认媒体查询', () => {
    env({ ua: UA_IPHONE, standalone: false, displayModeStandalone: true });
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('matchMedia 抛异常时兜住，返回 false 而不是把页面带崩', () => {
    env({ matchMediaThrows: true });
    expect(() => isStandaloneDisplay()).not.toThrow();
    expect(isStandaloneDisplay()).toBe(false);
  });
});

describe('isIosWebKit —— 判据、以及它的已知误判', () => {
  it('iPhone UA → true', () => {
    env({ ua: UA_IPHONE });
    expect(isIosWebKit()).toBe(true);
  });

  it('老 iPad UA（UA 里真有 iPad）→ true', () => {
    env({ ua: UA_IPAD_LEGACY });
    expect(isIosWebKit()).toBe(true);
  });

  it('iPadOS 13+ 的桌面 UA + maxTouchPoints=5 → true（这是第 2 条判据存在的唯一理由）', () => {
    env({ ua: UA_IPADOS_DESKTOP, maxTouchPoints: 5 });
    expect(isIosWebKit()).toBe(true);
  });

  it('同一条 UA、maxTouchPoints=0 → false，真 Mac 不能被当成 iPad', () => {
    // UA 完全相同，只有触摸点数不一样。这一条和上一条是一对，缺了任何一条都说明
    // 第 2 条判据要么形同虚设、要么把所有 Mac 都误伤了。
    expect(UA_MAC).toBe(UA_IPADOS_DESKTOP);
    env({ ua: UA_MAC, maxTouchPoints: 0 });
    expect(isIosWebKit()).toBe(false);
  });

  it('Mac 上连 maxTouchPoints 都没有（老浏览器）→ false，不能因为 undefined 就误判', () => {
    env({ ua: UA_MAC });
    expect(isIosWebKit()).toBe(false);
  });

  it('Android Chrome → false（UA 里有 AppleWebKit，绝不能拿它当判据）', () => {
    env({ ua: UA_ANDROID_CHROME, maxTouchPoints: 5 });
    expect(UA_ANDROID_CHROME).toContain('AppleWebKit');
    expect(isIosWebKit()).toBe(false);
  });

  it('Windows Chrome → false', () => {
    env({ ua: UA_WINDOWS_CHROME });
    expect(isIosWebKit()).toBe(false);
  });

  it('jsdom 自己的 UA → false（它里头就有 AppleWebKit，正好当反例）', () => {
    env();
    expect(UA_JSDOM).toContain('AppleWebKit');
    expect(() => isIosWebKit()).not.toThrow();
    expect(isIosWebKit()).toBe(false);
  });

  it('已知误报：接了触摸屏的 Mac 会被当成 iPad —— 这是有意接受的代价', () => {
    // 记在这里不是为了「锁住一个 bug」，而是让后来的人一眼看到这条判据的边界：
    // 真出现这种机器，它一定有 Notification，notifyPermission() 根本问不到这个函数
    // （见下面「误报的 Mac 不受影响」那条）。
    env({ ua: UA_MAC, maxTouchPoints: 10 });
    expect(isIosWebKit()).toBe(true);
  });
});

describe('notifyPermission —— 四种环境的判定顺序', () => {
  it('① iOS Safari 标签页（iOS UA + 没有 Notification + 非独立）→ needs-install', () => {
    env({ ua: UA_IPHONE, standalone: false, displayModeStandalone: false });
    vi.stubGlobal('isSecureContext', true);
    // 不装 Notification：这正是 iOS 标签页的真实情况
    expect(notifyPermission()).toBe('needs-install');
  });

  it('① iPadOS 桌面 UA 的标签页照样是 needs-install，不是 unsupported', () => {
    env({ ua: UA_IPADOS_DESKTOP, maxTouchPoints: 5, displayModeStandalone: false });
    vi.stubGlobal('isSecureContext', true);
    expect(notifyPermission()).toBe('needs-install');
  });

  it('② iOS 独立模式 + 有 Notification → 走浏览器自己的三档', () => {
    for (const p of ['default', 'granted', 'denied'] as const) {
      env({ ua: UA_IPHONE, standalone: true });
      vi.stubGlobal('isSecureContext', true);
      withNotification(p);
      expect(notifyPermission()).toBe(p);
      vi.unstubAllGlobals();
    }
  });

  it('② iOS 独立模式但仍然没有 Notification（iOS < 16.4）→ unsupported，这时候这句话是对的', () => {
    // 这一条说明为什么本档**不需要**任何 iOS 版本号判断：装完了还是没有，
    // 「当前浏览器不支持」就成了如实描述，引导用户再装一次才是误导。
    env({ ua: UA_IPHONE, standalone: true });
    vi.stubGlobal('isSecureContext', true);
    expect(notifyPermission()).toBe('unsupported');
  });

  it('③ 桌面 Chrome（有 Notification）→ 行为完全不变', () => {
    env({ ua: UA_WINDOWS_CHROME, displayModeStandalone: false });
    vi.stubGlobal('isSecureContext', true);
    withNotification('granted');
    expect(notifyPermission()).toBe('granted');
  });

  it('③ 老桌面浏览器（没有 Notification、不是 iOS）→ unsupported，不能劝人加主屏幕', () => {
    env({ ua: UA_WINDOWS_CHROME, displayModeStandalone: false });
    vi.stubGlobal('isSecureContext', true);
    expect(notifyPermission()).toBe('unsupported');
  });

  it('③ Android Chrome 没有 Notification 时也只能说 unsupported', () => {
    env({ ua: UA_ANDROID_CHROME, maxTouchPoints: 5, displayModeStandalone: false });
    vi.stubGlobal('isSecureContext', true);
    expect(notifyPermission()).toBe('unsupported');
  });

  it('④ jsdom（无 Notification、无 iOS UA、两个探测 API 都不存在）→ 仍然是 unsupported', () => {
    env();
    expect(notifyPermission()).toBe('unsupported');
  });

  it('误报的 Mac 不受影响：它有 Notification，走不到 isIosWebKit 那一步', () => {
    env({ ua: UA_MAC, maxTouchPoints: 10, displayModeStandalone: false });
    vi.stubGlobal('isSecureContext', true);
    withNotification('granted');
    expect(isIosWebKit()).toBe(true);          // 判据确实误报了
    expect(notifyPermission()).toBe('granted'); // 但状态机毫发无伤
  });
});

describe('顺序：insecure 压在 needs-install 前面', () => {
  it('非 HTTPS 的 iOS 标签页报 insecure，不报 needs-install', () => {
    // 理由：Notification 是 [SecureContext] 接口，非 HTTPS 的页面**装到主屏也照样没有**。
    // 这时候让用户去「添加到主屏幕」，是让他白折腾一趟再撞回同一堵墙；
    // 「先换成 https://」才是唯一能往前走的那句话。
    env({ ua: UA_IPHONE, standalone: false, displayModeStandalone: false });
    vi.stubGlobal('isSecureContext', false);
    expect(notifyPermission()).toBe('insecure');
  });

  it('非 HTTPS 的 iOS 独立模式同样报 insecure', () => {
    env({ ua: UA_IPHONE, standalone: true });
    vi.stubGlobal('isSecureContext', false);
    expect(notifyPermission()).toBe('insecure');
  });

  it('isSecureContext 是 undefined（jsdom / 古董环境）时不当作 insecure，iOS 仍走 needs-install', () => {
    // 防呆：如果把安全上下文判断写成 !window.isSecureContext，这一条会变成 'insecure'，
    // 于是 iOS 引导永远出不来。notify.ts 里只认 === false 就是为了这个。
    env({ ua: UA_IPHONE, standalone: false, displayModeStandalone: false });
    expect(window.isSecureContext).toBeUndefined();
    expect(notifyPermission()).toBe('needs-install');
  });
});
