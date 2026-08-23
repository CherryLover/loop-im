import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface ImageViewerProps {
  src: string;
  alt: string;
  onClose: () => void;
}

/**
 * 看原图的那一层。自己写的，没有引灯箱依赖 —— 需要的就是「铺一层黑底、居中放一张图、
 * 三种方式关掉」，为这点东西拉一个库进来不划算。
 *
 * 关掉的三条路：右上角按钮、Esc、点图片外面的背景。点图片本身不关，
 * 不然想把图挪进视野里看细节都会误关。
 *
 * 键盘这一档：
 *   - 打开时焦点落到关闭按钮上，回车/空格直接就能关；
 *   - 这一层里只有关闭按钮一个可聚焦的东西，所以 Tab 一律吃掉并按回原处
 *     —— 一个够用的焦点陷阱，焦点不会溜到背后那条已经被遮住的消息列表上；
 *   - 关掉之后焦点还回打开它的那个缩略图按钮，接着 Tab 不会从头开始。
 */
export function ImageViewer({ src, alt, onClose }: ImageViewerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // onClose 多半是调用方在 JSX 里现写的箭头函数，每次渲染都是新的一个。
  // 直接把它写进 effect 的依赖，父组件一重渲染就会「关掉再打开」一遍：
  // 焦点被抢回关闭按钮，记下的 opener 也被换成了关闭按钮自己。
  // 所以依赖留空，让这个 effect 一次打开只跑一次，函数本身走 ref 取最新的。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // 打开它的那个缩略图可能已经随消息一起被卸载了，isConnected 挡一下。
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div
      className="imgview"
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `图片预览：${alt}` : '图片预览'}
      // 用 mousedown 而不是 click：在图上按下、拖到背景才松手（框选/拖动图片时很常见）
      // 不该算成「点了背景」。和 Modal 的做法保持一致。
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <img className="imgview__img" src={src} alt={alt} />
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
}
