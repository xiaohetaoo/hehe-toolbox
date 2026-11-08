'use strict';
/* 媒体与 FFmpeg 的两个 IPC 域：
 *   · ffmpeg:* / target:*  —— FFmpeg 环境检测与下载、音视频转码压缩
 *   · rec:*                —— 屏幕录制（gdigrab，区域/声音/暂停分段/GIF）
 *
 * ============ 为什么这两个域放在同一个文件里 ============
 * 录制域**直接用 ffmpeg**：listDshowDevices / recSpawnSeg / recStartSeg 都调
 * findFfmpeg()，录完转 GIF 走同一套 runCmd 与参数拼装。
 * 拆成 ipc/ffmpeg.js + ipc/rec.js 的话，每一次录制调用都要跨模块取 ffmpeg
 * 路径查找，把「录制依赖 ffmpeg」这条本来很清楚的依赖变成两处维护。
 * 所以按**真实依赖**组织，与 ipc/dir-acl-links.js 的处理方式一致。
 *
 * ============ 搬迁原则：逐字搬，只改依赖表达方式 ============
 * 函数体与 handler 体原样来自 main.js（任务 6，947 行），**没有改任何语义**。
 * 只做了三类机械替换 + 注入：
 *   · `++jobSeq`            → `ctx.nextJobSeq()`
 *     （原来靠闭包自增 main.js 的计数器；ctx 的那一项委托回同一个变量，
 *      所以序号序列与搬走前完全一致）
 *   · `latestCancelable = X` → `setLatestCancelable(X)`
 *     （该变量只写不读，main.js 保留它并在注释里说明将来可能加「一键取消全部」）
 *   · `app.getPath('temp' | 'userData')` → `tempDir()` / `userDataDir()`
 *     （app 只能在 Electron 主进程里取，由 main.js 注入）
 * 其余一律靠 deps 注入，见下方形参说明。
 *
 * 【为什么 deps 有这么多项，而不是让模块自己 require】
 * handle 带着统一的高危门禁与结构化错误包装（CAP_GATED_CHANNELS 在 main.js
 * 的包装层里执行）。搬出去后必须仍走同一个包装 —— 否则渲染层可以直接
 * invoke 绕过门禁，而那正是这个项目最不能破的一条。
 * runCmd 的「非零不抛」语义被几十处依赖，pathExists 的容错分支也一样，
 * 都不能复制第二份。
 *
 * ============ 搬完之后 main.js 里留下了什么 ============
 * 只留下 register(ctx, deps) 这一次调用（与 dir-acl-links 同一形态）。
 * scripts/test-ipc-split.js 守着「搬出去的代码不直接引用 win / send / jobSeq」
 * 这条不变量；scripts/test-ipc-channels.js 守着通道总数。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
/* 火后不理的 taskkill 必须挂 error 监听：见 lib/spawn-detached.js 顶部说明。
 * 这个域原来有 6 处裸 spawn('taskkill', …)，与 main.js 里已修的那批同款 ——
 * 但这里拿不到 main.js 的局部助手，于是「修了一半」。 */
const { spawnDetached } = require('../lib/spawn-detached');
/* dialog 只在 ffmpeg:pick 里用（选 ffmpeg.exe / ffprobe.exe）。
 * 它是 Electron 主进程 API，必须在主进程侧 require。 */
const { dialog } = require('electron');
const CH = require('../lib/channels').CHANNELS;   // IPC 通道名唯一来源
/* 硬件编码：探测本机可用的编码器并把 crf 换算成 cq。
 * 全部逻辑在 lib/ 里（纯函数，可单测），这里只负责「探测一次 + 缓存 + 拼参数」。 */
const hwEncode = require('../lib/hw-encode');

/**
 * @param {object} ctx  见 ipc/ctx.js（win / jobs / isWin / send / nextJobSeq）
 * @param {object} deps 由 main.js 注入
 * @param {Function} deps.handle         带门禁与错误包装的 ipcMain.handle 包装
 * @param {Function} deps.send           向发起调用的窗口推送（ALS 三档路由版；
 *   不能用 ctx.send —— 那个只发主窗，独立工具窗口的进度会全部跑到主窗去）
 * @param {Function} deps.runCmd         跑命令（非零不抛）
 * @param {Function} deps.pathExists
 * @param {Function} deps.fmtErr
 * @param {Function} deps.storeGet
 * @param {Function} deps.storeSet
 * @param {Function} deps.moveFile
 * @param {Function} deps.uniqueTarget
 * @param {Function} deps.setLatestCancelable  等价于搬走前的 `latestCancelable = X`
 * @param {Function} deps.tempDir        等价于 app.getPath('temp')
 * @param {Function} deps.userDataDir    等价于 app.getPath('userData')
 * @param {object}   deps.pathGuard      lib/path-guard
 * @param {object}   deps.tempNames      lib/temp-names
 * @param {object}   deps.targetSize     lib/target-size
 * @param {new (p?: string) => {getEntries: Function, extractEntryTo: Function}} deps.AdmZip
 *                                      adm-zip 的构造函数（用 new 调用）
 * @param {Function} deps.downloadToFile  通用断点续传下载器（定义在 main.js，
 *                                       net:download 与 ffmpeg:download 共用）
 * @returns {void} 全部 IPC 都在这里就地注册，没有返回值
 */
module.exports = function register(ctx, deps) {
  const {
    handle, runCmd, pathExists, fmtErr, send,
    storeGet, storeSet, moveFile, uniqueTarget, setLatestCancelable,
    tempDir, userDataDir, pathGuard, tempNames, targetSize, AdmZip, downloadToFile,
  } = deps;

  const { jobs, isWin } = ctx;

  /* ============ 硬件编码：探测一次，缓存到进程内存 ============
   *
   * 【为什么缓存在模块级变量而不是每次现探】
   * 探测要真跑一次编码（实测 961ms：3 个编码器各跑 321ms）。转码一个批次
   * 可能是几十个文件，每次现探等于把「加速」的收益吃掉。
   *
   * 【为什么缓存要跟着 ffmpeg 路径失效】
   * 用户可能在设置里换一个 ffmpeg（比如从 essentials 换成 full build，
   * 后者才有 QSV）。缓存里存了当时的 ffmpeg 路径，路径变了就重探。
   *
   * 【为什么用"已 promise"而不是"已结果"】
   * 两个转码任务并发的场景下，第二个会在第一个探测完成前到达。
   * 存 promise 让第二个直接 await 同一个探测，而不是再跑一遍 961ms。
   */
  let hwCache = { ffmpeg: null, promise: null };

  /**
   * 取硬件编码探测结果（带缓存）。
   * @returns {Promise<{available:boolean,family:string|null,name:string|null,encoders:object}>}
   */
  function getHwProbe() {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) return Promise.resolve({ available: false, family: null, name: null, encoders: {}, probed: [] });
    if (hwCache.ffmpeg === ffmpeg && hwCache.promise) return hwCache.promise;
    const p = (async () => {
      try {
        const r = await runCmd(ffmpeg, ['-hide_banner', '-encoders'], { timeout: 15000 });
        const cands = hwEncode.listCandidates(r.stdout);
        if (!cands.length) return { available: false, family: null, name: null, encoders: {}, probed: [] };
        return hwEncode.detectEncoder(ffmpeg, cands);
      } catch (e) {
        /* 【探测失败必须降级成「无硬件」，不能把异常抛给调用方】
         * 探测只是个优化路径：它失败时转码应该退回 CPU 正常跑，
         * 而不是让「转码」这个功能整个不可用。 */
        console.error('[hw-encode] 探测失败，回退 CPU：', e && e.message);
        return { available: false, family: null, name: null, encoders: {}, probed: [] };
      }
    })();
    hwCache = { ffmpeg, promise: p };
    return p;
  }

  /**
   * 组装视频编码参数（CPU 或硬件）。
   *
   * 【这个函数是「为什么用户觉得加速没生效」的唯一答案】
   * 三条回退路径都在这里显式返回 hw:false，调用方据此在进度里如实告知：
   *   ① 用户没开开关            → 用 CPU
   *   ② 本机没有可用硬件        → 用 CPU
   *   ③ 探测到的是 h264 但用户要 hevc → 用 CPU（两个能力位独立）
   *
   * @param {object} o
   * @param {string} o.vcodec 界面选的 vcodec（'' / 'libx265' / 'copy'）
   * @param {number} o.crf
   * @param {string} o.preset CPU preset（硬件走自己的 preset）
   * @returns {Promise<{args:string[], hw:boolean, encoder:string, family:string|null}>}
   */
  async function videoEncodeArgs(o) {
    const want = o && o.vcodec === 'libx265' ? 'hevc' : 'h264';
    /* 【设置缺省值 = null 而不是 false，这个区别很重要】
     * 用户的要求是「检测到可用硬件就默认开启」，所以"没设置过"要落到
     * "探测完再定"，而不是直接 false：
     *   · null（从没设置过）→ 探测到可用硬件就自动开
     *   · true / false       → 用户显式选过，尊重它
     * 如果这里写成 storeGet(..., false)，那台有 N 卡的机器永远默认走 CPU，
     * 「默认开启」就形同虚设。 */
    let pref = null;
    try { pref = await storeGet('settings.hwAccel', null); } catch (e) { pref = null; }
    let enabled;
    let probe = { available: false, encoders: {} };
    if (pref === null || pref === undefined) {
      /* 没设置过：先探一次，能探到就默认用硬件（这就是用户要的"默认开启"） */
      probe = await getHwProbe();
      enabled = !!probe.available;
    } else {
      enabled = pref === true;
      if (enabled) probe = await getHwProbe();
    }
    const pick = hwEncode.pickVideoEncoder({ enabled, probe, codec: want });
    if (pick.hw) {
      return {
        args: ['-c:v', pick.name, ...hwEncode.hwQualityArgs(pick.family, o.crf)],
        hw: true, encoder: pick.name, family: pick.family,
      };
    }
    const name = want === 'hevc' ? 'libx265' : 'libx264';
    return { args: ['-c:v', name, '-crf', String(o.crf || 23), '-preset', String(o.preset || 'veryfast')], hw: false, encoder: name, family: null };
  }

  /* ============ 硬件编码失败后自动退回 CPU ============
   *
   * 【为什么必须有这一层】
   * 探测通过只说明"这一刻"能跑。实际用起来还有几种会让硬件编码失败的情况，
   * 而它们发生时代价很大 —— 整批转码到了一个文件就停住，用户看到「转换失败」：
   *   · 驱动在会话中途更新/重置（笔记本切换独显直连时最常见）
   *   · 显卡被另一个程序吃满显存（游戏、另一个转码任务）
   *   · 睡眠唤醒后 CUDA 上下文失效
   *   · 某些奇特的分辨率/像素格式硬件不接（例如 4096 宽、10bit 源）
   *
   * 【为什么是"重跑一次"而不是"预检"】
   * 上述情况无法在开始前可靠预测。唯一可靠的判据是"跑一遍看结果"。
   * 代价是失败时要多花一次时间，但那只发生在少数情况下；
   * 而"直接失败"是每次都会发生的用户体验灾难。
   *
   * 【为什么只回退一次】
   * 回退到 CPU 后再失败，就是真失败了（源文件损坏、磁盘满等），
   * 再重试只会让用户多等一遍。用 triedCpu 标志挡住二次回退。
   *
   * @param {object} o
   * @param {string[]} o.args 已拼好的参数（含硬件编码参数）
   * @param {boolean} o.hw 这批是不是走硬件
   * @param {Function} o.rebuildCpu 硬件失败时，用它重建一份纯 CPU 的参数
   * @returns {Promise<{code:number, errOut:string, usedHw:boolean, fellBack:boolean}>}
   */
  async function runEncodeWithFallback(o) {
    const once = (args) => new Promise((resolve) => {
      const proc = spawn(findFfmpeg(), args, { windowsHide: true });
      o.onProc && o.onProc(proc);
      let errOut = '', progBuf = '';
      proc.stdout.on('data', (d) => {
        progBuf += String(d);
        const lines = progBuf.split('\n');
        progBuf = lines.pop() || '';
        for (const line of lines) o.onLine && o.onLine(line);
      });
      proc.stderr.on('data', (d) => { errOut += String(d); if (errOut.length > 20000) errOut = errOut.slice(-8000); });
      proc.on('exit', (code) => resolve({ code, errOut }));
      proc.on('error', (err) => resolve({ code: -1, errOut: err.message }));
    });

    const first = await once(o.args);
    if (first.code === 0 || !o.hw) return { ...first, usedHw: !!o.hw, fellBack: false };
    /* 【取消时不回退】
     * 用户主动点了取消，这时不该"贴心地"再用 CPU 跑一遍 ——
     * 那会让他点了取消却看到 CPU 风扇转起来。 */
    if (o.isCancelled && o.isCancelled()) return { ...first, usedHw: true, fellBack: false };
    try { await fsp.rm(o.out, { force: true }); } catch (e) {}
    const cpuArgs = typeof o.rebuildCpu === 'function' ? o.rebuildCpu() : null;
    if (!cpuArgs) return { ...first, usedHw: true, fellBack: false };
    /* 告诉界面"硬件没成，正在改用 CPU" —— 否则用户会以为软件卡住了 */
    if (o.notify) o.notify();
    const second = await once(cpuArgs);
    return { ...second, usedHw: false, fellBack: true };
  }

  /* ============ ffmpeg 进程树的统一收尾 ============
   *
   * 【为什么要有这个函数】
   * 本文件此前有 5 处几乎一样的「杀 ffmpeg」内联代码：
   *     try { state.proc && state.proc.kill && state.proc.kill(); } catch (err) {}
   *     if (isWin && state.proc && state.proc.pid) spawnDetached('taskkill', [...'/t','/f']);
   * 每次新增一条需要取消的通道，就得把这四行再抄一遍 —— 漏抄 'taskkill' 那行，
   * proc.kill() 在 Windows 上只杀得掉 ffmpeg 自己，它 fork 出去的编码子进程会留下，
   * 表现是「点了取消，CPU 还满载」。抽出成函数后调用点只需一行。
   *
   * 【为什么先 proc.kill() 再 taskkill】
   * proc.kill() 是同步的、立刻发出；taskkill 要起一个进程，慢一拍。
   * 两个都做是刻意的冗余：proc.kill() 处理「进程还活着、信号能送达」的常见情况，
   * taskkill /t /f 处理它已经僵死或还有子进程的情况。顺序反过来会让
   * 「紧接着读进程状态」的调用方看到还没死的旧状态。
   *
   * @param {import('child_process').ChildProcess|null} proc
 */
  function killFfmpegTree(proc) {
    if (!proc) return;
    try { if (typeof proc.kill === 'function') proc.kill(); } catch (err) { /* 已退出 */ }
    if (isWin && proc.pid) {
      /* 火后不理：spawnDetached 内部已挂 error 监听，起不来也不会变成 uncaughtException。 */
      try { spawnDetached('taskkill', ['/pid', String(proc.pid), '/t', '/f']); } catch (err) { /* 进程可能刚好自己退了 */ }
    }
  }
  /* 【win 不能解构 —— 那会把 getter 当场求值成常量】
   * `const { win } = ctx` 在**解构那一刻**就求值了 getter，而本模块的
   * register 在 main.js 顶层执行、远早于 createWindow()，所以拿到的恒是 null；
   * 此后主窗建好、甚至关闭重建，这个值都不会变。
   * ipc/ctx.js 头部专门写了"用快照会『第一次能用、换窗口就不对』，所以做成
   * getter"—— 机制写对了，用法又错回去了。
   *
   * 后果：dialog.showOpenDialog(null, …) 合法但退化成**无父窗口**的对话框：
   * 不居中、不是主窗的模态子窗口，用户开着对话框还能继续点主窗
   * （容易连点出好几个）；在独立工具窗里点「选择 ffmpeg.exe」时也不归属那个窗口。
   *
   * 所以下面一律用 `ctx.win`（每次读都走 getter，拿的是当前值）。
   * jobs 返回同一个 Map、isWin 是布尔，都不变，可以安全解构。 */

  /* 【send 必须来自 deps，不能从 ctx 取】
   * ctx.send 是 v0.6.0 之前那版「只发主窗口」的实现；v0.6.0 起 main.js 的
   * send() 升级成三档路由（ALS 里的 sender / 无调用者回退主窗 / 调用者已销毁丢弃，
   * 判据在 lib/ipc-route.js）。本模块从 ctx 取 send，等于把整个域的多窗口路由
   * 关掉了：独立工具窗口里跑视频压制/目标体积/FFmpeg 安装时，进度事件全发到主窗口 ——
   *   · 发起窗口的进度条完全不动，取消按钮拿不到 runJobId（它是从 job:stream 里取的），
   *     点了没反应；
   *   · 主窗口若开着同一个工具页，JobPrefix 的「首次匹配前缀就认领」会把这个
   *     不属于它的任务认领走 —— 进度条乱跳、结束时弹「完成」。
   * 这正好抵消了 v0.6.4 修的孤儿任务防串扰。
   * fs-ops / net-lan 早就是从 deps 取 send 的，本模块照同一形态改。 */

  /* ======================= 以下为逐字搬来的实现 ======================= */

/* ================= IPC: ffmpeg 环境与音视频处理 ================= */
function binDir() { return path.join(userDataDir(), 'bin'); }
function findFfmpeg() {
  const custom = storeGet('settings.ffmpegPath', null);
  if (custom && fs.existsSync(custom)) return custom;
  if (fs.existsSync(path.join(binDir(), 'ffmpeg.exe'))) return path.join(binDir(), 'ffmpeg.exe');
  try {
    const r = spawnSync('where', ['ffmpeg'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    const p = (r.stdout || '').split(/\r?\n/).find(l => l.trim().toLowerCase().endsWith('ffmpeg.exe'));
    if (p) return p.trim();
  } catch (e) {}
  return null;
}
function findFfprobe() {
  const custom = storeGet('settings.ffprobePath', null);
  if (custom && fs.existsSync(custom)) return custom;
  const ff = findFfmpeg(); // 只探测一次，避免 PATH-only 环境下重复 where
  const sameDir = ff && path.join(path.dirname(ff), 'ffprobe.exe');
  if (sameDir && fs.existsSync(sameDir)) return sameDir;
  if (fs.existsSync(path.join(binDir(), 'ffprobe.exe'))) return path.join(binDir(), 'ffprobe.exe');
  try {
    const r = spawnSync('where', ['ffprobe'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    const p = (r.stdout || '').split(/\r?\n/).find(l => l.trim().toLowerCase().endsWith('ffprobe.exe'));
    if (p) return p.trim();
  } catch (e) {}
  return null;
}
handle(CH.FFMPEG.STATUS, async () => {
  const ffmpeg = findFfmpeg(), ffprobe = findFfprobe();
  let version = null;
  if (ffmpeg) {
    try { version = ((await runCmd(ffmpeg, ['-version'], { timeout: 8000 })).stdout || '').split(/\r?\n/)[0]; } catch (e) {}
  }
  return { ffmpeg, ffprobe, binDir: binDir(), version };
});

/* ============ 硬件编码能力探测 ============
 * 设置页用它显示「你的机器能用什么」，转码页用它显示「这次会走哪个编码器」。
 * 结果是真实跑出来的，不是读显卡型号猜的 —— 见 lib/hw-encode.js 顶部说明。 */
handle(CH.FFMPEG.HW_PROBE, async () => {
  const ffmpeg = findFfmpeg();
  /* 【没有 ffmpeg 时不要报错】
   * 「FFmpeg 环境」页在没装 ffmpeg 时也要能正常打开，设置页同理。
   * 返回 available:false + 一句原因，界面按「未安装」展示即可。 */
  if (!ffmpeg) return { available: false, family: null, name: null, encoders: {}, probed: [], reason: 'NO_FFMPEG' };
  const probe = await getHwProbe();
  let enabled = false;
  try { enabled = (await storeGet('settings.hwAccel', false)) === true; } catch (e) {}
  return { ...probe, enabled, ffmpeg };
});
handle(CH.FFMPEG.PICK, async (e) => {
  /* ctx.win 是 getter，每次读都是当前主窗（见上方解构处的说明） */
  const picked = await dialog.showOpenDialog(ctx.win || null, {
    title: '选择 ffmpeg.exe（可多选，同时选上 ffprobe.exe）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '可执行文件', extensions: ['exe'] }]
  });
  if (picked.canceled || !picked.filePaths.length) return { picked: [] };
  await fsp.mkdir(binDir(), { recursive: true });
  const copied = [];
  for (const src of picked.filePaths) {
    const name = path.basename(src).toLowerCase();
    if (name === 'ffmpeg.exe' || name === 'ffprobe.exe') {
      await fsp.copyFile(src, path.join(binDir(), name));
      copied.push(name);
    }
  }
  if (!copied.includes('ffmpeg.exe')) {
    /* 用户可能把 ffmpeg 存成了别的名字（如 ffmpeg-6.1.exe）。
     * 【判据必须是「输出里真的有 ffmpeg version」，不能只看进程能不能跑】
     * 原实现是 `await runCmd(first, ['-version'])` —— runCmd 默认对非零退出码
     * 不抛异常，而且任何程序响应 -version 都能"成功"，于是用户在同一个对话框里
     * 先选了 ffprobe.exe（或随便一个会打印版本号的 exe）且没有任何一项 basename
     * 恰好是 ffmpeg.exe 时，那个文件会被复制成 bin/ffmpeg.exe，
     * **覆盖掉原本可用的 ffmpeg**。之后所有转码全部失败，且用户不知道是这一步造成的。
     * 现在：① 要求退出码为 0；② 要求 stdout/stderr 里出现 'ffmpeg version'；
     * ③ 已经在 bin 里有可用 ffmpeg 时不覆盖，只提示。 */
    const first = picked.filePaths[0];
    try {
      const r = await runCmd(first, ['-version'], { timeout: 8000, throwOnNonZero: true });
      const ver = String(r.stdout || '') + String(r.stderr || '');
      if (!/ffmpeg version/i.test(ver)) throw new Error('输出里没有 ffmpeg version，不是 ffmpeg');
      const dest = path.join(binDir(), 'ffmpeg.exe');
      if (fs.existsSync(dest)) {
        const old = await runCmd(dest, ['-version'], { timeout: 8000 }).catch(() => null);
        if (old && /ffmpeg version/i.test(String(old.stdout || ''))) {
          // 已有可用的 ffmpeg，不覆盖：静默替换是破坏性的，且用户没要求
          return { picked: copied, binDir: binDir(), skipped: '已有可用的 ffmpeg，未覆盖' };
        }
      }
      await fsp.copyFile(first, dest);
      copied.push('ffmpeg.exe');
    } catch (err) { /* 不是 ffmpeg：保持原状，不复制 */ }
  }
  return { picked: copied, binDir: binDir() };
});
const FFMPEG_SOURCES = {
  npmmirror: { name: 'npmmirror 国内镜像（推荐，约 59MB，含 ffprobe）', type: 'gz-pair', base: 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1' },
  gyan: { name: 'gyan.dev 官方整合包（约 114MB，含 ffprobe）', url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', type: 'zip' },
  btbn: { name: 'BtbN GitHub 构建（约 90MB，含 ffprobe）', url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip', type: 'zip' }
};

handle(CH.FFMPEG.DOWNLOAD, async (e, sourceId) => {
  const src = FFMPEG_SOURCES[sourceId] || FFMPEG_SOURCES.npmmirror;
  const id = 'dl' + (ctx.nextJobSeq());
  const ctrl = new AbortController();
  jobs.set(id, { cancel: () => ctrl.abort() });
  setLatestCancelable(() => ctrl.abort());
  await fsp.mkdir(binDir(), { recursive: true });
  try {
    if (src.type === 'gz-pair') {
      const files = [['ffmpeg-win32-x64.gz', 'ffmpeg.exe'], ['ffprobe-win32-x64.gz', 'ffprobe.exe']];
      let idx = 0;
      for (const [gzName, exeName] of files) {
        idx++;
        const tmp = path.join(tempDir(), 'hehe-' + gzName);
        const emitLabel = () => send('job:stream', { id, data: JSON.stringify({ stage: 'label', label: `文件 ${idx}/2：${exeName}` }) });
        emitLabel();
        await downloadToFile(src.base + '/' + gzName, tmp, id, ctrl, `文件 ${idx}/2：${exeName}`);
        send('job:stream', { id, data: JSON.stringify({ stage: 'extract', label: `解压 ${exeName}` }) });
        const gz = fs.readFileSync(tmp);
        const out = zlib.gunzipSync(gz);
        fs.writeFileSync(path.join(binDir(), exeName), out);
        fs.rmSync(tmp, { force: true });
      }
      const ffmpeg = findFfmpeg();
      send('job:stream', { id, data: JSON.stringify({ stage: 'done' }) });
      return { ok: true, ffmpeg, ffprobe: findFfprobe(), found: 2 };
    }
    // zip 整合包
    const zipPath = tempNames.ffmpegZip({ tempDir: tempDir() });
    try {
      await downloadToFile(src.url, zipPath, id, ctrl, '整合包');
      send('job:stream', { id, data: JSON.stringify({ stage: 'extract' }) });
      const zip = new AdmZip(zipPath);
      let found = 0;
      for (const entry of zip.getEntries()) {
        const n = entry.entryName.replace(/\\/g, '/');
        if (n.endsWith('/ffmpeg.exe') || n.endsWith('/ffprobe.exe')) {
          zip.extractEntryTo(entry, binDir(), false, true);
          found++;
        }
      }
      if (!found) throw new Error('压缩包中未找到 ffmpeg.exe / ffprobe.exe');
      const ffmpeg = findFfmpeg();
      send('job:stream', { id, data: JSON.stringify({ stage: 'done' }) });
      return { ok: true, ffmpeg, ffprobe: findFfprobe(), found };
    } finally { await fsp.rm(zipPath, { force: true }).catch(() => {}); }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('下载已取消');
    throw err;
  } finally { jobs.delete(id); }
});
handle(CH.FFMPEG.REMOVE, async () => {
  await fsp.rm(binDir(), { recursive: true, force: true });
  storeSet('settings.ffmpegPath', undefined);
  storeSet('settings.ffprobePath', undefined);
  return true;
});
handle(CH.FFMPEG.PROBE, async (e, p) => {
  const ffprobe = findFfprobe();
  if (!ffprobe) throw new Error('未找到 ffprobe，请先在「FFmpeg 环境」中安装');
  const r = await runCmd(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', p], { timeout: 30000 });
  return JSON.parse(r.stdout);
});

/* ================= IPC: 目标体积压缩（音视频） =================
 * 借鉴 YourCatFileAssistant 的核心设计：不是"压一次看运气"，而是
 * 最多 8 轮候选输出，每轮按实际结果调整码率，达标才提交。
 * 关键约束（与对方一致）：
 *   - 绝不截断时长、绝不删音轨来凑体积
 *   - 每轮输出先写到任务专属临时文件，体积检查通过后才改名
 *   - 源文件本来就达标时直接另存并标注「已符合上限」
 *   - 进度最多 99%，提交成功才 100%
 */
handle(CH.TARGET.COMPRESS_AV, async (e, { items, outDir, targetBytes, mode, ratio }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  const ffprobe = findFfprobe();
  const id = 'tgt' + (ctx.nextJobSeq());
  const state = { cancel: false, proc: null };
  const killProc = () => killFfmpegTree(state.proc);
  jobs.set(id, { cancel: () => { state.cancel = true; killProc(); } });
  setLatestCancelable(() => { state.cancel = true; killProc(); });

  await fsp.mkdir(outDir, { recursive: true });
  const results = [];

  /* 读时长与音轨信息。时长拿不到就无法按体积反推码率，直接给出可读失败。 */
  async function probeMedia(p) {
    if (!ffprobe) return { duration: 0, hasAudio: false, width: 0, height: 0 };
    try {
      const r = await runCmd(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', p], { timeout: 30000 });
      const j = JSON.parse(r.stdout);
      const v = (j.streams || []).find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
      const a = (j.streams || []).find(s => s.codec_type === 'audio');
      return {
        duration: parseFloat((j.format || {}).duration) || (v && parseFloat(v.duration)) || 0,
        hasAudio: !!a,
        width: v ? v.width : 0,
        height: v ? v.height : 0
      };
    } catch (err) { return { duration: 0, hasAudio: false, width: 0, height: 0 }; }
  }

  try {
    for (let i = 0; i < items.length; i++) {
      if (state.cancel) break;
      const input = items[i];
      /* 【单个文件读不到不能中断整批】
       * 批量压缩时用户很可能在资源管理器里删/改队列里的文件。原实现直接
       * `await fsp.stat(input)`，ENOENT 一路冒到外层 finally —— 整批中断，
       * 而函数是「抛异常」而不是「返回 results」，前面已经压好的若干条记录
       * 随返回值一起消失，用户既拿不到成果清单，也不知道哪几个已完成。
       * 这里降级成「这一条失败，记下来，继续下一个」。 */
      let srcSize = 0;
      try {
        srcSize = (await fsp.stat(input)).size;
      } catch (err) {
        results.push({ input, out: null, ok: false, srcSize: 0, target: 0, err: '无法读取源文件：' + fmtErr(err) });
        send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(String(input || '')), pct: 100, done: true, ok: false, error: '无法读取源文件' }) });
        continue;
      }
      const want = mode === 'ratio'
        ? targetSize.tierTargetBytes(srcSize, ratio)
        : Math.floor(targetBytes);
      const base = path.basename(input).replace(/\.[^.]+$/, '');

      send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), stage: 'probe', pct: 1 }) });

      /* 源文件本来就达标：直接另存一份，标「已符合上限」。
         这是对方明确处理的场景 —— 用户的文件本来就够小，不该被重编码白白降低画质。 */
      if (srcSize <= want) {
        const dst = await uniqueTarget(outDir, base + path.extname(input));
        await fsp.copyFile(input, dst);
        results.push({ input, out: dst, ok: true, srcSize, outSize: srcSize, target: want, alreadyFits: true, rounds: 0 });
        send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok: true, alreadyFits: true }) });
        continue;
      }

      const media = await probeMedia(input);
      if (!(media.duration > 0)) {
        results.push({ input, out: null, ok: false, srcSize, target: want, err: '无法获取媒体时长，无法按体积反推码率' });
        send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok: false }) });
        continue;
      }

      const tmpDir = tempNames.tgtTmpDir({ tempDir: tempDir() });
      await fsp.mkdir(tmpDir, { recursive: true });
      let finalOut = null;
      let lastErr = '';
      let usedRounds = 0;
      /* 两遍法的 stats 文件：**每个输入文件只分析一次**，8 轮逼近全部复用。
       * passlog 记录的是帧复杂度，与 -b:v 目标值无关，换码率无需重新分析。
       * 路径统一成正斜杠：ffmpeg 在 Windows 上对 -passlogfile 的反斜杠转义处理
       * 不一致，曾出现 stats 写到奇怪位置、pass 2 读不到而静默降级。 */
      const passlogFile = path.join(tmpDir, 'x264pass').replace(/\\/g, '/');
      let pass1Done = false;

      try {
        /* ---- 两遍法：分析趟只做一次，8 轮逼近全部复用同一份 stats ----
         * 单遍 ABR 实际输出常偏离目标 10%~30%；两遍法按帧复杂度精确分配码率，
         * 实测把「3.09MB → 15% 目标」从 5 轮降到 2 轮。
         * 分析失败（老版本 ffmpeg、异常退出）时自动回退单遍，不影响功能。 */
        const progressOf = (round, inRound) => Math.min(99, ((i + (round + inRound) / targetSize.MAX_ROUNDS) / items.length) * 100);
        const runFfmpeg = (args, round) => new Promise((resolve) => {
          const proc = spawn(ffmpeg, args, { windowsHide: true });
          state.proc = proc;
          let buf = '', errOut = '';
          proc.stdout.on('data', (d) => {
            buf += String(d);
            const lines = buf.split('\n'); buf = lines.pop() || '';
            for (const line of lines) {
              const m = line.match(/out_time_us=(\d+)/);
              if (m && media.duration > 0) {
                const inRound = Math.min(1, parseInt(m[1]) / 1e6 / media.duration);
                send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: progressOf(round, inRound), round: round + 1 }) });
              }
            }
          });
          proc.stderr.on('data', (d) => { errOut += String(d); if (errOut.length > 20000) errOut = errOut.slice(-8000); });
          proc.on('exit', (code) => resolve({ code, errOut }));
          proc.on('error', (err) => resolve({ code: -1, errOut: err.message }));
        });

        const plan0 = targetSize.planBitrates({
          targetBytes: want, durationSec: media.duration,
          hasAudio: media.hasAudio, round: 0
        });
        if (plan0.ok) {
          send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), stage: 'analyze', pct: 0 }) });
          const p1 = await runFfmpeg(targetSize.buildPass1Args({
            input, videoKbps: plan0.videoKbps, passlogFile
          }), 0);
          if (p1.code === 0 && fs.existsSync(passlogFile + '-0.log')) pass1Done = true;
        }
        if (state.cancel) lastErr = '已取消';

        for (let round = 0; round < targetSize.MAX_ROUNDS; round++) {
          usedRounds = round + 1;
          if (state.cancel) break;

          const plan = targetSize.planBitrates({
            targetBytes: want, durationSec: media.duration,
            hasAudio: media.hasAudio, round
          });
          if (!plan.ok) { lastErr = plan.reason; break; }

          const cand = path.join(tmpDir, `r${round}.mp4`);
          // 两遍法：读 pass 1 的 stats 精确分配码率；分析没成功就退回单遍
          const args = pass1Done
            ? targetSize.buildPass2Args({
                input, output: cand, videoKbps: plan.videoKbps,
                audioKbps: plan.audioKbps, hasAudio: media.hasAudio, passlogFile
              })
            : targetSize.buildSinglePassArgs({
                input, output: cand, videoKbps: plan.videoKbps,
                audioKbps: plan.audioKbps, hasAudio: media.hasAudio
              });

          const r = await runFfmpeg(args, round);

          if (state.cancel) { lastErr = '已取消'; break; }
          if (r.code !== 0) {
            lastErr = r.errOut.split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' ') || ('退出码 ' + r.code);
            break;
          }
          let outBytes = 0;
          try { outBytes = (await fsp.stat(cand)).size; } catch (err) {}
          const verdict = targetSize.evaluateRound({ outBytes, targetBytes: want, round });
          if (verdict.ok) { finalOut = { file: cand, size: outBytes }; break; }
          if (verdict.done) { lastErr = verdict.reason; break; }
          try { await fsp.unlink(cand); } catch (err) {} // 未达标候选立刻删掉，省磁盘
        }

        if (finalOut) {
          /* 校验通过才提交：改成最终名（同名自动编号，不覆盖已有文件）。
           * 【跨卷必须退回「复制 + 删除」】临时目录在 %TEMP%（通常 C:），
           * 而输出目录完全可能被用户选到 D:/E:。Windows 上 rename 跨卷
           * 抛 EXDEV —— 八轮编码全部达标、成果就在 finalOut，却在最后一步
           * 失败，异常冒泡让 results 里连一条记录都没有，而 finally 还会把
           * tmpDir 整个删掉（成果一起没了）。项目在 7z 解压那边已经为同一个
           * EXDEV 坑写过注释，这里是同一类问题。 */
          const dst = await uniqueTarget(outDir, base + '.mp4');
          await moveFile(finalOut.file, dst);
          results.push({ input, out: dst, ok: true, srcSize, outSize: finalOut.size, target: want, rounds: usedRounds });
          send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok: true }) });
        } else {
          results.push({ input, out: null, ok: false, srcSize, target: want, rounds: usedRounds, err: lastErr || '未能压到目标体积' });
          send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok: false }) });
        }
      } finally {
        // 只清理自己的临时目录；已提交的最终文件不在其中
        try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (err) {}
      }
    }
  } finally { jobs.delete(id); }
  return { id, results, canceled: state.cancel };
});

/* 图片的目标体积压缩：按质量与尺寸双维度多轮逼近。
 * 与音视频不同，图片编码在渲染进程用 canvas 完成（已有链路），
 * 主进程只负责规划每轮参数与判定体积，实际重编码由渲染层完成。 */
handle(CH.TARGET.PLAN_IMAGE, (e, { round }) => {
  const q = targetSize.planImageQuality(round);
  return { quality: q.quality, scale: q.scale, round, maxRounds: targetSize.MAX_ROUNDS };
});
handle(CH.TARGET.EVAL_IMAGE, (e, { outBytes, targetBytes, round }) => {
  return targetSize.evaluateRound({ outBytes, targetBytes, round });
});

handle(CH.FFMPEG.CONVERT, async (e, { items, outDir, opts }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  const id = 'avc' + (ctx.nextJobSeq());
  const state = { cancel: false, proc: null };
  jobs.set(id, { cancel: () => { state.cancel = true; killFfmpegTree(state.proc); } });
  setLatestCancelable(() => { state.cancel = true; killFfmpegTree(state.proc); });
  const extMap = { mp4: 'mp4', webm: 'webm', mkv: 'mkv', mp3: 'mp3', wav: 'wav', flac: 'flac', gif: 'gif', m4a: 'm4a' };
  await fsp.mkdir(outDir, { recursive: true });
  const results = [];
  try {
    for (let i = 0; i < items.length; i++) {
      if (state.cancel) break;
      const input = items[i];
      const base = path.basename(input).replace(/\.[^.]+$/, '');
      const ext = extMap[opts.format] || 'mp4';
      let out = path.join(outDir, `${base}.${ext}`);
      for (let k = 1; await pathExists(out); k++) out = path.join(outDir, `${base}(${k}).${ext}`);
      let dur = 0;
      try {
        const ffprobe = findFfprobe();
        if (ffprobe) {
          const r = await runCmd(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', input], { timeout: 15000 });
          dur = parseFloat((JSON.parse(r.stdout).format || {}).duration) || 0;
        }
      } catch (err) {}
      const args = ['-hide_banner', '-y', '-nostats'];
      if (opts.ss) args.push('-ss', String(opts.ss));
      args.push('-i', input);
      if (opts.to) args.push('-t', String(opts.to));
      /* 【纯音频容器必须先算出来，不能只列 mp3/m4a】
       * 下面 3180 行用 isAudioOut 判断「不加 -c:v」，包含 wav/flac；
       * 而这一行的 -vn 列表只有 mp3/m4a/mute —— 于是选 WAV/FLAC 且没勾静音时，
       * 既不 -vn（视频流还在）也不 -c:v（没有视频编码器），ffmpeg 试图把
       * 源视频流塞进 wav 容器 → 直接失败；失败分支还会 rm(out) 删掉半成品，
       * 用户只看到「转换失败」，看不到真正原因。
       * 统一用同一个判据，避免两份列表各写各的。 */
      const isAudioOut = ['mp3', 'm4a', 'wav', 'flac'].includes(opts.format);
      if (isAudioOut || opts.mute) args.push('-vn');
      if (opts.mute) { args.push('-an'); }
      else {
        // 音频编码按容器选择：wav→PCM、flac→无损 flac（aac 进这两个容器会被拒绝/非标）
        const ac = opts.acodec || (opts.format === 'webm' ? 'libopus' : opts.format === 'mp3' ? 'libmp3lame' : opts.format === 'wav' ? 'pcm_s16le' : opts.format === 'flac' ? 'flac' : 'aac');
        args.push('-c:a', ac);
        if (ac === 'aac') args.push('-b:a', '160k');
        if (ac === 'libmp3lame') args.push('-q:a', '2');
        if (ac === 'libopus') args.push('-b:a', '128k');
      }
      /* 【enc 要在循环内取，因为每个文件的编码族可能不同吗？不会——
       * opts.vcodec 对整批相同。但 videoEncodeArgs 是 async（要读设置 + 探测缓存），
       * 放在循环内只是 await 同一个已 resolve 的 promise，开销可忽略；
       * 好处是不必把 enc 变量提到循环外，避免"忘了在批次开头初始化"这类错。 */
      let enc = null;
      if (!isAudioOut) {
        if (opts.vcodec === 'copy') args.push('-c:v', 'copy');
        else if (opts.format === 'webm') { args.push('-c:v', 'libvpx-vp9', '-crf', String(opts.crf || 34), '-b:v', '0', '-row-mt', '1'); }
        else if (opts.format === 'gif') { args.push('-an', '-vf', `fps=${opts.fps || 12},scale=${opts.gifWidth || 480}:-2:flags=lanczos`); }
        else {
          enc = await videoEncodeArgs({ vcodec: opts.vcodec, crf: opts.crf, preset: 'veryfast' });
          args.push(...enc.args);
          if (opts.scale) args.push('-vf', `scale=${opts.scale}:-2`);
          if (opts.fps) args.push('-r', String(opts.fps));
          if (opts.format === 'mp4') args.push('-movflags', '+faststart');
        }
      }
      args.push('-progress', 'pipe:1', out);
      /* 【把实际用的编码器报给界面】
       * 用户开了硬件加速却没看到速度变化时，这一行是唯一能自证的地方：
       * 是他没开开关、还是本机没有可用硬件、还是这批文件走的是 copy/gif。 */
      send('job:stream', { id, data: JSON.stringify({
        i, name: path.basename(input), stage: 'start',
        encoder: enc ? enc.encoder : (opts.vcodec === 'copy' ? 'copy' : null),
        hw: enc ? enc.hw : false,
      }) });
      const r = await new Promise((resolve) => {
        const proc = spawn(ffmpeg, args, { windowsHide: true });
        state.proc = proc;
        let lastPct = 0, errOut = '', progBuf = '';
        proc.stdout.on('data', (d) => {
          progBuf += String(d);
          const lines = progBuf.split('\n');
          progBuf = lines.pop() || ''; // 保留末行未完结部分，数字跨块分裂时不丢进度
          for (const line of lines) {
            const m = line.match(/out_time_us=(\d+)/);
            if (m && dur > 0) {
              lastPct = Math.min(99, parseInt(m[1]) / 1e6 / dur * 100);
              send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: lastPct }) });
            }
          }
        });
        proc.stderr.on('data', (d) => { errOut += String(d); if (errOut.length > 20000) errOut = errOut.slice(-8000); });
        proc.on('exit', (code) => resolve({ code, errOut }));
        proc.on('error', (err) => resolve({ code: -1, errOut: err.message }));
      });
      if (state.cancel) { try { await fsp.rm(out, { force: true }); } catch (err) {} results.push({ input, out: null, ok: false, err: '已取消' }); break; }
      const ok = r.code === 0 && await pathExists(out);
      if (!ok) { try { await fsp.rm(out, { force: true }); } catch (err) {} } // 清理半成品
      results.push({ input, out: ok ? out : null, ok, err: ok ? '' : (r.errOut.split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' ') || ('退出码 ' + r.code)) });
      send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok }) });
    }
  } finally { jobs.delete(id); }
  return { id, results, canceled: state.cancel };
});

/* 视频压制：重编码瘦身（预设/CRF/编码速度/分辨率/音频码率/去元数据） */
handle(CH.FFMPEG.PRESS, async (e, { items, outDir, opts }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  const id = 'prs' + (ctx.nextJobSeq());
  const state = { cancel: false, proc: null };
  const killProc = () => killFfmpegTree(state.proc);
  jobs.set(id, { cancel: () => { state.cancel = true; killProc(); } });
  setLatestCancelable(() => { state.cancel = true; killProc(); });
  await fsp.mkdir(outDir, { recursive: true });
  const results = [];
  try {
    for (let i = 0; i < items.length; i++) {
      if (state.cancel) break;
      const input = items[i];
      const base = path.basename(input).replace(/\.[^.]+$/, '');
      let out = path.join(outDir, `${base}_pressed.mp4`);
      for (let k = 1; await pathExists(out); k++) out = path.join(outDir, `${base}_pressed(${k}).mp4`);
      let dur = 0;
      try {
        const ffprobe = findFfprobe();
        if (ffprobe) {
          const r = await runCmd(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', input], { timeout: 15000 });
          dur = parseFloat((JSON.parse(r.stdout).format || {}).duration) || 0;
        }
      } catch (err) {}
      /* 【CPU / 硬件两条路径由 videoEncodeArgs 统一决定】
       * 这里原来写死 `libx264|libx265 + -crf + -preset`。改走统一入口后
       * 硬件模式的参数（-cq/-global_quality 等）由 lib/hw-encode.js 产出，
       * 且 crf 会被换算成等体积的 cq（不是照抄数值，见该文件顶部实测表）。 */
      const pressEnc = await videoEncodeArgs({ vcodec: opts.vcodec, crf: opts.crf, preset: opts.preset || 'veryfast' });
      /* 【参数拆成两段：视频编码部分单独拎出来】
       * 因为硬件失败回退 CPU 时只该替换这一段（-c:v …），
       * 音频/缩放/元数据那些参数要原样保留。整条重建容易漏项。 */
      const buildArgs = (videoArgs) => {
        const a = ['-hide_banner', '-y', '-nostats', '-i', input,
          ...videoArgs,
          '-pix_fmt', 'yuv420p'];
        if (opts.vcodec === 'libx265') a.push('-tag:v', 'hvc1');
        if (opts.scale) a.push('-vf', `scale=${opts.scale}:-2`);
        if (opts.fps) a.push('-r', String(opts.fps));
        if (opts.stripMeta !== false) a.push('-map_metadata', '-1');
        if (opts.audio === 'mute') a.push('-an');
        else if (opts.audio === 'copy') a.push('-c:a', 'copy');
        else a.push('-c:a', 'aac', '-b:a', opts.audio === '96k' ? '96k' : '128k');
        a.push('-movflags', '+faststart', '-progress', 'pipe:1', out);
        return a;
      };
      const args = buildArgs(pressEnc.args);
      send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), stage: 'start', encoder: pressEnc.encoder, hw: pressEnc.hw }) });
      let lastPct = 0;
      const r = await runEncodeWithFallback({
        args,
        hw: pressEnc.hw,
        out,
        isCancelled: () => state.cancel,
        onProc: (proc) => { state.proc = proc; },
        onLine: (line) => {
          const m = line.match(/out_time_us=(\d+)/);
          if (m && dur > 0) {
            lastPct = Math.min(99, parseInt(m[1]) / 1e6 / dur * 100);
            send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: lastPct }) });
          }
        },
        rebuildCpu: () => {
          const cpuName = opts.vcodec === 'libx265' ? 'libx265' : 'libx264';
          const fallback = ['-c:v', cpuName, '-crf', String(opts.crf || 23), '-preset', String(opts.preset || 'veryfast')];
          return buildArgs(fallback);
        },
        notify: () => send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), notice: 'hw-fallback' }) }),
      });
      if (state.cancel) { try { await fsp.rm(out, { force: true }); } catch (err) {} results.push({ input, out: null, ok: false, err: '已取消' }); break; }
      const ok = r.code === 0 && await pathExists(out);
      if (!ok) { try { await fsp.rm(out, { force: true }); } catch (err) {} } // 清理半成品
      let inSize = 0, outSize = 0;
      try { inSize = (await fsp.stat(input)).size; if (ok) outSize = (await fsp.stat(out)).size; } catch (err) {}
      results.push({
        input, out: ok ? out : null, ok, inSize, outSize,
        encoder: r.fellBack ? (opts.vcodec === 'libx265' ? 'libx265' : 'libx264') : pressEnc.encoder,
        hw: r.usedHw && !r.fellBack,
        fellBack: r.fellBack,
        err: ok ? '' : (r.errOut.split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' ') || ('退出码 ' + r.code)),
      });
      send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok }) });
    }
  } finally { jobs.delete(id); }
  return { id, results, canceled: state.cancel };
});

/* 视频截帧：单帧或帧序列 */
handle(CH.FFMPEG.FRAMES, async (e, { input, outDir, mode, ss, every, count, width }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  await fsp.mkdir(outDir, { recursive: true });
  const base = path.basename(input).replace(/\.[^.]+$/, '');
  const args = ['-hide_banner', '-y'];
  let out;
  if (mode === 'single') {
    if (ss) args.push('-ss', String(ss));
    args.push('-i', input, '-frames:v', '1', '-q:v', '2');
    if (width) args.push('-vf', `scale=${width}:-2`);
    out = path.join(outDir, `${base}_frame.jpg`);
    args.push(out);
  } else {
    const fps = Math.max(0.05, 1 / Math.max(1, every || 1));
    args.push('-i', input, '-vf', `fps=${fps}${width ? `,scale=${width}:-2` : ''}`, '-frames:v', String(Math.min(500, count || 20)), '-q:v', '3');
    out = path.join(outDir, `${base}_%03d.jpg`);
    args.push(out);
  }
  /* 【先记下已有的帧文件，截完只数「本次新增的」】
   * 原实现是截完之后 readdir 统计所有 `base_*.jpg`。对同一个视频重复截帧
   * （上次 20 张，这次 5 张）时，统计会得到 20+，界面显示的帧数与实际不符；
   * 而且 ffmpeg 带 -y 会把 base_001.jpg … 覆盖掉，用户上次的帧就没了 ——
   * 这一条靠「只统计新增」看不出来，所以要单独确认覆盖行为。
   * 这里用「截帧前后的文件集合差」统计，并把被覆盖的旧文件数如实报出来。 */
  let before = new Set();
  try { before = new Set(await fsp.readdir(outDir)); } catch (e) { before = new Set(); }
  const r = await runCmd(ffmpeg, args, { timeout: 300000 });
  if (r.code !== 0) throw new Error('截帧失败：' + (r.stderr || r.stdout).split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' '));
  let n = 0, overwritten = 0;
  try {
    const after = await fsp.readdir(outDir);
    const mine = after.filter((f) => f.startsWith(base + '_') && f.endsWith('.jpg'));
    n = mine.filter((f) => !before.has(f)).length;
    overwritten = mine.length - n;
  } catch (e) { /* 目录读不到就报 0，不编数字 */ }
  return {
    outDir, count: n, overwritten,
    first: path.join(outDir, mode === 'single' ? `${base}_frame.jpg` : `${base}_001.jpg`),
  };
});

/* ================= IPC: 视频裁剪（v0.5.0） =================
 * 只做「按时间截一段」，不碰滤镜、转场、拼接 —— 那类需求属于剪辑软件。
 *
 * ============ 两种模式的取舍是实测出来的，不是猜的 ============
 * 参数里 mode 有两个值：
 *   · 'copy'   —— -c copy 流复制，几秒完成，但**起点会被吸附到关键帧**
 *   · 'encode' —— 重编码，慢，但起点精确到帧
 *
 * 实测数据（源：10 秒 testsrc2，25fps，关键帧间隔 2 秒；目标：从 3.0s 起切 2 秒）：
 *
 *   模式        输出时长    首帧 vs 源 3.0s 帧(PSNR)   首帧 vs 源 2.0s 帧
 *   copy        3.080 秒    12.19 dB（完全不同）         inf（完全一致）
 *   encode      2.000 秒    39.97 dB（几乎一致）        12.22 dB
 *
 * 也就是说：copy 模式下用户要的 3.0s 根本没生效，实际是从 **2.0s** 开始的，
 * 而且多出 1.08 秒的内容 —— 因为 ffmpeg 会把 -ss 之前的关键帧也带上，
 * 再用 -avoid_negative_ts 把时间轴归零。这是流复制的固有限制，
 * 不是参数没调对。
 *
 * 所以界面上必须明说「快速模式起点可能提前，最多一个关键帧间隔」，
 * 并且默认用精确模式。把决定性数字写在这里，是因为后来者看到
 * "copy 快 10 倍"很容易把它改成默认 —— 那样用户会拿到起点不对的成品，
 * 而这种错误在播放器里**看不出来**（画面是连续的，只是早了几秒）。
 *
 * ============ -ss 放 -i 前还是后？ ============
 * 实测两者等价（重编码时都精确）：ffmpeg 2.1 之后输入侧 -ss 解码后丢弃
 * 到目标时间点。这里统一放 -i 前 —— 它对长视频更快（解复用器可以先跳），
 * 而不会牺牲精度。
 *
 * ============ 为什么不做「按关键帧切」的智能吸附 ============
 * 那需要先 ffprobe 出每个关键帧时间，再挑最近的一个，然后告诉用户
 * "我把你的切点挪了 0.8 秒"。用户要的是「3:00 到 3:30 这一段」，
 * 移动切点是替用户改需求。宁可慢一点、准一点。
 */
handle(CH.FFMPEG.TRIM, async (e, { input, out, start, duration, mode }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');

  /* 参数校验放在跑 ffmpeg 之前：这些值会被拼进命令行，
   * 而 ffmpeg 的参数解析对 `-1` / `NaN` 的反应是"照做"而不是报错。
   *
   * 【必须先判 null/'' 再 Number()】Number(null) === 0、Number('') === 0，
   * 所以只写 `Number(start)` 的话，缺参数的调用会被静默当成「从 0 秒开始」。
   * 对 start 而言 0 是合法值，于是这个缺口**不会报错、结果看起来也正常** ——
   * 用户以为切的是 3:00 那段，实际切的是片头。这是被单测抓出来的
   * （test-video-trim 的「start=null 竟然没被拒绝」）。 */
  const isBlank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
  if (isBlank(start)) throw new Error('缺少起点');
  if (isBlank(duration)) throw new Error('缺少时长');
  const st = Number(start);
  const du = Number(duration);
  if (!isFinite(st) || st < 0) throw new Error('起点无效');
  if (!isFinite(du) || du <= 0) throw new Error('时长必须大于 0');

  /* 输出路径两条闸门（与 audio-cut 同一套）：
   *   ① 不能等于输入 —— 否则源文件被成品覆盖，且原片不可恢复
   *   ② 不能落在系统关键目录（pathGuard）
   *
   * 「不覆盖已有文件」这一条不在这里做，而是渲染层先用 fs:unique-path
   * 生成不重名的路径再传进来。理由：这类工具的典型用法是"反复调参数试切"，
   * 每次都该留下一个成品供对比；在主进程强判"已存在就报错"只会让用户
   * 每次手动改文件名。代价是主进程这一层可以"覆盖任意非关键路径"——
   * 这与 video-press / target 的既有语义一致，不在这里单独收紧。 */
  if (path.resolve(String(out)) === path.resolve(String(input))) throw new Error('输出文件不能与源文件相同');
  const bad = pathGuard.checkOverwritable(out);
  if (bad) throw pathGuard.err(bad.code, bad.reason);

  const encode = mode !== 'copy';
  const args = ['-hide_banner', '-y', '-nostats'];
  /* -ss 放输入侧（见上方实测说明）。保留两位小数即可，多余的精度没有意义。 */
  args.push('-ss', st.toFixed(3));
  args.push('-i', input);
  args.push('-t', du.toFixed(3));

  /* 【已取消句柄必须在第一个 await 之前登记】
   * 这里原本是"拼完 args → 再 jobs.set"。加入硬件加速后，
   * `await videoEncodeArgs(...)` 成了本 handler 的第一个 await，
   * 于是 job 句柄的登记被推到了 await 之后 —— 调用方拿到返回的 id 时
   * （TRIM 是同步返回 id 的）句柄还不存在，`job:kill` 找不到任务。
   * 表现是「点取消没反应」，而 test-video-trim 的取消用例直接红。
   * 现在把 id/state/jobs.set 提到最前面：句柄先有，再做任何异步动作。 */
  const id = 'vtr' + (ctx.nextJobSeq());
  const state = { cancel: false, proc: null };
  const killProc = () => killFfmpegTree(state.proc);
  jobs.set(id, { cancel: () => { state.cancel = true; killProc(); } });
  setLatestCancelable(() => { state.cancel = true; killProc(); });

  if (encode) {
    /* 编码参数沿用视频压制页的"均衡"档，不提供界面旋钮 ——
     * 「最简单的裁剪」不该让用户学 CRF 是什么。
     * 【硬件加速开关同样作用于这里】用户开的是「视频编码用硬件」，
     * 裁剪重编码也是视频编码；如果只给转码页加速而裁剪页不动，
     * 用户会觉得那个开关时灵时不灵。 */
    const trimEnc = await videoEncodeArgs({ vcodec: 'libx264', crf: 20, preset: 'veryfast' });
    args.push(...trimEnc.args);
    args.push('-pix_fmt', 'yuv420p');
    /* 音频：有音轨就重编码成 AAC。不选 copy —— 视频重编码时音频 copy 会
     * 因为时间戳对齐问题在某些源上产生"整段静音"或爆音。 */
    args.push('-c:a', 'aac', '-b:a', '160k');
    /* faststart 让成品能边下边播（把 moov 挪到文件头），代价可以忽略。 */
    args.push('-movflags', '+faststart');
  } else {
    args.push('-c', 'copy');
    /* 【这两个参数是流复制能播放的前提】
     * 输入侧 -ss 之后，输出时间戳会从负数开始；不加 make_zero 的话
     * 成品开头有一段"不存在的时间"，部分播放器会卡住或显示黑屏。
     * 但它也正是上面实测里"时长多出 1.08 秒"的来源之一 ——
     * 这是模式的固有代价，不是 bug，界面上已写明。 */
    args.push('-avoid_negative_ts', 'make_zero');
  }
  /* 【-stats_period 必须设小，否则短片段只有一条进度】
   * ffmpeg 默认每 0.5 秒发一次进度块。裁一个 4 秒的片段只要 0.6 秒左右，
   * 于是整个过程只发得出 **1 条** out_time_us —— 界面上的进度条从 0 直接
   * 跳到 99%，等于没有进度。
   *
   * 实测（10 秒源切 10 秒、preset slow）：
   *   默认（0.5s）     0.75 秒完成，2 条进度
   *   -stats_period 0.1  0.75 秒完成，6 条
   *   -stats_period 0.05 0.64 秒完成，9 条
   * 取 0.2：足够让进度条动起来，又不会把 IPC 刷得太密
   * （每条都要过一次进程间通信和一次 JSON.parse）。
   *
   * 另外注意 -progress 与 -stats_period 是**两个独立开关**：
   * 去掉 -progress 时 stdout 是 0 字节（实测），进度会彻底消失。 */
  args.push('-stats_period', '0.2');
  args.push('-progress', 'pipe:1');
  args.push(out);

  try {
    const r = await new Promise((resolve) => {
      const proc = spawn(ffmpeg, args, { windowsHide: true });
      state.proc = proc;
      let errOut = '', progBuf = '';
      proc.stdout.on('data', (d) => {
        progBuf += String(d);
        const lines = progBuf.split('\n');
        progBuf = lines.pop() || '';
        for (const line of lines) {
          const m = line.match(/out_time_us=(\d+)/);
          /* 进度按「已输出时长 / 目标时长」算，封顶 99 ——
           * 最后 1% 留给"文件真的写完了"这个确认动作。 */
          if (m && du > 0) {
            const pct = Math.min(99, parseInt(m[1]) / 1e6 / du * 100);
            send('job:stream', { id, data: JSON.stringify({ pct }) });
          }
        }
      });
      proc.stderr.on('data', (d) => { errOut += String(d); if (errOut.length > 20000) errOut = errOut.slice(-8000); });
      proc.on('exit', (code) => resolve({ code, errOut }));
      proc.on('error', (err) => resolve({ code: -1, errOut: err.message }));
    });

    if (state.cancel) {
      try { await fsp.rm(out, { force: true }); } catch (err) {}
      throw new Error('已取消');
    }
    if (r.code !== 0 || !(await pathExists(out))) {
      /* 失败必须清掉半成品：留着的话用户会以为"切成功了，只是短了一点"，
       * 而这个文件可能在中间某处就断了。 */
      try { await fsp.rm(out, { force: true }); } catch (err) {}
      throw new Error('裁剪失败：' + (r.errOut.split(/\r?\n/).filter((l) => l.trim()).slice(-2).join(' ') || ('退出码 ' + r.code)));
    }

    /* 回读成品的实际时长报给界面。
     * 【为什么值得多跑一次 ffprobe】copy 模式下实际时长会与请求的不同
     * （关键帧吸附），界面必须显示**实际**值 —— 否则用户看着"2.00 秒"
     * 却拿到 3.08 秒的文件，下次就不敢信这个工具了。 */
    let outDur = 0, size = 0;
    try { size = (await fsp.stat(out)).size; } catch (err) {}
    const ffprobe = findFfprobe();
    if (ffprobe) {
      try {
        const pr = await runCmd(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', out], { timeout: 15000 });
        outDur = parseFloat((JSON.parse(pr.stdout).format || {}).duration) || 0;
      } catch (err) {}
    }
    send('job:stream', { id, data: JSON.stringify({ pct: 100, done: true }) });
    return { out, size, duration: outDur, mode: encode ? 'encode' : 'copy' };
  } finally {
    jobs.delete(id);
  }
});

/* 音频剪辑：截取 + 淡入淡出 + 增益 */
handle(CH.FFMPEG.AUDIO_CUT, async (e, { input, out, ss, dur, fadeIn, fadeOut, gain, format }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  // 输出路径不允许等于输入路径（否则会把源文件覆盖成剪辑结果）
  try {
    if (path.resolve(String(out)) === path.resolve(String(input))) throw new Error('输出文件不能与源文件相同');
    const bad = pathGuard.checkOverwritable(out);
    if (bad) throw pathGuard.err(bad.code, bad.reason);
  } catch (err) { throw err; }
  const ac = format === 'mp3' ? 'libmp3lame' : format === 'wav' ? 'pcm_s16le' : format === 'flac' ? 'flac' : 'aac';
  const args = ['-hide_banner', '-y'];
  if (ss) args.push('-ss', String(ss));
  args.push('-i', input);
  if (dur > 0) args.push('-t', String(dur));
  const filters = [];
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn}`);
  if (fadeOut > 0) {
    // 淡出起点取「截取时长」或源时长减淡出长度
    let total = dur > 0 ? dur : 0;
    if (total <= 0) {
      try {
        const ffprobe = findFfprobe();
        if (ffprobe) {
          const rp = await runCmd(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', input], { timeout: 15000 });
          total = parseFloat((JSON.parse(rp.stdout).format || {}).duration) || 0;
        }
      } catch (err) {}
    }
    const st = Math.max(0, total - fadeOut);
    filters.push(`afade=t=out:st=${st.toFixed(2)}:d=${fadeOut}`);
  }
  if (gain) filters.push(`volume=${gain}dB`);
  args.push('-vn', '-c:a', ac);
  if (ac === 'aac') args.push('-b:a', '192k');
  if (filters.length) args.push('-af', filters.join(','));
  args.push(out);
  const r = await runCmd(ffmpeg, args, { timeout: 300000 });
  if (r.code !== 0 || !(await pathExists(out))) throw new Error('剪辑失败：' + (r.stderr || r.stdout).split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' '));
  return { out, size: (await fsp.stat(out)).size };
});
/* ================= IPC: 屏幕录制（ffmpeg gdigrab，区域/声音/暂停分段/GIF） ================= */
let recProc = null, recOut = null, recSegs = [], recSegDir = null, recOpts = null;
// 分段数量（拼接降级提示用）
function fmtDur(segs) { return (segs || []).length + ' 段'; }
// 解析 ffmpeg -list_devices 输出。兼容三种格式：
//   4.x : "名称" (audio)  /  [dshow] "名称" (audio) 后的旧式行 "名称" [Audio]
//   6.x+: 不再输出 "DirectShow audio devices" 小节标题，逐行 "名称" (video)/(audio)
function parseDshowDevices(text) {
  const audio = [], video = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/"([^"]+)"\s*(?:\[(Audio|Video)\]|\((audio|video)\))\s*$/i);
    if (!m) continue;
    const name = m[1];
    const kind = (m[2] || m[3]).toLowerCase();
    if (kind === 'audio') { if (!audio.includes(name)) audio.push(name); }
    else if (!video.includes(name)) video.push(name);
  }
  return { audio, video };
}
/* ============ dshow 设备枚举的超时兜底 ============
 *
 * 【为什么必须有超时】
 * 原实现只靠 exit / error 两个事件收尾：
 *   p.on('exit',  () => resolve(out));
 *   p.on('error', () => resolve(''));
 * 只要 ffmpeg 既没退出也没报错，这个 Promise 就**永不 resolve** ——
 *
 *   实测（用一个永不退出的子进程模拟）：
 *     3 秒后仍未 resolve —— 无超时会让通道永久挂起
 *
 * 而它的调用方是 rec:audio-devices，也就是录音页打开时拉下拉框的那次调用。
 * 结果是：下拉框永远转圈，用户以为软件卡死，切走再切回来仍然是转圈。
 * 主进程没崩、日志没有报错，只是那条通道再也没有回过话。
 *
 * 【什么情况会挂住】dshow 是驱动层枚举，实测过的卡死形态：
 *   · 某个摄像头驱动占着设备不放（另一个会议软件正在用）
 *   · 虚拟摄像头（OBS / ManyCam）已卸载但注册表残留，ffmpeg 反复重试
 *   · 蓝牙音频设备休眠，OpenDevice 阻塞在驱动里
 * 这些都不产生 exit 也不产生 error —— 正是超时要兜的那一档。
 *
 * 【为什么是 15 秒而不是 3 秒】
 * 实测 dshow 枚举在设备多的机器上要 2~5 秒（每个设备都要 Open/Close 一次
 * 拿能力信息）。取值太紧会把「慢」误判成「挂」，用户设备列表就变成空的 ——
 * 那是把一个偶发的卡死换成每次必现的空列表，更糟。
 * 15 秒 = 正常最慢情况（约 5 秒）的 3 倍余量，同时远小于用户的耐心阈值。
 * 超时后返回空列表而不是抛错：调用方（录音页）对空列表已有「无可用设备」
 * 的展示分支，抛错则会让整个页面报红。
 *
 * 【超时后必须 kill，不能只 resolve】
 * 只 resolve 不杀的话，那个 ffmpeg 进程会一直挂着：下次打开录音页再枚举一次，
 * 又多一个。用户来回切几次就是一堆孤儿进程，且它们可能正占着摄像头，
 * 让新一次枚举也失败 —— 从「偶尔卡住」恶化成「永远拿不到设备」。
 * kill 用 taskkill /t 连子进程一起收（ffmpeg 在 Windows 上会 fork 出子进程）。
 *
 * scripts/test-dshow-timeout.js 把这三件事分别钉住了：
 * 挂住时必须 resolve、超时后必须 kill、正常退出时必须不 kill。 */
const DSHOW_LIST_TIMEOUT_MS = 15000;

async function listDshowDevices() {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return { audio: [], video: [] };
  const r = await new Promise((resolve) => {
    let out = '';
    let settled = false;
    /* 【timer 必须先声明成 undefined，不能等 setTimeout 那行再 const】
     * settle 里 clearTimeout(timer)，而 settle 会被 exit/error 调用 ——
     * 若 spawn 同步抛（极少数情况下 ENOENT 的判定不在异步路径），
     * 或 error 事件比下面那句 const timer 更早派发，就会命中 TDZ：
     *   ReferenceError: Cannot access 'timer' before initialization
     * 那会把「枚举失败」变成「主进程抛异常」，比原来的问题更糟。 */
    let timer;
    /* 收尾统一走这里：保证 resolve 只发生一次，且一定要清掉定时器
     * （不清的话进程会因为还有一个 pending timer 而晚退出，测试里表现为「跑完不结束」）。 */
    const settle = (val, proc) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      /* 只有「超时」这一档需要杀。正常 exit 时进程已经没了，
       * 再 kill 一次会拿到 ESRCH —— 虽然被 catch 掉了，但没有意义。 */
      if (val === null) {
        killFfmpegTree(proc);
        resolve('');
        return;
      }
      resolve(val);
    };
    const p = spawn(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true });
    timer = setTimeout(() => settle(null, p), DSHOW_LIST_TIMEOUT_MS);
    /* 定时器不该拖住进程退出：它只是兜底，不是常驻任务。 */
    if (timer && typeof timer.unref === 'function') timer.unref();
    p.stderr.on('data', d => { out += String(d); });
    p.on('exit', () => settle(out, p));
    p.on('error', () => settle('', p));
  });
  return parseDshowDevices(r);
}
handle(CH.REC.AUDIO_DEVICES, async () => {
  const d = await listDshowDevices();
  return { devices: d.audio, audio: d.audio, video: d.video };
});
/* rec:video-devices 已移除：录音页的下拉框由 rec:audio-devices 一次拿全
 * （它同时返回 audio 与 video），不必再开一条只取摄像头的通道。 */
// 画中画位置 → overlay 表达式（摄像头尺寸自适应，边距 16px）
function pipPosition(pos) {
  const pad = 16;
  switch (pos) {
    case 'lt': return '16:16';
    case 'rt': return `W-w-${pad}:16`;
    case 'lb': return `16:H-h-${pad}`;
    default: return `W-w-${pad}:H-h-${pad}`; // rb 默认
  }
}
function recSpawnSeg(segPath) {
  const ffmpeg = findFfmpeg();
  const o = recOpts;
  const args = ['-y', '-hide_banner', '-f', 'gdigrab', '-framerate', String(o.fps || 30)];
  if (o.rect) args.push('-offset_x', String(o.rect.x), '-offset_y', String(o.rect.y), '-video_size', `${o.rect.w}x${o.rect.h}`);
  args.push('-i', 'desktop');
  // 输入序号：0=桌面，1=摄像头（可选），其后为音频
  let nextIdx = 1;
  let camIdx = -1;
  if (o.camera) { args.push('-f', 'dshow', '-rtbufsize', '64M', '-i', `video=${o.camera}`); camIdx = nextIdx++; }
  if (o.audio) args.push('-f', 'dshow', '-rtbufsize', '64M', '-i', `audio=${o.audio}`);
  const fps = o.fps || 30;
  if (camIdx >= 0) {
    // 摄像头缩放到画面宽度的 25%（且为偶数），叠加到指定角落
    const scale = Math.min(Math.max(o.camScale || 0.25, 0.1), 0.5);
    const pos = pipPosition(o.camPos || 'rb');
    args.push('-filter_complex',
      `[${camIdx}:v]fps=${fps}[camf];[camf][0:v]scale2ref=w=trunc(main_w*${scale}/2)*2:h=-2[cams][basem];[basem][cams]overlay=${pos}:format=auto[vout]`,
      '-map', '[vout]');
    if (o.audio) args.push('-map', `${camIdx + 1}:a`);
  }
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
  if (o.audio) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-movflags', '+faststart', segPath);
  const proc = spawn(ffmpeg, args, { windowsHide: true });
  /* 【在 spawn 的同一个同步块里就挂上 error 监听】
   * 调用方 recStartSeg 确实会再挂一个（它要拿错误原因），但此刻中间只隔了
   * 几行同步代码 —— 那不是契约，是巧合。将来谁在这两处之间插一个 await，
   * 监听就会晚于 error 事件发生，而那时它已经升级成 uncaughtException。
   * 这里先挂一个空监听把这个时间窗填掉，语义上仍然是「调用方负责处理」。 */
  proc.on('error', () => {});
  return { proc, args };
}
handle(CH.REC.START, async (e, { outPath, fps, rect, audio, camera, camPos, camScale, overwrite }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  if (recProc && recProc.exitCode === null) throw new Error('已有录制进行中');
  /* 录制曾经是唯一没走覆盖闸门的写盘通道：recOut 直接等于渲染层给的 outPath，
   * 目标已存在就被 copyFile / ffmpeg -y 静默盖掉，界面上还只显示「录制完成」。
   *
   * 但「一律拒绝」也过头了：输出路径是走 dialog:save 选的，Windows 原生保存框
   * 在用户选中已存在文件时会**自己弹**「文件已存在，要替换它吗？」，
   * 用户点过「是」之后再被这里二次否决，就只能手动改文件名 ——
   * 等于把系统对话框的确认当空气，这是 v0.2.7 引入的回归。
   *
   * 所以分两种情况：
   *   overwrite=true  用户在系统对话框里已明确确认要替换，放行；
   *   overwrite 缺省  非交互调用（将来若有），保守起见仍然拒绝。
   * 无论哪种情况，系统关键目录的闸门都照旧执行 —— 不能因为「用户确认过」
   * 就去覆盖 System32 里的文件。 */
  if (typeof outPath !== 'string' || !outPath.trim()) throw new Error('录制输出路径无效');
  const recBad = pathGuard.checkOverwritable(outPath);
  if (recBad) throw pathGuard.err(recBad.code, recBad.reason);
  if (fs.existsSync(outPath) && !overwrite) {
    throw new Error('目标文件已存在，为避免覆盖已拒绝：' + outPath);
  }
  recOut = outPath;
  // yuv420p 要求偶数尺寸/偏移，框选结果向下取偶
  if (rect && typeof rect === 'object') {
    rect = { x: Math.max(0, Math.round(rect.x)) & ~1, y: Math.max(0, Math.round(rect.y)) & ~1,
      w: Math.max(64, Math.round(rect.w)) & ~1, h: Math.max(64, Math.round(rect.h)) & ~1 };
  } else rect = null;
  recOpts = { fps: fps || 30, rect, audio: audio || null, camera: camera || null, camPos: camPos || 'rb', camScale: camScale || 0.25 };
  recSegs = [];
  recSegDir = tempNames.recSegDir({ tempDir: tempDir() });
  await fsp.mkdir(recSegDir, { recursive: true });
  try {
    return await recStartSeg();
  } catch (err) {
    // 启动失败必须回滚状态：否则临时目录泄漏，且下次 resume 会误判会话仍在
    const dir = recSegDir;
    recOpts = null; recSegs = []; recSegDir = null; recProc = null;
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
});
async function recStartSeg() {
  const seg = path.join(recSegDir, `seg-${recSegs.length + 1}.mp4`);
  const { proc } = recSpawnSeg(seg);
  recProc = proc;
  let errOut = '';
  /* 【必须挂 error 监听，否则「ffmpeg 起不来」会把主进程炸掉】
   * spawn 失败（可执行文件被删/被杀软隔离/无执行权限）时 Node 会 emit 'error'；
   * 这里原来一个监听都没有，于是这个 error 升级成 uncaughtException ——
   * 用户点「开始录制」看到的不是「启动失败」，而是整个程序没了，
   * 下次启动还会被标成「上次异常退出」。
   * 记进 errOut 而不是只吞掉：下面 1.2 秒后的判据要用它给出失败原因。 */
  /* 【类型标注是给 tsc 看的】不写这一行时 `let spawnErr = null` 会被推断成
   * 类型 never（从未赋过值），下面判空后的 `.message` 就报 TS2339。
   * 运行时行为与此无关，但 checkJs 会红。 */
  /** @type {Error|null} */
  let spawnErr = null;
  proc.on('error', (err) => { spawnErr = err; });
  proc.stderr.on('data', (d) => { errOut += String(d); if (errOut.length > 12000) errOut = errOut.slice(-6000); });
  await new Promise(r => setTimeout(r, 1200));
  /* 【判据要同时看 spawn 错误，不能只看 exitCode】
   * spawn 失败时进程根本没起来，exitCode 一直是 null ——
   * 只判 `proc.exitCode !== null` 会把它当成「录制正常进行中」，
   * 于是界面上开始计时，而磁盘上什么都不会写出来。 */
  if (spawnErr || proc.exitCode !== null) {
    recProc = null;
    /* spawnErr 是 Error，但 Node 的 spawn 错误会在上面挂 code（ENOENT/EACCES），
     * 所以这里按 any 取 —— 直接写 spawnErr.code 会让 checkJs 报"Error 上没有 code"。 */
    const spawnCode = /** @type {any} */ (spawnErr || {}).code;
    const reason = spawnErr ? ('无法启动 ffmpeg：' + (spawnErr.message || spawnCode)) : errOut.split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' ');
    throw new Error('录制启动失败：' + reason);
  }
  recSegs.push(seg);
  return { ok: true, paused: false };
}
async function recStopSeg() {
  const proc = recProc;
  recProc = null;
  if (!proc || proc.exitCode !== null) return;
  await new Promise((resolve) => {
    proc.once('exit', resolve);
    try { proc.stdin.write('q'); } catch (e) {}
    setTimeout(() => { try { spawnDetached('taskkill', ['/pid', String(proc.pid), '/t', '/f']); } catch (err) {} }, 5000);
  });
  await new Promise(r => setTimeout(r, 300));
}
handle(CH.REC.PAUSE, async () => { await recStopSeg(); return { ok: true, paused: true }; });
handle(CH.REC.RESUME, async () => {
  // rec:stop 的 finally 会把 recOpts/recSegDir 置空；只检查 recOpts 会漏掉 recSegDir 已失效的情况
  if (!recOpts || !recSegDir) throw new Error('没有进行中的录制会话');
  return await recStartSeg();
});
handle(CH.REC.STOP, async (e, makeGif) => {
  await recStopSeg();
  if (!recSegs.length) return { ok: true, size: 0, outPath: recOut };
  // 拼接失败时的降级标记：必须如实告诉用户只拿到了第一段，
  // 否则“暂停过的录制”会静默丢掉后半段，用户还以为完整。
  let degraded = null;
  // 用 try/finally 保证临时分段目录一定被清理（原先清理写在末尾，中途抛错就泄漏）
  try {
    try {
      if (recSegs.length === 1 && recSegs[0]) {
        await fsp.copyFile(recSegs[0], recOut);
      } else {
        // 分段无损拼接（相同编码参数）
        const listFile = path.join(recSegDir, 'list.txt');
        await fsp.writeFile(listFile, recSegs.map(s => `file '${s.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
        const ffmpeg = findFfmpeg();
        const r = await runCmd(ffmpeg, ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', recOut], { timeout: 120000 });
        if (r.code !== 0) throw new Error('分段拼接失败：' + (r.stderr || '').split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' '));
      }
    } catch (err) {
      // 兜底只能保住第一段，必须把这件事说出来
      try {
        if (recSegs[0]) await fsp.copyFile(recSegs[0], recOut);
        degraded = `分段合并失败（${err.message}），已保存第一段共 ${fmtDur(recSegs)}；其余 ${recSegs.length - 1} 段未能合并`;
        console.warn('[rec] ' + degraded);
      } catch (e2) {
        degraded = `分段合并失败且无法保存任何分段：${err.message}`;
        throw err;
      }
      // 分段目录会被保留（finally 里降级时不删），把路径告诉用户以便手工合并
      degraded += `；剩余分段保留在 ${recSegDir}`;
    }
    let gifOut = null;
    if (makeGif) {
      /* 【GIF 目标名的两个坑】
       * 1) 用户走 dialog:save，文件名可以是任意东西。原来用
       *    `/\.mp4$/i` 只认 mp4 —— 存成 .mkv/.avi 时替换不生效，
       *    gifTarget === recOut，ffmpeg 一边读一边 `-y` 写同一个文件。
       * 2) 改成「剥掉最后一个扩展名再加 .gif」仍有坑：
       *    录成 `D:\rec\v1.2`（无扩展名但含点）→ 得到 `D:\rec\v1.gif`；
       *    录成 `D:\rec\.hidden` → 整个文件名被当成扩展名，结果跑到
       *    **父目录** `D:\rec.gif`。
       * 两种情况下，失败分支里的 `rm(gifTarget)` 删掉的是与本次录制
       * 毫不相干的用户既有文件。
       * 现在：只在确实是已知视频扩展名时才剥离，否则直接拼 `.gif`；
       * 并且**只在文件是我们这次新建时才删**（先记下它原本是否存在）。 */
      const REC_VIDEO_EXT = /^\.(mp4|mkv|avi|mov|webm|m4v|flv|wmv|ts)$/i;
      const recExt = path.extname(recOut);
      let gifTarget = REC_VIDEO_EXT.test(recExt)
        ? recOut.slice(0, -recExt.length) + '.gif'
        : recOut + '.gif';
      if (path.resolve(gifTarget).toLowerCase() === path.resolve(recOut).toLowerCase()) {
        gifTarget = recOut + '.gif';   // 兜底：绝不能与录像同路径
      }
      /* 目标已存在 → 不覆盖、不改名去猜，直接换一个不冲突的名字，
       * 这样失败清理绝不会误删用户原有的 gif。 */
      const gifPreexisted = await pathExists(gifTarget);
      if (gifPreexisted) {
        const stem = gifTarget.slice(0, -'.gif'.length);
        for (let i = 1; i < 1000 && await pathExists(gifTarget); i++) gifTarget = `${stem}(${i}).gif`;
      }
      try {
        const ffmpeg = findFfmpeg();
        const r = await runCmd(ffmpeg, ['-y', '-hide_banner', '-i', recOut, '-vf', 'fps=10,scale=480:-2:flags=lanczos', gifTarget], { timeout: 300000 });
        if (r.code !== 0) throw new Error('GIF 转码失败');
        gifOut = gifTarget;
      } catch (err) {
        // 失败时 ffmpeg 会留下体积不足的残缺 .gif，必须删掉，
        // 否则用户看到「录制完成」却发现目录里多了一个打不开的文件。
        // 但**只删我们自己新建的**：万一目标名撞上了用户既有文件，删了就是毁数据。
        if (!gifPreexisted) await fsp.rm(gifTarget, { force: true }).catch(() => {});
        gifOut = null;
      }
    }
    let size = 0;
    try { size = (await fsp.stat(recOut)).size; } catch (e) {}
    return { ok: true, size, outPath: recOut, gif: gifOut, degraded };
  } finally {
    // 降级（拼接失败、只保住第一段）时**不删**分段目录：
    // 用户可能想手工合并剩下的分段，无条件删掉等于把后半段录像永久销毁。
    // 只有完整成功才清理。
    if (!degraded) {
      await fsp.rm(recSegDir, { recursive: true, force: true }).catch(() => {});
    } else {
      console.warn('[rec] 保留分段目录以便手工恢复：' + recSegDir);
    }
    recOpts = null; recSegs = []; recSegDir = null;
  }
});
};
