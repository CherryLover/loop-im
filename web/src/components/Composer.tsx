import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import { Avatar } from './Avatar';
import { api, MAX_UPLOAD_MB } from '../lib/api';
import type { AttachmentKind, Conversation } from '../lib/types';

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
  /** image 才会内联渲染成图片；file 一律拼成普通链接，只能下载（见 issue #22）。 */
  kind: AttachmentKind;
  error?: string;
}

// 上传前只能按浏览器给的 type 猜一下，用来决定预览要不要显示缩略图。
// 真正算数的是服务端按真实字节给出的 kind，落地时会覆盖这里的猜测。
const guessKind = (file: File): AttachmentKind => (file.type.startsWith('image/') ? 'image' : 'file');

/** 一个会话暂存下来的输入状态。 */
interface DraftEntry {
  draft: string;
  attachment: Attachment | null;
}

const EMPTY_ENTRY: DraftEntry = { draft: '', attachment: null };

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
}: {
  conversation: Conversation;
  meId: string;
  onSend: (body: string) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
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
  liveEntry.current = { draft, attachment };

  // 会话变了：把旧会话的输入状态存起来，换上新会话自己的那份。
  // 在渲染期同步切换，避免先渲染出上一个会话的内容再被 effect 改掉。
  if (shownId !== conversation.id) {
    stash.current.set(shownId, { draft, attachment });
    const restored = stash.current.get(conversation.id) ?? EMPTY_ENTRY;
    setShownId(conversation.id);
    setDraft(restored.draft);
    setAttachment(restored.attachment);
    setMentionQuery(null);
    setIndex(0);
  }

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
    const guessed = guessKind(file);
    const previewUrl = URL.createObjectURL(file);
    writeAttachment(convId, (prev) => {
      revokePreview(prev);                       // 换附件，旧预览没人看了
      return { filename: file.name, url: null, previewUrl, uploading: true, kind: guessed };
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
      const { url, filename, kind } = await api.upload(file);
      // kind 以服务端为准（老服务端不返回这个字段时退回本地的猜测）。
      land({ filename, url, previewUrl, uploading: false, kind: kind ?? guessed });
    } catch (err) {
      land({
        filename: file.name, url: null, previewUrl, uploading: false, kind: guessed,
        error: err instanceof Error ? err.message : '上传失败',
      });
    }
  }

  async function submit() {
    const text = draft.trim();
    if (attachment?.uploading) return;
    // 图片拼成 Markdown 图片（会内联渲染），普通文件拼成普通链接（渲染成文件卡片，只能下载）。
    // 方括号会撑破 Markdown 的链接语法，从显示名里去掉，不影响服务端存的那份原名。
    const label = attachment ? attachment.filename.replace(/[[\]]/g, '') : '';
    const embed = attachment?.url
      ? (attachment.kind === 'image' ? `![${label}](${attachment.url})` : `[${label}](${attachment.url})`)
      : '';
    if (!text && !embed) return;

    // 乐观清空：正常情况下输入框立刻空出来。但发送失败时必须把用户打的字还回去，
    // 否则内容直接丢失，而且草稿为空会让「发送」按钮一直处于禁用态。
    // 发送期间用户可能切走，所以还原要认准发送时的那个会话，不能落到当前会话上。
    const sentId = conversation.id;
    const sentDraft = draft;
    const sentAttachment = attachment;
    setDraft('');
    setAttachment(null);
    setMentionQuery(null);
    try {
      await onSend([text, embed].filter(Boolean).join(text && embed ? '\n\n' : ''));
      revokePreview(sentAttachment);             // 发出去的是服务端 url，预览图可以释放了
    } catch {
      // 只在用户没有重新打字时还原，别覆盖掉他在等待期间输入的新内容。
      writeDraft(sentId, (current) => (current ? current : sentDraft));
      writeAttachment(sentId, (current) => {
        if (!current) return sentAttachment;
        revokePreview(sentAttachment);           // 已经有新附件了，旧预览留着也没人看
        return current;
      });
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    // 截图（image/*）优先；从文件管理器复制过来的普通文件也接住，走文件附件那一档。
    // kind === 'string' 的项是纯文本/富文本，交给输入框自己处理，别拦。
    const items = Array.from(e.clipboardData?.items || []).filter((i) => i.kind === 'file');
    const file = (items.find((i) => i.type.startsWith('image/')) ?? items[0])?.getAsFile();
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

      {attachment ? (
        <div className="attach">
          <span className={`attach__thumb${attachment.kind === 'file' ? ' attach__thumb--file' : ''}`}>
            {/* 只有确认过是图片的那一档才内联显示，其余一律给个文件图标。 */}
            {attachment.kind === 'image'
              ? <img src={attachment.previewUrl} alt={attachment.filename} />
              : <FileText size={16} />}
          </span>
          <span className="attach__name">{attachment.filename}</span>
          <span className="attach__state">
            {attachment.error ? attachment.error
              : attachment.uploading ? '上传中…'
                : attachment.kind === 'image' ? '已上传，将作为图片附件发送' : '已上传，将作为文件附件发送'}
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
          title={`从本地选择文件（图片或任意文件，不超过 ${MAX_UPLOAD_MB}MB）`}
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip size={18} />
        </button>
        <input
          ref={fileRef}
          type="file"
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
            placeholder="输入消息，支持 Markdown、粘贴图片、发送文件、@ 提及成员或 AI"
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
