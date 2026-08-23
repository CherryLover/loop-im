/**
 * Web Push 的前端一侧：订阅、上报、退订、角标。
 *
 * 三条贯穿全文件的原则：
 *
 * 1. **每次启动都无条件重新订阅一次。** iOS 不支持 `pushsubscriptionchange` 事件
 *    （MDN BCD：`safari_ios: version_added: false`），订阅失效（endpoint 轮换、
 *    系统清理）时我们**收不到任何通知**，只会表现为「推送忽然不到了」。所以不能
 *    「本地存过就跳过」——那正是这个 bug 长成的样子。`subscribe()` 对已有订阅是
 *    幂等的（返回同一个 endpoint），服务端那边也是 upsert，代价只有一次本地调用
 *    加一次幂等请求。
 *
 * 2. **VAPID 公钥必须从服务端拿**，不能编译进前端。每套部署的密钥都不一样，
 *    编进来就意味着「换个环境部署 = 前端要重新构建」，而且换密钥这件事本身
 *    （所有已有订阅立即失效）已经够难排查了，不该再加一层。
 *
 * 3. **全程失败只 warn，绝不打断页面。** 没有推送，网页照样是个完全能用的 IM。
 *    这个文件里没有任何一条抛出路径。
 */

import { api } from './api';

/** 设备标识存这儿。丢了就换一个新的，后果只是服务端多留一条死订阅（推一次 410 就被清掉）。 */
const DEVICE_KEY = 'loop-im-device';

/**
 * 等 SW 就绪的上限。
 *
 * `navigator.serviceWorker.ready` 有一个不讨喜的性质：**注册失败时它永远不 resolve**，
 * 既不 reject 也不超时。挂在它上面的 await 会静静地悬在那儿一辈子。所以这里自己加一道
 * 上限，超时就当「没有 SW」往下走 —— 反正调用方全都能接受 null。
 */
const SW_READY_TIMEOUT_MS = 10_000;

/**
 * 这台设备的稳定标识。服务端（push-decide）靠它判断「这台设备此刻在不在线」：
 * 已经有 SSE 连着的设备不用再推，人就在页面上看着。
 *
 * ⚠️ iOS 的主屏 App 和 Safari 标签页是**两个独立的存储沙箱**，它们会各拿到一个不同的
 * deviceId。这不是 bug，正是我们要的：那确实是两个互不相干的通知目标，主屏 App 在后台
 * 时该收推送，跟 Safari 里那个标签页开没开没有关系。
 *
 * localStorage 在隐私模式下可能直接抛，那就每次生成一个新的、只活这一次会话 ——
 * 退化成「每次启动算一台新设备」，多推一条，不会出错。
 */
export function deviceId(): string {
  let existing: string | null = null;
  try {
    existing = window.localStorage.getItem(DEVICE_KEY);
  } catch {
    /* 隐私模式：读不到就当没有 */
  }
  if (existing) return existing;

  const fresh = randomId();
  try {
    window.localStorage.setItem(DEVICE_KEY, fresh);
  } catch {
    /* 存不下就只在这次会话里有效 */
  }
  return fresh;
}

/** crypto.randomUUID 在 [SecureContext] 之外和老浏览器里可能没有，退回 Math.random。 */
function randomId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    /* 落到下面 */
  }
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 缓存住的 SW registration。
 *
 * 存在的理由只有一个：`notify.ts` 的 `notifyMessage` 是在 SSE 回调里**同步**调用的，
 * 它得当场决定走 `registration.showNotification()` 还是退回 `new Notification()`，
 * 而拿 registration 的所有 API 都是异步的。所以在启动时异步拿一次、存下来，
 * 同步路径读这个缓存。拿不到就是 null，`notify.ts` 自然退回构造函数那条老路。
 */
let cachedRegistration: ServiceWorkerRegistration | null = null;

/** 同步读缓存。`notify.ts` 用它决定弹通知走哪条路。 */
export function notifyRegistration(): ServiceWorkerRegistration | null {
  return cachedRegistration;
}

/**
 * 拿到 SW registration 并缓存起来。应用启动时调一次。
 *
 * 和订阅分开，是因为它俩的前提不一样：前台通知（showNotification）只要有 SW 就能用，
 * 不需要服务端配了 VAPID，也不需要用户开了推送开关。
 *
 * @returns 拿到就返回它，环境不支持 / 超时一律 null，绝不抛。
 */
export async function primeServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const ready = navigator.serviceWorker.ready;
    // 见 SW_READY_TIMEOUT_MS 的注释：ready 在注册失败时永远不结算，必须自己兜一道。
    const reg = await Promise.race([
      ready,
      new Promise<null>((resolve) => { setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS); }),
    ]);
    cachedRegistration = reg ?? null;
    return cachedRegistration;
  } catch (err) {
    console.warn('[loop-im] 拿不到 Service Worker registration，推送与后台通知不可用', err);
    return null;
  }
}

/** 只给测试用：把缓存清干净，免得用例之间互相串。 */
export function resetPushStateForTest(): void {
  cachedRegistration = null;
}

/**
 * base64url 的 VAPID 公钥 → `Uint8Array`。`applicationServerKey` 只认字节。
 *
 * 服务端给的是 base64url（`-` `_`、没有 `=` 填充），`atob` 只认标准 base64，
 * 得先换回来再补齐填充。
 */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** 上报给服务端的订阅形状，和 `POST /api/push/subscribe` 的契约一致。 */
interface SubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * 从浏览器给的 `PushSubscription` 里抠出服务端要的三个字段。
 *
 * 优先 `toJSON()`（标准方法，直接给出 base64url 的 keys）；老实现上它可能缺席或者
 * 少给 keys，那就退回 `getKey()` 自己编码。两条路都走不通就返回 null —— 一条缺 key 的
 * 订阅上报上去只会让服务端每次群发都多一次注定失败的请求。
 */
export function serializeSubscription(sub: PushSubscription): SubscriptionPayload | null {
  let endpoint = '';
  let p256dh = '';
  let auth = '';

  try {
    const json = typeof sub.toJSON === 'function' ? sub.toJSON() : null;
    if (json) {
      endpoint = json.endpoint || '';
      p256dh = json.keys?.p256dh || '';
      auth = json.keys?.auth || '';
    }
  } catch {
    /* 落到下面的 getKey */
  }

  if (!endpoint) endpoint = sub.endpoint || '';
  if (!p256dh) p256dh = bytesToBase64Url(safeGetKey(sub, 'p256dh'));
  if (!auth) auth = bytesToBase64Url(safeGetKey(sub, 'auth'));

  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function safeGetKey(sub: PushSubscription, name: 'p256dh' | 'auth'): ArrayBuffer | null {
  try {
    return typeof sub.getKey === 'function' ? sub.getKey(name) : null;
  } catch {
    return null;
  }
}

function bytesToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 订阅推送并上报给服务端。**每次应用启动都要调一次**（理由见文件头第 1 条），
 * 以及用户把开关拨到「开」的那一刻。
 *
 * 顺序是有讲究的：
 * 1. 先拿 registration —— 顺带把 `notify.ts` 要的缓存喂上，这一步和推送开没开无关；
 * 2. 权限不是 `granted` 就**到此为止，绝不调 `subscribe()`** ——
 *    没权限时它会直接 reject，而且在有些实现上还会顺手弹一次权限框，
 *    那就违反了「只在真实用户手势里申请权限」这条；
 * 3. 服务端没配 VAPID（`enabled: false`）也到此为止，别拿一个 null 公钥去 subscribe；
 * 4. 最后才 subscribe + 上报。
 *
 * @returns 订阅并上报成功才是 true。其余一律 false，不抛。
 */
export async function ensurePushSubscription(): Promise<boolean> {
  const reg = await primeServiceWorker();
  if (!reg || !reg.pushManager) return false;

  // 没权限就别往下走。这里读的是浏览器的原始状态，不借 notify.ts 的 notifyPermission()：
  // 那个函数还要分 insecure / needs-install 这些**给用户看的**档位，而这儿只关心
  // 「subscribe() 会不会成」这一个技术问题，两者没必要绑在一起。
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;

  try {
    const config = await api.pushConfig();
    if (!config?.enabled || !config.publicKey) return false;

    const sub = await reg.pushManager.subscribe({
      // ⚠️ 必须是 true。承诺了「每条推送都会弹一条用户可见的通知」却不弹，
      // WebKit 会**永久吊销**这台设备的订阅（见 public/sw.js 里那段红线）。
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(config.publicKey),
    });

    const payload = serializeSubscription(sub);
    if (!payload) {
      console.warn('[loop-im] 订阅缺少 endpoint 或密钥，不上报');
      return false;
    }

    await api.pushSubscribe({ deviceId: deviceId(), subscription: payload });
    return true;
  } catch (err) {
    // 能落到这儿的：服务端接口挂了、subscribe 被浏览器拒（权限刚被撤、公钥换过了）、
    // 或者上报请求失败。都不值得打断页面 —— 最坏的结果是这台设备暂时收不到推送，
    // 下次启动会再试一遍（见文件头第 1 条）。
    console.warn('[loop-im] 推送订阅失败，这台设备暂时收不到推送', err);
    return false;
  }
}

/**
 * 退订。用户把开关拨到「关」时调。
 *
 * **开关的语义在这一版变了**：从「本地弹不弹窗」变成「这台设备收不收推送」。
 * 所以关掉必须**真的退订**并告诉服务端，否则服务端那边还在推，锁屏上照样往外冒消息，
 * 用户会认为开关坏了 —— 而这一次他是对的。
 *
 * 两步各自独立兜错，谁失败都不挡另一步：
 * - 只退了本地没通知服务端 → 服务端下次推过去收到 404/410，自己会把这条订阅删掉；
 * - 只通知了服务端没退本地 → 服务端不再推，浏览器那份订阅闲置着，无害。
 * 两条都是自愈的，所以这里不需要重试，也不需要把失败抛给界面。
 */
export async function unsubscribePush(): Promise<void> {
  const reg = await primeServiceWorker();
  if (!reg || !reg.pushManager) return;

  let sub: PushSubscription | null = null;
  try {
    sub = await reg.pushManager.getSubscription();
  } catch (err) {
    console.warn('[loop-im] 读取现有推送订阅失败', err);
  }
  if (!sub) return;

  const endpoint = sub.endpoint;

  try {
    await sub.unsubscribe();
  } catch (err) {
    console.warn('[loop-im] 本地退订失败', err);
  }

  try {
    if (endpoint) await api.pushUnsubscribe(endpoint);
  } catch (err) {
    console.warn('[loop-im] 通知服务端删除订阅失败（服务端会在下次推送收到 410 时自行清理）', err);
  }
}

/**
 * 主屏图标上的未读角标。
 *
 * 两个 API 都可能不存在（Badging 要 iOS 16.4+，桌面 Safari 至今没有），而且在非独立
 * 模式下调用会 reject。所以 try/catch 加 `typeof` 双保险：角标是锦上添花，
 * 它绝不能成为任何一条主路径上的失败点。
 */
export function applyAppBadge(count: number): void {
  try {
    const nav = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    const done = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
    // 这两个方法返回 Promise，reject 了也只是角标没打上，吞掉。
    void done?.catch(() => {});
  } catch {
    /* 连属性都读不到（某些沙箱环境）也无所谓 */
  }
}
