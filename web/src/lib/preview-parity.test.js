// 跨端契约的前端这一半。
//
// 写成 .js 而不是 .ts 是有意的，理由同 styles-integrity.test.js / sw-source.test.js：
// tsconfig 的 include 只覆盖 src 且没开 allowJs，tsc 不会检查这个文件，也就不必为了
// 一个 node:fs 的 import 去给 web 装 @types/node。vitest 的 include 已经收 .js。
// （我第一版写成了 .ts，tsc 当场报 Cannot find module 'node:path' —— 这个坑仓库里
// 已经踩过两次并写在那两个文件顶上了。）期望值不写在这个文件里，写在 shared/preview-cases.json，
// 服务端 server/test/preview-parity.test.js 读的是同一张表。理由见那个 JSON 的 _why。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { plainTextOf } from './messages';

// vitest 的 root 是 web/，带一个上层候选免得有人从仓库根跑（同 styles-integrity.test.js）。
const casesPath = ['../shared/preview-cases.json', 'shared/preview-cases.json']
  .map((p) => resolve(process.cwd(), p))
  .find((p) => { try { readFileSync(p); return true; } catch { return false; } });

const table = JSON.parse(readFileSync(casesPath, 'utf8')) ;

describe('附件摘要 · 跨端契约（前端这一半）', () => {
  it('契约表本身是有内容的 —— 表被清空了要当场知道，而不是 0 条用例全绿', () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(11);
  });

  for (const { input, expected, why } of table.cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}（${why}）`, () => {
      expect(plainTextOf(input)).toBe(expected);
    });
  }
});
