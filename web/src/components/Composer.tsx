import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerUpLeft, ImagePlus, X } from 'lucide-react';
import { Avatar } from './Avatar';
import { api, MAX_UPLOAD_MB } from '../lib/api';
import type { Conversation, ReplyTarget } from '../lib/types';

interface MentionOption {
  key: string;
  label: string;
  name: string;
  avatarUrl: string | null;
  isAI: boolean;
}

interface Attachment {
  filename: string;
  url: string | null;
  previewUrl: string;
  uploading: boolean;
  error?: string;
}

/** 一个会话暂存下来的输入状态。 */
interface DraftEntry {
  draft: string;
  attachment: Attachment | null;
  /**
   * 正在回复哪一条。和草稿、附件是同一类东西：属于某个会话而不是属于这个组件，
   * 所以必须一起进暂存表 —— 否则在 A 群点了「回复」再切到 B 群，引用块会挂到 B 群头上。
   */
  replyTo: ReplyTarget | null;
}

const EMPTY_ENTRY: DraftEntry = { draft: '', attachment: null, replyTo: null };

// previewUrl 是 URL.createObjectURL 造出来的，不主动释放会一直占着 blob。
// 只在这张图确定不会再被渲染时调用：被替换、被移除、发送成功、组件卸载。
// 重复调用是无害的空操作，所以放在 state updater 里也不会出问题。
function revokePreview(attachment: Attachment | null | undefined) {
  // jsdom 等环境没有实现 revokeObjectURL，缺了就跳过。
  if (attachment?.previewUrl && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function Composer({
  conversation,
  meId,
  onSend,
  replyRequest = null,
}: {
  conversation: Conversation;
  meId: string;
  /** 第二个参数是被引用消息的 id；没有引用时不传，调用形态和以前完全一样。 */
  onSend: (body: string, replyTo?: string | null) => void | Promise<void>;
  /**
   * 消息气泡上点「回复」发过来的引用请求。每点一次父组件给一个新对象，
   * 这里只认对象身份的变化，所以切来切去不会把同一个请求重复消费。
   */
  replyRequest?: ReplyTarget | null;
}) {
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 每个会话各存一份草稿：切走时暂存，切回来时恢复。
  // 没有用 <Composer key={active.id}>，因为那样切走就等于卸载，草稿会被一并丢掉；
  // 而「去别的群确认一下再回来接着写」是很常见的用法。
  const stash = useRef(new Map<string, DraftEntry>());
  const [shownId, setShownId] = useState(conversation.id);
  // 异步回调（上传、发送）落地时当前显示的是哪个会话，用 ref 才拿得到最新值。
  const liveId = useRef(conversation.id);
  liveId.current = conversation.id;
  // 卸载时要释放的当前附件。
  const liveEntry = useRef<DraftEntry>(EMPTY_ENTRY);
  liveEntry.current = { draft, attachment, replyTo };

  // 会话变了：把旧会话的输入状态存起来，换上新会话自己的那份。
  // 在渲染期同步切换，避免先渲染出上一个会话的内容再被 effect 改掉。
  if (shownId !== conversation.id) {
    stash.current.set(shownId, { draft, attachment, replyTo });
    const restored = stash.current.get(conversation.id) ?? EMPTY_ENTRY;
    setShownId(conversation.id);
    setDraft(restored.draft);
    setAttachment(restored.attachment);
    setReplyTo(restored.replyTo);
    setMentionQuery(null);
    setIndex(0);
  }

  // 外面点了「回复」：把引用态记到当前这个会话上。用 ref 记住已经消费过哪一个请求，
  // 免得切换会话导致的重渲染又把旧请求重新塞回来，把用户刚取消掉的引用态复活。
  const consumedReply = useRef<ReplyTarget | null>(replyRequest);
  useEffect(() => {
    if (replyRequest === consumedReply.current) return;
    consumedReply.current = replyRequest;
    if (replyRequest) setReplyTo(replyRequest);
  }, [replyRequest]);

  useEffect(() => () => {
    // 组件卸载（比如退出登录、没有选中会话）时，所有暂存的预览图一起释放。
    revokePreview(liveEntry.current.attachment);
    for (const entry of stash.current.values()) revokePreview(entry.attachment);
  }, []);

  // 下面两个 write* 负责把更新写到「正确的会话」上：如果那个会话还显示着就走
  // state，已经切走了就直接改暂存，免得上传结果或发送失败的还原串到别的群里。
  function writeDraft(id: string, update: (prev: string) => string) {
    if (id === liveId.current) {
      setDraft(update);
      return;
    }
    const entry = stash.current.get(id) ?? EMPTY_ENTRY;
    stash.current.set(id, { ...entry, draft: update(entry.draft) });
  }

  function writeAttachment(id: string, update: (prev: Attachment | null) => Attachment | null) {
    if (id === liveId.current) {
      setAttachment(update);
      return;
    }
    const entry = stash.current.get(id) ?? EMPTY_ENTRY;
    stash.current.set(id, { ...entry, attachment: update(entry.attachment) });
  }

  function writeReply(id: string, update: (prev: ReplyTarget | null) => ReplyTarget | null) {
    if (id === liveId.current) {
      setReplyTo(update);
      return;
    }
    const entry = stash.current.get(id) ?? EMPTY_ENTRY;
    stash.current.set(id, { ...entry, replyTo: update(entry.replyTo) });
  }

  const options = useMemo<MentionOption[]>(() => {
    const roster = conversation.members.filter((m) => m.id !== meId);
    const list: MentionOption[] = [];
    if (conversation.type === 'group') {
      list.push({ key: 'all', label: '@全员', name: '全员', avatarUrl: null, isAI: false });
    }
    for (const m of roster.filter((r) => r.isAI)) {
      list.push({ key: m.id, label: `${m.name}（AI 助手）`, name: m.name, avatarUrl: m.avatarUrl, isAI: true });
    }
    for (const m of roster.filter((r) => !r.isAI)) {
      list.push({ key: m.id, label: m.name, name: m.name, avatarUrl: m.avatarUrl, isAI: false });
    }
    return list;
  }, [conversation, meId]);

  const visible = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return options.filter((o) => !q || o.name.toLowerCase().includes(q) || o.label.toLowerCase().includes(q));
  }, [mentionQuery, options]);

  const mentionOpen = mentionQuery !== null && visible.length > 0;

  function syncMentionState(value: string) {
    const match = /@([^\s@]*)$/.exec(value);
    setMentionQuery(match ? match[1] : null);
    setIndex(0);
  }

  function pick(option: MentionOption) {
    setDraft((d) => `${d.replace(/@[^\s@]*$/, '')}@${option.name} `);
    setMentionQuery(null);
    setIndex(0);
    inputRef.current?.focus();
  }

  async function attach(file: File) {
    const convId = conversation.id;
    const previewUrl = URL.createObjectURL(file);
    writeAttachment(convId, (prev) => {
      revokePreview(prev);                       // 换图，旧预览没人看了
      return { filename: file.name, url: null, previewUrl, uploading: true };
    });

    // 上传期间用户可能已经换了图或把附件删了，落地时先确认还是同一张。
    const land = (next: Attachment) => writeAttachment(convId, (prev) => {
      if (prev?.previewUrl !== previewUrl) {
        revokePreview(next);                     // 这张已经作废，别留着 blob
        return prev;
      }
      return next;
    });

    try {
      const { url, filename } = await api.upload(file);
      land({ filename, url, previewUrl, uploading: false });
    } catch (err) {
      land({
        filename: file.name, url: null, previewUrl, uploading: false,
        error: err instanceof Error ? err.message : '上传失败',
      });
    }
  }

  async function submit() {
    const text = draft.trim();
    if (attachment?.uploading) return;
    const image = attachment?.url ? `![${attachment.filename}](${attachment.url})` : '';
    if (!text && !image) return;

    // 乐观清空：正常情况下输入框立刻空出来。但发送失败时必须把用户打的字还回去，
    // 否则内容直接丢失，而且草稿为空会让「发送」按钮一直处于禁用态。
    // 发送期间用户可能切走，所以还原要认准发送时的那个会话，不能落到当前会话上。
    const sentId = conversation.id;
    const sentDraft = draft;
    const sentAttachment = attachment;
    const sentReply = replyTo;
    setDraft('');
    setAttachment(null);
    setReplyTo(null);
    setMentionQuery(null);
    try {
      const payload = [text, image].filter(Boolean).join(text && image ? '\n\n' : '');
      // 不引用时不传第二个参数：既有调用方（和它们的用例）看到的调用形态一点没变。
      await (sentReply ? onSend(payload, sentReply.id) : onSend(payload));
      revokePreview(sentAttachment);             // 发出去的是服务端 url，预览图可以释放了
    } catch {
      // 只在用户没有重新打字时还原，别覆盖掉他在等待期间输入的新内容。
      writeDraft(sentId, (current) => (current ? current : sentDraft));
      writeAttachment(sentId, (current) => {
        if (!current) return sentAttachment;
        revokePreview(sentAttachment);           // 已经有新附件了，旧预览留着也没人看
        return current;
      });
      // 引用态同样还给发送时的那个会话，而且不覆盖用户等待期间新选的引用。
      writeReply(sentId, (current) => current ?? sentReply);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIndex((i) => (i + 1) % visible.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIndex((i) => (i - 1 + visible.length) % visible.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(visible[Math.min(index, visible.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    // @ 气泡关着的时候，Esc 退掉引用态（气泡开着时上面那一档先吃掉 Esc）。
    if (e.key === 'Escape' && replyTo) {
      e.preventDefault();
      setReplyTo(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const file = Array.from(e.clipboardData?.items || [])
      .find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
    if (file) {
      e.preventDefault();
      void attach(file);
    }
  }

  return (
    <div className="composer">
      {mentionOpen ? (
        <div className="mentions">
          <div className="mentions__hint">提及 · ↑↓ 选择，Enter 确认</div>
          {visible.map((o, i) => (
            <button
              key={o.key}
              type="button"
              className={`mention-row${i === Math.min(index, visible.length - 1) ? ' mention-row--on' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(o)}
            >
              <Avatar name={o.name} url={o.avatarUrl} isAI={o.isAI} size={22} radius={7} label={o.key === 'all' ? '全' : undefined} />
              {o.label}
              {o.isAI ? <span className="mention-row__must">必定回复</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {replyTo ? (
        <div className="reply-bar">
          <CornerUpLeft size={13} className="reply-bar__icon" />
          <span className="reply-bar__who">回复 {replyTo.senderName}</span>
          <span className="reply-bar__text">{replyTo.preview}</span>
          <button
            type="button"
            className="reply-bar__x"
            onClick={() => setReplyTo(null)}
            title="取消引用"
            aria-label="取消引用"
          >
            <X size={13} />
          </button>
        </div>
      ) : null}

      {attachment ? (
        <div className="attach">
          <span className="attach__thumb">
            <img src={attachment.previewUrl} alt={attachment.filename} />
          </span>
          <span className="attach__name">{attachment.filename}</span>
          <span className="attach__state">
            {attachment.error ? attachment.error : attachment.uploading ? '上传中…' : '已上传，将作为图片附件发送'}
          </span>
          <button
            type="button"
            className="attach__x"
            onClick={() => {
              revokePreview(attachment);
              setAttachment(null);
            }}
            title="移除附件"
          >
            <X size={13} />
          </button>
        </div>
      ) : null}

      <div className="composer__row">
        <button
          type="button"
          className="composer__plus"
          title={`从本地选择图片（不超过 ${MAX_UPLOAD_MB}MB）`}
          onClick={() => fileRef.current?.click()}
        >
          <ImagePlus size={18} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void attach(file);
            e.target.value = '';
          }}
        />

        <div className="composer__box">
          <textarea
            ref={inputRef}
            className="composer__input"
            rows={1}
            value={draft}
            placeholder="输入消息，支持 Markdown、粘贴图片、@ 提及成员或 AI"
            onChange={(e) => {
              setDraft(e.target.value);
              syncMentionState(e.target.value);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <span className="composer__md">MD</span>
        </div>

        <button
          type="button"
          className="composer__send"
          onClick={() => void submit()}
          disabled={attachment?.uploading || (!draft.trim() && !attachment?.url)}
        >
          发送
        </button>
      </div>
    </div>
  );
}
