'use strict';
/* 首页分类网格的响应式断点：窄视口必须降列数，否则 .home-cat 溢出视口。
 *
 * ============ 锁的是哪次事故 ============
 * 真机视口走查（CDP Emulation 5 档宽度 x 4 个视图）发现：800x600 与
 * 640x500 下 .home-cat 右缘超出视口（.hc-name/.hc-count 被截在窗外）。
 * 根因是 .home-cats 固定 repeat(4, 1fr)，全项目此前没有任何宽度断点。
 * 修复后 1023px 以下降为两列，20 个组合全部无溢出。
 *
 * 【为什么不能只用行为断言】要触发必须真实渲染 + 改视口（CDP），
 * CI 无交互桌面会 SKIP，等于没有守卫；所以锁 CSS 形态。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, ROOT } = require('./lib/harness');

t('CSS4 首页分类网格必须有窄视口断点', () => {
  const css = fs.readFileSync(path.join(ROOT, 'css', 'app.css'), 'utf8');
  /* 锁的是：固定 4 列且无媒体查询覆盖 —— 窄窗口下分类卡片溢出视口。 */
  assert.ok(/\.home-cats\s*\{[^}]*repeat\(4,\s*1fr\)/.test(css), '.home-cats 应保持 4 列基准');
  /* 锁的是：断点被删（修复回退）。 */
  const mq = css.match(/@media\s*\(max-width:\s*\d+px\)\s*\{\s*\.home-cats\s*\{[^}]*repeat\(2/);
  assert.ok(mq, '缺少窄视口降两列的 @media 覆盖（.home-cats 会在 ≤800px 溢出）');
  /* 锁的是：断点宽度不合理 —— 大于 1024 会在常规尺寸降列（大屏排满更好看），
   * 小于 800 则断点不生效。 */
  const w = mq && parseInt(mq[0].match(/max-width:\s*(\d+)/)[1], 10);
  assert.ok(w >= 800 && w <= 1023, '断点宽度 ' + w + ' 不在合理区间 [800,1023]');
});

done();
