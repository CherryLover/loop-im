import { useEffect, useRef, useState } from 'react';
import { CornerUpLeft } from 'lucide-react';
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
  /** 点了气泡上的「回复」：把这条消息交给输入框做引用。不传就不显示回复入口。 */
  onReply?: (message: Message) => void;
}

export function MessageList({
  messages, meId, showSenderName, aiProviderLabel, typing, hasOlder, loadingOlder, onLoadOlder,
  reads = [], showReaderCount = false, onReply,
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
  // 刚跳过去的那条消息，短暂高亮一下，否则滚过去了也看不出落在哪一条上。
  const [flashId, setFlashId] = useState<string | null>(null);

  /**
   * 点引用块跳到原消息。原消息还没被翻页加载出来时 DOM 里找不到它，
   * 这时什么也不做 —— 与其把人滚到一个不相干的位置，不如原地不动。
   */
  function jumpTo(id: string | null | undefined) {
    if (!id) return;
    const target = scrollRef.current?.querySelector(`[data-mid="${CSS.escape(id)}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    setFlashId(id);
  }

  useEffect(() => {
    if (!flashId) return;
    const timer = window.setTimeout(() => setFlashId(null), 1400);
    return () => window.clearTimeout(timer);
  }, [flashId]);

  /** 气泡上的「回复」入口。平时淡出，指上去或聚焦时才显形（CSS 管，DOM 里一直在）。 */
  function replyButton(m: Message) {
    if (!onReply) return null;
    return (
      <button
        type="button"
        className="msg__reply"
        onClick={() => onReply(m)}
        aria-label={`引用回复 ${m.senderName} 的消息`}
      >
        <CornerUpLeft size={11} />
        回复
      </button>
    );
  }

  /** 气泡上方的引用块：显示被引用消息的发送者与摘要，点一下跳过去。 */
  function quoteBlock(m: Message) {
    if (!m.quote) return null;
    const gone = !m.quote.available;
    return (
      <button
        type="button"
        className={`quote${gone ? ' quote--gone' : ''}`}
        onClick={() => { if (!gone) jumpTo(m.replyTo); }}
        disabled={gone}
        title={gone ? '原消息已不可用' : '跳到被引用的消息'}
      >
        {gone ? null : <span className="quote__who">{m.quote.senderName}</span>}
        <span className="quote__text">{m.quote.preview}</span>
      </button>
    );
  }
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
              <div className="chat__notice" data-mid={m.id}>{m.body}</div>
            ) : mine ? (
              <div className={`msg--me${flashId === m.id ? ' msg--flash' : ''}`} data-mid={m.id}>
                <div className="msg__col msg__col--me">
                  {quoteBlock(m)}
                  <div
                    className={`md bubble bubble--me${m.pending ? ' bubble--sending' : ''}`}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.body) }}
                  />
                  {/* 「已读」只依据对方真实上报的已读位置，不拿在线状态或送达去推断。 */}
                  <div className="msg__meta">
                    {statusOf(m)}
                    {replyButton(m)}
                  </div>
                </div>
              </div>
            ) : (
              <div className={`msg--other${flashId === m.id ? ' msg--flash' : ''}`} data-mid={m.id}>
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
                  {quoteBlock(m)}
                  <div
                    className={`md bubble ${m.isAI ? 'bubble--ai' : 'bubble--other'}`}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.body) }}
                  />
                  <div className="msg__meta">
                    {clock(m.createdAt)}
                    {m.isAI ? ` · 由 ${aiProviderLabel} 生成` : ''}
                    {replyButton(m)}
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
