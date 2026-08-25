import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CornerUpLeft, FileText, Film, Paperclip, X } from 'lucide-react';
import { Avatar } from './Avatar';
import { api, MAX_UPLOAD_MB, MAX_VIDEO_UPLOAD_MB } from '../lib/api';
import { rememberPreview } from '../lib/upload-cache';
import type { AttachmentKind, Conversation, ReplyTarget } from '../lib/types';

interface MentionOption {
  key: string;
  label: string;
  name: string;
  avatarUrl: string | null;
  isAI: boolean;
}

interface Attachment {
  /**
   * 本地唯一 id。以前只有一个附件时用 previewUrl 当身份就够了，多选之后不行：
   * jsdom 里 URL.createObjectURL 是个返回常量的桩，真实浏览器里同一个 File 反复
   * createObjectURL 也未必唯一。上传结果落地、移除单个附件都靠这个 id 定位。
   */
  id: string;
  filename: string;
  url: string | null;
  previewUrl: string;
  uploading: boolean;
  /**
   * image 内联渲染成图片，video 内联成播放器；file 一律拼成普通链接，
   * 只能下载（见 issue #22）。
   */
  kind: AttachmentKind;
  error?: string;
}

/**
 * 一次最多能挂几个附件。
 *
 * 定 9 的两条理由：
 *  1. 服务端 /uploads 是每分钟 20 次的用量限流（server/src/usage-limit.js）。
 *     9 个一批意味着连发两批（18 次）仍在额度内，用户不会因为「正常地发了两组图」
 *     就撞上「上传太频繁了」。取 10 的话两批正好顶到 20，第三次动作立刻被拒，
 *     余量太薄；不设上限则一次拖 50 张既卡住自己（同时 50 个请求）也把额度瞬间打光。
 *  2. 9 是 IM 里通行的一批张数（3×3 一屏），用户对「一次最多九张」有现成预期。
 */
export const MAX_ATTACHMENTS = 9;

// 上传前只能按浏览器给的 type 猜一下，用来决定预览要不要显示缩略图。
// 真正算数的是服务端按真实字节给出的 kind，落地时会覆盖这里的猜测。
const guessKind = (file: File): AttachmentKind => (
  file.type.startsWith('image/') ? 'image'
    : file.type.startsWith('video/') ? 'video'
      : 'file'
);

/** 附件条上的说明文案。 */
const KIND_HINT: Record<AttachmentKind, string> = {
  image: '已上传，将作为图片附件发送',
  video: '已上传，将作为视频发送，可在聊天里直接播放',
  file: '已上传，将作为文件附件发送',
};

/** 附件的本地 id。进程内自增就够用，不需要全局唯一。 */
let attachmentSeq = 0;
const nextAttachmentId = () => `att_${++attachmentSeq}`;

/** 把输入框高度写成内容的实际高度（上限交给 CSS 的 max-height）。 */
function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  // 量不出来（jsdom 天生如此；display:none 里也是 0）就保持 auto，让 CSS 的
  // min-height 兜底，绝不把 0px 写上去。等元素真正可见时宽度监听会补量一次。
  if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
}

/** 一个会话暂存下来的输入状态。 */
interface DraftEntry {
  draft: string;
  /**
   * 待发送的附件，**按用户选择的顺序**。顺序是有意义的：发送时就按这个顺序
   * 一条一条发出去，对面看到的排序和这里一致。
   */
  attachments: Attachment[];
  /**
   * 正在回复哪一条。和草稿、附件是同一类东西：属于某个会话而不是属于这个组件，
   * 所以必须一起进暂存表 —— 否则在 A 群点了「回复」再切到 B 群，引用块会挂到 B 群头上。
   */
  replyTo: ReplyTarget | null;
}

// 只读的空态。attachments 这个数组会被多个 entry 共享引用，所以下面所有更新
// 一律「造新数组」，绝不原地 push/splice。
const EMPTY_ENTRY: DraftEntry = { draft: '', attachments: [], replyTo: null };

// previewUrl 是 URL.createObjectURL 造出来的，不主动释放会一直占着 blob。
// 只在这张图确定不会再被渲染时调用：被移除、发送失败被丢弃、组件卸载。
//
// 注意「发送成功」不再无条件走这里了：图片发出去之后 blob 会交给 upload-cache
// 接管（发送方渲染自己刚发的图时直接用本地原图，不再回源下载一遍），
// 那份 blob 的释放由缓存的 LRU 负责，见 lib/upload-cache.ts。
// 重复调用是无害的空操作，所以放在 state updater 里也不会出问题。
function revokePreview(attachment: Attachment | null | undefined) {
  // jsdom 等环境没有实现 revokeObjectURL，缺了就跳过。
  if (attachment?.previewUrl && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

/** 一个附件拼成的消息正文。图片用 Markdown 图片语法，视频和普通文件用链接语法。 */
function embedOf(attachment: Attachment): string {
  // 视频用链接写法而不是图片写法：它本来就不是图片，而且这样在任何不认识视频的地方
  // （老客户端、纯文本摘要）都会降级成一条能点开的附件链接。真正决定「渲染成播放器
  // 还是文件卡片」的是服务端给的扩展名，不是这里选了哪种语法，见 lib/md.ts。
  // 方括号会撑破 Markdown 的链接语法，从显示名里去掉，不影响服务端存的那份原名。
  const label = attachment.filename.replace(/[[\]]/g, '');
  return attachment.kind === 'image'
    ? `![${label}](${attachment.url})`
    : `[${label}](${attachment.url})`;
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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  // 「超出上限」这类一次性提示。它不属于某个会话的输入内容，所以**不进暂存表**，
  // 切会话、重新选文件时清掉即可。
  const [notice, setNotice] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 输入框高度跟着内容走：一行起步，写多行就长高，上限之后内部滚动（上限在 CSS 的
  // max-height 里，桌面和手机各一档）。量高度的办法是先把 height 打回 auto 再读
  // scrollHeight —— 不打回去的话，删行之后 scrollHeight 永远等于旧高度，缩不回来。
  // 挂在 layoutEffect 上而不是 onChange 里：draft 的来路不止打字一条 —— 选中 @ 补全、
  // 发送后清空、发送失败还原、切会话恢复草稿，全都要跟着重新量一次。
  useLayoutEffect(() => {
    autosize(inputRef.current);
  }, [draft, conversation.id]);

  // 内容没变但**宽度**变了，换行点就全变了，高度同样要重量：窗口缩放、成员面板
  // 开合、手机上从「会话列表」切回聊天（display:none 里量出来的高度是 0，白量）。
  // 只认宽度变化就够了 —— 高度变化是上面自己写出来的，跟着它再量会原地打转。
  const measuredWidth = useRef(-1);
  useLayoutEffect(() => {
    const el = inputRef.current;
    // jsdom 没有 ResizeObserver：宽度不会变，跳过即可。
    if (!el || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width === measuredWidth.current) return;
      measuredWidth.current = width;
      autosize(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
  liveEntry.current = { draft, attachments, replyTo };

  // 会话变了：把旧会话的输入状态存起来，换上新会话自己的那份。
  // 在渲染期同步切换，避免先渲染出上一个会话的内容再被 effect 改掉。
  if (shownId !== conversation.id) {
    stash.current.set(shownId, { draft, attachments, replyTo });
    const restored = stash.current.get(conversation.id) ?? EMPTY_ENTRY;
    setShownId(conversation.id);
    setDraft(restored.draft);
    setAttachments(restored.attachments);
    setReplyTo(restored.replyTo);
    setNotice(null);
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
    // 已经发出去、交给 upload-cache 接管的那些不在这两处，不会被误放。
    for (const a of liveEntry.current.attachments) revokePreview(a);
    for (const entry of stash.current.values()) for (const a of entry.attachments) revokePreview(a);
  }, []);

  // 下面三个 write* 负责把更新写到「正确的会话」上：如果那个会话还显示着就走
  // state，已经切走了就直接改暂存，免得上传结果或发送失败的还原串到别的群里。
  function writeDraft(id: string, update: (prev: string) => string) {
    if (id === liveId.current) {
      setDraft(update);
      return;
    }
    const entry = stash.current.get(id) ?? EMPTY_ENTRY;
    stash.current.set(id, { ...entry, draft: update(entry.draft) });
  }

  function writeAttachments(id: string, update: (prev: Attachment[]) => Attachment[]) {
    if (id === liveId.current) {
      setAttachments(update);
      return;
    }
    const entry = stash.current.get(id) ?? EMPTY_ENTRY;
    stash.current.set(id, { ...entry, attachments: update(entry.attachments) });
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

  /**
   * 单个附件的上传。每个附件各走各的：一个失败只写坏它自己那一行，
   * 其余的照常上传、照常可发。
   */
  async function uploadOne(convId: string, id: string, file: File, guessed: AttachmentKind) {
    // 上传期间用户可能已经把这一条删了，落地时先按 id 确认它还在。
    // 不在就什么都不做 —— 它的 blob 在被移除时已经放掉了。
    const land = (patch: Partial<Attachment>) => writeAttachments(convId, (prev) => {
      const at = prev.findIndex((a) => a.id === id);
      if (at < 0) return prev;
      const next = prev.slice();
      next[at] = { ...next[at], ...patch };
      return next;
    });

    try {
      const { url, filename, kind } = await api.upload(file);
      // kind 以服务端为准（老服务端不返回这个字段时退回本地的猜测）。
      land({ filename, url, uploading: false, kind: kind ?? guessed, error: undefined });
    } catch (err) {
      land({ uploading: false, error: err instanceof Error ? err.message : '上传失败' });
    }
  }

  /** 选中若干个文件：超过上限的部分不收，其余每个各起一次上传。 */
  function attach(files: File[]) {
    if (!files.length) return;
    const convId = conversation.id;

    // attachments 取自本次渲染。选文件、粘贴都是各自独立的一次交互，
    // 中间必然隔了一次渲染，所以这里读到的就是最新值。
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setNotice(`最多同时挂 ${MAX_ATTACHMENTS} 个附件，先发送或移除几个再选`);
      return;
    }
    const accepted = files.slice(0, room);
    const dropped = files.length - accepted.length;
    setNotice(dropped > 0
      ? `一次最多 ${MAX_ATTACHMENTS} 个附件，这次加进来 ${accepted.length} 个，剩下 ${dropped} 个没有加`
      : null);

    const pending: Attachment[] = accepted.map((file) => ({
      id: nextAttachmentId(),
      filename: file.name,
      url: null,
      previewUrl: URL.createObjectURL(file),
      uploading: true,
      kind: guessKind(file),
    }));
    writeAttachments(convId, (prev) => [...prev, ...pending]);
    // 并发发起：一个慢文件不该把后面的都堵住。浏览器自己会把同域并发压到几条，
    // 而 9 这个上限保证了最坏情况也就 9 个请求。
    pending.forEach((entry, i) => void uploadOne(convId, entry.id, accepted[i], entry.kind));
  }

  function removeAttachment(id: string) {
    setNotice(null);
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (!gone) return prev;
      revokePreview(gone);
      return prev.filter((a) => a.id !== id);
    });
  }

  /**
   * 发送。文字和每个附件**各发一条消息**，文字在前、媒体按选择顺序在后。
   *
   * 产品决定不做图文混排：聊天里图归图、字归字，一条消息一个气泡。所以选 3 张图
   * 加一段文字会发 4 条 —— 也因此有了「发到一半失败」这种中间态，处理规则见下。
   */
  async function submit() {
    const text = draft.trim();
    // 还有在传的就先不发：它没有 url，发出去只会是一条空链接。
    if (attachments.some((a) => a.uploading)) return;

    // 上传失败的那些没有 url，发不出去。它们**留在附件条上**（而不是跟着乐观清空
    // 一起被丢掉）：多选之后一批里坏一两个是常态，悄悄扔掉用户根本发现不了自己
    // 少发了东西，留在那里既是提示也方便移除或重选。
    const sendable = attachments.filter((a) => a.url);
    const stuck = attachments.filter((a) => !a.url);
    if (!text && !sendable.length) return;

    // 乐观清空：正常情况下输入框立刻空出来。但发送失败时必须把没发成的部分还回去，
    // 否则内容直接丢失，而且草稿为空会让「发送」按钮一直处于禁用态。
    // 发送期间用户可能切走，所以还原要认准发送时的那个会话，不能落到当前会话上。
    const sentId = conversation.id;
    const sentDraft = draft;
    const sentReply = replyTo;
    setDraft('');
    setAttachments(stuck);
    setReplyTo(null);
    setNotice(null);
    setMentionQuery(null);

    // 三个还原动作各自独立，失败时只调用对应的那一个 —— 这就是「只还原失败的那部分」。
    // 文字和引用都只在用户没有重新输入时才还原，别覆盖掉他在等待期间的新内容。
    const restoreText = () => writeDraft(sentId, (current) => (current ? current : sentDraft));
    const restoreReply = () => writeReply(sentId, (current) => current ?? sentReply);
    /** 把还没发出去的那些附件放回附件条最前面，保持用户当初选的顺序。 */
    const restoreAttachments = (rest: Attachment[]) => writeAttachments(sentId, (current) => {
      const merged = [...rest, ...current];
      if (merged.length <= MAX_ATTACHMENTS) return merged;
      // 极端情况：等待期间用户又选了新的，加起来超过上限。没发出去的优先留下
      // （那是他真正要发的内容），队尾多出来的丢掉并释放，免得漏 blob。
      for (const extra of merged.slice(MAX_ATTACHMENTS)) revokePreview(extra);
      return merged.slice(0, MAX_ATTACHMENTS);
    });

    // 引用挂在**第一条**上：有文字就挂文字那条，只有附件时才挂第一个附件那条。
    // 一次回复只该产生一个引用块，挂多条会在对话里显示成引用了好几遍。
    const replyOnText = Boolean(text);
    const send = (body: string, carriesReply: boolean) => (
      // 不引用时不传第二个参数：既有调用方（和它们的用例）看到的调用形态一点没变。
      sentReply && carriesReply ? onSend(body, sentReply.id) : onSend(body)
    );

    if (text) {
      try {
        await send(text, true);
      } catch {
        // 文字这条没发出去，后面的附件**一个都不发**：这一组的顺序是文字在前，
        // 只把媒体发出去会让对面先看到图再看不到说明。整组退回输入框，原样重试即可。
        restoreText();
        restoreAttachments(sendable);
        restoreReply();
        return;
      }
    }

    // 附件按顺序一条一条发。**任何一条失败就地停下**，它和它后面的一起退回附件条。
    //
    // 为什么不是「跳过坏的继续发后面的」：
    //  1. 顺序是有语义的（截图 1/2/3、合同第 1 页第 2 页）。跳过第 2 张接着发第 3 张，
    //     用户补发第 2 张时它会落在第 3 张后面，顺序被永久打乱 —— 比少一张更难发现，
    //     也更难修。停下来则保证「已经发出去的永远是一个正确的前缀」，退回的那截
    //     重发一次就能原样接上。
    //  2. 第 2 张失败的常见原因（断网、被移出会话、撞上限流）对第 3 张同样成立，
    //     硬发下去只会把 1 次失败变成 8 次失败，还白白烧掉限流额度，把用户更快
    //     推到「上传太频繁了」那堵墙上。
    //  3. 和上面「文字没成 → 媒体不发」是同一条规则：整个发送是一个有序序列，
    //     断在哪里就停在哪里。用户只需要记一套行为。
    for (let i = 0; i < sendable.length; i += 1) {
      const current = sendable[i];
      try {
        await send(embedOf(current), !replyOnText && i === 0);
      } catch {
        // 已经发出去的那些（文字、以及 0..i-1 这几个附件）绝不能退回输入框 ——
        // 它们真的已经在对话里了，退回去等于让用户以为没发出去，重试一次就发重。
        restoreAttachments(sendable.slice(i));
        if (!replyOnText && i === 0) restoreReply();   // 引用挂在这一条上时才跟着退回
        return;
      }
      if (current.kind === 'image' && current.url) {
        // 这张图真的发出去了：把本地原图交给预览缓存，发送方渲染自己刚发的图时
        // 直接用它，不用再把刚上传的东西下载回来一遍（还要过鉴权和 MinIO）。
        // blob 从此归缓存管，这里**不能** revoke，否则缓存里存的是个失效地址。
        rememberPreview(current.url, current.previewUrl);
      } else {
        // 视频和普通文件不进缓存：视频单个能到 100MB，为省一次请求把它按在内存里
        // 是亏的（<video> 本来就是按 Range 流式播）；普通文件根本没有内联预览。
        revokePreview(current);
      }
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
    // 截图（image/*）优先；从文件管理器复制过来的普通文件也接住，走文件附件那一档。
    // kind === 'string' 的项是纯文本/富文本，交给输入框自己处理，别拦。
    // 剪贴板里有多个文件时一次全收下（多选之后这是合法输入，不再只取第一个）。
    const items = Array.from(e.clipboardData?.items || []).filter((i) => i.kind === 'file');
    const images = items.filter((i) => i.type.startsWith('image/'));
    const files = (images.length ? images : items)
      .map((i) => i.getAsFile())
      .filter((f): f is File => Boolean(f));
    if (files.length) {
      e.preventDefault();
      attach(files);
    }
  }

  const uploading = attachments.some((a) => a.uploading);
  const sendable = attachments.some((a) => a.url);

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

      {notice ? <div className="attach-note">{notice}</div> : null}

      {attachments.length ? (
        <>
          {/* 只有一个时不啰嗦，多选了才提示总数和「各占一个气泡」这件事。 */}
          {attachments.length > 1 ? (
            <div className="attach-list__count">
              已选 {attachments.length}/{MAX_ATTACHMENTS} 个附件，将按顺序各发一条
            </div>
          ) : null}
          {/* 横向一排 1:1 方块，放不下就横向滚（见 styles.css 的说明）。
              竖排时 9 个附件 = 9 行，手机上直接把输入框顶出可视区；横排之后
              不管选几个，占的垂直空间都是固定的一格。 */}
          <div className="attach-list">
            {attachments.map((attachment) => (
              <div
                className="attach"
                key={attachment.id}
                /* 方块只有 72px 宽，文件名一定会被截断；完整名字挂在 title 上，
                   鼠标悬停能看全，读屏则读下面的 .attach__name。 */
                title={attachment.filename}
                data-state={attachment.error ? 'error' : attachment.uploading ? 'uploading' : 'ready'}
              >
                <span className={`attach__thumb${attachment.kind === 'image' ? '' : ' attach__thumb--file'}`}>
                  {/* 只有确认过是图片的那一档才内联显示缩略图，视频给胶片图标，其余给文件图标。
                      这里刻意不为待发的视频做一个 <video> 预览：会白白解一遍码，而这个方块
                      本来就只是「选了什么」的提示。 */}
                  {/* alt 留空是**故意**的：文件名就在下面那条 .attach__name 上，
                      再给缩略图配一遍 alt，读屏会把同一个名字连读两次。 */}
                  {attachment.kind === 'image'
                    ? <img src={attachment.previewUrl} alt="" />
                    : attachment.kind === 'video' ? <Film size={22} />
                      : <FileText size={22} />}
                </span>
                <span className="attach__name">{attachment.filename}</span>
                {/* 失败的那一档不在方块里写原因：服务端的报错可能很长，72px 的格子里
                    只能截断，而「为什么失败」恰恰是用户必须读全的一句。所以方块上只留
                    虚线边 + ⚠ 两个**非颜色**的标记，完整原因放到下面的 .attach-alert，
                    并且全篇只出现这一处，不重复。 */}
                {attachment.error ? null : (
                  <span className="attach__state">
                    {attachment.uploading ? '上传中…' : KIND_HINT[attachment.kind]}
                  </span>
                )}
                <button
                  type="button"
                  className="attach__x"
                  onClick={() => removeAttachment(attachment.id)}
                  title="移除附件"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          {/* 上传失败的完整原因。role="alert" 让读屏在失败发生时立刻播报；
              视觉上它是一条独立的文字行，不依赖悬停，手机上也读得到。 */}
          {attachments.some((a) => a.error) ? (
            <div className="attach-alerts" role="alert">
              {attachments.filter((a) => a.error).map((a) => (
                /* 文件名故意**不**包在自己的元素里：包起来的话它和方块里的
                   .attach__name 就是两个内容相同的节点，getByText(文件名) 会撞车。 */
                <p className="attach-alert" key={a.id}>
                  {a.filename}：<span className="attach__state">{a.error}</span>
                </p>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="composer__row">
        <button
          type="button"
          className="composer__plus"
          title={`从本地选择文件（图片、视频或任意文件；视频不超过 ${MAX_VIDEO_UPLOAD_MB}MB，其余不超过 ${MAX_UPLOAD_MB}MB）`}
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip size={18} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) attach(files);
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
          disabled={uploading || (!draft.trim() && !sendable)}
        >
          发送
        </button>
      </div>
    </div>
  );
}
