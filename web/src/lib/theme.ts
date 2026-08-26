import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'loop-im-theme';

// 只有手动切换过才写这个 key，值是 manual:light / manual:dark；没有这个 key = 跟随系统。
// 旧版曾在每次加载时把「按系统算出来的初值」也写进去（裸的 light/dark），等于替所有人
// 做了一次手动选择，从此再也不跟随系统 —— 这正是要修的 bug。裸值分不清是谁选的，
// 而误写的占绝大多数，所以迁移策略是：见到旧格式一律清掉、当作没选过；
// 真正手动选过的人重新切一次即可，此后就是新格式。
const readManual = (): Theme | null => {
  const saved = localStorage.getItem(KEY);
  if (saved === 'manual:light') return 'light';
  if (saved === 'manual:dark') return 'dark';
  if (saved !== null) localStorage.removeItem(KEY);
  return null;
};

const systemTheme = (): Theme =>
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

export function useTheme() {
  const [manual, setManual] = useState<Theme | null>(readManual);
  const [system, setSystem] = useState<Theme>(systemTheme);

  // 跟随系统是「持续跟随」：系统切深色，开着的页面也要跟着切，不能只在加载那一刻看一眼。
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const theme = manual ?? system;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = useCallback(() => {
    setManual((prev) => {
      const next: Theme = (prev ?? systemTheme()) === 'light' ? 'dark' : 'light';
      localStorage.setItem(KEY, `manual:${next}`);
      return next;
    });
  }, []);

  return { theme, toggle };
}
