// 自己发的气泡（.bubble--me）是实色紫 #5B4BC4 + 白字，气泡**内部**的元素必须跟着反相。
// 上一批加代码块时漏了这一步：`.md code` / `.md .mdcode` 用的是 --surface3 —— 那是给
// 「浅色页面底」配的浅灰。浅色主题下白字压 #E8E5E0 只有 1.26:1（读不出来），
// 深色主题下 #302E38 压在紫气泡上明度比 2.06（就是用户说的「叠在一起很累」）。
//
// 颜色本身 jsdom 验不了（不做布局、不算层叠、不载样式表），只能到浏览器里看。
// 但**样式挂靠点**是纯 DOM，而且恰恰是最容易被无声改坏的一环：
//
//   最大的坑：`md`、`bubble`、`bubble--me` 是同一个 div 上的三个类，
//   所以 `.bubble--me .md code` 这种**后代**写法一个元素都匹配不到。
//   仓库里原来那条 `.bubble--me .md blockquote` 就是这么写的，一直没生效。
//   下面第一组用例把「同一个元素」这件事钉死：真要哪天拆成父子两层，
//   得先看见这里红，再回去把 styles.css 里那一串选择器一起改。
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MessageList } from './MessageList';
import type { Message } from '../lib/types';

const message = (body: string, senderId: string): Message => ({
  id: 'm_1',
  conversationId: 'c1',
  senderId,
  senderName: senderId === 'u_lin' ? '林悦' : '陈子航',
  senderAvatarUrl: null,
  body,
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: false,
});

/** meId 恒为 u_lin：sender 传 u_lin 就是「自己发的」，传别人就是对方发的。 */
const view = (body: string, senderId = 'u_lin') =>
  render(
    <MessageList
      messages={[message(body, senderId)]}
      meId="u_lin"
      showSenderName
      typing={false}
    />,
  );

describe('气泡的类名结构：反相选择器全靠它', () => {
  it('md / bubble / bubble--me 在同一个元素上，不是父子两层', () => {
    const { container } = view('随便一句');
    const bubble = container.querySelector('.bubble--me') as HTMLElement;

    expect(bubble).not.toBeNull();
    expect(bubble.classList.contains('md')).toBe(true);
    // 反过来也钉一遍：.bubble--me 底下**没有**另一个 .md，
    // 所以 `.bubble--me .md X` 永远是空匹配，styles.css 里不能那么写。
    expect(bubble.querySelector('.md')).toBeNull();
  });

  it('对方的气泡不带 bubble--me，反相规则不会误伤', () => {
    const { container } = view('随便一句', 'u_chen');
    expect(container.querySelector('.bubble--me')).toBeNull();
    expect(container.querySelector('.bubble')?.classList.contains('md')).toBe(true);
  });
});

describe('需要反相的元素，挂靠点都在自己气泡里面', () => {
  it('代码块是 pre.mdcode > code，两层都在 .bubble--me 内', () => {
    const { container } = view('```\nnpm run build\n```');
    const bubble = container.querySelector('.bubble--me') as HTMLElement;
    const pre = bubble.querySelector('pre.mdcode') as HTMLElement;

    expect(pre).not.toBeNull();
    expect(pre.querySelector('code')?.textContent).toBe('npm run build');
  });

  it('行内代码是**裸的** <code>，不在 .mdcode 里 —— 两者要分别给底色', () => {
    const { container } = view('跑一下 `npm ci` 再说');
    const bubble = container.querySelector('.bubble--me') as HTMLElement;
    const codes = Array.from(bubble.querySelectorAll('code'));

    expect(codes).toHaveLength(1);
    expect(codes[0].textContent).toBe('npm ci');
    expect(codes[0].closest('.mdcode')).toBeNull();
  });

  it('同一条消息里行内代码和代码块可以共存，各自认各自的规则', () => {
    const { container } = view('先 `cd web`：\n\n```\nnpm test\n```');
    const bubble = container.querySelector('.bubble--me') as HTMLElement;
    const inline = Array.from(bubble.querySelectorAll('code')).filter((c) => !c.closest('.mdcode'));
    const inBlock = Array.from(bubble.querySelectorAll('.mdcode code'));

    expect(inline.map((c) => c.textContent)).toEqual(['cd web']);
    expect(inBlock.map((c) => c.textContent)).toEqual(['npm test']);
  });

  it('普通链接是不带 .filecard 的 <a>（要刷成白字 + 下划线的就是它）', () => {
    const { container } = view('看这个 [发版说明](https://example.com/notes)');
    const bubble = container.querySelector('.bubble--me') as HTMLElement;
    const link = bubble.querySelector('a') as HTMLAnchorElement;

    expect(link.classList.contains('filecard')).toBe(false);
    expect(link.textContent).toBe('发版说明');
  });

  it('附件卡片也是 <a>，但带 .filecard —— 反相规则用 :not(.filecard) 把它排除掉', () => {
    const { container } = view('[发版清单.pdf](/uploads/9f3a.bin)');
    const bubble = container.querySelector('.bubble--me') as HTMLElement;
    const links = Array.from(bubble.querySelectorAll('a'));

    expect(links).toHaveLength(1);
    expect(links[0]).toHaveClass('filecard');
  });

  it('引用块、@提及、视频的挂靠点也都在自己气泡里', () => {
    const quote = view('> 引用一句').container;
    expect(quote.querySelector('.bubble--me blockquote')).not.toBeNull();

    const mention = view('@林悦 看一下').container;
    expect(mention.querySelector('.bubble--me .mention')).not.toBeNull();

    const video = view('![片段.mp4](/uploads/9f3a.mp4)').container;
    expect(video.querySelector('.bubble--me .mdvideo')).not.toBeNull();
  });
});

describe('这套 Markdown 到底会渲染出哪些元素（决定了「哪些需要反相」这张表）', () => {
  it('列表 / 标题 / 粗斜体只继承气泡的文字色，本身不带自己的底色或字色', () => {
    const { container } = view('# 标题\n- 一\n- 二\n1. 甲\n**粗** *斜*');
    const bubble = container.querySelector('.bubble--me') as HTMLElement;

    expect(bubble.querySelector('h1')).not.toBeNull();
    expect(bubble.querySelectorAll('ul li')).toHaveLength(2);
    expect(bubble.querySelectorAll('ol li')).toHaveLength(1);
    expect(bubble.querySelector('strong')).not.toBeNull();
    expect(bubble.querySelector('em')).not.toBeNull();
  });

  it('渲染器根本不产出 <hr> 和 <table>，所以这两样不用做反相', () => {
    const { container } = view('---\n\n| a | b |\n| - | - |\n| 1 | 2 |');
    const bubble = container.querySelector('.bubble--me') as HTMLElement;

    expect(bubble.querySelector('hr')).toBeNull();
    expect(bubble.querySelector('table')).toBeNull();
  });
});

/*
 * 只能靠真浏览器看的部分：
 *   1. 浅色 / 深色两个主题下叠出来的实际观感（jsdom 不载样式表，也不算层叠）；
 *   2. 代码块与气泡之间 1.47 的明度差，在真机上够不够「看出这是一块」；
 *   3. 长代码横向滚动时暗块的边缘表现。
 * 选定的值与实测对比度写在 styles.css 对应那几条规则的注释里。
 */
