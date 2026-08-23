import type { Conversation, Message, MessageReaction, User } from './types';

/**
 * 有人改了名字或换了头像之后，把**已经拷进前端状态里的那几份用户资料**就地对齐。
 *
 * 为什么需要这么一层：服务端从来不存这些拷贝 —— 会话成员、消息的 senderName /
 * senderAvatarUrl、引用摘要里的名字、表情回应的名单，全是 `JOIN users` 现算的
 * （见 server/src/routes/conversations.js）。也就是说「跟着人变」本来就是这套接口的
 * 语义，任何一次重新拉取都会给出新名字。前端只是把手里那份已经渲染出来的拷贝对齐，
 * 不是在改语义，更不是把「历史快照」改成「跟随」——那种快照本仓库从来没有过。
 *
 * 为什么不直接重拉：`user-updated` 是广播事件，一个人改名，全站每个客户端都会收到。
 * 在这里重拉会话列表和每个已加载会话的消息，代价是一次改名换来 N 个请求，还会把
 * 消息列表的滚动位置、翻页游标（older）和乐观气泡一起冲掉。
 *
 * 三个函数遵守同一条约定：**没有任何字段真的变化时，原样返回传进来的那个引用**。
 * 会话列表和消息表都是 React 状态，无脑造新数组等于每收到一次广播就把整棵子树
 * 重渲染一遍（连带 MessageList 里按引用比较的那些判断全部失效）。
 */

/** 会随「改资料 / 停用 / 上下线」变化的字段。只比这些，够判断要不要造新对象了。 */
const sameUserFacts = (a: User, b: User) =>
  a.name === b.name
  && a.avatarUrl === b.avatarUrl
  && a.disabled === b.disabled
  && a.online === b.online
  && a.dept === b.dept
  && a.role === b.role
  && a.email === b.email;

/**
 * 联系人名单里的那一行换成新的。
 * 名单里没有这个人（`user-created` 走的是同一个事件回调）时原样返回，
 * 由调用方决定要不要为此重拉一次名单 —— 这里不擅自往名单里插行，顺序是服务端定的。
 */
export function syncUserInList(list: User[], user: User): User[] {
  const at = list.findIndex((u) => u.id === user.id);
  if (at < 0 || sameUserFacts(list[at], user)) return list;
  const next = list.slice();
  next[at] = { ...list[at], ...user };
  return next;
}

/**
 * 会话列表：成员那一份拷贝，外加单聊 / AI 会话的标题（它就是对方的名字，
 * 口径同服务端 serializeConversation）。群聊标题是群名，与谁改名无关。
 *
 * roleInGroup 是「在这个群里的身份」（群主 / 常驻 / 部门），不随个人资料变，
 * 本系统也没有改部门的入口，所以原样留着，不在这里重算一遍服务端的规则。
 */
export function syncUserInConversations(list: Conversation[], user: User, meId: string): Conversation[] {
  let changed = false;
  const next = list.map((c) => {
    const at = c.members.findIndex((m) => m.id === user.id);
    if (at < 0) return c;
    const before = c.members[at];
    // 单聊里对方就是标题；改名的是我自己时标题不动（我看到的是对方的名字）。
    const title = c.type !== 'group' && user.id !== meId ? user.name : c.title;
    if (title === c.title && sameUserFacts(before, user)) return c;
    changed = true;
    const members = c.members.slice();
    members[at] = { ...before, ...user, roleInGroup: before.roleInGroup };
    return { ...c, title, members };
  });
  return changed ? next : list;
}

/** 表情回应的悬浮名单里也带着名字（`users[].name`），一并对齐。 */
function syncReactions(list: MessageReaction[] | undefined, user: User): MessageReaction[] | undefined {
  if (!list?.length) return list;
  let changed = false;
  const next = list.map((r) => {
    const at = r.users.findIndex((u) => u.id === user.id);
    if (at < 0 || r.users[at].name === user.name) return r;
    changed = true;
    const users = r.users.slice();
    users[at] = { ...users[at], name: user.name };
    return { ...r, users };
  });
  return changed ? next : list;
}

/**
 * 一个会话里已加载的那些消息。
 *
 * 引用摘要（quote）里只有名字、没有 senderId，只能靠 replyTo 回查本线程里的原消息
 * 来认人。原消息还没翻页出来时认不出来，那一处就先留着旧名字，等下次拉取由服务端纠正
 * —— 那种情况下引用块本来也跳不过去，影响面很小。
 */
function syncUserInThread(list: Message[], user: User): Message[] {
  const senderOf = new Map(list.map((m) => [m.id, m.senderId]));
  let changed = false;
  const next = list.map((m) => {
    const patch: Partial<Message> = {};
    if (m.senderId === user.id) {
      if (m.senderName !== user.name) patch.senderName = user.name;
      if (m.senderAvatarUrl !== user.avatarUrl) patch.senderAvatarUrl = user.avatarUrl;
    }
    if (m.quote?.available && m.replyTo && senderOf.get(m.replyTo) === user.id
        && m.quote.senderName !== user.name) {
      patch.quote = { ...m.quote, senderName: user.name };
    }
    const reactions = syncReactions(m.reactions, user);
    if (reactions !== m.reactions) patch.reactions = reactions;
    if (!Object.keys(patch).length) return m;
    changed = true;
    return { ...m, ...patch };
  });
  return changed ? next : list;
}

/** 按会话分桶的消息表；没被这个人碰过的那些桶保持原引用。 */
export function syncUserInMessages(all: Record<string, Message[]>, user: User): Record<string, Message[]> {
  let changed = false;
  const next: Record<string, Message[]> = {};
  for (const [conversationId, list] of Object.entries(all)) {
    const patched = syncUserInThread(list, user);
    if (patched !== list) changed = true;
    next[conversationId] = patched;
  }
  return changed ? next : all;
}
