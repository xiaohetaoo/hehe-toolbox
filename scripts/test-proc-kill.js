'use strict';
const assert = require('assert');
const { t, done, readMain } = require('./lib/harness');
const { scanBrace } = require('../lib/src-scan');
const mainSrc = readMain({ raw: true });

/* proc:kill 保护检查的行为测试（原 test-round13 的 13）。
 *
 * 锁的是：进程查询失败时**必须拒绝**，而不是跳过保护检查直接 taskkill。
 * 早期实现把"查不到"当成"不是关键进程"，于是杀掉了不该杀的东西。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

/* ---------------- 以下助手随 round13 的用例一起迁来 ----------------
 * 都从主进程/渲染层源码里抽出**真实现**来跑，不是手写副本
 * （副本会与实现分叉，那样测试就假绿了）。 */

function segFromHandler(channel, label) {
  const start = mainSrc.indexOf("handle('" + channel + "'");
  assert.ok(start > 0, '找不到 handler: ' + channel);
  /* handler 签名里可能有默认参数对象 `opts = {}`，不能取 start 之后的第一个 '{'，
   * 要跳到 `=> {` 之后的那个函数体开括号。 */
  const arrow = mainSrc.indexOf('=>', start);
  const from = arrow > 0 ? arrow : start;
  const open = mainSrc.indexOf('{', from);
  assert.ok(open > 0, 'handler ' + channel + ' 没有函数体');
  const end = scanBrace(mainSrc, open);
  assert.ok(end > open, 'handler ' + channel + ' 括号不配平');
  return mainSrc.slice(start, end);
}

t('13 proc:kill：进程查询失败必须拒绝，而不是跳过保护检查直接 taskkill', () => {
  const seg = segFromHandler('proc:kill');
  /* 缺陷形态：一个 try 包住保护判定，catch 里靠中文文本匹配决定是否重抛 */
  assert.ok(!/if \(\/拒绝结束\/\.test\(String\(err\.message\)\)\) throw err;/.test(seg),
    '仍在用中文文本匹配决定是否重抛 —— 查询机制坏掉时保护检查被整体跳过');
  assert.ok(/无法确认 PID|进程查询失败/.test(seg),
    '查询失败时应明确拒绝并说明原因');
});

/* ==================== 14. 下载：取消清理与 416 断点 ==================== */

done();
