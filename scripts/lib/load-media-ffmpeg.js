'use strict';
const fs = require('fs');
const path = require('path');

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

  const ctx = Object.assign({
    win: null,
    jobs,
    isWin: process.platform === 'win32',
    /* 把 id 也记下来：多个用例共用一个 streams 数组，不按 id 分组的话
     * 会读到别的任务（甚至上一个用例）的进度，断言就变成噪声。 */
    send: (ev, payload) => { if (ev === 'job:stream') streams.push(payload); },
    nextJobSeq: () => ++jobSeq.n,
  }, o.ctx || {});

  const deps = Object.assign({
    handle: (ch, fn) => { handlers.set(ch, fn); },
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
     * userDataDir()/bin/ffmpeg.exe。测试里把 userDataDir 指到本机真实的
     * %APPDATA%/hehe-toolbox，这样 ffmpeg 已安装的机器上能真跑。 */
    userDataDir: o.userDataDir || (() => path.join(require('os').homedir(), 'AppData', 'Roaming', 'hehe-toolbox')),
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
    path.join(require('os').homedir(), 'AppData', 'Roaming', 'hehe-toolbox', 'bin', 'ffmpeg.exe'),
    '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

module.exports = { loadMediaFfmpeg, detectFfmpeg, makeRunCmd, pathExists };
