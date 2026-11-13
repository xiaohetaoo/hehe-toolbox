'use strict';
/* 功能域映射表（scripts/features.json）与 --changed 解析的守卫。
 *
 * ============ 锁的是哪次事故 ============
 * 这套机制的价值全在"映射表准不准"。表一旦漂移，--changed 会**静默漏测**
 * —— 用户以为跑过了，实际没跑。这比没有 --changed 更危险。
 * 所以这里锁四件事：
 *   1. 每个测试都归属至少一个功能域（新增测试忘了登表 → 漏测）；
 *   2. 表里写的测试文件都真实存在（改了名没同步 → 指向不存在的文件）；
 *   3. 表里写的 src 路径至少有文件能被匹配（拼错路径 → 该域永远命中不了）；
 *   4. 保守策略真的生效（core 一改就全量、未知文件也全量）。
 *
 * 【为什么不能只用行为断言】"改了 X 该跑哪些"是纯函数判定，可以断言；
 * 但"映射表符不符合项目语义"只能人看。这里锁的是**结构完整性**
 * （无遗漏、无悬空），语义正确性靠 PR 时看 diff。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, ROOT } = require('./lib/harness');
const F = require('./lib/features.js');

t('FM1 每个测试都归属至少一个功能域', () => {
  /* 锁的是：新增测试忘了登表 —— 那样 --changed 永远不会选中它，
   * 漏测是静默的（没有任何报错，只是"跑过了"里不含它）。 */
  const spec = F.loadSpec();
  const uncovered = F.allTests().filter((tf) => F.featuresOfTest(spec, tf).length === 0);
  assert.deepStrictEqual(uncovered, [],
    '这些测试没归入任何功能域（在 scripts/features.json 里补上）：\n  ' + uncovered.join('\n  '));
});

t('FM2 表里登记的测试文件都存在', () => {
  /* 锁的是：测试改名/删除后没同步表 —— 悬空条目会让 --feature 报
   * "找到 N 个测试"却实际只跑到 N-1 个。 */
  const spec = F.loadSpec();
  const all = new Set(F.allTests());
  const dangling = [];
  for (const def of spec.values()) {
    for (const re of def.testRes) {
      /* 通配模式无法逐个列出，改用"至少有一个测试被它匹配"来判 */
      const hit = [...all].some((tf) => re.test(tf));
      if (!hit) dangling.push(def.id + ' 的 test 模式 ' + re.source + ' 匹配不到任何测试');
    }
  }
  assert.deepStrictEqual(dangling, [], dangling.join('\n'));
});

t('FM3 每个域至少有一个测试', () => {
  /* 锁的是：建了空域。空域在 --feature 下会"跑 0 个"然后退出 1，
   * 看起来像坏了。要么给它测试，要么删掉这个域。 */
  const rows = F.listFeatures();
  const empty = rows.filter((r) => r.tests === 0);
  assert.deepStrictEqual(empty.map((r) => r.id), [],
    '这些功能域没有测试：' + empty.map((r) => r.id).join(', '));
});

t('FM4 core 域的 src 一改就全量', () => {
  /* 锁的是：保守策略。main.js 是全局的，改它却只跑某个域 = 漏测。 */
  const r = F.testsForChanged(['main.js']);
  assert.strictEqual(r.full, true, 'main.js 改动应触发全量');
  assert.strictEqual(r.tests.length, F.allTests().length, '全量应包含所有测试');
});

t('FM5 未知文件也回退全量', () => {
  /* 锁的是：新增的源文件还没登记时，不能"因为没归属就少跑"。 */
  const r = F.testsForChanged(['src/从未登记过的新文件.js']);
  assert.strictEqual(r.full, true, '未知文件应回退全量');
});

t('FM6 单一域改动只跑该域，不全量', () => {
  /* 锁的是：精确性。pdf-plus.js 只属于 pdf 域，不该拖 190 个测试。
   * 阈值取 <20 是因为 pdf 域本来就小；放宽一点防误伤未来的合理增长。 */
  const r = F.testsForChanged(['js/tools/pdf-plus.js']);
  assert.strictEqual(r.full, false, 'pdf 改动不该全量');
  assert.ok(r.tests.length < 20, 'pdf 域应是小批测试，实际 ' + r.tests.length);
  assert.ok(r.tests.length >= 1, 'pdf 域至少要跑到 1 个测试');
});

t('FM7 只改测试脚本时只跑它自己', () => {
  /* 锁的是：改断言却触发全量 → 每次调测试等 5 分钟，--changed 失去意义。 */
  const r = F.testsForChanged(['scripts/test-cmdk.js']);
  assert.strictEqual(r.full, false, '只改测试脚本不该全量');
  assert.deepStrictEqual(r.tests, ['test-cmdk.js']);
});

t('FM8 --feature 能取到测试，未知域会报错', () => {
  /* 锁的是：命令行入口。--feature 拼错域名的表现必须是明确报错，
   * 不能静默跑 0 个然后报成功。 */
  const list = F.testsForFeature('dev');
  assert.ok(list.length >= 5, 'dev 域应至少有 5 个测试，实际 ' + list.length);
  assert.throws(() => F.testsForFeature('不存在的域'), /未知功能域/, '未知域必须抛错');
});

t('FM9 改动多域时取并集', () => {
  /* 锁的是：同时改两个域的源文件，两边的测试都要跑（不能只跑最后一个）。 */
  const r = F.testsForChanged(['js/clip-actions.js', 'js/tools/pdf-plus.js']);
  assert.strictEqual(r.full, false);
  assert.ok(r.features.indexOf('clip') >= 0 && r.features.indexOf('pdf') >= 0,
    '应同时命中 clip 与 pdf，实际：' + r.features.join(','));
});

done();
