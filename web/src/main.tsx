import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerServiceWorker } from './lib/sw';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 注册放在 render 之后，这个顺序是有意的：注册是个纯异步副作用，页面不依赖它的结果，
// 排在前面只会白白往首屏前面塞一次网络请求。
// void 是给人看的 —— 明说「这个 Promise 不用等，也不会 reject」（见 lib/sw.ts：
// 它自己吞掉所有失败）。没有 SW，网页照样是个能用的 IM，只是收不到后台推送。
void registerServiceWorker();
