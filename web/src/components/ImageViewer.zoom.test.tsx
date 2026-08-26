/**
 * 缩放这套交互的判定逻辑：双击 / 双触切换、滚轮、捏合、放大后单指是平移不翻页、
 * 换一张图缩放归位。
 *
 * jsdom 量不出布局，getBoundingClientRect 全是 0 —— 而锚点缩放的数学恰恰全靠这个
 * 矩形。所以这里把大图的矩形打成一个固定值（左上 (100, 50)、800×600），
 * 数值断言都是按这个盒子和 jsdom 默认视口 1024×768 手算出来的。
 * 真实的惯性、浏览器抢手势，一律只能真机上过。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ImageViewer } from './ImageViewer';

function mockImageAlreadyLoaded() {
  Object.defineProperty(HTMLImageElement.prototype, 'complete', {
    configurable: true,
    get() { return !!this.getAttribute('src'); },
  });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true,
    get() { return 100; },
  });
}

function mockImageRect() {
  // 布局盒固定在左上 (100, 50)、800×600（中心 (500, 350)）。真浏览器的
  // getBoundingClientRect 反映 transform 之后的样子 —— 组件里的 baseBox()
  // 正是靠「从矩形里扣掉当前缩放」还原布局盒的，所以这个桩必须把元素当前的
  // inline transform 应用上去，静态矩形会让第二步之后的手势全部算错。
  vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLImageElement) {
    const m = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\(([\d.]+)\)/.exec(this.style.transform || '');
    const tx = m ? parseFloat(m[1] ?? '0') : 0;
    const ty = m ? parseFloat(m[2] ?? '0') : 0;
    const s = m ? parseFloat(m[3] ?? '1') : 1;
    const w = 800 * s;
    const h = 600 * s;
    const cx = 500 + tx;
    const cy = 350 + ty;
    return {
      x: cx - w / 2, y: cy - h / 2, left: cx - w / 2, top: cy - h / 2,
      right: cx + w / 2, bottom: cy + h / 2, width: w, height: h,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

afterEach(() => {
  Reflect.deleteProperty(HTMLImageElement.prototype, 'complete');
  Reflect.deleteProperty(HTMLImageElement.prototype, 'naturalWidth');
  vi.restoreAllMocks();
});

const img = () => document.body.querySelector('img.imgview__img') as HTMLImageElement;
const layer = () => document.body.querySelector('.imgview') as HTMLElement;
const at = (x: number, y: number) => ({ clientX: x, clientY: y });

function open(props: Partial<Parameters<typeof ImageViewer>[0]> = {}) {
  mockImageAlreadyLoaded();
  return render(
    <ImageViewer
      images={[{ src: 'blob:mock-1', alt: '一' }, { src: 'blob:mock-2', alt: '二' }]}
      index={0}
      onIndex={() => {}}
      onClose={() => {}}
      {...props}
    />,
  );
}

describe('双击 / 双触缩放', () => {
  it('双击放大到 2.5 倍，落点为锚；再双击复位', () => {
    mockImageRect();
    open();
    // 盒子中心 (500, 350)。以 (400, 300) 为锚：t = 锚 − 中心 − 锚的图上坐标 × 2.5
    fireEvent.doubleClick(img(), at(400, 300));
    expect(img().style.transform).toBe('translate3d(150px, 75px, 0) scale(2.5)');
    fireEvent.doubleClick(img(), at(400, 300));
    expect(img().style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
  });

  it('触摸端连点两下等于双击', () => {
    mockImageRect();
    open();
    const l = layer();
    fireEvent.touchStart(l, { touches: [at(400, 300)] });
    fireEvent.touchEnd(l, { changedTouches: [at(400, 300)], touches: [] });
    fireEvent.touchStart(l, { touches: [at(400, 300)] });
    fireEvent.touchEnd(l, { changedTouches: [at(400, 300)], touches: [] });
    expect(img().style.transform).toBe('translate3d(150px, 75px, 0) scale(2.5)');
  });

  it('两次点离得太远是两次各自的点，不凑成双击', () => {
    mockImageRect();
    open();
    const l = layer();
    fireEvent.touchStart(l, { touches: [at(100, 100)] });
    fireEvent.touchEnd(l, { changedTouches: [at(100, 100)], touches: [] });
    fireEvent.touchStart(l, { touches: [at(400, 300)] });
    fireEvent.touchEnd(l, { changedTouches: [at(400, 300)], touches: [] });
    expect(img().style.transform).toContain('scale(1)');
  });
});

describe('滚轮缩放（含触控板捏合）', () => {
  it('往上滚放大，倍数封顶 4', () => {
    mockImageRect();
    open();
    fireEvent.wheel(layer(), { deltaY: -10000, clientX: 500, clientY: 350 });
    expect(img().style.transform).toContain('scale(4)');
  });

  it('缩到 1 就停，不会缩得比适配屏幕还小', () => {
    mockImageRect();
    open();
    fireEvent.wheel(layer(), { deltaY: 10000, clientX: 500, clientY: 350 });
    expect(img().style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
  });
});

describe('双指捏合', () => {
  it('两指距离拉大一倍，就放大一倍，中点为锚', () => {
    mockImageRect();
    open();
    const l = layer();
    // 中点 (400, 300)，起始指距 200，拉到 400 → 2 倍
    fireEvent.touchStart(l, { touches: [at(300, 300), at(500, 300)] });
    fireEvent.touchMove(l, { touches: [at(200, 300), at(600, 300)] });
    // t = 中点 − 中心 − 锚的图上坐标 × 2 = (400−500−(−100×2), 300−350−(−50×2)) = (100, 50)
    expect(img().style.transform).toBe('translate3d(100px, 50px, 0) scale(2)');
  });

  it('平移出界会被夹回来：图的边缘到屏幕边缘就停', () => {
    mockImageRect();
    open();
    const l = layer();
    fireEvent.touchStart(l, { touches: [at(300, 300), at(500, 300)] });
    // 指距 200→400（放大到 2 倍），同时把中点拽到右下角 (800, 700)：
    // 不夹的话 t 会是 (500, 450)；2 倍下横向最多 (1600−1024)/2 = 288，纵向 (1200−768)/2 = 216
    fireEvent.touchMove(l, { touches: [at(600, 700), at(1000, 700)] });
    expect(img().style.transform).toBe('translate3d(288px, 216px, 0) scale(2)');
  });
});

describe('放大之后的单指', () => {
  it('是平移，不是翻页', () => {
    mockImageRect();
    const onIndex = vi.fn();
    open({ onIndex });
    fireEvent.doubleClick(img(), at(500, 350));   // 以中心为锚放大，t 归零
    expect(img().style.transform).toBe('translate3d(0px, 0px, 0) scale(2.5)');

    const l = layer();
    fireEvent.touchStart(l, { touches: [at(600, 300)] });
    fireEvent.touchMove(l, { touches: [at(400, 300)] });
    fireEvent.touchEnd(l, { changedTouches: [at(400, 300)], touches: [] });
    // 横划 200px，足够翻页的距离 —— 但放大着，所以是把图往左拖了 200
    expect(onIndex).not.toHaveBeenCalled();
    expect(img().style.transform).toBe('translate3d(-200px, 0px, 0) scale(2.5)');
  });

  it('没放大时同样的横划照常翻页', () => {
    mockImageRect();
    const onIndex = vi.fn();
    open({ onIndex });
    const l = layer();
    fireEvent.touchStart(l, { touches: [at(600, 300)] });
    fireEvent.touchMove(l, { touches: [at(400, 300)] });
    fireEvent.touchEnd(l, { changedTouches: [at(400, 300)], touches: [] });
    expect(onIndex).toHaveBeenCalledWith(1);
  });
});

describe('翻页与入场', () => {
  it('换一张图，缩放归位', () => {
    mockImageRect();
    const view = open();
    fireEvent.doubleClick(img(), at(500, 350));
    expect(img().style.transform).toContain('scale(2.5)');
    view.rerender(
      <ImageViewer
        images={[{ src: 'blob:mock-1', alt: '一' }, { src: 'blob:mock-2', alt: '二' }]}
        index={1}
        onIndex={() => {}}
        onClose={() => {}}
      />,
    );
    expect(img().style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
  });

  it('带着 origin 打开不会崩（jsdom 没有 WAAPI，入场动画静默跳过）', () => {
    // 真浏览器里这是「从缩略图长出来」的 FLIP；这里钉住的是降级路径：
    // Element.animate 不存在时必须直接呈现终态，而不是报错或卡在起点。
    expect(() => {
      open({ origin: { x: 10, y: 20, width: 160, height: 160 } });
    }).not.toThrow();
    expect(img().getAttribute('data-state')).toBe('ready');
  });
});
