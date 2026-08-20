// 引用摘要在前端的那份口径：输入框上方看到的一行，和消息发出去之后
// 服务端回给气泡的那一行必须长得一样，不然「选的时候是这句、发完变另一句」。
import { describe, expect, it } from 'vitest';
import { QUOTE_PREVIEW_LIMIT, replyTargetOf } from './messages';
import type { Message } from './types';

const msg = (body: string): Message => ({
  id: 'm_1',
  conversationId: 'c1',
  senderId: 'u_chen',
  senderName: '陈子航',
  senderAvatarUrl: null,
  body,
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: false,
});

describe('从消息造引用态', () => {
  it('带上消息 id 和发送者名字', () => {
    expect(replyTargetOf(msg('联调排期改到下周二'))).toEqual({
      id: 'm_1', senderName: '陈子航', preview: '联调排期改到下周二',
    });
  });

  it('图片折成 [图片]，不把整段 Markdown 塞进引用块', () => {
    expect(replyTargetOf(msg('![截图](/uploads/a.png)')).preview).toBe('[图片]');
  });

  it('去掉 Markdown 记号、把换行压成空格', () => {
    expect(replyTargetOf(msg('## 结论\n- 一\n- 二')).preview).toBe('结论 一 二');
  });

  it('长正文按上限截断', () => {
    const preview = replyTargetOf(msg('一'.repeat(120))).preview;
    expect(preview).toHaveLength(QUOTE_PREVIEW_LIMIT);
  });
});
