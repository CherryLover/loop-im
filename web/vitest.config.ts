import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // 也收 .js：styles-integrity.test.js 要用 node:fs 读 styles.css 做结构校验，
    // 而 tsconfig 的 types 数组里没有 @types/node，写成 .ts 会让 tsc 报找不到模块。
    // .js 落在 tsconfig 的检查范围之外（include 只覆盖 src 且没开 allowJs），正好。
    include: ['src/**/*.test.{ts,tsx,js}'],
  },
});
