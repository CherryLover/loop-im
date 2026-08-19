import { useMemo, useRef, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { Avatar } from './Avatar';
import { api } from '../lib/api';
import type { Conversation } from '../lib/types';

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

export function Composer({
  conversation,
  meId,
  onSend,
}: {
  conversation: Conversation;
  meId: string;
  onSend: (body: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
    const previewUrl = URL.createObjectURL(file);
    setAttachment({ filename: file.name, url: null, previewUrl, uploading: true });
    try {
      const { url, filename } = await api.upload(file);
      setAttachment({ filename, url, previewUrl, uploading: false });
    } catch (err) {
      setAttachment({
        filename: file.name, url: null, previewUrl, uploading: false,
        error: err instanceof Error ? err.message : '上传失败',
      });
    }
  }

  function submit() {
    const text = draft.trim();
    if (attachment?.uploading) return;
    const image = attachment?.url ? `![${attachment.filename}](${attachment.url})` : '';
    if (!text && !image) return;
    onSend([text, image].filter(Boolean).join(text && image ? '\n\n' : ''));
    setDraft('');
    setAttachment(null);
    setMentionQuery(null);
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
      submit();
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

      {attachment ? (
        <div className="attach">
          <span className="attach__thumb">
            <img src={attachment.previewUrl} alt={attachment.filename} />
          </span>
          <span className="attach__name">{attachment.filename}</span>
          <span className="attach__state">
            {attachment.error ? attachment.error : attachment.uploading ? '上传中…' : '已上传，将作为图片附件发送'}
          </span>
          <button type="button" className="attach__x" onClick={() => setAttachment(null)} title="移除附件">
            <X size={13} />
          </button>
        </div>
      ) : null}

      <div className="composer__row">
        <button
          type="button"
          className="composer__plus"
          title="从本地选择图片"
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
          onClick={submit}
          disabled={attachment?.uploading || (!draft.trim() && !attachment?.url)}
        >
          发送
        </button>
      </div>
    </div>
  );
}
