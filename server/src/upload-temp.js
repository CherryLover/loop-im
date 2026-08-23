/**
 * 上传中转文件的读取与清理。
 *
 * multer 不再用 memoryStorage（100MB 的视频 × 并发 = OOM），改成先落到 UPLOAD_TMP_DIR。
 * 临时文件**必须保证被删掉**，否则磁盘会一天天被填满，而且填的是用户传上来的原始内容。
 * 一共三条路径：
 *
 *   1. 成功        —— 路由的 finally 里删（local 驱动已经 rename 走了，这里是空操作）；
 *   2. 失败        —— 同一个 finally：嗅探不通过 400、体积超限 413、写对象存储抛异常，
 *                     统统落在同一处，不靠每个 return 前面各写一遍；
 *   3. 请求中断    —— 客户端断线时路由根本不会被执行。这一条由 multer 自己兜住：
 *                     它在 req 的 'aborted' / 'close' 上调 storage._removeFile，
 *                     diskStorage 的实现就是 fs.unlink。同理 busboy 判定超限
 *                     （LIMIT_FILE_SIZE）时也会先删文件再把错误抛给错误中间件。
 *                     我们不重复实现，但**用例逐条盯住**这三条，见 test/upload-temp.test.js。
 */
import { open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { UPLOAD_TMP_DIR } from './db.js';
import { logEvent, logWarn } from './log.js';

/**
 * 嗅探只需要文件开头这么多字节。
 * 所有判定里看得最远的是 looksLikeSvg（前 1024 字节），4KB 留足余量，
 * 而且正好是一个页大小，读起来只有一次 syscall。
 */
export const SNIFF_HEAD_BYTES = 4096;

/** 读临时文件的开头若干字节喂给 inspectUpload。整份 100MB 绝不进内存。 */
export async function readSniffHead(path, bytes = SNIFF_HEAD_BYTES) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 删掉一份中转文件。已经不在了也算成功（local 驱动是 rename 走的，这是正常情况）。
 * 真删不掉只记一行日志，绝不因此把一次成功的上传变成 500 —— 用户的文件已经存好了。
 */
export async function discardTemp(file) {
  const path = file?.path;
  if (!path) return;
  try {
    await rm(path, { force: true });
  } catch (err) {
    // 只记路径不记文件名、更不记内容（见 log.js 的红线）。
    logWarn('upload.temp_cleanup_failed', { err: String(err?.message || err) });
  }
}

/**
 * 启动时扫一遍中转目录，把**陈旧**的残骸清掉。
 *
 * 上面那三条路径盖住了进程还活着的所有情况；盖不住的只剩一种：进程被 `kill -9`
 * 或者容器被硬停在上传半路，那一刻磁盘上的文件没有任何人会来收。一次就几十上百 MB，
 * 攒上几个月就是一块填满的盘，而且没有任何告警会提。所以每次启动兜一次底。
 *
 * 只删「够老」的（默认 6 小时）：万一有别的实例共用同一个 DATA_DIR，
 * 也不至于把人家正在写的那一份删掉。这是删文件，宁可漏删。
 * 与孤儿清理（attachment-access.js）不同，这里**不需要开关**：中转文件是我们自己的
 * 中间产物，不是用户的附件，没有任何东西引用它，删掉不会丢任何数据。
 */
export async function sweepStaleTemp({ olderThanMs = 6 * 60 * 60 * 1000, dir = UPLOAD_TMP_DIR } = {}) {
  let removed = 0;
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return { scanned: 0, removed: 0 };                 // 目录还没建起来，没什么可扫的
  }
  const cutoff = Date.now() - olderThanMs;
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.mtimeMs > cutoff) continue;
      await rm(path, { force: true });
      removed += 1;
    } catch (err) {
      logWarn('upload.temp_sweep_failed', { err: String(err?.message || err) });
    }
  }
  // 只记条数，不记文件名（见 log.js 的红线）。清出东西来才记，正常情况下日志是干净的。
  if (removed) logEvent('upload.temp_swept', { scanned: names.length, removed });
  return { scanned: names.length, removed };
}
