/**
 * 「本地通知」和「推送通知」之间的交接。
 *
 * 页面切到后台之后，同一条消息有两条可能的路：服务端推一条，页面自己弹一条。
 * 两条都走就是两条通知（tag 相同会互相覆盖，但手机会震两下）；两条都不走就是
 * **什么都收不到**，那是功能失效。所以这两边必须严丝合缝地互补，这个文件就锁这件事。
 *
 * 交接的规则只有一句：**页面切走了、而且这台设备确实有推送订阅 → 本地不弹，交给推送。**
 * 两个条件缺一不可，下面每一条用例都在盯着「缺一个会怎样」。
 */
import { describe, expect, it } from 'vitest';
import { notifyTitle, shouldNotifyMessage } from './notify';
import type { Conversation, Message } from './types';

const message = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  conversationId: 'c1',
  senderId: 'u_peer',
  senderName: '陈子航',
  senderAvatarUrl: null,
  body: '明天的发版要不要提前？',
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: false,
  ...over,
});

const group = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  type: 'group',
  title: '发版协作',
  peerId: null,
  createdBy: 'u_me',
  members: [],
  lastMessage: null,
  unread: 0,
  ...over,
});

/** 「页面切走了、消息也不在眼前」这个基础场景，其余字段各条用例自己覆盖。 */
const hidden = (over: Record<string, unknown> = {}) => ({
  message: message(),
  conversation: group(),
  meId: 'u_me',
  visible: false,
  enabled: true,
  documentHidden: true,
  ...over,
});

describe('有推送订阅 → 本地不弹，交给推送', () => {
  it('页面切走 + 有订阅 → 不弹（否则同一条消息两条通知，手机震两下）', () => {
    expect(shouldNotifyMessage(hidden({ pushSubscribed: true }))).toBe(false);
  });

  it('⚠️ 页面切走 + **没有**订阅 → 照旧弹（硬要求：不能回归成「切后台什么都收不到」）', () => {
    // 没配 VAPID、用户没授权、浏览器不支持推送的设备全落在这一档。
    // 它们**没有**第二条路，本地通知是唯一的通道，一步都不能省。
    expect(shouldNotifyMessage(hidden({ pushSubscribed: false }))).toBe(true);
  });

  it('pushSubscribed 没传（老调用方）等同于「没有订阅」→ 照旧弹', () => {
    // 默认值必须站在「弹」这一边：漏弹是功能失效，多弹只是打扰。
    expect(shouldNotifyMessage(hidden())).toBe(true);
  });

  it('⚠️ 页面**没**切走、只是人在联系人页 + 有订阅 → 照旧弹', () => {
    // 这一档最容易被写错。页面开着（documentHidden=false）时这台设备报告的是「前台」，
    // 服务端因此**不会**推 —— 这时候本地再不弹，用户就什么都收不到了。
    // 所以判据是 documentHidden 而不是 visible，两者不是一回事。
    expect(shouldNotifyMessage(hidden({ documentHidden: false, pushSubscribed: true }))).toBe(true);
  });

  it('documentHidden 没传也当成「页面开着」→ 照旧弹', () => {
    expect(shouldNotifyMessage(hidden({ documentHidden: undefined, pushSubscribed: true }))).toBe(true);
  });

  it('人正看着这条消息时，有没有订阅都不弹（这条规则在前面就拦下了）', () => {
    expect(shouldNotifyMessage(hidden({ visible: true, pushSubscribed: false }))).toBe(false);
    expect(shouldNotifyMessage(hidden({ visible: true, pushSubscribed: true }))).toBe(false);
  });

  it('交接不会把别的规则漏掉：自己发的 / 系统消息 / 免打扰 / 没开开关，一律还是不弹', () => {
    expect(shouldNotifyMessage(hidden({ message: message({ senderId: 'u_me' }), pushSubscribed: false }))).toBe(false);
    expect(shouldNotifyMessage(hidden({ message: message({ kind: 'system' }), pushSubscribed: false }))).toBe(false);
    expect(shouldNotifyMessage(hidden({ conversation: group({ muted: true }), pushSubscribed: false }))).toBe(false);
    expect(shouldNotifyMessage(hidden({ enabled: false, pushSubscribed: false }))).toBe(false);
  });
});

describe('本地通知标题 · 和服务端推送标题必须逐字一致', () => {
  it('群聊：发送者 · 群名', () => {
    expect(notifyTitle(message(), group())).toBe('陈子航 · 发版协作');
  });

  it('单聊：就是发送者本人', () => {
    expect(notifyTitle(message(), group({ type: 'dm', title: undefined }))).toBe('陈子航');
  });

  it('⚠️ 不带应用名 —— iOS 会自动给主屏 Web App 的通知附上一行 short_name', () => {
    // 服务端的 pushTitle 同样不带（server/src/push-decide.js）。两边一起改，
    // 否则同一条消息在本地通知和推送通知上会长成两个样子。
    const dm = group({ type: 'dm', title: undefined });
    const ai = group({ type: 'ai', title: undefined });
    for (const conversation of [group(), dm, ai]) {
      expect(notifyTitle(message(), conversation)).not.toMatch(/Loop/i);
    }
  });
});
