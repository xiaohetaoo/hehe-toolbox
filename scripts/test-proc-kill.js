'use strict';
const assert = require('assert');
const { t, done, readMain } = require('./lib/harness');
const mainSrc = readMain({ raw: true });

/* proc:kill 保护检查的行为测试（原 test-round13 的 13）。
 *
 * 锁的是：进程查询失败时**必须拒绝**，而不是跳过保护检查直接 taskkill。
 * 早期实现把"查不到"当成"不是关键进程"，于是杀掉了不该杀的东西。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

/* ---------------- 以下助手随 round13 的用例一起迁来 ----------------
 * 都从主进程/渲染层源码里抽出**真实现**来跑，不是手写副本
 * （副本会与实现分叉，那样测试就假绿了）。 */


t('13 proc:kill：进程查询失败必须拒绝，而不是跳过保护检查直接 taskkill', () => {
  /* 【断言的目标函数搬到了 killProcessChecked】
   * 原来这段判据直接写在 `handle(CH.PROC.KILL, ...)` 里，测试按通道名取片段。
   * 加「文件占用解锁」时把它抽成了 killProcessChecked（解锁要复用同一份
   * 安全判据），于是 handler 只剩一行转发：
   *     handle(CH.PROC.KILL, async (e, pid) => killProcessChecked(pid));
   * 按通道名取到的片段里已经没有函数体，两条断言随之失效。
   * 现在改成直接定位函数体 —— 断言内容一字未改。 */
  const i = mainSrc.indexOf('async function killProcessChecked(');
  assert.ok(i > 0, '找不到 killProcessChecked（PROC.KILL 的实现函数）');
  const seg = mainSrc.slice(i, i + 2600);
  /* 缺陷形态：一个 try 包住保护判定，catch 里靠中文文本匹配决定是否重抛 */
  /* 锁的是「靠中文文本匹配决定是否重抛」这个缺陷形态：查询机制坏掉时
     * 保护检查会被整体跳过，进程直接被 taskkill。
     * 只能看源码形态 —— 真跑要把进程查询弄坏，那需要注入故障。 */
  assert.ok(!/if \(\/拒绝结束\/\.test\(String\(err\.message\)\)\) throw err;/.test(seg),
    '仍在用中文文本匹配决定是否重抛 —— 查询机制坏掉时保护检查被整体跳过');
  /* 锁的是「查询失败时必须拒绝而不是放行」：拒绝是安全的默认值。
     * 真跑要模拟查询失败，只能靠注入。 */
  assert.ok(/无法确认 PID|进程查询失败/.test(seg),
    '查询失败时应明确拒绝并说明原因');
  /* 锁的是：PROC.KILL 的 handler 绕开 killProcessChecked 自己实现一遍 ——
   * 那样两条路径的判据会分叉（解锁与「结束进程」行为不一致）。 */
  assert.ok(/handle\(CH\.PROC\.KILL, async \(e, pid\) => killProcessChecked\(pid\)\)/.test(mainSrc),
    'PROC.KILL 没有走 killProcessChecked');
});

/* ==================== 14. 下载：取消清理与 416 断点 ==================== */

done();
