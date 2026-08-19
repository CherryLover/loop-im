import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Search } from 'lucide-react';
import { Avatar, AiBadge } from '../components/Avatar';
import { MessageList } from '../components/MessageList';
import { Composer } from '../components/Composer';
import { api } from '../lib/api';
import { listTime } from '../lib/format';
import type { Conversation, Message, User } from '../lib/types';

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
  onSelect: (id: string) => void;
  onBack: () => void;
  onSend: (body: string) => void;
  onCreateGroup: () => void;
  /** 外部（建群成功）要求直接进入的会话 id，手机端据此展开聊天详情。 */
  pendingOpenId: string | null;
  /** 上面的请求已处理，通知外部清空，避免下次回到会话页又被强制展开。 */
  onPendingOpenDone: () => void;
}

export function ChatPage(props: ChatPageProps) {
  const { me, conversations, activeId, messages, typing, aiProviderLabel, silentRead, canCreateGroup, showChatOnMobile } = props;
  const [query, setQuery] = useState('');
  const [aiContext, setAiContext] = useState('');

  const active = conversations.find((c) => c.id === activeId) || null;

  // 建群成功后会话是外部选中的，手机端要跟着切到聊天详情，否则只停留在会话列表。
  const { pendingOpenId, onPendingOpenDone } = props;
  useEffect(() => {
    if (!pendingOpenId) return;
    setShowChatOnMobile(true);
    onPendingOpenDone();
  }, [pendingOpenId, onPendingOpenDone]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : conversations;
  }, [conversations, query]);

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
              placeholder="搜索会话"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="convos__list">
          {filtered.length === 0 ? <div className="convos__empty">没有匹配的会话。</div> : null}
          {filtered.map((c) => {
            const isAI = c.type === 'ai';
            const groupPeer = c.type !== 'group' ? c.members.find((m) => m.id !== me.id) : null;
            return (
              <button
                key={c.id}
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
                    <div className="convo__title">{c.title}</div>
                    {isAI ? <AiBadge /> : null}
                    <span className="convo__time">{c.lastMessage ? listTime(c.lastMessage.createdAt) : ''}</span>
                  </div>
                  <div className="convo__preview">{c.lastMessage?.preview || '还没有消息'}</div>
                </div>
              </button>
            );
          })}
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
            />

            {active.type === 'group' && silentRead ? (
              <div className="silent-hint">
                <span className="dot dot--online" />
                Aria 静默读取本群上下文，被 @ 时才发言
              </div>
            ) : null}

            <Composer conversation={active} meId={me.id} onSend={props.onSend} />
          </div>

          {active.type === 'group' ? (
            <div className="members">
              <div>
                <div className="section-label" style={{ marginBottom: 8 }}>成员 · {active.members.length}</div>
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
