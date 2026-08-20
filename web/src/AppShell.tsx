import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, MessageCircle, Users } from 'lucide-react';
import { Logo } from './components/Logo';
import { Toast } from './components/Toast';
import { ChatPage } from './pages/ChatPage';
import { ContactsPage } from './pages/ContactsPage';
import { AiPage } from './pages/AiPage';
import { CreateGroupModal } from './modals/CreateGroupModal';
import { AddContactModal } from './modals/AddContactModal';
import { ProfileModal } from './modals/ProfileModal';
import { ManageGroupModal, type ManageMode } from './modals/ManageGroupModal';
import { ApiError, api } from './lib/api';
import { initialOf } from './lib/md';
import { unreadAriaLabel, unreadBadgeClass, unreadLabel } from './lib/format';
import { mergeMessage, replyTargetOf } from './lib/messages';
import { sortConversations } from './lib/conversations';
import { notifyMessage, useDesktopNotify } from './lib/notify';
import { useStream } from './lib/useStream';
import type { Theme } from './lib/theme';
import type { AiPublicInfo, Conversation, Message, MessageReaction, ReadState, User } from './lib/types';

type Tab = 'chat' | 'contacts' | 'ai';

// 与 styles.css 里 `@media (max-width: 720px)` 的断点一致：手机布局下会话列表和聊天详情
// 是前后两屏（.chat--hidden），桌面布局下两者并排常驻。判断「详情露出来没有」得先知道是哪一种。
const MOBILE_QUERY = '(max-width: 720px)';
const MOBILE_MAX_WIDTH = 720;

function isMobileViewport() {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') return window.matchMedia(MOBILE_QUERY).matches;
  return window.innerWidth > 0 && window.innerWidth <= MOBILE_MAX_WIDTH;
}

/** 请求被主动取消（退出登录、组件卸载）不是错误，是预期内的结束。 */
function isAbortError(err: unknown) {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

interface OlderState {
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
}

interface AppShellProps {
  me: User;
  ai: AiPublicInfo;
  theme: Theme;
  onToggleTheme: () => void;
  onSignOut: () => void;
  justSignedIn: boolean;
}

export function AppShell({ me: initialMe, ai: initialAi, theme, onToggleTheme, onSignOut, justSignedIn }: AppShellProps) {
  const [me, setMe] = useState(initialMe);
  const [ai, setAi] = useState(initialAi);
  const [tab, setTab] = useState<Tab>('chat');
  const [users, setUsers] = useState<User[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  // 每个会话的历史翻页状态：下一页游标、还有没有更早的、是否正在加载。
  const [older, setOlder] = useState<Record<string, OlderState>>({});
  // 每个会话里其他人的已读位置，用来把自己的气泡标成「已读」。
  const [reads, setReads] = useState<Record<string, ReadState[]>>({});
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  // 手机端「会话列表 / 会话详情」的开合状态放在这里，切换底部 tab 时不会被重置。
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [modal, setModal] = useState<'group' | 'contact' | 'profile' | null>(null);
  // 群管理弹窗：加人 / 改群名 / 退群，三者共用一个组件。
  const [manage, setManage] = useState<{ mode: ManageMode; conversationId: string } | null>(null);
  const [toast, setToast] = useState(justSignedIn ? '已上线 · 与服务器保持连接' : '');
  // 浏览器标签页可不可见。存成状态而不是每次现读 document.hidden：可见性一变，
  // 「详情是不是在眼前」要跟着重算，切回来时才能补报已读。
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  const [mobileLayout, setMobileLayout] = useState(isMobileViewport);
  // 已经开始退出登录：实时连接、心跳和后台刷新都要立刻停手（issue #21）。
  const [signingOut, setSigningOut] = useState(false);
  const loaded = useRef<Set<string>>(new Set());
  // loadOlder 要读最新的翻页状态又不想因此重建回调，用 ref 镜像一份。
  const olderRef = useRef<Record<string, OlderState>>({});
  olderRef.current = older;
  // 上次上报的已读位置：{ 上报时刻, 报到哪条消息 }。用来节流，也用来避免重复上报同一位置。
  const markedRef = useRef<Record<string, { at: number; upTo: number }>>({});
  // SSE 回调里要判断「消息是不是发到当前正开着的会话」，用 ref 拿最新值。
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  // send 里要就地查出被引用的那条消息来拼乐观气泡的引用块，同样用 ref，免得进 deps。
  const messagesRef = useRef<Record<string, Message[]>>({});
  messagesRef.current = messages;
  // 改置顶/免打扰时要拿到改之前的那一项来做回滚，用 ref 镜像一份，免得进 deps。
  const conversationsRef = useRef<Conversation[]>([]);
  conversationsRef.current = conversations;
  const signingOutRef = useRef(false);
  // 退出或卸载时要把在途的列表 / 消息请求一起取消：它们的凭据马上就作废了。
  const abortRef = useRef<AbortController | null>(null);

  // 桌面通知的开关与权限。权限只在用户于个人资料里主动打开时才申请，页面加载时不碰。
  const notify = useDesktopNotify();

  const isAdmin = me.role === 'admin';

  /**
   * 「聊天详情真的在用户眼前」——所有已读上报共用这一个判据（issue #20）。
   * 选中了某个会话不等于用户正看着它：切到联系人 / AI 管理页、手机端从详情退回会话列表、
   * 浏览器标签页切走，详情都不在眼前，这期间收到的新消息不能算已读。
   */
  const desktopDetailShown = !mobileLayout && activeId !== null;      // 桌面布局：详情与列表并排常驻
  const mobileDetailShown = mobileLayout && mobileChatOpen && activeId !== null;
  const chatDetailVisible = tab === 'chat' && pageVisible && (desktopDetailShown || mobileDetailShown);
  const chatDetailVisibleRef = useRef(false);
  chatDetailVisibleRef.current = chatDetailVisible;

  /**
   * 「某个会话里的消息此刻正摆在用户眼前」——已读上报和桌面通知共用的唯一判据。
   * 在 chatDetailVisible（issue #20 的定义）之上再加一条：露着的得正好是这个会话。
   * 两件事共用它，同一条消息就不可能既被标成已读、又弹出一个通知来。
   */
  const messageVisibleNow = useCallback(
    (conversationId: string) => chatDetailVisibleRef.current && conversationId === activeIdRef.current,
    [],
  );

  /**
   * 当前会话里「别人发的、此刻确实渲染出来了的」最后一条消息的时间——已读只能报到这里。
   * null 表示这个会话的消息还没加载出来，此时报已读等于闭着眼睛报，先不报。
   * 自己发的消息不算「读到了什么」，不参与计算，也就不会因为自己发言而触发上报。
   */
  const readTarget = useMemo(() => {
    const list = activeId ? messages[activeId] : undefined;
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].senderId !== me.id) return list[i].createdAt;
    }
    return 0;                                   // 加载过了，但没有别人发的消息
  }, [activeId, messages, me.id]);
  const readTargetRef = useRef<number | null>(null);
  readTargetRef.current = readTarget;

  /** 列表 / 消息请求共用的取消信号；退出或卸载时一次性掐掉。 */
  const abortSignal = useCallback(() => {
    if (!abortRef.current) abortRef.current = new AbortController();
    return abortRef.current.signal;
  }, []);

  const abortInFlight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;                    // 置空：StrictMode 会挂载两次，下次要用时再开一张新的
  }, []);

  useEffect(() => abortInFlight, [abortInFlight]);

  /**
   * 「发出去就不等结果」的请求统一在这里收尾（issue #21）：
   * - 取消掉的：主动退出或组件卸载导致的，预期内，安静收场；
   * - 401：凭据已经不作数了，api 层已经清掉本地登录态并把用户送回登录页，
   *   这里只需把这个 rejection 正常消费掉，不再让它冒成没人接的页面错误；
   * - 其余失败：仍然要留下痕迹，别让后台刷新静默失效。
   */
  const background = useCallback((task: Promise<unknown>, what: string) => {
    void task.catch((err: unknown) => {
      if (isAbortError(err)) return;
      if (err instanceof ApiError && err.status === 401) return;
      console.warn(`[loop-im] ${what}失败`, err);
    });
  }, []);

  const refreshConversations = useCallback(async () => {
    if (signingOutRef.current) return;
    const { conversations: list } = await api.conversations({ signal: abortSignal() });
    setConversations(list);
    setActiveId((current) => current ?? list[0]?.id ?? null);
  }, [abortSignal]);

  const refreshUsers = useCallback(async () => {
    if (signingOutRef.current) return;
    const { users: list } = await api.users({ signal: abortSignal() });
    setUsers(list);
  }, [abortSignal]);

  const refreshAiInfo = useCallback(async () => {
    if (signingOutRef.current) return;
    const { ai: info } = await api.me();
    setAi(info);
  }, []);

  useEffect(() => {
    background(refreshConversations(), '刷新会话列表');
    background(refreshUsers(), '刷新联系人');
  }, [refreshConversations, refreshUsers, background]);

  // Heartbeat keeps this client "在线" and refreshes everyone else's presence.
  useEffect(() => {
    if (signingOut) return;
    const tick = () => background(api.ping().then((r) => setUsers(r.users)), '心跳');
    const timer = window.setInterval(tick, 45_000);
    return () => window.clearInterval(timer);
  }, [signingOut, background]);

  // 视口在断点两侧变化时重算布局：桌面转手机后，详情是不是还露着会跟着变。
  useEffect(() => {
    const sync = () => setMobileLayout(isMobileViewport());
    sync();
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_QUERY) : null;
    if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', sync);
    window.addEventListener('resize', sync);
    return () => {
      if (mq && typeof mq.removeEventListener === 'function') mq.removeEventListener('change', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const loadMessages = useCallback(async (conversationId: string) => {
    const page = await api.messages(conversationId, { signal: abortSignal() });
    setMessages((m) => ({ ...m, [conversationId]: page.messages }));
    setOlder((o) => ({ ...o, [conversationId]: { cursor: page.nextBefore, hasMore: page.hasMore, loading: false } }));
    setReads((r) => ({ ...r, [conversationId]: page.reads }));
  }, [abortSignal]);

  /**
   * 上报已读。打开会话、回到详情、窗口重新可见、详情里渲染出别人的新消息，都调这一个。
   * 判据只有 messageVisibleNow 一个（见上），此外再挡两道：
   * 同一位置 1 秒内不重复上报；消息还没渲染出来时不报，等这一轮渲染完 effect 会补上。
   */
  const markRead = useCallback(async (conversationId: string) => {
    if (!messageVisibleNow(conversationId) || signingOutRef.current) return;
    const upTo = readTargetRef.current;
    if (upTo === null) return;
    const last = markedRef.current[conversationId];
    if (last && upTo <= last.upTo && Date.now() - last.at < 1000) return;
    markedRef.current[conversationId] = { at: Date.now(), upTo };
    try {
      // 报到「此刻真的渲染出来的最后一条」，别顺手把还没进列表的新消息也标成已读。
      await api.markRead(conversationId, upTo || undefined);
      // 未读清零的同时也清掉「@ 我」那一档，否则高亮徽标会一直挂在读过的会话上。
      setConversations((list) => list.map((c) => (c.id === conversationId ? { ...c, unread: 0, mentionsUnread: 0 } : c)));
    } catch (err) {
      delete markedRef.current[conversationId];   // 失败就允许下次重试
      if (!isAbortError(err) && !(err instanceof ApiError && err.status === 401)) {
        console.warn('[loop-im] 上报已读失败', err);
      }
    }
  }, [messageVisibleNow]);

  /** 往前翻一页历史，接在当前列表前面。重复点击靠 loading 挡住。 */
  const loadOlder = useCallback(async (conversationId: string) => {
    const state = olderRef.current[conversationId];
    if (!state?.hasMore || state.loading || !state.cursor) return;
    setOlder((o) => ({ ...o, [conversationId]: { ...state, loading: true } }));
    try {
      const page = await api.messages(conversationId, { before: state.cursor, signal: abortSignal() });
      setMessages((all) => ({ ...all, [conversationId]: [...page.messages, ...(all[conversationId] || [])] }));
      setOlder((o) => ({ ...o, [conversationId]: { cursor: page.nextBefore, hasMore: page.hasMore, loading: false } }));
    } catch (err) {
      if (isAbortError(err)) return;             // 已经在退出/卸载了，不用再恢复按钮
      setOlder((o) => ({ ...o, [conversationId]: { ...state, loading: false } }));
    }
  }, [abortSignal]);

  useEffect(() => {
    if (!activeId || loaded.current.has(activeId)) return;
    const id = activeId;
    loaded.current.add(id);
    background(loadMessages(id).catch((err) => {
      loaded.current.delete(id);                 // 取消或失败都允许下次重新加载
      throw err;
    }), '加载消息');
  }, [activeId, loadMessages, background]);

  // 已读上报的唯一入口：详情真的在眼前时报一次。打开会话、从联系人 / AI 页或手机会话列表
  // 回到详情、标签页重新可见、详情里渲染出别人的新消息，都会让这里重跑一遍。
  useEffect(() => {
    if (!chatDetailVisible || !activeId) return;
    void markRead(activeId);
  }, [chatDetailVisible, activeId, readTarget, markRead]);

  // 从别的标签页/窗口切回来时补一次：期间收到的消息此刻才真正被看到。
  useEffect(() => {
    const onFocus = () => {
      setPageVisible(!document.hidden);
      if (!document.hidden && activeIdRef.current) void markRead(activeIdRef.current);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [markRead]);

  const appendMessage = useCallback((message: Message) => {
    setMessages((all) => ({
      ...all,
      [message.conversationId]: mergeMessage(all[message.conversationId] || [], message),
    }));
  }, []);

  /**
   * 把某条消息的回应换成服务端给的最新一份。整份替换而不是就地加减：计数、都有谁、
   * 我点没点都由服务端算好，前端自己拼容易和别人同时点时算岔。
   * 那个会话还没加载过（或消息已经翻页出去了）就什么也不做，等下次读消息时一起带回来。
   */
  const applyReactions = useCallback((conversationId: string, messageId: string, reactions: MessageReaction[]) => {
    setMessages((all) => {
      const list = all[conversationId];
      if (!list?.some((m) => m.id === messageId)) return all;
      return { ...all, [conversationId]: list.map((m) => (m.id === messageId ? { ...m, reactions } : m)) };
    });
  }, []);

  /** 点一个表情：自己点过就是取消，没点过就是加上。两个接口都返回最新聚合。 */
  const toggleReaction = useCallback(async (message: Message, emoji: string) => {
    const { conversationId, id } = message;
    const mine = (message.reactions || []).some((r) => r.emoji === emoji && r.mine);
    try {
      const res = mine
        ? await api.removeReaction(conversationId, id, emoji)
        : await api.addReaction(conversationId, id, emoji);
      applyReactions(conversationId, id, res.reactions);
    } catch (err) {
      if (isAbortError(err) || (err instanceof ApiError && err.status === 401)) return;
      setToast(err instanceof Error ? err.message : '操作失败');
    }
  }, [applyReactions]);

  // 退出一开始就断开实时连接：等待退出接口返回的这段时间里，再进来的事件只会引出
  // 一串注定 401 的请求（issue #21）。
  useStream(!signingOut, {
    onMessage: (message) => {
      appendMessage(message);
      // 桌面通知和已读上报共用 messageVisibleNow：看得见就只标已读、不通知，
      // 看不见（切走了标签页、在联系人页、手机端退回了会话列表）才弹通知。
      // 自己发的、系统消息、免打扰会话、没开开关或没权限，都在 notifyMessage 里挡掉。
      notifyMessage({
        message,
        conversation: conversations.find((c) => c.id === message.conversationId),
        meId: me.id,
        visible: messageVisibleNow(message.conversationId),
        enabled: notify.enabled,
        onClick: () => {
          setTab('chat');
          selectConversation(message.conversationId);
        },
      });
      background(refreshConversations(), '刷新会话列表');
      // 已读不在这里报：消息进了列表、而且详情确实在眼前时，上面那个 effect 会报。
      // 只按会话 id 判断的话，人在联系人页 / AI 页 / 手机会话列表也会被标成已读（issue #20）。
    },
    onTyping: (conversationId, isTyping) => setTyping((t) => ({ ...t, [conversationId]: isTyping })),
    onConversationCreated: () => background(refreshConversations(), '刷新会话列表'),
    onUserChanged: () => background(refreshUsers(), '刷新联系人'),
    onPresence: () => background(refreshUsers(), '刷新联系人'),
    // 别人点了回应，我这边立刻跟着变。服务端按人各发一份，mine 已经是我这一份。
    onReaction: (conversationId, messageId, reactions) => applyReactions(conversationId, messageId, reactions),
    onRead: (conversationId, userId, lastReadAt) => {
      setReads((all) => {
        const list = all[conversationId] || [];
        const next = list.some((r) => r.userId === userId)
          ? list.map((r) => (r.userId === userId ? { ...r, lastReadAt } : r))
          : [...list, { userId, lastReadAt }];
        return { ...all, [conversationId]: next };
      });
    },
  });

  const send = useCallback(async (body: string, replyTo?: string | null) => {
    const conversationId = activeId;
    if (!conversationId) return;
    // 乐观气泡也要带上引用块，否则从回车到服务端确认之间引用会先消失再冒出来。
    // 摘要就地从已加载的消息里取；取不到（原消息还没翻页出来）就先不显示，
    // 服务端确认的那条消息会带着权威摘要把它替换掉。
    const quoted = replyTo ? (messagesRef.current[conversationId] || []).find((m) => m.id === replyTo) : undefined;
    const quotedTarget = quoted ? replyTargetOf(quoted) : null;
    const temp: Message = {
      id: `tmp_${Date.now()}`,
      conversationId,
      senderId: me.id,
      senderName: me.name,
      senderAvatarUrl: me.avatarUrl,
      body,
      mentions: [],
      createdAt: Date.now(),
      isAI: false,
      pending: true,
      replyTo: replyTo ?? null,
      quote: quotedTarget
        ? { senderName: quotedTarget.senderName, preview: quotedTarget.preview, available: true }
        : null,
    };
    setMessages((all) => ({ ...all, [conversationId]: [...(all[conversationId] || []), temp] }));
    try {
      // 不引用时不带第三个参数，请求形态和以前一致。
      const { message } = replyTo
        ? await api.sendMessage(conversationId, body, replyTo)
        : await api.sendMessage(conversationId, body);
      setMessages((all) => ({
        ...all,
        [conversationId]: mergeMessage((all[conversationId] || []).filter((m) => m.id !== temp.id), message),
      }));
      background(refreshConversations(), '刷新会话列表');
    } catch (err) {
      setMessages((all) => ({
        ...all,
        [conversationId]: (all[conversationId] || []).filter((m) => m.id !== temp.id),
      }));
      setToast(err instanceof Error ? err.message : '发送失败');
      // 抛回给 Composer：它据此把用户打的字还原到输入框，不能在这里吞掉。
      throw err;
    }
  }, [activeId, me, refreshConversations, background]);

  /** 主动退出：先掐掉实时连接、心跳和在途请求，再交给上层清登录态（issue #21）。 */
  const handleSignOut = useCallback(() => {
    signingOutRef.current = true;
    setSigningOut(true);
    abortInFlight();
    onSignOut();
  }, [abortInFlight, onSignOut]);

  /**
   * 置顶 / 免打扰：先本地就位再落库。置顶会让这一项跳到列表顶部，等一轮往返再动
   * 会有明显的迟滞感，所以就地改完顺手重排（口径与服务端同一份，见 lib/conversations.ts）。
   * 失败就把这一项整个换回改之前的样子并提示——设置没存上却留着新样子，比不改更让人困惑。
   *
   * 注意这里只碰 pinned / muted 两个字段：unread、mentionsUnread 一律不动。
   * 设为免打扰不代表这个会话被读过，未读该是多少还是多少。
   */
  const setConversationPrefs = useCallback(async (
    conversationId: string,
    patch: { pinned?: boolean; muted?: boolean },
  ) => {
    const before = conversationsRef.current.find((c) => c.id === conversationId);
    setConversations((list) =>
      sortConversations(list.map((c) => (c.id === conversationId ? { ...c, ...patch } : c))));
    try {
      await api.updateConversationPrefs(conversationId, patch);
    } catch (err) {
      if (before) {
        setConversations((list) => sortConversations(list.map((c) => (c.id === conversationId ? before : c))));
      }
      setToast(err instanceof Error ? err.message : '设置失败');
    }
  }, []);

  /** 移除成员：可逆操作（还能再加回来），所以不额外弹确认，用提示条回执。 */
  const removeMember = useCallback(async (conversationId: string, userId: string, name: string) => {
    try {
      await api.removeMember(conversationId, userId);
      await refreshConversations();
      setToast(`已将 ${name} 移出群聊`);
    } catch (err) {
      setToast(err instanceof Error ? err.message : '移除失败');
    }
  }, [refreshConversations]);

  /** 群管理弹窗完成后：刷新会话；如果是退群，还要把选中项切走。 */
  const onManageDone = useCallback(async (message: string, left?: boolean) => {
    setManage(null);
    setToast(message);
    if (left) {
      setActiveId(null);
      setMobileChatOpen(false);
    }
    await refreshConversations();
  }, [refreshConversations]);

  // 主动选中某个会话：手机端同时展开会话详情。自动选中（如登录后的首个会话）不走这里。
  const selectConversation = useCallback((id: string) => {
    setActiveId(id);
    setMobileChatOpen(true);
  }, []);

  const openDirect = useCallback(async (userId: string) => {
    try {
      const { conversation } = await api.openDirect(userId);
      await refreshConversations();
      selectConversation(conversation.id);
      setTab('chat');
    } catch (err) {
      setToast(err instanceof Error ? err.message : '无法发起会话');
    }
  }, [refreshConversations, selectConversation]);

  const navItems = useMemo(() => {
    const items: { key: Tab; label: string; short: string; icon: typeof MessageCircle }[] = [
      { key: 'chat', label: '会话', short: '会话', icon: MessageCircle },
      { key: 'contacts', label: '联系人', short: '联系人', icon: Users },
    ];
    if (isAdmin) items.push({ key: 'ai', label: 'AI 管理', short: 'AI', icon: Bot });
    return items;
  }, [isAdmin]);

  const activeMessages = activeId ? messages[activeId] || [] : [];
  const activeReads = activeId ? reads[activeId] || [] : [];
  const totalUnread = conversations.reduce((n, c) => n + (c.unread || 0), 0);
  // 总徽标也要体现「有 @ 我」这一档：不然点进会话列表前根本看不出有人在叫我。
  const totalMentions = conversations.reduce((n, c) => n + (c.mentionsUnread || 0), 0);
  const unreadBadge = (
    <span className={unreadBadgeClass(totalMentions)} aria-label={unreadAriaLabel(totalUnread, totalMentions)}>
      {totalMentions > 0 ? <span className="badge__at" aria-hidden="true">@</span> : null}
      {unreadLabel(totalUnread)}
    </span>
  );

  return (
    <div className="app">
      {toast ? <Toast text={toast} /> : null}

      <div className="app__body">
        <nav className="sidebar">
          <div className="sidebar__logo"><Logo size={17} /></div>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                className={`nav-btn${tab === item.key ? ' nav-btn--on' : ''}`}
                title={item.label}
                aria-current={tab === item.key}
                onClick={() => setTab(item.key)}
              >
                <span className="nav-btn__icon">
                  <Icon size={16} />
                  {item.key === 'chat' && totalUnread > 0 ? unreadBadge : null}
                </span>
                {item.short}
              </button>
            );
          })}
          <button type="button" className="sidebar__me" title="个人资料" onClick={() => setModal('profile')}>
            {me.avatarUrl ? <img src={me.avatarUrl} alt={me.name} /> : initialOf(me.name)}
            <span className="sidebar__me-dot" />
          </button>
        </nav>

        {tab === 'chat' ? (
          <ChatPage
            me={me}
            conversations={conversations}
            activeId={activeId}
            messages={activeMessages}
            typing={activeId ? !!typing[activeId] : false}
            aiProviderLabel={ai.providerLabel}
            silentRead={ai.silentRead}
            canCreateGroup={isAdmin}
            showChatOnMobile={mobileChatOpen}
            reads={activeReads}
            hasOlder={activeId ? !!older[activeId]?.hasMore : false}
            loadingOlder={activeId ? !!older[activeId]?.loading : false}
            onLoadOlder={() => { if (activeId) void loadOlder(activeId); }}
            onSelect={selectConversation}
            onBack={() => setMobileChatOpen(false)}
            onSend={send}
            onReact={(message, emoji) => void toggleReaction(message, emoji)}
            onCreateGroup={() => setModal('group')}
            onAddMembers={(id) => setManage({ mode: 'add', conversationId: id })}
            onRemoveMember={(id, userId, name) => void removeMember(id, userId, name)}
            onRenameGroup={(id) => setManage({ mode: 'rename', conversationId: id })}
            onLeaveGroup={(id) => setManage({ mode: 'leave', conversationId: id })}
            onTogglePin={(id, pinned) => void setConversationPrefs(id, { pinned })}
            onToggleMute={(id, muted) => void setConversationPrefs(id, { muted })}
          />
        ) : null}

        {tab === 'contacts' ? (
          <ContactsPage
            me={me}
            users={users}
            isAdmin={isAdmin}
            onChat={openDirect}
            onAddContact={() => setModal('contact')}
            onCreateGroup={() => setModal('group')}
          />
        ) : null}

        {tab === 'ai' && isAdmin ? <AiPage onSettingsSaved={refreshAiInfo} /> : null}
      </div>

      <nav className="tabbar">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              type="button"
              className={`tab${tab === item.key ? ' tab--on' : ''}`}
              onClick={() => setTab(item.key)}
            >
              <span className="nav-btn__icon">
                <Icon size={16} />
                {item.key === 'chat' && totalUnread > 0 ? unreadBadge : null}
              </span>
              {item.label}
            </button>
          );
        })}
        <button type="button" className="tab" onClick={() => setModal('profile')}>
          <span style={{ width: 16, height: 16, borderRadius: 99, background: 'var(--surface3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8.5, color: 'var(--text)' }}>
            {initialOf(me.name)}
          </span>
          我
        </button>
      </nav>

      {manage ? (() => {
        const target = conversations.find((c) => c.id === manage.conversationId);
        return target ? (
          <ManageGroupModal
            mode={manage.mode}
            conversation={target}
            users={users}
            onClose={() => setManage(null)}
            onDone={(message, left) => background(onManageDone(message, left), '刷新会话列表')}
          />
        ) : null;
      })() : null}

      {modal === 'group' ? (
        <CreateGroupModal
          users={users}
          meId={me.id}
          onClose={() => setModal(null)}
          onCreated={(id) => {
            setModal(null);
            background(refreshConversations().then(() => {
              loaded.current.delete(id);
              // 建群后直接进入新群：手机端也要跟着从会话列表切到聊天详情。
              selectConversation(id);
              setTab('chat');
            }), '刷新会话列表');
          }}
        />
      ) : null}

      {modal === 'contact' ? (
        <AddContactModal onClose={() => setModal(null)} onCreated={() => background(refreshUsers(), '刷新联系人')} />
      ) : null}

      {modal === 'profile' ? (
        <ProfileModal
          me={me}
          theme={theme}
          onToggleTheme={onToggleTheme}
          notifyEnabled={notify.enabled}
          notifyPermission={notify.permission}
          onToggleNotify={() => void notify.toggle()}
          onClose={() => setModal(null)}
          onUpdated={(user) => {
            setMe(user);
            background(refreshUsers(), '刷新联系人');
            background(refreshConversations(), '刷新会话列表');
          }}
          onSignOut={handleSignOut}
        />
      ) : null}
    </div>
  );
}
