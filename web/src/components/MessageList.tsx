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
}

export function MessageList({ messages, meId, showSenderName, aiProviderLabel, typing }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, typing]);

  let lastDay = '';

  return (
    <div className="chat__scroll">
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
                  <div className="msg__meta">{m.pending ? '发送中…' : `${clock(m.createdAt)} · 已读`}</div>
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
