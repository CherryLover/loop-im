import { useEffect, useMemo, useRef } from 'react';
import type { MouseEvent } from 'react';
import { renderMarkdown } from '../lib/md';

interface MarkdownBodyProps {
  /** 消息正文（Markdown 源码）。 */
  body: string;
  /** 气泡本身的 class，原样透传。 */
  className: string;
  /**
   * 点了缩略图：把要看的原图交出去。不传就不给放大入口
   * （缩略图仍然渲染，只是点不动）。
   */
  onOpenImage?: (src: string, alt: string) => void;
}

/**
 * 一条消息的正文。
 *
 * renderMarkdown 的产物是**一次性的 HTML 字符串**，而图片的「加载中 / 加载失败」是
 * 运行时状态，字符串里装不下。这里把两者接起来：HTML 照旧 innerHTML 进去（md.ts 那套
 * 「先转义、再套规则、属性值走占位槽」的顺序一个字都不用动），加载状态则在 effect 里
 * 用 addEventListener 挂到已经渲染出来的 <img> 上，只改宿主 <button> 的 data-state，
 * 蒙版和失败文案由 CSS 按这个属性画。
 *
 * 另一条路是把图片渲染成真正的 React 组件（把 Markdown 解析成节点树再渲染）。
 * 没走那条：那等于把 md.ts 从「产出 HTML 字符串」改成「产出 AST」，它现在这套
 * 占位槽 + 分块的实现和 55 条测试全都是按字符串写的，为了两个状态位重写整个渲染器，
 * 风险远大于收益。而这条路把「用户输入」和「运行时状态」彻底分开了：
 * 用户输入只经过 md.ts 的转义管线，状态只由这里的 JS 写，
 * HTML 产物里一个 on* 属性都没有，也就没有多出任何注入面。
 */
export function MarkdownBody({ body, className, onOpenImage }: MarkdownBodyProps) {
  const ref = useRef<HTMLDivElement>(null);
  /**
   * 连**这个对象本身**都要缓住，不能只缓里面的字符串。
   *
   * React 更新 dangerouslySetInnerHTML 时先比对的是 prop 的引用：每次渲染都递一个新的
   * `{ __html }` 字面量进去，它就会认为「变了」，把 innerHTML 整个重写一遍。
   * 后果不是慢一点而已 —— 重写会把已经渲染好的 <img> 换成全新的节点，
   * 下面那个 effect 的依赖是 html 字符串（没变），不会重跑，新节点上一个监听都没有，
   * 那张图就永远停在灰蒙版上了。而 MessageList 每来一条新消息、每敲一下「对方正在输入」
   * 都会重渲染，等于聊得越热闹图越容易卡住。引用缓住之后 React 直接跳过这个 prop。
   */
  const inner = useMemo(() => ({ __html: renderMarkdown(body) }), [body]);
  const html = inner.__html;

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const off: Array<() => void> = [];

    for (const img of root.querySelectorAll<HTMLImageElement>('img.mdimg__img')) {
      const box = img.closest<HTMLButtonElement>('button.mdimg');
      if (!box) continue;

      const settle = (state: 'ready' | 'error') => {
        box.setAttribute('data-state', state);
        // 加载失败的那张没有原图可看，别留一个按下去什么都不发生的按钮，
        // 顺手也把它移出 Tab 序列。
        if (state === 'error') box.disabled = true;
      };

      // 图片可能在 effect 跑到之前就已经好了（浏览器缓存、或者本地 blob 基本是同步的），
      // 那一次 load 事件早就过去了，再挂监听也等不到。complete 就是补这一次判定用的：
      // src 非空且 complete 时，naturalWidth 是 0 就说明它是「加载完了，但失败了」。
      // 少了这一段，缓存命中的图会永远停在灰蒙版上。
      if (img.getAttribute('src') && img.complete) {
        settle(img.naturalWidth > 0 ? 'ready' : 'error');
        continue;
      }

      const onLoad = () => settle('ready');
      const onError = () => settle('error');
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
      off.push(() => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
      });
    }

    return () => { for (const f of off) f(); };
  }, [html]);

  /**
   * 点缩略图开大图。用事件委托而不是给每张图挂 onclick：这些节点是 innerHTML 进来的，
   * React 管不到它们，但合成事件照样能从它们冒泡到这个 div 上。
   */
  function onClick(e: MouseEvent<HTMLDivElement>) {
    if (!onOpenImage) return;
    const target = e.target as HTMLElement | null;
    const box = target?.closest?.('button.mdimg');
    const img = box?.querySelector('img.mdimg__img');
    if (!img || box?.getAttribute('data-state') === 'error') return;
    onOpenImage(img.getAttribute('src') || '', img.getAttribute('alt') || '');
  }

  return (
    <div
      ref={ref}
      className={className}
      onClick={onClick}
      dangerouslySetInnerHTML={inner}
    />
  );
}
