import { useCallback, useState } from 'react';
import { previewOf } from './messages';
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
 */

/**
 * 前两档是本模块加的，浏览器自己只有后三档：
 * - 'insecure'：当前页面不是安全上下文（非 HTTPS 且非 localhost），浏览器禁用了通知；
 * - 'unsupported'：浏览器压根没有 Notification。
 */
export type NotifyPermission = 'insecure' | 'unsupported' | 'default' | 'granted' | 'denied';

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

export function notifyPermission(): NotifyPermission {
  // 安全上下文排在最前：非 HTTPS 时 Notification 往往干脆是 undefined，
  // 先判它才能给出「换 HTTPS」这句真正有用的话，而不是「浏览器不支持」。
  if (notifyInsecureContext()) return 'insecure';
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
 * 已经是 granted / denied 时直接返回当前值：被拒之后再调浏览器也不会真的问，
 * 反复调只会让人以为出了故障。
 */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (notifyInsecureContext()) return 'insecure';
  if (!notifySupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission as NotifyPermission;
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
 * 真正弹一条。返回有没有弹出去，方便调用方和测试判断。
 * 任何异常都就地咽掉：这是在 SSE 回调里跑的，抛出去会把新消息的处理一起带崩。
 */
export function notifyMessage(input: IncomingNotice): boolean {
  if (!shouldNotifyMessage(input)) return false;
  if (notifyPermission() !== 'granted') return false;         // 含「浏览器不支持」这一档
  try {
    const notice = new Notification(notifyTitle(input.message, input.conversation), {
      body: previewOf(input.message.body),
      // 同一个会话只保留最新一条，连着来十条消息不会堆十个通知。
      tag: `loop-im:${input.message.conversationId}`,
    });
    notice.onclick = () => {
      // 聚焦窗口可能被浏览器拒绝（比如通知来自另一个 tab），不影响后面的跳转。
      try { window.focus(); } catch { /* 忽略 */ }
      notice.close();
      input.onClick();
    };
    return true;
  } catch (err) {
    console.warn('[loop-im] 桌面通知弹出失败', err);
    return false;
  }
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
  try {
    const notice = new Notification(NOTIFY_ENABLED_TITLE, {
      body: NOTIFY_ENABLED_BODY,
      tag: 'loop-im:enabled',
    });
    notice.onclick = () => {
      try { window.focus(); } catch { /* 忽略 */ }
      notice.close();
    };
    return true;
  } catch (err) {
    console.warn('[loop-im] 确认通知弹出失败', err);
    return false;
  }
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
      return;
    }
    const next = await requestNotifyPermission();
    setPermission(next);
    // 权限没拿到就别把开关显示成「已开启」：开着却永远不弹，比关着更让人摸不着头脑。
    const on = next === 'granted';
    setEnabled(on);
    saveNotifyEnabled(on);
    // 开成功了就立刻弹一条确认，别让用户对着一个「已开启」的开关猜它到底通没通。
    if (on) notifyEnabledConfirmation();
  }, [enabled]);

  return { enabled, permission, toggle };
}
