'use strict';
const assert = require('assert');
const { t, done, readMain } = require('./lib/harness');
const { scanBrace } = require('../lib/src-scan');
const mainSrc = readMain({ raw: true });

/* 定时任务归一化的行为测试（原 test-round13 的 3a / 3b / 3c / 24）。
 *
 * 锁的是：clean 类型的 hhmm 被丢掉（用户设的 03:00 变成默认时间）、
 * daily / loop 的既有语义被改坏、以及 armAllSchedules 在建窗后
 * 立刻对还没加载完的页面发确认提示（弹窗落在一个空白页上）。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

/* ---------------- 以下助手随 round13 的用例一起迁来 ----------------
 * 都从主进程/渲染层源码里抽出**真实现**来跑，不是手写副本
 * （副本会与实现分叉，那样测试就假绿了）。 */
function loadNormSchedule() {
  /* 【不用注释当右边界】原实现靠「生成不重复的本地 id」那条注释定位结束，
   * 注释一改就报「找不到 normSchedule」。
   * 这段包含三个顶层声明（SCHED_TYPES / SCHED_MIN_EVERY_MIN / normSchedule），
   * 所以取「SCHED_TYPES 起 → normSchedule 函数体配平结束为止」。 */
  const start = mainSrc.indexOf('const SCHED_TYPES');
  assert.ok(start > 0, '找不到 SCHED_TYPES');
  const fnAt = mainSrc.indexOf('function normSchedule', start);
  assert.ok(fnAt > start, '找不到 normSchedule');
  const open = mainSrc.indexOf('{', fnAt);
  const end = scanBrace(mainSrc, open);
  assert.ok(end > open, 'normSchedule 括号不配平');
  return new Function(mainSrc.slice(start, end) + '\nreturn { normSchedule, SCHED_TYPES };')();
}

t('3a normSchedule：clean 类型必须保留用户选的 hhmm', () => {
  const { normSchedule } = loadNormSchedule();
  const out = normSchedule({ type: 'clean', hhmm: '03:00', message: '' });
  assert.strictEqual(out.hhmm, '03:00',
    'clean 任务的 hhmm 被丢掉了 —— armSchedule 会退回默认 09:00，界面也会显示 undefined。实际 ' + JSON.stringify(out));
});

t('3b normSchedule：daily 行为不变，非法时间仍然拒绝', () => {
  const { normSchedule } = loadNormSchedule();
  assert.strictEqual(normSchedule({ type: 'daily', hhmm: '9:05', message: 'x' }).hhmm, '09:05',
    'daily 的补零行为不该变');
  assert.throws(() => normSchedule({ type: 'daily', hhmm: '25:00', message: 'x' }), /超出范围/);
  assert.throws(() => normSchedule({ type: 'clean', hhmm: 'abc' }), /HH:MM/);
});

t('3c normSchedule：loop 仍只需要 everyMin，且不接受 NaN', () => {
  const { normSchedule } = loadNormSchedule();
  const r = normSchedule({ type: 'loop', everyMin: 15, message: 'hi' });
  assert.strictEqual(r.everyMin, 15);
  assert.ok(!('hhmm' in r), 'loop 不该带 hhmm');
  assert.throws(() => normSchedule({ type: 'loop', everyMin: 'abc' }), /数字/);
});

/* ==================== 4. zip 同名子目录不互相覆盖 ==================== */
/* zip:compress 的 handler 体是 async 的，抽出来时要包成 AsyncFunction。 */

t('24 armAllSchedules：不能在建窗后立刻对未加载完的页面发确认提示', () => {
  /* 定位到 applyHotkey 之后、冒烟测试之前的那一小段（周期任务武装处），
   * 只在这一段里查，避免命中文件别处（createWindow 里也有 did-finish-load）造成的假绿。 */
  /* 【右边界不用注释】原实现找「冒烟测试：遍历全部工具页」那句注释。
   * 那段是 whenReady 回调里的代码，注释一改就定位失败。
   * 改用 whenReady 回调体的括号配平。 */
  const from = mainSrc.indexOf('applyHotkey(storeGet');
  assert.ok(from > 0, '定位不到 applyHotkey 调用处');
  const readyAt = mainSrc.lastIndexOf('app.whenReady(', from);
  assert.ok(readyAt > 0, '找不到 app.whenReady');
  const readyOpen = mainSrc.indexOf('{', mainSrc.indexOf('(', readyAt));
  const readyEnd = scanBrace(mainSrc, readyOpen);
  assert.ok(readyEnd > from, 'whenReady 回调括号不配平');
  const to = readyEnd;
  const seg = mainSrc.slice(from, to);
  /* 允许的形态只有两种：包在 isLoading() 判断里，或包在 did-finish-load 回调里。
   * 裸的 `armAllSchedules();`（上一行不是 if / 回调）才算缺陷 —— 用「前一行」判断。 */
  const lines = seg.split('\n');
  const bare = lines.findIndex((l, i) => {
    if (!/^\s*armAllSchedules\(\);/.test(l)) return false;
    const prev = (lines[i - 1] || '').trim();
    return !(/^if\s*\(/.test(prev) || /did-finish-load/.test(prev));
  });
  assert.strictEqual(bare, -1,
    '仍在建窗后同步 armAllSchedules：loop 任务的「已生效」确认提示会发给还没订阅的渲染层');
  assert.ok(/did-finish-load/.test(seg), '应等页面加载完再武装');
  assert.ok(/isLoading\(\)/.test(seg), '已加载完的情况要直接武装，不能一直等');
});

/* ==================== 25. path-guard：递归删除必须更严 ==================== */

done();
