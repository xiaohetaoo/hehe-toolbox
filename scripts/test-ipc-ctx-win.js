'use strict';
/* ctx.win 必须按需读（getter），不能被解构成常量。
 *
 * ============ 锁的是哪个回归 ============
 * `const { win } = ctx;` 会在**解构那一刻**立刻求值 getter。而
 * ipc/media-ffmpeg.js 的 register 在 main.js 顶层执行，远早于
 * `createWindow()`（后者在 app.whenReady 里），所以拿到的恒是 null；
 * 此后即使主窗建好、关闭重建，这个值也不会变。
 *
 * ipc/ctx.js 头部专门写了「这些值在进程生命周期里会变，用快照会
 * 『第一次能用、换窗口就不对』，所以做成 getter」—— 机制写对了，
 * 用法又错回去了。
 *
 * 后果：`dialog.showOpenDialog(null, …)` 合法但退化成**无父窗口**的对话框：
 * 不居中、不是主窗的模态子窗口，用户开着对话框还能继续点主窗
 * （容易连点出好几个）；在独立工具窗口里点「选择 ffmpeg.exe」时也不归属那个窗口。
 *
 * ============ 验证方式 ============
 * ① 结构：模块里不得出现 `const { ... win ... } = ctx`。
 * ② 行为：真 register 一次（此时 ctx.win 为 null），再把 ctx.win 换成假窗口，
 *    调 FFMPEG.PICK，断言 dialog 收到的 browserWindow 是**后者**。
 *    这条能成立，靠的正是"每次读 getter"。
 */
const { t, done, assert, readSrc } = require('./lib/harness');

t('P1 media-ffmpeg 不再把 ctx.win 解构成常量', () => {
  /* 锁的是：FFmpeg 选择对话框永远没有父窗口（不居中、非模态、可连点出多个）。
   * 只能用源码断言的一部分 —— "有没有解构"是文本事实；
   * 真正的行为由 P2 覆盖。 */
  const src = readSrc('ipc/media-ffmpeg.js');
  const decls = [...src.matchAll(/const\s*\{([^}]*)\}\s*=\s*ctx\s*;/g)].map((x) => x[1]);
  const hasWin = decls.some((d) => /(^|[,{\s])win([,}\s]|$)/.test(d));
  assert.strictEqual(hasWin, false,
    'media-ffmpeg 仍把 win 从 ctx 解构成常量 —— 它恒为 null（register 早于 createWindow）'
    + (decls.length ? '\n  ctx 解构: ' + decls.join(' | ') : ''));
  /* 而且必须真的用 ctx.win 去开对话框（不能干脆不传父窗口） */
  /* 锁的是：干脆不传父窗口 —— 也会退化成无父窗口对话框，与快照 bug 同样糟。 */
  assert.ok(/showOpenDialog\(\s*ctx\.win/.test(src),
    'showOpenDialog 没有用 ctx.win 作父窗口 —— 会退化成无父窗口对话框');
});

t('P2 行为：register 时 win 为 null，之后换成假窗口，PICK 收到的父窗口是后者', () => {
  /* 锁的是：getter 被快照 → 永远拿 null。行为断言：
   * 用真模块真注册，在两次不同的 ctx.win 下观察 dialog 收到了什么。 */
  const env = makePickEnv({ win: null });
  const handlers = new Map();
  const reg = require('../ipc/media-ffmpeg');

  /* register 时主窗还没建（win=null），这与真实启动顺序一致 */
  reg(env.ctx, env.deps(handlers));

  const pick = handlers.get('ffmpeg:pick');
  assert.ok(typeof pick === 'function', '没有注册 ffmpeg:pick');

  /* 现在主窗建好了 */
  env.setWin(env.fakeMain);

  return pick({}).then(() => {
    /* dialog 收到的第一个参数就是 browserWindow */
    assert.strictEqual(env.dialogCalls.length, 1, 'dialog 没被调用');
    const parent = env.dialogCalls[0];
    assert.strictEqual(parent, env.fakeMain,
      'PICK 传给 dialog 的父窗口不是当前主窗（拿到了 null 或旧值）——'
      + ' 说明 ctx.win 被快照了');
  });
});

/* 造一套 PICK 需要的环境：假 dialog、假 ctx（win 可换）、最小 deps。 */
function makePickEnv(opts) {
  const state = { win: opts && opts.win ? opts.win : null };
  const dialogCalls = [];
  /* 假 dialog 模块：不能在 deps 里注入（模块自己 require('electron')），
   * 所以这里用 require.cache 注入一个假的 electron。 */
  const fakeElectron = {
    dialog: {
      showOpenDialog: (...args) => {
        /* electron 的签名有两种：showOpenDialog(win, opts) 与 showOpenDialog(opts)。
         * 模块用的是前者，这里按参数个数判断，并记录"父窗口"那一个。 */
        dialogCalls.push(args.length >= 2 ? args[0] : undefined);
        return Promise.resolve({ canceled: true, filePaths: [] });
      },
    },
    app: { getPath: () => require('os').tmpdir(), isPackaged: false },
    nativeTheme: { shouldUseDarkColors: false },
  };
  const realPath = require.resolve('electron');
  require.cache[realPath] = {
    id: realPath, filename: realPath, loaded: true, exports: fakeElectron,
  };

  const fakeMain = { isDestroyed: () => false, id: 1 };
  const ctx = {
    get win() { return state.win; },      // ← 关键：真 getter
    jobs: new Map(),
    isWin: true,
    isMac: false,
    nextJobSeq: () => 1,
    send: () => {},
  };
  const notNeeded = (n) => () => { throw new Error('测试桩不该被调用：' + n); };
  const deps = (handlers) => ({
    handle: (ch, fn) => handlers.set(ch, fn),
    send: () => {},
    runCmd: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    pathExists: () => false,
    shortErr: (e) => String((e && e.message) || e),
    fmtErr: (e) => String((e && e.message) || e),
    storeGet: () => null,
    storeSet: () => true,
    moveFile: notNeeded('moveFile'),
    uniqueTarget: notNeeded('uniqueTarget'),
    setLatestCancelable: () => {},
    tempDir: () => require('os').tmpdir(),
    userDataDir: () => require('os').tmpdir(),
    pathGuard: {},
    tempNames: {},
    targetSize: notNeeded('targetSize'),
    AdmZip: notNeeded('AdmZip'),
    downloadToFile: notNeeded('downloadToFile'),
  });
  return {
    ctx,
    deps,
    fakeMain,
    dialogCalls,
    setWin: (w) => { state.win = w; },
  };
}

done();
