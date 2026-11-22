'use strict';
/* R16：取消/离开窗口的行为回归。
 *
 * ============ 为什么要这个文件 ============
 * 前几轮的测试多为「源码正则」或「手动模拟状态」，无法抓住真正的缺陷：
 *   · 用户点开始 → invoke 还没返回 → 点停止：**取消完全无效**，
 *     invoke 返回后任务照样启动（jobId 此刻还是 null）。
 *   · 首条 job:stream 抢先认领 jobId → invoke 返回时页面已离开：
 *     旧 finally 看到 jobId 非空就不清理，监听器/进度/按钮全部残留。
 *   · arm 不检查 shutdown 的退出码：系统拒绝排期，界面照样开始倒计时。
 *   · cancel 吞掉失败：取消失败时界面说"已取消"，到点照样关机。
 *
 * 本文件的做法：**把真实函数体抠出来，喂 fake invoke / fake DOM / 可控
 * Promise**，驱动真实的取消时序。断言落在"是否调用 JOB.KILL"、
 * "界面状态是什么"、"有没有弹成功提示"这些可观察结果上。
 */

const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

/* ---------------- 通用工具 ---------------- */

/** 从源码里取一个函数的完整体（按花括号配平）。 */
function extractFn(src, signature) {
  const i = src.indexOf(signature);
  assert.ok(i >= 0, '找不到函数：' + signature);
  const braceStart = src.indexOf('{', i + signature.length - 1);
  let depth = 0, end = -1;
  for (let k = braceStart; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  assert.ok(end > braceStart, '花括号不配平：' + signature);
  return src.slice(i, end);
}

/** 可控 Promise：外部决定何时 resolve/reject。 */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 让出若干个微任务周期。 */
const tick = (n = 6) => new Promise((r) => setTimeout(r, n));

/* ==================================================================
 * C1 arm：shutdown 退出码非零不得启动倒计时
 * ================================================================== */

/* 锁的是 P0：arm 在 await EXEC.RUN 之后不检查返回码 ——
 * 系统拒绝排期（1116 权限/1190 已有计划）时界面照样倒计时并承诺会关机。 */
t('C1-1 shutdown 返回非零时不得 arm、不得显示成功文案', async () => {
  const src = readSrc('js/tools/sys-tools.js', { raw: true });
  const iApply = src.indexOf('async function apply()');
  assert.ok(iApply > 0, '找不到 apply');
  const applyBody = extractFn(src, 'async function apply()');

  /* 取"关机/重启"分支：从 `shutdown /` 的模板串开始，到 `} else {` 之前 */
  const iRun = applyBody.indexOf('shutdown /');
  assert.ok(iRun > 0, '找不到 shutdown 的 invoke');
  /* 往前退到 `try {`，往后找到该 try 块的结尾（花括号配平） */
  const tryStart = applyBody.lastIndexOf('try {', iRun);
  assert.ok(tryStart > 0, '找不到 shutdown 的 try 块');
  let depth = 0, end = -1;
  for (let k = applyBody.indexOf('{', tryStart); k < applyBody.length; k++) {
    if (applyBody[k] === '{') depth++;
    else if (applyBody[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  assert.ok(end > tryStart, 'shutdown 分支花括号不配平');
  /* 从 try 块起点取到 `arm(confirmMsg` 之后的 status 赋值结束 */
  const armIdx = applyBody.indexOf('arm(confirmMsg', tryStart);
  assert.ok(armIdx > tryStart, '找不到 arm 调用');
  const statusEnd = applyBody.indexOf('\n', applyBody.indexOf('status.textContent =', armIdx));
  const seg = applyBody.slice(tryStart, statusEnd + 1);

  const armed = [];
  const toasts = [];
  let statusText = '';
  const fn = new Function(
    'invoke', 'toast', 'arm', 'confirmBox', 'window', 'Channels', 'mins', 'm', 'confirmMsg',
    `let status = { textContent: '' };
     return (async () => {
       ${seg}
       return status.textContent;
     })();`
  );
  const out = await fn(
    async () => ({ code: 1116, stdout: '', stderr: '拒绝访问。' }),
    (m, lvl) => toasts.push([m, lvl]),
    (...a) => armed.push(a),
    async () => true,
    { api: { errText: (e) => String((e && e.message) || e) }, App: {} },
    { CHANNELS: { EXEC: { RUN: 'exec:run' } } },
    30, 'shutdown', '关机'
  );
  statusText = String(out || '');

  /* 锁的是：非零退出码仍然 arm —— 界面会开始倒计时并承诺关机。 */
  assert.strictEqual(armed.length, 0, 'shutdown 退出码 1116 时仍然 arm 了（假成功）');
  /* 锁的是：失败时没有报错提示（用户以为已排期）。 */
  assert.ok(toasts.some(([, lvl]) => lvl === 'error'), '失败时没有 error 提示');
  /* 锁的是：失败时 status 仍写了"系统将在 N 分钟后执行"。 */
  assert.ok(!/分钟后/.test(statusText), '失败时仍显示"N 分钟后执行"，实际：' + statusText);
});

/* 锁的是：非零码的错误提示里要说明原因，不能只说"失败"。 */
t('C1-2 shutdown 失败提示必须带退出码与原因', () => {
  const src = readSrc('js/tools/sys-tools.js', { raw: true });
  const iRun = src.indexOf("shutdown /");
  assert.ok(iRun > 0);
  const seg = src.slice(iRun, iRun + 1800);
  /* 锁的是：只看有没有抛错、不看 code（假成功）。 */
  assert.ok(/code !== 0/.test(seg), '没有检查 shutdown 的退出码');
  /* 锁的是：失败提示不含退出码（用户无法判断是无权限还是已有计划）。 */
  assert.ok(/退出码/.test(seg), '失败提示没有带退出码');
});

/* ==================================================================
 * C2 cancel：必须收集真实结果，全成功才清状态
 * ================================================================== */

/* 锁的是 P0：cancel 吞掉失败后无条件写"已取消定时任务"。 */
t('C2-1 取消失败时不得显示"已取消"，且必须保留可操作状态', async () => {
  const src = readSrc('js/tools/sys-tools.js', { raw: true });
  const cancelBody = extractFn(src, 'async function cancel()');

  /* 用真实 cancel 函数体，注入会失败的 invoke */
  const state = { mode: '关机', targetTs: Date.now() + 600000 };
  let countdownText = '', countdownCls = '', statusText = '', statusHTML = '';
  const toasts = [];
  const fn = new Function(
    'invoke', 'toast', 'loadOnce', 'window', 'Channels',
    'countdown', 'status', 'st',
    `let mode = st.mode, targetTs = st.targetTs, timer = null;
     ${cancelBody}
     return cancel;`
  );
  const countdown = {
    set textContent(v) { countdownText = v; }, get textContent() { return countdownText; },
    set className(v) { countdownCls = v; }, get className() { return countdownCls; },
  };
  const status = {
    set textContent(v) { statusText = v; }, get textContent() { return statusText; },
    set innerHTML(v) { statusHTML = v; }, get innerHTML() { return statusHTML; },
  };
  const cancelFn = fn(
    /* invoke：shutdown /a 抛错（模拟权限不足） */
    async (ch) => { throw new Error('拒绝访问'); },
    (m, lvl) => toasts.push([m, lvl]),
    async () => {},
    { api: { errText: () => '拒绝访问' } },
    { CHANNELS: { EXEC: { RUN: 'exec:run' }, SCHED: { ONCE_LIST: 'sched:list', ONCE_REMOVE: 'sched:rm' } } },
    countdown, status, state
  );
  await cancelFn();

  /* 锁的是：取消失败却写了"已取消定时任务（含系统关机计划）"。 */
  assert.ok(!/已取消定时任务/.test(statusText), '取消失败却显示"已取消定时任务"');
  /* 锁的是：失败时倒计时被写成"已取消"（用户以为安全了）。 */
  assert.ok(!/^已取消$/.test(countdownText), '取消失败却把倒计时写成"已取消"');
  /* 锁的是：失败时没有明确告知"仍在生效"。 */
  assert.ok(/失败|仍在生效/.test(statusHTML + statusText), '没有告知用户计划可能仍在生效');
  /* 锁的是：失败时弹了 info/success 而不是 error。 */
  assert.ok(toasts.some(([, lvl]) => lvl === 'error'), '取消失败没有 error 提示');
});

/* 锁的是：部分 ONCE_REMOVE 失败仍报"已取消"。 */
t('C2-2 部分一次性定时撤销失败也必须如实报告', async () => {
  const src = readSrc('js/tools/sys-tools.js', { raw: true });
  const cancelBody = extractFn(src, 'async function cancel()');
  const state = { mode: '睡眠', targetTs: Date.now() + 60000 };
  let statusHTML = '', statusText = '';
  const toasts = [];
  let removeCalls = 0;
  const fn = new Function(
    'invoke', 'toast', 'loadOnce', 'window', 'Channels',
    'countdown', 'status', 'st',
    `let mode = st.mode, targetTs = st.targetTs, timer = null;
     ${cancelBody}
     return cancel;`
  );
  const cancelFn = fn(
    async (ch) => {
      if (ch === 'exec:run') return { code: 0 };
      if (ch === 'sched:list') return [{ id: 'a', action: 'sleep' }, { id: 'b', action: 'lock' }];
      if (ch === 'sched:rm') {
        removeCalls++;
        /* 第二个撤销失败 */
        if (removeCalls === 2) throw new Error('计划不存在或权限不足');
        return { ok: true };
      }
      return null;
    },
    (m, lvl) => toasts.push([m, lvl]),
    async () => {},
    { api: { errText: (e) => String((e && e.message) || e) } },
    { CHANNELS: { EXEC: { RUN: 'exec:run' }, SCHED: { ONCE_LIST: 'sched:list', ONCE_REMOVE: 'sched:rm' } } },
    {
      set textContent(v) {}, get textContent() { return ''; },
      set className(v) {}, get className() { return ''; },
    },
    {
      set textContent(v) { statusText = v; }, get textContent() { return statusText; },
      set innerHTML(v) { statusHTML = v; }, get innerHTML() { return statusHTML; },
    },
    state
  );
  await cancelFn();

  /* 锁的是：第一条失败后循环 break，剩下的定时没被撤销 —— 而界面说"已取消"。 */
  assert.strictEqual(removeCalls, 2, '每个一次性定时都必须尝试撤销（不能中途放弃）');
  /* 锁的是：部分失败仍显示成功文案。 */
  assert.ok(!/已取消定时任务/.test(statusText), '部分撤销失败却显示"已取消定时任务"');
  /* 锁的是：部分失败没有 error 提示。 */
  assert.ok(toasts.some(([, lvl]) => lvl === 'error'), '部分撤销失败没有 error 提示');
});

/* 锁的是：全部成功时仍要正常清状态（不能因为加严而永远报错）。 */
t('C2-3 全部成功时正常显示已取消并清空状态机', async () => {
  const src = readSrc('js/tools/sys-tools.js', { raw: true });
  const cancelBody = extractFn(src, 'async function cancel()');
  let statusText = '', countdownText = '';
  const fn = new Function(
    'invoke', 'toast', 'loadOnce', 'window', 'Channels',
    'countdown', 'status', 'st',
    `let mode = st.mode, targetTs = st.targetTs, timer = null;
     ${cancelBody}
     return { cancel, st: () => ({ mode, targetTs }) };`
  );
  const st = { mode: '关机', targetTs: Date.now() + 600000 };
  const api = fn(
    async (ch) => {
      if (ch === 'exec:run') return { code: 0 };
      if (ch === 'sched:list') return [];
      return null;
    },
    () => {},
    async () => {},
    { api: { errText: String } },
    { CHANNELS: { EXEC: { RUN: 'exec:run' }, SCHED: { ONCE_LIST: 'sched:list', ONCE_REMOVE: 'sched:rm' } } },
    {
      set textContent(v) { countdownText = v; }, get textContent() { return countdownText; },
      set className(v) {}, get className() { return ''; },
    },
    {
      set textContent(v) { statusText = v; }, get textContent() { return statusText; },
      set innerHTML(v) {}, get innerHTML() { return ''; },
    },
    st
  );
  await api.cancel();
  /* 锁的是：成功路径被"加严"改坏（永远报失败）。 */
  assert.ok(/已取消定时任务/.test(statusText), '全部成功时应显示"已取消定时任务"，实际：' + statusText);
  assert.strictEqual(countdownText, '已取消');
  const after = api.st();
  /* 锁的是：成功后没清 mode/targetTs（onEnter 会复活倒计时）。 */
  assert.strictEqual(after.mode, '', '成功后 mode 没清空');
  assert.strictEqual(after.targetTs, 0, '成功后 targetTs 没清零');
});

/* ==================================================================
 * C3 下载页：停止在 jobId 返回前点击必须生效
 * ================================================================== */

/* 锁的是 P1：stop 只在 jobId 存在时才 kill —— 取消窗口无效。 */
t('C3-1 下载：首条流事件先认领 jobId、invoke 后返回、页面已离开 → 必须彻底收尾', async () => {
  const src = readSrc('js/tools/net-tools.js', { raw: true });
  /* 【必须定位到**下载页**的 start】net-tools 里 Ping 也有一份
   * `async function start()` 且排在前面的。用下载页独有的状态声明做锚点。 */
  const anchor = src.indexOf('let jobId = null, unsub = null;');
  assert.ok(anchor > 0, '找不到下载页的状态声明');
  const iStart = src.indexOf('async function start()', anchor);
  assert.ok(iStart > anchor, '下载页状态声明之后找不到 start');
  const startBody = extractFn(src.slice(iStart - 20), 'async function start()');

  let progHidden = false;
  let startDisabled = true, stopDisabled = false;
  const subs = [];

  const fn = new Function(
    'invoke', 'toast', 'urlIn', 'fileIn', 'prog', 'status', 'startBtn', 'stopBtn',
    'JobPrefix', 'Channels', 'window', 'safeNameFromUrl', 'isDesktop', 'state',
    `let jobId = state.jobId, unsub = state.unsub, downloadRunSeq = state.seq;
     ${startBody}
     /* 把内部状态暴露给测试：cleanup 的等价动作是 ++downloadRunSeq + dropSub。
      * 必须操作**闭包内**的变量，改外部 state.seq 是无效的（这正是本测试
      * 第一次写错的地方 —— 它"通过"了但根本没走到过期分支）。 */
     return {
       start,
       /* 模拟页面 cleanup */
       cleanup() { downloadRunSeq++; if (unsub) { try { unsub(); } catch (e) {} unsub = null; } },
       peek() { return { jobId, seq: downloadRunSeq }; },
     };`
  );
  const state = { jobId: null, unsub: null, seq: 0 };
  const api = fn(
    async (ch) => {
      if (ch === 'app:get-info') return { userData: 'C:/tmp' };
      if (ch === 'net:download') {
        /* invoke 挂起：稍后由测试 resolve */
        return state.pending.promise;
      }
      return null;
    },
    () => {},
    { value: 'https://example.com/a.bin' },
    { value: '' },
    { show() {}, hide() { progHidden = true; }, set() {} },
    { textContent: '' },
    { get disabled() { return startDisabled; }, set disabled(v) { startDisabled = v; } },
    { get disabled() { return stopDisabled; }, set disabled(v) { stopDisabled = v; } },
    /* 【下载页用的是 window.JobPrefix，不是裸标识符】 */
    null,
    { CHANNELS: { NET: { DOWNLOAD: 'net:download' }, JOB: { KILL: 'job:kill' }, APP: { GET_INFO: 'app:get-info' } } },
    {
      api: { errText: String, isDev: false },
      JobPrefix: {
        subscribe(prefix, cb) {
          const sub = { prefix, cb, alive: true };
          subs.push(sub);
          state.sub = sub;
          state.streamCb = cb;
          return () => { sub.alive = false; };
        },
      },
    },
    () => 'a.bin',
    true,      // isDesktop
    state
  );

  state.pending = deferred();
  const p = api.start();
  await tick();
  /* 模拟：首条 job:stream 抢先把 jobId 认领 */
  if (state.streamCb) {
    try { state.streamCb({ id: 'dlg-1', data: JSON.stringify({ pct: 10 }) }); } catch (e) {}
  }
  /* 模拟：页面离开 —— 用**闭包内**的等价动作（++seq + dropSub） */
  api.cleanup();
  /* 现在让 invoke 返回 */
  state.pending.resolve({ id: 'dlg-1' });
  await p;
  await tick();

  /* 锁的是：旧 finally 只看 jobId 非空就不清理 —— 监听器/进度/按钮全残留。
   * 现在必须：进度隐藏、按钮复位。 */
  assert.strictEqual(progHidden, true, '过期分支没有隐藏进度条（界面停在"下载中"）');
  assert.strictEqual(startDisabled, false, '过期分支没有恢复开始按钮');
  assert.strictEqual(stopDisabled, true, '过期分支没有禁用取消按钮');
  /* 锁的是：过期分支没把内部 jobId 清掉（后续 finally 会误判还有活任务）。 */
  assert.strictEqual(api.peek().jobId, null, '过期分支没有清空 jobId');
});

/* ==================================================================
 * C4 系统定时：onEnter 的过期分支必须清状态
 * ================================================================== */

/* 锁的是 P2：onEnter 写"已触发"却不清 mode → cleanup 覆盖成"已交给系统"。 */
t('C4-1 onEnter 过期分支必须清 mode/targetTs，之后 cleanup 不得改写文案', () => {
  const src = readSrc('js/tools/sys-tools.js', { raw: true });
  /* 取 onEnter 回调里"过期"那一段 */
  const iOver = src.indexOf("targetTs - Date.now() <= 0");
  assert.ok(iOver > 0, '找不到 onEnter 的过期判定');
  const seg = src.slice(iOver, iOver + 700);
  /* 锁的是：只写"已触发"不清状态机 —— cleanup 会把它改写成"已交给系统"。 */
  assert.ok(/mode = ''/.test(seg), '过期分支没有清 mode');
  assert.ok(/targetTs = 0/.test(seg), '过期分支没有清 targetTs');
  /* 锁的是：文案仍是裸"已触发"（没说明已结束，用户可能以为还会执行）。 */
  assert.ok(/已触发（已结束）|已触发\(已结束\)/.test(seg), '过期分支文案没有说明"已结束"');
});

/* ==================================================================
 * C5 局域网扫描：离开后状态行与按钮必须复位
 * ================================================================== */

/* 锁的是 P2/P3：离开页面后返回，状态行仍写"正在扫描…"、按钮仍灰。 */
t('C5-1 lan-scan 离开后必须复位状态行与按钮，返回后不显示"正在扫描中"', () => {
  const src = readSrc('js/tools/lan-scan.js', { raw: true });
  /* 取 cleanup 注册的那一段 */
  const iCl = src.indexOf('window.App.onCleanup(');
  assert.ok(iCl > 0, '找不到 cleanup');
  const seg = src.slice(iCl, iCl + 900);
  /* 锁的是：cleanup 只 prog.hide() 不改文案/按钮 —— 用户返回时以为卡死。 */
  assert.ok(/scanBtn\.disabled = false/.test(seg), 'cleanup 没有恢复扫描按钮');
  assert.ok(/status\.textContent =/.test(seg), 'cleanup 没有更新状态行');
  /* 锁的是：文案没有告知"上一轮作废"，用户不知道后台还在收尾。 */
  assert.ok(/作废|收尾/.test(seg), 'cleanup 文案没有说明上一轮扫描的处置');
});

/* ==================================================================
 * C6 停止在 jobId 返回前点击：必须真的停住（本轮最核心的取消窗口）
 * ================================================================== */

/* 锁的是 P1：`if (jobId) kill` 在 jobId 还是 null 的窗口里完全无效，
 * 而 start 恢复后 token 未变 → 任务照样启动（ping -t 永不退出）。 */
t('C6-1 Ping：invoke 返回前点停止 → 不得进入运行中，且返回后不得留下任务', async () => {
  const src = readSrc('js/tools/net-tools.js', { raw: true });
  /* Ping 页的 start 在文件中第一个（下载页的在后） */
  const startBody = extractFn(src, 'async function start()');

  const kills = [];
  let startDisabled = false, stopDisabled = true;
  let streamSubs = 0;
  const pending = deferred();

  /* 【stop 也要用真实现】单独抠 stop 的函数体，与 start 共用同一批闭包变量。
   * 不能手写 stop 的副本 —— 那样测试会与实现分叉（这正是本文件开头强调的）。 */
  const stopBody = extractFn(src.slice(src.indexOf('async function stop()') - 20), 'async function stop()');

  const fn2 = new Function(
    'invoke', 'toast', 'hostIn', 'term', 'startBtn', 'stopBtn', 'isDesktop',
    'on', 'Channels', 'window', 'state',
    `let jobId = null, unsubStream, unsubExit;
     let latencies = [], sent = 0, recv = 0, running = false;
     let pingRunSeq = 0;
     function updateStats() {}
     const chart = { draw() {} };
     ${startBody}
     ${stopBody}
     return {
       start, stop,
       peek: () => ({ jobId, running, seq: pingRunSeq }),
     };`
  );

  const api = fn2(
    /* invoke：EXEC.STREAM 挂起，稍后返回一个 job id */
    async (ch) => {
      if (ch === 'exec:stream') return pending.promise;
      if (ch === 'job:kill') { kills.push(ch); return true; }
      return null;
    },
    () => {},
    { value: 'www.example.com' },
    { innerHTML: '', appendChild() {}, children: [], scrollTop: 0 },
    { get disabled() { return startDisabled; }, set disabled(v) { startDisabled = v; } },
    { get disabled() { return stopDisabled; }, set disabled(v) { stopDisabled = v; } },
    true,
    (ev, cb) => { if (ev === 'job:stream') streamSubs++; return () => {}; },
    { CHANNELS: { EXEC: { STREAM: 'exec:stream' }, JOB: { KILL: 'job:kill' } } },
    { api: { errText: String } },
    {}
  );

  /* 点开始（invoke 挂起中） */
  const pStart = api.start();
  await tick();
  /* 【关键时序】此刻 jobId 还是 null，用户点停止 */
  await api.stop();
  /* 停止后立刻可见的效果 */
  const afterStop = api.peek();
  /* 锁的是：停止后 running 仍为 true（界面显示"运行中"）。 */
  assert.strictEqual(afterStop.running, false, '点停止后 running 仍为 true');
  /* 锁的是：停止后按钮没复位（用户以为还在跑）。 */
  assert.strictEqual(startDisabled, false, '点停止后"开始"按钮仍禁用');
  assert.strictEqual(stopDisabled, true, '点停止后"停止"按钮仍可用');

  /* 现在让 invoke 返回一个新的 job id */
  pending.resolve('ping-job-1');
  await pStart;
  await tick();

  /* 锁的是：停止后 start 恢复，任务照样被记下来并订阅（取消无效）。
   * 正确行为：token 已过期 → start 必须自己把刚建出的 job kill 掉，
   * 且不得写入 jobId、不得订阅。 */
  assert.strictEqual(api.peek().jobId, null, '过期后仍把 jobId 写进去了（任务未取消）');
  assert.ok(kills.length >= 1, '过期分支没有 kill 刚建出的 job（ping -t 会在后台常驻）');
  /* 锁的是：过期后仍然订阅了事件（监听器泄漏）。 */
  assert.strictEqual(streamSubs, 0, '过期后仍建立了 job:stream 订阅');
});

done();
