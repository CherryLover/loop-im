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
 * 本文件每个导出函数都遵守同一条约定：**没有任何字段真的变化时，原样返回传进来的那个
 * 引用**。会话列表和消息表都是 React 状态，无脑造新数组等于每收到一次广播就把整棵子树
 * 重渲染一遍（连带 MessageList 里按引用比较的那些判断全部失效）。
 *
 * 上下线（presence）也在这里，但走的是单独一条窄口径的路，理由见下面 PresenceMap 那一段。
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

/**
 * 上下线单独走一条窄口径的路，不复用上面那几个函数。
 *
 * 因为手里只有 `{ userId, online }`：`presence` 事件就带这两个字段（服务端在登录、
 * 退出、停用、重置密码时发，见 routes/auth.js、routes/users.js）。不要「先从联系人名单里
 * 查出完整的 User 再 spread 进去」—— 那个人可能压根还不在名单里（刚开通的账号），
 * 而且会让在线点准不准取决于另一份状态是不是最新的，等于把一个 bug 换成两个。
 *
 * 心跳（POST /auth/ping 返回整份名单）走的也是这里：把名单折成一张 id -> online 的表
 * 传进来即可。这一路尤其要紧 —— 「关掉浏览器就走了」这种下线服务端不发任何事件，
 * 90 秒窗口过期后只有心跳能发现它。
 *
 * 同样守本文件那条约定：真有人变了才造新对象，否则原样返回。presence 比改名频繁得多
 * （每次登录退出，外加每 45 秒一轮心跳），在这里省下的就是整棵会话子树的重渲染。
 */
export type PresenceMap = ReadonlyMap<string, boolean>;

/** 把一份名单（心跳返回的整份、或单个 presence 事件凑出来的一条）折成 presence 表。 */
export const presenceOf = (users: Pick<User, 'id' | 'online'>[]): PresenceMap =>
  new Map(users.map((u) => [u.id, u.online]));

/**
 * 这张表说这个人现在是什么状态；表里没提到他就保持原样。
 * 已停用的账号一律离线，口径同服务端 auth.js 的 isOnline —— 停用广播的顺序是
 * presence 在前、user-updated 在后，这里再挡一道，免得一条迟到的 online 把他重新点亮。
 */
const onlineIn = (user: User, presence: PresenceMap) => {
  const next = presence.get(user.id);
  return next === undefined ? user.online : next && !user.disabled;
};

/** 名单里每个人的在线状态；只碰 online 这一个字段，名字头像一概不动。 */
export function syncPresenceInList<T extends User>(list: T[], presence: PresenceMap): T[] {
  let changed = false;
  const next = list.map((u) => {
    const online = onlineIn(u, presence);
    if (online === u.online) return u;
    changed = true;
    return { ...u, online };
  });
  return changed ? next : list;
}

/**
 * 会话列表里那一份成员拷贝。单聊标题是对方的名字，跟在线状态无关，不动。
 * 没有成员变化的会话保持原引用（连带 ChatPage 里按引用比较的那些判断继续生效）。
 */
export function syncPresenceInConversations(list: Conversation[], presence: PresenceMap): Conversation[] {
  let changed = false;
  const next = list.map((c) => {
    const members = syncPresenceInList(c.members, presence);
    if (members === c.members) return c;
    changed = true;
    return { ...c, members };
  });
  return changed ? next : list;
}

/**
 * 心跳返回的是**整份**名单，直接 setUsers 就是每 45 秒换一个新数组、把联系人页
 * 白白重渲染一遍。逐行比过一遍确实一个字都没变（绝大多数时候如此）就留着旧的那份。
 *
 * 只要有一行变了就整份采用服务端这一版：它是权威值，顺序也是它定的（同 syncUserInList），
 * 前端不在这里逐行拼一个「一半旧一半新」的名单。
 */
export function adoptUserList(prev: User[], next: User[]): User[] {
  if (prev.length !== next.length) return next;
  const same = prev.every((u, i) => u.id === next[i].id && sameUserFacts(u, next[i]));
  return same ? prev : next;
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
