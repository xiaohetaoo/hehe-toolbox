'use strict';
const { t, done } = require('./lib/harness');
/* lib/fail-text.js 的行为测试（任务 2 的样板）。
 *
 * 这三条断言是「行为断言」的标准形态：跑真实现，断言**返回值内容**，
 * 不看源码文本。对照一下被它取代的那两条源码断言——
 * /alertBox\({[\s\S]{0,200}部分文件未能重命名/ 锁的是源码版面，
 * 而且锁的恰是错误写法（见 lib/fail-text.js 顶部说明）。
 */
const assert = require('assert');
const { buildFailText } = require('../lib/fail-text');

t('成功 3 失败 2：明细里有两个文件名、两个目标名、两条原因', () => {
  const failures = [
    { from: 'D:/a/one.txt', to: 'D:/a/one.md', err: '被占用' },
    { from: 'D:/a/two.txt', to: 'D:/a/two.md', err: '拒绝访问' },
  ];
  const text = buildFailText(3, failures);
  assert.ok(text.includes('one.txt'), '缺少源文件名');
  assert.ok(text.includes('one.md'), '缺少目标名');
  assert.ok(text.includes('被占用'), '缺少失败原因');
  assert.ok(text.includes('two.txt') && text.includes('拒绝访问'), '第二条失败项被吞掉了');
  assert.ok(text.includes('成功 3 个') && text.includes('失败 2 个'),
    '成功/失败计数不对，首行是：' + text.split('\n')[0]);
  // 反面对照：空串正是「弹出空白框」的表现，必须排除
  assert.ok(text.trim().length > 20, '明细文本过短，弹出来接近空白：' + JSON.stringify(text));
});

t('失败 17 个：只列 15 条，并说明还有 2 个未列出', () => {
  const many = Array.from({ length: 17 }, (_, k) => ({ from: 'f' + k, to: 'g' + k, err: 'err' + k }));
  const text = buildFailText(0, many);
  assert.ok(text.includes('…还有 2 个未列出'), '超过 15 条时没说明剩余数量');
  assert.ok(text.includes('err14'), '第 15 条应该被列出（上限 15）');
  assert.ok(!text.includes('err15'), '第 16 条不该被列出');
  assert.ok(!text.includes('err16'), '第 17 条不该被列出');
});

t('失败 0 个：返回只有计数头，不带任何明细', () => {
  const text = buildFailText(5, []);
  assert.strictEqual(text, '成功 5 个，失败 0 个：\n\n',
    '失败为空时不应拼出明细或截断提示，实际：' + JSON.stringify(text));
});

/* 边界：非数组 / 缺字段 / 自定义 limit
 * 为什么要测：这两个入口都来自用户操作后的循环，failures 一定是数组；
 * 但 limit 是可选参数，且历史上被误传过 0（会被 `|| 15` 兜回默认值）。
 * 把兜底行为锁住，避免以后改这里时静默变成「一条都不列」。 */
t('边界：failures 非数组按空处理，limit 传 0 回退默认 15', () => {
  assert.strictEqual(buildFailText(0, null), '成功 0 个，失败 0 个：\n\n');
  const many = Array.from({ length: 20 }, (_, k) => ({ from: 'a' + k, to: 'b' + k, err: 'e' + k }));
  const zero = buildFailText(0, many, 0);
  assert.ok(zero.includes('…还有 5 个未列出'), 'limit=0 应回退成 15（列 15 条、剩 5 条）');
  const three = buildFailText(0, many, 3);
  assert.ok(three.includes('…还有 17 个未列出'), 'limit=3 时应剩 17 条');
  assert.ok(!three.includes('e3'), 'limit=3 时第 4 条不该被列出');
});

/* 双环境一致性：渲染层拿到的是同一个函数（不是复制品）。
 * 这条必须存在，否则「共用一份实现」只是口头承诺。 */
t('lib/fail-text.js 在 node 与浏览器两种加载方式下导出同一个实现', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fail-text.js'), 'utf8');
  /* 锁的是：「lib/fail-text.js 在 node 与浏览器两种加载方式下导出同一个实现」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/module\.exports\s*=\s*api/.test(src), 'node 分支没有导出');
  /* 锁的是：「lib/fail-text.js 在 node 与浏览器两种加载方式下导出同一个实现」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/root\.FailText\s*=\s*api/.test(src), '浏览器分支没有挂 window.FailText');
  /* 用 vm 模拟浏览器分支：把 module 藏掉，只留 globalThis */
  const vm = require('vm');
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.ok(sandbox.FailText && typeof sandbox.FailText.buildFailText === 'function',
    '浏览器分支没有产出 FailText.buildFailText');
  /* 同一个输入必须产出同一段文本 —— 若哪天有人只改了一边，这里会红 */
  const args = [1, [{ from: 'x', to: 'y', err: 'z' }]];
  assert.strictEqual(sandbox.FailText.buildFailText(...args), buildFailText(...args),
    '两个分支的实现已分叉（输出不一致）');
});

done();
