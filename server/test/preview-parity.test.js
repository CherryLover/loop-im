// 跨端契约的服务端这一半。期望值不写在这个文件里，写在 shared/preview-cases.json，
// 前端 web/src/lib/preview-parity.test.ts 读的是同一张表。理由见那个 JSON 的 _why。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { previewOf } from '../src/routes/conversations.js';

const here = dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(readFileSync(resolve(here, '../../shared/preview-cases.json'), 'utf8'));

describe('附件摘要 · 跨端契约（服务端这一半）', () => {
  test('契约表本身是有内容的 —— 表被清空了要当场知道，而不是 0 条用例全绿', () => {
    assert.ok(table.cases.length >= 11, `契约表只剩 ${table.cases.length} 条`);
  });

  for (const { input, expected, why } of table.cases) {
    // limit 给一个大到不会截断的值：这张表只管清洗口径，截断长度各处不同
    // （列表 26 / 引用 48 / 推送 120），不在契约范围内。
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}（${why}）`, () => {
      assert.equal(previewOf(input, 9999), expected);
    });
  }
});
