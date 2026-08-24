import { describe, expect, it } from 'vitest';
import { mergeMessage, plainTextOf, previewOf, replyTargetOf } from './messages';
import type { Message } from './types';

const message = (over: Partial<Message>): Message => ({
  id: 'm1',
  conversationId: 'c1',
  senderId: 'u_lin',
  senderName: '林悦',
  senderAvatarUrl: null,
  body: '你好',
  mentions: [],
  createdAt: 1000,
  isAI: false,
  ...over,
});

/**
 * 附件摘要的口径表 —— 这一份是**跨端契约**，不只是本文件的夹具。
 *
 * 背景：plainTextOf 的注释从第一天起就写着「照抄服务端 conversations.js 的 previewOf」，
 * 然后它照样漂了 —— 服务端有「非图片附件 → [文件] 名字」那一条，前端一直没有，
 * 于是引用块和桌面通知里把 `[季度报告.pdf](/uploads/c3d4.pdf)` 整条原样抖了出来，
 * /uploads/ 的真实路径就这么摆在了消息预览里。注释拦不住漂移，用例才能。
 *
 * 所以把口径写成数据摆在这儿，形态只有三种，两端必须一模一样：
 *   [图片] / [视频] / [文件] 名字
 * 这里钉死的是**前端这一份**的行为；服务端那半由另一路改动跟上，
 * 两边真正对齐要在合并时拿同一组正文各跑一遍来验 —— 别指望这个文件能替它验。
 * 谁要改这张表，就是在改跨端契约，服务端那份得一起改。
 */
const ATTACHMENT_PREVIEW_CASES: Array<{ desc: string; body: string; expected: string }> = [
  // ---- 用户当面提的那三种形态 ----
  { desc: '图片折成 [图片]', body: '![风景.png](/uploads/a1b2.png)', expected: '[图片]' },
  {
    desc: '非图片附件折成「[文件] 名字」，不抖出 /uploads/ 路径',
    body: '[季度报告.pdf](/uploads/c3d4.pdf)',
    expected: '[文件] 季度报告.pdf',
  },
  { desc: '视频单独一档 [视频]', body: '[发布会.mp4](/uploads/e5f6.mp4)', expected: '[视频]' },

  // ---- 口径的边界，跟 md.ts 的 isVideoAttachment 对齐 ----
  { desc: '.webm 也是视频', body: '[录屏](/uploads/g7h8.webm)', expected: '[视频]' },
  { desc: '后缀不分大小写', body: '[发布会](/uploads/i9j0.MP4)', expected: '[视频]' },
  {
    desc: '图片语法指向视频时也是 [视频]（md.ts 同样把它渲染成播放器）',
    body: '![宣传片](/uploads/k1l2.mp4)',
    expected: '[视频]',
  },
  {
    desc: '查询串里的 .mp4 不算视频 —— 先切掉 ?query 再看后缀',
    body: '[伪装](/uploads/m3n4.bin?v=.mp4)',
    expected: '[文件] 伪装',
  },
  {
    desc: '站外链接一个字都不动，只有 /uploads/ 才折叠',
    body: '看这个 [季度报告](https://example.com/q3.pdf)',
    expected: '看这个 [季度报告](https://example.com/q3.pdf)',
  },
  {
    desc: '图片和文件混在一段里各折各的',
    body: '看图 ![截图](/uploads/o5p6.png) 还有 [纪要.docx](/uploads/q7r8.docx)',
    expected: '看图 [图片] 还有 [文件] 纪要.docx',
  },
  {
    desc: '名字里的 - 会被 Markdown 记号那条洗成空格（服务端同款毛刺，一起认下来）',
    body: '[Q3-报告.pdf](/uploads/s9t0.pdf)',
    expected: '[文件] Q3 报告.pdf',
  },
  // Markdown 记号是被换成空格再压空白的，不是被删掉的（服务端同款）。
  { desc: '没有附件的正文照旧只做记号清洗', body: '**今晚**发版', expected: '今晚 发版' },
];

describe('摘要里的附件口径（[图片] / [视频] / [文件] 名字）', () => {
  for (const { desc, body, expected } of ATTACHMENT_PREVIEW_CASES) {
    it(desc, () => {
      // 全等，不用 toContain：漏掉一条规则时残留的 /uploads/ 路径也「包含」着期望的片段。
      expect(plainTextOf(body)).toBe(expected);
    });
  }

  it('引用块用的 previewOf 走同一份清洗 —— 这就是当初漏出 /uploads/ 的那条路径', () => {
    expect(previewOf('[季度报告.pdf](/uploads/c3d4.pdf)')).toBe('[文件] 季度报告.pdf');
    expect(previewOf('[发布会.mp4](/uploads/e5f6.mp4)')).toBe('[视频]');
  });

  it('回复目标的摘要同样不带原始路径', () => {
    const target = replyTargetOf({
      id: 'm_pdf',
      conversationId: 'c1',
      senderId: 'u_chen',
      senderName: '陈默',
      senderAvatarUrl: null,
      body: '[季度报告.pdf](/uploads/c3d4.pdf)',
      mentions: [],
      createdAt: 1000,
      isAI: false,
    });
    expect(target.preview).toBe('[文件] 季度报告.pdf');
  });

  it('截断仍然在清洗之后发生，48 字上限没变', () => {
    // 折叠之后才数长度：`[文件] 纪要.pdf ` 是 12 个字，后面还能再放 36 个。
    // 要是清洗漏了那条规则，被数进 48 里的就会是 `/uploads/u1v2.pdf` 那一串。
    expect(previewOf(`[纪要.pdf](/uploads/u1v2.pdf) ${'很'.repeat(80)}`))
      .toBe(`[文件] 纪要.pdf ${'很'.repeat(36)}`);
  });
});

describe('消息合并', () => {
  it('按发送时间排序，AI 回复不会插到自己的消息前面', () => {
    const mine = message({ id: 'm_mine', createdAt: 2000, body: '@Aria 看下风险' });
    const reply = message({ id: 'm_ai', senderId: 'ai', isAI: true, createdAt: 2100, body: '已收到提及' });
    const merged = mergeMessage([reply], mine);
    expect(merged.map((m) => m.id)).toEqual(['m_mine', 'm_ai']);
  });

  it('同一条消息从 HTTP 和 SSE 各来一次也只保留一条', () => {
    const confirmed = message({ id: 'm_1' });
    expect(mergeMessage([confirmed], confirmed)).toHaveLength(1);
  });

  it('确认后的消息会顶掉对应的乐观占位', () => {
    const optimistic = message({ id: 'tmp_1', body: '在写了', pending: true, createdAt: 5000 });
    const confirmed = message({ id: 'm_9', body: '在写了', createdAt: 3000 });
    const merged = mergeMessage([optimistic], confirmed);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('m_9');
  });

  it('别人的同文本消息不会误删我的待发消息', () => {
    const mine = message({ id: 'tmp_1', body: '收到', pending: true, createdAt: 5000 });
    const theirs = message({ id: 'm_2', senderId: 'u_chen', body: '收到', createdAt: 4000 });
    const merged = mergeMessage([mine], theirs);
    expect(merged.map((m) => m.id)).toEqual(['m_2', 'tmp_1']);
  });

  it('待发送的消息始终排在最后', () => {
    const pending = message({ id: 'tmp_2', body: '还在发', pending: true, createdAt: 100 });
    const confirmed = message({ id: 'm_3', createdAt: 9000 });
    expect(mergeMessage([pending], confirmed).map((m) => m.id)).toEqual(['m_3', 'tmp_2']);
  });
});
