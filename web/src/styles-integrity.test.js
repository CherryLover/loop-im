// 这道闸门是为一次真实事故加的，别删。
//
// 合并 styles.css 的冲突时丢了一个闭合花括号：
//
//   @media (prefers-reduced-motion: reduce) {
//     .avatar-slot__spinner { animation-duration: 2.4s; }
//                                  ← 这里的 } 没了
//   .md .mdimg { ... }             ← 于是后面整段都掉进了这个 media query
//
// 后果是那一整批图片样式**只对开了「减少动态效果」的人生效**，其余人看到的还是旧版面。
// 而这条流水线上没有任何人会发现：tsc 不看 CSS；vite 遇到括号不平衡会自动收口、
// 不报错；jsdom 不计算样式。580 条前端用例、CI 九项，一个都没拦住，靠人肉看出来的。
//
// 写成 .js 而不是 .ts 是有意的：tsconfig 的 include 只覆盖 src 且没开 allowJs，
// 所以 tsc 不会检查这个文件，也就不需要为了一个 node:fs 的 import 去给 web 装
// @types/node。vitest 照常会收它。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// 不用 import.meta.url：vitest 转换后的模块里它不是 file: scheme，fileURLToPath 会抛。
// vitest 的 root 是 web/，所以按 cwd 找；带一个上层候选，免得有人从仓库根跑。
const CSS_PATH = ['src/styles.css', 'web/src/styles.css']
  .map((p) => resolve(process.cwd(), p))
  .find(existsSync);

const CSS = readFileSync(CSS_PATH, 'utf8');

/** 去掉注释，注释里的花括号不算数（`content: "{"` 这类本仓库没有，真出现了再说）。 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) || []).length));

/** 逐字符扫，返回每个块的 { 选择器, 行号, 外层块 }。 */
function parseBlocks(css) {
  const clean = stripComments(css);
  const blocks = [];
  const stack = [];
  let line = 1;
  let buf = '';
  for (const ch of clean) {
    if (ch === '\n') line += 1;
    if (ch === '{') {
      const selector = buf.trim().replace(/\s+/g, ' ');
      blocks.push({ selector, line, ancestors: stack.map((s) => s.selector) });
      stack.push({ selector, line });
      buf = '';
    } else if (ch === '}') {
      if (!stack.length) throw new Error(`第 ${line} 行有多余的 }`);
      stack.pop();
      buf = '';
    } else {
      buf += ch;
    }
  }
  return { blocks, unclosed: stack };
}

describe('styles.css 结构完整性', () => {
  it('花括号必须平衡 —— 少一个 } 会让后面整段静默掉进上一个块里', () => {
    const { unclosed } = parseBlocks(CSS);
    const detail = unclosed.map((s) => `第 ${s.line} 行的 "${s.selector}"`).join('、');
    expect(unclosed.length, `这些块没有闭合：${detail}`).toBe(0);
  });

  it('普通选择器不能嵌在别的块里 —— CSS 不支持嵌套，嵌进去等于整条规则失效或被条件化', () => {
    const { blocks } = parseBlocks(CSS);
    // 只有 @media / @supports / @keyframes 这类 at-rule 才允许有子块。
    const nested = blocks.filter((b) => b.ancestors.length > 0
      && !b.ancestors.every((a) => a.startsWith('@')));
    const detail = nested.map((b) => `第 ${b.line} 行 "${b.selector}" 嵌在 "${b.ancestors.join(' > ')}" 里`).join('\n');
    expect(nested.length, `发现嵌套的普通规则：\n${detail}`).toBe(0);
  });

  it('那段图片与查看器的样式必须在顶层，不能被条件化', () => {
    const { blocks } = parseBlocks(CSS);
    // 这几条是事故现场：它们曾经整段掉进 prefers-reduced-motion 里。
    for (const selector of ['.md .mdimg', '.imgview', '.attach-list']) {
      const hit = blocks.find((b) => b.selector === selector);
      expect(hit, `找不到规则 ${selector}，是不是被改名了？改名请同时更新这条用例`).toBeTruthy();
      expect(hit.ancestors, `${selector} 被裹在 ${hit.ancestors.join(' > ')} 里了`).toEqual([]);
    }
  });
});
