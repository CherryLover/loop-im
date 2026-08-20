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
import { api } from './lib/api';
import { initialOf } from './lib/md';
import { unreadAriaLabel, unreadBadgeClass, unreadLabel } from './lib/format';
import { mergeMessage } from './lib/messages';
import { useStream } from './lib/useStream';
import type { Theme } from './lib/theme';
import type { AiPublicInfo, Conversation, Message, ReadState, User } from './lib/types';

type Tab = 'chat' | 'contacts' | 'ai';

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
  const loaded = useRef<Set<string>>(new Set());
  // loadOlder 要读最新的翻页状态又不想因此重建回调，用 ref 镜像一份。
  const olderRef = useRef<Record<string, OlderState>>({});
  olderRef.current = older;
  // 上次上报已读的时间，用来节流。
  const markedRef = useRef<Record<string, number>>({});
  // SSE 回调里要判断「消息是不是发到当前正开着的会话」，用 ref 拿最新值。
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const isAdmin = me.role === 'admin';

  const refreshConversations = useCallback(async () => {
    const { conversations: list } = await api.conversations();
    setConversations(list);
    setActiveId((current) => current ?? list[0]?.id ?? null);
  }, []);

  const refreshUsers = useCallback(async () => {
    const { users: list } = await api.users();
    setUsers(list);
  }, []);

  const refreshAiInfo = useCallback(async () => {
    const { ai: info } = await api.me();
    setAi(info);
  }, []);

  useEffect(() => {
    void refreshConversations();
    void refreshUsers();
  }, [refreshConversations, refreshUsers]);

  // Heartbeat keeps this client "在线" and refreshes everyone else's presence.
  useEffect(() => {
    const tick = () => api.ping().then((r) => setUsers(r.users)).catch(() => {});
    const timer = window.setInterval(tick, 45_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const loadMessages = useCallback(async (conversationId: string) => {
    const page = await api.messages(conversationId);
    setMessages((m) => ({ ...m, [conversationId]: page.messages }));
    setOlder((o) => ({ ...o, [conversationId]: { cursor: page.nextBefore, hasMore: page.hasMore, loading: false } }));
    setReads((r) => ({ ...r, [conversationId]: page.reads }));
  }, []);

  /**
   * 上报已读。会话打开、窗口重新聚焦、以及在当前会话里收到新消息时都会调用，
   * 所以这里挡一道：同一会话 1 秒内不重复上报，未读本来就是 0 时也不上报。
   */
  const markRead = useCallback(async (conversationId: string) => {
    if (typeof document !== 'undefined' && document.hidden) return;
    const last = markedRef.current[conversationId] || 0;
    if (Date.now() - last < 1000) return;
    markedRef.current[conversationId] = Date.now();
    try {
      await api.markRead(conversationId);
      // 未读清零的同时也清掉「@ 我」那一档，否则高亮徽标会一直挂在读过的会话上。
      setConversations((list) => list.map((c) => (c.id === conversationId ? { ...c, unread: 0, mentionsUnread: 0 } : c)));
    } catch {
      markedRef.current[conversationId] = 0;   // 失败就允许下次重试
    }
  }, []);

  /** 往前翻一页历史，接在当前列表前面。重复点击靠 loading 挡住。 */
  const loadOlder = useCallback(async (conversationId: string) => {
    const state = olderRef.current[conversationId];
    if (!state?.hasMore || state.loading || !state.cursor) return;
    setOlder((o) => ({ ...o, [conversationId]: { ...state, loading: true } }));
    try {
      const page = await api.messages(conversationId, { before: state.cursor });
      setMessages((all) => ({ ...all, [conversationId]: [...page.messages, ...(all[conversationId] || [])] }));
      setOlder((o) => ({ ...o, [conversationId]: { cursor: page.nextBefore, hasMore: page.hasMore, loading: false } }));
    } catch {
      setOlder((o) => ({ ...o, [conversationId]: { ...state, loading: false } }));
    }
  }, []);

  useEffect(() => {
    if (!activeId || loaded.current.has(activeId)) return;
    loaded.current.add(activeId);
    void loadMessages(activeId);
  }, [activeId, loadMessages]);

  // 打开会话即视为读到此刻。
  useEffect(() => {
    if (activeId) void markRead(activeId);
  }, [activeId, markRead]);

  // 从别的标签页/窗口切回来时补一次：期间收到的消息此刻才真正被看到。
  useEffect(() => {
    const onFocus = () => {
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

  useStream(true, {
    onMessage: (message) => {
      appendMessage(message);
      void refreshConversations();
      // 正开着这个会话就直接标已读，别让未读徽标闪一下再消失。
      if (message.conversationId === activeIdRef.current && message.senderId !== me.id) {
        void markRead(message.conversationId);
      }
    },
    onTyping: (conversationId, isTyping) => setTyping((t) => ({ ...t, [conversationId]: isTyping })),
    onConversationCreated: () => void refreshConversations(),
    onUserChanged: () => void refreshUsers(),
    onPresence: () => void refreshUsers(),
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

  const send = useCallback(async (body: string) => {
    const conversationId = activeId;
    if (!conversationId) return;
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
    };
    setMessages((all) => ({ ...all, [conversationId]: [...(all[conversationId] || []), temp] }));
    try {
      const { message } = await api.sendMessage(conversationId, body);
      setMessages((all) => ({
        ...all,
        [conversationId]: mergeMessage((all[conversationId] || []).filter((m) => m.id !== temp.id), message),
      }));
      void refreshConversations();
    } catch (err) {
      setMessages((all) => ({
        ...all,
        [conversationId]: (all[conversationId] || []).filter((m) => m.id !== temp.id),
      }));
      setToast(err instanceof Error ? err.message : '发送失败');
      // 抛回给 Composer：它据此把用户打的字还原到输入框，不能在这里吞掉。
      throw err;
    }
  }, [activeId, me, refreshConversations]);

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
            onCreateGroup={() => setModal('group')}
            onAddMembers={(id) => setManage({ mode: 'add', conversationId: id })}
            onRemoveMember={(id, userId, name) => void removeMember(id, userId, name)}
            onRenameGroup={(id) => setManage({ mode: 'rename', conversationId: id })}
            onLeaveGroup={(id) => setManage({ mode: 'leave', conversationId: id })}
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
            onDone={(message, left) => void onManageDone(message, left)}
          />
        ) : null;
      })() : null}

      {modal === 'group' ? (
        <CreateGroupModal
          users={users}
          meId={me.id}
          onClose={() => setModal(null)}
          onCreated={async (id) => {
            setModal(null);
            await refreshConversations();
            loaded.current.delete(id);
            // 建群后直接进入新群：手机端也要跟着从会话列表切到聊天详情。
            selectConversation(id);
            setTab('chat');
          }}
        />
      ) : null}

      {modal === 'contact' ? (
        <AddContactModal onClose={() => setModal(null)} onCreated={() => void refreshUsers()} />
      ) : null}

      {modal === 'profile' ? (
        <ProfileModal
          me={me}
          theme={theme}
          onToggleTheme={onToggleTheme}
          onClose={() => setModal(null)}
          onUpdated={(user) => {
            setMe(user);
            void refreshUsers();
            void refreshConversations();
          }}
          onSignOut={onSignOut}
        />
      ) : null}
    </div>
  );
}
