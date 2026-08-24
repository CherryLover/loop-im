// 回归测试：见 ImageViewer.tsx 里 ref 回调上的注释。
//
// jsdom 不实现真实的图片加载状态机，<img>.complete 恒为 false，没法用真实
// src 自然复现「图片已经加载完成」这个场景。用 Object.defineProperty 顶掉
// complete / naturalWidth，模拟浏览器缓存命中（大图和缩略图同一个 src）或
// 本地 blob: URL（几乎同步就绪）——这才是这个 bug 在生产里被触发的真实条件。
import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
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

afterEach(() => {
  // 不还原会污染同文件里其它用真实 <img> 的测试（还有别的测试文件共用这个 jsdom 全局）。
  Reflect.deleteProperty(HTMLImageElement.prototype, 'complete');
  Reflect.deleteProperty(HTMLImageElement.prototype, 'naturalWidth');
});

describe('ImageViewer', () => {
  it('图片挂载时就已 complete（缓存命中 / 本地 blob:）不会陷入无限重渲染', () => {
    mockImageAlreadyLoaded();
    // ref 回调没有幂等判断的话：每次渲染都是新的 ref 函数引用，React 重新调用它，
    // img.complete 恒为 true → 一直 setLoad 出新对象 → 一直触发重渲染 → 循环，
    // 直到 React 抛出「Maximum update depth exceeded」（生产环境即用户报的 error #185）。
    expect(() => {
      render(
        <ImageViewer
          images={[{ src: 'blob:mock-1', alt: '截图' }]}
          index={0}
          onIndex={() => {}}
          onClose={() => {}}
        />,
      );
    }).not.toThrow();
    // ImageViewer 用 createPortal 挂到 document.body，不在 render() 的默认 container 里。
    // 不只是「没崩」，状态也真的要稳定收敛到 ready，不是卡在 loading。
    expect(document.body.querySelector('.imgview__img')?.getAttribute('data-state')).toBe('ready');
  });

  it('翻页到下一张同样已 complete 的图，也不会陷入无限重渲染', () => {
    mockImageAlreadyLoaded();
    expect(() => {
      render(
        <ImageViewer
          images={[
            { src: 'blob:mock-1', alt: '第一张' },
            { src: 'blob:mock-2', alt: '第二张' },
          ]}
          index={1}
          onIndex={() => {}}
          onClose={() => {}}
        />,
      );
    }).not.toThrow();
    expect(document.body.querySelector('.imgview__img')?.getAttribute('data-state')).toBe('ready');
  });
});
