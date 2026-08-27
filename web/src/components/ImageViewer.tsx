import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { imageFileName, triggerDownload } from '../lib/save-image';

/** 画廊里的一张。src 已经是渲染层最终用的那个地址（可能是 blob:，也可能带 ?token=）。 */
export interface GalleryImage {
  src: string;
  alt: string;
}

/** 打开预览那一刻，被点的缩略图在视口里的位置。入场动画从这个框「长」到居中大图。 */
export interface ViewerOrigin {
  x: number;
  y: number;
  width: number;
  height: number;
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
  /** 不传（或者量不到，rect 是 0）就没有展开动画，只有背景淡入。 */
  origin?: ViewerOrigin | null;
}

/** 手指横向走多少像素才算一次「翻页」，而不是手抖。 */
const SWIPE_PX = 44;
/**
 * 横向位移至少要是纵向的这么多倍才算横划。
 * 不加这一条的话，顺着页面竖着一划、手指稍微斜一点就会翻页。
 */
const SWIPE_RATIO = 1.4;
/** 缩放上限。再大就只剩马赛克了；下限钉死 1，缩得比适配屏幕还小没有意义。 */
const MAX_SCALE = 4;
/** 双击 / 双触一步跳到的倍数。 */
const DOUBLE_TAP_SCALE = 2.5;
/** 两次点按间隔在这个毫秒数以内才算双击。 */
const DOUBLE_TAP_MS = 300;
/** 两次点按落点相距超过这个像素数，就是两次各自的点，不凑成双击。 */
const DOUBLE_TAP_SLOP = 28;
/** 手指挪动超过这个像素数就不再算「按住不动」：长按取消、这一按也不算点。 */
const TAP_SLOP = 12;
/** 按住多久弹出保存菜单。 */
const LONG_PRESS_MS = 500;

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function prefersReducedMotion() {
  // jsdom 没有 matchMedia，真浏览器一定有 —— 缺失时当「不减弱」处理。
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Web Share API 能不能分享文件。iOS 上这是网页把图片存进系统相册的唯一途径
 * （分享面板里的「存储图像」）；不支持的环境退回 <a download>。
 * 每次现查而不是模块级缓存一份：判断本身很便宜，测试还要打桩。
 */
function supportsFileShare() {
  try {
    if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
    return navigator.canShare({ files: [new File([], 'probe.png', { type: 'image/png' })] });
  } catch {
    return false;
  }
}

/**
 * 主输入是不是手指（粗指针）。桌面的 Safari / Chrome 同样支持分享文件，
 * 只看 supportsFileShare 会把桌面用户也拽进分享面板 —— 得再加一道「这是触屏设备」。
 * jsdom 没有 matchMedia，缺失时当桌面处理。
 */
function isCoarsePointer() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

interface ZoomState { scale: number; tx: number; ty: number }
const ZOOM_RESET: ZoomState = { scale: 1, tx: 0, ty: 0 };

/** img 的「布局盒」：中心点和未缩放的宽高。transform 不改布局，从渲染矩形里扣掉当前缩放即可。 */
interface BaseBox { w: number; h: number; cx: number; cy: number }

type Gesture =
  | { kind: 'single'; x0: number; y0: number; tx0: number; ty0: number; moved: boolean }
  | { kind: 'pinch'; d0: number; s0: number; ux: number; uy: number; box: BaseBox }
  | null;

/**
 * 看原图的那一层：**盖住整个页面**的蒙版 + 当前会话的图片画廊。
 * 自己写的，没有引灯箱依赖 —— 需要的就是「铺一层黑底、居中放一张图、能前后翻、
 * 能缩放、能保存、三种方式关掉」，为这点东西拉一个库进来不划算。
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
 * ## 入场 / 退场动画
 *
 * 打开时背景淡入（CSS），大图从缩略图的位置「长」到居中（origin + WAAPI 的 FLIP：
 * 先量出终点矩形，再从起点框算一个 translate+scale 反着播）。关闭时整层淡出，
 * 播完才真的调 onClose。两处都尊重 prefers-reduced-motion；jsdom 没有
 * Element.animate，测试环境里关闭因此保持同步 —— 这不是巧合，是依赖。
 *
 * ## 缩放
 *
 * 双指捏合、双击 / 双触在 1x 和 2.5x 之间切换、桌面滚轮（含触控板捏合，
 * 表现为 ctrlKey+wheel）。放大之后单指 / 按住鼠标拖动是平移，翻页手势让位；
 * 平移有边界：图的边缘拖到屏幕边缘就停，不会整张飞出去。换一张图缩放归位。
 * 数学都以「布局中心 + translate + scale」为模型，锚点（手指中点 / 光标 / 双击落点）
 * 在缩放前后指着图上同一个位置。
 *
 * ## 保存
 *
 * 在大图上按住 500ms 弹操作菜单：系统分享（能存相册，见 supportsFileShare）
 * 和直接下载。顶栏另有常驻的保存按钮 —— 长按是触屏的路，桌面和键盘用户得有看得见的入口。
 *
 * 顶栏按钮在**触屏且支持分享文件**的环境（约等于手机）直接走系统分享，不走下载：
 * iOS 上浏览器下载只会落进「文件」App，用户想要的是相册，而网页进相册只有分享面板里
 * 「存储图像」这一条路。桌面反过来，直接下载才是预期，弹分享面板是多一步打扰。
 * 分享面板本身起不来（取图太慢、Safari 认定已出了手势时效之类）就退回下载兜底 ——
 * 图都取到手了，这一按不能什么都没发生。
 * 图先 fetch 成 Blob 再交出去：src 可能带 ?token=，也可能是 blob:，两种 fetch 都吃。
 *
 * ## 关掉的三条路
 * 右上角按钮、Esc、点图片外面的背景。点图片本身不关，不然想把图挪进视野里
 * 看细节都会误关。保存菜单开着时 Esc 先关菜单。
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
 *     消息列表上。保存菜单的按钮出现时自动进圈，消失时自动出圈；
 *   - 关掉之后焦点还回打开它的那个缩略图按钮，接着 Tab 不会从头开始。
 */
export function ImageViewer({ images, index, onIndex, onClose, hasOlder = false, origin = null }: ImageViewerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  /** 保存菜单（长按弹出的那个）。 */
  const [menuOpen, setMenuOpen] = useState(false);
  /** 保存流程的状态：busy 时按钮禁掉防连点，error 展示出来并几秒后自己消失。 */
  const [saveState, setSaveState] = useState<'idle' | 'busy' | 'error'>('idle');

  /**
   * 回调和当前状态都从这里取最新的，而不是写进 effect 的依赖。
   *
   * onClose / onIndex 多半是调用方在 JSX 里现写的箭头函数，每次渲染都是新的一个。
   * 直接把它们写进依赖，父组件一重渲染就会「关掉再打开」一遍：焦点被抢回关闭按钮，
   * 记下的 opener 也被换成了关闭按钮自己，背景滚动锁还会被解掉再上一次。
   * 所以下面那个 effect 的依赖留空，一次打开只跑一次。
   */
  const latest = useRef({ images, index, onIndex, onClose, menuOpen });
  latest.current = { images, index, onIndex, onClose, menuOpen };

  const count = images.length;
  const current = images[index] ?? { src: '', alt: '' };
  /**
   * 顶栏保存按钮走哪条路：触屏 + 系统能分享文件（约等于手机）→ 系统分享，
   * 能进相册；否则（桌面）→ 直接下载。见文件头「保存」。
   */
  const shareSave = supportsFileShare() && isCoarsePointer();
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

  /* ---------- 缩放 ---------- */

  /**
   * 缩放的真值放 ref：手势回调之间要读到**刚写进去**的值，走 state 会慢一拍
   * （touchmove 连着来，setState 攒到下一次渲染才可见）。state 那份只管渲染。
   * smooth 表示这次变化要不要过渡动画：双击是「跳」（要），捏合和拖动是「跟手」（不要）。
   */
  const zoomRef = useRef<ZoomState>(ZOOM_RESET);
  const [zoomView, setZoomView] = useState<ZoomState & { smooth: boolean }>({ ...ZOOM_RESET, smooth: false });
  /**
   * 上一次**真的渲染到 DOM 上**的那份缩放。和 zoomRef 的区别在事件连发时显形：
   * 触控板滚动一帧里能塞进好几个 wheel，zoomRef 已经往前跑了，DOM 的 transform
   * 还停在上一次 render。baseBox 要把 transform 从矩形里扣掉，除数必须用
   * 矩形对应的那份（这份），拿 zoomRef 除会把布局盒算大，边界夹取跟着失效 ——
   * 实测能让图缩回 1 倍时卡着几十像素的偏移回不去。
   */
  const renderedZoom = useRef<ZoomState>(ZOOM_RESET);
  renderedZoom.current = zoomView;

  function applyZoom(next: ZoomState, smooth: boolean) {
    zoomRef.current = next;
    setZoomView({ ...next, smooth: smooth && !prefersReducedMotion() });
  }

  /** transform 不参与布局，所以从渲染矩形里把（矩形对应的）缩放扣掉，就是布局盒。 */
  function baseBox(): BaseBox | null {
    const img = imgRef.current;
    if (!img) return null;
    const r = img.getBoundingClientRect();
    const { scale, tx, ty } = renderedZoom.current;
    return {
      w: r.width / scale,
      h: r.height / scale,
      cx: r.left + r.width / 2 - tx,
      cy: r.top + r.height / 2 - ty,
    };
  }

  /**
   * 平移边界：图的边缘最多拖到屏幕边缘就停。某个方向上放大后仍然比屏幕小，
   * 那个方向就锁死居中 —— 一张竖图放大到 2 倍宽度还不够铺满时，横向就不该能拖。
   */
  function clampPan(scale: number, tx: number, ty: number, box: BaseBox): ZoomState {
    const maxX = Math.max(0, (box.w * scale - window.innerWidth) / 2);
    const maxY = Math.max(0, (box.h * scale - window.innerHeight) / 2);
    return { scale, tx: clamp(tx, -maxX, maxX), ty: clamp(ty, -maxY, maxY) };
  }

  /** 以视口上的 (px, py) 为锚缩放：缩放前后，锚点指着图上的同一个位置。 */
  function zoomAt(px: number, py: number, nextScale: number, smooth: boolean) {
    const box = baseBox();
    if (!box || !box.w || !box.h) {
      // 量不到布局（图还没 ready）就只改倍数不做锚定，别除出 NaN。
      applyZoom({ scale: clamp(nextScale, 1, MAX_SCALE), tx: 0, ty: 0 }, smooth);
      return;
    }
    const { scale: s0, tx, ty } = zoomRef.current;
    const s = clamp(nextScale, 1, MAX_SCALE);
    const ux = (px - box.cx - tx) / s0;
    const uy = (py - box.cy - ty) / s0;
    applyZoom(clampPan(s, px - box.cx - ux * s, py - box.cy - uy * s, box), smooth);
  }

  function resetZoom(smooth: boolean) {
    applyZoom(ZOOM_RESET, smooth);
  }

  /** 双击 / 双触：放大着就复位，没放大就以落点为锚跳到 2.5x。 */
  function toggleZoom(px: number, py: number) {
    if (zoomRef.current.scale > 1.01) resetZoom(true);
    else zoomAt(px, py, DOUBLE_TAP_SCALE, true);
  }

  // 换一张图，缩放归位。上一张拖到哪儿是上一张的事。
  useEffect(() => {
    const z = zoomRef.current;
    if (z.scale !== 1 || z.tx !== 0 || z.ty !== 0) applyZoom(ZOOM_RESET, false);
    setMenuOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  function go(delta: number) {
    const { images: list, index: at, onIndex: set } = latest.current;
    const next = at + delta;
    if (next < 0 || next >= list.length) return;   // 不循环，见文件头
    set(next);
  }

  /* ---------- 退场 ---------- */

  /** 正在播关闭动画。期间再点再按都不重复触发，播完统一走 onClose。 */
  const closing = useRef(false);

  function requestClose() {
    if (closing.current) return;
    const layerEl = dialogRef.current;
    // 播不了（jsdom 没有 WAAPI）或者用户关了动效，就立刻关。测试里的同步断言靠这条。
    if (!layerEl || typeof layerEl.animate !== 'function' || prefersReducedMotion()) {
      latest.current.onClose();
      return;
    }
    closing.current = true;
    // 没放大时大图顺带收一点，比干巴巴的淡出多一层「收回去」的方向感；
    // 放大着就别动它了 —— 从 2.5x 突然跳去播 1x 的动画反而是闪一下。
    if (zoomRef.current.scale === 1 && imgRef.current && typeof imgRef.current.animate === 'function') {
      imgRef.current.animate(
        [{ transform: 'translate3d(0, 0, 0) scale(1)' }, { transform: 'translate3d(0, 0, 0) scale(.94)' }],
        { duration: 130, easing: 'ease-in', fill: 'forwards' },
      );
    }
    const anim = layerEl.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 130,
      easing: 'ease-in',
      fill: 'forwards',
    });
    anim.onfinish = () => latest.current.onClose();
    anim.oncancel = () => latest.current.onClose();
  }

  /* ---------- 入场 ---------- */

  /** 只在第一次 ready 时播入场动画；翻页后每张图的 ready 不再触发。 */
  const entered = useRef(false);
  /** 打开时落在哪一张。图还没 ready 用户就翻走了的话，origin 已经对不上，放弃动画。 */
  const openedAt = useRef(index);

  useLayoutEffect(() => {
    if (entered.current || state !== 'ready') return;
    entered.current = true;
    const img = imgRef.current;
    if (!img || !origin || origin.width <= 0 || origin.height <= 0) return;
    if (typeof img.animate !== 'function' || prefersReducedMotion()) return;
    if (latest.current.index !== openedAt.current) return;
    const to = img.getBoundingClientRect();
    if (!to.width || !to.height) return;
    // 缩略图是 1:1 裁切的方格、大图是 contain，两个框比例多半不同。
    // 用 max 让起始大小盖住缩略图那个方格，形状差异靠透明度爬坡遮一下。
    const s = Math.max(origin.width / to.width, origin.height / to.height);
    const dx = origin.x + origin.width / 2 - (to.left + to.width / 2);
    const dy = origin.y + origin.height / 2 - (to.top + to.height / 2);
    img.animate(
      [
        { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${s})`, opacity: 0.55 },
        { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
      ],
      { duration: 240, easing: 'cubic-bezier(.2, .75, .25, 1)' },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  /* ---------- 打开期间的全局事务：焦点、滚动锁、键盘、滚轮 ---------- */

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
        // 保存菜单开着时 Esc 只关菜单 —— 一层一层退，别一杆子捅穿。
        if (latest.current.menuOpen) setMenuOpen(false);
        else requestClose();
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
        // 焦点陷阱。可聚焦的东西会随着「翻到头了没有 / 菜单开没开」变化，
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

    /**
     * 滚轮缩放（触控板捏合在浏览器里也是 wheel，带 ctrlKey、delta 更细）。
     * 手动 addEventListener 而不是 JSX 的 onWheel：React 把根上的 wheel 监听注册成
     * passive 的，preventDefault 拦不住浏览器的整页缩放，只有自己挂 passive: false 才行。
     */
    const layerEl = dialogRef.current;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (latest.current.menuOpen) return;
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
      zoomAt(e.clientX, e.clientY, zoomRef.current.scale * factor, false);
    };
    layerEl?.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      window.removeEventListener('keydown', onKey);
      layerEl?.removeEventListener('wheel', onWheel);
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
      body.style.overflow = prevOverflow;
      // 打开它的那个缩略图可能已经随消息一起被卸载了，isConnected 挡一下。
      if (opener?.isConnected) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 保存菜单开合时把焦点带过去 / 带回来，键盘和读屏用户才找得到它。
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    if (menuOpen) sheetRef.current?.querySelector('button')?.focus();
    else if (!closing.current) closeRef.current?.focus();
  }, [menuOpen]);

  // 保存失败的提示不用手动关，几秒后自己退场。
  useEffect(() => {
    if (saveState !== 'error') return;
    const t = window.setTimeout(() => setSaveState('idle'), 3000);
    return () => window.clearTimeout(t);
  }, [saveState]);

  /* ---------- 触摸手势：划动翻页 / 捏合缩放 / 平移 / 双触 / 长按 ---------- */

  const gesture = useRef<Gesture>(null);
  /** 上一次「点」落在哪、什么时候 —— 双触判定用。 */
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  /** 长按计时器。 */
  const pressTimer = useRef<number | null>(null);
  /** 触摸端刚双触完，紧跟着的合成 dblclick 要吞掉，不然一次双触缩放两遍。 */
  const touchZoomedAt = useRef(0);
  /**
   * 刚用手势做完事（翻页 / 平移 / 双触 / 长按）。浏览器在 touchend 之后可能补一发
   * 模拟的 mousedown，落在背景上就会被当成「点了背景」直接把预览关掉 ——
   * 手一划整层没了。顺序是先 touchend 再 mousedown，所以在这里立个旗，
   * 背景关闭那边看一眼就放过。
   */
  const gestured = useRef(false);

  function cancelLongPress() {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }

  /**
   * 双指落定，开一段捏合。锚点记成**图上的点**（两指中点在图片坐标系里的位置）：
   * 捏合过程中中点移动、距离变化，都换算成「让这个图上点跟着中点走」，
   * 缩放和双指平移就是同一条公式。量不到布局（图还没 ready）就整段作废 ——
   * 作废的意思是这几根手指接下来既不缩放也不翻页，直到全部抬起重来。
   */
  function startPinch(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }) {
    lastTap.current = null;
    const box = baseBox();
    if (!box || !box.w || !box.h) { gesture.current = null; return; }
    const d0 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (!d0) { gesture.current = null; return; }
    const mx = (a.clientX + b.clientX) / 2;
    const my = (a.clientY + b.clientY) / 2;
    const { scale, tx, ty } = zoomRef.current;
    gesture.current = {
      kind: 'pinch',
      d0,
      s0: scale,
      ux: (mx - box.cx - tx) / scale,
      uy: (my - box.cy - ty) / scale,
      box,
    };
  }

  function onTouchStart(e: ReactTouchEvent) {
    cancelLongPress();
    if (menuOpen) return;   // 菜单开着时手势全停，点哪儿都只是在跟菜单打交道
    if (e.touches.length === 1) {
      const t = e.touches[0];
      if (!t) return;
      gesture.current = {
        kind: 'single',
        x0: t.clientX, y0: t.clientY,
        tx0: zoomRef.current.tx, ty0: zoomRef.current.ty,
        moved: false,
      };
      // 长按保存：按在图上、钉住不动满 500ms 才算。按在背景上长按没有可保存的东西。
      if ((e.target as Element | null)?.closest?.('.imgview__img')) {
        pressTimer.current = window.setTimeout(() => {
          pressTimer.current = null;
          gesture.current = null;   // 这一按到此为止：不翻页、不算点、不参与双触
          gestured.current = true;
          lastTap.current = null;
          setMenuOpen(true);
        }, LONG_PRESS_MS);
      }
    } else if (e.touches.length === 2 && e.touches[0] && e.touches[1]) {
      startPinch(e.touches[0], e.touches[1]);
    } else {
      gesture.current = null;
    }
  }

  function onTouchMove(e: ReactTouchEvent) {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'single') {
      // 中途多了一根手指：这已经是捏合，不是划动。正常情况下第二指落下会有自己的
      // touchstart 把手势换掉，这里是兜底 —— 兜不住的话这一把会被误判成翻页。
      if (e.touches.length > 1) {
        cancelLongPress();
        if (e.touches[0] && e.touches[1]) startPinch(e.touches[0], e.touches[1]);
        else gesture.current = null;
        return;
      }
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - g.x0;
      const dy = t.clientY - g.y0;
      if (!g.moved && Math.hypot(dx, dy) > TAP_SLOP) {
        g.moved = true;
        cancelLongPress();   // 手在走，就不是长按
      }
      // 放大状态下单指是平移，跟手、不留给翻页。
      if (g.moved && zoomRef.current.scale > 1) {
        const box = baseBox();
        if (!box) return;
        applyZoom(clampPan(zoomRef.current.scale, g.tx0 + dx, g.ty0 + dy, box), false);
      }
      return;
    }
    // pinch
    const a = e.touches[0];
    const b = e.touches[1];
    if (!a || !b) return;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (!d) return;
    const mx = (a.clientX + b.clientX) / 2;
    const my = (a.clientY + b.clientY) / 2;
    const s = clamp(g.s0 * (d / g.d0), 1, MAX_SCALE);
    applyZoom(clampPan(s, mx - g.box.cx - g.ux * s, my - g.box.cy - g.uy * s, g.box), false);
  }

  function onTouchEnd(e: ReactTouchEvent) {
    cancelLongPress();
    const g = gesture.current;
    if (!g) return;

    if (g.kind === 'pinch') {
      gestured.current = true;
      if (e.touches.length >= 1) {
        // 先抬起一根：剩下那根接着当平移用，别让图在两指变一指的瞬间跳一下。
        const t = e.touches[0];
        if (t) {
          gesture.current = {
            kind: 'single',
            x0: t.clientX, y0: t.clientY,
            tx0: zoomRef.current.tx, ty0: zoomRef.current.ty,
            moved: true,
          };
          return;
        }
      }
      gesture.current = null;
      return;
    }

    gesture.current = null;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - g.x0;
    const dy = t.clientY - g.y0;
    // touchmove 可能一次都没来（很快的一划），距离再补一次判定。
    const moved = g.moved || Math.hypot(dx, dy) > TAP_SLOP;

    if (!moved) {
      // 是一次「点」。凑不凑成双触？
      const now = performance.now();
      const prev = lastTap.current;
      if (prev && now - prev.t < DOUBLE_TAP_MS && Math.hypot(t.clientX - prev.x, t.clientY - prev.y) < DOUBLE_TAP_SLOP) {
        lastTap.current = null;
        gestured.current = true;
        touchZoomedAt.current = now;
        toggleZoom(t.clientX, t.clientY);
      } else {
        // 单独一次点先记下来。注意**不**立 gestured 旗：点背景关闭走的正是
        // touchend 之后那发模拟 mousedown，把它拦了背景就点不动了。
        lastTap.current = { t: now, x: t.clientX, y: t.clientY };
      }
      return;
    }

    if (zoomRef.current.scale > 1) {
      // 放大状态下这一划是平移，移动量已经在 touchmove 里消化了，别再当翻页。
      gestured.current = true;
      return;
    }
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;
    gestured.current = true;
    // 往左划 = 想看后面那张，和相册、和横向列表的方向一致。
    go(dx < 0 ? 1 : -1);
  }

  /* ---------- 鼠标：背景关闭、双击缩放、放大后拖动平移 ---------- */

  function onBackgroundDown(e: ReactMouseEvent) {
    if (gestured.current) {        // 刚做完手势，这一发是浏览器补的模拟事件，不是点击
      gestured.current = false;
      return;
    }
    // 用 mousedown 而不是 click：在图上按下、拖到背景才松手（框选/拖动图片时很常见）
    // 不该算成「点了背景」。和 Modal 的做法保持一致。
    if (e.target === e.currentTarget) requestClose();
  }

  function onImgDoubleClick(e: ReactMouseEvent) {
    // 触摸端我们自己处理了双触，浏览器要是再补一发 dblclick，吞掉。
    if (performance.now() - touchZoomedAt.current < 700) return;
    toggleZoom(e.clientX, e.clientY);
  }

  function onImgMouseDown(e: ReactMouseEvent) {
    if (zoomRef.current.scale <= 1) return;
    if (e.button !== 0) return;
    e.preventDefault();
    const box = baseBox();
    if (!box) return;
    const start = { x: e.clientX, y: e.clientY, tx: zoomRef.current.tx, ty: zoomRef.current.ty };
    const move = (ev: MouseEvent) => {
      applyZoom(clampPan(zoomRef.current.scale, start.tx + ev.clientX - start.x, start.ty + ev.clientY - start.y, box), false);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  /* ---------- 保存 ---------- */

  /**
   * 把当前这张取成 Blob。src 直接 fetch：带 ?token= 的是同源带凭证的普通请求，
   * blob: 的 fetch 回来的就是内存里那份 —— 两种都不用特判。
   */
  async function fetchCurrentBlob() {
    const res = await fetch(current.src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return { blob, name: imageFileName(current.alt, current.src, blob.type) };
  }

  /**
   * 走系统分享（iOS 存相册的唯一网页途径，面板里选「存储图像」）。
   * 分享面板被用户自己划掉（AbortError）不算失败；分享本身起不来 ——
   * 拿到 File 之后 canShare 反悔，或者 share 抛 NotAllowedError（取图太慢，
   * Safari 认定已经不在用户手势里了）—— 就退回下载：图都取到手了，
   * 这一按至少要落下点什么。
   */
  async function shareImage() {
    if (saveState === 'busy') return;
    setSaveState('busy');
    try {
      const { blob, name } = await fetchCurrentBlob();
      const file = new File([blob], name, { type: blob.type || 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
        } catch (err) {
          if ((err as DOMException)?.name === 'AbortError') {
            setSaveState('idle');
            return;
          }
          triggerDownload(blob, name);
        }
      } else {
        triggerDownload(blob, name);
      }
      setSaveState('idle');
      setMenuOpen(false);
    } catch {
      setSaveState('error');   // 取图就失败了：手里没有东西，只能报错
    }
  }

  async function downloadImage() {
    if (saveState === 'busy') return;
    setSaveState('busy');
    try {
      const { blob, name } = await fetchCurrentBlob();
      triggerDownload(blob, name);
      setSaveState('idle');
      setMenuOpen(false);
    } catch {
      setSaveState('error');
    }
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
        data-zoomed={zoomView.scale > 1 ? 'true' : undefined}
        src={current.src}
        alt={current.alt}
        style={{
          transform: `translate3d(${zoomView.tx}px, ${zoomView.ty}px, 0) scale(${zoomView.scale})`,
          transition: zoomView.smooth ? 'transform .24s cubic-bezier(.2, .75, .25, 1)' : undefined,
        }}
        onLoad={() => setLoad({ src: current.src, state: 'ready' })}
        onError={() => setLoad({ src: current.src, state: 'error' })}
        onDoubleClick={onImgDoubleClick}
        onMouseDown={onImgMouseDown}
        ref={(img) => {
          imgRef.current = img;
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

      {/* 保存失败的提示：长按菜单和顶栏下载共用。挂在层上而不是菜单里 ——
          顶栏那条路没有菜单，失败了也得有地方说。 */}
      {saveState === 'error' ? (
        <div className="imgview__saveerr" role="status">图片保存失败，稍后再试</div>
      ) : null}

      <button
        type="button"
        className="imgview__download"
        onClick={shareSave ? shareImage : downloadImage}
        disabled={saveState === 'busy'}
        aria-label={shareSave ? '保存图片' : '下载图片'}
        title={shareSave ? '保存图片' : '下载图片'}
      >
        <Download size={18} />
      </button>

      <button
        ref={closeRef}
        type="button"
        className="imgview__close"
        onClick={requestClose}
        aria-label="关闭图片预览"
      >
        <X size={18} />
      </button>

      {menuOpen ? (
        <>
          {/* 菜单自己的挡板：开着菜单时点哪儿都只是关菜单，不会误触背景把整层关了。 */}
          <div
            className="imgview__sheetback"
            onMouseDown={() => {
              if (gestured.current) { gestured.current = false; return; }
              setMenuOpen(false);
            }}
          />
          <div className="imgview__sheet" ref={sheetRef} role="group" aria-label="图片操作">
            {supportsFileShare() ? (
              <button type="button" onClick={shareImage} disabled={saveState === 'busy'}>
                保存到相册 / 分享…
              </button>
            ) : null}
            <button type="button" onClick={downloadImage} disabled={saveState === 'busy'}>
              下载到本地
            </button>
            <button type="button" className="imgview__sheet-cancel" onClick={() => setMenuOpen(false)}>
              取消
            </button>
          </div>
        </>
      ) : null}
    </div>
  );

  // 挂到 body，不是挂在消息列表里。见文件头「为什么必须 createPortal」。
  return createPortal(layer, document.body);
}
