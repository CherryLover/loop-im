import { useEffect, useRef, useState } from 'react';
import { CornerUpLeft, SmilePlus, Wrench } from 'lucide-react';
import { Avatar, AiBadge } from './Avatar';
import { MarkdownBody } from './MarkdownBody';
import { ImageViewer } from './ImageViewer';
import type { GalleryImage, ViewerOrigin } from './ImageViewer';
import { clock, dayLabel } from '../lib/format';
import { REACTION_EMOJIS } from '../lib/reactions';
import type { AgentStep, Message, ReadState } from '../lib/types';

interface MessageListProps {
  messages: Message[];
  meId: string;
  showSenderName: boolean;
  typing: boolean;
  /**
   * 正在干活的 Agent 列表（按开工顺序）。有值时每个 Agent 各渲染一行自己的指示器
   * （自己的头像 + 名字），多 Agent 并行时才分得清是谁在忙；为空或不传但 typing
   * 为真时，退回原来那行通用的「AI」指示器（老服务端的事件不带这份名单）。
   */
  typingAgents?: { id: string; name: string }[];
  /**
   * 每个正在干活的 Agent 已累积的过程步子（键是 Agent 用户 id）。气泡跟着一步步
   * 往下长——中间说的话直接是正文、工具动作带小扳手，尾部保留跳动的点（D15'）。
   */
  typingSteps?: Record<string, AgentStep[]>;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** 会话里其他人的已读位置；据此把自己的气泡标成已读。 */
  reads?: ReadState[];
  /** 群聊显示「n 人已读」，私聊只显示「已读」。 */
  showReaderCount?: boolean;
  /** 点了气泡上的「回复」：把这条消息交给输入框做引用。不传就不显示回复入口。 */
  onReply?: (message: Message) => void;
  /**
   * 点了某个表情：切换我自己在这条消息上的这个回应（点过就是取消）。
   * 不传就只读——已有的回应照常显示，但点不动，也没有选表情的入口。
   */
  onReact?: (message: Message, emoji: string) => void;
}

export function MessageList({
  messages, meId, showSenderName, typing, typingAgents, typingSteps, hasOlder, loadingOlder, onLoadOlder,
  reads = [], showReaderCount = false, onReply, onReact,
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

  // 表情面板此刻开在哪条消息上（同一时刻只开一个）。
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  /**
   * 正在看的大图。气泡里的图是 1:1 切过的缩略图，看原图这条路由它兜住。
   * 状态放在列表这一层而不是每个气泡里：同一时刻只该有一层，
   * 放在气泡里的话点第二张就会叠出两层。
   *
   * 存的不只是被点的那一张，而是**打开那一刻整条会话里的全部图片 + 落在第几张**，
   * 这样蒙版里才能前后翻。origin 是被点缩略图当时在视口里的位置 ——
   * 预览的入场动画从那个框长出来；量不到（jsdom、或者极端的布局时机）就是 null，
   * ImageViewer 会退回纯淡入。
   */
  const [viewing, setViewing] = useState<{ images: GalleryImage[]; index: number; origin: ViewerOrigin | null } | null>(null);

  /**
   * 点开某张缩略图，顺手把整条会话的图片收成一个画廊。
   *
   * ## 为什么是查 DOM，不是解析消息的 body
   *
   * 备选方案是遍历 `messages`、用正则从每条 Markdown 源码里抠 `![](…)`。不走那条，
   * 因为「一段 Markdown 会渲染出哪些图」这件事的唯一权威是 md.ts，而它做的事
   * 远不止一条正则：
   *
   *   - 反引号里的 `![图](x)` 是**字面量**，不是图（行内代码先被抽进槽位了）；
   *   - `.mp4` / `.webm` 的站内附件会走 `<video>`，不是图；
   *   - `safeUrl()` 会把 `javascript:` 之类挡成 `#`；
   *   - `displaySrc()` 会把服务端 URL 换成本地 blob:（自己刚发的那张），
   *     没命中才拼上 `?token=`。
   *
   * 在这里再实现一遍，等于把这四条规则抄成第二份，两份迟早会分叉 ——
   * 到那时画廊里会多出根本不存在的图，或者点开的是另一张。
   * 查 DOM 拿到的是 md.ts **已经算完**的结果：`.mdimg__img` 只会是图片，
   * src 已经是最终地址（blob: 或带 token 的都原样能用），顺序就是消息顺序。
   *
   * 代价是「看得见才收得到」：还没翻页加载出来的更早消息不在 DOM 里，也就不在画廊里。
   * 这正是 hasOlder 要在蒙版上说明的那件事 —— 与其偷偷少几张，不如把范围讲清楚。
   *
   * 加载失败的那些排除掉：它们的按钮已经是 disabled，没有原图可看，
   * 放进画廊只会让人翻到一张坏图，还把「共 n 张」这个数撑大。
   */
  function openImage(src: string, alt: string, clicked: HTMLImageElement) {
    // 被点那一刻缩略图的位置，交给预览层做「从这里长出来」的入场动画。
    const r = clicked.getBoundingClientRect();
    const origin = r.width > 0 && r.height > 0
      ? { x: r.left, y: r.top, width: r.width, height: r.height }
      : null;
    const root = scrollRef.current;
    const all = Array.from(root?.querySelectorAll<HTMLImageElement>('img.mdimg__img') ?? [])
      .filter((img) => img.closest('button.mdimg')?.getAttribute('data-state') !== 'error');
    const at = all.indexOf(clicked);
    // 收不到（理论上不会：能点开就说明它在列表里）就退回「只看这一张」，
    // 总比开出一个空画廊强。
    if (at < 0) {
      setViewing({ images: [{ src, alt }], index: 0, origin });
      return;
    }
    setViewing({
      images: all.map((img) => ({
        src: img.getAttribute('src') || '',
        alt: img.getAttribute('alt') || '',
      })),
      index: at,
      origin,
    });
  }

  /**
   * 气泡下方那一行已有回应：一个表情一个按钮，显示计数，指上去能看到都有谁。
   * 自己点过的那个高亮（aria-pressed 同时把状态说给读屏软件），再点一下就是取消。
   * 在途的乐观气泡（pending）还没有服务端的 id，先不给回应入口。
   */
  function reactionRow(m: Message) {
    const list = m.reactions || [];
    if (m.pending || (!list.length && !onReact)) return null;
    const picking = pickerFor === m.id;
    return (
      <div className="reactions">
        {list.map((r) => (
          <button
            key={r.emoji}
            type="button"
            className={`reaction${r.mine ? ' reaction--mine' : ''}`}
            title={`${r.users.map((u) => u.name).join('、')} 点了 ${r.emoji}`}
            aria-label={`${r.emoji} ${r.count} 人${r.mine ? '，包括我，再点一次取消' : ''}`}
            aria-pressed={r.mine}
            disabled={!onReact}
            onClick={() => onReact?.(m, r.emoji)}
          >
            <span aria-hidden="true">{r.emoji}</span>
            <span className="reaction__n">{r.count}</span>
          </button>
        ))}

        {onReact ? (
          // Esc 关面板挂在外层：点开之后焦点还留在入口按钮上，挂在面板里收不到这个键。
          <span
            className="reactions__pick"
            onKeyDown={(e) => { if (e.key === 'Escape') setPickerFor(null); }}
          >
            <button
              type="button"
              className={`reaction reaction--add${picking ? ' reaction--open' : ''}`}
              aria-label="添加表情回应"
              aria-expanded={picking}
              onClick={() => setPickerFor(picking ? null : m.id)}
            >
              <SmilePlus size={13} />
            </button>
            {picking ? (
              // 固定的一小组表情，不引表情选择器依赖。Esc 关掉，选完也关掉。
              <div className="reactions__menu" role="menu">
                {REACTION_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    role="menuitem"
                    aria-label={`用 ${emoji} 回应`}
                    onClick={() => { setPickerFor(null); onReact(m, emoji); }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            ) : null}
          </span>
        ) : null}
      </div>
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
    // 第二个 Agent 中途加入时 typing 布尔不变、指示器却多了一行，同样要跟着贴到底。
  }, [typing, typingAgents?.length]);

  // 实时状态行（D15）出现/刷新会把指示器撑高：本来就贴底的人要继续贴底，
  // 不然第一条状态刚好被输入框挡住半截（本地实测踩到）。阈值放宽到 80px
  //（48px 贴底判据 + 状态行自身的高度——effect 跑的时候它已经把内容撑高了）；
  // 正在翻历史的人不满足判据，不会被拽回来。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) endRef.current?.scrollIntoView({ block: 'end' });
  }, [typingSteps]);

  // 视线贴底时，容器变矮也要跟着贴底。容器变矮有两个来路：输入框写到多行长高了、
  // 手机上软键盘弹起把整个壳压扁了。浏览器在容器缩水时保持的是 scrollTop 而不是
  // 「距底部的距离」，于是最新那几条消息刚好被吃掉 —— 恰恰是正在打字的人最需要
  // 看着的内容。只有本来就贴底才追（阈值 48px ≈ 一条短消息），正在翻历史的人
  // 不能被拽回来。
  //
  // 「本来就贴底」必须按**变化之前**的几何来判，不能读现场：容器缩水的瞬间，
  // WebKit 会先派发一个由缩水引起的 scroll 事件，那一刻 clientHeight 已经变小、
  // scrollTop 还是旧的，现算「距底部」必然超阈值 —— iOS 模拟器上实测就是这样
  // 把贴底判丢的。所以 scroll 里只在 clientHeight 没变时才记账（用户真的在滚），
  // clientHeight 变了的那些滚动属于 resize 的余波，留给 ResizeObserver 用
  // 变化前的账本裁决。
  const lastStable = useRef({ top: 0, height: 0, client: 0 });
  const noteScroll = (el: HTMLElement) => {
    if (el.clientHeight === lastStable.current.client) {
      lastStable.current = { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
    }
  };
  useEffect(() => {
    const el = scrollRef.current;
    // jsdom 没有 ResizeObserver（也量不出布局），跳过即可，真浏览器都有。
    if (!el || typeof ResizeObserver !== 'function') return;
    lastStable.current = { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
    const ro = new ResizeObserver(() => {
      const prev = lastStable.current;
      if (prev.height - prev.top - prev.client < 48) el.scrollTop = el.scrollHeight;
      lastStable.current = { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let lastDay = '';

  return (
    <div
      className="chat__scroll"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        noteScroll(el);
        if (el.scrollTop < 80) requestOlder();
      }}
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
                  <MarkdownBody
                    className={`md bubble bubble--me${m.pending ? ' bubble--sending' : ''}`}
                    body={m.body}
                    onOpenImage={openImage}
                  />
                  {reactionRow(m)}
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
                  {m.isAI && m.progress?.length ? (
                    // Agent 的回复像它「慢慢写出来」的样子（D15'）：过程平铺在气泡里，
                    // 分割线下面才是最终结论——翻历史一进来就是这副全貌，不用点开。
                    <div className="bubble bubble--ai bubble--flow">
                      <StepsFlow steps={m.progress} />
                      <div className="flow__divider" role="separator" aria-label="以上是执行过程，以下是最终回复" />
                      <MarkdownBody className="md" body={m.body} onOpenImage={openImage} />
                    </div>
                  ) : (
                    <MarkdownBody
                      className={`md bubble ${m.isAI ? 'bubble--ai' : 'bubble--other'}`}
                      body={m.body}
                      onOpenImage={openImage}
                    />
                  )}
                  {reactionRow(m)}
                  <div className="msg__meta">
                    {clock(m.createdAt)}
                    {replyButton(m)}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {typingAgents && typingAgents.length > 0 ? (
        // 知道是谁在忙就一人一行：自己的头像 + 名字（名字的写法与上面 AI 消息行一致，
        // 群里几个 Agent 同时被 @ 时，各自的指示灯亮在各自名下）。
        typingAgents.map((a) => {
          const steps = typingSteps?.[a.id] ?? [];
          return (
            <div key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <Avatar name={a.name} isAI size={32} radius={10} />
              <div className="msg__col">
                <div className="msg__name--ai">
                  <span>{a.name}</span>
                  <AiBadge />
                </div>
                {/*
                  干活中的气泡在一步步长出来（D15'）：过程内容平铺其中，尾部的三个点
                  表示「还没写完」。一步都还没有时就是原来那个纯打点的气泡。
                */}
                <div className={`bubble bubble--ai bubble--flow${steps.length ? '' : ' bubble--dots'}`} role="status" aria-label={`${a.name} 正在处理`}>
                  {steps.length ? <StepsFlow steps={steps} /> : null}
                  <div className="typing typing--inline">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            </div>
          );
        })
      ) : typing ? (
        // 不知道是谁（老服务端的事件不带 agents）就保留原来的通用「AI」一行。
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Avatar name="AI" isAI size={32} radius={10} />
          <div className="typing">
            <span />
            <span />
            <span />
          </div>
        </div>
      ) : null}

      <div ref={endRef} />

      {/*
        写在这里只是为了「同一时刻只开一层」这件事跟状态待在一起 ——
        ImageViewer 内部用 createPortal 挂到 document.body，实际渲染位置和这里无关，
        所以它不会再被 .chat__scroll 的 overflow 和层叠上下文夹住。
      */}
      {viewing ? (
        <ImageViewer
          images={viewing.images}
          index={viewing.index}
          onIndex={(index) => setViewing((v) => (v ? { ...v, index } : v))}
          onClose={() => setViewing(null)}
          hasOlder={hasOlder}
          origin={viewing.origin}
        />
      ) : null}
    </div>
  );
}

/**
 * 过程步子的平铺流（D15'）：中间文字直接排成段落（像正文一样读）；工具动作只留
 * 一个小扳手图标，**连续的几步合并成一个图标 ×N**（命令明细不丢——悬停可见）。
 * 历史气泡和进行中的气泡共用同一个渲染——收工瞬间从「实时长出来的」切到
 * 「消息里带的」，长相不变，看不出接缝。
 */
function StepsFlow({ steps }: { steps: AgentStep[] }) {
  // 相邻的工具步收成一段：{kind:'tools'} 记着条数和明细，文字步原样穿插其间。
  const segments: ({ kind: 'text'; seq: number; content: string } | { kind: 'tools'; seq: number; labels: string[] })[] = [];
  for (const s of steps) {
    const prev = segments.at(-1);
    if (s.kind === 'tool' && prev?.kind === 'tools') prev.labels.push(s.content);
    else if (s.kind === 'tool') segments.push({ kind: 'tools', seq: s.seq, labels: [s.content] });
    else segments.push({ kind: 'text', seq: s.seq, content: s.content });
  }
  return (
    <>
      {segments.map((seg) => (
        seg.kind === 'tools' ? (
          <div key={seg.seq} className="flow__tool" title={seg.labels.join('\n')}>
            <Wrench size={12} aria-label={`${seg.labels.length} 步工具操作`} />
            {seg.labels.length > 1 ? <span className="flow__tool-n">×{seg.labels.length}</span> : null}
          </div>
        ) : (
          <p key={seg.seq} className="flow__say">{seg.content}</p>
        )
      ))}
    </>
  );
}
