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
import { api } from './lib/api';
import { initialOf } from './lib/md';
import { mergeMessage } from './lib/messages';
import { useStream } from './lib/useStream';
import type { Theme } from './lib/theme';
import type { AiPublicInfo, Conversation, Message, User } from './lib/types';

type Tab = 'chat' | 'contacts' | 'ai';

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
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  // 手机端「会话列表 / 会话详情」的开合状态放在这里，切换底部 tab 时不会被重置。
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [modal, setModal] = useState<'group' | 'contact' | 'profile' | null>(null);
  const [toast, setToast] = useState(justSignedIn ? '已上线 · 与服务器保持连接' : '');
  // 建群成功后记下新群 id，通知 ChatPage 在手机端直接展开它的聊天详情。
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null);
  const loaded = useRef<Set<string>>(new Set());

  const isAdmin = me.role === 'admin';

  const refreshConversations = useCallback(async () => {
    const { conversations: list } = await api.conversations();
    setConversations(list);
    setActiveId((current) => current ?? list[0]?.id ?? null);
  }, []);

  const clearPendingOpen = useCallback(() => setPendingOpenId(null), []);

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
    const { messages: list } = await api.messages(conversationId);
    setMessages((m) => ({ ...m, [conversationId]: list }));
  }, []);

  useEffect(() => {
    if (!activeId || loaded.current.has(activeId)) return;
    loaded.current.add(activeId);
    void loadMessages(activeId);
  }, [activeId, loadMessages]);

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
    },
    onTyping: (conversationId, isTyping) => setTyping((t) => ({ ...t, [conversationId]: isTyping })),
    onConversationCreated: () => void refreshConversations(),
    onUserChanged: () => void refreshUsers(),
    onPresence: () => void refreshUsers(),
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
    }
  }, [activeId, me, refreshConversations]);

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
                <Icon size={16} />
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
            onSelect={selectConversation}
            onBack={() => setMobileChatOpen(false)}
            onSend={send}
            onCreateGroup={() => setModal('group')}
            pendingOpenId={pendingOpenId}
            onPendingOpenDone={clearPendingOpen}
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
              <Icon size={16} />
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

      {modal === 'group' ? (
        <CreateGroupModal
          users={users}
          meId={me.id}
          onClose={() => setModal(null)}
          onCreated={async (id) => {
            setModal(null);
            await refreshConversations();
            setActiveId(id);
            loaded.current.delete(id);
            setTab('chat');
            setPendingOpenId(id);
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
