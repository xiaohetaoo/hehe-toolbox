'use strict';
/* 三个媒体工具的「防重入标志必须在第一个 await 之前置位」。
 *
 * ============ 锁的是哪个回归 ============
 * av-convert / video-press / video-trim 三个工具的 run() 开头都有
 * `if (running) return;`，但 `running = true` 原来排在
 * `await invoke(FFMPEG.STATUS)`（video-trim 还多一个 `FS.UNIQUE_PATH`）之后。
 *
 * 于是那两次 IPC 往返期间按钮一直可点。用户连点两下，两次调用都会通过
 * `if (running)` 检查，各自生成输出路径、各自 subscribe、各自 invoke 一次长任务：
 *   · 两个 ffmpeg 进程同时写同一批源文件；
 *   · 三个工具共用模块级 runJobId，后者覆盖前者，「取消」只能杀掉一个
 *     （甚至杀错）；
 *   · 两份进度事件混进同一条订阅，进度条来回跳；
 *   · finally 里先结束的那轮会把 running / 按钮全部复位，而另一个任务还在跑 ——
 *     用户此时能再点第三次。
 *
 * ============ 验证方式 ============
 * 把三个工具的 run() **真源码**装进桩里执行（不是读源码形态）：
 *   · FFMPEG.STATUS 用一个可控延迟的 promise —— 就是那个"窗口期"
 *   · 在它兑现之前，同步连调两次 run()
 *   · 断言第二次被 `if (running)` 挡住（长任务只被 invoke 一次）
 * 这比"看源码里 running = true 在第几行"强得多：判据是行为结果，
 * 而且能覆盖"标志提到了前面但 try/finally 写漏导致复位不对"这种半吊子修法。
 */
const { t, done, assert, readSrc } = require('./lib/harness');
const srcScan = require('../lib/src-scan');


/* 三个工具各自的"长任务通道"，用来数到底 invoke 了几次。 */
const CASES = [
  { file: 'js/tools/media/av-convert.js', longCh: 'ffmpeg:convert', name: 'av-convert' },
  { file: 'js/tools/media/video-press.js', longCh: 'ffmpeg:press', name: 'video-press' },
  { file: 'js/tools/media/video-trim.js', longCh: 'ffmpeg:trim', name: 'video-trim' },
];

/* 从工具源码里取出 run 函数体。
 * 三个文件的 run 都定义在 render(page) 里，形如 `async function run() {`。 */
function extractRun(relPath) {
  const src = readSrc(relPath);
  return srcScan.extractFn(src, 'async function run()', relPath + ' 的 run');
}

/* 用桩跑一次 run()。
 *
 * 【为什么要构造这么多桩】run() 里用到的都是 render 作用域的闭包
 * （picker / startBtn / status / 各种输入框）。这里按最小可用原则给齐，
 * 关键是控制 FFMPEG.STATUS 的**兑现时机**。 */
function makeRunner(relPath, opts) {
  const runSrc = extractRun(relPath);
  const calls = { long: 0, status: 0 };
  let releaseStatus;
  const statusGate = new Promise((r) => { releaseStatus = r; });

  const noop = () => {};
  const fakeBtn = { disabled: false, addEventListener: noop };
  const fakeInput = { value: '00:00/00:01', addEventListener: noop };
  const fakeSel = { value: 'mp4', addEventListener: noop, options: [] };
  const fakeProg = { show: noop, hide: noop, set: noop, el: {} };
  const fakePicker = {
    count: 1, paths: ['C:/tmp/a.mp4'], setLocked: noop, clear: noop,
    list: { add: noop, rowAt: () => null, refresh: noop }, el: {},
  };

  const invoke = (ch) => {
    if (ch === 'ffmpeg:status') { calls.status++; return statusGate.then(() => ({ ffmpeg: 'C:/ffmpeg.exe' })); }
    if (ch === 'fs:unique-path') return Promise.resolve('C:/tmp/a_trim.mp4');
    if (ch === opts.longCh) { calls.long++; return Promise.resolve({ results: [{ ok: true }], size: 1, duration: 1, out: 'x' }); }
    if (ch === 'job:kill' || ch === 'ffmpeg:trim') { calls.long++; return Promise.resolve({}); }
    return Promise.resolve({});
  };

  const params = [
    'invoke', 'Channels', 'picker', 'startBtn', 'cancelBtn', 'status', 'prog',
    'outDirIn', 'fmtSel', 'vcodecSel', 'crfIn', 'scaleSel', 'fpsIn', 'muteChk',
    'ssIn', 'toIn', 'gifWIn', 'codecSel', 'speedSel', 'audioSel', 'stripChk',
    'modeSel', 'startIn', 'durIn', 'meta', 'video', 'previewBox', 'videoInfo',
    'startRow', 'setStartBtn', 'setEndBtn', 'setFullBtn', 'endShow', 'langSel',
    'toast', 'fmtBytes', 'escapeHtml', 'parseClock', 'fmtClock', 'h', 'div', 'btn',
    'progressEl', 'filePicker', 'window', 'App', 'runJobIdBox', 'setRunJobId',
  ];
  const prelude = `
    let running = false;
    let runJobId = null;
    /* video-trim 把开始按钮叫 goBtn，另外两个叫 startBtn —— 三个工具各自
     * 独立演进过命名。这里给个别名，免得为它单独开一套桩。 */
    const goBtn = startBtn;
  `;
  const body = runSrc + '\nreturn { run, getRunning: () => running };';
  const f = new Function(...params, prelude + '\n' + body);

  const runner = f(
    invoke,
    { CHANNELS: {
      FFMPEG: { STATUS: 'ffmpeg:status', CONVERT: 'ffmpeg:convert', PRESS: 'ffmpeg:press', TRIM: 'ffmpeg:trim' },
      FS: { UNIQUE_PATH: 'fs:unique-path', READ_FILE_B64: 'fs:read-file-b64' },
      JOB: { KILL: 'job:kill' },
    } },
    fakePicker, fakeBtn, fakeBtn, { textContent: '', innerHTML: '', style: {} }, fakeProg,
    fakeInput, fakeSel, fakeSel, fakeInput, fakeSel, fakeInput, { checked: false },
    fakeInput, fakeInput, fakeInput, fakeSel, fakeSel, fakeSel, { checked: false },
    fakeSel, fakeInput, fakeInput, { duration: 60 }, {}, {}, {},
    {}, fakeBtn, fakeBtn, fakeBtn, {}, fakeSel,
    noop, (n) => String(n) + 'B', (s) => String(s),
    (v) => 1, (v) => '00:01', noop, noop, noop, fakeProg, noop,
    { JobPrefix: { subscribe: () => () => {} }, App: { openTool: noop, onCleanup: noop } },
    { openTool: noop, onCleanup: noop }, {}, noop);

  return { run: runner.run, calls, release: () => releaseStatus(), getRunning: runner.getRunning };
}

/* ---------- 每个工具一条 ---------- */

for (const c of CASES) {
  t('R-' + c.name + ' 连点两下只启动一个长任务（防重入标志在第一个 await 之前）', async () => {
    /* 锁的是：running 置位排在 await 之后 → 两次 IPC 往返期间按钮可点，
     * 连点起两个 ffmpeg 进程。 */
    const r = makeRunner(c.file, c);
    /* 【关键：不 await】第一次 run 立刻进到 await FFMPEG.STATUS 处挂起，
     * 此刻 running 必须已经是 true —— 否则下面那次调用会穿过去。 */
    const p1 = r.run();
    /* 同一个 microtask 里再点一次 —— 这就是"连点两下" */
    const p2 = r.run();
    /* 放行 STATUS，让两次调用都能继续跑完 */
    r.release();
    await Promise.all([p1, p2]);

    assert.strictEqual(r.calls.long, 1,
      c.name + ' 的长任务被启动了 ' + r.calls.long + ' 次 —— '
      + '第二次没被 if (running) 挡住（防重入标志置得太晚）');
  });
}

t('R-all 三个工具的 run 都以 try/finally 收口（早退路径也要复位）', () => {
  /* 锁的是：把 running = true 提前之后，忘了把复位放进 finally ——
   * 「FFmpeg 未安装」「参数无效」这些早退路径会让按钮永久禁用。
   * 只能用源码断言：要验的是"每条 return 路径都会经过复位"，
   * 那需要为每个工具伪造全部早退条件，成本高于收益；
   * 而"有没有 finally"是结构事实，一眼可见。 */
  for (const c of CASES) {
    const runSrc = extractRun(c.file);
    assert.ok(/finally\s*\{/.test(runSrc),
      c.name + ' 的 run() 没有 finally —— 早退路径不会复位按钮');
    assert.ok(/running\s*=\s*false/.test(runSrc),
      c.name + ' 的 finally 里没有复位 running');
  }
});

t('R-guard 防重入标志确实在第一个 await 之前（结构佐证）', () => {
  /* 行为断言（R-*）已经覆盖了这一点；这里再补一条结构断言，
   * 因为它在失败时能直接指出"第几行的问题"，比行为断言更易定位。
   * 锁的是同一个回归。 */
  for (const c of CASES) {
    const runSrc = extractRun(c.file);
    const iRunning = runSrc.indexOf('running = true');
    const iAwait = runSrc.indexOf('await ');
    assert.ok(iRunning > 0, c.name + ' 里找不到 running = true');
    assert.ok(iAwait > 0, c.name + ' 里找不到 await');
    assert.ok(iRunning < iAwait,
      c.name + ' 的 running = true 排在第一个 await 之后（第 ' + iRunning
      + ' 字符 vs ' + iAwait + '）—— 那段时间按钮可点，连点会起两个任务');
  }
});

done();
