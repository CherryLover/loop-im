import { useEffect, useRef } from 'react';
import { Avatar, AiBadge } from './Avatar';
import { renderMarkdown } from '../lib/md';
import { clock, dayLabel } from '../lib/format';
import type { Message } from '../lib/types';

interface MessageListProps {
  messages: Message[];
  meId: string;
  showSenderName: boolean;
  aiProviderLabel: string;
  typing: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}

export function MessageList({
  messages, meId, showSenderName, aiProviderLabel, typing, hasOlder, loadingOlder, onLoadOlder,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // 加载历史前记下「距底部多远」，插入后按这个距离还原，视线不会被顶走。
  const restoreFromBottom = useRef<number | null>(null);
  const lastId = messages.at(-1)?.id;
  const prevLastId = useRef<string | undefined>(undefined);

  function requestOlder() {
    if (!hasOlder || loadingOlder || !onLoadOlder) return;
    const el = scrollRef.current;
    restoreFromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
    onLoadOlder();
  }

  useEffect(() => {
    const el = scrollRef.current;
    // 刚插入了更早的消息：还原滚动位置，别当成「来了新消息」滚到底。
    if (restoreFromBottom.current !== null && el) {
      el.scrollTop = el.scrollHeight - restoreFromBottom.current;
      restoreFromBottom.current = null;
      prevLastId.current = lastId;
      return;
    }
    // 只有最后一条变了（真的来了新消息）或首次渲染时才滚到底。
    if (lastId !== prevLastId.current) {
      prevLastId.current = lastId;
      endRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [messages, typing, lastId]);

  useEffect(() => {
    if (typing) endRef.current?.scrollIntoView({ block: 'end' });
  }, [typing]);

  let lastDay = '';

  return (
    <div
      className="chat__scroll"
      ref={scrollRef}
      onScroll={(e) => { if (e.currentTarget.scrollTop < 80) requestOlder(); }}
    >
      {hasOlder ? (
        <button type="button" className="chat__older" onClick={requestOlder} disabled={loadingOlder}>
          {loadingOlder ? '加载中…' : '加载更早的消息'}
        </button>
      ) : null}

      {messages.length === 0 && !typing ? <div className="chat__empty">还没有消息，说点什么吧。</div> : null}

      {messages.map((m) => {
        const day = dayLabel(m.createdAt);
        const chip = day !== lastDay ? day : null;
        lastDay = day;
        const mine = m.senderId === meId;

        return (
          <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {chip ? <div className="chat__daychip">{chip}</div> : null}

            {mine ? (
              <div className="msg--me">
                <div className="msg__col msg__col--me">
                  <div
                    className={`md bubble bubble--me${m.pending ? ' bubble--sending' : ''}`}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.body) }}
                  />
                  {/* 服务端收下消息只说明发送成功，对方是否看过没人统计过，别写「已读」。 */}
                  <div className="msg__meta">{m.pending ? '发送中…' : `${clock(m.createdAt)} · 已发送`}</div>
                </div>
              </div>
            ) : (
              <div className="msg--other">
                <Avatar name={m.senderName} url={m.senderAvatarUrl} isAI={m.isAI} size={32} radius={10} />
                <div className="msg__col">
                  {m.isAI ? (
                    <div className="msg__name--ai">
                      <span>{m.senderName}</span>
                      <AiBadge />
                    </div>
                  ) : showSenderName ? (
                    <div className="msg__name">{m.senderName}</div>
                  ) : null}
                  <div
                    className={`md bubble ${m.isAI ? 'bubble--ai' : 'bubble--other'}`}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.body) }}
                  />
                  <div className="msg__meta">
                    {clock(m.createdAt)}
                    {m.isAI ? ` · 由 ${aiProviderLabel} 生成` : ''}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {typing ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Avatar name="Aria" isAI size={32} radius={10} />
          <div className="typing">
            <span />
            <span />
            <span />
          </div>
        </div>
      ) : null}

      <div ref={endRef} />
    </div>
  );
}
