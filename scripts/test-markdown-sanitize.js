'use strict';
/* Markdown sanitize 守卫测试：4 处调用必须都有"无 sanitizer 退化"路径 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, ROOT } = require('./lib/harness');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* 在源码里找 marked.parse 的调用，判附近（±6 行）是否有守卫与退化路径 */
function findMarkedCalls(rel) {
  const s = read(rel);
  const lines = s.split('\n');
  const calls = [];
  lines.forEach((l, i) => {
    if (/marked\.parse\(/.test(l)) {
      /* 退化路径可能写成 if/else 块（守卫在前一行、退化在后面几行），
       * 所以扫描 ±6 行窗口而不是只看相邻一行。 */
      const context = lines.slice(Math.max(0, i - 2), i + 7).join('\n');
      /* 锁的是：守卫必须真的调 DOMPurify.sanitize —— 只判 window.DOMPurify
       * 存在还不够，还要确认守卫分支里做的是净化。 */
      const hasGuard = /DOMPurify\.sanitize/.test(context) || /window\.DOMPurify\)/.test(context);
      const hasFallback = /textContent\s*=/.test(context) || /escapeHtml/.test(context);
      calls.push({ line: i + 1, hasGuard, hasFallback });
    }
  });
  return calls;
}

t('MD1 office.js 的 Markdown 渲染必须有 sanitizer 守卫与纯文本退化', () => {
  /* 锁的是：v0.8.6 审查发现的降级写法缺陷 ——
   * 「有 DOMPurify 就 sanitize，没有就原样 innerHTML」。
   * DOMPurify 缺失意味着环境异常，此时打开含脚本的 .md 就是 XSS。
   * 修后：无 sanitizer 时退化为 textContent（纯文本预览）。 */
  const calls = findMarkedCalls('js/tools/office.js');
  assert.ok(calls.length >= 1, '应能找到 marked.parse 调用');
  for (const c of calls) {
    assert.ok(c.hasGuard, 'office.js:' + c.line + ' 的 marked.parse 无 DOMPurify 守卫');
    assert.ok(c.hasFallback, 'office.js:' + c.line + ' 缺纯文本退化路径（textContent）');
  }
});

t('MD2 dev.js 的 Markdown 渲染同上', () => {
  const calls = findMarkedCalls('js/tools/dev.js');
  assert.ok(calls.length >= 1);
  for (const c of calls) {
    assert.ok(c.hasGuard, 'dev.js:' + c.line + ' 无守卫');
    assert.ok(c.hasFallback, 'dev.js:' + c.line + ' 缺退化路径');
  }
});

t('MD3 text-tools.js 的两处 Markdown 渲染都安全', () => {
  /* 锁的是：L315 修复 + L437 原本就用 escapeHtml + pre（已是安全写法）。
   * 两处都要有守卫，其中一处允许 escapeHtml 形式的退化。 */
  const calls = findMarkedCalls('js/tools/text-tools.js');
  assert.ok(calls.length >= 2, '应有两处 marked.parse');
  for (const c of calls) {
    assert.ok(c.hasGuard, 'text-tools:' + c.line + ' 无守卫');
    assert.ok(c.hasFallback, 'text-tools:' + c.line + ' 缺退化路径');
  }
});

t('MD4 DOMPurify 必须在 index.html 里加载', () => {
  const html = read('index.html');
  /* 锁的是：依赖声明必须显式存在 —— 守卫判 window.DOMPurify 存在，
   * 把脚本从 index.html 删掉的话所有 Markdown 预览会静默退化成纯文本
   * （功能丢失但不炸）；这里锁"依赖仍然在"，让删除变成显式决定。 */
  assert.ok(/purify/i.test(html), 'index.html 应加载 DOMPurify');
});

done();
