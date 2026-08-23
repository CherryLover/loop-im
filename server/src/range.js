/**
 * `Range: bytes=...` 的解析。`<video>` 的硬需求：Safari / iOS 拿不到 206 直接不播，
 * 拖进度条也全靠它。
 *
 * 只支持**单段** bytes 范围，三种写法：
 *   bytes=100-199   闭区间
 *   bytes=100-      从 100 到结尾
 *   bytes=-500      最后 500 字节
 *
 * 有意不支持的两种，都按「当作没带 Range，返回 200 + 完整内容」处理（RFC 9110 允许）：
 *   - 多段（`bytes=0-9,20-29`）：要回 multipart/byteranges，播放器不需要，实现它只是徒增面积；
 *   - 非 bytes 单位（`items=0-9`）：规范明确要求忽略不认识的单位。
 *
 * 语法对、但范围落在文件外（`越界`）才是 416：那是客户端算错了位置，必须让它知道，
 * 否则播放器会拿着一段错位的字节一直转圈。416 要带 `Content-Range: bytes * /total`
 * 告诉它文件到底多大。
 */

/**
 * @param {string|undefined} raw  原始的 Range 请求头
 * @param {number} totalSize      对象总字节数
 * @returns {null | {start:number, end:number} | {unsatisfiable:true}}
 *          null = 当作没带 Range（返回 200 完整内容）
 */
export function parseRange(raw, totalSize) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  // 单位不是 bytes（含完全不成形状的头）：按规范忽略，退回 200。
  const m = /^bytes\s*=\s*(.*)$/i.exec(text);
  if (!m) return null;
  const spec = m[1].trim();
  // 多段：不实现 multipart/byteranges，整份返回即可，播放器会自己再要。
  if (spec.includes(',')) return null;

  const parts = /^(\d*)-(\d*)$/.exec(spec);
  // `bytes=` 后面是垃圾（`bytes=abc`、`bytes=`、`bytes=--5`）：语法就不对，一律 416。
  if (!parts || (parts[1] === '' && parts[2] === '')) return { unsatisfiable: true };

  const size = Number(totalSize);
  if (!Number.isFinite(size) || size < 0) return { unsatisfiable: true };

  let start;
  let end;
  if (parts[1] === '') {
    // 后缀式 `bytes=-N`：要最后 N 字节。N=0 没有任何意义，规范也说这是 416。
    const suffix = Number(parts[2]);
    if (suffix === 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(parts[1]);
    // 开区间 `bytes=N-`：一直到结尾。闭区间的 end 超出文件末尾时**截断**而不是报错，
    // 播放器常常故意多要一截（`bytes=0-99999999`），那是合法用法。
    end = parts[2] === '' ? size - 1 : Math.min(Number(parts[2]), size - 1);
  }

  // 空文件、起点已经在文件外、或者截断之后区间反了：都是 416。
  if (size === 0 || start >= size || start > end) return { unsatisfiable: true };
  return { start, end };
}

/** `bytes 100-199/1234` → `{ start, end, total }`；解不出来返回 null。 */
export function parseContentRange(raw) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(raw ?? '').trim());
  if (!m) return null;
  return {
    start: Number(m[1]),
    end: Number(m[2]),
    total: m[3] === '*' ? null : Number(m[3]),
  };
}

/** 416 响应里 `Content-Range: bytes * /total` 的 total，用来从上游的 416 里把总长捞出来。 */
export function totalFromContentRange(raw) {
  const m = /\/(\d+)\s*$/.exec(String(raw ?? '').trim());
  return m ? Number(m[1]) : null;
}
