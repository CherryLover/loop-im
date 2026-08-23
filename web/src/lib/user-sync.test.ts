import { describe, expect, it } from 'vitest';
import {
  adoptUserList, presenceOf, syncPresenceInConversations, syncPresenceInList,
  syncUserInConversations, syncUserInList, syncUserInMessages,
} from './user-sync';
import type { Conversation, Message, User } from './types';

const ME: User = {
  id: 'u_lin', name: '林悦', email: 'lin@loop.dev', dept: '产品',
  role: 'admin', avatarUrl: null, isAI: false, online: true, disabled: false,
};
const PEER: User = {
  ...ME, id: 'u_chen', name: '陈子航', email: 'c@loop.dev', dept: '后端',
  role: 'member', avatarUrl: '/uploads/old.png',
};
const RENAMED: User = { ...PEER, name: '陈子航（新）', avatarUrl: '/uploads/new.png' };

const convo = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c_group',
  type: 'group',
  title: '发版协作',
  peerId: null,
  createdBy: ME.id,
  members: [ME, PEER].map((m) => ({ ...m, roleInGroup: m.id === ME.id ? '管理员' : m.dept })),
  lastMessage: null,
  unread: 0,
  ...over,
});

const dm = () => convo({
  id: 'c_dm', type: 'dm', title: PEER.name, peerId: PEER.id,
});

const message = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  conversationId: 'c_group',
  senderId: PEER.id,
  senderName: PEER.name,
  senderAvatarUrl: PEER.avatarUrl,
  body: '内容',
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: false,
  ...over,
});

describe('syncUserInList', () => {
  it('名单里那一行换成新的', () => {
    expect(syncUserInList([ME, PEER], RENAMED)[1]).toMatchObject({
      id: PEER.id, name: '陈子航（新）', avatarUrl: '/uploads/new.png',
    });
  });

  it('名单里没有这个人（user-created）时原样返回，不擅自插行', () => {
    const list = [ME];
    const stranger: User = { ...PEER, id: 'u_new' };
    expect(syncUserInList(list, stranger)).toBe(list);
  });

  it('什么都没变时返回原引用', () => {
    const list = [ME, PEER];
    expect(syncUserInList(list, { ...PEER })).toBe(list);
  });
});

describe('syncUserInConversations', () => {
  it('群成员里那一份拷贝跟着变，群名不动', () => {
    const [after] = syncUserInConversations([convo()], RENAMED, ME.id);
    expect(after.title).toBe('发版协作');
    expect(after.members[1]).toMatchObject({ name: '陈子航（新）', avatarUrl: '/uploads/new.png' });
  });

  it('roleInGroup 是群里的身份，不被个人资料覆盖掉', () => {
    const [after] = syncUserInConversations([convo()], RENAMED, ME.id);
    expect(after.members[1].roleInGroup).toBe('后端');
    expect(after.members[0].roleInGroup).toBe('管理员');
  });

  it('单聊的标题就是对方的名字，也要跟着变', () => {
    const [after] = syncUserInConversations([dm()], RENAMED, ME.id);
    expect(after.title).toBe('陈子航（新）');
  });

  it('改名的是我自己时，单聊标题不动 —— 我看到的是对方的名字', () => {
    const [after] = syncUserInConversations([dm()], { ...ME, name: '林悦悦' }, ME.id);
    expect(after.title).toBe('陈子航');
    expect(after.members[0].name).toBe('林悦悦');
  });

  it('停用标记也走同一条路（它同样被拷进了成员列表）', () => {
    const [after] = syncUserInConversations([convo()], { ...PEER, disabled: true }, ME.id);
    expect(after.members[1].disabled).toBe(true);
  });

  it('与这个人无关的会话保持原引用，不会被无谓地重渲染', () => {
    const other = convo({ id: 'c_other', members: [{ ...ME, roleInGroup: '管理员' }] });
    const list = [convo(), other];
    const next = syncUserInConversations(list, RENAMED, ME.id);
    expect(next).not.toBe(list);
    expect(next[1]).toBe(other);
  });

  it('一个字段都没变时整份返回原引用', () => {
    const list = [convo(), dm()];
    expect(syncUserInConversations(list, { ...PEER }, ME.id)).toBe(list);
  });
});

describe('syncPresenceInList', () => {
  it('只改在线状态，名字头像一概不动', () => {
    const [, after] = syncPresenceInList([ME, PEER], presenceOf([{ id: PEER.id, online: false }]));
    expect(after.online).toBe(false);
    expect(after).toMatchObject({ name: '陈子航', avatarUrl: '/uploads/old.png' });
  });

  it('这张表没提到的人保持原对象引用', () => {
    const list = [ME, PEER];
    const next = syncPresenceInList(list, presenceOf([{ id: PEER.id, online: false }]));
    expect(next[0]).toBe(ME);
  });

  it('已停用的账号一律离线，不会被一条 presence 重新点亮', () => {
    const gone: User = { ...PEER, online: false, disabled: true };
    const list = [gone];
    const next = syncPresenceInList(list, presenceOf([{ id: gone.id, online: true }]));
    expect(next[0].online).toBe(false);
    expect(next).toBe(list);                     // 没变就是没变，连新数组都不该造
  });

  it('状态没变时整份返回原引用 —— 同一条 presence 重复到达不该引起重渲染', () => {
    const list = [ME, PEER];
    const presence = presenceOf([{ id: PEER.id, online: false }]);
    const once = syncPresenceInList(list, presence);
    expect(once).not.toBe(list);
    expect(syncPresenceInList(once, presence)).toBe(once);
  });
});

describe('syncPresenceInConversations', () => {
  it('群成员的在线点跟着变，群里的身份和名字不动', () => {
    const [after] = syncPresenceInConversations([convo()], presenceOf([{ id: PEER.id, online: false }]));
    expect(after.members[1]).toMatchObject({ name: '陈子航', roleInGroup: '后端', online: false });
  });

  it('单聊标题是对方的名字，跟在线状态无关', () => {
    const [after] = syncPresenceInConversations([dm()], presenceOf([{ id: PEER.id, online: false }]));
    expect(after.title).toBe('陈子航');
    expect(after.members[1].online).toBe(false);
  });

  it('心跳返回的是整份名单：一次把好几个人改完', () => {
    const [after] = syncPresenceInConversations(
      [convo()],
      presenceOf([{ id: ME.id, online: true }, { id: PEER.id, online: false }]),
    );
    expect(after.members.map((m) => m.online)).toEqual([true, false]);
  });

  it('没有这个人的会话保持原引用，不会被无谓地重渲染', () => {
    const other = convo({ id: 'c_other', members: [{ ...ME, roleInGroup: '管理员' }] });
    const list = [convo(), other];
    const next = syncPresenceInConversations(list, presenceOf([{ id: PEER.id, online: false }]));
    expect(next).not.toBe(list);
    expect(next[1]).toBe(other);
  });

  it('同一条 presence 重复到达时，整份返回原引用', () => {
    const list = [convo(), dm()];
    const presence = presenceOf([{ id: PEER.id, online: false }]);
    const once = syncPresenceInConversations(list, presence);
    expect(once).not.toBe(list);
    expect(syncPresenceInConversations(once, presence)).toBe(once);
    expect(syncPresenceInConversations(once, presence)[0]).toBe(once[0]);
  });
});

describe('adoptUserList', () => {
  it('心跳拿回来的名单内容一模一样时，留着手里那份，别换数组身份', () => {
    const prev = [ME, PEER];
    expect(adoptUserList(prev, [{ ...ME }, { ...PEER }])).toBe(prev);
  });

  it('有人下线了就整份采用服务端这一版', () => {
    const prev = [ME, PEER];
    const next = [ME, { ...PEER, online: false }];
    expect(adoptUserList(prev, next)).toBe(next);
  });

  it('名单长度变了（新同事进来）同样采用新的', () => {
    const prev = [ME];
    const next = [ME, PEER];
    expect(adoptUserList(prev, next)).toBe(next);
  });
});

describe('syncUserInMessages', () => {
  it('已加载消息上的发送者名字和头像跟着变', () => {
    const next = syncUserInMessages({ c_group: [message()] }, RENAMED);
    expect(next.c_group[0]).toMatchObject({
      senderName: '陈子航（新）', senderAvatarUrl: '/uploads/new.png',
    });
  });

  it('别人发的消息一个字不动', () => {
    const mine = message({ id: 'm2', senderId: ME.id, senderName: ME.name });
    const next = syncUserInMessages({ c_group: [mine] }, RENAMED);
    expect(next.c_group[0]).toBe(mine);
  });

  it('引用摘要：原消息还在本线程里时认得出来，名字跟着变', () => {
    const quoted = message({ id: 'm1' });
    const reply = message({
      id: 'm2', senderId: ME.id, senderName: ME.name, replyTo: 'm1',
      quote: { senderName: '陈子航', preview: '内容', available: true },
    });
    const next = syncUserInMessages({ c_group: [quoted, reply] }, RENAMED);
    expect(next.c_group[1].quote?.senderName).toBe('陈子航（新）');
  });

  it('引用摘要：原消息还没翻页出来时认不出人，那一处先留着旧名字', () => {
    const reply = message({
      id: 'm2', senderId: ME.id, senderName: ME.name, replyTo: 'm_far_away',
      quote: { senderName: '陈子航', preview: '内容', available: true },
    });
    const next = syncUserInMessages({ c_group: [reply] }, RENAMED);
    expect(next.c_group[0].quote?.senderName).toBe('陈子航');
  });

  it('表情回应的悬浮名单里也带着名字，一并对齐', () => {
    const m = message({
      id: 'm3', senderId: ME.id, senderName: ME.name,
      reactions: [{ emoji: '👍', count: 1, mine: false, users: [{ id: PEER.id, name: '陈子航' }] }],
    });
    const next = syncUserInMessages({ c_group: [m] }, RENAMED);
    expect(next.c_group[0].reactions?.[0].users[0].name).toBe('陈子航（新）');
  });

  it('没被这个人碰过的会话桶保持原引用', () => {
    const untouched = [message({ id: 'm9', senderId: ME.id, senderName: ME.name })];
    const all = { c_group: [message()], c_other: untouched };
    const next = syncUserInMessages(all, RENAMED);
    expect(next).not.toBe(all);
    expect(next.c_other).toBe(untouched);
  });

  it('一条都没变时整份返回原引用', () => {
    const all = { c_group: [message()] };
    expect(syncUserInMessages(all, { ...PEER })).toBe(all);
  });
});
