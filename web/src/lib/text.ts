// 文本截断的唯一口径：**按字素簇（grapheme cluster）切，不按 UTF-16 码元切**。
//
// 与服务端 server/src/text.js 是同一份实现（跨端不能直接共享模块，只能两边各放一份）。
// 两边的行为由 text.test.ts / text.test.js 里同一组 emoji 样本锁住，改一边必须改另一边。
//
// 为什么不能用 String.prototype.slice()：它按码元切，一个 emoji 占两个码元，切在中间
// 就留下半个代理对（lone surrogate），界面上是一个 �：
//
//   '…一二三四五👍收到'.slice(0, 26)  ->  '…一二三四五\ud83d'   ← 乱码
//
// 为什么也不能只按码点（[...s].slice(n)）切 —— 那只解决一半：
//
//   ❤️  = U+2764 U+FE0F        按码点切成 ❤        变体选择符掉了，红心变黑心
//   👍🏽  = U+1F44D U+1F3FD      按码点切成 👍       肤色修饰符掉了
//   👨‍👩‍👧 = 三个人 + 两个 U+200D   按码点切成 👨       一家三口变成一个人，还可能留下悬空的 ZWJ
//   🇨🇳  = 两个区域指示符        按码点切成 🇨       剩一个孤零零的区域指示符
//
// 字素簇才是「用户眼里的一个字」。Intl.Segmenter 是平台内置的 UAX #29 实现。
//
// locale 固定用 'zh'：字素簇切分本身与 locale 无关（UAX #29 的规则是通用的），
// 写死一个值只是为了两端、各浏览器行为完全一致，不受系统区域设置影响。

const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });

/** 把字符串拆成字素簇数组。文本摘要都很短，这点开销可以忽略。 */
export function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of segmenter.segment(String(text ?? ''))) out.push(segment);
  return out;
}

/**
 * 「用户眼里的字数」。长度校验都该用这个，而不是 .length ——
 * .length 数的是码元，一个 emoji 算 2 个、一家三口算 8 个。
 */
export function graphemeLength(text: string): number {
  return graphemes(text).length;
}

/**
 * 按字素簇截断到 limit 个「字」。短于 limit 时原样返回（不复制、不重排）。
 * limit 非正数或不是有限数时返回空串。
 */
export function truncate(text: string, limit: number): string {
  const s = String(text ?? '');
  if (!Number.isFinite(limit) || limit <= 0) return '';
  // 快路径：码元数都不超过 limit 时，字素簇数必然也不超过，不用切分。
  if (s.length <= limit) return s;
  const out: string[] = [];
  for (const { segment } of segmenter.segment(s)) {
    if (out.length >= limit) break;
    out.push(segment);
  }
  return out.join('');
}
