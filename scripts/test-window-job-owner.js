'use strict';
/* 窗口关闭 → 它启动的后台任务必须被取消；事件不许漏到别的窗口。
 *
 * ============ 锁的是哪个回归 ============
 * v0.6.0 引入独立工具窗口后多了一条真实路径（现有测试没覆盖）：
 *   独立窗里跑着 ffmpeg 转换 → 用户直接关掉那个窗口
 *   → 任务继续在后台跑（closed 只把窗口从 toolWindows 里过滤掉，没有取消任务）
 *   → 之后每条 job:stream 命中 send() 的"调用者已销毁"分支，
 *     在老代码里会**回退到主窗口**
 *   → 主窗若开着同一个工具页，JobPrefix.subscribe 的「首次匹配即认领」
 *     会把这个外来任务当成自己的：进度条乱跳、结束时弹「完成」。
 * 而用户手里那个 jobId 已经随窗口消失，连取消都做不到。
 *
 * ============ 为什么是行为测试而不是源码断言 ============
 * 这两件事都能抽成纯函数/纯类，脱离 Electron 直接跑：
 *   lib/job-owner.js   OwnerJobMap —— 假的 jobs 表 + 假 webContents 就能验
 *   lib/ipc-route.js   pickSendTarget —— 三个入参三个返回值
 * 源码断言只能证明"写了 broadcast/判断"，证明不了"关掉的窗口的任务真的被取消了"，
 * 也证明不了"该丢的时候没回退"。所以这里全部走真实现。
 *
 * 【刻意不 spawn 任何进程】任务用假的 cancel 函数，只看它有没有被调用。
 */
const { t, done, assert } = require('./lib/harness');
const { OwnerJobMap } = require('../lib/job-owner');
const { pickSendTarget } = require('../lib/ipc-route');

/* 假的 webContents：id 是主进程里真正用来判归属的那个值。 */
function fakeWC(id, destroyed) {
  return { id, isDestroyed: () => !!destroyed };
}

/* ---------- ① 任务归属 ---------- */

t('J1 任务登记时自动记下发起它的窗口 id（调用点不用改）', () => {
  const jobs = new OwnerJobMap(() => 42);
  jobs.set('avc1', { cancel() {} });
  assert.strictEqual(jobs.get('avc1').ownerWC, 42,
    '没有打上 ownerWC —— 关窗时就无法判断这条任务归谁');
});

t('J2 没有调用者时 ownerWC 是 null（托盘/定时任务不属于任何窗口）', () => {
  const jobs = new OwnerJobMap(() => null);
  jobs.set('dl1', { cancel() {} });
  assert.strictEqual(jobs.get('dl1').ownerWC, null);
});

t('J3 getOwner 抛异常也不能让任务登记失败', () => {
  /* ALS 在某些极端时序下取不到 store；那时宁可丢掉归属信息，
   * 也不能让 jobs.set 抛 —— 抛出去等于这个工具彻底不能用了。 */
  const jobs = new OwnerJobMap(() => { throw new Error('no ALS context'); });
  jobs.set('job1', { cancel() {} });
  assert.strictEqual(jobs.size, 1, '取归属失败不该阻止任务登记');
  assert.strictEqual(jobs.get('job1').ownerWC, null);
});

t('J4 关窗时该窗口的任务被 cancel 且从表里移除（锁的就是孤儿任务）', () => {
  let cur = 7;
  const jobs = new OwnerJobMap(() => cur);
  let cancelled = 0;
  cur = 7; jobs.set('avc1', { cancel: () => { cancelled++; } });
  cur = 7; jobs.set('avc2', { cancel: () => { cancelled++; } });
  cur = 9; jobs.set('avc3', { cancel: () => { cancelled++; } });   // 另一个窗口的

  const n = jobs.cancelOwnedBy(7);
  assert.strictEqual(n, 2, '应取消 2 个（实际 ' + n + '）');
  assert.strictEqual(cancelled, 2, 'cancel() 没有真的被调用');
  assert.strictEqual(jobs.has('avc1'), false, '取消后必须从 jobs 表移除');
  assert.strictEqual(jobs.has('avc2'), false);
  assert.strictEqual(jobs.has('avc3'), true, '别的窗口的任务被误杀了');
});

t('J5 取消一个窗口的任务不会波及"没有归属"的任务', () => {
  /* 托盘/定时任务 ownerWC 是 null。若拿 null 当查询条件去遍历，
   * 它们会被整批误杀 —— 用户关一个工具窗口，后台的定时任务全没了。 */
  const jobs = new OwnerJobMap(() => null);
  let cancelled = 0;
  jobs.set('job1', { cancel: () => { cancelled++; } });
  const n = jobs.cancelOwnedBy(null);
  assert.strictEqual(n, 0, 'null 不该匹配任何任务');
  assert.strictEqual(cancelled, 0, '无归属的任务被误杀了');
  assert.strictEqual(jobs.size, 1);
});

t('J6 某个任务的 cancel 抛异常时，其余任务照样被清账', () => {
  /* 漏一个任务留在表里，比少杀一个更麻烦：它会在主窗口那边冒充别人的任务。
   * 所以 cancel 失败也要继续删。 */
  const jobs = new OwnerJobMap(() => 3);
  jobs.set('a1', { cancel() { throw new Error('进程已退出'); } });
  jobs.set('a2', { cancel() {} });
  const n = jobs.cancelOwnedBy(3);
  assert.strictEqual(n, 2, '异常导致后面的任务漏掉了');
  assert.strictEqual(jobs.size, 0, 'cancel 抛异常的任务仍应被移除');
});

t('J7 取消过程中任务自己删自己（handler 的 finally）不会漏掉后面的条目', () => {
  /* 真实形态：cancel() → 子进程被杀 → handler 的 finally 执行 jobs.delete(id)。
   * 边遍历边删，Map 迭代器会跳过后续条目 —— 所以实现里先取了快照。 */
  const jobs = new OwnerJobMap(() => 5);
  jobs.set('b1', { cancel() { jobs.delete('b1'); } });
  jobs.set('b2', { cancel() { jobs.delete('b2'); } });
  jobs.set('b3', { cancel() {} });
  const n = jobs.cancelOwnedBy(5);
  assert.strictEqual(n, 3, '自删导致后续条目被跳过（应 3，实际 ' + n + '）');
  assert.strictEqual(jobs.size, 0);
});

/* ---------- ② 推送该发给谁 ---------- */

t('S1 有活着的调用者 → 发给他（不广播）', () => {
  assert.strictEqual(pickSendTarget(fakeWC(1, false)), 'sender');
});

t('S2 没有调用者（托盘/定时/启动期）→ 退回主窗口', () => {
  assert.strictEqual(pickSendTarget(null), 'fallback');
  assert.strictEqual(pickSendTarget(undefined), 'fallback');
});

t('S3 调用者已销毁 → 丢弃，不许回退（锁的就是串扰）', () => {
  /* 这是问题 2 的核心判据：回退本来是给"没有调用者"准备的兜底，
   * 用在"调用者已死"的场景只会把别人的任务进度甩到主窗口。 */
  assert.strictEqual(pickSendTarget(fakeWC(2, true)), 'drop');
});

t('S4 isDestroyed 自己抛异常时按已销毁处理（丢弃）', () => {
  /* webContents 已释放时 isDestroyed 可能抛。此时任何发送都会失败，
   * 退回主窗口只会制造串扰 —— 按"已销毁"判是唯一安全的选择。 */
  const broken = { id: 3, isDestroyed() { throw new Error('Object has been destroyed'); } };
  assert.strictEqual(pickSendTarget(broken), 'drop');
});

t('S5 三档判据互斥且穷尽（不存在第四种结果）', () => {
  const cases = [null, undefined, fakeWC(1, false), fakeWC(2, true)];
  for (const c of cases) {
    const r = pickSendTarget(c);
    assert.ok(['sender', 'fallback', 'drop'].indexOf(r) >= 0, '出现了未定义的档位：' + r);
  }
});

/* ---------- ③ 主进程侧的接线（只能读源码，说明见下） ---------- */

const { readSrc } = require('./lib/harness');
const mainSrc = readSrc('main.js');

t('W1 独立窗口的 closed 会清掉它启动的任务', () => {
  /* 锁的是：v0.6.0 的 closed 只做 toolWindows.filter，任务变孤儿。
   * 逻辑已由 J1–J7 行为覆盖，这里只确认主进程把它接上了。 */
  assert.ok(/jobs\.cancelOwnedBy\(wcId\)/.test(mainSrc),
    'closed 里没有调用 jobs.cancelOwnedBy —— 关窗后任务会变成孤儿');
  /* 锁的是：没在创建时记下 webContents.id —— closed 触发时已取不到 id，
   * 清账逻辑会拿 null 去查，一个任务都删不掉。 */
  assert.ok(/webContents\.id/.test(mainSrc),
    '没有在创建时记下 webContents.id —— closed 触发时已取不到 id');
});

t('W2 send() 用的是三档判据，而不是"发不出去就回退"', () => {
  /* 锁的是：调用者已销毁时仍然回退主窗口那条串扰路径。
   * 判据本身已由 S1–S5 行为覆盖，这里只确认 main.js 的 send() 真的在用它 ——
   * 而不是又写回老形态 `if (target && !target.isDestroyed()) { send } else { 回退 }`。
   *
   * 【为什么必须取函数体再断言，而不是全文 includes】实测验证过：
   * 把老形态原封不动加回去、把 switch 留在后面（不可达），全文里
   * pickSendTarget( 仍然存在，一条 `includes` 的断言照样 PASS —— 假绿。
   * 所以用 extractFn 精确取出 send 的体，只在体内判。 */
  const sendFn = require('../lib/src-scan').extractFn(mainSrc, 'function send(ev, data)', 'send');
  /* 锁的是：send() 没用三档判据（判据逻辑本身已由 S1–S5 行为覆盖，
   * 这里确认主进程真的接上了它而不是自己又写一遍）。
   * 只能用源码断言：这是"某个函数有没有调用某个东西"的结构事实。 */
  assert.ok(/pickSendTarget\(/.test(sendFn), 'send() 里没有用 pickSendTarget');
  /* 锁的是：调用者已销毁时仍然回退主窗口那条串扰路径。 */
  assert.ok(!/target\s*&&\s*!target\.isDestroyed\(\)/.test(sendFn),
    'send() 里还留着「活着就发、否则回退」的老写法 —— 调用者已销毁时就会串扰');
  /* 锁的是：丢弃时静默 —— 排查「进度条不动」时分不清"没发"和"被丢弃"。 */
  assert.ok(/丢弃推送/.test(sendFn), '丢弃分支没有留下可排查的日志（要求不静默）');
  /* 丢弃分支必须**在**回退之前：写在后面等于永远走不到。 */
  const iDrop = sendFn.indexOf('丢弃推送');
  const iFallback = sendFn.indexOf('ipcCtx.send(');
  assert.ok(iDrop > 0 && iFallback > iDrop, '丢弃分支没有排在回退之前（写反了等于没写）');
});

done();
