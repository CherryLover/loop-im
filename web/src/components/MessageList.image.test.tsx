/**
 * 聊天里的图片：1:1 缩略图 / 加载状态 / 点开看原图。
 *
 * ## 关于「加载完成后蒙版消失」怎么测
 *
 * jsdom 不联网，<img> 永远不会真的去下载，load 事件也就永远不会自然触发。
 * 所以这里测的是**状态机**，不是像素：
 *
 *   1. 先确认渲染完那一刻 data-state 是 loading（蒙版由 CSS 按这个属性画）；
 *   2. 手动 `img.dispatchEvent(new Event('load'))` —— 这就是浏览器加载完时会做的
 *      那一件事，组件挂的是同一个 addEventListener('load')，走的是同一条代码路径；
 *   3. 再断言 data-state 变成了 ready，loading 这个值没了。
 *
 * **哪一部分没被真实浏览器覆盖**，如实记在这里：
 *   - 「data-state=loading 时那层灰蒙版真的盖住了图、ready 之后真的不见了」——
 *     这是纯 CSS（`[data-state="loading"]::before`），jsdom 不做布局也不算层叠，
 *     测不到。CSS 选择器写错、蒙版没盖住、z 序不对，这里全都是绿的。
 *   - 「浏览器到底会不会发 load / error」本身。这里是我们自己 dispatch 的，
 *     等于假定了浏览器行为；真实的 404、超时、CORS 失败没有被覆盖。
 *   - `img.complete` 那条快路径（图已在缓存里、effect 跑到时事件早就过去了）。
 *     jsdom 里 complete 恒为 false（已实测），所以这条分支在这里根本走不到，
 *     只有真实浏览器的缓存命中才会走。这是本次改动里覆盖最薄的一处。
 *   - 缩略图的实际尺寸和 object-fit 裁切效果。
 *   以上都要靠真机/真浏览器过一眼，自动化测试给不了。
 *
 * ## 全页蒙版这一档，jsdom 能测到哪、测不到哪
 *
 * 能测的是**结构**：`createPortal` 到底有没有把这一层挂到 `document.body` 下面
 * （断言节点的 parentElement 就是 body、且不在渲染容器里）、关掉之后 body 上还留不留
 * 残骸、背景滚动锁上没上又解没解、焦点去哪了。这些都是 DOM 事实，jsdom 说了算。
 *
 * **测不了的是「它真的盖住了整页」**：jsdom 不做布局、不算层叠上下文，
 * `position: fixed`、`inset: 0`、`z-index: 25` 在这里全是没人读的字符串。
 * 换句话说，就算 CSS 写错、蒙版只盖住半屏、或者被侧栏压在下面，这个文件照样全绿。
 * portal 挂对了只是「有可能盖住整页」的**必要**条件，不是充分条件 ——
 * 那一半必须在真实浏览器里看。
 *
 * 触摸滑动同理：这里只能派发 touchstart / touchmove / touchend 测判定逻辑，
 * 真手势（惯性、滚动抢手势、iOS 边缘返回）一条都没覆盖。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageList } from './MessageList';
import { clearToken, setToken } from '../lib/api';
import { clearPreviewCache, rememberPreview } from '../lib/upload-cache';
import type { Message } from '../lib/types';

afterEach(() => {
  clearToken();
  clearPreviewCache();
});

const message = (body: string, over: Partial<Message> = {}): Message => ({
  id: 'm_1',
  conversationId: 'c1',
  senderId: 'u_chen',
  senderName: '陈子航',
  senderAvatarUrl: null,
  body,
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: false,
  ...over,
});

const rest = {
  meId: 'u_lin',
  showSenderName: true,
  aiProviderLabel: '模拟供应商',
  typing: false,
} as const;

const view = (body: string, over: Partial<Message> = {}) =>
  render(<MessageList messages={[message(body, over)]} {...rest} />);

/** 四张图，分散在三条消息里 —— 画廊要跨消息收，不能只收被点那一条。 */
const gallery = () =>
  render(
    <MessageList
      messages={[
        message('![一](/uploads/a.png)\n\n![二](/uploads/b.png)', { id: 'm_1' }),
        message('中间插一句话', { id: 'm_2' }),
        message('![三](/uploads/c.png)', { id: 'm_3', senderId: 'u_lin' }),
        message('![四](/uploads/d.png)', { id: 'm_4' }),
      ]}
      {...rest}
    />,
  );

const imageOf = (container: HTMLElement) =>
  container.querySelector('img.mdimg__img') as HTMLImageElement;
const boxOf = (container: HTMLElement) =>
  container.querySelector('button.mdimg') as HTMLButtonElement;

/**
 * 蒙版一律从 document.body 上找，不从渲染容器里找 —— 这本身就是这次改动的要点：
 * 它已经不在消息列表那棵子树里了。
 */
const layer = () => document.body.querySelector('.imgview');
const bigImage = () => document.body.querySelector('img.imgview__img') as HTMLImageElement | null;
const countText = () => document.body.querySelector('.imgview__count')?.textContent;

describe('图片缩略图', () => {
  it('图片包在一个可聚焦的按钮里，不再是一个裸 img', () => {
    const { container } = view('![发版流程](/uploads/9f3a.png)');
    const box = boxOf(container);
    expect(box).not.toBeNull();
    expect(box.tagName).toBe('BUTTON');
    // type=button：万一将来这段 HTML 落进某个 form 里，别变成提交按钮。
    expect(box.getAttribute('type')).toBe('button');
    expect(box).toHaveAccessibleName('查看大图：发版流程');
    expect(imageOf(container).getAttribute('src')).toBe('/uploads/9f3a.png');
  });

  it('缩略图不再挂在旧的 .md img 那档宽度上', () => {
    // 1:1 靠 CSS 的 `.md .mdimg__img { object-fit: cover }` 加宿主的等宽高实现，
    // jsdom 量不出来。能在这里钉住的是「类名对得上」——CSS 挂钩没被改掉。
    const { container } = view('![图](/uploads/9f3a.png)');
    expect(imageOf(container).className).toBe('mdimg__img');
  });

  it('一屏外的图不占带宽', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    expect(imageOf(container).getAttribute('loading')).toBe('lazy');
  });
});

describe('图片的加载状态', () => {
  it('刚渲染出来是 loading（灰蒙版这一档）', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    expect(boxOf(container).getAttribute('data-state')).toBe('loading');
  });

  it('load 之后变成 ready，蒙版那一档的状态没了', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    const box = boxOf(container);
    expect(box.getAttribute('data-state')).toBe('loading');
    fireEvent.load(imageOf(container));
    expect(box.getAttribute('data-state')).toBe('ready');
    expect(box.getAttribute('data-state')).not.toBe('loading');
  });

  it('error 之后变成 error，而不是永远停在灰块上', () => {
    const { container } = view('![图](/uploads/broken.png)');
    const box = boxOf(container);
    fireEvent.error(imageOf(container));
    expect(box.getAttribute('data-state')).toBe('error');
    // 没有原图可看，按钮同时被禁掉，不留一个按下去没反应的东西。
    expect(box.disabled).toBe(true);
  });

  it('同一条消息里的多张图各算各的', () => {
    const { container } = view('![一](/uploads/a.png)\n\n![二](/uploads/b.png)');
    const boxes = container.querySelectorAll('button.mdimg');
    const imgs = container.querySelectorAll('img.mdimg__img');
    expect(boxes.length).toBe(2);
    fireEvent.load(imgs[0]);
    fireEvent.error(imgs[1]);
    expect(boxes[0].getAttribute('data-state')).toBe('ready');
    expect(boxes[1].getAttribute('data-state')).toBe('error');
  });

  it('正文变了之后，新渲染出来的图重新从 loading 开始', () => {
    // 重渲染会换掉 innerHTML，effect 得跟着重新挂监听；漏了的话新图就永远是灰的。
    const { container, rerender } = view('![一](/uploads/a.png)');
    fireEvent.load(imageOf(container));
    expect(boxOf(container).getAttribute('data-state')).toBe('ready');

    rerender(
      <MessageList
        messages={[message('![二](/uploads/b.png)')]}
        meId="u_lin"
        showSenderName
        aiProviderLabel="模拟供应商"
        typing={false}
      />,
    );
    expect(imageOf(container).getAttribute('src')).toBe('/uploads/b.png');
    expect(boxOf(container).getAttribute('data-state')).toBe('loading');
    fireEvent.load(imageOf(container));
    expect(boxOf(container).getAttribute('data-state')).toBe('ready');
  });

  it('别的消息进来重渲染时，已经加载好的图不会被打回灰蒙版', () => {
    /**
     * 回归钉子。开发过程中真踩到过：dangerouslySetInnerHTML 每次都递一个新的
     * `{ __html }` 字面量，React 认为 prop 变了就把 innerHTML 整个重写，
     * <img> 被换成全新的节点、监听全丢，而 effect 的依赖（html 字符串）没变不会重跑。
     * 结果是每来一条新消息，屏幕上已经看得好好的图全都退回灰块，而且再也不恢复。
     */
    const first = message('![图](/uploads/a.png)');
    const rest = {
      meId: 'u_lin', showSenderName: true, aiProviderLabel: '模拟供应商', typing: false,
    } as const;
    const { container, rerender } = render(<MessageList messages={[first]} {...rest} />);

    const imgBefore = imageOf(container);
    fireEvent.load(imgBefore);
    expect(boxOf(container).getAttribute('data-state')).toBe('ready');

    // 又来了一条消息（外加「对方正在输入」，这两件事在真实聊天里几乎不停地发生）
    rerender(
      <MessageList
        messages={[first, message('后来的一条', { id: 'm_2' })]}
        {...rest}
        typing
      />,
    );

    // 同一个 DOM 节点还在（没被 innerHTML 重写掉），状态也还是 ready
    expect(container.querySelectorAll('img.mdimg__img')[0]).toBe(imgBefore);
    expect(imgBefore.isConnected).toBe(true);
    expect(boxOf(container).getAttribute('data-state')).toBe('ready');
  });

  it('自己发的那条（bubble--me）走的是同一套', () => {
    const { container } = view('![图](/uploads/a.png)', { senderId: 'u_lin' });
    expect(container.querySelector('.bubble--me button.mdimg')).not.toBeNull();
    fireEvent.load(imageOf(container));
    expect(boxOf(container).getAttribute('data-state')).toBe('ready');
  });
});

describe('点开看原图：盖住整页的蒙版', () => {
  it('蒙版挂在 document.body 下，不再长在消息列表里', () => {
    /**
     * 这次改动的核心回归钉。之前 ImageViewer 直接渲染在 MessageList 的子树里，
     * 也就是长在 .chat__scroll 内部 —— 于是它受会话区的 overflow 和层叠上下文管，
     * 盖不住整页（用户说的「在会话层级处理」）。改成 createPortal 到 body 之后，
     * 它必须**不在** container 里，而在 body 的直接子节点里。
     */
    const { container } = view('![发版流程](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));

    const l = layer();
    expect(l).not.toBeNull();
    // 不在渲染容器（也就是消息列表那棵子树）里
    expect(container.querySelector('.imgview')).toBeNull();
    expect(container.contains(l)).toBe(false);
    // 是 body 的直接子节点（testing-library 的容器也是 body 的子节点，两者是兄弟）
    expect(l?.parentElement).toBe(document.body);
  });

  it('还是那一层对话框，放的是同一个地址', () => {
    const { container } = view('![发版流程](/uploads/9f3a.png)');
    expect(layer()).toBeNull();

    fireEvent.click(imageOf(container));

    const l = layer();
    expect(l?.getAttribute('role')).toBe('dialog');
    expect(l?.getAttribute('aria-modal')).toBe('true');
    const big = bigImage();
    expect(big?.getAttribute('src')).toBe('/uploads/9f3a.png');
    expect(big?.getAttribute('alt')).toBe('发版流程');
    // 「大图完整显示、不像缩略图那样裁切」是 CSS 的 object-fit: contain，jsdom 量不出来。
    // 这里只钉住 CSS 挂钩还在：类名对不上的话那条规则就落空了。
    expect(big?.className).toBe('imgview__img');
  });

  it('Esc 关掉', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    expect(layer()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(layer()).toBeNull();
  });

  it('点背景关掉，点图片本身不关', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));

    // 点在图上：想把图挪进视野里看细节，不该误关。
    fireEvent.mouseDown(bigImage() as HTMLElement);
    expect(layer()).not.toBeNull();

    fireEvent.mouseDown(layer() as HTMLElement);
    expect(layer()).toBeNull();
  });

  it('关闭按钮能点，而且一打开焦点就在它上面', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    const close = screen.getByRole('button', { name: '关闭图片预览' });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(layer()).toBeNull();
  });

  it('加载失败的那张点不开（打开也只是另一张坏图）', () => {
    const { container } = view('![图](/uploads/broken.png)');
    fireEvent.error(imageOf(container));
    fireEvent.click(imageOf(container));
    expect(layer()).toBeNull();
  });

  it('点气泡里别的东西不会误开预览', () => {
    const { container } = view('普通文字 **加粗** 和 [文档](https://loop.dev/doc)');
    fireEvent.click(container.querySelector('.bubble') as HTMLElement);
    expect(layer()).toBeNull();
  });
});

describe('蒙版的焦点与背景滚动', () => {
  it('关掉之后焦点还给那张缩略图，Tab 不会从头来过', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    const box = boxOf(container);
    box.focus();
    fireEvent.click(box);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).toBe(box);
  });

  it('只有一张图时，Tab 出不去这一层（在下载和关闭两个按钮之间打转）', () => {
    // 两个箭头这时候压根没渲染，焦点陷阱查的是 button:not([disabled])，
    // 循环里只剩下载和关闭两个，Tab 在它们之间转圈，出不去这一层。
    const { container } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    const close = screen.getByRole('button', { name: '关闭图片预览' });
    const download = screen.getByRole('button', { name: '下载图片' });
    close.blur();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(download);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(download);
  });

  it('多张图时 Tab 在这一层里循环，不会跑到背后的消息列表上', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[1]);
    const l = layer() as HTMLElement;
    const seen: (Element | null)[] = [];
    for (let i = 0; i < 4; i += 1) {
      fireEvent.keyDown(window, { key: 'Tab' });
      seen.push(document.activeElement);
    }
    // 每一跳都还落在这一层里面
    for (const el of seen) expect(l.contains(el)).toBe(true);
    // 而且真的在循环（不是死死卡在同一个按钮上）
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  it('Shift+Tab 反着走，同样出不去', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[1]);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect((layer() as HTMLElement).contains(document.activeElement)).toBe(true);
  });

  it('打开时锁住背景滚动，关掉后原样还回去', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    expect(document.body.style.overflow).toBe('');
    fireEvent.click(imageOf(container));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('');
  });

  it('还回去的是原来那个值，不是无脑清空', () => {
    document.body.style.overflow = 'clip';
    const { container } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('clip');
    document.body.style.overflow = '';
  });

  it('整棵树被卸载（退出登录那种）时，滚动锁一样会解开', () => {
    /**
     * 这条比「关掉预览」更要紧：预览开着的时候点退出登录，组件是被直接卸载掉的，
     * 没人会去调 onClose。解锁写在 effect 的 cleanup 里就是为了兜住这一档 ——
     * 漏了的话退出登录之后整页都滚不动，而且完全看不出是谁干的。
     */
    const { container, unmount } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('关掉之后 body 上不留残骸，卸载也不留', () => {
    const { container, unmount } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    expect(document.body.querySelectorAll('.imgview').length).toBe(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.body.querySelectorAll('.imgview').length).toBe(0);

    fireEvent.click(imageOf(container));
    unmount();
    expect(document.body.querySelectorAll('.imgview').length).toBe(0);
  });

  it('开过又关、再开一次，不会叠出两层', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(imageOf(container));
    expect(document.body.querySelectorAll('.imgview').length).toBe(1);
  });
});

describe('画廊：翻看会话里的图片', () => {
  it('收的是整条会话的图，不只是被点那条消息里的', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);
    expect(countText()).toBe('第 1 / 4 张');
  });

  it('落点是被点的那一张，不是永远从第一张开始', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[2]);
    expect(countText()).toBe('第 3 / 4 张');
    expect(bigImage()?.getAttribute('src')).toBe('/uploads/c.png');
  });

  it('同一张图发了两次，点第二次开的就是第二张（按节点认，不按 src 认）', () => {
    // 按 src 找的话两次都会命中第一张，翻页起点就错了。
    const { container } = render(
      <MessageList
        messages={[
          message('![同一张](/uploads/dup.png)', { id: 'm_1' }),
          message('中间隔一句', { id: 'm_2' }),
          message('![同一张](/uploads/dup.png)', { id: 'm_3' }),
        ]}
        {...rest}
      />,
    );
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[1]);
    expect(countText()).toBe('第 2 / 2 张');
  });

  it('按钮能往后翻，也能往前翻', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);

    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    expect(countText()).toBe('第 2 / 4 张');
    expect(bigImage()?.getAttribute('src')).toBe('/uploads/b.png');

    fireEvent.click(screen.getByRole('button', { name: '上一张' }));
    expect(countText()).toBe('第 1 / 4 张');
    expect(bigImage()?.getAttribute('src')).toBe('/uploads/a.png');
  });

  it('键盘左右方向键也能翻', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(countText()).toBe('第 2 / 4 张');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(countText()).toBe('第 3 / 4 张');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(countText()).toBe('第 2 / 4 张');
  });

  it('到头了就到头了，不循环——两端的箭头分别灰掉', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);

    const prev = () => screen.getByRole('button', { name: '上一张' }) as HTMLButtonElement;
    const next = () => screen.getByRole('button', { name: '下一张' }) as HTMLButtonElement;

    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(false);
    // 在第一张上再往前：既不动，也不绕到最后一张
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(countText()).toBe('第 1 / 4 张');

    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(countText()).toBe('第 4 / 4 张');
    expect(next().disabled).toBe(true);
    expect(prev().disabled).toBe(false);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(countText()).toBe('第 4 / 4 张');
  });

  it('只有一张图时不出箭头，指示器照样说清楚「就这一张」', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    expect(screen.queryByRole('button', { name: '上一张' })).toBeNull();
    expect(screen.queryByRole('button', { name: '下一张' })).toBeNull();
    expect(countText()).toBe('第 1 / 1 张');
  });

  it('翻页时对话框的可及名字跟着换，读屏不会一直念第一张的说明', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);
    expect(layer()?.getAttribute('aria-label')).toBe('图片预览：一');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(layer()?.getAttribute('aria-label')).toBe('图片预览：二');
  });

  it('加载失败的图不进画廊，也不算进「共几张」', () => {
    const { container } = gallery();
    const imgs = container.querySelectorAll('img.mdimg__img');
    fireEvent.error(imgs[1]);                       // b.png 坏了
    fireEvent.click(imgs[0]);
    expect(countText()).toBe('第 1 / 3 张');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(bigImage()?.getAttribute('src')).toBe('/uploads/c.png');
  });
});

describe('画廊里的「全部」到底是哪些', () => {
  it('还有更早的消息没加载出来时，明说这个数只算已加载的', () => {
    const { container } = render(
      <MessageList
        messages={[message('![一](/uploads/a.png)')]}
        {...rest}
        hasOlder
        onLoadOlder={() => {}}
      />,
    );
    fireEvent.click(imageOf(container));
    expect(countText()).toBe('第 1 / 1 张');
    expect(
      screen.getByText('只包含已加载的消息；更早的图片要先在聊天里往上翻加载出来'),
    ).not.toBeNull();
  });

  it('已经翻到底、没有更早的消息了，就不说那句话（免得平白让人心虚）', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);
    expect(layer()?.querySelector('.imgview__hint')).toBeNull();
  });
});

describe('画廊里的地址：blob: 和带 token 的都要能用', () => {
  it('自己刚发的那张走本地 blob:，画廊里原样带着', () => {
    // 发送端的本地预览：md.ts 的 displaySrc 会把服务端 URL 换成内存里的 blob URL。
    // 画廊是从**已经渲染出来的 DOM** 上收 src 的，所以这一步是白拿的 ——
    // 换成自己解析 body，就得把 displaySrc 这条规则再实现一遍。
    rememberPreview('/uploads/a.png', 'blob:loop/local-copy');
    const { container } = render(
      <MessageList
        messages={[message('![一](/uploads/a.png)\n\n![二](/uploads/b.png)')]}
        {...rest}
      />,
    );
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);
    expect(bigImage()?.getAttribute('src')).toBe('blob:loop/local-copy');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(bigImage()?.getAttribute('src')).toBe('/uploads/b.png');
  });

  it('别人发的那张带着 ?token=，画廊里一个字都不能少（少了就 401）', () => {
    setToken('tok-abc');
    const { container } = render(
      <MessageList
        messages={[message('![一](/uploads/a.png)\n\n![二](/uploads/b.png)')]}
        {...rest}
      />,
    );
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[1]);
    expect(bigImage()?.getAttribute('src')).toBe('/uploads/b.png?token=tok-abc');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(bigImage()?.getAttribute('src')).toBe('/uploads/a.png?token=tok-abc');
  });
});

describe('大图自己的加载状态', () => {
  it('刚打开是 loading，有话说出来，不是一片纯黑', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    expect(bigImage()?.getAttribute('data-state')).toBe('loading');
    expect(screen.getByRole('status').textContent).toBe('加载中…');
  });

  it('load 之后变 ready，提示收起来', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    fireEvent.load(bigImage() as HTMLElement);
    expect(bigImage()?.getAttribute('data-state')).toBe('ready');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('load 失败说清楚是失败了', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    fireEvent.error(bigImage() as HTMLElement);
    expect(bigImage()?.getAttribute('data-state')).toBe('error');
    expect(screen.getByRole('status').textContent).toBe('图片加载失败');
  });

  it('翻到下一张时重新从 loading 开始，不吃上一张的 ready', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);
    fireEvent.load(bigImage() as HTMLElement);
    expect(bigImage()?.getAttribute('data-state')).toBe('ready');

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(bigImage()?.getAttribute('src')).toBe('/uploads/b.png');
    expect(bigImage()?.getAttribute('data-state')).toBe('loading');
    fireEvent.load(bigImage() as HTMLElement);
    expect(bigImage()?.getAttribute('data-state')).toBe('ready');
  });
});

describe('触摸左右滑', () => {
  /**
   * jsdom 里没有真手势，只能派发 touchstart / touchmove / touchend 三个事件来测
   * **判定逻辑**（阈值、方向、单指还是多指）。真实的滚动抢手势、惯性、
   * iOS 上的边缘返回手势，一律没有覆盖 —— 那几样只能在真机上过。
   */
  const at = (x: number, y: number) => ({ clientX: x, clientY: y });
  const swipe = (fromX: number, toX: number, fromY = 0, toY = 0) => {
    const l = layer() as HTMLElement;
    fireEvent.touchStart(l, { touches: [at(fromX, fromY)] });
    fireEvent.touchMove(l, { touches: [at(toX, toY)] });
    fireEvent.touchEnd(l, { changedTouches: [at(toX, toY)], touches: [] });
  };

  it('往左划看下一张', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);
    swipe(300, 120);
    expect(countText()).toBe('第 2 / 4 张');
  });

  it('往右划看上一张', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[2]);
    swipe(120, 300);
    expect(countText()).toBe('第 2 / 4 张');
  });

  it('划得太短当手抖，不翻页', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);
    swipe(300, 270);     // 30px，不到阈值
    expect(countText()).toBe('第 1 / 4 张');
  });

  it('主要是竖着划的不算翻页', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);
    swipe(300, 240, 0, 400);   // 横 60、竖 400
    expect(countText()).toBe('第 1 / 4 张');
  });

  it('两根手指（捏合看细节）中途作废，不翻页', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);
    const l = layer() as HTMLElement;
    fireEvent.touchStart(l, { touches: [at(300, 0)] });
    fireEvent.touchMove(l, { touches: [at(200, 0), at(400, 0)] });
    fireEvent.touchEnd(l, { changedTouches: [at(120, 0)], touches: [] });
    expect(countText()).toBe('第 1 / 4 张');
  });

  it('划到头了不循环', () => {
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);
    swipe(120, 300);                       // 在第一张上往右划
    expect(countText()).toBe('第 1 / 4 张');
  });

  it('划完之后浏览器补的那一发 mousedown 不会把整层关掉', () => {
    /**
     * 移动端在 touchend 之后可能补发一套模拟鼠标事件。落在背景上就会被
     * 「点背景关闭」接住 —— 手一划整层没了，这是最容易漏的一个坑。
     */
    const { container } = gallery();
    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);
    swipe(300, 120);
    fireEvent.mouseDown(layer() as HTMLElement);
    expect(layer()).not.toBeNull();
    expect(countText()).toBe('第 2 / 4 张');

    // 但这只吃掉紧跟着的那一发；之后正常点背景照样能关。
    fireEvent.mouseDown(layer() as HTMLElement);
    expect(layer()).toBeNull();
  });
});

describe('视频不进画廊', () => {
  it('视频照旧是 mdvideo，尺寸由 CSS 收口，没被改成缩略图按钮', () => {
    // 视频不做 1:1 裁切 —— 切掉的是画面内容，不是留白。
    // 所以这里钉的是「它还是个原生 <video>，没被卷进 .mdimg 那一套」。
    const { container } = view('![片子](/uploads/9f3a.mp4)');
    const video = container.querySelector('video.mdvideo');
    expect(video).not.toBeNull();
    expect(container.querySelector('button.mdimg')).toBeNull();
    expect(video?.getAttribute('preload')).toBe('metadata');
  });

  it('会话里夹着视频时，「共几张」只数图片，翻页也跳过视频', () => {
    /**
     * 决定：**视频不进画廊**。三条理由：
     *   1. <video> 自带播放控件。横划在播放器上是拖进度条、左右方向键是快进快退，
     *      和画廊的「左右翻页」是同一组手势，塞在一起必然打架；
     *   2. 视频现在压根没有「点开看大图」这个入口（md.ts 直出内联播放器，
     *      不是可点的缩略图按钮）。把它算进 indicator，等于让「共 n 张」
     *      比用户能点开的东西还多，指示器立刻就不诚实了；
     *   3. 视频是 preload=metadata 的流，翻页时预载/卸载的代价和图片不是一个量级。
     *
     * 实现上是白拿的：画廊从 `.mdimg__img` 收，而 md.ts 把视频渲染成 <video>，
     * 天然就不在这个选择器里 —— 一行排除逻辑都不用写。
     */
    const { container } = render(
      <MessageList
        messages={[
          message('![一](/uploads/a.png)', { id: 'm_1' }),
          message('![片子](/uploads/v.mp4)', { id: 'm_2' }),
          message('![二](/uploads/b.png)', { id: 'm_3' }),
        ]}
        {...rest}
      />,
    );
    expect(container.querySelectorAll('video.mdvideo').length).toBe(1);

    fireEvent.click(container.querySelectorAll('img.mdimg__img')[0]);
    expect(countText()).toBe('第 1 / 2 张');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(countText()).toBe('第 2 / 2 张');
    expect(bigImage()?.getAttribute('src')).toBe('/uploads/b.png');
    // 翻到底了：视频没有偷偷排在后面
    expect((screen.getByRole('button', { name: '下一张' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
