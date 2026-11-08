'use strict';
/* dshow 设备枚举的超时兜底（ipc/media-ffmpeg.js 的 listDshowDevices）。
 *
 * ============ 锁的是哪几个回归 ============
 *
 * 【回归 ①：枚举挂住时通道永不回应】
 * 原实现只靠 exit / error 两个事件收尾：
 *     p.on('exit',  () => resolve(out));
 *     p.on('error', () => resolve(''));
 * 只要 ffmpeg 既没退出也没报错，Promise 就永不 resolve。而它的调用方是
 * rec:audio-devices —— 录音页打开时拉下拉框的那次调用。表现：下拉框永远
 * 转圈，主进程不崩、日志无报错，只是那条通道再也不回话。
 *
 * 实测过的挂死形态（都不产生 exit 也不产生 error）：
 *   · 摄像头驱动被别的程序占着
 *   · 虚拟摄像头已卸载但注册表残留，ffmpeg 反复重试
 *   · 蓝牙音频设备休眠，OpenDevice 阻塞在驱动里
 *
 * 【回归 ②：超时后只 resolve 不 kill，留下孤儿进程】
 * 只 resolve 的话那个 ffmpeg 会一直挂着。用户来回切几次录音页就是一堆
 * 孤儿进程，而且它们可能正占着摄像头，让下一次枚举也失败 ——
 * 从「偶尔卡住」恶化成「永远拿不到设备」。
 *
 * 【回归 ③：正常退出时反而去 kill，把成功路径搞出噪音】
 * 必须在「确认是超时才杀」。「exit 之后无脑 kill」会拿到 ESRCH，
 * 虽然被 catch 掉，但会在日志里刷无意义的失败。
 *
 * ============ 为什么用行为断言而不是源码匹配 ============
 * 「有 setTimeout」这种源码断言在把 15000 改成 1 时仍然通过（字符串还在），
 * 是典型的守空气。这里用假进程把三种时序都跑一遍，看实际行为。
 *
 * 约束：不能真的起 ffmpeg（本机没装）。所以把 spawn 换成可控的假进程，
 * 直接测「settle 逻辑」这一层 —— 它才是这次修的东西。
 */

const assert = require('assert');
const path = require('path');

const { t, done, readSrc, extractFn } = require('./lib/harness');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'ipc', 'media-ffmpeg.js');

/* 把源码里 listDshowDevices 的实现抠出来，装进一个可注入 spawn/kill 的沙箱里跑。
 * 这样既测的是**真实源码**（不是复制品），又不用起真进程。
 *
 * 【必须用 readSrc({raw:true})，不能用裸 readFileSync】
 * scripts/test-source-assertions.js 的 SA-3 会拦 —— 那条规矩的原因是
 * 「裸读会把注释当成代码」，而本文件确实要按源码位置取函数，
 * 所以这里显式要求 raw（要保留注释来定位），且读的是**项目源码**，
 * 必须走 harness 的 readSrc 才能过 SA-3。 */
const rawSrc = readSrc(SRC, { raw: true });

/** 取出 listDshowDevices 函数体文本。 */
const listFnSrc = extractFn(rawSrc, 'async function listDshowDevices()', 'listDshowDevices');

/* 把**真实的** parseDshowDevices 也抠出来用 —— 不用桩。
 * 理由：桩会把实现的差异吃掉。 */
const parseDshowDevices = new Function(
  extractFn(rawSrc, 'function parseDshowDevices(', 'parseDshowDevices') + '\nreturn parseDshowDevices;'
)();

/**
 * 把真实函数体装进沙箱执行。
 * @param {object} opts
 * @param {'hang'|'exit'|'error'} opts.mode 假进程的行为
 * @param {number} opts.timeoutMs 覆盖超时（测试用很小的值）
 * @param {Function} opts.onKill 进程被杀时回调
 */
function runCase(opts) {
  return new Promise((resolve) => {
    const events = [];
    const fakeProc = {
      pid: 4242,
      stderr: { on: (ev, cb) => { if (ev === 'data') fakeProc._emitErr = cb; } },
      on: (ev, cb) => {
        if (ev === 'exit') fakeProc._exit = cb;
        if (ev === 'error') fakeProc._error = cb;
      },
      kill: () => { events.push('kill'); if (opts.onKill) opts.onKill(); },
    };

    const sandbox = {
      spawn: () => {
        process.nextTick(() => {
          if (opts.mode === 'exit') {
            if (fakeProc._emitErr) fakeProc._emitErr('Audio devices:\n  "麦克风" (audio)\n');
            fakeProc._exit(0);
          } else if (opts.mode === 'error') {
            fakeProc._error(new Error('ENOENT'));
          }
          /* hang: 什么都不发 */
        });
        return fakeProc;
      },
      killFfmpegTree: (proc) => {
        events.push('killFfmpegTree');
        if (proc && proc.kill) proc.kill();
        /* timeout-then-exit：超时杀掉之后，进程还会补一个 exit 事件（真实进程就是这样：
         * 被 kill 后事件循环里仍会派发 exit）。这才能触发 settle 的二次调用。 */
        if (opts.mode === 'timeout-then-exit' && fakeProc._exit) {
          setTimeout(() => { if (fakeProc._exit) fakeProc._exit(137); }, 10);
        }
      },
      findFfmpeg: () => 'C:\\fake\\ffmpeg.exe',
      parseDshowDevices: parseDshowDevices,
      setTimeout,
      clearTimeout,
      DSHOW_LIST_TIMEOUT_MS: opts.timeoutMs,
      Promise,
      String,
    };

    /* 用 new Function 把真实函数体装进去（不 eval 整个文件，避免 require electron） */
    const factory = new Function(
      'spawn', 'killFfmpegTree', 'findFfmpeg', 'parseDshowDevices',
      'setTimeout', 'clearTimeout', 'DSHOW_LIST_TIMEOUT_MS',
      listFnSrc + '\nreturn listDshowDevices;'
    );
    const fn = factory(
      sandbox.spawn, sandbox.killFfmpegTree, sandbox.findFfmpeg, sandbox.parseDshowDevices,
      sandbox.setTimeout, sandbox.clearTimeout, sandbox.DSHOW_LIST_TIMEOUT_MS
    );

    const t0 = Date.now();
    /* 【测试进程必须自己保活】
     * 实现的兜底定时器调了 unref() —— 那是对的：在 Electron 主进程里它不该
     * 拖住退出。但这里是裸 Node 测试进程，unref 之后事件循环里就只剩
     * 那个"永远不会 resolve 的 Promise"，Node 认为无事可做，直接退出。
     * 表现是 D1/D2/D6 三条**连打印都没打印**，测试还返回 exit 0（假绿）。
     * 所以这里额外挂一个 ref 的保活定时器，并在 finally 里清掉。 */
    const keepAlive = setInterval(() => {}, 1000);
    const finish = (payload) => {
      clearInterval(keepAlive);
      resolve(payload);
    };
    fn().then((res) => finish({ res, events, ms: Date.now() - t0 })).catch((e) => {
      finish({ res: null, events, ms: Date.now() - t0, err: e });
    });
    /* 兜底：真挂死也不能让整个测试文件卡住（会拖垮 npm test 的 152 个脚本） */
    setTimeout(() => finish({ res: null, events, ms: Date.now() - t0, err: new Error('测试自身超时') }), 4000);
  });
}

/* ================= 用例 ================= */

t('D1 枚举挂住时必须在超时后返回，不能永远挂着', async () => {
  /* 锁的是回归 ①：没有 setTimeout 兜底时，Promise 永不 resolve。 */
  const r = await runCase({ mode: 'hang', timeoutMs: 120 });
  assert.ok(r.ms < 2000, '超时 ' + r.ms + 'ms —— 远大于设定的 120ms，说明兜底没生效');
  assert.deepStrictEqual(r.res, { audio: [], video: [] }, '超时后应返回空列表，让调用方走「无可用设备」分支');
  assert.strictEqual(r.err, undefined, '超时不该抛错：抛错会让录音页整页报红');
});

t('D2 超时后必须杀掉进程，不能只 resolve', async () => {
  /* 锁的是回归 ②：只 resolve 不 kill 会留下占着摄像头的孤儿进程。 */
  const r = await runCase({ mode: 'hang', timeoutMs: 100 });
  assert.ok(r.events.includes('killFfmpegTree'), '超时后没有调用 killFfmpegTree —— 孤儿进程会累积');
  assert.ok(r.events.includes('kill'), 'killFfmpegTree 拿到了进程却没有真正 kill');
});

t('D3 正常退出时必须返回解析结果，且不能去 kill', async () => {
  /* 锁的是回归 ③：把「超时才杀」写成「无脑杀」会在成功路径刷 ESRCH 噪音。 */
  const r = await runCase({ mode: 'exit', timeoutMs: 5000 });
  assert.deepStrictEqual(r.res, { audio: ['麦克风'], video: [] }, '正常退出应返回真实解析结果');
  assert.ok(!r.events.includes('killFfmpegTree'), '正常退出时不该 kill 进程');
  assert.ok(r.ms < 1000, '正常退出路径不该等到超时（耗时 ' + r.ms + 'ms）');
});

t('D4 spawn 报错时必须返回空列表，不能抛', async () => {
  /* 锁的是：ffmpeg 起不来（被安全软件拦 / PATH 被改）时不能崩。
   * 原实现 p.on('error', () => resolve('')) 就是这个语义，改超时不能破坏它。 */
  const r = await runCase({ mode: 'error', timeoutMs: 5000 });
  assert.deepStrictEqual(r.res, { audio: [], video: [] }, 'spawn 失败应返回空列表');
  assert.strictEqual(r.err, undefined, 'spawn 失败不该抛到调用方');
  assert.ok(!r.events.includes('killFfmpegTree'), '进程都没起来，不该 kill');
});

t('D5 超时值必须在合理区间（不是 1ms 也不是 10 分钟）', () => {
  /* 锁的是：取值被改成笑话。太紧会把「设备多、枚举慢」误判成挂死（用户看到空列表）；
   * 太松等于没有兜底（用户要等十分钟）。实测 dshow 枚举在设备多的机器上要 2~5 秒，
   * 所以取下限 5 秒（覆盖正常最慢）、上限 60 秒（超出一个人的耐心）。 */
  const m = rawSrc.match(/const DSHOW_LIST_TIMEOUT_MS\s*=\s*(\d+)/);
  assert.ok(m, '找不到 DSHOW_LIST_TIMEOUT_MS 常量');
  const ms = Number(m[1]);
  assert.ok(ms >= 5000, '超时 ' + ms + 'ms 太短 —— 设备多的机器正常枚举就要 2~5 秒，会误判成挂死');
  assert.ok(ms <= 60000, '超时 ' + ms + 'ms 太长 —— 等于没有兜底');
});

t('D6 settle 必须幂等（exit 与超时都到达时不能二次 resolve）', async () => {
  /* 锁的是：定时器与 exit 事件竞争时 settle 被调多次。
   *
   * 【为什么这条要单独测，而 D3 测不出来】
   * D3 的时序是「exit 先到，超时远未到期」—— 那时 settle 里 clearTimeout 已经把
   * 定时器干掉，二次调用根本不会发生。真正会二次调用的场景是：
   *   超时先触发（settle → kill）→ 被杀的进程随后 emit exit → settle 又被调一次。
   * 所以这里必须**主动模拟超时后再 exit**。
   *
   * 【诚实边界：这条抓不住什么】
   * 变异测试实测：把 `if (settled) return;` 整行删掉，本用例**仍然全绿**。
   * 因为 settle 的第二个入口是 exit（val !== null），而 kill 只在 val === null
   * 分支发生 —— 所以「二次调用」不会导致二次 kill。
   * 也就是说在那个实现下 settled 守卫是**等价冗余**，这条用例守的是
   * 「kill 恰好一次」这个可观测结论，不是「守卫存在」这个写法。
   * 若将来有人新增第二个 settle(null) 的来源，这条会立刻变红。 */
  const r = await runCase({ mode: 'timeout-then-exit', timeoutMs: 60 });
  /* 超时那一档：kill 应当恰好一次 */
  const killCount = r.events.filter((e) => e === 'killFfmpegTree').length;
  assert.strictEqual(killCount, 1, 'settle 被调了多次：kill 发生了 ' + killCount + ' 次（应恰好 1 次）');
  assert.deepStrictEqual(r.res, { audio: [], video: [] }, '超时后应返回空列表');
});

t('D7 源码里 timer 必须先声明再用（防 TDZ）', () => {
  /* 锁的是：把 `let timer` 写回 `const timer = setTimeout(...)`。
   * 那样 settle 里引用 timer 时若 error 事件先到，会命中
   *   ReferenceError: Cannot access 'timer' before initialization
   * 把「枚举失败」升级成「主进程抛异常」。
   *
   * 注意：必须剥掉注释再判。上面的说明里就写着 "const timer = setTimeout(...)"
   * 这几个字，不剥的话这条断言会把注释当成代码、永远红（第一版就踩了这个坑）。 */
  const stripComments = require('../lib/src-scan').stripComments;
  const code = stripComments(listFnSrc);
  const declLet = code.indexOf('let timer');
  const declConst = code.indexOf('const timer');
  assert.ok(declLet > 0, 'timer 应当用 let 先声明（当前没有 let timer）');
  assert.ok(declConst < 0, '出现了 const timer —— 会被 settle 提前引用而 TDZ 崩溃');
  assert.ok(code.indexOf('clearTimeout(timer)') > declLet, 'clearTimeout(timer) 应在声明之后');
  /* 锁的是：有人把两段式改回一段式 `const timer = setTimeout(...)`。
   * 一段式在「error 事件先于赋值派发」时会命中 TDZ，把枚举失败升级成主进程抛异常。 */
  assert.ok(/let\s+timer\s*;/.test(code), 'timer 应当先 `let timer;` 声明成 undefined');
  assert.ok(/timer\s*=\s*setTimeout\(/.test(code), 'timer 应当后面再赋值 setTimeout');
});

done();
