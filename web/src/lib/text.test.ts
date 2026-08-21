// 前端的按字素簇截断。**这一组是服务端 server/test/emoji-truncate.test.js 的镜像**：
// 样本和期望值逐条对齐，两端各有一份实现（跨端不能直接共享模块），只能靠这两组
// 测试保证它们不漂 —— 引用摘要在输入框上方（前端算）和气泡里（服务端算）必须一模一样，
// 一边按码元切一边按字素簇切，同一条消息就会显示成两个样子。
import { describe, expect, it } from 'vitest';
import { graphemeLength, graphemes, truncate } from './text';
import { previewOf, plainTextOf, QUOTE_PREVIEW_LIMIT } from './messages';
import { initialOf } from './md';

/** 有没有落单的代理项 —— 也就是「被切坏了」的判据，肉眼上就是那个 �。 */
const hasLoneSurrogate = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

/** 真实样本。与服务端那份逐条对齐，改一边必须改另一边。 */
const SAMPLES: Array<[string, string, number]> = [
  ['基本 emoji', '👍', 2],
  // ❤ 是 BMP 里的字符（一个码元），加上变体选择符才是两个 —— 它不产生孤儿代理项，
  // 但按码元/码点切一样会把 FE0F 丢掉，红心变成黑心，同样属于「切坏了」。
  ['变体选择符', '❤️', 2],
  ['肤色修饰符', '👍🏽', 4],
  ['ZWJ 家庭', '👨‍👩‍👧', 8],
  ['国旗（两个区域指示符）', '🇨🇳', 4],
];

describe('按字素簇截断', () => {
  it('每个样本都是一个字素簇，但码元数各不相同', () => {
    for (const [name, emoji, units] of SAMPLES) {
      expect(emoji.length, `${name} 的码元数变了，样本可能被编辑器改坏了`).toBe(units);
      expect(graphemeLength(emoji), `${name} 应该算一个「字」`).toBe(1);
      expect(graphemes(emoji), `${name} 不该被拆开`).toEqual([emoji]);
    }
  });

  it('emoji 正好压在截断边界上时，整颗保留或整颗丢掉，绝不留半个', () => {
    const head = '一二三四五六七八九十一二三四五六七八九十一二三四五';   // 25 个字
    for (const [name, emoji] of SAMPLES) {
      const body = `${head}${emoji}收到`;

      // 先证明 bug 确实存在：码元切法在这里就是坏的。
      expect(body.slice(0, 26), `${name}：slice 竟然切对了？样本失效了`).not.toBe(`${head}${emoji}`);

      expect(truncate(body, 26), `${name}：第 26 个字应完整保留`).toBe(`${head}${emoji}`);
      expect(truncate(body, 25), `${name}：越界的 emoji 应整颗丢掉`).toBe(head);

      for (let n = 1; n <= graphemeLength(body); n += 1) {
        const out = truncate(body, n);
        expect(hasLoneSurrogate(out), `${name}：limit=${n} 切出了孤儿代理项 ${JSON.stringify(out)}`).toBe(false);
        expect(graphemeLength(out), `${name}：limit=${n} 字数不对`).toBe(Math.min(n, graphemeLength(body)));
        expect(body.startsWith(out), `${name}：limit=${n} 的结果必须是原文的前缀`).toBe(true);
      }
    }
  });

  it('ZWJ 家庭切在任何位置都不会剩下悬空的连接符或半个家庭', () => {
    const body = `${'啊'.repeat(5)}👨‍👩‍👧好`;
    for (let n = 1; n <= 7; n += 1) {
      const out = truncate(body, n);
      expect(out.endsWith('‍'), `limit=${n} 结尾留了悬空 ZWJ`).toBe(false);
      expect(hasLoneSurrogate(out), `limit=${n} 切出了孤儿代理项`).toBe(false);
    }
    expect(truncate(body, 5)).toBe('啊啊啊啊啊');
    expect(truncate(body, 6)).toBe('啊啊啊啊啊👨‍👩‍👧');
  });

  it('国旗是两个区域指示符，不能只留一个', () => {
    expect(truncate('🇨🇳🇯🇵', 1)).toBe('🇨🇳');
    expect(truncate('🇨🇳🇯🇵', 2)).toBe('🇨🇳🇯🇵');
    expect(graphemeLength('🇨🇳🇯🇵'), '两面旗是两个字，不是四个').toBe(2);
  });

  it('纯 emoji 串按「用户眼里的字数」给够，不因为码元多而少给', () => {
    const flags = '🇨🇳'.repeat(10);
    expect(graphemeLength(flags)).toBe(10);
    expect(truncate(flags, 10), '10 面旗只有 10 个字，不该被截').toBe(flags);
    expect(flags.slice(0, 10).length, 'slice 只能给到 2.5 面旗——这正是要修的').toBe(10);
  });

  it('短于上限时原样返回，边界参数不炸', () => {
    expect(truncate('你好👍', 99)).toBe('你好👍');
    expect(truncate('你好👍', 0)).toBe('');
    expect(truncate('你好👍', -1)).toBe('');
    expect(truncate('你好👍', NaN)).toBe('');
    expect(truncate('', 10)).toBe('');
    expect(graphemeLength('')).toBe(0);
  });
});

describe('前端摘要用的是同一把尺子', () => {
  it('引用摘要（48 字）不留半个 emoji，且第 48 个字完整', () => {
    const head = '一二三四五六七八九十'.repeat(4) + '一二三四五六七';   // 47 个字
    expect(graphemeLength(head)).toBe(QUOTE_PREVIEW_LIMIT - 1);
    for (const [name, emoji] of SAMPLES) {
      const preview = previewOf(`${head}${emoji}尾巴`);
      expect(hasLoneSurrogate(preview), `${name}：引用摘要里有孤儿代理项`).toBe(false);
      expect(preview, `${name}：第 48 个字应是完整的 emoji`).toBe(`${head}${emoji}`);
      expect(graphemeLength(preview)).toBe(QUOTE_PREVIEW_LIMIT);
    }
  });

  it('清洗与截断是两件事：搜索结果行只清洗、不截断', () => {
    const long = `${'一二三四五六七八九十'.repeat(10)}👍`;
    expect(graphemeLength(plainTextOf(long)), '清洗不该动长度').toBe(101);
    expect(plainTextOf('看这个 ![图](/uploads/a.png) **重点**')).toBe('看这个 [图片] 重点');
    // 截断版本仍然按 48 个字来。
    expect(graphemeLength(previewOf(long))).toBe(QUOTE_PREVIEW_LIMIT);
  });

  it('头像首字：名字以 emoji 开头时取一整颗，不是半个代理对', () => {
    expect(initialOf('林悦')).toBe('林');
    expect(initialOf('Aria')).toBe('Ar');
    expect(initialOf('')).toBe('?');
    for (const [name, emoji] of SAMPLES) {
      const got = initialOf(`${emoji}小明`);
      expect(hasLoneSurrogate(got), `${name}：头像首字是半个代理对`).toBe(false);
      expect(got, `${name}：应取完整的一颗`).toBe(emoji);
    }
  });
});
