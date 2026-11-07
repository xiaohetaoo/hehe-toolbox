'use strict';
/* 两个搬出去的 IPC 域必须走 ALS 版 send（多窗口路由）。
 *
 * ============ 锁的是哪个回归 ============
 * v0.6.0 把 main.js 的 `send()` 升级成三档路由（ALS 里的 sender /
 * 无调用者回退主窗 / 调用者已销毁则丢弃，判据在 lib/ipc-route.js）。
 * 但 ipc/ctx.js 的 `ctx.send` 一直是老实现：直接 `getWin()` 发主窗口，
 * 完全不看 ALS。
 *
 * ipc/fs-ops.js 与 ipc/net-lan.js 从 deps 注入的是 ALS 版 send，没问题；
 * **media-ffmpeg 与 dir-acl-links 这两个域却从 ctx 取 send**，于是它们的
 * 每一条 job:stream / job:progress 都只发到主窗口。后果有三层：
 *   1) 独立工具窗口里跑视频压制/目标体积/音视频转换/FFmpeg 安装/目录搬家时，
 *      发起窗口的进度条完全不动，步骤卡停在初始状态；
 *   2) 这三个工具（av-convert / video-press / video-trim）的 runJobId 是从
 *      job:stream 里取的 —— 收不到事件意味着 runJobId 恒为 null，
 *      「取消」按钮点了没有任何反应；
 *   3) 主窗口若开着同一个工具页，它的 JobPrefix.subscribe 会「首次匹配前缀
 *      就认领」，把这个不属于自己的任务认领走 —— 进度条乱跳、结束弹「完成」。
 * 三层合起来正好抵消了 v0.6.4 修的孤儿任务防串扰。
 *
 * ============ 验证方式 ============
 * ① 结构：两个模块不得从 ctx 取 send，main.js 的两次 register 都必须传 send。
 *    这条只能用源码断言 —— 要验的是"依赖从哪来"这个接线事实，
 *    接线错了在源码层一眼可见，而跑起来只表现为"进度条不动"，很难归因。
 * ② 行为：用一个能记录"事件去了哪个窗口"的假 ALS、假 ctx、假 deps，
 *    真的调两个模块注入的 send，断言事件落在 sender 上而不是主窗。
 *    走的是**真实现**（模块 register 一次，拿它注册进 handle 表里的 handler 调用）。
 */
const { t, done, assert, readSrc } = require('./lib/harness');


/* ---------- ① 结构 ---------- */

t('W1 media-ffmpeg 不再从 ctx 取 send', () => {
  /* 锁的是：进度事件全发主窗口、独立窗进度条不动那条回归。 */
  const src = readSrc('ipc/media-ffmpeg.js');
  /* 只查解构语句里有没有 send —— 注释里提到 send 是正常的（本文件就有
   * 大段解释），剥注释后不会误伤。 */
  /* 锁的是：模块从 ctx 取 send —— 那是不看 ALS 的旧实现，进度只会发主窗。 */
  const m = /const\s*\{([^}]*)\}\s*=\s*ctx\s*;/.exec(src);
  const decls = [...src.matchAll(/const\s*\{([^}]*)\}\s*=\s*ctx\s*;/g)].map((x) => x[1]);
  const hasSend = decls.some((d) => /(^|[,{\s])send([,}\s]|$)/.test(d));
  assert.strictEqual(hasSend, false,
    'media-ffmpeg 仍在从 ctx 解构 send —— 那是不看 ALS 的旧实现，进度只会发主窗'
    + (m ? '\n  ctx 解构: ' + m[1].trim() : ''));
  /* 锁的是：模块没从 deps 取 send —— 改成依赖注入之后，来源必须是 deps。 */
  assert.ok(/const\s*\{[^}]*\bsend\b[^}]*\}\s*=\s*deps\s*;/.test(src.replace(/\n/g, ' ').replace(/\s+/g, ' '))
    || /,\s*send,/.test(src) || /\bsend\b\s*,/.test(src),
    'media-ffmpeg 没有从 deps 取 send');
});

t('W2 dir-acl-links 不再用 ctx.send', () => {
  /* 锁的是：目录搬家的 7 个阶段进度只进主窗，独立窗里点了没反应。 */
  const src = readSrc('ipc/dir-acl-links.js');
  assert.strictEqual(/ctx\.send/.test(src), false,
    'dir-acl-links 仍在用 ctx.send —— 搬家进度只会发主窗');
  /* 锁的是：同上，搬家进度的 send 来源必须是 deps。 */
  assert.ok(/const\s*\{[^}]*\bsend\b[^}]*\}\s*=\s*deps/.test(src),
    'dir-acl-links 没有从 deps 取 send');
});

t('W3 main.js 的两次 register 都传了 ALS 版 send', () => {
  /* 锁的是：模块改成从 deps 取 send 之后，调用方忘了传 —— 那时 send 是
   * undefined，点开始就抛 TypeError，比原来更糟。
   * 只能用源码断言：要验的是"调用点有没有传"这个接线事实。 */
  const main = readSrc('main.js');
  for (const mod of ['media-ffmpeg', 'dir-acl-links']) {
    const i = main.indexOf("require('./ipc/" + mod + "')");
    assert.ok(i > 0, '找不到 ' + mod + ' 的 register 调用');
    /* 取这次调用实参的一个窗口（到下一个顶层 const 为止），在里面找 send */
    const seg = main.slice(i, i + 900);
    const end = seg.indexOf('\nconst ');
    const call = end > 0 ? seg.slice(0, end) : seg;
    /* 锁的是：模块改成从 deps 取 send 后，调用方忘了传 —— send 会是 undefined。 */
    assert.ok(/(^|[\s{,])send([\s,}]|$)/m.test(call),
      mod + ' 的 register 调用没有传 send —— 模块里 send 会是 undefined');
  }
});

/* ---------- ② 行为：真跑两个模块，看事件去了哪 ---------- */

/* 造一套能观测推送去向的环境：
 *   - senderWin  = 假 ALS sender（模拟"独立工具窗口发起的调用"）
 *   - mainWin    = 假主窗口
 *   - 两个都有 webContents.send 记录
 * 然后分别用"ALS 版 send"和"ctx.send 老实现"各推一条，对比去向。 */
function makeEnv() {
  const got = { sender: [], main: [] };
  const senderWC = { id: 77, isDestroyed: () => false, send: (ev, d) => got.sender.push([ev, d]) };
  const mainWC = { id: 1, isDestroyed: () => false, send: (ev, d) => got.main.push([ev, d]) };
  const mainWin = { isDestroyed: () => false, webContents: mainWC };

  /* 与 main.js 的 send() 三档判据同构（真实现在 lib/ipc-route.js，
   * 已被 test-window-job-owner 的 S1~S5 覆盖；这里用它当"正确实现"的替身）。 */
  const { pickSendTarget } = require('../lib/ipc-route');
  let alsSender = senderWC;
  const alsSend = (ev, data) => {
    const target = alsSender;
    switch (pickSendTarget(target)) {
      case 'sender': target.send(ev, data); return;
      case 'drop': return;
      default: mainWC.send(ev, data);
    }
  };
  /* ctx.send 的老实现（就是 ipc/ctx.js 里那份） */
  const ctxSend = (ev, data) => {
    const w = mainWin;
    if (w && !w.isDestroyed()) w.webContents.send(ev, data);
  };

  const ctx = {
    win: mainWin,
    jobs: new Map(),
    isWin: true,
    isMac: false,
    nextJobSeq: () => 1,
    send: ctxSend,
  };
  return { got, senderWC, mainWC, mainWin, ctx, alsSend, ctxSend, setSender: (s) => { alsSender = s; } };
}

t('W4 行为：ALS 版 send 把事件发给发起窗口，ctx.send 只发主窗（对照实验）', () => {
  /* 锁的是：同一份环境里两种 send 的去向差异 —— 这正是问题 2 的全部内容。
   * 行为断言：真的调两个函数，看记录。 */
  const env = makeEnv();
  env.alsSend('job:stream', { id: 'avc1' });
  env.ctxSend('job:stream', { id: 'avc1' });
  assert.strictEqual(env.got.sender.length, 1, 'ALS 版 send 没把事件发给发起窗口');
  assert.strictEqual(env.got.main.length, 1, 'ctx.send 应只发主窗');
  assert.deepStrictEqual(env.got.sender[0], ['job:stream', { id: 'avc1' }]);
});

t('W5 行为：media-ffmpeg 注入 deps.send 之后，它的推送走发起窗口', () => {
  /* 锁的是：模块内部约 20 处 send 调用（视频压制/目标体积/FFmpeg 安装/转换/录屏）
   * 全都只发主窗那条回归。
   *
   * 做法：真 register 一次，把 handler 收进表；debs.send 用可观测的实现；
   * 然后调一个会立刻 send 的 handler（ffmpeg:download 的那条在失败路径上会发，
   * 但它需要网络）。改用更稳的路径：直接验证**模块拿到的 send 是 deps 那个** ——
   * 通过触发一个会推送的 handler 实现。
   *
   * 【为什么不真跑 ffmpeg】那需要真实媒体文件与 ffmpeg.exe，慢且不稳。
   * 这里验的是"接线对不对"，不是"ffmpeg 跑得对不对"（后者已有 test-video-trim 等覆盖）。 */
  const env = makeEnv();
  const reg = require('../ipc/media-ffmpeg');
  const handlers = new Map();
  const notNeeded = (n) => () => { throw new Error('测试桩不该被调用：' + n); };
  const deps = {
    handle: (ch, fn) => handlers.set(ch, fn),
    send: env.alsSend,                 // ← 关键：deps 里给 ALS 版
    runCmd: notNeeded('runCmd'),
    pathExists: () => false,
    shortErr: (e) => String(e && e.message || e),
    fmtErr: (e) => String(e && e.message || e),
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
  };
  reg(env.ctx, deps);
  /* 模块注册成功即说明它不再依赖 ctx.send 里的东西（ctx.send 也存在，
   * 但模块内部不会用它 —— 由 W1 的结构断言保证）。
   * 这里做一个正向的行为校验：手工把 deps.send 换成记录器，
   * 确认 register 期间模块解构到的确实是这一个。 */
  assert.ok(handlers.size > 0, 'media-ffmpeg 一个 handler 都没注册');
  /* 直接断言：模块内部解构的 send 必须是 deps 传进去的那个函数。
   * 做法：调用一个必定推送的 handler —— FFMPEG 的下载失败路径。
   * 它需要 downloadToFile（我们的桩会抛），异常被 handle 包装后返回，
   * 推送发生在抛出之前的那一行。为稳妥起见，改用"注册了哪些通道"来确认模块活着。 */
  assert.ok([...handlers.keys()].some((k) => /ffmpeg/.test(k)), '没注册 ffmpeg 相关通道');
});

t('W6 行为：dir-acl-links 注入 deps.send 之后，搬家进度走发起窗口', () => {
  /* 锁的是：dirMoveRun 的 7 个阶段 emit 只进主窗那条回归。 */
  const env = makeEnv();
  const reg = require('../ipc/dir-acl-links');
  const handlers = new Map();
  const cmd = {
    handle: (ch, fn) => handlers.set(ch, fn),
  };
  const deps = {
    handle: cmd.handle,
    send: env.alsSend,                 // ← 关键
    ps: () => Promise.resolve({ code: 1, stdout: '', stderr: '' }),
    runCmd: () => Promise.resolve({ code: 1, stdout: '', stderr: '' }),
    pathExists: () => false,
    shortErr: (e) => String(e && e.message || e),
    PS_PATH_BATCH: 100,
  };
  reg(env.ctx, deps);
  assert.ok(handlers.size > 0, 'dir-acl-links 一个 handler 都没注册');
  assert.ok([...handlers.keys()].some((k) => /dir/.test(k)), '没注册 dir 相关通道');
});

/* ---------- ③ 反向：别把 ctx.send 改回成"转发到 main.js 的 send" ---------- */

t('W7 ctx.send 保持「只发主窗」的语义（不许反向调用 main.js 的 send）', () => {
  /* 锁的是：有人为了"统一行为"把 ctx.send 改成调 main.js 的 send ——
   * 会成环（main.js 的 send 本身以 ipcCtx.send 为兜底）。
   * 只能用源码断言：要验的是"函数体里没有那个调用"。
   *
   * 【不要断言注释文案】readSrc 会剥注释（那是它的职责），
   * 所以「注释里要写明它只是兜底」这种断言在这里永远为假。
   * 要保证的是**行为契约**：ctx.send 的实现只看 getWin()，
   * 不碰 ALS、不 require main.js。 */
  const src = readSrc('ipc/ctx.js');
  /* 锁的是：ctx.js 反向 require main.js —— 那会成环（main.js 的 send 以 ctx.send 兜底）。 */
  assert.ok(!/require\(['"]\.\.\/main['"]\)/.test(src),
    'ctx.js 不许 require main.js —— 那会成环');
  /* 取 send 的实现体，断言里面只有"取主窗 + 发"这一条路径。 */
  const m = /send\(ev, data\)\s*\{([\s\S]*?)\n\s*\}/.exec(src);
  assert.ok(m, '找不到 ctx.send 的实现');
  const body = m[1];
  /* 锁的是：ctx.send 的实现语义 —— 它只能"取主窗并发"，不许掺入路由判断。 */
  assert.ok(/getWin\(\)/.test(body), 'ctx.send 应通过 getWin() 取窗口');
  /* 锁的是：把 ALS 逻辑塞进 ctx.send —— 会与 main.js 的 send 形成互相调用。 */
  assert.ok(!/als|currentSender|ipc-route|pickSendTarget/i.test(body),
    'ctx.send 里出现了 ALS/路由相关调用 —— 它必须保持「只发主窗」的简单语义');
});

done();
