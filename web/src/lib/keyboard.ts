/**
 * 软键盘挡住输入框 —— iOS 那一半的解法。
 *
 * ── 两个平台是两套机制，各修各的 ─────────────────────────────────────────────
 *
 * Android Chrome：认 viewport meta 里的 `interactive-widget=resizes-content`
 * （index.html 已加）。键盘弹起 → 布局视口变矮 → `.app` 的 100dvh 跟着缩 →
 * flex 布局把输入框顶到键盘上沿。纯声明式，不需要这个文件出手。
 *
 * iOS（Safari 与 PWA 独立模式都一样）：不认识 interactive-widget，也没有任何
 * 等价开关。键盘弹起时**布局视口纹丝不动**，只有 visualViewport 变矮，然后系统
 * 自作主张把整页往上平移凑合一下 —— 结果就是标题栏被推出屏幕、输入框一半埋在
 * 键盘里。JS 里唯一能拿到键盘位置的地方就是 visualViewport，没有第二条路。
 *
 * ── 做法：把 .app 的底边钉在「可视区域的真实底边」上 ─────────────────────────
 *
 * 监听 visualViewport 的 resize/scroll，把 offsetTop + height（可视区域底边在
 * 布局坐标系里的位置）写进根元素的 `--vv-bottom`；styles.css 把 .app 的高度定成
 * `min(100dvh, var(--vv-bottom, 100dvh))`。键盘一起一收、系统平移多少，每个事件
 * 都会把底边重新钉到当下的可视底边上 —— 输入框贴着键盘上沿是**按构造成立**的，
 * 不存在「几个来源不同的高度做减法，其中一个过期了」这种失配。
 *
 * 第一版就是栽在减法上：`innerHeight - vv.height - offsetTop` 三个数取样时机
 * 不同步，真机上算出一个偏大的键盘高度，把 .app 压得比可视区还矮，Tab 栏下面
 * 露出一条背景色的空带。现在只用 visualViewport 自己的两个字段，同一次事件里
 * 读出来的必然自洽。
 *
 * 在 Android（resizes-content 生效）上 offsetTop 恒为 0、vv.height ≈ 100dvh，
 * min() 取谁都一样 —— 两套机制不会叠加双扣。
 *
 * ── scale 检查：整页缩放时收手 ────────────────────────────────────────────────
 *
 * 用户双指放大页面时 vv.height 也会变小，但那不是键盘，跟着缩 .app 就把好好的
 * 页面截成一半。放大状态（scale > 1）下直接把变量摘掉、完全不干预 —— 缩放浏览
 * 本来就该让系统自己管。顺带一说：以前 iOS 上点一下输入框就会残留一个约 1.2 的
 * 放大倍率（字号 < 16px 触发自动放大），正是它把第一版的算术带崩的；现在
 * viewport meta 里的 maximum-scale=1 已经把自动放大关了，这里的检查只是给
 * 用户主动缩放留的安全阀。
 */
export function startKeyboardInsetTracking(): () => void {
  const vv = window.visualViewport;
  // 老浏览器 / jsdom 没有 visualViewport：不追踪也不报错，一切照旧。
  if (!vv) return () => {};
  const root = document.documentElement;

  const apply = () => {
    // 取整是因为 iOS 会给出小数像素，写进 CSS 会让布局在半像素上抖。
    if (vv.scale > 1.01) {
      root.style.removeProperty('--vv-bottom');
      return;
    }
    root.style.setProperty('--vv-bottom', `${Math.round(vv.offsetTop + vv.height)}px`);
    // 文档本身不可滚（.app 恰好一屏、内部各区各自滚），这一下只在 iOS 偶尔把
    // 文档也推出滚动量时把它归位，不会打扰任何真实的滚动位置。
    if (window.scrollY > 0) window.scrollTo(0, 0);
  };

  apply();
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  return () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
    root.style.removeProperty('--vv-bottom');
  };
}
