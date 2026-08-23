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
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageList } from './MessageList';
import type { Message } from '../lib/types';

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

const view = (body: string, over: Partial<Message> = {}) =>
  render(
    <MessageList
      messages={[message(body, over)]}
      meId="u_lin"
      showSenderName
      aiProviderLabel="模拟供应商"
      typing={false}
    />,
  );

const imageOf = (container: HTMLElement) =>
  container.querySelector('img.mdimg__img') as HTMLImageElement;
const boxOf = (container: HTMLElement) =>
  container.querySelector('button.mdimg') as HTMLButtonElement;

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

describe('点开看原图', () => {
  it('点缩略图开出一层预览，放的是同一个地址', () => {
    const { container } = view('![发版流程](/uploads/9f3a.png)');
    expect(container.querySelector('.imgview')).toBeNull();

    fireEvent.click(imageOf(container));

    const view0 = container.querySelector('.imgview') as HTMLElement;
    expect(view0).not.toBeNull();
    expect(view0.getAttribute('role')).toBe('dialog');
    expect(view0.getAttribute('aria-modal')).toBe('true');
    const big = view0.querySelector('img') as HTMLImageElement;
    expect(big.getAttribute('src')).toBe('/uploads/9f3a.png');
    expect(big.getAttribute('alt')).toBe('发版流程');
  });

  it('Esc 关掉', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    expect(container.querySelector('.imgview')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('.imgview')).toBeNull();
  });

  it('点背景关掉，点图片本身不关', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    const layer = container.querySelector('.imgview') as HTMLElement;

    // 点在图上：想把图挪进视野里看细节，不该误关。
    fireEvent.mouseDown(layer.querySelector('img') as HTMLElement);
    expect(container.querySelector('.imgview')).not.toBeNull();

    fireEvent.mouseDown(layer);
    expect(container.querySelector('.imgview')).toBeNull();
  });

  it('关闭按钮能点，而且一打开焦点就在它上面', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    const close = screen.getByRole('button', { name: '关闭图片预览' });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(container.querySelector('.imgview')).toBeNull();
  });

  it('关掉之后焦点还给那张缩略图，Tab 不会从头来过', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    const box = boxOf(container);
    box.focus();
    fireEvent.click(box);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).toBe(box);
  });

  it('Tab 出不去这一层（只有关闭按钮一个可聚焦的东西）', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    fireEvent.click(imageOf(container));
    const close = screen.getByRole('button', { name: '关闭图片预览' });
    close.blur();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
  });

  it('键盘可达：缩略图能 Tab 到，回车就能打开', () => {
    const { container } = view('![图](/uploads/9f3a.png)');
    const box = boxOf(container);
    // 原生 button，没有 tabindex=-1 之类的东西把它踢出 Tab 序列。
    expect(box.getAttribute('tabindex')).toBeNull();
    box.focus();
    expect(document.activeElement).toBe(box);
    // 回车在原生 button 上会被浏览器翻译成一次 click；这里直接测那一次 click。
    fireEvent.click(box);
    expect(container.querySelector('.imgview')).not.toBeNull();
  });

  it('加载失败的那张点不开（打开也只是另一张坏图）', () => {
    const { container } = view('![图](/uploads/broken.png)');
    fireEvent.error(imageOf(container));
    fireEvent.click(imageOf(container));
    expect(container.querySelector('.imgview')).toBeNull();
  });

  it('点气泡里别的东西不会误开预览', () => {
    const { container } = view('普通文字 **加粗** 和 [文档](https://loop.dev/doc)');
    fireEvent.click(container.querySelector('.bubble') as HTMLElement);
    expect(container.querySelector('.imgview')).toBeNull();
  });
});

describe('视频不撑满气泡', () => {
  it('视频照旧是 mdvideo，尺寸由 CSS 收口，没被改成缩略图按钮', () => {
    // 视频不做 1:1 裁切 —— 切掉的是画面内容，不是留白。
    // 所以这里钉的是「它还是个原生 <video>，没被卷进 .mdimg 那一套」。
    const { container } = view('![片子](/uploads/9f3a.mp4)');
    const video = container.querySelector('video.mdvideo');
    expect(video).not.toBeNull();
    expect(container.querySelector('button.mdimg')).toBeNull();
    expect(video?.getAttribute('preload')).toBe('metadata');
  });
});
