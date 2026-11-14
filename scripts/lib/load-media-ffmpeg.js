'use strict';
const fs = require('fs');
const path = require('path');

/* 【数据目录名必须跟产品名走，不能写死 hehe-toolbox】
 * 真实数据目录是 %APPDATA%/<productName>，而 package.json 的 productName 是
 * 「核核工具箱」。这里曾写死 hehe-toolbox —— 那只是早期版本留下的空壳目录。
 * 后果不是报错，而是**静默 SKIP**：ffmpeg 明明装在
 * %APPDATA%\核核工具箱\bin\ffmpeg.exe，test-concat-list / test-video-trim /
 * test-two-pass-e2e 却判定「本机没有 ffmpeg」整段跳过，而断言数守卫把 SKIP
 * 当成环境跳过放行 —— 真正的回归可以顺着这条缝漏过去（第四轮审查实测到）。
 * 现在按 productName 解析，并保留旧目录名作为兼容回退。 */
function defaultUserDataDir() {
  const os = require('os');
  const root = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  let productName = '核核工具箱';
  try {
    productName = require('../../package.json').productName || productName;
  } catch (e) { /* 读不到就退回已知名字 */ }
  const primary = path.join(root, productName);
  if (fs.existsSync(path.join(primary, 'bin', 'ffmpeg.exe'))) return primary;
  const legacy = path.join(root, 'hehe-toolbox');
  if (fs.existsSync(path.join(legacy, 'bin', 'ffmpeg.exe'))) return legacy;
  return primary;
}

/**
 * 加载 ipc/media-ffmpeg.js，返回「通道名 → handler」的 Map。
 *
 * ============ 为什么需要它 ============
 * 与 scripts/lib/load-fs-ops-handlers.js 同一个理由：ipc/media-ffmpeg.js 是
 * `module.exports = function register(ctx, deps)` 形态，可以脱离 Electron 加载，
 * 但此前**没有任何测试真的加载过它** —— 所有关于 ffmpeg:* 的断言都是
 * 「读源码 + 正则匹配」，测的是文本形态而不是行为。
 *
 * v0.5.0 的视频裁剪是个典型例子：参数怎么拼进命令行、-ss 放哪、
 * 失败时半成品有没有清掉、copy 模式实际时长会不会漂 —— 这些全都只能靠跑一遍
 * 真 ffmpeg 才知道，而正则匹配对它们一无所知。
 *
 * ============ 依赖怎么给 ============
 *   · runCmd / pathExists 用真实实现（从 lib 或本地重写一份等价的）
 *   · storeGet / storeSet 用内存对象（不碰用户配置）
 *   · pathGuard 用真模块（裁剪的输出路径闸门就在它里面，不能桩掉）
 *   · AdmZip / downloadToFile / targetSize 等与裁剪无关的一律给"调了就抛"的桩
 */

/** 极简 runCmd：与 main.js 同名函数的语义一致（非零不抛，返回 {code,stdout,stderr}）。 */
function makeRunCmd() {
  const { spawn } = require('child_process');
  return function runCmd(cmd, args, opts) {
    return new Promise((resolve) => {
      const p = spawn(cmd, args, { windowsHide: true });
      let stdout = '', stderr = '';
      const timer = opts && opts.timeout ? setTimeout(() => { try { p.kill(); } catch (e) {} }, opts.timeout) : null;
      p.stdout.on('data', (d) => { stdout += String(d); });
      p.stderr.on('data', (d) => { stderr += String(d); });
      p.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + e.message }); });
      p.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  };
}

function pathExists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

/**
 * @param {object} [overrides] 覆盖 ctx / deps 里的任意项（测试用）
 * @returns {{ handlers: Map<string, Function>, streams: Array, jobs: Map<string, object>, storeData: object }}
 *   streams   —— 被 send('job:stream', …) 推出去的事件（原样，含 {id, data}），
 *               测试按 id 分组后可以只看自己那次任务的进度
 *   jobs      —— 主进程的任务表（取消用例要从这里取 cancel 句柄）
 *   storeData —— storeGet/storeSet 的内存桩，测试可以直接断言写入了什么
 */
function loadMediaFfmpeg(overrides) {
  const o = overrides || {};
  const reg = require('../../ipc/media-ffmpeg');

  const handlers = new Map();
  const streams = [];
  const jobSeq = { n: 0 };
  const jobs = new Map();
  const storeData = {};

  const notNeeded = (name) => () => { throw new Error('测试桩不该被调用：' + name); };

  /* 推送桩：只记录、不发送。
   * 【ctx 和 deps 要共用同一个函数】v0.6.6 起 media-ffmpeg 从 **deps** 取 send
   * （不再用 ctx.send —— 那个只发主窗、不看 ALS）。两边各写一份的话，
   * 一旦哪天代码里同时存在两条路径，同一条进度会被记两次，断言就变成噪声。 */
  const recordSend = (ev, payload) => { if (ev === 'job:stream') streams.push(payload); };

  const ctx = Object.assign({
    win: null,
    jobs,
    isWin: process.platform === 'win32',
    send: recordSend,
    nextJobSeq: () => ++jobSeq.n,
  }, o.ctx || {});

  const deps = Object.assign({
    handle: (ch, fn) => { handlers.set(ch, fn); },
    /* 【send 必须显式给】不给的话第一次推送就 TypeError: send is not a function ——
     * 实测踩过：test-video-trim 在这里崩掉，而它测的本来是别的东西。
     * 推送去向（ALS 路由）由 test-ipc-send-wiring.js 单独覆盖。 */
    send: recordSend,
    runCmd: makeRunCmd(),
    pathExists,
    fmtErr: (e) => String((e && e.message) || e),
    storeGet: (k, d) => (k in storeData ? storeData[k] : d),
    storeSet: (k, v) => { storeData[k] = v; return true; },
    moveFile: notNeeded('moveFile'),
    uniqueTarget: notNeeded('uniqueTarget'),
    setLatestCancelable: () => {},
    tempDir: () => require('os').tmpdir(),
    /* 【userDataDir 必须指到真实存在 ffmpeg 的那个目录】
     * findFfmpeg 会先查 storeGet('settings.ffmpegPath')，没设时查
     * userDataDir()/bin/ffmpeg.exe。目录名按 package.json 的 productName 解析
     * （见 defaultUserDataDir 的说明：写死 hehe-toolbox 会让三条真跑 ffmpeg
     * 的测试静默 SKIP）。 */
    userDataDir: o.userDataDir || defaultUserDataDir,
    pathGuard: require('../../lib/path-guard'),
    tempNames: require('../../lib/temp-names'),
    targetSize: notNeeded('targetSize'),
    AdmZip: notNeeded('AdmZip'),
    downloadToFile: notNeeded('downloadToFile'),
  }, o.deps || {});

  reg(ctx, deps);
  return { handlers, streams, jobs, storeData };
}

/** 找一台机器上可用的 ffmpeg；没有则返回 null（测试据此 SKIP）。 */
function detectFfmpeg() {
  const candidates = [
    path.join(defaultUserDataDir(), 'bin', 'ffmpeg.exe'),
    '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

module.exports = { loadMediaFfmpeg, detectFfmpeg, makeRunCmd, pathExists, defaultUserDataDir };
