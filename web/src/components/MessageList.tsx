import { useEffect, useRef } from 'react';
import { Avatar, AiBadge } from './Avatar';
import { renderMarkdown } from '../lib/md';
import { clock, dayLabel } from '../lib/format';
import type { Message, ReadState } from '../lib/types';

interface MessageListProps {
  messages: Message[];
  meId: string;
  showSenderName: boolean;
  aiProviderLabel: string;
  typing: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** 会话里其他人的已读位置；据此把自己的气泡标成已读。 */
  reads?: ReadState[];
  /** 群聊显示「n 人已读」，私聊只显示「已读」。 */
  showReaderCount?: boolean;
}

export function MessageList({
  messages, meId, showSenderName, aiProviderLabel, typing, hasOlder, loadingOlder, onLoadOlder,
  reads = [], showReaderCount = false,
}: MessageListProps) {
  /**
   * 自己那条消息的状态。有人的已读位置不早于这条消息的时间，就算被读过了。
   * 没有任何人读过时仍然只说「已发送」—— 送达服务端不等于对方看过。
   */
  const statusOf = (m: Message) => {
    if (m.pending) return '发送中…';
    const readers = reads.filter((r) => r.lastReadAt >= m.createdAt).length;
    if (!readers) return `${clock(m.createdAt)} · 已发送`;
    return showReaderCount ? `${clock(m.createdAt)} · ${readers} 人已读` : `${clock(m.createdAt)} · 已读`;
  };
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

            {m.kind === 'system' ? (
              // 成员变动、改群名之类的提示：居中一行灰字，不占气泡、也不算某个人「说的话」
              <div className="chat__notice">{m.body}</div>
            ) : mine ? (
              <div className="msg--me">
                <div className="msg__col msg__col--me">
                  <div
                    className={`md bubble bubble--me${m.pending ? ' bubble--sending' : ''}`}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.body) }}
                  />
                  {/* 「已读」只依据对方真实上报的已读位置，不拿在线状态或送达去推断。 */}
                  <div className="msg__meta">{statusOf(m)}</div>
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
