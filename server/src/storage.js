// Attachment storage. The design calls for S3; the default driver writes to local
// disk and hands back a public URL, so the upload route stays identical either way.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPLOAD_DIR } from './db.js';

export const driver = process.env.S3_BUCKET ? 's3' : 'local';

/**
 * 落盘。`ext` 是**服务端**定的扩展名（图片按真实字节嗅探的结果，其余一律 `.bin`），
 * 调用方绝不能把用户传来的文件名传进来 —— 那正是 issue #22 的成因：
 * 沿用 `x.html` 会让 express.static 按网页返回，脚本就在同源下执行了。
 */
export async function putObject({ buffer, ext = '', mime }) {
  const key = `${randomUUID()}${ext}`;
  if (driver === 's3') {
    // Wire an S3 client here; the rest of the app only needs { url, key }.
    throw new Error('S3 driver 未配置：请实现 putObject 的 S3 分支');
  }
  writeFileSync(join(UPLOAD_DIR, key), buffer);
  return { key, url: `/uploads/${key}`, mime };
}
