#!/usr/bin/env node
/**
 * 清点 / 清理 issue #22 修复之前落盘的历史上传文件。
 *
 *   node scripts/cleanup-legacy-uploads.mjs                 # 只清点，什么都不改（默认）
 *   node scripts/cleanup-legacy-uploads.mjs --apply         # 把可疑文件移进 uploads/quarantine/
 *   node scripts/cleanup-legacy-uploads.mjs --apply --delete # 直接删除（不可恢复，慎用）
 *   node scripts/cleanup-legacy-uploads.mjs --help
 *
 * 目录默认取 DATA_DIR/uploads（和服务端同一个环境变量），也可以用 --dir 指定。
 *
 * 为什么不在启动时自动跑：
 *   这些是**用户数据**。启动即删太危险 —— 误判、跑错环境、或者只是想先看一眼，
 *   都会变成不可逆的损失。所以只做成手动脚本，默认还只是预演。
 *
 * 为什么不着急：
 *   修复之后 /uploads 的回源响应头已经按扩展名白名单发：白名单（.png/.jpg/.jpeg/.gif/.webp）
 *   之外的一律 `Content-Disposition: attachment` + `application/octet-stream` + `nosniff`，
 *   历史上那些 .html/.svg 从升级那一刻起就已经跑不起来了（server/src/attachments.js）。
 *   这个脚本是卫生工作，不是止血。
 *
 * 判定口径（和服务端同一套函数，不另写一份）：
 *   - 扩展名在内联白名单里，但真实字节不是对应的图片 —— 可疑（伪装成图片的东西）；
 *   - 真实字节是 SVG —— 可疑（SVG 现在一律不收）；
 *   - 扩展名不在白名单、也不是 .bin —— 可疑（修复前沿用用户扩展名留下的产物）；
 *   - 其余（合法图片、以及新方案落下的 .bin）—— 保留。
 *
 * 隔离而不是删除是默认动作：文件被移进 uploads/quarantine/ 之后 URL 就 404 了，
 * 万一误判还能搬回来。确认无误再加 --delete。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeSvg, sniffImage } from '../server/src/attachments.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 12).join('\n').replace(/^ \* ?/gm, ''));
  process.exit(0);
}

const apply = args.includes('--apply');
const remove = args.includes('--delete');
const dirArg = args.indexOf('--dir');
const dataDir = process.env.DATA_DIR || join(here, '..', 'server', 'data');
const uploadDir = dirArg >= 0 ? args[dirArg + 1] : join(dataDir, 'uploads');

if (!existsSync(uploadDir)) {
  console.error(`找不到上传目录：${uploadDir}\n用 DATA_DIR 或 --dir 指定。`);
  process.exit(1);
}

const QUARANTINE = join(uploadDir, 'quarantine');
// 服务端会内联返回的扩展名，各自对应的真实图片 mime。
const INLINE = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'],
]);

/** 这个文件该不该被拎出来。返回原因字符串，没问题就返回 null。 */
function suspicionOf(name, buffer) {
  const ext = extname(name).toLowerCase();
  const image = sniffImage(buffer);
  if (looksLikeSvg(buffer)) return 'SVG（可执行的 XML，现在一律不收）';
  if (INLINE.has(ext)) {
    if (!image) return `扩展名是 ${ext}，真实字节却不是图片`;
    if (image.mime !== INLINE.get(ext)) return `扩展名是 ${ext}，真实字节是 ${image.mime}`;
    return null;
  }
  if (ext === '.bin') return null;                       // 新方案落下的普通附件
  return `扩展名 ${ext || '（无）'} 不在内联白名单里，是修复前沿用用户文件名留下的`;
}

const rows = [];
for (const name of readdirSync(uploadDir)) {
  const full = join(uploadDir, name);
  if (!statSync(full).isFile()) continue;
  const buffer = readFileSync(full);
  const reason = suspicionOf(name, buffer);
  if (reason) rows.push({ name, full, reason, bytes: buffer.length });
}

console.log(`上传目录：${uploadDir}`);
console.log(`可疑文件：${rows.length} 个\n`);
for (const row of rows) console.log(`  ${row.name}  (${row.bytes} 字节)  ← ${row.reason}`);

if (!rows.length) process.exit(0);

if (!apply) {
  console.log('\n这是预演，什么都没改。');
  console.log('  隔离（可恢复）：node scripts/cleanup-legacy-uploads.mjs --apply');
  console.log('  直接删除（不可恢复）：node scripts/cleanup-legacy-uploads.mjs --apply --delete');
  console.log('\n提醒：这些文件即使留着也已经不能作为网页执行了（回源强制下载）。');
  console.log('      被引用过的附件一旦处理，聊天记录里对应的链接会变成 404。');
  process.exit(0);
}

if (!remove) mkdirSync(QUARANTINE, { recursive: true });
for (const row of rows) {
  if (remove) {
    unlinkSync(row.full);
    console.log(`已删除 ${row.name}`);
  } else {
    renameSync(row.full, join(QUARANTINE, row.name));
    console.log(`已隔离 ${row.name} → quarantine/`);
  }
}
console.log(`\n完成：${rows.length} 个文件${remove ? '已删除' : `已移进 ${QUARANTINE}`}。`);
