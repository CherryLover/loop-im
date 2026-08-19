// Attachment storage. The design calls for S3; the default driver writes to local
// disk and hands back a public URL, so the upload route stays identical either way.
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPLOAD_DIR } from './db.js';

export const driver = process.env.S3_BUCKET ? 's3' : 'local';

export async function putObject({ buffer, filename, mime }) {
  const key = `${randomUUID()}${extname(filename) || ''}`;
  if (driver === 's3') {
    // Wire an S3 client here; the rest of the app only needs { url, key }.
    throw new Error('S3 driver 未配置：请实现 putObject 的 S3 分支');
  }
  writeFileSync(join(UPLOAD_DIR, key), buffer);
  return { key, url: `/uploads/${key}`, mime };
}
