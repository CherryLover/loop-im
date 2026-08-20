import { useEffect, useMemo, useState } from 'react';
import { Bell, BellOff, ChevronLeft, LogOut, Pencil, Pin, PinOff, Search, UserPlus, X } from 'lucide-react';
import { Avatar, AiBadge } from '../components/Avatar';
import { MessageList } from '../components/MessageList';
import { Composer } from '../components/Composer';
import { api } from '../lib/api';
import { listTime, unreadAriaLabel, unreadBadgeClass, unreadLabel } from '../lib/format';
import { replyTargetOf } from '../lib/messages';
import type { Conversation, Message, MessageSearchResult, ReadState, ReplyTarget, User } from '../lib/types';

/** 搜索框里输入多久没动就发请求：每敲一个字都打一次服务端太浪费。 */
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 20;

/** 结果行只放一行摘要，把 Markdown 记号和图片压成纯文本（与服务端 previewOf 同一思路）。 */
const plainPreview = (body: string) =>
  body.replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]').replace(/[#*`\-\n]/g, ' ').replace(/\s+/g, ' ').trim();

interface ChatPageProps {
  me: User;
  conversations: Conversation[];
  activeId: string | null;
  messages: Message[];
  typing: boolean;
  aiProviderLabel: string;
  silentRead: boolean;
  canCreateGroup: boolean;
  showChatOnMobile: boolean;
  reads: ReadState[];
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onSelect: (id: string) => void;
  onBack: () => void;
  onSend: (body: string, replyTo?: string | null) => void | Promise<void>;
  /** 切换我在某条消息上的某个表情回应（点过就是取消）。不传就只读，与 MessageList 同一约定。 */
  onReact?: (message: Message, emoji: string) => void;
  onCreateGroup: () => void;
  onAddMembers: (conversationId: string) => void;
  onRemoveMember: (conversationId: string, userId: string, name: string) => void;
  onRenameGroup: (conversationId: string, currentTitle: string) => void;
  onLeaveGroup: (conversationId: string, title: string) => void;
  /** 置顶 / 取消置顶。传的是「改成什么」，不是「当前是什么」。 */
  onTogglePin: (conversationId: string, pinned: boolean) => void;
  /** 免打扰 / 取消免打扰。同样传「改成什么」。 */
  onToggleMute: (conversationId: string, muted: boolean) => void;
}

export function ChatPage(props: ChatPageProps) {
  const { me, conversations, activeId, messages, typing, aiProviderLabel, silentRead, canCreateGroup, showChatOnMobile } = props;
  const [query, setQuery] = useState('');
  const [aiContext, setAiContext] = useState('');
  // 搜索框现在同时搜会话标题（本地过滤）和消息正文（走服务端）。
  const [results, setResults] = useState<MessageSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  // 点了气泡上的「回复」之后转交给 Composer 的引用请求。每点一次都是新对象，
  // Composer 认对象身份来消费；引用态本身归 Composer 按会话暂存，这里不做保管。
  const [replyRequest, setReplyRequest] = useState<ReplyTarget | null>(null);

  const active = conversations.find((c) => c.id === activeId) || null;
  // 建群者本人和系统管理员可以增减成员、改群名（与服务端 canManageGroup 一致）。
  const canManage = !!active && active.type === 'group' && (active.createdBy === me.id || me.role === 'admin');

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    const q = trimmed.toLowerCase();
    return q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : conversations;
  }, [conversations, trimmed]);

  /**
   * 消息正文只能问服务端（权限边界在那边，前端手里只有已加载的那点消息）。
   * alive 标记 + clearTimeout：输入过程中前一次请求的结果不能覆盖后一次，
   * 清空关键词时也要立刻收掉结果，不能等在途请求回来再闪一下。
   */
  useEffect(() => {
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      setSearchError('');
      return;
    }
    let alive = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api.searchMessages(trimmed, { limit: SEARCH_LIMIT })
        .then((page) => {
          if (!alive) return;
          setResults(page.results);
          setSearchError('');
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setResults([]);
          setSearchError(err instanceof Error ? err.message : '搜索失败');
        })
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [trimmed]);

  useEffect(() => {
    if (!active || active.type !== 'group') {
      setAiContext('');
      return;
    }
    let alive = true;
    api.aiContext(active.id)
      .then((r) => alive && setAiContext(r.line))
      .catch(() => alive && setAiContext(''));
    return () => {
      alive = false;
    };
  }, [active, messages.length]);

  const peer = active && active.type !== 'group' ? active.members.find((m) => m.id !== me.id) : null;
  const subtitle = !active
    ? ''
    : active.type === 'group'
      ? `${active.members.length} 名成员 · Aria 常驻`
      : active.type === 'ai'
        ? `一对一 · ${aiProviderLabel}`
        : peer?.online ? '在线' : '离线';

  return (
    <div className="chat">
      <div className={`convos${showChatOnMobile ? ' convos--hidden' : ''}`}>
        <div className="convos__head">
          <div className="convos__title">会话</div>
          {canCreateGroup ? (
            <button type="button" className="btn btn--sm" onClick={props.onCreateGroup}>+ 建群</button>
          ) : null}
        </div>
        <div className="convos__search">
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search size={13} style={{ position: 'absolute', left: 9, color: 'var(--faint)' }} />
            <input
              className="input input--search"
              style={{ paddingLeft: 27 }}
              placeholder="搜索会话和消息"
              aria-label="搜索会话和消息"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="convos__list">
          {trimmed ? <div className="convos__section">会话 · {filtered.length}</div> : null}
          {filtered.length === 0 ? <div className="convos__empty">没有匹配的会话。</div> : null}
          {filtered.map((c) => {
            const isAI = c.type === 'ai';
            const mentioned = c.mentionsUnread || 0;       // 未读里有多少条 @ 到我
            // 置顶与免打扰是「我」的个人设置；老接口不带这两个字段时按关着处理。
            const pinned = !!c.pinned;
            const muted = !!c.muted;
            const groupPeer = c.type !== 'group' ? c.members.find((m) => m.id !== me.id) : null;
            return (
              // 会话本身是一个按钮，置顶/免打扰是另外两个按钮，按钮不能套按钮，
              // 所以在外面包一层容器，让操作区跟会话行并排而不是嵌进去。
              <div key={c.id} className={`convo-item${pinned ? ' convo-item--pinned' : ''}`}>
                <button
                  type="button"
                  className={`convo${c.id === activeId ? ' convo--on' : ''}`}
                  onClick={() => props.onSelect(c.id)}
                >
                  <Avatar
                    name={groupPeer?.name || c.title}
                    url={groupPeer?.avatarUrl}
                    isAI={isAI}
                    size={34}
                    radius={10}
                    label={c.type === 'group' ? '群' : undefined}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="convo__row">
                      {/* 置顶和免打扰各有一个明确的记号，不用点开也不用悬浮就能看出来 */}
                      {pinned ? <Pin size={11} className="convo__flag" aria-label="已置顶" /> : null}
                      <div className="convo__title">{c.title}</div>
                      {isAI ? <AiBadge /> : null}
                      {muted ? <BellOff size={11} className="convo__flag" aria-label="已免打扰" /> : null}
                      <span className="convo__time">{c.lastMessage ? listTime(c.lastMessage.createdAt) : ''}</span>
                      {/* 免打扰只是让徽标弱化，未读数照显、照算 —— 免打扰不是不计未读 */}
                      {c.unread > 0 ? (
                        <span
                          className={unreadBadgeClass(mentioned, muted)}
                          aria-label={unreadAriaLabel(c.unread, mentioned)}
                        >
                          {/* 颜色之外再给一个记号：只靠高亮色区分，色觉障碍的人是看不出来的 */}
                          {mentioned > 0 ? <span className="badge__at" aria-hidden="true">@</span> : null}
                          {unreadLabel(c.unread)}
                        </span>
                      ) : null}
                    </div>
                    <div className="convo__preview">{c.lastMessage?.preview || '还没有消息'}</div>
                  </div>
                </button>
                <div className="convo__actions">
                  <button
                    type="button"
                    className={`convo__action${pinned ? ' convo__action--on' : ''}`}
                    aria-pressed={pinned}
                    title={pinned ? `取消置顶「${c.title}」` : `置顶「${c.title}」`}
                    aria-label={pinned ? `取消置顶「${c.title}」` : `置顶「${c.title}」`}
                    onClick={() => props.onTogglePin(c.id, !pinned)}
                  >
                    {pinned ? <PinOff size={12} /> : <Pin size={12} />}
                  </button>
                  <button
                    type="button"
                    className={`convo__action${muted ? ' convo__action--on' : ''}`}
                    aria-pressed={muted}
                    title={muted ? `取消免打扰「${c.title}」` : `免打扰「${c.title}」`}
                    aria-label={muted ? `取消免打扰「${c.title}」` : `免打扰「${c.title}」`}
                    onClick={() => props.onToggleMute(c.id, !muted)}
                  >
                    {muted ? <Bell size={12} /> : <BellOff size={12} />}
                  </button>
                </div>
              </div>
            );
          })}

          {/* 消息命中。点一条就跳到它所在的会话（暂时只定位到会话，不滚到那条消息）。 */}
          {trimmed ? (
            <>
              <div className="convos__section">
                消息{searching ? ' · 搜索中…' : ` · ${results.length}`}
              </div>
              {searchError ? <div className="convos__empty">{searchError}</div> : null}
              {!searching && !searchError && results.length === 0 ? (
                <div className="convos__empty">没有匹配的消息。</div>
              ) : null}
              {results.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`convo${r.conversationId === activeId ? ' convo--on' : ''}`}
                  onClick={() => props.onSelect(r.conversationId)}
                >
                  <Avatar
                    name={r.conversationTitle}
                    isAI={r.conversationType === 'ai'}
                    size={34}
                    radius={10}
                    label={r.conversationType === 'group' ? '群' : undefined}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="convo__row">
                      <div className="convo__title">{r.conversationTitle}</div>
                      <span className="convo__time">{listTime(r.createdAt)}</span>
                    </div>
                    <div className="convo__preview">{r.senderName}：{plainPreview(r.body)}</div>
                  </div>
                </button>
              ))}
            </>
          ) : null}
        </div>
      </div>

      {active ? (
        <div className={`chat${showChatOnMobile ? '' : ' chat--hidden'}`} style={{ flex: 1, minWidth: 0 }}>
          <div className="chat__main">
            <div className="chat__head">
              <button
                type="button"
                className="btn btn--icon chat__back"
                onClick={props.onBack}
                title="返回会话列表"
              >
                <ChevronLeft size={15} />
              </button>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <div className="chat__title">{active.title}</div>
                  {active.type === 'ai' ? <AiBadge /> : null}
                </div>
                <div className="chat__sub">
                  {active.type !== 'group' ? (
                    <span className={`dot ${active.type === 'ai' || peer?.online ? 'dot--online' : 'dot--offline'}`} />
                  ) : null}
                  {subtitle}
                </div>
              </div>
            </div>

            <MessageList
              messages={messages}
              meId={me.id}
              showSenderName={active.type === 'group'}
              aiProviderLabel={aiProviderLabel}
              typing={typing}
              reads={props.reads}
              showReaderCount={active.type === 'group'}
              hasOlder={props.hasOlder}
              loadingOlder={props.loadingOlder}
              onLoadOlder={props.onLoadOlder}
              onReply={(m) => setReplyRequest(replyTargetOf(m))}
              onReact={props.onReact}
            />

            {active.type === 'group' && silentRead ? (
              <div className="silent-hint">
                <span className="dot dot--online" />
                Aria 静默读取本群上下文，被 @ 时才发言
              </div>
            ) : null}

            <Composer conversation={active} meId={me.id} onSend={props.onSend} replyRequest={replyRequest} />
          </div>

          {active.type === 'group' ? (
            <div className="members">
              <div>
                <div className="members__head">
                  <div className="section-label">成员 · {active.members.length}</div>
                  {canManage ? (
                    <button type="button" className="btn btn--sm" onClick={() => props.onAddMembers(active.id)}>
                      <UserPlus size={13} /> 添加
                    </button>
                  ) : null}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {active.members.map((m) => (
                    <div key={m.id} className="members__row">
                      <Avatar
                        name={m.name}
                        url={m.avatarUrl}
                        isAI={m.isAI}
                        size={26}
                        radius={8}
                        dot={m.isAI ? null : m.online ? 'online' : 'offline'}
                      />
                      <span className="members__name">{m.name}</span>
                      {m.isAI ? <AiBadge /> : null}
                      <span className="members__role">{m.roleInGroup}</span>
                      {/* 群主不能被移除（他要走得自己退群），自己也不从这里移除 */}
                      {canManage && m.id !== active.createdBy && m.id !== me.id ? (
                        <button
                          type="button"
                          className="members__remove"
                          title={`将 ${m.name} 移出群聊`}
                          aria-label={`将 ${m.name} 移出群聊`}
                          onClick={() => props.onRemoveMember(active.id, m.id, m.name)}
                        >
                          <X size={12} />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>

              {aiContext ? (
                <div className="ai-context">
                  <div className="ai-context__label">AI 掌握的上下文</div>
                  <div className="ai-context__body">{aiContext}</div>
                </div>
              ) : null}

              <div className="members__actions">
                {canManage ? (
                  <button type="button" className="btn btn--sm" onClick={() => props.onRenameGroup(active.id, active.title)}>
                    <Pencil size={13} /> 修改群名
                  </button>
                ) : null}
                <button type="button" className="btn btn--sm" onClick={() => props.onLeaveGroup(active.id, active.title)}>
                  <LogOut size={13} /> 退出群聊
                </button>
              </div>

              <div className="members__foot">Aria 会记录每个人的沟通习惯，下次对话时沿用。</div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="chat__main" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div className="chat__empty">从左侧选择一个会话开始聊天。</div>
        </div>
      )}
    </div>
  );
}
