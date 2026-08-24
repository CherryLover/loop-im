import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, TouchEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

/** 画廊里的一张。src 已经是渲染层最终用的那个地址（可能是 blob:，也可能带 ?token=）。 */
export interface GalleryImage {
  src: string;
  alt: string;
}

interface ImageViewerProps {
  /** 当前会话**已加载出来**的全部可预览图片，按消息先后排好。 */
  images: GalleryImage[];
  /** 现在看的是第几张（从 0 起）。受控——由调用方持有，翻页也走 onIndex。 */
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
  /**
   * 会话里还有更早的消息没被翻页加载出来。
   *
   * 只要它是 true，`images` 就**不是**这个会话的全部图片，只是已加载那一段里的全部。
   * 界面上必须说出这件事，否则用户翻到第 1 张、看到「上一张」灰掉，
   * 会以为已经到头了 —— 而其实往上翻聊天记录还能刷出更早的图。
   */
  hasOlder?: boolean;
}

/** 手指横向走多少像素才算一次「翻页」，而不是手抖。 */
const SWIPE_PX = 44;
/**
 * 横向位移至少要是纵向的这么多倍才算横划。
 * 不加这一条的话，顺着页面竖着一划、手指稍微斜一点就会翻页。
 */
const SWIPE_RATIO = 1.4;

/**
 * 看原图的那一层：**盖住整个页面**的蒙版 + 当前会话的图片画廊。
 * 自己写的，没有引灯箱依赖 —— 需要的就是「铺一层黑底、居中放一张图、能前后翻、
 * 三种方式关掉」，为这点东西拉一个库进来不划算。
 *
 * ## 为什么必须 createPortal
 *
 * 之前它是直接渲染在 MessageList 的子树里的，也就是长在 `.chat__scroll` 里面。
 * `position: fixed` 在那个位置**不一定**相对视口定位：祖先上任何一个 transform /
 * filter / contain / will-change 都会把它变成相对那个祖先定位，而且它还被夹在
 * 会话区的 overflow 和层叠上下文里。结果就是用户说的「在会话层级处理」——
 * 顶多盖住聊天区，盖不住侧栏和顶栏。挂到 document.body 之后，fixed 才真的是整页。
 *
 * Modal.tsx 目前也没有用 portal。参考它的鼠标交互写法可以，但**别抄这一点**。
 *
 * ## 关掉的三条路
 * 右上角按钮、Esc、点图片外面的背景。点图片本身不关，不然想把图挪进视野里
 * 看细节都会误关。
 *
 * ## 不循环
 *
 * 到头了就把箭头置灰，不从最后一张绕回第一张。原因是 `images` 本身就可能是**不完整**的
 * （见 hasOlder）：一个会绕圈的画廊在暗示「这是一个闭合的集合，你已经看全了」，
 * 而实际上左边还有没加载出来的图。让边界显形，比让它转起来诚实。
 * 只有一张图时两个箭头都是灰的，也就一眼能看出「就这一张」。
 *
 * ## 键盘
 *   - 打开时焦点落到关闭按钮上，回车/空格直接就能关；
 *   - ← / → 翻页；
 *   - Tab 在这一层内部循环（一个够用的焦点陷阱），焦点不会溜到背后那条已经被遮住的
 *     消息列表上。只有一张图时两个箭头是 disabled，可聚焦的就只剩关闭按钮，
 *     Tab 一按就回到它自己；
 *   - 关掉之后焦点还回打开它的那个缩略图按钮，接着 Tab 不会从头开始。
 */
export function ImageViewer({ images, index, onIndex, onClose, hasOlder = false }: ImageViewerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  /**
   * 回调和当前下标都从这里取最新的，而不是写进 effect 的依赖。
   *
   * onClose / onIndex 多半是调用方在 JSX 里现写的箭头函数，每次渲染都是新的一个。
   * 直接把它们写进依赖，父组件一重渲染就会「关掉再打开」一遍：焦点被抢回关闭按钮，
   * 记下的 opener 也被换成了关闭按钮自己，背景滚动锁还会被解掉再上一次。
   * 所以下面那个 effect 的依赖留空，一次打开只跑一次。
   */
  const latest = useRef({ images, index, onIndex, onClose });
  latest.current = { images, index, onIndex, onClose };

  const count = images.length;
  const current = images[index] ?? { src: '', alt: '' };
  const atFirst = index <= 0;
  const atLast = index >= count - 1;

  /**
   * 大图自己的加载状态。缩略图那套是 innerHTML 出来的、只能外挂 addEventListener；
   * 这里的 <img> 是真的 React 节点，直接用 onLoad / onError 就行。
   *
   * 状态里连**是哪一张**一起存：翻页时 src 变了但 state 还留在上一张的 ready 上，
   * 会让下一张在真正加载完之前就不显示「加载中」。比对 src 不一致时一律当 loading，
   * 这样就不需要一个「index 变了就重置」的 effect —— 那个 effect 会在 ref 回调
   * 之后才跑，反而把下面那条缓存命中的快路径覆盖掉。
   */
  const [load, setLoad] = useState<{ src: string; state: 'loading' | 'ready' | 'error' }>(
    { src: current.src, state: 'loading' },
  );
  const state = load.src === current.src ? load.state : 'loading';

  function go(delta: number) {
    const { images: list, index: at, onIndex: set } = latest.current;
    const next = at + delta;
    if (next < 0 || next >= list.length) return;   // 不循环，见文件头
    set(next);
  }

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    /**
     * 背景滚动锁。蒙版盖住整页之后，滚轮再滚动背后的消息列表就成了「看不见的东西在动」。
     * 存的是**原来那个行内值**再原样还回去，不是无脑清成 ''：万一别处也动过 body 的
     * overflow，别把人家的值抹掉。
     *
     * 这个还原写在 effect 的 cleanup 里，所以不只是「关掉预览」会解锁 ——
     * 组件因为任何原因被卸载（切会话、退出登录把整棵树拆掉）都会解。
     * 少了这一条，退出登录之后整个页面就滚不动了，而且看不出是谁干的。
     */
    const body = document.body;
    const prevOverflow = body.style.overflow;
    body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        latest.current.onClose();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(1);
        return;
      }
      if (e.key === 'Tab') {
        // 焦点陷阱。可聚焦的东西会随着「翻到头了没有」变化（箭头会被 disable），
        // 所以每次按 Tab 现查一遍，不预先存一份。
        e.preventDefault();
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [],
        );
        if (!focusable.length) return;
        const at = focusable.indexOf(document.activeElement as HTMLButtonElement);
        const step = e.shiftKey ? -1 : 1;
        // at === -1（焦点跑到层外去了）时 next 落在 0 或末尾，正好把它拽回来。
        const next = (at + step + focusable.length) % focusable.length;
        focusable[next]?.focus();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      body.style.overflow = prevOverflow;
      // 打开它的那个缩略图可能已经随消息一起被卸载了，isConnected 挡一下。
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  /**
   * 触摸左右滑。手机上这是翻页的主要交互（箭头按钮在小屏上又小又挡画面）。
   *
   * 只认单指：两根手指是在捏合缩放看细节，那时候任何位移都不该翻页。
   */
  const touch = useRef<{ x: number; y: number; ok: boolean } | null>(null);
  /**
   * 刚刚靠滑动翻过页。浏览器在 touchend 之后可能补一发模拟的 mousedown，
   * 落在背景上就会被当成「点了背景」直接把预览关掉 —— 手一划整层没了。
   * 顺序是先 touchend 再 mousedown，所以在这里立个旗，背景关闭那边看一眼就放过。
   */
  const swiped = useRef(false);

  function onTouchStart(e: TouchEvent) {
    const t = e.touches[0];
    touch.current = e.touches.length === 1 && t
      ? { x: t.clientX, y: t.clientY, ok: true }
      : null;
  }

  function onTouchMove(e: TouchEvent) {
    // 中途多了一根手指 → 这是捏合，不是划动，作废。
    if (e.touches.length > 1 && touch.current) touch.current.ok = false;
  }

  function onTouchEnd(e: TouchEvent) {
    const start = touch.current;
    touch.current = null;
    if (!start?.ok) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;
    swiped.current = true;
    // 往左划 = 想看后面那张，和相册、和横向列表的方向一致。
    go(dx < 0 ? 1 : -1);
  }

  function onBackgroundDown(e: MouseEvent) {
    if (swiped.current) {          // 刚划完，这一发是浏览器补的模拟事件，不是点击
      swiped.current = false;
      return;
    }
    // 用 mousedown 而不是 click：在图上按下、拖到背景才松手（框选/拖动图片时很常见）
    // 不该算成「点了背景」。和 Modal 的做法保持一致。
    if (e.target === e.currentTarget) latest.current.onClose();
  }

  const layer = (
    <div
      className="imgview"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={current.alt ? `图片预览：${current.alt}` : '图片预览'}
      onMouseDown={onBackgroundDown}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <img
        // key 钉在 src 上：翻页时换一个全新的 <img> 节点，下面那个 ref 回调才会重跑，
        // 缓存命中的那一张也就能立刻结算成 ready。
        key={current.src}
        className="imgview__img"
        data-state={state}
        src={current.src}
        alt={current.alt}
        onLoad={() => setLoad({ src: current.src, state: 'ready' })}
        onError={() => setLoad({ src: current.src, state: 'error' })}
        ref={(img) => {
          // 图可能在 React 挂上 onLoad 之前就已经好了（浏览器缓存，或者本地 blob:
          // 基本是同步的），那一次 load 事件早就过去了。complete 是补这一次判定用的：
          // src 非空且 complete 时，naturalWidth 是 0 就说明「加载完了，但失败了」。
          //
          // 这是个内联函数，每次渲染 React 都会当成「新 ref」重新调这个回调 ——
          // 图片一旦 complete 就会一直是 complete，若不做幂等判断，每次调用都
          // setLoad 出一个新对象、触发重渲染、重渲染又把这个回调再跑一遍，
          // 死循环到 React 报「Maximum update depth exceeded」。命中同款 src/state
          // 就把 prev 原样传回去，让 setState 因为引用没变而跳过这次渲染。
          if (img?.getAttribute('src') && img.complete) {
            const next = img.naturalWidth > 0 ? 'ready' : 'error';
            setLoad((prev) => (prev.src === current.src && prev.state === next ? prev : { src: current.src, state: next }));
          }
        }}
      />

      {/* 大图也要有加载态，别是一片纯黑让人以为卡住了。role=status 让读屏也听得见。 */}
      {state === 'ready' ? null : (
        <div className="imgview__status" role="status">
          {state === 'error' ? '图片加载失败' : '加载中…'}
        </div>
      )}

      {count > 1 ? (
        <>
          <button
            type="button"
            className="imgview__nav imgview__nav--prev"
            onClick={() => go(-1)}
            disabled={atFirst}
            aria-label="上一张"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            className="imgview__nav imgview__nav--next"
            onClick={() => go(1)}
            disabled={atLast}
            aria-label="下一张"
          >
            <ChevronRight size={22} />
          </button>
        </>
      ) : null}

      <div className="imgview__bar">
        {/* aria-live：翻页时焦点还留在箭头上，不播报的话读屏用户完全不知道换了一张。 */}
        <span className="imgview__count" aria-live="polite">
          第 {index + 1} / {count} 张
        </span>
        {/*
          「共 n 张」里的 n 只数得到已经加载出来的消息。消息是分页的，往上翻才会拉更早的，
          所以这里必须把话说全，不能让用户以为翻到头了就是看完了。
        */}
        {hasOlder ? (
          <span className="imgview__hint">
            只包含已加载的消息；更早的图片要先在聊天里往上翻加载出来
          </span>
        ) : null}
      </div>

      <button
        ref={closeRef}
        type="button"
        className="imgview__close"
        onClick={onClose}
        aria-label="关闭图片预览"
      >
        <X size={18} />
      </button>
    </div>
  );

  // 挂到 body，不是挂在消息列表里。见文件头「为什么必须 createPortal」。
  return createPortal(layer, document.body);
}
