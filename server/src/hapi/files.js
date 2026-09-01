// 附件双向摆渡（方案 D16）：
//
// 用户→Agent：消息正文里引用的站内附件（/uploads/<key>），在递话前从我们的存储读出、
// 传进 hapi 会话，正文里的链接换成「文件已放到 <路径>」——路径在 runner 机器上，
// Agent 用自己的工具就能读。传不了的（过大/超个数/记录缺失）留占位并写明原因，
// 绝不让 Agent 对着一个它打不开的内链 URL 干瞪眼。
//
// Agent→用户：回合里通过 display_image 交付的图片，收工后从 hub 下载、存成我们的
// 附件、以 Agent 的名义作为图片消息贴进聊天（跟在文字回复后面，不重复引用触发消息，
// 与人类「文字在前、媒体在后」的拆条约定一致）。
//
// 上限（都可用环境变量调）：单文件 HAPI_ATTACH_MAX_MB（默认 15）；单回合双向各
// HAPI_ATTACH_MAX_PER_TURN（默认 5）张——超出的跳过并注明，不整回合失败。
import { extname } from 'node:path';
import { get, run, now, uid } from '../db.js';
import { getObject, putObject } from '../storage.js';
import { attachmentKeysIn } from '../attachments.js';
import { logWarn } from '../log.js';
import { fetchGeneratedImage, uploadSessionFile } from './client.js';

const maxBytes = () => Number(process.env.HAPI_ATTACH_MAX_MB || 15) * 1024 * 1024;
const maxPerTurn = () => Number(process.env.HAPI_ATTACH_MAX_PER_TURN || 5);

const isImageMime = (mime) => String(mime || '').startsWith('image/');

/**
 * 把若干段正文里引用到的站内附件传进会话，返回 { noteFor, attachments }：
 * noteFor(key, 显示名) 给正文替换用（null = 这个 key 不是本轮处理的，保持原占位）；
 * attachments 是随消息一起发的元数据数组。逐个失败逐个跳过，绝不让整回合黄掉。
 */
export async function pushAttachmentsToSession(sessionId, bodies) {
  const keys = [...new Set(bodies.flatMap((b) => attachmentKeysIn(b)))];
  const notes = new Map();
  const attachments = [];
  let sent = 0;
  for (const key of keys) {
    const row = get('SELECT * FROM attachments WHERE url = ?', `/uploads/${key}`);
    const kindWord = isImageMime(row?.mime) ? '图片' : '文件';
    if (!row) continue;                                    // 查无此附件：保持原占位
    if (sent >= maxPerTurn()) {
      notes.set(key, (name) => `[${kindWord} ${name}：本轮附件数已达上限，未传入]`);
      continue;
    }
    if ((row.bytes || 0) > maxBytes()) {
      notes.set(key, (name) => `[${kindWord} ${name}：超过 ${process.env.HAPI_ATTACH_MAX_MB || 15}MB，未传入]`);
      continue;
    }
    try {
      const buffer = await getObject(key);
      if (!buffer) continue;
      const path = await uploadSessionFile(sessionId, {
        filename: row.filename,
        content: buffer.toString('base64'),
        mimeType: row.mime || 'application/octet-stream',
      });
      attachments.push({ id: uid('att'), filename: row.filename, mimeType: row.mime || 'application/octet-stream', size: row.bytes || buffer.length, path });
      sent += 1;
      notes.set(key, (name) => `[${kindWord} ${name} 已放到：${path}]`);
    } catch (err) {
      logWarn('hapi.files.push_failed', { key, detail: String(err.message || err) });
      notes.set(key, (name) => `[${kindWord} ${name}：传入失败，未送达]`);
    }
  }
  return {
    attachments,
    noteFor: (key, name) => {
      const make = notes.get(key);
      return make ? make(name) : null;
    },
  };
}

/**
 * 正文里的站内附件链接 → 摆渡说明（或占位）。noteFor 给 null 时退回默认占位
 * （[图片]/[文件：名]），与群聊补课此前的降级一致。
 */
export function annotateAttachments(body, noteFor = () => null) {
  return String(body)
    .replace(/!\[([^\]]*)\]\(\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]*)\)/g,
      (_, name, key) => noteFor(key, name || '未命名') ?? '[图片]')
    .replace(/\[([^\]]*)\]\(\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]*)\)/g,
      (_, name, key) => noteFor(key, name || '未命名') ?? `[文件：${name || '未命名'}]`);
}

/**
 * 收工后把回合里交付的图片贴进聊天：下载 → 存进我们的附件 → 以 Agent 名义发图片消息。
 * 图片消息不带引用（引用挂在文字回复上，媒体跟随，与人类拆条一致）、不挂过程。
 * 一张失败不连累其余；全部失败也不影响已经贴出的文字回复。
 */
export async function deliverGeneratedImages({ sessionId, images, target, postReply }) {
  let delivered = 0;
  for (const image of images.slice(0, maxPerTurn())) {
    try {
      const buffer = await fetchGeneratedImage(sessionId, image.imageId);
      if (buffer.length > maxBytes()) {
        logWarn('hapi.files.image_too_big', { imageId: image.imageId, bytes: buffer.length });
        continue;
      }
      const ext = extname(image.fileName) || (image.mimeType === 'image/jpeg' ? '.jpg' : '.png');
      const { key, url } = await putObject({ buffer, ext, mime: image.mimeType });
      run('INSERT INTO attachments (id, owner_id, filename, url, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        `att_${key}`, target.userId, image.fileName, url, image.mimeType, buffer.length, now());
      const label = image.fileName.replace(/[[\]]/g, '');
      postReply(target, `![${label}](${url})`, null);
      delivered += 1;
    } catch (err) {
      logWarn('hapi.files.deliver_failed', { imageId: image.imageId, detail: String(err.message || err) });
    }
  }
  return delivered;
}
