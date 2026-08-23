import { useCallback, useState } from 'react';
import { previewOf } from './messages';
import { ensurePushSubscription, notifyRegistration, unsubscribePush } from './push';
import type { Conversation, Message } from './types';

/**
 * 浏览器桌面通知。
 *
 * 三条原则，代码里每一处都按这个来：
 * 1. 不主动骚扰。绝不在页面加载时调 requestPermission()——那是最招人烦的反模式。
 *    只有用户在个人资料里自己把开关拨上去，才申请权限；被拒之后不再重复申请。
 * 2. 只在用户看不见这条消息时才弹。判据由调用方（AppShell）给，和已读上报是同一个
 *    （issue #20 的 chatDetailVisible），同一条消息不会既被标成已读又弹通知。
 * 3. 没有 Notification 就安静降级。jsdom、老浏览器、iOS 上的非 PWA Safari 都没有它，
 *    任何一处都不能因此抛异常把页面搞挂。
 * 4. 环境问题要说人话。Notification 是 [SecureContext] 接口：通过 http://内网IP 访问时
 *    浏览器直接不给，权限申请连弹都不弹。这一档单独报成 'insecure'，不能和「浏览器太老」
 *    混成同一句「不支持」——那是把 URL 的问题赖给浏览器，用户换个浏览器还是不行。
 *    同理，iOS 标签页里 Notification 不存在，报「浏览器不支持」也是错的——iOS 上所有
 *    浏览器都是同一个 WebKit，换谁都一样，那一档单独报成 'needs-install'。
 */

/**
 * 前三档是本模块加的，浏览器自己只有后三档：
 * - 'insecure'：当前页面不是安全上下文（非 HTTPS 且非 localhost），浏览器禁用了通知；
 * - 'needs-install'：iOS / iPadOS，页面还跑在 Safari 标签页里，得先「添加到主屏幕」；
 * - 'unsupported'：浏览器压根没有 Notification。
 */
export type NotifyPermission =
  | 'insecure'
  | 'needs-install'
  | 'unsupported'
  | 'default'
  | 'granted'
  | 'denied';

const KEY = 'loop-im-notify';

/**
 * 当前页面是不是**确定**不在安全上下文里。
 *
 * 只认 `=== false` 这一种情况：真实浏览器从 2016 年起都有 isSecureContext，读出 undefined
 * 说明是 jsdom 或古董环境，那属于「不知道」，不能据此把功能判死。
 */
export function notifyInsecureContext(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === false;
}

/** 浏览器有没有 Notification。typeof 对未声明的全局也安全，不会抛。 */
export function notifySupported(): boolean {
  return typeof Notification !== 'undefined';
}

/**
 * 当前页面是不是跑在「已安装的 Web App」里（从主屏 / 启动器图标打开，没有地址栏那种）。
 *
 * 两条路都要认，缺一条都会漏判：
 * - `display-mode: standalone` 媒体查询——标准做法，Android / 桌面 / iOS 16.4+ 都认；
 * - `navigator.standalone`——iOS 的私有属性，老 iOS 上**只有**它。
 *
 * 两个 API 在 jsdom 里都不存在（`window.matchMedia` 是 undefined，`navigator.standalone`
 * 也是），所以每一步都得先探再用。探不到一律当「不是独立模式」——这和
 * notifyInsecureContext() 只认 `=== false` 是同一个思路的两面：那边「不知道」不能拿来
 * 把功能判死，这边「不知道」不能拿来断言用户已经装好了。两边都是往「别乱下结论」的
 * 方向倒，只是安全的那一侧刚好相反。
 */
export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as (Navigator & { standalone?: boolean }) | undefined;
  // 只认 === true。iOS 标签页里这个属性是 false，别的环境里它压根不存在（undefined）——
  // 后者是「没有这个 API」，不是「不在独立模式」，得让下面的媒体查询继续说话。
  if (nav?.standalone === true) return true;
  try {
    return window.matchMedia('(display-mode: standalone)').matches === true;
  } catch {
    // 这个 catch 兜的是两件事，别以为它只防一件：
    // 1. matchMedia 根本不存在（jsdom 就是这样，调用直接 TypeError）；
    // 2. 个别老 WebKit 碰到不认识的媒体特性会抛，而不是返回 matches:false。
    // 曾经在这上面加过一道 `typeof window.matchMedia !== 'function'` 的前置守卫，
    // 后来发现它一行都测不出来——第 1 种情况已经被这个 catch 完整覆盖，
    // 那道守卫是纯粹的死代码，删掉了。
    return false;
  }
}

/**
 * 当前是不是 iOS / iPadOS。判据只有 UA 和 maxTouchPoints，两条：
 *
 * 1. UA 里有 iPhone / iPad / iPod —— 认。
 * 2. iPadOS 13 起 Safari 默认报**桌面** UA（`Macintosh; Intel Mac OS X ...`），里面
 *    根本没有 "iPad"。剩下还站得住的区分点只有触摸点数：真 Mac 报 0（触控板不算
 *    触摸屏），iPad 报 5。所以补一条 `Macintosh + maxTouchPoints > 1`。
 *    iPhone 上手动开「请求桌面网站」也落到这一条。
 *
 * **已知误判，写出来省得后人以为它准：**
 * - 误报：接了触摸屏的 Mac、某些辅助输入设备、以及 Chrome DevTools 的设备模拟，
 *   都可能满足第 2 条。代价可控——这个函数只在 `notifySupported()` 已经为 false 时
 *   才会被问到，而任何一台跑得动 Notification 的 Mac 根本走不到那一步；真误报了，
 *   后果也只是多看到一句「添加到主屏幕」的建议。
 * - 漏报：改过 UA 的 App 内嵌 WebView（微信、企业 IM 之类）可能既不含 iPhone 也不含
 *   Macintosh，会退回 'unsupported'。那正是**改动前**的行为，不比现在更差。
 *
 * 不能用的两个判据，别再捡回来：
 * - "AppleWebKit"：Chrome、Edge、连 jsdom 的默认 UA 里都有它，一认就全世界都是 iOS；
 * - `navigator.platform`：已废弃，而且 iPadOS 上它就报 "MacIntel"，和 Mac 分不开。
 */
export function isIosWebKit(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return true;
  return /\bMacintosh\b/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

export function notifyPermission(): NotifyPermission {
  // ── 这四步的先后顺序本身就是需求，别随手调换 ────────────────────────────
  //
  // 1) 'insecure' 压在最前。非 HTTPS 时 Notification 往往干脆是 undefined，先判它
  //    才能给出「换 HTTPS」这句真正有用的话，而不是「浏览器不支持」。
  //    iOS 上同样如此，而且更要紧：Notification 是 [SecureContext] 接口，非 HTTPS 的
  //    页面**就算装到主屏也照样没有**。这时候劝人去「添加到主屏幕」，是让他白折腾一趟
  //    再回到同一个死胡同。所以 'insecure' 排在 'needs-install' 之前，不是之后。
  //
  // 2) 'needs-install' 必须排在 'unsupported' 之前。iOS Safari 标签页里 Notification
  //    确实是 undefined，按老顺序会被判成「当前浏览器不支持桌面通知」——而那句话是
  //    错的：iOS 上所有浏览器都是同一个 WebKit，用户换到 Chrome / Firefox 结果一模
  //    一样，只会更困惑。真正该做的是「添加到主屏幕」。这就是这一档存在的全部理由。
  //
  // 3) 三个条件缺一不可：没有 Notification（有就不必引导安装了）、确实是 iOS
  //    （在 Android Chrome 或老桌面浏览器上说「加到主屏幕」同样是误导）、
  //    而且还没装（装完了却仍然没有 Notification 是另一回事，见下一条）。
  //
  // 4) 剩下的 'unsupported' 才是名副其实的「这个浏览器真的没有」。已经装到主屏、
  //    Notification 仍然缺席的 iOS（低于 16.4）会落到这里，那时候「不支持」就是**对的**
  //    ——所以这一档不需要任何 iOS 版本号判断，顺序本身已经把版本问题分掉了。
  if (notifyInsecureContext()) return 'insecure';
  if (!notifySupported() && isIosWebKit() && !isStandaloneDisplay()) return 'needs-install';
  if (!notifySupported()) return 'unsupported';
  return Notification.permission as NotifyPermission;
}

/** 偏好持久化，和主题同一套做法。localStorage 在隐私模式下可能直接抛，兜住。 */
export function loadNotifyEnabled(): boolean {
  try {
    return window.localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function saveNotifyEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* 存不下就只在这一次会话里生效，不值得打断用户 */
  }
}

/**
 * 申请权限。只该由「用户点开关」这一条路径调用。
 *
 * 只有 'default' 这一档才真的去问浏览器，其余全部原样返回 notifyPermission() 的判断：
 * - 三个环境档（insecure / needs-install / unsupported）下 requestPermission() 要么
 *   根本不存在，要么注定失败；
 * - 已经 granted / denied 的，再调浏览器也不会真的问，反复调只让人以为出了故障。
 * 借 notifyPermission() 判断而不是自己重列一遍条件，是为了让两处的顺序不可能走岔。
 */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  const current = notifyPermission();
  if (current !== 'default') return current;
  try {
    // 老浏览器上 requestPermission 是回调式的，返回 undefined；那就以当前权限为准。
    const result = await Notification.requestPermission();
    return (result as NotifyPermission) ?? notifyPermission();
  } catch {
    return notifyPermission();
  }
}

export interface IncomingNotice {
  message: Message;
  /** 消息所属会话；列表还没刷出来时可能没有，此时按「不是群聊、没免打扰」处理。 */
  conversation?: Conversation;
  meId: string;
  /** 这条消息此刻是不是就摆在用户眼前——与已读上报共用的判据。 */
  visible: boolean;
  /** 用户在设置里把桌面通知打开了没有。 */
  enabled: boolean;
  /** 点通知之后跳到这个会话去。 */
  onClick: () => void;
}

/**
 * 该不该为这条消息弹通知。纯函数，不碰 Notification，便于单独锁住每一条规则。
 * 权限和浏览器支持性不在这儿判（见 notifyMessage）——那两个是环境问题，不是消息问题。
 */
export function shouldNotifyMessage(input: Omit<IncomingNotice, 'onClick'>): boolean {
  if (!input.enabled) return false;
  if (input.visible) return false;                            // 人正看着，弹了是打扰
  if (input.message.senderId === input.meId) return false;    // 自己发的
  if (input.message.kind === 'system') return false;          // 入群/改群名之类的提示
  if (input.conversation?.muted === true) return false;       // 会话已设为免打扰
  return true;
}

/**
 * 通知标题：群聊得带群名，不然只看到一个人名，不知道是从哪个群冒出来的。
 * 单聊 / AI 会话的标题就是发送者本人。
 */
export function notifyTitle(message: Message, conversation?: Conversation): string {
  return conversation?.type === 'group'
    ? `${message.senderName} · ${conversation.title}`
    : message.senderName;
}

/**
 * 弹一条通知的**唯一入口**。前台本地通知和后台推送因此走同一条路：
 * 有 Service Worker registration 就 `registration.showNotification()`，否则退回
 * `new Notification()`。
 *
 * 为什么统一到 showNotification 这一侧：
 * - iOS 上**只有**它 —— 主屏 App 里 `new Notification()` 构造函数是不能用的
 *   （Notification 存在，但只有 `permission` / `requestPermission` 那几个静态成员）；
 * - 两套弹通知的代码迟早会漂移。tag 是最典型的：SW 那边（public/sw.js）用
 *   `loop-im:${conversationId}`，这边也必须一模一样，同一个会话的本地通知和推送通知
 *   才会互相覆盖而不是堆成两摞。一个入口，就没有第二处要记着改。
 *
 * 桌面 Chrome / Firefox 上两条路都有，优先 SW 那条：这样点通知的处理也统一走
 * SW 的 `notificationclick`（→ postMessage → AppShell），而不是这里的 `onclick`。
 *
 * `registration` 是启动时异步取好缓存下来的（见 lib/push.ts 的 primeServiceWorker）——
 * 这个函数是在 SSE 回调里同步调用的，当场 await 不了。
 *
 * @returns 有没有弹出去。任何异常都就地咽掉：这是在 SSE 回调里跑的，
 *          抛出去会把新消息的处理一起带崩。
 */
function showNotice(
  title: string,
  options: { body: string; tag: string; conversationId?: string | null },
  onClick?: () => void,
): boolean {
  const registration = notifyRegistration();
  if (registration && typeof registration.showNotification === 'function') {
    try {
      // showNotification 是异步的，但它不返回通知对象，点击只能靠 SW 的
      // notificationclick 事件接住 —— 所以 onClick 在这条路上不挂，
      // 由 SW postMessage 回页面来完成同样的跳转（AppShell 里接的）。
      void Promise.resolve(
        registration.showNotification(title, {
          body: options.body,
          tag: options.tag,
          data: { conversationId: options.conversationId ?? null },
        }),
      ).catch((err) => console.warn('[loop-im] showNotification 失败', err));
      return true;
    } catch (err) {
      // 同步就抛说明这条路根本走不通（比如权限在这一瞬间被撤），落到下面的构造函数。
      console.warn('[loop-im] showNotification 调用失败，退回通知构造函数', err);
    }
  }

  try {
    const notice = new Notification(title, { body: options.body, tag: options.tag });
    notice.onclick = () => {
      // 聚焦窗口可能被浏览器拒绝（比如通知来自另一个 tab），不影响后面的跳转。
      try { window.focus(); } catch { /* 忽略 */ }
      notice.close();
      onClick?.();
    };
    return true;
  } catch (err) {
    console.warn('[loop-im] 桌面通知弹出失败', err);
    return false;
  }
}

/**
 * 真正弹一条。返回有没有弹出去，方便调用方和测试判断。
 */
export function notifyMessage(input: IncomingNotice): boolean {
  if (!shouldNotifyMessage(input)) return false;
  if (notifyPermission() !== 'granted') return false;         // 含「浏览器不支持」这一档
  return showNotice(
    notifyTitle(input.message, input.conversation),
    {
      body: previewOf(input.message.body),
      // 同一个会话只保留最新一条，连着来十条消息不会堆十个通知。
      // ⚠️ 这个串必须和 public/sw.js 里推送通知用的完全一致。
      tag: `loop-im:${input.message.conversationId}`,
      conversationId: input.message.conversationId,
    },
    input.onClick,
  );
}

export const NOTIFY_ENABLED_TITLE = '桌面通知已开启';
export const NOTIFY_ENABLED_BODY = '切到别的标签页或别的应用时，新消息会像这样弹出来。';

/**
 * 开关刚拨到「开」的那一刻，立刻弹一条确认。
 *
 * 这是标准做法，不是锦上添花：本产品**只在用户看不见消息时**才弹通知（见
 * shouldNotifyMessage），用户开完开关往往还停在聊天页，于是接下来很久都不会弹任何东西，
 * 看上去和「点了没反应 / 坏了」一模一样。先弹一条确认，用户就知道通道是通的。
 *
 * 和 notifyMessage 一样，任何异常都就地咽掉：拨开关不该把页面搞挂。
 */
export function notifyEnabledConfirmation(): boolean {
  if (notifyPermission() !== 'granted') return false;
  return showNotice(NOTIFY_ENABLED_TITLE, { body: NOTIFY_ENABLED_BODY, tag: 'loop-im:enabled' });
}

export interface DesktopNotify {
  enabled: boolean;
  permission: NotifyPermission;
  /** 拨动开关。关 → 开时才申请权限；没拿到权限就不把开关拨上去。 */
  toggle: () => Promise<void>;
}

export function useDesktopNotify(): DesktopNotify {
  const [enabled, setEnabled] = useState(loadNotifyEnabled);
  const [permission, setPermission] = useState<NotifyPermission>(notifyPermission);

  const toggle = useCallback(async () => {
    if (enabled) {
      setEnabled(false);
      saveNotifyEnabled(false);
      // ⚠️ 开关的语义变了：从「本地弹不弹窗」变成「这台设备收不收通知」。
      // 关掉必须**真的退订**，否则服务端不知道，照样往这台设备推 ——
      // 用户会看到一个「已关闭」的开关和一屏还在冒的锁屏通知，而这一次他是对的。
      // 不 await：退订是网络往返，开关的视觉状态不该等它（失败也是自愈的，见 push.ts）。
      void unsubscribePush();
      return;
    }
    // 权限申请必须发生在**真实的用户手势**里，所以这一步只能在这条 onClick 路径上。
    const next = await requestNotifyPermission();
    setPermission(next);
    // 权限没拿到就别把开关显示成「已开启」：开着却永远不弹，比关着更让人摸不着头脑。
    const on = next === 'granted';
    setEnabled(on);
    saveNotifyEnabled(on);
    if (on) {
      // 开成功了就立刻弹一条确认，别让用户对着一个「已开启」的开关猜它到底通没通。
      notifyEnabledConfirmation();
      // 再把订阅交给服务端。同样不 await：订阅失败只是这台设备暂时收不到推送，
      // 下次启动 AppShell 还会再试一遍（见 push.ts 文件头第 1 条）。
      void ensurePushSubscription();
    }
  }, [enabled]);

  return { enabled, permission, toggle };
}
