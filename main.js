'use strict';
/* 启动耗时打点（仅 HEHE_BOOTTIME 设置时启用，不影响正常运行）
   注意：这里必须用 require 现场取 fs，不能引用下面 `const fs = require('fs')`。
   那个 const 还没有初始化（TDZ），bootMark 里 try/catch 会把 ReferenceError
   默默吞掉，导致最靠前的 main-start / electron-loaded 两条打点永远丢失。 */
const BOOT_T0 = Date.now();
const BOOT_FILE = process.env.HEHE_BOOTTIME || null;
function bootMark(name) {
  if (!BOOT_FILE) return;
  try { require('fs').appendFileSync(BOOT_FILE, name + '\t' + (Date.now() - BOOT_T0) + '\n'); } catch (e) {}
}
bootMark('main-start');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, Tray, Menu, screen, globalShortcut, nativeTheme, desktopCapturer } = require('electron');
bootMark('electron-loaded');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, spawnSync } = require('child_process');
const http = require('http');
const AdmZip = require('adm-zip');
const solarlunar = require('solarlunar');
const archiveGuard = require('./lib/archive-guard'); // 解压安全预检（路径穿越/ADS/设备名/限额）
const archiveProcess = require('./lib/archive-process');
const targetSize = require('./lib/target-size');     // 目标体积压缩的多轮逼近算法
const errorInfo = require('./lib/errors');           // 结构化错误（稳定错误码 + 建议操作）
const pathGuard = require('./lib/path-guard');       // 破坏性操作的路径安全网（删/写/覆盖）
const windowSecurity = require('./lib/window-security');
const updateFile = require('./lib/update-file');
const downloadLib = require('./lib/download');
const powerGate = require('./lib/power-gate');       // 电源命令识别 + 门禁判定（与测试共享同一实现）
/* lib/job-id 只在**渲染层一侧**用（js/job-prefixes.js 与它对齐）。
 * 主进程从来不读这张表：事件过滤是渲染层 claimJobId 做的。
 * 这里原先有一行未使用的 require，已删除 —— 留着会让「主进程也参与过滤」
 * 看起来像真的，实际两份数据源靠测试脚本手工对齐，容易长期漂移。 */
const fsOps = require('./lib/fs-ops');               // 唯一名/临时名等文件命名纯逻辑
const mojibake = require('./lib/mojibake');           // 乱码识别与编码探测（纯逻辑）
const diskHealth = require('./lib/disk-health');      // 磁盘健康：诚实区分「拿到了/拿不到」（纯逻辑）
/* lanScanLib 不再在 main.js 里用：它所有的调用点都随 network 域
 * 搬到了 ipc/net-lan.js（那个模块自己 require）。留在这里会让
 * ESLint 报 no-unused-vars —— 这是好事，说明搬运是干净的。 */
/* 临时产物命名的**唯一来源**：生成函数与清理白名单在同一个模块里，
 * 避免"新增一种产物忘了登记白名单"（.hehe-7zx-* 那次残留事故的根因）。 */
const tempNames = require('./lib/temp-names');
/* 文件名用的**本地**时间戳。原来几处直接用 toISOString()，那是 UTC ——
 * UTC+8 用户看到的 hosts 备份名会差 8 小时，在「恢复 hosts」列表里挑错备份。
 * 内部诊断用的 .corrupt- 备份仍走 UTC（跨时区比对更方便），不在此列。 */
const timeStamp = require('./lib/time-stamp');
/* 崩溃日志：打包后的 exe 没有控制台，异常只写 console 等于没记。
 * 这个模块负责脱敏、截断、轮转，主进程这边只提供目录与时机。 */
const crashLog = require('./lib/crash-log');
const CH = require('./lib/channels').CHANNELS;   // IPC 通道名唯一来源（见文件头说明）
/* 用户可调偏好的规格表（默认值/区间/类型）。**渲染层与主进程共用同一份** ——
 * 主进程侧只有少数几项要用（标尺最小长度、崩溃日志份数、更新缓存时长），
 * 但区间校验必须与设置页一致，否则"设置页夹到 20，主进程照收 999"。
 * 文件在 js/ 下是因为它主要服务渲染层；这里 require 不会引入 electron 依赖。 */
const prefsSpec = require('./lib/prefs-spec');
const { OwnerJobMap } = require('./lib/job-owner');   // 任务归属（谁发起的、关窗时清账）
const { pickSendTarget } = require('./lib/ipc-route'); // 推送发给谁（三档判据，纯函数）
const toolNames = require('./lib/tool-names');      // 工具 id → 中英文名（独立窗口标题用）
/* 【任务 5 之后这里少了 5 个 require】rm-lockers / links / dir-move /
 * acl-repair / channels 现在只被 ipc/dir-acl-links.js 使用 —— 那两个域连同
 * handle(dirMoveCh.X.Y, ...) 一起搬过去了，模块自己 require 它们。
 * 留着这些 require 就是「main.js 顶部引了但没人用」，ESLint 的
 * no-unused-vars 会立刻报出来（它确实报了，我才发现的）。 */
bootMark('deps-loaded');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
let win = null;
let tray = null;
let isQuitting = false;
let jobSeq = 0;
/* 后台任务表。形状仍是 Map（id → { cancel }），只是多记了一个 ownerWC ——
 * 即「这条任务是哪个窗口发起的」。为什么要记：独立工具窗口关掉之后，
 * 它启动的任务原来会继续跑，并且每条 job:stream 都被 send 的兜底逻辑
 * 甩到主窗口去，冒充成主窗口的任务（详见 lib/job-owner.js 头部）。
 *
 * 【为什么收在这里而不是给 20 多处 jobs.set 逐个补字段】
 * 那种做法漏一处就是一条静默的孤儿任务路径，而以后新写的任务默认又会忘。
 * set() 里统一打标，调用点一处都不用改。
 *
 * 发起者从 ALS 上下文取（currentSender 会读 als）。这里传的是**函数**而不是
 * 当场取到的值：als 在本行之后才声明（TDZ），而箭头体只在 set() 时才执行，
 * 那时 als 早已初始化完毕。 */
const jobs = new OwnerJobMap(() => {
  const s = currentSender();
  return (s && typeof s.id === 'number') ? s.id : null;
});
const serverMap = new Map();
/* 静态服务的根目录与端口。服务活在主进程、跨页面存活，
 * 所以这些信息必须留在主进程，供 server:status 回填界面。 */
let serverRoot = null, serverPort = null;
let lastCpuSample = null;
let lastProcSnap = null;

/* ---------------- data store ---------------- */
const storeFile = () => path.join(app.getPath('userData'), 'hehe-data.json');
/* 崩溃日志目录。放在 userData 下，与数据文件同一个根 ——
 * 用户要把它发给开发者时只需要知道一个位置（设置页有「打开日志目录」入口）。 */
const crashLogDir = () => path.join(app.getPath('userData'), 'logs');
/* 上次是否异常退出。启动时读一次并清掉标记，之后固定用这个值，
 * 免得中途再打开设置页时又把它当成"本次异常"。 */
let lastSessionCrashed = false;
let storeData = { settings: {}, favorites: [], recents: [], quicklaunch: [], commands: [], clipHistory: [], notes: [], autostartBackup: [] };
// 记录 store 是否加载成功。损坏的 hehe-data.json 会让 loadStore 静默回退默认值，
// 此时 clipHistory 是空的——若照常跑清扫，clip-img 里的所有图片都会被当孤儿删光。
let storeLoadFailed = false;
/* 加载失败时保存的原始损坏文件副本路径（供界面提示用户「原文件在这里」）。 */
let storeCorruptCopy = null;
let saveTimer = null;
function loadStore() {
  try {
    storeData = Object.assign(storeData, JSON.parse(fs.readFileSync(storeFile(), 'utf8')));
  } catch (e) {
    // 首次运行（ENOENT）是正常的；解析失败才是真问题，必须标记出来
    if (e && e.code !== 'ENOENT') {
      storeLoadFailed = true;
      console.error('[store] 读取失败，本次禁用依赖 store 的清扫：', e.message);
      /* 【关键：先留原始副本，再让内存回退默认值】
       * loadStore 失败后 storeData 停在默认值（笔记、收藏、剪贴板历史全空）。
       * 而 storeSet 是**任何**一次设置变更都会走的路（拨一个开关、自动记一条
       * 剪贴板、加一条待办…），saveStore 200ms 后就把这份「空数据」原子改名
       * 落到 hehe-data.json 上 —— 原文件当场被覆盖，且没有任何备份。
       * 实测复现：文件尾部被截断（断电典型形态）→ 拨一下「关闭到托盘」开关
       * → 100 篇笔记永久消失。
       * 解析失败的 JSON 往往**大部分内容是完好的**（只是尾部截断/多了一个逗号），
       * 用户/我们可以用编辑器手工救回来。所以这里原样复制一份带时间戳的副本，
       * 让「救得回来」这件事至少成立；文件名也记下来，界面上能告诉用户去哪找。 */
      try {
        const raw = fs.readFileSync(storeFile());
        const stamp = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 23);
        const bak = storeFile() + '.corrupt-' + stamp + '.json';
        fs.writeFileSync(bak, raw);
        storeCorruptCopy = bak;
        console.error('[store] 原文件已另存为', bak);
      } catch (e2) {
        console.error('[store] 另存损坏文件失败（原文件仍在原位）：', e2.message);
      }
    }
  }
}
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushStore, 200);
}
function flushStore() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const tmp = storeFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(storeData, null, 2));
    fs.renameSync(tmp, storeFile()); // 原子替换，避免断电/崩溃截断数据
  } catch (e) { console.error('store save failed', e); }
}
function storeGet(key, def) {
  const parts = String(key).split('.');
  let cur = storeData;
  for (const p of parts) { if (cur == null || typeof cur !== 'object') return def; cur = cur[p]; }
  return cur === undefined ? def : cur;
}
function storeSet(key, val) {
  const parts = String(key).split('.');
  let cur = storeData;
  for (let i = 0; i < parts.length - 1; i++) { if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}; cur = cur[parts[i]]; }
  cur[parts[parts.length - 1]] = val;
  saveStore();
  return true;
}

/** 读一项用户偏好（带区间夹取），主进程侧用。
 *
 *  【为什么不像渲染层那样缓存】
 *  主进程用到的地方只有三处（标尺最小长度、崩溃日志份数、更新缓存时长），
 *  都是低频路径（开标尺、写日志、点检查更新）。每次现读 storeData 更简单，
 *  也不会出现"渲染层改了、主进程缓存没更新"的不一致。
 *
 *  @param {string} key SPECS 里的键
 *  @returns {number|boolean} 已夹到合法区间的值；键不存在时返回 undefined
 */
function prefsGet(key) {
  const spec = prefsSpec.SPECS[key];
  if (!spec) return undefined;
  const all = storeGet('settings.prefs', null);
  const raw = (all && typeof all === 'object' && all[key] !== undefined) ? all[key] : spec.def;
  return prefsSpec.normalize(key, raw);
}

/* ---------------- helpers ---------------- */
/* ============ IPC 域的显式上下文（任务 5 第 1 步）============
 * main.js 是单文件 + 全闭包，任何一段 handler 想搬出去，都得先查清它隐式
 * 依赖了什么 —— 而那种依赖漏一处，`node --check` 完全看不见（语法合法，
 * 运行时才 ReferenceError）。所以这一步不改逻辑，只把依赖收敛成一个显式对象。
 *
 * 访问器**故意都是 getter 语义**：win 会重建、jobSeq 会递增、jobs 表会增删。
 * 做成快照对象的话，搬出去的代码拿到的就是构造那一刻的值 ——
 * 表现是「第一次能用、换窗口就不对」，非常难查。
 *
 * nextJobSeq 与本文件的 ++jobSeq 是**同一份计数**：任务 id 一旦分裂成两套编号，
 * job:stream 的 id 就可能撞车，渲染层按前缀认领（JobPrefix）会认错任务。
 *
 * 【必须在 send 之前声明】send 会调用 ipcCtx.send；const 有暂时性死区，
 * 声明在后的话 send 在首次调用时会 ReferenceError（而 node --check 看不出来）。
 */
/* ============ 多窗口：事件按「发起它的那个窗口」路由 ============
 *
 * 【为什么必须做这件事】
 * 在「标签可以拖出来变独立窗口」之前，全进程只有一个 win，所有推送都发它，
 * 从不出错。有了第二个窗口之后，同一个 IPC 通道会被两个窗口分别调用：
 *   · 主窗打开「视频压制」并开始压制；
 *   · 独立窗打开「磁盘分析」并开始扫描。
 * 两边的 job:stream 都走同一个 send()，于是**两边的进度条互相串**：
 * 主窗的压制进度被扫描进度顶掉，反之亦然。而渲染层按 job id 前缀认领
 * （JobPrefix.subscribe），认领不上的就静默丢弃 —— 表现是"进度条不动"或"跳变"，
 * 很难归因。
 *
 * 【做法】改 send() 的语义，而不是改 50 处调用点：
 *   · ipcMain.handle 的包装层用 AsyncLocalStorage 把**发起调用的 webContents**
 *     记进上下文；
 *   · 该 handler 同步或异步派生的一切（await、spawn 的 data 回调、setTimeout）
 *     都携带这个上下文 —— 已用探针验证 ALS 能穿过 spawn 回调，这是前提；
 *   · send(ev, data) 优先发给上下文里的那个 webContents，
 *     没有上下文（定时任务、托盘、启动期）才退回主窗口/广播。
 *
 * 【为什么用 ALS 而不是给每个 send 加参数】
 * 50 处 send('job:stream', …) 分散在 main.js 与 4 个 ipc 模块里，逐个加参数
 * 要穿透十几层调用（handler → runFfmpeg → 进度回调），改漏一处就是那个工具的
 * 进度串到别的窗口去。ALS 让"谁发起的"自动流动，调用点一个都不用改。 */
const als = new (require('async_hooks').AsyncLocalStorage)();

/* 当前 handler 调用来自哪个 webContents。没有上下文时返回 null。 */
function currentSender() {
  const st = als.getStore();
  return (st && st.sender) || null;
}

const ipcCtx = require('./ipc/ctx').createIpcCtx({
  getWin: () => win,
  getJobs: () => jobs,
  nextJobSeq: () => ++jobSeq,
  getIsWin: () => isWin,
  getIsMac: () => isMac,
});

/* 向「发起这次操作的窗口」推送事件；没有上下文时退回主窗口。
 *
 * 路由优先级：
 *   1) ALS 上下文里的 webContents —— 即本次 IPC 调用来自哪个窗口
 *   2) 主窗口 win —— 定时任务、托盘、启动期这些没有调用者的事件
 *   3) 全都没有：静默丢弃（窗口可能还没建好或已销毁）
 *
 * 【第 1 条是这次改动的全部意义】见上方"多窗口：事件按发起它的那个窗口路由"。
 * 没有它，两个窗口的后台任务进度会互相覆盖 —— 而渲染层按 job id 前缀认领，
 * 认领不上的静默丢弃，表现成"进度条不动"，完全无法归因。
 *
 * 【为什么不广播给所有窗口】广播会让"主窗正在压制、独立窗正在扫描"时，
 * 两边都收到对方的事件。渲染层的 JobPrefix 只认自己认领的那个 id，
 * 多余的事件虽然会被丢弃，但每次都要过一遍 IPC 广播 + 监听器分发；
 * 而且广播会把"哪个窗口该响应"变成渲染层的责任，主进程反而失去控制。
 * 定向发送更准，也更省。
 *
 * 【第三档：调用者已销毁 —— 丢弃，不回退】
 * 「回退主窗口」本是给**没有调用者**的场景准备的兜底（托盘 / 定时 / 启动期）。
 * 用它去处理"调用者已经死了"，结果只会是串扰：独立窗里跑着 ffmpeg，
 * 用户关掉那个窗口，之后每条 job:stream 都甩到主窗；主窗若开着同一个工具页，
 * JobPrefix.subscribe 的「首次匹配即认领」会把它当成自己的任务 ——
 * 进度条乱跳、结束弹「完成」，而用户手里连 jobId 都没有了，无从取消。
 * 判据在 lib/ipc-route.js 里（纯函数，可脱离 Electron 单测）。 */
function send(ev, data) {
  const target = currentSender();
  switch (pickSendTarget(target)) {
    case 'sender':
      try { target.send(ev, data); return; } catch (e) { /* 落到下面的兜底 */ }
      break;
    case 'drop':
      /* 不静默：排查「进度条不动」时，最想知道的就是"事件到底有没有发出去"。
       * 一行 warn 就能把这条路径与「任务根本没启动」区分开。 */
      console.warn('[ipc] 丢弃推送 ' + ev + '：发起它的窗口已关闭（不回退主窗口，避免串到别人的任务）');
      return;
    default:
      break;
  }
  ipcCtx.send(ev, data);
}

/* 把「全局界面偏好」推给所有窗口：主窗 + 独立工具窗 + 辅助窗口。
 *
 * 【为什么需要广播】语言 / 配色 / 深浅是全应用偏好，但状态所有权在渲染层：
 * i18n.setLang 只作用当前窗口，data-accent / data-theme 写的是当前
 * document 的 documentElement。所以主窗切了英文、换了主色、改了明暗之后，
 * 已经打开的独立工具窗口（以及标尺/贴图/截图标注这些辅助窗口）
 * 会一直停在旧值 —— 三个不同实例，同一个共因。
 *
 * 【theme 为什么传最终结果而不是原始 mode】'system' 要按 nativeTheme 解析，
 * 而各个窗口自己 matchMedia 得到的答案可能因为时机不同而不一致。
 * 主进程这边解析一次，广播的就是确定的 dark / light。
 *
 * ev：{ lang, accent, theme, prefs } —— theme 是 'dark' | 'light'。
 *
 * 【为什么把 prefs 也带上】
 * Prefs 的内存缓存（js/app.js 的 Prefs._v）是**每个渲染进程各一份**。
 * 主窗口改了「图片压缩默认质量」之后，已经开着的独立工具窗口仍然用旧值 ——
 * 用户会认为设置没生效。更糟的是：如果独立窗口也调 Prefs.set，
 * 它会用自己那份陈旧的 _v **整对象**覆盖 store，静默回滚主窗口刚改的值。
 * 带上 prefs 之后，各窗口收到广播就重跑 Prefs.load()，缓存保持一致。
 * （Prefs.set 也同步改成了只写单个键，见 js/app.js —— 双保险。） */
function broadcastUiPrefs() {
  const payload = {
    lang: uiLang,
    accent: currentAccent,
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    /* 取 store 里的实际值，而不是另存一份内存副本 ——
     * 那份副本会因为「谁最后写的」而漂移。 */
    prefs: storeGet('settings.prefs', null),
  };
  const targets = [win, ...toolWindows, ...auxWindows()];
  for (const w of targets) {
    if (!w || w.isDestroyed()) continue;
    try { w.webContents.send(CH.APP.UI_PREFS_CHANGED, payload); } catch (e) { /* 窗口刚销毁，忽略 */ }
  }
}

function fmtErr(e) { return (e && e.message) || String(e); }
const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
  if (!windowSecurity.isTrustedSender(e, __dirname)) {
    return { ok: false, code: 'UNTRUSTED_SENDER', error: '拒绝非应用页面调用桌面功能', advice: '请从应用窗口使用该功能' };
  }
  // 高危能力门禁：未在设置里开启的能力，其 IPC 一律拒绝。
  // 放在统一包装里而不是逐个 handler 里，避免以后新增 handler 时忘了加。
  // sys:power / svc:action 由各自 handler 按 action 精细判定（锁屏、启动服务无害）。
  const cap = CAP_GATED_CHANNELS[ch];
  if (cap && !dangerousEnabled(cap)) {
    /* 【门禁拒绝也要带 code / advice，形状与正常错误分支一致】
     * 下面 catch 分支返回的是 { ok:false, error, code, advice }，
     * 而这里原来只有 error —— 于是 js/api.js 里
     *   if (r && r.code) err.code = r.code;
     *   if (r && r.advice) err.advice = r.advice;
     * 两行全部落空，调用方拿到的 e.code 恒为 undefined，
     * 「按码分支」的逻辑（例如引导用户去设置页开启）根本走不到。
     * 拒绝理由本来就知道（就是没开这个能力），没道理不告诉前端。 */
    return {
      ok: false,
      error: dangerousDenied(cap),
      code: 'CAP_DENIED',
      advice: dangerousDeniedAdvice(cap)
    };
  }
  /* 【把「谁调用的」记进 ALS，供 send() 定向推送】
   * als.run 的作用域必须**包住整个 fn 的执行**，包括它 await 出去的一切、
   * spawn 的子进程 data 回调、以及 setTimeout —— 那些正是发 job:stream 的地方。
   * 已用探针验证 ALS 能穿过 spawn 回调（这是整套路由的前提）。
   *
   * e.sender 指向发起调用的 webContents。它在 handler 返回后可能已被销毁
   * （用户关掉了那个窗口），所以 send() 里每次都要判 isDestroyed，不能缓存。 */
  return als.run({ sender: e && e.sender }, async () => {
    try { return { ok: true, data: await fn(e, ...args) }; }
    catch (err) {
      /* 结构化错误：除了原来给渲染端用的 error 字符串，再附带稳定错误码与建议操作。
         渲染端 window.api.invoke 仍然 throw new Error(error)，旧代码零改动；
         需要更细信息的地方可以读 err.code / err.advice。 */
      const payload = errorInfo.toPayload(err);
      return { ok: false, error: payload.message, code: payload.code, advice: payload.advice };
    }
  });
});
/* 执行外部命令的通用入口。
 *
 * 【退出码语义：默认「非零不抛」，需要抛时必须显式 opts.throwOnNonZero】
 * execFile 的回调里 `err` 同时表示「进程起不来」和「退出码非零」。默认路径
 * 只在 `err && !stdout` 时 reject —— 也就是**有输出的非零退出码会被静默当成成功**，
 * 调用方拿到的是 `{code: 1, stdout:'...'}`，必须自己检查 code。
 *
 * 这个设计有它的理由（很多命令用非零码表达「没查到」，比如 reg query 查一个
 * 不存在的键、tasklist 过滤无结果），全项目几十处调用都依赖它，不能一刀切改成抛。
 * 但它同时也是好几个真实缺陷的根因，因为写调用方的人很容易默认「没抛就是成功」：
 *   · office:status 里 `...; catch{exit 1}` 完全不起作用 → 恒返回 office:true
 *   · ffmpeg:pick 把任意能响应 -version 的 exe 当成 ffmpeg
 * 所以新增 throwOnNonZero：需要「失败必须抛」的地方显式打开，
 * 不用逐个去猜调用点。
 */
/* 【火后不理的子进程必须挂 error 监听并 unref】
 * 项目里有十余处 `spawn('taskkill', …)` / `spawn('shutdown', …)`，
 * 都是「发出去就不管了」的辅助动作。但 Node 的 ChildProcess 在 spawn 失败时
 * （ENOENT / EACCES / 系统找不到可执行文件）会 emit 'error'；
 * 没有监听器时，这个 error 会升级成主进程的 uncaughtException ——
 * 结果是：一条取消动作没生效，却写进 crash-log、还把下次启动标记成
 * 「上次异常退出」，让用户以为程序崩过。
 * 统一收口到这个助手：挂一个空 error 监听（失败就当没做成，不上升为崩溃），
 * 再 unref 让子进程不拖住主进程退出。返回值仍是 ChildProcess，调用方
 * 若需要 pid 之类可以继续用。 */
/* 【实现搬到 lib/spawn-detached.js】
 * ipc/media-ffmpeg.js 的录制/转码域里有同样形态的 6 处 taskkill，
 * 而那个模块拿不到 main.js 里的局部函数 —— 只在这里修，媒体域照旧裸 spawn，
 * 就成了「修了一半」：测试断言 main.js 已经没有裸 spawn，看起来问题已解决。
 * 搬到 lib/ 之后两边 require 同一份，断言也能按整棵主进程树来写。
 * 这里保留同名绑定，避免动几十处调用点（行为不变）。 */
const { spawnDetached } = require('./lib/spawn-detached');

function runCmd(cmd, args, opts = {}) {
  const enc = opts.encoding || 'utf8';
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 30000, maxBuffer: 32 * 1024 * 1024, cwd: opts.cwd, encoding: enc === 'gbk' ? 'buffer' : enc }, (err, stdout, stderr) => {
      if (enc === 'gbk') {
        const dec = new TextDecoder('gbk');
        stdout = dec.decode(stdout || Buffer.alloc(0));
        stderr = dec.decode(stderr || Buffer.alloc(0));
      }
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      if (opts.throwOnNonZero && err) { reject(sanitizeCmdError(err, args)); return; }
      if (err && !stdout) reject(sanitizeCmdError(err, args));
      else resolve({ stdout: stdout || '', stderr: stderr || '', code });
    });
  });
}
/* 命令行脱敏：execFile 的 err.message 是**完整命令行**。
 * 7z 只支持 -p<密码> 一种传参方式，密码必然会出现在 argv 里，
 * 也就必然出现在 err.message 中。这个 message 会经 handle() 原样返回渲染层，
 * 渲染层再 toast 出来 —— 等于把密码弹在屏幕上。
 * 这里统一把 -p<非空白> 与 password= / token= 之类抹成 ***。 */
function sanitizeCmdError(err, args) {
  const msg = String((err && err.message) || err || '');
  /* 脱敏规则收成一个函数：message 与 stack 都要过一遍。
   * 【为什么 stack 也必须过】execFile 的 err.stack 第一行就是 err.message
   * （实测：`Error: Command failed: ... -pmy secret pass`）。原实现只清理了
   * message，然后把**未清理的** err.stack 原样赋给新错误 ——
   * lib/errors.js 的 toPayload 会把 err.stack 塞进 detail 字段（注释写的是
   * 「可展开技术详情用于排查」）。今天 detail 还没回传到界面，但这是一颗
   * 埋着的雷：谁把 detail 接出去，密码就跟着出去了。既然清理只要一行，就别留。 */
  const mask = (text) => {
    let s = String(text == null ? '' : text);
    /* 【顺序是硬的：先按 args 原文精确替换，再跑正则】
     * 反过来的话，`\s-p\S+` 会先把 `-pmy secret pass` 啃成 `-p*** secret pass`，
     * 之后 `s.includes('-pmy secret pass')` 永远为假 —— 补丁看着写了、实际无效。
     * 实测踩过这个坑（改完仍泄漏后半个密码）。 */
    for (const a of (args || [])) {
      const v = String(a);
      if (v.length <= 2) continue;
      if (/^-p./i.test(v)) {
        if (s.includes(v)) s = s.split(v).join('-p***');
        continue;
      }
      const mPwd = /^(--pass(?:word)?=)(.+)$/i.exec(v);
      if (mPwd && mPwd[2] && s.includes(v)) s = s.split(v).join(mPwd[1] + '***');
    }
    s = s
      .replace(/\s-p\S+/g, ' -p***')                       // 7z 密码
      .replace(/\s--password[=\s]\S+/gi, ' --password=***')
      .replace(/(password|passwd|token|secret|apikey|api_key)\s*[=:]\s*\S+/gi, '$1=***');
    // 参数里若有长字符串（>=6 位）也抹掉，防止未命中上面模式的传递方式
    for (const a of (args || [])) {
      const v = String(a);
      if (v.length >= 6 && /^[A-Za-z0-9!@#$%^&*()_+\-=\[\]{};:'",.<>\/?\\|`~]{6,}$/.test(v) && s.includes(v)) {
        s = s.split(v).join('***');
      }
    }
    return s;
  };
  const clean = mask(msg);
  const e = new Error(clean);
  e.code = (err && err.code) || 'CMD_FAILED';
  if (err && err.stack) e.stack = mask(err.stack);
  return e;
}
// Windows PowerShell 输出默认是 OEM 代码页（GBK），强制其以 UTF-8 输出，避免中文乱码
function ps(script, timeout = 30000, cwd) {
  return runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + script], { timeout, encoding: 'utf8', cwd });
}

// 异步存在性判断：批量文件操作里替代 fs.existsSync，避免阻塞主进程
async function pathExists(p) {
  try { await fsp.access(p); return true; } catch (e) { return false; }
}

/* 生成不覆盖的目标路径：已存在则自动加序号。
 * 借鉴 YourCatFileAssistant「已存在的文件不覆盖，按序号生成新名称」的做法，
 * 供目标体积压缩与归档解压共用。
 * relName 来自压缩包条目等外部输入，必须挡住路径穿越（..）和绝对路径。 */
async function uniqueTarget(root, relName) {
  const base = pathGuard.resolveInside(root, relName);
  if (!(await pathExists(base))) return base;
  const dir = path.dirname(base);
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  for (let i = 1; i < 10000; i++) {
    const cand = path.join(dir, `${stem}(${i})${ext}`);
    if (!(await pathExists(cand))) return cand;
  }
  throw new Error('无法生成不重名的目标路径：' + relName);
}

/* 把文件「搬」到目标路径，跨卷时自动退回「复制 + 删除源」。
 *
 * 【为什么需要它】Windows 上 fsp.rename 跨卷直接抛 EXDEV（跨设备链接不允许）。
 * 本应用大量流程是「在 %TEMP% 里生成成品 → 提交到用户选的输出目录」，
 * 而输出目录经常在 D:/E:（系统盘之外正是「处理大文件」最需要的地方）。
 * 用裸 rename 的话，这类流程在最后一步、成果已经生成完的时候才失败 ——
 * 既白等了整轮处理，失败路径还常常顺手把临时目录删掉，连成果一起没了。
 *
 * 只在 EXDEV 时复制；其它错误（权限、占用、目标已存在）照旧抛，
 * 不掩盖真正的原因。复制成功后才删源，避免「源删了、目标没写成」。
 *
 * @param {string} src 现有文件
 * @param {string} dst 目标路径（调用方负责保证不覆盖）
 */
async function moveFile(src, dst) {
  try {
    await fsp.rename(src, dst);
    return { moved: true, copied: false };
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      const st = await fsp.stat(src);
      await fsp.copyFile(src, dst);
      const dstSt = await fsp.stat(dst).catch(() => null);
      if (!dstSt || dstSt.size !== st.size) {
        // 复制不完整：删掉半成品，源保持不动，让调用方看到真实失败
        await fsp.rm(dst, { force: true }).catch(() => {});
        throw new Error('跨盘搬运失败：复制后大小不符（源 ' + st.size + ' / 目标 ' + (dstSt ? dstSt.size : 0) + '）');
      }
      await fsp.rm(src, { force: true }).catch(() => {});
      return { moved: true, copied: true };
    }
    throw err;
  }
}

/* 本应用在系统临时目录里创建的临时产物（统一 hehe- 前缀）。
   自动清理只允许碰这些文件，绝不能整目录清空——%TEMP% 是全机器共享的，
   里面还有别的程序正在使用的文件，整目录删除会导致它们崩溃或丢数据。

   【白名单已经搬到 lib/temp-names.js —— 不要再往这里加正则】
   原来的问题是：生成临时名的字符串散落在十几处，白名单却靠这里的**手写正则**
   描述 —— 两份独立事实，只能靠人肉同步。真实事故：.hehe-7zx-* 带前导点，
   白名单写成 ^hehe-7zx-（不带点），于是那个暂存目录永远匹配不上，
   7z 解压崩溃后永久残留、而「清理临时文件」扫不到它。
   现在生成函数与白名单在同一个模块里，scripts/test-temp-names.js 会逐个验证
   「每个生成函数产出的名字都能被白名单命中」—— 新增产物忘登记时测试立刻红。 */
function isOwnTempName(name) { return tempNames.isOwnTempName(name); }

/* 批量 PowerShell 查询的分块大小（公共常量，放在文件靠前处）。
 *
 * 【为什么必须分块】把几百个路径拼成一个数组字面量一次传进去会撞上
 * Windows 命令行上限（约 32767 字符），Node 直接抛 spawn ENAMETOOLONG，
 * PowerShell 根本没启动。实测：单路径 91 字符时，500 个就超限。
 * 每块 60 个路径：即便单个路径 200 字符也只占 1.2 万字符，留足余量。
 *
 * 使用者：link:scan（取 LinkType）、linkNatures（判链接性质）、
 * rmQueryLockers（Restart Manager 查占用 —— 这条曾经漏了分块，
 * 200 个深路径直接 ENAMETOOLONG，占用查询整个失效）。 */
const PS_PATH_BATCH = 60;


/* ---------------- 高危功能开关 ----------------
   高危 = 可能造成数据丢失或系统级不可逆影响（删文件、清空回收站、杀进程、
   改 hosts、重启系统…）。这类能力默认关闭，必须先在「设置 → 高危功能」里
   显式开启才能使用。
   门禁放在主进程而不是渲染层：渲染层的 if 只是界面约束，任何一次误改或
   绕过都可能让删文件的 IPC 直接生效。主进程这里是最后一道闸。 */
/* 【高危能力的名称与描述是双语的，且必须留在主进程】
 * 这些名字会出现在三个地方：
 *   1) 设置页的能力清单（渲染层直接显示 dangerous:list 的结果）
 *   2) 门禁拒绝时的错误文案（dangerousDenied 在主进程生成）
 *   3) 部分锁工具顶部的提示卡（渲染层复述「哪一项被锁」）
 * 早期只有中文，托盘修了、这里没跟上：英文界面下「设置 → 高危功能」
 * 整页中英混排（分区标题是英文，每一项能力名却是中文）。
 * 语言用渲染层通过 app:set-lang 传过来的 uiLang，与托盘同一份。 */
const CAP_TEXT = {
  zh: {
    'file-delete': ['删除文件', '删除重复文件、空目录、笔记、剪贴板图片等（不进回收站）'],
    'junk-clean': ['垃圾清理', '清理系统临时文件、浏览器缓存、缩略图缓存'],
    'recycle-empty': ['清空回收站', '永久清空系统回收站，不可恢复'],
    'process-kill': ['结束进程', '强制结束任意进程，未保存数据会丢失'],
    'service-stop': ['停止系统服务', '停止正在运行的 Windows 服务，依赖它的程序可能异常退出'],
    'system-power': ['关机 / 重启 / 休眠', '执行关机、重启、休眠等系统电源操作（锁屏与睡眠不受限制）'],
    'hosts-edit': ['编辑 Hosts', '写入系统 hosts 文件并刷新 DNS，影响全机解析'],
    'registry-edit': ['注册表与右键菜单', '删除开机自启项、切换 Win11 经典右键菜单'],
    /* 目录搬家最坏的结果是「源目录删了、链接是坏的、数据在别处」——
     * 用户会以为文件丢了。中间态（已改名但链接没建成）尤其危险，
     * 所以它必须是独立的高危能力，不能借用 file-delete。 */
    'dir-move': ['目录搬家（建链接替身）', '把目录搬到别处并在原位置建目录联接；失败时可能留下坏链接'],
    'acl-repair': ['取得所有权 / 修复权限', '改文件所有者并授予完全控制；会放宽该路径（及其子项）的访问权限'],
  },
  en: {
    'file-delete': ['Delete files', 'Delete duplicate files, empty folders, notes, clipboard images, etc. (bypassing the Recycle Bin)'],
    'junk-clean': ['Junk cleanup', 'Clean temp files, browser caches and thumbnail caches'],
    'recycle-empty': ['Empty Recycle Bin', 'Permanently empty the Recycle Bin; this cannot be undone'],
    'process-kill': ['Kill processes', 'Force-kill any process; unsaved work is lost'],
    'service-stop': ['Stop services', 'Stop running Windows services; programs that depend on them may fail'],
    'system-power': ['Shutdown / restart / hibernate', 'Shut down, restart or hibernate the system (lock and sleep are not restricted)'],
    'hosts-edit': ['Edit hosts', 'Write the system hosts file and flush DNS; affects name resolution machine-wide'],
    'registry-edit': ['Registry and context menu', 'Remove startup entries, switch to the Windows 11 classic context menu'],
    'dir-move': ['Folder move (with link)', 'Move a folder elsewhere and leave a directory junction behind; a failed run may leave a broken link'],
    'acl-repair': ['Take ownership / repair permissions', 'Change the owner and grant full control; widens access for that path and everything under it'],
  },
};
/* 清单顺序即设置页展示顺序（显式列出，不靠对象键顺序）。 */
const DANGEROUS_CAP_IDS = [
  'file-delete', 'junk-clean', 'recycle-empty', 'process-kill', 'service-stop',
  'system-power', 'hosts-edit', 'registry-edit', 'dir-move', 'acl-repair',
];
function capText(id) {
  const pack = CAP_TEXT[uiLang] || CAP_TEXT.zh;
  const pair = pack[id] || CAP_TEXT.zh[id] || [id, ''];
  return { name: pair[0], desc: pair[1] };
}
/* 用取值器而不是快照：语言切换后同一处代码（dangerousDenied / dangerous:list）
 * 立刻给出新语言的文案，不需要重建这个对象。 */
const DANGEROUS_CAPS = {};
for (const id of DANGEROUS_CAP_IDS) {
  Object.defineProperty(DANGEROUS_CAPS, id, { get() { return capText(id); }, enumerable: true });
}
// 默认全部关闭；用户在设置里开启的存到 settings.dangerousCaps（数组）
function dangerousEnabled(cap) {
  const list = storeGet('settings.dangerousCaps', []);
  return Array.isArray(list) && list.indexOf(cap) !== -1;
}
// 需要高危权限的 IPC 通道 → 所属能力
const CAP_GATED_CHANNELS = {
  'fs:delete': 'file-delete',
  'fs:delete-empty': 'file-delete',
  /* 【fs:rename 为什么也归到 file-delete】
   * 它是一个「移动文件到任意位置」的原语：可以把自己的文件搬进 Startup 实现自启，
   * 也可以在 overwrite=true 时覆盖目标同名文件（等于删掉了目标那份）。
   * 语义上它就是「删除 + 新建」的组合，而同一批写盘通道
   * （fs:write-text / fs:write-file-b64 / fs:merge-parts / zip:compress）
   * 都走 checkOverwritable 闸门，唯独它既没闸门、也不在门禁表里 ——
   * 等于一个不受任何高位约束的任意外写入口。
   * 现在两者都补上：目标路径过 checkOverwritable，通道归 file-delete 门禁。 */
  'fs:rename': 'file-delete',
  'clip:remove-images': 'file-delete',
  /* 曾经还有一条 'clip:gc-images': 'file-delete'。
   * 那个通道已经删了（孤图清扫改成启动时走 sweepClipImages()），
   * 但门禁表里留了这一行 —— 门禁是「通道名 → 能力」的映射表，
   * 条目指向一个不存在的通道时不会报错，只会永远不被查到。
   * 它不会造成安全漏洞，但会让「表里有多少条、对应多少通道」这种
   * 对账永远差一条，也让后来者以为还有这么个入口可用。
   * 现在由 test-ipc-channels 强制对账（表里每条都必须真注册过），删掉才绿。 */
  'fs:clean-junk': 'junk-clean',
  'sys:recycle-empty': 'recycle-empty',
  'proc:kill': 'process-kill',
  'file:unlock': 'process-kill',
  'svc:action': 'service-stop',
  'hosts:write': 'hosts-edit',
  'hosts:restore': 'hosts-edit',
  'autostart:delete': 'registry-edit',
  'autostart:enable': 'registry-edit',
  'ctxmenu:classic': 'registry-edit',
  // 逐条禁用/启用右键菜单项改的是同一类 HKCR 键，与「Win11 经典菜单」等价，
  // 之前漏在门禁外：没开开关的用户也能直接调它写注册表。
  'ctxmenu:toggle': 'registry-edit',
  /* 清理僵尸链接 = 删除文件系统条目，按删除门禁管 */
  'link:remove': 'file-delete',
  /* 目录搬家会复制/改名/建链接/删备份，最坏情况是「数据在别处、链接是坏的」，
   * 单独一个能力，不能借用 file-delete */
  'dir:move': 'dir-move',
  /* 【权限修复必须走门禁】
   * 早期 DANGEROUS_CAPS 里声明了 acl-repair，但没有任何通道映射到它，
   * TOOL_DANGEROUS_CAPS 里也没有这个工具 —— 结果是设置页的开关拨了不生效、
   * 工具卡片不标红、只要以管理员运行就能直接调 acl:repair。
   * 而「改所有者 + 递归放宽整棵子树的权限」是这批功能里影响面最大的一个
   * （对目录递归就是一次性放开其下所有条目），所以它不能只靠「用户看得见」。 */
  'acl:repair': 'acl-repair'
};
// sys:power 通道里既有危险动作（关机/重启/休眠）也有无害动作（锁屏/睡眠），
// 睡眠只是把内存转成待机状态、不会丢数据，所以不纳入高危门禁。
const DANGEROUS_POWER_ACTIONS = ['hibernate', 'restart', 'shutdown'];
/* 门禁拒绝文案也要双语：它会直接弹在界面上（toast / 错误提示）。
 * 只翻能力名是不够的 —— 整句「…属于高危功能，已默认关闭…」同样是中文。 */
const GATE_TEXT = {
  zh: (name) => `「${name}」属于高危功能，已默认关闭。请到「设置 → 高危功能」中开启后再使用。`,
  en: (name) => `"${name}" is a high-risk feature and is currently off. Enable it under Settings → High-risk features first.`,
};
function dangerousDenied(cap) {
  const pack = GATE_TEXT[uiLang] || GATE_TEXT.zh;
  return pack(DANGEROUS_CAPS[cap].name);
}
/* 门禁拒绝时的「下一步该做什么」。
 * 与 dangerousDenied 分开成两个函数，是因为它们回答的是不同问题：
 *   前者说「为什么被拦」，后者说「怎么才能用」。
 * js/api.js 会把 advice 拼在错误文本后面（errText 里 `msg + '\n建议：' + advice`），
 * 所以这里给一句可直接照做的操作路径，不要重复上面那句。 */
const GATE_ADVICE = {
  zh: (name) => `打开「设置 → 高危功能」，找到「${name}」并打开开关，然后重试。`,
  en: (name) => `Open Settings → High-risk features, turn on "${name}", then try again.`,
};
function dangerousDeniedAdvice(cap) {
  const pack = GATE_ADVICE[uiLang] || GATE_ADVICE.zh;
  return pack(DANGEROUS_CAPS[cap].name);
}
handle(CH.DANGEROUS.LIST, () => ({
  caps: DANGEROUS_CAP_IDS.map(id => ({
    id, name: DANGEROUS_CAPS[id].name, desc: DANGEROUS_CAPS[id].desc, enabled: dangerousEnabled(id)
  })),
  enabled: DANGEROUS_CAP_IDS.filter(dangerousEnabled)
}));
handle(CH.DANGEROUS.SET, (e, cap, on) => {
  if (!DANGEROUS_CAP_IDS.includes(cap)) throw new Error('未知的高危功能项');
  const list = new Set(Array.isArray(storeGet('settings.dangerousCaps', [])) ? storeGet('settings.dangerousCaps', []) : []);
  if (on) list.add(cap); else list.delete(cap);
  storeSet('settings.dangerousCaps', [...list]);
  return { id: cap, enabled: on };
});
// 工具 id → 涉及的高危能力。渲染层据此把工具卡片标红。
// 显式列出而不是从通道名反推：通道前缀（fs:、sys:…）跟工具 id 对不上，
// 反推会把「文件处理」整个模块都标红，失去区分意义。
const TOOL_DANGEROUS_CAPS = {
  'junk-clean': ['junk-clean'],
  'empty-dir-clean': ['file-delete'],
  /* 【批量重命名 / 批量改后缀 也依赖 file-delete】
   * fs:rename 归到 file-delete 门禁之后（见 CAP_GATED_CHANNELS 的说明），
   * 这两个工具就成了"必须开启该能力才能用"的功能。若不在这里登记，
   * 设置页的开关拨了不生效、工具卡片也不标红 —— 用户看到的是
   * 「功能点了没反应」，而不是「需要先开启高危能力」。 */
  'batch-rename': ['file-delete'],
  'batch-ext': ['file-delete'],
  'dedupe': ['file-delete'],
  'local-notes': ['file-delete'],
  'clipboard-history': ['file-delete'],
  'process-manager': ['process-kill'],
  'file-unlock': ['process-kill'],
  'port-occupy': ['process-kill'],
  'services-power': ['service-stop'],
  'quick-ops': ['system-power', 'recycle-empty'],
  'hosts-edit': ['hosts-edit'],
  'autostart': ['registry-edit'],
  'win-classic-menu': ['registry-edit'],
  'dir-move': ['dir-move'],
  'link-doctor': ['file-delete'],
  /* 诊断（acl:diagnose）是只读的，不进这张表；只有真正改权限的 acl:repair 计入 */
  'acl-repair': ['acl-repair']
};
handle(CH.DANGEROUS.TOOL_CAPS, () => {
  const out = {};
  for (const [tool, caps] of Object.entries(TOOL_DANGEROUS_CAPS)) {
    out[tool] = { caps, enabled: caps.some(c => dangerousEnabled(c)) };
  }
  return out;
});

/* ---------------- window ---------------- */
// 系统主题变化时广播到渲染端（跟随系统模式下同步深浅色）
nativeTheme.on('updated', () => {
  send('settings.theme-changed', nativeTheme.shouldUseDarkColors);
});
/* ---------------- 启动进度窗 ---------------- */
// 两条启动路径的耗时结构完全不同，所以启动窗只对慢的那条启用：
//
// 【便携版单 exe】双击 → NSIS 解压整个 Electron（实测 6~16s）→ 启动应用（~0.85s）→ 主窗
//   解压阶段由打包时的 NSIS splashImage（assets/splash.bmp）显示；
//   但它只覆盖到解压完成，portable.nsi 在 ExecWait 前就 BgImage::Destroy 了，
//   之后到主窗出现还有 ~0.85s 什么都没画。本启动窗接管这一段，让全程都有反馈。
//
// 【zip 免安装目录版】双击 → 启动应用（~0.64s）→ 主窗
//   快到弹启动窗只会「闪一下」，反而更难看，所以不弹。
//
// 判别依据：PORTABLE_EXECUTABLE_FILE 由 portable.nsi 在 ExecWait 前注入环境变量，
// 只有单文件便携版才有。zip 解压出来的 exe 没有这个变量。
//
// 环境变量：HEHE_SPLASH=1 强制显示（调试用）；HEHE_NOSPLASH=1 关闭；自检（SMOKE/SHOT）一律关闭。
let splashWin = null;
let splashVisible = false; // 启动窗是否真的显示过（没显示过就不需要等淡出）
let mainShown = false;
let splashStage = { pct: 8, label: '正在启动…' }; // 记住最新阶段：启动窗还没加载完时消息会丢，就绪后补发

function splashEnabled() {
  if (process.env.HEHE_NOSPLASH || process.env.HEHE_SMOKE || process.env.HEHE_SHOT) return false;
  if (process.env.HEHE_SPLASH) return true;  // 调试：强制显示
  return !!process.env.PORTABLE_EXECUTABLE_FILE; // 只有单文件便携版慢到值得弹
}

function splashSend(ev, data) {
  if (ev === 'splash:step' && data) splashStage = data;
  if (!splashWin || splashWin.isDestroyed()) return;
  try { splashWin.webContents.send(ev, data); } catch (e) {}
}

function destroySplash() {
  if (!splashWin || splashWin.isDestroyed()) { splashWin = null; return; }
  const s = splashWin;
  splashWin = null;
  try { s.destroy(); } catch (e) {}
}

// 启动窗位置：屏幕正中偏上，避免正好压住主窗将来的位置
function centerSplash(self) {
  try {
    const d = screen.getPrimaryDisplay();
    const wa = d.workArea;
    const [w, h] = self.getSize();
    self.setPosition(
      Math.round(wa.x + (wa.width - w) / 2),
      Math.round(wa.y + (wa.height - h) / 2 - Math.round(wa.height * 0.06))
    );
  } catch (e) {}
}

function createSplash() {
  if (!splashEnabled()) return;
  try {
    splashWin = new BrowserWindow({
      width: 396, height: 188,
      frame: false, transparent: true, resizable: false, movable: true,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
      show: false, backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false,
        /* 与主窗口/标尺/贴图/截图窗保持一致：preload 的 isDev 完全依赖这个注入，
         * 漏掉就按开发态处理。splash 目前没用 isDev，但这是隐患 ——
         * 一旦 splash.js 以后要按打包态分支，就会静默走错分支。 */
        additionalArguments: ['--hehe-packaged=' + (app.isPackaged ? '1' : '0')]
      }
    });
    hardenWindow(splashWin);
    const self = splashWin;
    // 便携版：NSIS 在 ExecWait 前已经 BgImage::Destroy 拆掉了自己的解压画面，
    // 之后到主窗出现这一段是「什么都没画」的空档，所以启动窗要立刻显示，越早越好。
    // （zip 版不会走到这里，splashEnabled 已按 PORTABLE_EXECUTABLE_FILE 过滤）
    self.setAlwaysOnTop(true, 'screen-saver');
    centerSplash(self);
    self.on('closed', () => { if (splashWin === self) splashWin = null; });
    // 一有内容就显示（用 ready-to-show 而不是固定延时：延时短了会闪空白窗口，长了又拉大空档）
    self.once('ready-to-show', () => {
      if (mainShown || self.isDestroyed()) return;
      splashVisible = true;
      try { self.showInactive(); } catch (e) { try { self.show(); } catch (e2) {} }
      splashSend('splash:step', splashStage); // 补发启动窗加载期间错过的阶段
    });
    self.loadFile('splash.html', {
      query: {
        accent: storeGet('settings.accent', 'polar') || 'polar',
        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
        v: app.getVersion()
      }
    });
    // 兜底：启动窗自身出问题也不允许拖住主界面。
    // 但只能在真实进度还没超过它时才发，否则会把已经跑到的 70% 阶段
    // 反向改写回 55% —— 渲染端 pct 有 Math.max 保护，label 却是无条件覆盖的。
    setTimeout(() => {
      if (mainShown || splashStage.pct >= 55) return;
      splashSend('splash:step', { pct: 55, label: '加载界面…' });
    }, 300);
    // 兜底：万一主窗 ready-to-show 一直不触发（渲染层崩溃等），启动窗也不能永远盖在最前面
    setTimeout(() => {
      if (mainShown) return;
      mainShown = true;
      try { if (win && !win.isDestroyed()) win.show(); } catch (e) {}
      destroySplash();
    }, 30000);
  } catch (e) {
    console.error('splash failed', e.message);
    splashWin = null;
  }
}

// 主窗显示：先让主窗在启动窗**下面**画好，再让启动窗淡出。
/* 【为什么不能「先淡出、等 260ms、再显示主窗」】
 * 原来这里发 splash:done 之后 setTimeout(reveal, 260)，而 reveal 里才 win.show()。
 * 于是那 260ms 里启动窗正在淡出，主窗却还没显示 —— 用户看到的就是
 * 「弹窗没了，中间空一下，主界面才冒出来」。实测用户明确反馈了这个空档。
 *
 * 正确顺序是反过来的：
 * 1) 先 win.show()：主窗渲染层在 ready-to-show 时就已经画好了，
 *    它在启动窗下面，不会打断淡出观感；
 * 2) 再发 splash:done 让启动窗淡出（启动窗是 alwaysOnTop，仍盖在上面）；
 * 3) 淡出结束销毁启动窗 —— 此时它底下已经是完整的主界面。
 * 这样启动窗消失的那一帧，主界面必然已经就位，不存在空白。
 */
function showWindowAfterSplash() {
  if (mainShown) return;
  mainShown = true;
  if (!win || win.isDestroyed()) { destroySplash(); return; }

  try { win.show(); } catch (e) {}
  bootMark('window-shown');

  // 启动窗根本没显示过（启动太快）→ 没有淡出动画要等，直接销毁
  if (!splashVisible || !splashWin || splashWin.isDestroyed()) { destroySplash(); return; }

  splashSend('splash:done', {});
  // splash.html 的淡出是 0.18s（transition），等它彻底透明再销毁；
  // 主窗此时已经在下面画好，所以这一帧切换是无缝的。
  setTimeout(destroySplash, 200);
}

/* ============================================================
 * 窗口安全加固：每个 BrowserWindow 建好后都必须走一遍
 *
 * 【为什么必须有】Electron 的默认行为里有两件事是"全开"的：
 *   ① 权限请求默认批准（官方文档：可以设置 handler 覆盖"默认全部授予"）
 *   ② window.open() 默认新建一个继承 webPreferences 的 BrowserWindow
 *
 * 本项目的页面只加载本地 file://，但**渲染的是大量用户可控文本**
 * （Markdown 预览、笔记、OCR 结果、diff、日志查看）。任何一处漏掉净化
 * 都可能变成：开出一个不受控的新窗口，或者申请到地理位置/MIDI 这类
 * 与本应用毫无关系的权限。
 *
 * 【为什么不逐个手写】主进程有 5 处以上 new BrowserWindow
 * （主窗、独立工具窗、标尺、贴图、截图、离屏 PDF）。逐处写必然漏一处，
 * 而漏的那处不会有任何提示。收成一个函数，新建窗口时照抄一行。
 * ============================================================ */
function hardenWindow(w) {
  if (!w || w.isDestroyed()) return w;
  try {
    /* ① 一律拒绝新开窗口。需要"点链接开浏览器"的地方走 SHELL.OPEN_URL
     *    （它只允许 http/https，见 ipc/fs-ops.js）。 */
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Only main-process loadFile/loadURL may replace a document. Local file://
    // links are untrusted too; a new document would inherit this window's preload.
    w.webContents.on('will-navigate', ev => ev.preventDefault());
    w.webContents.on('will-frame-navigate', ev => ev.preventDefault());
    /* ③ 权限：白名单放行，其余拒绝。
     *    · media            —— 录屏要麦克风/摄像头，OCR 要枚举设备 label
     *    · notifications    —— 番茄钟、定时提醒
     *    · clipboard-read   —— 剪贴板历史要读系统剪贴板
     *    · clipboard-sanitized-write —— copyText 走的是渲染层 API，
     *      不需要这条；留注释说明为什么没列它，避免以后乱加。
     *    · fullscreen       —— 截图/贴图窗口进入全屏
     *    其余（geolocation / midi / midiSysex / hid / serial / usb /
     *    background-sync / accelerometer 等）一律拒绝并记一条日志。 */
    const ALLOWED = new Set(['media', 'notifications', 'clipboard-read', 'fullscreen']);
    const ses = w.webContents.session;
    /* 【session 是共享的】主窗与各辅助窗用的是同一个 defaultSession，
     * 所以这两个 handler 只需要装一次；重复装会覆盖，行为仍然一致。
     * 用标记位避免每个窗口都重装一遍（重装本身无害，但会让"到底装了几次"
     * 变得说不清）。 */
    if (!ses.__hehePermBound) {
      ses.__hehePermBound = true;
      ses.setPermissionRequestHandler((wc, permission, callback) => {
        const granted = !!wc && windowSecurity.isTrustedPage(wc.getURL(), __dirname) && ALLOWED.has(permission);
        if (!granted) console.warn('[security] 拒绝权限请求：', permission);
        callback(granted);
      });
      /* 【必须有 checkHandler，而且口径要与 requestHandler 一致】
       * 只装 request 不装 check 会出现"请求被拒但检查通过"的矛盾状态
       * （Chromium 有些路径先问 check 再决定要不要发 request）。 */
      ses.setPermissionCheckHandler((wc, permission) => !!wc && windowSecurity.isTrustedPage(wc.getURL(), __dirname) && ALLOWED.has(permission));
    }
  } catch (e) {
    console.warn('[security] 窗口加固失败：', fmtErr(e));
  }
  return w;
}

function createWindow() {
  bootMark('create-window-start');
  mainShown = false; // 窗口可能被销毁后重建（从托盘重新打开），需要重新走一次显示流程
  /* preload 在渲染进程里拿不到 app（typeof app === 'undefined'，
   * 直接读 app.isPackaged 会抛 TypeError 并被兜底成 isDev=true，
   * 于是打包版也当自己是开发态、测试钩子常驻）。
   * 这里由主进程判断好，通过 additionalArguments 注入给 preload 读。 */
  const packagedArg = '--hehe-packaged=' + (app.isPackaged ? '1' : '0');
  win = new BrowserWindow({
    width: 1000, height: 660, minWidth: 860, minHeight: 580,
    frame: false, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#F2F3F5',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: '核核工具箱',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      additionalArguments: [packagedArg],
      spellcheck: false
    }
  });
  hardenWindow(win);
  Menu.setApplicationMenu(null);
  bootMark('window-created');
  win.loadFile('index.html');
  win.webContents.on('console-message', (...args) => {
    let level, message, source, line;
    if (typeof args[1] === 'number') { level = args[1]; message = args[2]; line = args[3]; source = args[4]; }
    else { const ev = args[0]; level = ev.level; message = ev.message; source = ev.sourceId; line = ev.lineNumber; }
    console.log(`[renderer:${level}]`, message, `(${source}:${line})`);
  });
  /* 渲染进程崩溃（OOM / 被杀 / asar 被动过）在主进程这边只有一个事件，
   * 界面上表现为「整片白了」或「窗口没了」。这里必须落盘：
   * 渲染进程自己的 console 随进程一起消失，之前什么都留不下。
   *
   * 崩溃后 Electron 会留下一个"死掉"的 webContents。不去 reload 的话，
   * 用户看到的就是一张永久白屏的窗口 —— 那正是最让人困惑的状态。
   * 所以这里记录后主动 reload 一次（只是恢复界面，不重放导致崩溃的操作）。 */
  win.webContents.on('render-process-gone', (e, details) => {
    const reason = details && details.reason;
    const exitCode = details && details.exitCode;
    recordCrash('render-process-gone', {
      detail: crashLog.describeGone(reason, exitCode),
      err: null
    });
    // 用户主动退出（isQuitting）时不重载，否则会拖住退出流程
    if (isQuitting) return;
    // 'killed' 常常是用户在任务管理器里主动结束子进程，也不该自动复活
    if (reason === 'killed' || reason === 'clean-exit') return;
    try {
      setTimeout(() => {
        try {
          if (win && !win.isDestroyed()) win.webContents.reload();
        } catch (err) {}
      }, 1200);
    } catch (err) {}
  });
  win.once('ready-to-show', () => { bootMark('ready-to-show'); showWindowAfterSplash(); });
  win.webContents.once('dom-ready', () => splashSend('splash:step', { pct: 72, label: '准备界面…' }));
  win.webContents.once('did-finish-load', () => { bootMark('renderer-loaded'); });
  win.on('maximize', () => send('win:maximized', true));
  win.on('unmaximize', () => send('win:maximized', false));
  win.on('close', (e) => {
    if (!isQuitting && storeGet('settings.closeToTray', true) && tray) {
      e.preventDefault(); win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

function showMainWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

/* ---------------- tray ---------------- */
/* 主进程侧没有 i18n 体系（渲染层的 js/i18n.js 只在窗口里跑）。
 * 托盘菜单和系统通知是主进程自己画的，所以这里放一份**极小的**双语表，
 * 只覆盖托盘与通知用到的几条文案。语言由渲染层通过 app:set-lang 传过来，
 * 切换语言时会重新建菜单 —— 否则英文用户看到的中文托盘菜单永远不跟着变。
 * 新增托盘项时请同时补两套文案，不要只写中文。 */
const TRAY_I18N = {
  zh: { tooltip: '核核工具箱', show: '显示主界面', snip: '✂️ 截图标注',
        pin: '📌 贴剪贴板图片', notes: '📝 记事', ocr: '🔍 OCR 剪贴板图片',
        quit: '退出', noClipImg: '剪贴板中没有图片' },
  en: { tooltip: 'HeHe Toolbox', show: 'Show main window', snip: '✂️ Annotate screenshot',
        pin: '📌 Pin clipboard image', notes: '📝 Notes', ocr: '🔍 OCR clipboard image',
        quit: 'Quit', noClipImg: 'No image in clipboard' },
};
let uiLang = 'zh';
function trayText(key) {
  const pack = TRAY_I18N[uiLang] || TRAY_I18N.zh;
  return pack[key] != null ? pack[key] : TRAY_I18N.zh[key];
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'assets', 'icon32.png'));
    tray.setToolTip(trayText('tooltip'));
    const menu = Menu.buildFromTemplate([
      { label: trayText('show'), click: showMainWindow },
      { type: 'separator' },
      { label: trayText('snip'), click: () => { snipStart('annotate').catch(() => {}); } },
      { label: trayText('pin'), click: () => { pinClipboardImage().catch((e2) => { showMainWindow(); send('tray:err', e2.message); }); } },
      { label: trayText('notes'), click: () => { showMainWindow(); send('app:open-tool', 'local-notes'); } },
      { label: trayText('ocr'), click: async () => {
          const img = clipboard.readImage();
          if (img.isEmpty()) { showMainWindow(); send('tray:err', trayText('noClipImg')); return; }
          const file = snipTmp();
          await fsp.writeFile(file, img.toPNG());
          showMainWindow();
          send('snip:ocr', file);
        } },
      { type: 'separator' },
      { label: trayText('quit'), click: () => { isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', showMainWindow);
  } catch (e) { console.error('tray failed', e); tray = null; }
}

/* 渲染层切换界面语言时通知主进程，让托盘菜单跟着换。
 * 只重建托盘菜单，不动别的状态。语言值不认识时保守回中文。
 *
 * 【写完必须广播】托盘只是主进程自己画的那一半；语言真正的消费者是各窗口的
 * 渲染层。不广播的话，主窗切成英文后，已经打开的独立工具窗口仍是中文 ——
 * 而它是用户刚刚从这里拖出去的，两秒之内就看到两种语言。 */
handle(CH.APP.SET_LANG, (e, lang) => {
  const next = lang === 'en' ? 'en' : 'zh';
  if (next === uiLang && tray) return true; // 没变就不用重建
  uiLang = next;
  if (tray) {
    try { tray.destroy(); } catch (err) {}
    tray = null;
    createTray();
  }
  broadcastUiPrefs();
  return true;
});

/* ---------------- global hotkey ---------------- */
let currentHotkey = null;
function applyHotkey(acc) {
  if (!acc) {
    try { if (currentHotkey) globalShortcut.unregister(currentHotkey); } catch (e) {}
    currentHotkey = null;
    return true;
  }
  if (acc === currentHotkey) return true;
  let ok = false;
  try { ok = globalShortcut.register(acc, () => { showMainWindow(); send('hotkey:pressed', acc); }); } catch (e) { ok = false; }
  if (!ok) return false; // 新键注册失败时保留旧热键
  try { if (currentHotkey) globalShortcut.unregister(currentHotkey); } catch (e) {}
  currentHotkey = acc;
  return true;
}

/* 逻辑核心数（缓存 60 秒：核数不会变，但 os.cpus() 每次都要构造整张表） */
let _coreCountCache = null, _coreCountAt = 0;
function cpuCoreCount() {
  if (_coreCountCache && Date.now() - _coreCountAt < 60000) return _coreCountCache;
  try { _coreCountCache = os.cpus().length || 1; } catch (e) { _coreCountCache = _coreCountCache || 1; }
  _coreCountAt = Date.now();
  return _coreCountCache;
}

/* ---------------- cpu sampler ----------------
 * 【只枚举一次】原实现每次采样要跑三遍 os.cpus()：
 * sampleCpu() 里一遍、接着 interval 里又两遍 reduce。
 * os.cpus() 会枚举所有逻辑核心并构造对象数组，在 32 核机器上开销不小，
 * 而且每 1.5 秒一次。
 * 现在一次枚举同时算出「当前总量」与「给下次用的基线」。 */
function readCpuTimes() {
  const cpus = os.cpus();
  let idle = 0, total = 0, cores = cpus.length;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total, cores };
}
setInterval(() => {
  // 窗口不可见（最小化到托盘/隐藏）时不必推送状态，避免无谓唤醒渲染进程
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
  const cur = readCpuTimes();
  let cpu = 0;
  if (lastCpuSample) {
    const idleD = cur.idle - lastCpuSample.idle, totalD = cur.total - lastCpuSample.total;
    cpu = totalD > 0 ? Math.min(100, Math.max(0, (1 - idleD / totalD) * 100)) : 0;
  }
  lastCpuSample = { idle: cur.idle, total: cur.total };
  const totalMem = os.totalmem(), freeMem = os.freemem();
  send('sys:stats', { cpu: Math.round(cpu * 10) / 10, memUsed: totalMem - freeMem, memTotal: totalMem, memPct: Math.round((1 - freeMem / totalMem) * 1000) / 10 });
}, 1500);

/* ================= IPC: app / window / store ================= */
/* 【窗口控制必须作用于「发起调用的那个窗口」】
 * 这三个通道原来直接操作主窗 win。独立工具窗口出现之后，
 * 用户点独立窗上的最小化，被最小化的是**主窗** —— 独立窗纹丝不动，
 * 看起来像按钮坏了；点关闭则关掉主窗，而用户想关的是手上这个。
 *
 * 优先按 ALS 上下文取发起者（BrowserWindow.fromWebContents），
 * 取不到才退回主窗 —— 托盘、快捷键这些没有调用者的路径仍然走主窗。 */
function senderWindow() {
  const wc = currentSender();
  if (wc && !wc.isDestroyed()) {
    try { const w = BrowserWindow.fromWebContents(wc); if (w && !w.isDestroyed()) return w; } catch (e) {}
  }
  return (win && !win.isDestroyed()) ? win : null;
}
handle(CH.WIN.MINIMIZE, () => { const w = senderWindow(); if (w) w.minimize(); });
handle(CH.WIN.MAXIMIZE, () => {
  const w = senderWindow();
  if (!w) return;
  w.isMaximized() ? w.unmaximize() : w.maximize();
});
handle(CH.WIN.CLOSE, () => { const w = senderWindow(); if (w) w.close(); });
/* 截取调用方窗口的内容区，缩成小图给标签拖拽做跟手预览。
 *
 * 【为什么需要它】浏览器拖标签时会跟着一个页面缩略图，用户立刻明白
 * "我正在搬运这个东西"。只让标签变半透明的话，拖动过程中没有任何
 * 东西跟着鼠标，观感是"拖了一下、松手后别处冒出个窗口"。
 *
 * 【为什么在主进程做，不在渲染层用 html2canvas】
 * 渲染层拿不到自己的像素（contextIsolation + 无 nodeIntegration）。
 * 而 webContents.capturePage 是主进程 API，且**实测很快**：
 * 区域截图预热之后 5ms（全窗口 15ms），缩到 360px 宽后约 14KB 的 data URL。
 * 一次截图的开销远低于拖拽时每帧移位的开销，不会让拖动变卡。
 *
 * @param {{x:number,y:number,width:number,height:number}} [rect]
 *   内容区在窗口内的 DIP 矩形；不传则截整窗。
 * @returns {Promise<string|null>} data:image/png;base64,… ；失败返回 null
 *   （不做成抛错：拖拽预览拿不到图是可以接受的降级，不该打断拖拽本身）
 */
handle(CH.WIN.THUMBNAIL, async (e, rect) => {
  const w = senderWindow();
  if (!w) return null;
  try {
    const opts = (rect && rect.width > 0 && rect.height > 0)
      ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      : undefined;
    const img = await w.webContents.capturePage(opts);
    if (!img || img.isEmpty()) return null;
    /* 缩到 360px 宽：够看清是哪个工具页，又不至于让 IPC 传几百 KB。
     * 高度按比例，不裁剪 —— 预览图长宽比与真实页面一致才像"缩略图"。 */
    const sz = img.getSize();
    const targetW = 360;
    const scaled = sz.width > targetW
      ? img.resize({ width: targetW, height: Math.round(sz.height * targetW / sz.width) })
      : img;
    return scaled.toDataURL();
  } catch (err) {
    return null;
  }
});
/* 让渲染层知道「这次是从默认值起来的」。
 * 不加这条的话，用户只会看到笔记/收藏/剪贴板历史全空了，却不知道
 * 是数据文件损坏、也不知道原文件已被另存到哪 —— 只会以为程序把数据弄丢了。
 * 正常启动时 storeLoadFailed 为 false，界面不受任何影响。 */
handle(CH.STORE.HEALTH, () => ({
  ok: !storeLoadFailed,
  corruptCopy: storeCorruptCopy,
  file: storeFile(),
}));
handle(CH.APP.GET_INFO, () => ({
  appVersion: app.getVersion(),
  electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome,
  platform: process.platform,
  userData: app.getPath('userData'),
  exePath: app.getPath('exe'),
  hostname: os.hostname(),
  username: os.userInfo().username
}));
handle(CH.STORE.GET, (e, key, def) => storeGet(key, def));
handle(CH.STORE.SET, (e, key, val) => {
  const parts = String(key).split('.');
  if (parts[0] === 'updateCache' || parts.some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) {
    throw new Error('该存储路径由主进程管理，不能从页面修改');
  }
  const r = storeSet(key, val);
  /* 【偏好值改动要广播给所有窗口】
   * 主窗口改 set，独立工具窗口的 Prefs 缓存不会自动更新 —— 用户会认为
   * 「设置没生效」。广播一次，各窗口重跑 Prefs.applyFromStore。
   * 只对 settings.prefs* 这一个命名空间广播：其它 store 键（笔记、
   * 剪贴板历史、缓存）改动极其频繁，全广播会把 UI 打满。 */
  if (typeof key === 'string' && key.startsWith('settings.prefs')) broadcastUiPrefs();
  return r;
});
/* store:remove 已移除：全项目没有任何调用方（渲染层只删收藏/历史时用的是
 * store:set 置空）。js/api.js 的浏览器模拟分支曾保留它，也一并删掉。 */
/* ============ 独立工具窗口（v0.6.0）============
 * 渲染层把标签拖出标签栏时调用它，把该工具弹成一个独立窗口。
 *
 * 【为什么复用 index.html 而不是另做一个 tool.html】
 * 工具页依赖整套外壳：js/ui.js 的组件、Registry、i18n、channels 常量表、
 * JobPrefix、i18n 工具正文表…… 另做一个页面就要复制这 20 多个 <script>，
 * 两份迟早分叉（改了一条通道常量、独立窗仍是旧的）。复用同一个页面 +
 * 一个 standalone 启动参数，加载的是同一批文件、同一个启动路径。
 *
 * 【用 query 参数而不是 additionalArguments】
 * additionalArguments 在 preload 里读（process.argv），
 * 而"要打开哪个工具"是渲染层的事，preload 不该知道。
 * 用 loadFile 的 query 传 tool / standalone，渲染层启动时读 location.search。
 *
 * 【独立窗口不继承主窗口的标签栏状态】
 * 它就是"一个工具占一个窗口"，没有标签栏、没有侧边栏，只有标题栏 + 工具页。
 * 这样拖出去之后用户得到的是一个干净的专注窗口，而不是一个缩小版主窗。 */
let toolWindows = [];

function openToolWindow(toolId) {
  if (!toolId || typeof toolId !== 'string') throw new Error('缺少工具 id');
  /* 同一个工具已经弹出去过：聚焦那一个，而不是开第二个。
   * 用户拖出去两次通常是不确定"上次成没成"，再开一个反而更乱。 */
  for (const w of toolWindows) {
    if (w && !w.isDestroyed() && w.__heheToolId === toolId) {
      try { if (w.isMinimized()) w.restore(); w.focus(); } catch (e) {}
      return { focused: true, id: w.id };
    }
  }
  const packagedArg = '--hehe-packaged=' + (app.isPackaged ? '1' : '0');
  const w = new BrowserWindow({
    /* 比主窗小一圈：它是"一个工具"，不需要主窗那么大的画布。
     * 宽高给得够放常见的表单 + 结果区。 */
    width: 900, height: 640, minWidth: 560, minHeight: 420,
    frame: false, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#F2F3F5',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    /* 【标题必须带上工具名】原来所有独立窗口都叫「核核工具箱」：开三个之后，
     * 任务栏与 Alt+Tab 里是三个同名条目，只能靠缩略图辨认哪个是哪个。
     * 名字从 lib/tool-names.js 取 —— 主进程读不到渲染层的注册表（js/tools/*
     * 是浏览器脚本，require 会立刻 TypeError），而给 100 多个工具文件加 UMD
     * 适配只为拿一个名字，不值得。两张表由 scripts/test-tool-window-title.js
     * 守着一致性，新增工具漏登记会直接红。 */
    title: toolNames.toolTitle(toolId, uiLang),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      additionalArguments: [packagedArg],
      spellcheck: false,
    }
  });
  hardenWindow(w);
  w.__heheToolId = toolId;
  /* 【窗口的 webContents id 要在创建时记下来】'closed' 触发时 webContents
   * 已经销毁，那时 getWebContents() 拿不到 id —— 而没有它就无法判断
   * 「哪些任务是这个窗口发起的」。 */
  let wcId = null;
  try { wcId = w.webContents.id; } catch (e) { wcId = null; }
  w.loadFile('index.html', { query: { tool: toolId, standalone: '1' } });
  w.once('ready-to-show', () => { try { w.show(); } catch (e) {} });
  w.on('closed', () => {
    toolWindows = toolWindows.filter((x) => x !== w);
    /* 【关窗必须连带取消它启动的任务，否则任务变孤儿、事件漏到主窗口】
     * 用户关掉正在跑 ffmpeg 的独立窗口，任务却继续在后台跑：
     *   · 没有任何 UI 能再取消它（jobId 已随窗口消失）；
     *   · 之后每条 job:stream 都会命中 send() 的"调用者已销毁"那一档，
     *     要么被丢弃、要么（在老代码里）漏到主窗口，被主窗同工具页的
     *     JobPrefix 认领成自己的任务 —— 进度条乱跳、结束时弹「完成」。
     * 归属是在 jobs.set 时打上的（见 lib/job-owner.js），这里按 id 清账。 */
    const killed = jobs.cancelOwnedBy(wcId);
    if (killed > 0) console.warn('[job] 独立窗口关闭，已取消它启动的 ' + killed + ' 个任务');
  });
  toolWindows.push(w);
  return { focused: false, id: w.id };
}

handle(CH.APP.OPEN_TOOL_WINDOW, (e, toolId) => openToolWindow(toolId));
/* 主题：nativeTheme 是系统级开关，改完各窗口的 CSS 却不会自动跟着变 ——
 * 它们看的是自己 documentElement 上的 data-theme。所以必须广播。
 * 返回值带上最终明暗，调用方（主窗）不用再猜 'system' 解出来是什么。 */
handle(CH.APP.SET_THEME, (e, mode) => {
  nativeTheme.themeSource = mode;
  broadcastUiPrefs();
  return nativeTheme.shouldUseDarkColors;
});
handle(CH.APP.SET_AUTOSTART, (e, enable) => {
  if (isWin || isMac) app.setLoginItemSettings({ openAtLogin: !!enable });
  return app.getLoginItemSettings().openAtLogin;
});
handle(CH.APP.GET_AUTOSTART, () => (isWin || isMac) ? app.getLoginItemSettings().openAtLogin : false);
handle(CH.APP.SET_HOTKEY, (e, acc) => applyHotkey(acc));

/* ---- 崩溃日志的界面入口 ----
 * 只读为主，不需要门禁（清空也只删 logs/ 下的 crash*.log，不碰用户数据）。
 * 四个通道：
 *   info   上次是否异常退出 + 日志文件列表（设置页显示一行摘要）
 *   read   最近一条日志的尾部（用户点「查看」时按需读，不预热）
 *   reveal 在文件管理器里定位日志目录（用户要发给开发者）
 *   clear  清空已有日志（会话标记是另一套语义，不受影响） */
handle(CH.APP.CRASH_INFO, () => {
  const logs = crashLog.listLogs(crashLogDir());
  return {
    lastSessionCrashed: lastSessionCrashed,
    dir: crashLogDir(),
    count: logs.length,
    totalBytes: logs.reduce((a, b) => a + b.size, 0),
    latest: logs.length ? { name: logs[0].name, size: logs[0].size, mtime: logs[0].mtime } : null
  };
});
handle(CH.APP.CRASH_READ, (e, maxBytes) => {
  // 上限夹一下：渲染层传大值也不能让它把几 MB 文本塞进 IPC
  const n = Math.min(64 * 1024, Math.max(1024, Number(maxBytes) || 16 * 1024));
  return crashLog.tail(crashLogDir(), n);
});
handle(CH.APP.CRASH_REVEAL, async () => {
  const dir = crashLogDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  // showItemInFolder 需要文件路径；目录直接 openPath 更稳
  try { await shell.openPath(dir); return true; } catch (e) { return false; }
});
handle(CH.APP.CRASH_CLEAR, () => {
  // 清空日志：删除所有 crash*.log。会话标记不动（那是另一套语义）
  const logs = crashLog.listLogs(crashLogDir());
  let n = 0;
  for (const l of logs) {
    try { fs.rmSync(l.path, { force: true }); n++; } catch (e) {}
  }
  return n;
});

/* ================= IPC: dialog ================= */
/* 【对话框必须归属「发起调用的那个窗口」】
 * 原来写死 dialog.showOpenDialog(win, …)：独立工具窗口里点「选择文件/保存文件」
 * 时，对话框挂在主窗上 —— 不居中于发起它的窗口、不是它的模态子窗口，
 * 用户还能继续点独立窗，容易连点出好几个对话框。
 * 这与 WIN.MINIMIZE/MAXIMIZE/CLOSE 的 senderWindow() 修复是同一类问题
 * （窗口控制按发起者路由、dialog 漏了），也与 ipc/media-ffmpeg.js 的
 * ffmpeg:pick 用的 ctx.win getter 同理。
 * 优先按 ALS 上下文取发起窗口；托盘/定时这类无调用者的路径退回主窗。 */
handle(CH.DIALOG.OPEN, async (e, opts = {}) => {
  const r = await dialog.showOpenDialog(senderWindow(), {
    title: opts.title, defaultPath: opts.defaultPath,
    properties: opts.properties || ['openFile'],
    filters: opts.filters
  });
  return r.canceled ? null : r.filePaths;
});
handle(CH.DIALOG.SAVE, async (e, opts = {}) => {
  const r = await dialog.showSaveDialog(senderWindow(), { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
  return r.canceled ? null : r.filePath;
});
/* dialog:message 已移除：全项目无调用方（需要确认时用渲染层的 confirmBox，
 * 需要系统原生提示时走 dialog:save / dialog:open 那条线）。 */

/* ================= IPC: 乱码修复 / 编码探测 =================
 * 中文 Windows 上最常见的三种乱码（锟斤拷、GBK 当 UTF-8 读、
 * UTF-8 当 latin1 读）都在这里处理。核心逻辑在 lib/mojibake.js。
 *
 * 输入有两种形态：
 *   - 用户粘贴的一段乱码文本（字符串）
 *   - 一个文件（原始字节，探测最准）
 * 两者都走同一条分析链，返回排序后的候选 + 每条的分数。
 */
handle(CH.TEXT.DETECT_ENCODING, async (e, input, opts = {}) => {
  const o = opts || {};
  if (!input) throw new Error('没有要分析的内容');

  /* 文件形态：直接读字节，交给编码探测（最准，因为拿的是原始数据） */
  if (o.isFile) {
    const st = await fsp.stat(input).catch(() => null);
    if (!st) throw new Error('文件不存在：' + input);
    if (st.size > 16 * 1024 * 1024) throw new Error('文件过大（>16MB），请改用「文件编码转换」');
    const buf = await fsp.readFile(input);
    const cands = mojibake.detectEncodings(buf);
    /* 【把候选统一成 from/to 形状再返回】
     * lib 里 detectEncodings 的字段是 encodings/label/text/score（见
     * lib/mojibake.js 的签名注释；那个字段名叫 encodings 是历史拼写，
     * 有测试与外部引用，不在主进程这边改名）。
     * 而渲染层读的是 from/to —— 早期直接把原始对象透出去，于是文件模式的
     * 「最可能的结果」显示「? → ?」、候选表的「转换」列全是「? → ?」、
     * rowKey 全为空串，真正有用的编码名一个字都没显示出来。
     * 文件模式存在的意义就是告诉用户「这文件其实是 GBK」，所以这里补上：
     *   from = '原始字节'（文件模式没有「从某个编码解过来」这一步，是原始字节换解码器）
     *   to   = label（真正要显示的东西）
     * 同时保留 label / encodings 原字段，外部若有引用不受影响。 */
    const shaped = cands.slice(0, 6).map((c) => Object.assign({}, c, {
      from: '原始字节',
      to: c.label || c.encodings || '?',
    }));
    return {
      source: 'file', path: input, size: st.size,
      best: shaped[0] || null,
      candidates: shaped,
      kuen: false,
      note: cands.length ? '' : '这个运行时缺少可用的编码解码器',
    };
  }

  /* 文本形态。
   * 【锟斤拷这类乱码以前只能识别、修不了】
   * 标准解法是「按源编码把字符编回字节 → 按目标编码解」，而 Node 只有
   * UTF 系列的编码器（GBK/Big5 只能解不能编），这条链一直缺着。
   * 现在把主进程的 ps() 注入给 lib：.NET 的 GetEncoding(936) 就是 CP936，
   * 一次 PowerShell 进程算完所有需要的源编码（逐条起进程要好几秒）。
   * 文本过长会撞上命令行长度上限，超过就跳过并如实说明 ——
   * 不能悄悄退回「无候选」，那会让用户以为这条修复路径不存在。 */
  const textIn = String(input);
  const canUsePs = textIn.length <= 6000;
  if (canUsePs) {
    const r = await mojibake.analyzeWithEncoder(textIn, ps);
    return Object.assign({ source: 'text' }, r);
  }
  const r = mojibake.analyzeMojibake(textIn);
  return Object.assign({ source: 'text' }, r, {
    externalTried: false,
    note: (r.note ? r.note + ' ' : '') +
      '（文本较长，未尝试借助系统编码器的 GBK 修复；把内容拆短一些再试。）',
  });
});

/* 把「按某个编码解码后」的文本再按另一个编码编回去 —— 用于「我想换成 GBK
 * 存盘」这类需求。Node 只内置 UTF 系列的编码器，其它编码要靠系统编码器
 * （mojibake.encodeTextMany 那条路，乱码修复已经在用），但「另存为该编码」
 * 这个功能尚未提供 —— 所以这里只给**判定**，不假装能转。
 * 判定本身仍是有用的：含 U+FFFD 的文本任何转码都救不回来。 */
handle(CH.TEXT.CAN_REENCODE, async (e, text, enc) => {
  const target = String(enc || '');
  const lossy = /[\uFFFD]/.test(String(text || ''));
  const supported = ['utf-8', 'utf-16le', 'utf-16be'].indexOf(mojibake.normEnc(target)) !== -1;
  return {
    ok: true, supported, lossy,
    note: lossy
      ? '文本里含替换字符（U+FFFD），说明原始字节已经丢失，任何转码都无法完全还原'
      : (supported
        ? '可以转换'
        : '这个编码要靠系统工具（.NET 编码器）完成 —— 本应用在乱码修复时已经在用；' +
          '但目前不提供「另存为该编码」'),
  };
});

/* ================= IPC: fs / hash / crypt / split / dedupe / zip =================
 * 28 个通道全部搬到了 ipc/fs-ops.js（任务 7）。
 * 搬运方式：整段照抄，只有 ++jobSeq → ctx.nextJobSeq()、latestCancelable = X →
 * setLatestCancelable(X) 这两类机械替换，与 dir-acl-links / media-ffmpeg 同构。
 *
 * 【为什么这几个函数从模块里取回来】writeFileAtomic / dirSizeFast / walkDir /
 * uniqueTarget / isOwnTempName 定义在被搬走的那一段里，但本文件的其他域也在用
 * （例如 hosts 兜底要用 writeFileAtomic、垃圾扫描要用 isOwnTempName）。
 * 与其复制一份回去让两份实现分叉，不如让模块反向导出、这里解构取用。
 */
const fsIpc = require('./ipc/fs-ops')(ipcCtx, {
  handle, send, jobs, fmtErr,
  setLatestCancelable: (fn) => { latestCancelable = fn; },
  fs, fsp, path, os, crypto, shell,
  AdmZip, pathGuard, tempNames, fsOps, archiveGuard,
  uniqueTarget, isOwnTempName,
});
/* 从模块取回被其他域共用的实现（见上面那段说明） */
const { writeFileAtomic, dirSizeFast, walkDir } = fsIpc;


/* ================= IPC: exec / process ================= */
/* 危险系统命令的识别：exec:run 是通用命令通道，本身不设高危门禁（快捷启动等功能要用它），
 * 但**关机/重启/休眠**这类不可逆操作必须走 system-power 门禁 ——
 * 否则用户没开「系统电源操作」开关，也能通过「定时任务」工具里的
 * `shutdown /s /t 60` 把机器关掉，等于门禁形同虚设。
 *
 * 注意 `shutdown /a`（取消已安排的关机）是**无害的恢复操作**，必须放行 ——
 * 否则用户没法取消自己刚排的关机。
 *
 * 【实现已抽到 lib/power-gate.js】原因：这段判定原来只存在于本文件，
 * 单元测试为了测它把同样的正则抄了一份，导致 main.js 改动后测试仍全绿（假绿）。
 * 现在 main.js 与 test-powergate.js 都 require 同一个实现，改一处两边同步。 */
/* eslint-disable-next-line no-unused-vars -- 历史遗留：定义了但未使用（删它需同步改测试断言，留给下一轮） */
function isPowerCommand(cmd) {
  return powerGate.isPowerCommand(cmd);
}
function assertPowerAllowed(cmd) {
  const denyMsg = powerGate.checkPowerGate(cmd, dangerousEnabled('system-power'));
  if (denyMsg) {
    /* 【文案由这里生成，不用 lib 里那句】
     * lib/power-gate.js 是纯函数模块，没有语言上下文，它返回的固定中文句子
     * 在英文界面下就是「一半英文一半中文」。这里按当前语言重建一句：
     * 能力名走 capText（与设置页同一份），句式走 GATE_TEXT。
     * 仍然用 powerGate 的返回值当判据 —— 判定逻辑只有一份。 */
    const e = new Error(dangerousDenied('system-power'));
    e.code = 'CAP_DENIED';
    throw e;
  }
}
handle(CH.EXEC.RUN, async (e, { cmd, args, shellType, cwd, timeoutMs }) => {
  /* 关机/重启/休眠必须先在设置里开启「系统电源操作」。
   * 【必须拿「整条命令」判，不能把 cmd 与 args 分开判】
   * power-gate 的剥离逻辑是按整条命令行做的：`cmd.exe` 自己不是危险词，
   * `/c shutdown /s /t 0` 单独看也只是个参数串，两者拼起来才是关机命令。
   * 早期分开判，于是下面这些全部穿门禁（已实测 isPowerCommand 单判皆 false、
   * 整条拼接皆为 true）：
   *   exec:run { cmd:'cmd.exe', args:['/c','shutdown','/s','/t','0'] }
   *   exec:run { cmd:'powershell.exe', args:['-Command','Stop-Computer'] }
   *   exec:stream 同理
   * 而「定时关机」工具正是走 exec:run + shellType:'cmd'，
   * 这条门禁存在的唯一理由就是拦住它。 */
  const flatArgs = Array.isArray(args) ? args.map((a) => String(a == null ? '' : a)) : [];
  assertPowerAllowed([String(cmd == null ? '' : cmd), ...flatArgs].join(' '));
  if (shellType === 'ps') return await ps(cmd, timeoutMs || 30000, cwd);
  if (shellType === 'cmd') {
    return await runCmd('cmd.exe', ['/c', cmd], { cwd, timeout: timeoutMs || 30000, encoding: 'gbk' });
  }
  return await runCmd(cmd, args || [], { cwd, timeout: timeoutMs || 30000, encoding: 'gbk' });
});
handle(CH.EXEC.STREAM, (e, { command, args, cwd }) => {
  // 流式通道同样要过电源门禁（理由见 exec:run 上方注释：必须整条判）
  const flatArgs = Array.isArray(args) ? args.map((a) => String(a == null ? '' : a)) : [];
  assertPowerAllowed([String(command == null ? '' : command), ...flatArgs].join(' '));
  const id = 'job' + (++jobSeq);
  const proc = spawn(command, args || [], { windowsHide: true, cwd });
  jobs.set(id, {
    /* proc.pid 在 spawn 失败（ENOENT）时是 undefined，`String(undefined)` 会让
     * taskkill 报「找不到进程 undefined」并被空 catch 吞掉 —— 用户以为取消了，
     * 进程却还在跑。pid 拿不到时退回 proc.kill()。 */
    cancel: () => {
      try {
        if (!proc.pid) { try { proc.kill(); } catch (e2) {} return; }
        if (isWin) spawnDetached('taskkill', ['/pid', String(proc.pid), '/t', '/f']);
        else proc.kill('SIGKILL');
      } catch (err) {}
    }
  });
  // 每个任务持有自己的解码器（stream:true 保留跨块的多字节字符）
  let outDec, errDec;
  try { outDec = new TextDecoder('gbk'); errDec = new TextDecoder('gbk'); } catch (e) { outDec = errDec = new TextDecoder(); }
  proc.stdout.on('data', (d) => { send('job:stream', { id, data: outDec.decode(d, { stream: true }) }); });
  proc.stderr.on('data', (d) => { send('job:stream', { id, data: errDec.decode(d, { stream: true }), err: true }); });
  proc.on('exit', (code) => { jobs.delete(id); send('job:exit', { id, code }); });
  proc.on('error', (err) => { jobs.delete(id); send('job:exit', { id, code: -1, error: fmtErr(err) }); });
  return id;
});
/* 【取消任务必须核对归属】
 * 这里原来是 `const j = jobs.get(id); if (j) j.cancel(); return true;` ——
 * 一句校验都没有，而对任何 id（包括根本不存在的）都返回 true。
 * 后果有两层：
 *   · v0.6.0 多窗口之后，A 窗口拿到 B 窗口的 job id 就能直接杀掉它的任务；
 *   · 调用方拿到的 true 无法区分"已取消"与"这个 id 根本不存在"。
 * 归属由 OwnerJobMap 在 set() 时自动补 ownerWC（见 lib/job-owner.js）。
 * 这里取当前调用者：als 上下文里有 sender 就用它，没有（托盘/定时）就是 null。 */
handle(CH.JOB.KILL, (e, id) => {
  const st = als.getStore();
  const caller = (st && st.sender && typeof st.sender.id === 'number') ? st.sender.id : null;
  if (jobs && typeof jobs.cancelIfOwnedBy === 'function') return jobs.cancelIfOwnedBy(id, caller);
  /* 兜底：jobs 若不是 OwnerJobMap（测试桩等）就退回旧行为，不要因为这次加固
   * 让取消按钮在那种环境下彻底失效。 */
  const j = jobs.get(id);
  if (j) j.cancel();
  return { ok: true, cancelled: !!j };
});
// 取消最近一次启动的可取消任务（扫描/测速等，renderer 拿不到 job id 时使用）
/* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
let latestCancelable = null;
/* job:cancel-latest 已移除：全项目没有调用方 —— 渲染层的取消按钮一律走
 * job:kill <id>（带归属校验，不会误杀别人的任务）。
 * latestCancelable 本身保留：各长任务仍在装它，将来若要加「一键取消全部」
 * 可以直接读这个变量，不必再开一条无人使用的通道。 */

/* process list with cpu% (PS based) */
handle(CH.PROC.LIST, async () => {
  const r = await ps(`@(Get-Process | ForEach-Object { $p=$_; $path=''; try{$path=$p.Path}catch{}; [pscustomobject]@{id=$p.Id;name=$p.ProcessName;cpu=$p.CPU;ws=[math]::Round($p.WorkingSet64/1KB,0)} }) | ConvertTo-Json -Compress`, 20000);
  let rows;
  try { rows = JSON.parse(r.stdout || '[]'); } catch (err) { throw new Error('进程查询失败：' + (r.stderr || err.message)); }
  if (!Array.isArray(rows)) rows = [rows];
  const now = Date.now();
  const out = [];
  const prev = lastProcSnap ? lastProcSnap.map : null;
  const newMap = new Map();
  for (const row of rows) {
    if (row.id == null) continue;
    let cpuPct = null;
    if (prev && prev.has(row.id) && row.cpu != null && prev.get(row.id).cpu != null) {
      const dCpu = row.cpu - prev.get(row.id).cpu;
      const dt = (now - lastProcSnap.t) / 1000;
      // 用缓存的核数：进程列表每轮都会调到这里，没必要每次都枚举 CPU
      if (dt > 0 && dCpu >= 0) cpuPct = Math.round(Math.min(100, (dCpu / dt / cpuCoreCount()) * 100) * 10) / 10;
    }
    newMap.set(row.id, { cpu: row.cpu });
    out.push({ pid: row.id, name: row.name, cpu: row.cpu, memKB: row.ws || 0, cpuPct });
  }
  lastProcSnap = { t: now, map: newMap };
  out.sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0) || b.memKB - a.memKB);
  return out;
});
handle(CH.PROC.DETAIL, async (e, pid) => {
  const r = await ps(`Get-CimInstance Win32_Process -Filter "ProcessId=${parseInt(pid, 10)}" | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`, 15000);
  if (!r.stdout.trim()) return { path: '', cmdline: '' };
  const j = JSON.parse(r.stdout);
  return { path: j.ExecutablePath || '', cmdline: j.CommandLine || '' };
});
/* 系统关键进程黑名单：结束它们会导致蓝屏 / 强制重启 / 会话崩溃。
 * 按**进程名**判断（PID 每次启动都变，不可靠）。
 *   lsass     -> 本地安全认证，杀掉立即蓝屏重启
 *   csrss     -> 客户端/服务器运行时子系统，杀掉立即蓝屏
 *   wininit / services / smss / winlogon -> 启动与会话管理，杀掉系统不可用
 *   System / Registry / Memory Compression -> 内核线程，无法也不应结束 */
const PROTECTED_PROC_NAMES = new Set([
  'system', 'registry', 'smss', 'csrss', 'wininit', 'services', 'winlogon', 'lsass',
  'lsaiso', 'fontdrvhost', 'dwm', 'memory compression', 'secure system', 'msmpeng',
  'svchost', 'explorer'
]);
const PROTECTED_PROC_PID_MAX = 1000;   // 低 PID 区几乎全是系统进程，保守拦截

/* 【结束进程的唯一实现：PROC.KILL 与「文件占用解锁」共用】
 * 原来这段判据直接写在 PROC.KILL 的 handler 里。加解锁功能时如果另写一份，
 * 就会出现两份白名单 —— 历史上已经踩过一次（加了一边忘另一边）。
 * 抽成函数后：判据只有一份，两条通道各自只负责自己的上下文校验
 * （PROC.KILL 不需要关心"这个 pid 是不是这个文件的占用者"，
 *   解锁那边要）。
 * 返回 true 表示已执行 taskkill；失败一律抛（带上给用户看的中文原因）。 */
async function killProcessChecked(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) throw new Error('进程 ID 无效');
  // 不能杀自己：主进程被杀会导致正在进行的录制/下载/写盘中断，
  // flushStore 没机会执行，hehe-data.json 会停留在旧状态（最坏丢一次改动）。
  if (n === process.pid) throw new Error('不能结束本程序自身的进程');
  /* 查进程名，命中系统关键进程直接拒绝。注意 taskkill 的 /f 对 lsass 这类
   * 受保护进程会触发系统强制重启（蓝屏），是不可逆破坏。
   *
   * 【必须区分「进程已退出」与「查询本身失败」】
   * 原实现用一个 try 包住保护判定，catch 里靠 `/拒绝结束/` 文本匹配决定是否
   * 重新抛出 —— 也就是说 PowerShell 查询本身失败（策略禁用、超时、无输出）时，
   * 保护性检查被整体跳过，只要 PID > 1000 就直接 /f 强杀。
   * 而「查询失败」与「进程不存在」是两件完全不同的事：前者说明我们**没能**
   * 确认它是不是关键进程，此时应当拒绝，而不是放行。
   * （注释原本写的是「查不到进程名时放行（进程可能已退出）」，那是有意为之；
   *  但只有 stdout 为空才代表「进程不存在」，抛异常代表查询机制坏了。） */
  let pname = '';
  try {
    const r = await ps(`try{(Get-Process -Id ${n} -ErrorAction Stop).ProcessName}catch{''}`, 10000);
    pname = String(r.stdout || '').trim().toLowerCase();
  } catch (err) {
    throw new Error('无法确认 PID ' + n + ' 是不是系统关键进程（进程查询失败：' + fmtErr(err) +
      '），已拒绝结束它。请用任务管理器确认后再操作。');
  }
  if (pname && PROTECTED_PROC_NAMES.has(pname)) {
    throw new Error(`拒绝结束系统关键进程：${pname}（ID ${n}）。结束它会导致系统蓝屏或强制重启。`);
  }
  if (n <= PROTECTED_PROC_PID_MAX) {
    throw new Error(`拒绝结束 PID ${n}：低 PID 区（≤${PROTECTED_PROC_PID_MAX}）通常是系统进程，误杀会造成不可逆损坏。如确认无误请用任务管理器操作。`);
  }
  await runCmd('taskkill', ['/pid', String(n), '/f'], { timeout: 10000 });
  return true;
}
handle(CH.PROC.KILL, async (e, pid) => killProcessChecked(pid));

/* ================= IPC: network（已搬到 ipc/net-lan.js）================= */
require('./ipc/net-lan')({
  handle, runCmd, jobs,
  // 拆分纪律：这些能力必须注入，模块不能自己实现（见 ipc/net-lan.js 头部）
  nextJobSeq: () => ++jobSeq,
  setLatestCancelable: (fn) => { latestCancelable = fn; },
  send,
  ps,
});
/* static server */
handle(CH.SERVER.START, async (e, root, port) => {
  if (serverMap.has('s')) throw new Error('已有服务在运行，请先停止');
  let p = port || 8128;
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
  const srv = http.createServer(async (req, res) => {
    try {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      const absRoot = path.resolve(root);
      let fp = path.resolve(path.join(absRoot, urlPath));
      /* 【逃逸检查必须解析真实路径】只做字符串比较时，root 内若有指向外部的
       * symlink / junction（node_modules\.bin 类目录里就有），可以读到 root 之外的文件。
       * 这里先 realpath 归一，再做「是否在 root 内」判定，并且大小写不敏感
       * （Windows 文件系统不区分大小写，纯 startsWith 会被大小写变体绕过）。 */
      let realRoot, realFp;
      try { realRoot = fs.realpathSync.native(absRoot); } catch (err) { realRoot = absRoot; }
      try { realFp = fs.existsSync(fp) ? fs.realpathSync.native(fp) : fp; } catch (err) { realFp = fp; }
      {
        const lq = realFp.toLowerCase(), lr = realRoot.toLowerCase();
        const ok = lq === lr || lq.startsWith(lr + path.sep) || lq.startsWith(lr + '/');
        if (!ok) { res.writeHead(403); res.end('403'); return; }
      }
      let st = await fsp.stat(fp).catch(() => null);
      if (st && st.isDirectory()) { fp = path.join(fp, 'index.html'); st = await fsp.stat(fp).catch(() => null); }
      if (!st) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found');
        send('server:log', { time: Date.now(), text: `404  ${req.method} ${urlPath}` });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
      const stream = fs.createReadStream(fp);
      /* 【客户端断开时必须销毁读流，否则 fd 泄漏】
       * 原来只有 stream.on('error')，没有 res.on('close')。
       * pipe 在目标端失效时只会 unpipe，**不会**销毁源流；
       * 浏览器关标签、刷新页面、取消下载都会让 createReadStream 停在半途，
       * 文件句柄一直开着 —— 反复刷新一个大文件页面就能把句柄耗光。
       * 现在用 pipeline 让 Node 自己负责销毁与清理（它会在任一端结束/出错时
       * 销毁另一端），比手写 res.on('close') 更完整。 */
      try {
        const { pipeline } = require('stream');
        pipeline(stream, res, () => { /* 结束/出错都无需额外处理，资源已由 pipeline 释放 */ });
      } catch (e) {
        // 极端兜底：pipeline 不可用时至少保证客户端断开能销毁读流
        res.on('close', () => { try { stream.destroy(); } catch (x) {} });
        stream.on('error', () => { try { res.destroy(); } catch (x) {} });
        stream.pipe(res);
      }
      send('server:log', { time: Date.now(), text: `200  ${req.method} ${urlPath}  ${st.size}B` });
    } catch (err) { res.writeHead(500); res.end('500'); }
  });
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(p, '127.0.0.1', () => resolve()); });
  serverMap.set('s', srv);
  /* 记下真实根目录与端口：server:status 要能据此回填界面（见该 handler 的说明） */
  serverRoot = root; serverPort = p;
  return { port: p, url: `http://127.0.0.1:${p}` };
});
handle(CH.SERVER.STOP, () => {
  const s = serverMap.get('s');
  /* 【时序问题：已实测，结论是「不成立，无 EADDRINUSE」，只留下 status 短暂的滞后】
   * 原本担心的是：s.close() 是异步的（要等所有连接结束才真正释放端口），
   * 而下面紧接着就 serverMap.delete('s') 并把 serverRoot/serverPort 置空。
   * 若此刻还有 pipeline 在传大文件，理论上会 EADDRINUSE、甚至变成没人能 stop 的孤儿。
   *
   * 【实测：在 Windows 上不成立】
   * 用慢速客户端 + 8MB 文件，传到一半调用 close() 并立刻同端口 listen：
   *   · 同端口重启**成功**，没有 EADDRINUSE；
   *   · 旧传输**自然完结**（8/8 MB 全部收完，不是被截断）；
   *   · 唯一真实存在的现象是 status 短暂滞后：从 close() 到传输真正结束
   *     约 170ms 内，server:status 已经返回 null，而端口还没释放。
   * 成因是 Windows 的 socket 双绑定语义：listen 的独占性与「已建立的连接」
   * 不是同一件事 —— 老连接继续跑，新 listen 照样能绑上同一个端口。
   * Linux 上 close() 后立刻 listen 会 EADDRINUSE（这个差异如果哪天要跨平台，
   * 需要重新评估，但本项目只发 Windows 包）。
   *
   * 【所以不改行为】改成「等 close 回调再清状态」只为消除 170ms 的显示滞后，
   * 代价是 stop 之后按钮要等当前传输结束才恢复 —— 对用户是更糟的体验
   * （点停止没反应）。**注意：这里不是"没验证过所以先不动"，而是验证过
   * 之后确认原来的担心不成立**，才保持现状。
   * scripts/test-static-server-stop.js 把这个实测结论钉住了：
   * 它真的起服务器、真的限速传输、真的同端口重启，断言「不 EADDRINUSE
   * + 旧传输完整」，所以将来若换平台或改 Node 版本导致行为变化，那条会先红。 */
  if (s) { s.close(); serverMap.delete('s'); }
  serverRoot = null; serverPort = null;
  return true;
});
/* 【server:status 恢复 —— 它曾经被"没有调用方"删掉，但那个判断漏了一件事】
 *
 * 服务本身活在**主进程**的 serverMap 里，页面销毁（切页）并不会停服。
 * 而渲染层每次 render() 都是全新局部状态（let running = false、
 * stopBtn.disabled = true），没有任何地方同步主进程的真实状态。
 * 于是「启动 → 切到别的工具页 → 切回来」会变成死局：
 *   · 界面显示「未启动」；
 *   · 点启动报「已有服务在运行，请先停止」；
 *   · 停止按钮是禁用的（因为界面以为没启动）。
 * 用户只能重启程序。
 *
 * 真正的结论是：**跨页面存活的东西必须有地方问它还在不在**。
 * 只有只读、不产生副作用的查询，所以不需要门禁。 */
handle(CH.SERVER.STATUS, () => {
  const s = serverMap.get('s');
  if (!s) return null;
  return { running: true, root: serverRoot, port: serverPort, url: serverPort ? `http://127.0.0.1:${serverPort}` : null };
});

/* ================= IPC: system ================= */

/* 磁盘健康采集。**诚实原则**见 lib/disk-health.js 顶部注释：
 * 拿不到的字段留 null，绝不填 0，绝不合成「健康度」。
 *
 * 【实测过的数据源与结果】
 *   Get-PhysicalDisk               → 可靠（型号/介质/总线/容量/系统健康状态）
 *   Get-StorageReliabilityCounter  → 本机 NVMe 拿不到（返回空）
 *   MSStorageDriver_FailurePredictStatus → 同样拿不到
 *   Win32_DiskDrive.Status         → 只有 "OK"/"Error" 粗粒度
 * 所以采集脚本要把每个能取到的值**单独 try**，任一失败就留空，
 * 而不是整段失败、也不是补 0。 */
let diskHealthCache = null, diskHealthCacheAt = 0;

handle(CH.SYS.DISK_HEALTH, async (e, force) => {
  if (!force && diskHealthCache && Date.now() - diskHealthCacheAt < 300000) return diskHealthCache;

  const isAdmin = await isRunningAsAdmin();

  /* PowerShell 侧：逐字段取值，取不到就输出空字符串。
   * 用 JSON 输出，让 Node 侧能区分「缺失」与「0」——
   * 注意 PowerShell 里的 0 会被 JSON 序列化成 0，
   * 所以取不到的字段统一用 $null（序列化成 null），不能写 0。 */
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @()
$disks = Get-PhysicalDisk
foreach ($d in $disks) {
  $o = [ordered]@{}
  $o.model = [string]$d.FriendlyName
  $o.mediaType = [string]$d.MediaType
  $o.busType = [string]$d.BusType
  $o.size = if ($d.Size) { [long]$d.Size } else { $null }
  $o.healthStatus = [string]$d.HealthStatus
  $o.operationalStatus = [string]$d.OperationalStatus
  $o.temperature = $null
  $o.powerOnHours = $null
  $o.wear = $null
  $o.readErrors = $null
  $o.writeErrors = $null
  $o.startStop = $null
  # 可靠性计数器：很多机器上返回空，取到才填
  $c = $null
  try { $c = $d | Get-StorageReliabilityCounter -ErrorAction Stop } catch { $c = $null }
  if ($c) {
    if ($c.Temperature -ne $null -and $c.Temperature -gt 0) { $o.temperature = [int]$c.Temperature }
    if ($c.PowerOnHours -ne $null) { $o.powerOnHours = [long]$c.PowerOnHours }
    if ($c.Wear -ne $null) { $o.wear = [int]$c.Wear }
    if ($c.ReadErrorsTotal -ne $null) { $o.readErrors = [long]$c.ReadErrorsTotal }
    if ($c.WriteErrorsTotal -ne $null) { $o.writeErrors = [long]$c.WriteErrorsTotal }
    if ($c.StartStopCycleCount -ne $null) { $o.startStop = [long]$c.StartStopCycleCount }
  }
  $out += $o
}
@($out) | ConvertTo-Json -Depth 4 -Compress
`;

  let raw = { disks: [] };
  try {
    const r = await ps(script, 40000);
    const text = String(r.stdout || '').trim();
    if (text) {
      const parsed = JSON.parse(text);
      /* ConvertTo-Json 在只有一个元素时会输出对象而不是数组 —— 统一成数组 */
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      /* 【关键】把 PowerShell 的 null 与「空字符串」都归一成 null，
       * 绝不把空字符串当 0。 */
      raw.disks = arr.map((d) => {
        const pick = (k) => {
          const v = d[k];
          if (v == null) return null;
          if (typeof v === 'string' && v.trim() === '') return null;
          return v;
        };
        return {
          model: pick('model'),
          mediaType: pick('mediaType'),
          busType: pick('busType'),
          size: pick('size'),
          healthStatus: pick('healthStatus'),
          operationalStatus: pick('operationalStatus'),
          temperature: pick('temperature'),
          powerOnHours: pick('powerOnHours'),
          wear: pick('wear'),
          readErrors: pick('readErrors'),
          writeErrors: pick('writeErrors'),
          startStop: pick('startStop'),
        };
      });
    }
  } catch (err) {
    raw = { disks: [], error: err.message };
  }

  const shaped = diskHealth.shape({ disks: raw.disks, isAdmin });
  if (raw.error) shaped.limitations.push('采集过程出错：' + raw.error);
  /* 每块盘附带剩余寿命说明（拿不到 wear 就是 null，界面显示「本机取不到」） */
  for (const d of shaped.disks) d.estimate = diskHealth.estimateRemaining(d.wear);

  diskHealthCache = shaped;
  diskHealthCacheAt = Date.now();
  return shaped;
});

let hwCache = null, hwCacheAt = 0;
/* 【PowerShell 5.1 的日期形态】
 * ConvertTo-Json 会把 DateTime 写成 "/Date(1793413286500)/"（带正斜杠转义）。
 * 派生的 TimeSpan（例如 Win32_Process 的 CreationDate）会写成
 * "/Date(ms)/" 或 {"value":..,"Days":..} 这类对象，两种都要能处理。
 * 这里统一转成毫秒数字；解析不出来就置 null（界面显示「-」，绝不显示 NaN）。
 * 纯函数，供测试直接调。 */
function parsePsDate(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object') {
    // TimeSpan / DateTime 的包装对象
    if (typeof v.value === 'number') return v.value;
    return null;
  }
  const s = String(v).trim();
  if (!s) return null;
  // /Date(1793413286500)/ 或 /Date(-1234567)/
  const m = s.match(/^\/Date\(([-+]?\d+)\)\/$/);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }
  // 已经是 ISO 或其它 new Date 可解析的形态
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}
/* 把 os 对象里的日期字段统一成毫秒数字（另附 *Ms 形式的显式字段）。 */
function normalizeDateFields(osObj) {
  const out = Object.assign({}, osObj);
  for (const k of ['LastBootUpTime', 'InstallDate']) {
    if (k in out) out[k] = parsePsDate(out[k]);
  }
  return out;
}
handle(CH.SYS.HW_INFO, async (e, force) => {
  if (!force && hwCache && Date.now() - hwCacheAt < 60000) return hwCache;
  const script = `
$ErrorActionPreference='SilentlyContinue'
$cpu = Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,LoadPercentage | ConvertTo-Json -Compress
$board = Get-CimInstance Win32_BaseBoard | Select-Object Manufacturer,Product,Version | ConvertTo-Json -Compress
$bios = Get-CimInstance Win32_BIOS | Select-Object Manufacturer,SMBIOSBIOSVersion,ReleaseDate | ConvertTo-Json -Compress
$gpu = Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM,CurrentHorizontalResolution,CurrentVerticalResolution | ConvertTo-Json -Compress
$dd = Get-CimInstance Win32_DiskDrive | Select-Object Model,Size,InterfaceType,MediaType | ConvertTo-Json -Compress
$oss = Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture,LastBootUpTime,InstallDate | ConvertTo-Json -Compress
$nic = Get-CimInstance Win32_NetworkAdapter -Filter "PhysicalAdapter=True" | Select-Object Name,MACAddress,NetEnabled | ConvertTo-Json -Compress
$battery = Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus,DesignVoltage | ConvertTo-Json -Compress
$tmp = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object InstanceName,CurrentTemperature | ConvertTo-Json -Compress
[pscustomobject]@{cpu=$cpu;board=$board;bios=$bios;gpu=$gpu;disks=$dd;os=$oss;nic=$nic;battery=$battery;temps=$tmp} | ConvertTo-Json -Depth 3 -Compress
`;
  const r = await ps(script, 30000);
  if (!r.stdout.trim()) throw new Error('硬件信息查询失败：' + (r.stderr || 'PowerShell 无输出'));
  let j;
  try { j = JSON.parse(r.stdout); } catch (err) { throw new Error('解析硬件信息失败'); }
  // PS 5.1 的 ConvertTo-Json 会把内层 JSON 作为字符串嵌入，这里二次解析
  const maybeParse = (v) => { if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return v; } } return v; };
  for (const k of Object.keys(j)) j[k] = maybeParse(j[k]);
  const norm = (x) => x == null || x === '' ? [] : (Array.isArray(x) ? x : [x]);
  // partitions
  const parts = [];
  try {
    const ld = await ps(`@(Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType,Size,FreeSpace) | ConvertTo-Json -Compress`, 15000);
    let ldArr = [];
    try { ldArr = JSON.parse(ld.stdout || '[]'); if (!Array.isArray(ldArr)) ldArr = [ldArr]; } catch (err) {}
    for (const d of ldArr) parts.push({ drive: d.DeviceID, label: d.VolumeName || '', type: d.DriveType, size: Number(d.Size) || 0, free: Number(d.FreeSpace) || 0 });
  } catch (err) {}
  const info = {
    cpu: maybeParse(j.cpu) || {},
    board: j.board || {}, bios: j.bios || {},
    gpu: norm(j.gpu), disks: norm(j.disks),
    /* 【PS 5.1 的 ConvertTo-Json 会把 DateTime 序列化成 "\/Date(1793413286500)\/"】
     * 这个字符串交给 new Date() 得到的是 Invalid Date，getTime() 是 NaN，
     * 界面那一格就恒显示 "NaN-NaN-NaN NaN:NaN:NaN"。
     * 修在**数据出口**：把这种形式解析成毫秒数字（再补一个 ISO 形态的字段，
     * 渲染层两种都能用）。只在界面层兜的话，任何新调用方都会再踩一遍。 */
    os: normalizeDateFields(j.os || {}),
    nic: norm(j.nic).filter(n => n.Name),
    battery: j.battery || null,
    temps: norm(j.temps).filter(t => t.CurrentTemperature).map(t => ({ name: t.InstanceName, celsius: Math.round((t.CurrentTemperature / 10 - 273.15) * 10) / 10 })),
    partitions: parts,
    memTotal: os.totalmem(), memFree: os.freemem(),
    host: os.hostname(), user: os.userInfo().username,
    arch: os.arch(), uptimeS: Math.floor(os.uptime())
  };
  hwCache = info; hwCacheAt = Date.now();
  return info;
});
handle(CH.SYS.POWER, async (e, action) => {
  // 关机/重启/休眠会造成数据丢失或系统状态中断，必须先在高危功能里开启；
  // 锁屏、睡眠只是待机，不丢数据，不纳入门禁。
  if (DANGEROUS_POWER_ACTIONS.includes(action) && !dangerousEnabled('system-power')) {
    throw new Error(dangerousDenied('system-power'));
  }
  switch (action) {
    case 'lock': await runCmd('rundll32.exe', ['user32.dll,LockWorkStation'], { timeout: 5000 }); return true;
    case 'sleep': await runCmd('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { timeout: 5000 }); return true;
    case 'hibernate': spawnDetached('shutdown', ['/h']); return true;
    case 'restart': spawnDetached('shutdown', ['/r', '/t', '0']); return true;
    case 'shutdown': spawnDetached('shutdown', ['/s', '/t', '0']); return true;
    default: throw new Error('未知操作');
  }
});
handle(CH.SYS.RECYCLE_EMPTY, async () => {
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
  const r = await ps(`Clear-RecycleBin -Force -ErrorAction Stop`, 20000);
  return true;
});
/* autostart via registry */
const RUN_KEYS = [
  { hive: 'HKCU', key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', label: '当前用户' },
  { hive: 'HKLM', key: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', label: '所有用户' }
];
handle(CH.AUTOSTART.LIST, async () => {
  const out = [];
  for (const rk of RUN_KEYS) {
    try {
      const r = await runCmd('reg', ['query', rk.key], { timeout: 10000, encoding: 'gbk' });
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = line.match(/^\s{4}(.+?)\s{2,}REG_(\S+)\s{4}(.*)$/);
        if (m) out.push({ hive: rk.hive, key: rk.key, label: rk.label, name: m[1], type: 'REG_' + m[2], cmd: m[3].trim() });
      }
    } catch (err) { /* HKLM may fail silently */ }
  }
  return out;
});
handle(CH.AUTOSTART.DELETE, async (e, item, permanent) => {
  if (permanent) {
    await runCmd('reg', ['delete', item.key, '/v', item.name, '/f'], { timeout: 10000 });
    return true;
  }
  // disable = backup + delete
  const bak = storeGet('autostartBackup', []);
  if (!bak.find(b => b.hive === item.hive && b.name === item.name)) { bak.push(item); storeSet('autostartBackup', bak); }
  await runCmd('reg', ['delete', item.key, '/v', item.name, '/f'], { timeout: 10000 });
  return true;
});
handle(CH.AUTOSTART.ENABLE, async (e, item) => {
  /* /t 必须带 REG_ 前缀！实测（Windows 11 + Node 24）：
       reg add ... /t REG_SZ   -> 成功
       reg add ... /t SZ       -> "无效语法" 失败
     曾有人误以为 reg 只认 SZ，建议去掉前缀 —— 那会让「恢复启用」永远失败。
     item.type 在 autostart:list 里就是按 'REG_' + m[2] 存的，这里直接用。 */
  const rawType = String(item.type || 'REG_SZ').trim().toUpperCase();
  const type = rawType.startsWith('REG_') ? rawType : 'REG_' + rawType;
  await runCmd('reg', ['add', item.key, '/v', item.name, '/t', type, '/d', item.cmd, '/f'], { timeout: 10000 });
  const bak = storeGet('autostartBackup', []).filter(b => !(b.hive === item.hive && b.name === item.name));
  storeSet('autostartBackup', bak);
  return true;
});
handle(CH.AUTOSTART.DISABLED_LIST, () => storeGet('autostartBackup', []));

/* hosts */
const HOSTS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
handle(CH.HOSTS.READ, async () => ({ content: await fsp.readFile(HOSTS_PATH, 'utf8'), path: HOSTS_PATH }));
handle(CH.HOSTS.WRITE, async (e, content) => {
  // 直接覆盖系统 hosts 有风险（写入中途失败会留下半截文件，影响全机 DNS）。
  // 先自动备份，再写临时文件后原子替换。
  const dir = path.join(app.getPath('userData'), 'hosts-backup');
  let backedUp = false;
  try {
    await fsp.mkdir(dir, { recursive: true });
    // 备份名精确到毫秒 + 随机后缀：只到秒的话，同一秒内连点两次保存会互相覆盖备份，
    // 第一次那份（可能才是正确的）就没了。
    const name = `hosts-${timeStamp.localStampDashMs(new Date())}-${crypto.randomBytes(2).toString('hex')}.bak`;
    await fsp.copyFile(HOSTS_PATH, path.join(dir, name));
    /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
    backedUp = true;
  } catch (err) {
    // 备份失败必须中止：没有退路时覆盖 hosts，一旦写入出问题用户无法恢复原文件。
    // 原实现是「备份失败不阻断」，等于拿用户的系统 hosts 赌一把。
    throw new Error('备份当前 hosts 失败，已中止写入（避免无法恢复）：' + fmtErr(err));
  }
  const tmp = HOSTS_PATH + '.hehe.tmp';
  try {
    await fsp.writeFile(tmp, content, 'utf8');
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw new Error('写入临时文件失败，原 hosts 未被改动：' + fmtErr(err));
  }
  try {
    await fsp.rename(tmp, HOSTS_PATH);
  } catch (err) {
    // Windows 上目标存在时 rename 会失败。退化为「删旧 + 改名」，
    // 关键是不要退化成直接 writeFile(HOSTS_PATH)：那是 O_TRUNC 覆盖写，
    // 中途失败会留下半截 hosts，影响全机 DNS。
    await fsp.rm(HOSTS_PATH, { force: true }).catch(() => {});
    try {
      await fsp.rename(tmp, HOSTS_PATH);
    } catch (err2) {
      // 到这里 hosts 已被删、tmp 还在。**必须先用 tmp 把 hosts 补回来，再清理 tmp** ——
      // 顺序反了（先 rm(tmp) 再 copyFile(tmp)）就等于把系统 hosts 彻底弄丢：
      // 原文件已删、唯一副本也被删，只剩 userData 里的备份，全机 DNS 直接断。
      let restored = false;
      try {
        await fsp.copyFile(tmp, HOSTS_PATH);
        restored = true;
      } catch (e3) {
        // 连复制都失败：至少别删 tmp，让用户/运维还有机会手工恢复
        throw new Error('替换 hosts 失败且无法恢复：' + fmtErr(err2) + '；临时文件已保留在 ' + tmp + '，备份在 ' + dir);
      }
      if (restored) await fsp.rm(tmp, { force: true }).catch(() => {});
      throw new Error('替换 hosts 失败：' + fmtErr(err2) + '（原 hosts 已从临时文件恢复，已保留备份）');
    }
  }
  try { await runCmd('ipconfig', ['/flushdns'], { timeout: 10000 }); } catch (err) {}
  return true;
});
handle(CH.HOSTS.BACKUP, async () => {
  const dir = path.join(app.getPath('userData'), 'hosts-backup');
  await fsp.mkdir(dir, { recursive: true });
  const name = `hosts-${timeStamp.localStampDashMs(new Date())}-${crypto.randomBytes(2).toString('hex')}.bak`;
  await fsp.copyFile(HOSTS_PATH, path.join(dir, name));
  return { name };
});
handle(CH.HOSTS.BACKUPS, async () => {
  const dir = path.join(app.getPath('userData'), 'hosts-backup');
  try { return (await fsp.readdir(dir)).map(n => path.join(dir, n)).reverse(); } catch (err) { return []; }
});
handle(CH.HOSTS.RESTORE, async (e, backupPath) => {
  // 只允许还原本机制作、且位于 hosts-backup 目录内的备份，
  // 避免误传/构造任意路径把无关文件写进系统 hosts。
  const dir = path.resolve(path.join(app.getPath('userData'), 'hosts-backup'));
  const abs = path.resolve(String(backupPath || ''));
  if (!abs.startsWith(dir + path.sep) || !/\.bak$/i.test(abs)) {
    throw new Error('备份文件无效：只能还原本机生成的 hosts 备份');
  }
  if (!(await pathExists(abs))) throw new Error('备份文件不存在：' + path.basename(abs));

  /* 还原前必须把**当前** hosts 也备份一份。
     原来直接 copyFile(备份 -> hosts)：用户选错备份时，当前的 hosts 当场被冲掉，
     而且没有任何副本可以退回 —— 等于「还原」变成了不可逆操作。
     另外用临时文件 + rename 原子替换，避免写到一半留下半截 hosts。 */
  const stamp = timeStamp.localStampDashMs(new Date()) + '-' + crypto.randomBytes(2).toString('hex');
  try {
    await fsp.copyFile(HOSTS_PATH, path.join(dir, `hosts-prerestore-${stamp}.bak`));
  } catch (err) {
    throw new Error('备份当前 hosts 失败，已中止还原（避免无法退回）：' + fmtErr(err));
  }
  const tmp = HOSTS_PATH + '.hehe.restore.tmp';
  try {
    await fsp.copyFile(abs, tmp);
    await fsp.rename(tmp, HOSTS_PATH);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    // 与 hosts:write 同理：不能退化成直接覆盖写
    try {
      await fsp.copyFile(abs, HOSTS_PATH);
    } catch (e2) {
      throw new Error('还原 hosts 失败：' + fmtErr(err) + '（当前 hosts 的备份已保存在 hosts-backup 目录）');
    }
  }
  try { await runCmd('ipconfig', ['/flushdns'], { timeout: 10000 }); } catch (err) {}
  return true;
});

/* 配色主题（accent）广播：主窗口改了配色后，标尺/贴图/截图标注这些辅助窗口
   也要跟着换主色，否则它们会一直显示旧主题的蓝色。 */
const ACCENT_IDS = ['polar', 'mist', 'jade', 'violet', 'rose', 'gold', 'teal', 'sand', 'mono'];
let currentAccent = 'polar';
function auxWindows() {
  const list = [];
  if (rulerWin && !rulerWin.isDestroyed()) list.push(rulerWin);
  for (const bw of pinWins.values()) if (bw && !bw.isDestroyed()) list.push(bw);
  if (snipWin && !snipWin.isDestroyed()) list.push(snipWin);
  return list;
}
function broadcastAccent(id) {
  for (const w of auxWindows()) {
    try { w.webContents.send('aux:accent', id); } catch (e) {}
  }
}
/* 配色要同时发给两类窗口，而且用的通道不一样 —— 这不是重复：
 *   · 辅助窗口（标尺/贴图/截图标注）是独立页面，只认 aux:accent；
 *   · 独立工具窗口跑的是 index.html 渲染层，它靠 UI_PREFS_CHANGED 一起
 *     更新语言/明暗/主色三项。
 * 早先只广播了 auxWindows()，独立工具窗因此一直停在旧主色。 */
handle(CH.APP.SET_ACCENT, (e, id) => {
  const accent = ACCENT_IDS.indexOf(id) !== -1 ? id : 'polar';
  currentAccent = accent;
  broadcastAccent(accent);
  broadcastUiPrefs();
  return accent;
});
/* app:get-accent 已移除：渲染层自己知道当前强调色（它是自己 set 的），
 * 辅助窗口通过 loadFile 的 query 参数拿到，不需要回头问主进程。 */

/* screen ruler floating window */
/* 【标尺必须能伸长/缩短】
 * 工具页的说明一直写着「拖动边缘可调整长度」，但这个窗口是
 * `resizable: false`、通道表里也只有 RULER / RULER_CLOSE / RULER_MOVE ——
 * 用户拖边缘什么都不会发生，属于**承诺了却没实现**。
 *
 * 为什么不直接把 resizable 改成 true：无边框（frame: false）窗口在
 * Windows 上没有系统边框，resizable: true 并不会给用户可抓的边缘，
 * 只是让程序自己能改尺寸。所以这里自己画把手（见 ruler-2.js），
 * 拖动时通过 RULER_RESIZE 精确设置尺寸。
 *
 * 长度下限：横向至少 160px（再短就只剩两个按钮），纵向同理；
 * 上限取当前显示器工作区，避免拉出屏幕外之后抓不回来。
 * 【下限现在可配置】设置 → 通用 → 标尺最小长度（20~800px）。
 * 每次拖拽现读，改完立刻生效（这是低频路径，现读比加缓存省心）。 */
const RULER_MIN_DEFAULT = 160;
/* 标尺的"厚度"（横向标尺的高 / 纵向标尺的宽）是固定值。
 * 见 RULER_RESIZE 的注释：让它参与回读会带来 +1px/次的累积漂移。 */
const RULER_THICK = { h: 56, v: 56 };
/* 标尺当前的几何。**由主进程独占维护**：创建/拖动/拉伸都更新它，
 * 拉伸时以它为基准而不是 getBounds()（回读会被 DPI 取整带偏）。 */
let rulerGeom = null;
let rulerWin = null;
handle(CH.WIN.RULER, (e, dir) => {
  if (rulerWin && !rulerWin.isDestroyed()) rulerWin.close();
  const horizontal = dir !== 'v';
  const w0 = horizontal ? 600 : RULER_THICK.v;
  const h0 = horizontal ? RULER_THICK.h : 600;
  rulerWin = new BrowserWindow({
    width: w0, height: h0,
    frame: false, transparent: true, alwaysOnTop: true, resizable: true,
    skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false,
      additionalArguments: ['--hehe-packaged=' + (app.isPackaged ? '1' : '0')] }
  });
  hardenWindow(rulerWin);
  /* 记录创建时的几何（位置由窗口管理器决定，用回读补齐一次 —— 之后就不再回读）。 */
  try { rulerGeom = rulerWin.getBounds(); } catch (e) { rulerGeom = { x: 0, y: 0, width: w0, height: h0 }; }
  rulerWin.setAlwaysOnTop(true, 'screen-saver');
  /* resizable: true 只是为了 setSize/setBounds 生效；用户抓不到系统边框，
   * 真正的拉伸入口是我们自己画的把手。这里显式关掉最大化/全屏，
   * 避免用户双击标题区（无边框时没有）或快捷键把它变成全屏。 */
  try { rulerWin.setMaximizable(false); } catch (e) {}
  try { rulerWin.setFullScreenable(false); } catch (e) {}
  const self = rulerWin;
  self.on('closed', () => {
    if (rulerWin === self) { rulerWin = null; rulerGeom = null; }
  });
  rulerWin.loadFile('ruler.html', { query: { dir: horizontal ? 'h' : 'v', accent: currentAccent } });
  return true;
});
handle(CH.WIN.RULER_CLOSE, () => {
  if (rulerWin && !rulerWin.isDestroyed()) rulerWin.close();
  return true;
});
handle(CH.WIN.RULER_MOVE, (e, x, y) => {
  if (!rulerWin || rulerWin.isDestroyed()) return false;
  const px = Math.round(Number(x) || 0), py = Math.round(Number(y) || 0);
  const disp = screen.getDisplayNearestPoint({ x: px + 20, y: py + 20 });
  const wa = disp.workArea;
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
  const [bw, bh] = rulerWin.getSize();
  const cx = Math.min(Math.max(px, wa.x - bw + 40), wa.x + wa.width - 40);
  const cy = Math.min(Math.max(py, wa.y), wa.y + wa.height - 40);
  rulerWin.setPosition(cx, cy);
  /* 同步几何缓存：拖动与拉伸改的是同一份状态，漏了这句下次拉伸会跳回旧位置。 */
  if (rulerGeom) { rulerGeom.x = cx; rulerGeom.y = cy; }
  return true;
});
/* 拉伸标尺。anchor 说明**哪条边是固定的**：
 *   'end'   —— 左上角不动，往右下拉长（拖右/下边缘）
 *   'start' —— 右下角不动，往左上拉长（拖左/上边缘）
 * 两个方向都要支持，否则用户拖左边会看到整个窗口跟着跑。
 *
 * 【几何必须用「我们上次设进去的值」，不能用 getBounds() 回读】
 * 真机实测（dpr=1.875）踩到的两个漂移：
 *   · 厚度每拉一次 +1px：58 → 59 → 60 → 61。因为 getBounds() 往返一次
 *     会被 DPI 取整，回读值比设进去的大一点，再设回去又大一点，逐次累积。
 *   · start 锚点每拉一次偏 2px：右边缘 1285 → 1283。同上，
 *     cur.x + cur.width 不等于真实右边缘，于是 next.x 一步步跑偏。
 * 只要窗口尺寸只由主进程改，缓存就是精确的 —— 回读只会引入误差。
 * setPosition（拖动）也同步更新缓存，两者是同一份几何。 */
handle(CH.WIN.RULER_RESIZE, (e, w, h, anchor) => {
  if (!rulerWin || rulerWin.isDestroyed()) return false;
  const cur = rulerGeom || rulerWin.getBounds();
  const horizontal = cur.width >= cur.height;
  const disp = screen.getDisplayNearestPoint({ x: cur.x + 20, y: cur.y + 20 });
  const wa = disp.workArea;
  const maxLen = horizontal ? wa.width : wa.height;

  /* 厚度取**创建时定下的常量**，不参与计算，也不回读 —— 它是固定值，
   * 一旦让它跟着当前几何走，就会变成上面那个 +1px 的累积漂移。 */
  const thick = horizontal ? RULER_THICK.h : RULER_THICK.v;
  /* 【长度取哪个参数必须跟着方向走】
   * 横向标尺的长度是 width，纵向标尺的长度是 height。
   * 写错会取到"厚度"那一维（57），于是永远被下限夹到 160 —— 真机实测：
   * 纵向请求 800 却得到 161，表现就是"纵向标尺完全拉不动"。 */
  let len = Math.round(horizontal
    ? (Number(w) || cur.width)
    : (Number(h) || cur.height));
  /* 下限可配置：取不到时用规格默认值 160，保证极端时序下不会变成 NaN 夹出怪尺寸。 */
  const minLenRaw = prefsGet('rulerMinLen');
  const minLen = (typeof minLenRaw === 'number' && minLenRaw > 0) ? minLenRaw : RULER_MIN_DEFAULT;
  len = Math.min(Math.max(len, minLen), maxLen);

  const next = horizontal
    ? { x: cur.x, y: cur.y, width: len, height: thick }
    : { x: cur.x, y: cur.y, width: thick, height: len };
  if (anchor === 'start') {
    if (horizontal) next.x = cur.x + cur.width - len;
    else next.y = cur.y + cur.height - len;
  }
  rulerGeom = next;
  rulerWin.setBounds(next);
  return true;
});

/* screen */
handle(CH.SCREEN.CURSOR, () => {
  const pt = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt);
  return { x: pt.x, y: pt.y, display: { bounds: d.bounds, scaleFactor: d.scaleFactor } };
});
handle(CH.SCREEN.CAPTURE, async () => {
  const pt = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(pt);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }
  });
  let src = sources.find(s => s.display_id === String(display.id)) || sources[0];
  if (!src) throw new Error('屏幕捕获失败');
  return {
    dataUrl: src.thumbnail.toDataURL(),
    display: { bounds: display.bounds, scaleFactor: display.scaleFactor, size: display.size },
    cursor: { x: pt.x, y: pt.y }
  };
});

/* clipboard */
handle(CH.CLIP.WRITE_TEXT, (e, text) => { clipboard.writeText(text); return true; });
handle(CH.CLIP.READ_TEXT, () => clipboard.readText());
handle(CH.CLIP.WRITE_IMAGE, (e, dataUrl) => { clipboard.writeImage(nativeImage.createFromDataURL(dataUrl)); return true; });
handle(CH.CLIP.READ_IMAGE, () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  return img.toDataURL();
});

/* lunar */
handle(CH.LUNAR.S2L, (e, y, m, d) => solarlunar.solar2lunar(y, m, d));
/* 【整月一次返回】日历页要点一次翻月就渲染 28~31 格，原来逐日 await
 * 31 次串行 IPC。农历换算是纯计算，一次算完整月没有任何额外代价，
 * 却把 31 次往返压成 1 次。
 * 返回数组下标记为「日 - 1」（第 1 天在 [0]），空位由调用方按星期补。
 * 单日算失败时该位置为 null 而不是整体抛错 —— 一个月里某天出问题
 * 不该让整张日历变空白。 */
handle(CH.LUNAR.MONTH, (e, y, m) => {
  const yy = Number(y), mm = Number(m);
  if (!Number.isInteger(yy) || !Number.isInteger(mm) || mm < 1 || mm > 12) {
    throw new Error('月份参数不合法');
  }
  /* 该月有多少天：下个月第 0 天 = 本月最后一天 */
  const days = new Date(yy, mm, 0).getDate();
  const out = [];
  for (let d = 1; d <= days; d++) {
    try { out.push(solarlunar.solar2lunar(yy, mm, d)); } catch (err) { out.push(null); }
  }
  return { year: yy, month: mm, days, items: out };
});
handle(CH.LUNAR.L2S, (e, y, m, d, leap) => solarlunar.lunar2solar(y, m, d, !!leap));

/* qrcode (main side, lib is CJS) */
handle(CH.QR.GENERATE, async (e, text, opts = {}) => {
  const QRCode = require('qrcode');
  const buf = await QRCode.toBuffer(text, {
    type: 'png', width: opts.size || 320, margin: opts.margin != null ? opts.margin : 2,
    errorCorrectionLevel: opts.level || 'M',
    color: { dark: opts.dark || '#1D2129', light: opts.light || '#FFFFFF' }
  });
  return { b64: buf.toString('base64') };
});
/* qr:save 已移除：全项目无调用方，前端早已改用 fs:write-file-b64 自己落盘。
 * 这条通道曾经是「参数直接来自渲染层、却没有覆盖保护」的任意路径写文件入口，
 * 后来又补了闸门；但既无人调用，最干净的做法是删掉，
 * 少一个入口就少一处将来被人重新接上去的风险。 */

/* ================= IPC: ffmpeg 环境与音视频处理 + 屏幕录制 =================
 * ffmpeg:* / target:* / rec:* 三个域的实现都在 ipc/media-ffmpeg.js（任务 6）。
 * 本文件只保留下面这一次 register(ctx, deps) 调用。
 *
 * 【为什么传 deps 而不是让模块自己 require】
 * handle 带着统一的高危门禁与结构化错误包装（CAP_GATED_CHANNELS 在下面的
 * 包装层里执行）。搬出去后必须仍走同一个包装，否则渲染层直接 invoke 就能
 * 绕过门禁 —— 那是这个项目最不能破的一条。runCmd 的「非零不抛」语义、
 * pathExists 的容错分支同理，都不能复制第二份。
 * 模块里的 ++jobSeq 改成 ctx.nextJobSeq()、latestCancelable = X 改成
 * deps.setLatestCancelable(X)、app.getPath(...) 改成 deps.tempDir()/userDataDir()，
 * 三者都委托回本文件的同一个值，语义不变。
 */

const mediaIpc = require('./ipc/media-ffmpeg')(ipcCtx, {
  handle,
  /* 【send 必须传 ALS 版（本文件的 send），不能让它用 ctx.send】
   * ctx.send 只发主窗口；本文件的 send() 是三档路由。这一项漏了，
   * 独立工具窗口里的进度事件就全跑到主窗去（详见 ipc/media-ffmpeg.js 的说明）。 */
  send,
  runCmd,
  pathExists,
  shortErr,
  fmtErr,
  storeGet,
  storeSet,
  moveFile,
  uniqueTarget,
  /* latestCancelable 在本文件里是「只写不读」的（见它的声明处注释：
   * 各长任务仍在装它，将来若要加「一键取消全部」才读）。模块里原来是
   * 直接赋值，搬出去后改成回调，写回的是同一个变量 —— 语义不变。 */
  setLatestCancelable: (fn) => { latestCancelable = fn; },
  /* app.getPath 只能在主进程取；这两个取值与搬走前的调用完全等价。 */
  tempDir: () => app.getPath('temp'),
  userDataDir: () => app.getPath('userData'),
  pathGuard,
  tempNames,
  targetSize,
  AdmZip,
  /* downloadToFile 是通用下载器，net:download 也在用它，所以留在本文件、
   * 由这里注入（它不属于媒体域）。 */
  downloadToFile,
});
/* mediaIpc 目前不需要导出任何东西给 main.js —— 它只注册通道。
 * 用 void 表达式标明"这里确实不用它"，比留个未使用变量干净。 */
void mediaIpc;

/* ================= IPC: Office 文档转换（LibreOffice / Office COM 双引擎） ================= */
function findSoffice() {
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LibreOffice', 'program', 'soffice.exe')
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (err) {} }
  try {
    const r = spawnSync('where', ['soffice'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    const p = (r.stdout || '').split(/\r?\n/).find(l => l.trim().toLowerCase().endsWith('soffice.exe'));
    if (p) return p.trim();
  } catch (err) {}
  return null;
}
handle(CH.OFFICE.STATUS, async () => {
  const soffice = findSoffice();
  /* 【必须用 throwOnNonZero，否则恒为 true】
   * 原写法靠 PowerShell 里 `catch{exit 1}` 表达「没装 Office」，但 runCmd 默认
   * 对非零退出码**不抛异常**（只要进程有输出），于是 try 永远成功、office 恒 true ——
   * 没装 Office 的机器上「Office 可用」是错的，用户随后选 COM 引擎转换全失败。
   * 这里打开 throwOnNonZero，让退出码真正变成异常。 */
  let office = false;
  try {
    await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'try{$w=New-Object -ComObject Word.Application;$w.Quit();exit 0}catch{exit 1}'],
    { timeout: 20000, throwOnNonZero: true });
    office = true;
  } catch (err) { office = false; }
  return { soffice, office };
});
handle(CH.OFFICE.CONVERT, async (e, { files, target, outDir }) => {
  const soffice = findSoffice();
  const results = [];
  await fsp.mkdir(outDir, { recursive: true });
  if (soffice) {
    for (const f of files) {
      // soffice 的输出名由它自己按「源基名.目标扩展名」决定，无法直接指定文件名。
      // 如果直接 --outdir 到用户选的目录，而同名文件已存在，就会静默覆盖
      // （「输出目录留空=源文件目录」时尤其常见：合同.docx 转 pdf 会盖掉已有的合同.pdf）。
      // 做法：先转到任务专属临时目录，再用 uniqueTarget 挪到目标目录。
      const stage = tempNames.uniqTmpDir({ tempDir: app.getPath('temp') });
      try {
        await fsp.mkdir(stage, { recursive: true });
        /* 保留退出码：soffice 转换失败时退出码非零，而 runCmd 默认不抛 */
        const conv = await runCmd(soffice, ['--headless', '--norestore', '--convert-to', target, '--outdir', stage, f], { timeout: 180000 });
        /* 【不要按「源基名.扩展名」猜产出文件名】
         * soffice 的输出名由它自己决定，实测有几种对不上的情况：
         *   · 源名含多个点（合同.v2.docx）—— 我们猜「合同.v2.docx → 合同.v2.pdf」，
         *     多数版本确实如此，但带宏/模板的文档可能改成别的；
         *   · target 大小写、以及 `.docx` → `.docx` 这类同格式转换；
         *   · soffice 已在跑（--headless 会复用同一 user profile）时可能直接返回、
         *     把文件写到**别的** outdir 或干脆没产出。
         * 猜错时 pathExists(produced) 恒 false → 每个文件都报「转换未产出文件」，
         * 而真正转好的文件就躺在 stage 里，被 finally 的 rm(stage) 删掉。
         * 改成：先按预期名找；找不到就在 stage 里找唯一的产出文件（排除源文件本身）。 */
        let produced = path.join(stage, path.basename(f).replace(/\.[^.]+$/, '') + '.' + target);
        if (!(await pathExists(produced))) {
          let cands = [];
          try {
            const names = await fsp.readdir(stage);
            const srcName = path.basename(f).toLowerCase();
            cands = names
              .filter((n) => n.toLowerCase() !== srcName)              // 排除被复制进来的源文件
              .map((n) => path.join(stage, n));
          } catch (e) { cands = []; }
          if (cands.length === 1) produced = cands[0];
          else if (cands.length > 1) {
            // 多个产出：优先挑与 target 扩展名相同的
            const hit = cands.find((c) => path.extname(c).toLowerCase() === '.' + String(target).toLowerCase());
            if (hit) produced = hit;
          }
        }
        if (!(await pathExists(produced))) {
          const tail = (conv.stderr || conv.stdout || '').split(/\r?\n/).filter((l) => l.trim()).slice(-2).join(' ');
          results.push({
            input: f, out: null, ok: false,
            err: '转换未产出文件' + (conv.code ? '（soffice 退出码 ' + conv.code + '）' : '') +
              (tail ? '：' + tail : '（格式可能不支持）'),
          });
          continue;
        }
        const out = await uniqueTarget(outDir, path.basename(produced));
        await fsp.mkdir(path.dirname(out), { recursive: true });
        /* 跨盘同样不能裸 rename（stage 在 %TEMP%，outDir 可能在别的盘） */
        await moveFile(produced, out);
        results.push({ input: f, out, ok: true, err: '' });
      } catch (err) {
        results.push({ input: f, out: null, ok: false, err: fmtErr(err) });
      } finally {
        await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
      }
    }
    return { engine: 'LibreOffice', results };
  }
  // Office COM 引擎
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const isInPdf = ext === '.pdf';
    const isMsDoc = ['.doc', '.docx', '.rtf', '.txt'].includes(ext);
    const isMsXls = ['.xls', '.xlsx', '.csv'].includes(ext);
    const isMsPpt = ['.ppt', '.pptx'].includes(ext);
    const base = path.basename(f).replace(/\.[^.]+$/, '');
    // 输出名必须唯一：输出目录常常就是源文件目录（「留空=源文件目录」），
    // 而 docx/pdf/rtf/txt 同基名共存很常见。直接写 base+target 会把
    // 已有的同名异扩展文件静默覆盖（例：把合同.pdf 转 docx，覆盖掉原来的合同.docx）。
    let out;
    try { out = await uniqueTarget(outDir, base + '.' + target); }
    catch (e) { results.push({ input: f, out: null, ok: false, err: '输出路径非法：' + fmtErr(e) }); continue; }
    try {
      let script = '';
      const inP = f.replace(/'/g, "''"), outP = out.replace(/'/g, "''");
      if (isInPdf && target === 'docx') {
        script = `$w=New-Object -ComObject Word.Application;$w.Visible=$false;$w.DisplayAlerts=0;try{$d=$w.Documents.Open('${inP}',$false,$true);$d.SaveAs2('${outP}',16);$d.Close($false);[Console]::WriteLine('OK')}finally{$w.Quit()}`;
      } else if (isMsDoc && target === 'pdf') {
        script = `$w=New-Object -ComObject Word.Application;$w.Visible=$false;$w.DisplayAlerts=0;try{$d=$w.Documents.Open('${inP}',$false,$true);$d.SaveAs2('${outP}',17);$d.Close($false);[Console]::WriteLine('OK')}finally{$w.Quit()}`;
      } else if (isMsXls && target === 'pdf') {
        script = `$e=New-Object -ComObject Excel.Application;$e.Visible=$false;$e.DisplayAlerts=$false;try{$b=$e.Workbooks.Open('${inP}',0,$true);$b.ExportAsFixedFormat(0,'${outP}');$b.Close($false);[Console]::WriteLine('OK')}finally{$e.Quit()}`;
      } else if (isMsPpt && target === 'pdf') {
        script = `$p=New-Object -ComObject PowerPoint.Application;try{$pres=$p.Presentations.Open('${inP}',$true,$false,$false);$pres.SaveAs('${outP}',32);$pres.Close();[Console]::WriteLine('OK')}finally{$p.Quit()}`;
      } else {
        results.push({ input: f, out: null, ok: false, err: `COM 引擎不支持 ${ext} → ${target}（安装 LibreOffice 可支持更多格式）` });
        continue;
      }
      const r = await ps(script, 180000);
      const ok = await pathExists(out);
      results.push({ input: f, out: ok ? out : null, ok, err: ok ? '' : (r.stdout + r.stderr).slice(-200) || '转换失败（文件可能受密码保护）' });
    } catch (err) {
      results.push({ input: f, out: null, ok: false, err: (err.message || '').includes('Cannot create') || /0x80040154/.test(err.message) ? '未检测到 Microsoft Office，请安装 Office 或 LibreOffice' : fmtErr(err) });
    }
  }
  return { engine: 'Office COM', results };
});

/* ================= IPC: 右键菜单管理 ================= */
const CTX_ROOTS = [
  ['HKCR\\*\\shell', '文件 · 自定义菜单'],
  ['HKCR\\*\\shellex\\ContextMenuHandlers', '文件 · 扩展处理器'],
  ['HKCR\\Directory\\shell', '文件夹 · 自定义菜单'],
  ['HKCR\\Directory\\shellex\\ContextMenuHandlers', '文件夹 · 扩展处理器'],
  ['HKCR\\Folder\\shell', '所有对象 · 自定义菜单'],
  ['HKCR\\AllFilesystemObjects\\shellex\\ContextMenuHandlers', '全部对象 · 扩展处理器']
];
handle(CH.CTXMENU.LIST, async () => {
  const groups = [];
  for (const [key, label] of CTX_ROOTS) {
    const items = [];
    try {
      const r = await runCmd('reg', ['query', key, '/s'], { timeout: 20000, encoding: 'gbk' });
      let cur = null, inCommandKey = false; // 进入 Xxx\command 子键后，默认值归属 cur.command 而非 display
      for (const raw of r.stdout.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        if (/^HKEY_CLASSES_ROOT/i.test(line)) {
          // reg 输出使用全称 HKEY_CLASSES_ROOT\...，而 CTX_ROOTS 里是 HKCR 短名；按全称前缀截取
          const rootFull = key.replace(/^HKCR/i, 'HKEY_CLASSES_ROOT');
          const sub = line.slice(rootFull.length).replace(/^\\/, '');
          if (sub && !sub.includes('\\')) {
            cur = { key, keyPath: line, name: sub, display: '', command: '', disabled: false, hasCommand: false };
            items.push(cur);
            inCommandKey = false;
          } else if (cur && sub === cur.name + '\\command') { cur.hasCommand = true; inCommandKey = true; }
          else inCommandKey = false;
          continue;
        }
        const m = line.match(/^\s{4}(.+?)\s{2,4}REG_(\S+)\s*(.*)$/);
        if (!m || !cur) continue;
        const vn = m[1].replace(/^\(默认\)$|^\(Default\)$/i, '');
        const vd = m[3].trim();
        if (vn === '' && inCommandKey) cur.command = vd;
        else if (vn === '') cur.display = vd;
        else if (vn === 'LegacyDisable') cur.disabled = true;
        else if (vn === 'Command' && !cur.command) cur.command = vd;
      }
    } catch (err) { /* 键不存在或无权限读取 */ }
    groups.push({ key, label, items });
  }
  return groups;
});
handle(CH.CTXMENU.TOGGLE, async (e, item, disable) => {
  // keyPath 是「从 reg query 输出里正则解析出来的字符串」，再拼进 reg add/delete。
  // 必须限制在 CTX_ROOTS 这些允许的根之下，否则解析出畸形路径就能写任意注册表位置。
  const FULL_ROOTS = CTX_ROOTS.map(([k]) => k.replace(/^HKCR/i, 'HKEY_CLASSES_ROOT'));
  const kp = String((item && item.keyPath) || '');
  const upper = kp.toUpperCase();
  const allowed = FULL_ROOTS.some(root => upper === root.toUpperCase() || upper.startsWith(root.toUpperCase() + '\\'));
  if (!allowed) throw new Error('非法的注册表路径，已拒绝：' + kp);
  // 只允许两级以内的子项（根\项名 或 根\项名\command），防止深层改写
  const root = FULL_ROOTS.find(r => upper === r.toUpperCase() || upper.startsWith(r.toUpperCase() + '\\'));
  const depth = kp.slice(root.length).split('\\').filter(Boolean).length;
  if (depth > 2) throw new Error('注册表路径层级过深，已拒绝：' + kp);
  if (disable) {
    await runCmd('reg', ['add', kp, '/v', 'LegacyDisable', '/t', 'REG_SZ', '/d', '', '/f'], { timeout: 10000 });
  } else {
    await runCmd('reg', ['delete', kp, '/v', 'LegacyDisable', '/f'], { timeout: 10000 });
  }
  return true;
});

/* ================= IPC: 电池健康度 ================= */
handle(CH.SYS.BATTERY_DETAIL, async () => {
  try {
    const design = await ps(`@(Get-CimInstance -Namespace root\\wmi -ClassName BatteryStaticData | Select-Object DesignedCapacity) | ConvertTo-Json -Compress`, 15000);
    const full = await ps(`@(Get-CimInstance -Namespace root\\wmi -ClassName BatteryFullChargedCapacity | Select-Object FullChargedCapacity) | ConvertTo-Json -Compress`, 15000);
    const d = design.stdout.trim() ? JSON.parse(design.stdout) : null;
    const f = full.stdout.trim() ? JSON.parse(full.stdout) : null;
    const designCap = Array.isArray(d) ? d[0]?.DesignedCapacity : d?.DesignedCapacity;
    const fullCap = Array.isArray(f) ? f[0]?.FullChargedCapacity : f?.FullChargedCapacity;
    if (!designCap || !fullCap) return null;
    return { designCap, fullCap, health: Math.round(fullCap / designCap * 1000) / 10 };
  } catch (err) { return null; }
});

/* ================= IPC: 全局文件搜索（NTFS USN 索引 / es.exe / 快速扫描） ================= */
const searchIndexes = new Map(); // 'C:' -> { map: Map(frn -> [parentFrn, name, isDir]), builtAt, count }
function searchResolvePath(drive, frn) {
  const idx = searchIndexes.get(drive);
  if (!idx || frn === 5) return drive + '\\';
  const parts = [];
  let cur = frn, guard = 0;
  while (cur !== 5 && guard++ < 256) {
    const rec = idx.map.get(cur);
    if (!rec) { parts.push('(已删除)'); break; }
    parts.push(rec[1]);
    cur = rec[0];
  }
  parts.reverse();
  return drive + '\\' + parts.join('\\');
}
function findEsExe() {
  const esDirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']];
  for (const d of esDirs) {
    if (!d) continue;
    const c = path.join(d, 'Everything', 'es.exe');
    try { if (fs.existsSync(c)) return c; } catch (err) {}
  }
  return null;
}
async function findEsExeAsync() {
  let p = findEsExe();
  if (p) return p;
  try {
    const r = await runCmd('where', ['es'], { timeout: 5000 });
    const hit = (r.stdout || '').split(/\r?\n/).find(l => l.trim().toLowerCase().endsWith('es.exe'));
    if (hit) p = hit.trim();
  } catch (e) {}
  return p;
}
handle(CH.SEARCH.ENV, async () => {
  const admin = await (async () => { try { return (await runCmd('net', ['session'], { timeout: 6000 })).code === 0; } catch (e) { return false; } })();
  const es = await findEsExeAsync();
  const volumes = [];
  try {
    const r = await ps(`@(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3") | Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress`, 15000);
    let arr = JSON.parse(r.stdout || '[]');
    if (!Array.isArray(arr)) arr = [arr];
    for (const d of arr) volumes.push({ drive: d.DeviceID, label: d.VolumeName || '', size: Number(d.Size) || 0, free: Number(d.FreeSpace) || 0 });
  } catch (err) {}
  return { admin, es, volumes };
});
handle(CH.SEARCH.INDEX_STATUS, () => {
  const out = {};
  for (const [drive, idx] of searchIndexes) out[drive] = { count: idx.count, builtAt: idx.builtAt };
  return out;
});
handle(CH.SEARCH.FREE, () => { searchIndexes.clear(); return true; });
handle(CH.SEARCH.BUILD, async (e, driveLetter) => {
  const drive = String(driveLetter || '').toUpperCase();
  if (!/^[A-Z]:$/.test(drive)) throw new Error('无效的盘符');
  const id = 'usn' + (++jobSeq);
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ` +
    `$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace HeheUsn {
  public class Enumerator {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(IntPtr hDevice, uint dwIoControlCode, IntPtr lpInBuffer, uint nInBufferSize, IntPtr lpOutBuffer, uint nOutBufferSize, out uint lpBytesReturned, IntPtr lpOverlapped);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr hObject);
    public static void Run(string driveRoot) {
      IntPtr h = CreateFileW("\\\\\\\\.\\\\" + driveRoot, 0x80000000u, 3u, IntPtr.Zero, 3u, 0x02000000u, IntPtr.Zero);
      if (h == (IntPtr)(-1)) { Console.Out.WriteLine("E\\t" + Marshal.GetLastWin32Error()); return; }
      byte[] inData = new byte[24]; // MFT_ENUM_DATA_V0：StartFileNumber(8) + LowUsn(8) + HighUsn(8)
      inData[16] = 0xFF; inData[17] = 0xFF; inData[18] = 0xFF; inData[19] = 0xFF;
      inData[20] = 0xFF; inData[21] = 0xFF; inData[22] = 0xFF; inData[23] = 0xFF; // HighUsn = MAXIMUM
      GCHandle pin = GCHandle.Alloc(inData, GCHandleType.Pinned);
      byte[] outBuf = new byte[0x10000];
      GCHandle pout = GCHandle.Alloc(outBuf, GCHandleType.Pinned);
      long count = 0; int lastP = 0;
      try {
        while (true) {
          uint ret;
          bool ok = DeviceIoControl(h, 0x900B3u, pin.AddrOfPinnedObject(), 24u, pout.AddrOfPinnedObject(), (uint)outBuf.Length, out ret, IntPtr.Zero);
          if (!ok) { int err = Marshal.GetLastWin32Error(); if (err == 38 || err == 0) break; Console.Out.WriteLine("E\\t" + err); break; }
          if (ret == 0) break;
          if (ret > 8) {
            int off = 8; // 输出前 8 字节是下一次查询的起始 USN
            while (off + 60 <= ret) {
              uint recLen = BitConverter.ToUInt32(outBuf, off);
              if (recLen < 60 || off + (int)recLen > ret) break;
              long frn = BitConverter.ToInt64(outBuf, off + 8);
              long parent = BitConverter.ToInt64(outBuf, off + 16);
              // USN_RECORD_V2（winioctl.h）：RecLen+0 Major+4 Minor+6 FRN+8 ParentFRN+16 Usn+24
              // TimeStamp+32 Reason+40 SourceInfo+44 SecurityId+48 FileAttributes+52 FileNameLength+56 FileNameOffset+58 FileName+60
              uint attr = BitConverter.ToUInt32(outBuf, off + 52);
              int nameLen = BitConverter.ToUInt16(outBuf, off + 56);
              int nameOff = BitConverter.ToUInt16(outBuf, off + 58);
              if (nameLen > 0 && off + nameOff + nameLen <= off + (int)recLen) {
                string name = Encoding.Unicode.GetString(outBuf, off + nameOff, nameLen).TrimEnd('\\0');
                Console.Out.Write("F\\t" + frn + "\\t" + parent + "\\t" + attr + "\\t");
                Console.Out.WriteLine(name);
                count++;
              }
              off += (int)recLen;
            }
          }
          Buffer.BlockCopy(outBuf, 0, inData, 0, 8);
          int pct = (int)(count / 100000);
          if (pct > lastP) { lastP = pct; Console.Out.WriteLine("P\\t" + count); }
        }
        Console.Out.WriteLine("D\\t" + count);
      } finally { pin.Free(); pout.Free(); CloseHandle(h); }
    }
  }
}
'@
Add-Type -TypeDefinition $src
[HeheUsn.Enumerator]::Run('${drive}')`], { windowsHide: true });
  /* 【在 spawn 的同一个同步块里就挂上 error 监听】
   * 下面 Promise 里的 proc.on(error, reject) 才是真正的处理逻辑，
   * 但它隔了 jobs.set / 索引结构初始化等几行。目前这段是纯同步的，
   * 所以错误一定发生在监听挂上之后 —— 可这只是当前版面的巧合。
   * 先把时间窗填掉，避免将来插入一个 await 就把 uncaughtException 放回来。 */
  proc.on('error', () => {});
  const kill = () => { try { spawnDetached('taskkill', ['/pid', String(proc.pid), '/t', '/f']); } catch (err) {} };
  jobs.set(id, { cancel: kill });
  latestCancelable = kill;
  const map = new Map();
  let count = 0, errMsg = null, lastEmit = 0;
  try {
  await new Promise((resolve, reject) => {
    let out = '', errOut = '';
    const handleLine = (line) => {
      if (!line) return;
      const tag = line[0];
      if (tag === 'F') {
        const i1 = line.indexOf('\t', 2), i2 = line.indexOf('\t', i1 + 1), i3 = line.indexOf('\t', i2 + 1);
        if (i1 < 0 || i2 < 0 || i3 < 0) return;
        const frn = Number(line.slice(2, i1)), parent = Number(line.slice(i1 + 1, i2));
        const attr = Number(line.slice(i2 + 1, i3)), name = line.slice(i3 + 1);
        if (name && name !== '.' && name !== '..' && Number.isFinite(frn)) { map.set(frn, [parent, name, !!(attr & 0x10)]); count++; }
      } else if (tag === 'P') {
        const now = Date.now();
        if (now - lastEmit > 300) { lastEmit = now; send('job:stream', { id, data: JSON.stringify({ buildCount: Number(line.slice(2)) || 0 }) }); }
      } else if (tag === 'E') { errMsg = Number(line.slice(2)); }
    };
    const stdoutDec = new TextDecoder('utf-8'); // stream:true 语义由 decode 第二参提供，跨 64KB 块的多字节中文文件名不被截断
    proc.stdout.on('data', (d) => {
      out += stdoutDec.decode(d, { stream: true });
      let i;
      while ((i = out.indexOf('\n')) >= 0) { const line = out.slice(0, i).replace(/\r$/, ''); out = out.slice(i + 1); handleLine(line); }
    });
    proc.stderr.on('data', (d) => { errOut += d.toString('utf8'); if (errOut.length > 8000) errOut = errOut.slice(-4000); });
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
      out += stdoutDec.decode();
      if (out.trim()) { for (const l of out.split(/\r?\n/)) if (l.trim()) handleLine(l.trim()); }
      if (errMsg === 5) return reject(new Error('需要管理员权限：读取 NTFS 索引（USN）要求以管理员身份运行核核工具箱'));
      if (errMsg != null) return reject(new Error('NTFS 索引失败（Win32 错误 ' + errMsg + '），该分区可能不是 NTFS 格式'));
      if (code !== 0) return reject(new Error('索引进程退出码 ' + code + (errOut ? '：' + errOut.split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' ') : '')));
      if (!count) return reject(new Error('未读取到任何文件记录（分区可能不是 NTFS）'));
      resolve();
    });
  });
  searchIndexes.set(drive, { map, count, builtAt: Date.now() });
  return { drive, count };
  } finally { jobs.delete(id); }
});
handle(CH.SEARCH.QUERY, async (e, { q, drive, limit, stat }) => {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return { rows: [], total: 0, ms: 0 };
  const t0 = Date.now();
  const cap = Math.min(2000, limit || 300);
  const rows = [];
  const scanIdx = (driveLetter, idx) => {
    for (const [frn, rec] of idx.map) {
      if (rec[1].toLowerCase().includes(query)) {
        rows.push({ frn, drive: driveLetter, name: rec[1], dir: rec[2] });
        if (rows.length >= cap) return true;
      }
    }
    return false;
  };
  if (drive && searchIndexes.has(drive)) scanIdx(drive, searchIndexes.get(drive));
  else for (const [driveLetter, idx] of searchIndexes) { if (scanIdx(driveLetter, idx)) break; }
  for (const r of rows) { r.path = searchResolvePath(r.drive, r.frn); delete r.frn; }
  if (stat) {
    await Promise.all(rows.slice(0, 400).map(async (r) => {
      if (r.dir) return;
      try { const st = await fsp.stat(r.path); r.size = st.size; r.mtime = st.mtimeMs; } catch (err) {}
    }));
  }
  return { rows, total: rows.length, ms: Date.now() - t0 };
});
handle(CH.SEARCH.ES, async (e, { q, limit }) => {
  const es = await findEsExeAsync();
  if (!es) throw new Error('未找到 es.exe（Everything 命令行工具），请安装 Everything 后重试');
  const query = String(q || '').trim();
  if (!query) return { rows: [], total: 0, ms: 0 };
  const t0 = Date.now();
  const r = await runCmd(es, ['-n', String(Math.min(2000, limit || 300)), query], { timeout: 15000, encoding: 'utf8' });
  const rows = [];
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const p = line.trim();
    if (!p) continue;
    rows.push({ path: p, name: path.basename(p), dir: false });
  }
  await Promise.all(rows.slice(0, 400).map(async (row) => {
    try { const st = await fsp.stat(row.path); row.dir = st.isDirectory(); if (!row.dir) { row.size = st.size; row.mtime = st.mtimeMs; } } catch (err) {}
  }));
  return { rows, total: rows.length, ms: Date.now() - t0 };
});
handle(CH.SEARCH.QUICK, (e, { root, q, limit }) => {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return { id: null };
  const id = 'qs' + (++jobSeq);
  const cancelRef = { canceled: false };
  const kill = () => { cancelRef.canceled = true; };
  jobs.set(id, { cancel: kill });
  latestCancelable = kill;
  (async () => {
    const t0 = Date.now();
    const cap = Math.min(3000, limit || 500);
    let matched = 0, scanned = 0, lastSend = 0;
    let batch = [];
    const sendBatch = () => { if (batch.length) { send('job:stream', { id, data: JSON.stringify({ rows: batch }) }); batch = []; } };
    const walk = async (dir, depth) => {
      if (cancelRef.canceled || matched >= cap || depth > 32) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { return; }
      for (const ent of entries) {
        if (cancelRef.canceled || matched >= cap) return;
        const full = dir.replace(/[\\/]+$/, '') + '\\' + ent.name;
        scanned++;
        const now = Date.now();
        if (now - lastSend > 500) { lastSend = now; send('job:stream', { id, data: JSON.stringify({ scanned }) }); }
        if (ent.name.toLowerCase().includes(query)) {
          matched++;
          batch.push({ path: full, name: ent.name, dir: ent.isDirectory() });
          if (batch.length >= 25) sendBatch();
        }
        if (ent.isDirectory() && !ent.isSymbolicLink()) await walk(full, depth + 1);
      }
    };
    try { await walk(root, 0); } catch (err) { sendBatch(); send('job:stream', { id, data: JSON.stringify({ done: true, error: err.message }) }); jobs.delete(id); return; }
    sendBatch();
    send('job:stream', { id, data: JSON.stringify({ done: true, matched, scanned, ms: Date.now() - t0, canceled: cancelRef.canceled }) });
    jobs.delete(id);
  })();
  return { id };
});

/* ================= IPC: 屏幕录制 =================
 * rec:* 与 ffmpeg:* / target:* 一起搬到了 ipc/media-ffmpeg.js（任务 6）。
 * 两者放在同一个模块里，是因为录制域直接用 ffmpeg（设备枚举、分段录制、
 * 录完转 GIF 都调 findFfmpeg / runCmd）—— 理由见该文件头部。
 */

/* ================= IPC: 文件内容搜索（流式） ================= */
handle(CH.CONTENT.SEARCH, (e, { root, q, useRegex, ci, exts, limit }) => {
  const id = 'cs' + (++jobSeq);
  const cancelRef = { canceled: false };
  const kill = () => { cancelRef.canceled = true; };
  jobs.set(id, { cancel: kill });
  latestCancelable = kill;
  (async () => {
    const t0 = Date.now();
    let re;
    try { re = useRegex ? new RegExp(q, ci ? 'i' : '') : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ci ? 'i' : ''); }
    catch (err) { send('job:stream', { id, data: JSON.stringify({ done: true, error: '正则无效：' + err.message }) }); jobs.delete(id); return; }
    const extSet = new Set(String(exts || '').split(/[,\s]+/).map(x => x.toLowerCase().replace(/^\./, '')).filter(Boolean));
    const cap = Math.min(3000, limit || 500);
    let matched = 0, scanned = 0, lastSend = 0, batch = [];
    const sendBatch = () => { if (batch.length) { send('job:stream', { id, data: JSON.stringify({ rows: batch }) }); batch = []; } };
    await walkDir(root, { _cancelRef: cancelRef }, async (item) => {
      if (cancelRef.canceled || item.type !== 'file') return;
      scanned++;
      if (extSet.size && !extSet.has(path.extname(item.path).slice(1).toLowerCase())) return;
      try {
        const st = await fsp.stat(item.path);
        if (st.size > 20 * 1024 * 1024) return;
        const buf = await fsp.readFile(item.path);
        if (buf.includes(0)) return; // 跳过二进制
        let text = buf.toString('utf8');
        if (text.includes('\uFFFD')) { try { text = new TextDecoder('gbk').decode(buf); } catch (err) {} }
        const lines = text.split(/\r?\n/);
        for (let ln = 0; ln < lines.length; ln++) {
          if (re.test(lines[ln])) {
            matched++;
            batch.push({ path: item.path, line: ln + 1, text: lines[ln].length > 300 ? lines[ln].slice(0, 300) + '…' : lines[ln] });
            if (batch.length >= 30) sendBatch();
            if (matched >= cap) break;
          }
        }
        const now = Date.now();
        if (now - lastSend > 400) { lastSend = now; sendBatch(); send('job:stream', { id, data: JSON.stringify({ scanned, matched }) }); }
      } catch (err) {}
      if (matched >= cap) cancelRef.canceled = true;
    });
    sendBatch();
    send('job:stream', { id, data: JSON.stringify({ done: true, matched, scanned, ms: Date.now() - t0 }) });
    jobs.delete(id);
  })();
  return { id };
});

/* ================= IPC: 贴图置顶窗口 ================= */
/* 【Map 键必须是**字符串**，且读写两侧都要归一】
 * 原来写的是 `pinWins.set(bw.id, bw)` —— bw.id 是数字。但窗口 URL 里传的是
 * `String(bw.id)`，渲染层用 URLSearchParams.get() 读回来必然是字符串，
 * 又原样经 IPC 发回来。于是 `get('12')` 与 `get(12)` 是两个不同的键，
 * 三个 handler 全都取不到窗口；而它们都写成 `if (bw && ...) return true`，
 * 取不到照样返回成功 —— 表现就是**拖动、滚轮缩放、双击/Esc 关闭三件事
 * 全部静默失效**，不报错、不提示。
 * （关闭"看起来能用"是假象：closePin() 里还有一句 window.close() 兜底，
 *   走的是 Electron 自己的关闭，根本没经过这三个 handler。）
 *
 * 修法双保险：登记与删除统一转 String，handler 侧再用 pinKey() 归一，
 * 将来谁传数字也不会坏。取不到窗口时返回 false 而不是假装成功，
 * 让"没生效"这件事对调用方可观测。 */
const pinKey = (id) => String(id == null ? '' : id);
const pinWins = new Map();
/** 按 id 找贴图窗口：键类型归一，已销毁的一律当作找不到。 */
function pinWinOf(id) {
  const bw = pinWins.get(pinKey(id));
  return (bw && !bw.isDestroyed()) ? bw : null;
}
async function createPinWindow(srcPath) {
  const img = nativeImage.createFromPath(srcPath);
  const size = img.getSize();
  if (!size.width) throw new Error('无法读取图片');
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const scale = Math.min(1, (wa.width * 0.5) / size.width, (wa.height * 0.7) / size.height);
  const bw = new BrowserWindow({
    width: Math.max(80, Math.round(size.width * scale)), height: Math.max(60, Math.round(size.height * scale)),
    frame: false, transparent: true, alwaysOnTop: true, resizable: false, skipTaskbar: true, hasShadow: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false,
      additionalArguments: ['--hehe-packaged=' + (app.isPackaged ? '1' : '0')] }
  });
  hardenWindow(bw);
  bw.setAlwaysOnTop(true, 'screen-saver');
  pinWins.set(pinKey(bw.id), bw);
  bw.on('closed', () => pinWins.delete(pinKey(bw.id)));
  await bw.loadFile('pin.html', { query: { id: String(bw.id), src: srcPath, accent: currentAccent } });
  return { id: bw.id, w: size.width, h: size.height };
}
/* win:pin-image 通道已移除：截图「贴图」与「贴剪贴板图片」都直接调
 * createPinWindow()，没有渲染层调用方。函数本身保留，它是这两条路径的实现。 */
handle(CH.WIN.PIN_MOVE, (e, id, x, y) => {
  const bw = pinWinOf(id);
  if (!bw) return false;   // 找不到就如实说没做到，不再假装成功
  bw.setPosition(Math.round(x), Math.round(y));
  return true;
});
handle(CH.WIN.PIN_RESIZE, (e, id, w, h) => {
  const bw = pinWinOf(id);
  if (!bw) return false;
  bw.setSize(Math.max(80, Math.round(w)), Math.max(60, Math.round(h)));
  return true;
});
handle(CH.WIN.PIN_CLOSE, (e, id) => {
  const bw = pinWinOf(id);
  if (!bw) return false;
  bw.close();
  return true;
});

/* ================= IPC: 窗口管理（置顶/透明度/置底） ================= */
const WINMGR_CS = `
using System;using System.Text;using System.Runtime.InteropServices;using System.Diagnostics;
namespace HeheWin{public class Util{
[DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
[DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x,int y,int cx,int cy,uint flags);
[DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h,int i,int v);
[DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint cr, byte alpha, uint flags);
public static void List(){ EnumWindows(delegate(IntPtr h, IntPtr l){ if(!IsWindowVisible(h)) return true; var sb=new StringBuilder(512); if(GetWindowText(h,sb,512)==0) return true; uint pid; GetWindowThreadProcessId(h,out pid); string pn=""; try{pn=Process.GetProcessById((int)pid).ProcessName;}catch{} int ex=GetWindowLong(h,-20); Console.WriteLine(h.ToInt64()+"\\t"+pid+"\\t"+(((ex&0x8)!=0)?1:0)+"\\t"+pn+"\\t"+sb.ToString().Replace("\\t"," ")); return true;}, IntPtr.Zero); }
public static string Topmost(long h, bool on){ SetWindowPos((IntPtr)h, on?new IntPtr(-1):new IntPtr(-2),0,0,0,0,0x3); return "OK"; }
public static string Bottom(long h){ SetWindowPos((IntPtr)h, new IntPtr(1),0,0,0,0,0x3); return "OK"; }
public static string Opacity(long h, int alpha){ var p=(IntPtr)h; int ex=GetWindowLong(p,-20); if(alpha>=255){ SetWindowLong(p,-20,ex & ~0x80000); } else { if((ex&0x80000)==0) SetWindowLong(p,-20,ex|0x80000); SetLayeredWindowAttributes(p,0,(byte)alpha,2);} return "OK"; }
}}
`;
async function winmgrRun(method) {
  const r = await ps('Add-Type -TypeDefinition @\'\n' + WINMGR_CS + '\n\'@\n' + method, 25000);
  return r.stdout;
}
handle(CH.WINMGR.LIST, async () => {
  const out = await winmgrRun('[HeheWin.Util]::List()');
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const p = line.split('\t');
    if (p.length >= 5 && /^\d+$/.test(p[0])) rows.push({ hwnd: p[0], pid: +p[1], topmost: p[2] === '1', proc: p[3], title: p.slice(4).join('\t') });
  }
  return rows;
});
handle(CH.WINMGR.TOPMOST, (e, hwnd, on) => winmgrRun(`[HeheWin.Util]::Topmost(${+hwnd}, ${on ? '$true' : '$false'})`));
handle(CH.WINMGR.BOTTOM, (e, hwnd) => winmgrRun(`[HeheWin.Util]::Bottom(${+hwnd})`));
handle(CH.WINMGR.OPACITY, (e, hwnd, alpha) => winmgrRun(`[HeheWin.Util]::Opacity(${+hwnd}, ${Math.max(20, Math.min(255, alpha | 0))})`));

/* ================= IPC: 文件占用解锁（Restart Manager） =================
 * 中文 Windows 上最高频的痛点之一：删不掉、提示被占用，但不知道谁占的。
 * 用系统自带的 Restart Manager（rstrtmgr.dll）查占用进程，无需 handle.exe、
 * 无需管理员权限，也不引入第三方 exe（handle.exe 常被杀软报毒）。
 *
 * 只查不杀：查询是只读操作，安全。要结束占用进程走已有的 proc:kill
 * （那条通道受 process-kill 高危门禁保护），本模块不重复提供杀进程能力。
 */

/* 【为什么必须每次重新 Add-Type】
 * ps() 每次都会启动一个**新的 powershell.exe 进程**，Add-Type 定义的
 * 类型只存在于那一个进程里，进程退出就没了。
 * 早期这里用一个进程内布尔标志做「已编译就跳过 Add-Type」的缓存，
 * 结果第二次调用必然报「找不到类型 [HeheFiles.Util]」——
 * 缓存的是「本 Node 进程编译过」，而真正需要类型的 PowerShell 进程早换了。
 *
 * 代价是每次多 0.4~1.2 秒的编译时间。这个代价值得付：
 * 想省掉它就得维持一个常驻 PowerShell runspace 或落盘一个 C# 程序集，
 * 两者都会引入生命周期管理与清理问题，为一个只读查询不值得。
 * 后人不要把它改回缓存 —— 改了就是必现的功能失效。
 */


;

/* 一次查多个文件时，也要能查「目录里所有被占用的文件」——
 * 删目录删不掉时最有用。这里只扫一层，避免大目录卡死。 */
;

/* 批量 PowerShell 查询的分块大小。
 *
 * 【为什么必须分块】把几百个路径拼成一个数组字面量一次传进去会撞上
 * Windows 命令行上限（约 32767 字符），Node 直接抛 spawn ENAMETOOLONG，
 * PowerShell 根本没启动。实测：单路径 91 字符时，500 个就超限。
 * 每块 60 个路径：即便单个路径 200 字符也只占 1.2 万字符，留足余量。
 *
 * 【位置说明】这个常量最早定义在文件靠后处，而 link:scan / linkNatures /
 * rmQueryLockers 都在它之前就用到它。虽然 handler 是启动后才调用的（那时
 * const 早已初始化），但依赖「声明顺序」的代码一旦被提到模块顶层就会 TDZ 崩，
 * 所以现在统一放在文件靠前的公共常量区（见前面 PS_PATH_BATCH 的定义）。 */

/**
 * 把错误压成一句人话。
 * Node 的 spawn 失败会把**整条命令行**塞进 message（几千字符），
 * 直接显示在界面上等于没给信息。这里保留错误码 + 前一段文字。
 *
 * @param {Error} err
 * @returns {string}
 */
function shortErr(err) {
  const code = String((err && err.code) || '').trim();
  const msg = String((err && err.message) || err || '').replace(/\s+/g, ' ').trim();
  const head = msg.length > 100 ? msg.slice(0, 100) + '…' : msg;
  return code && msg.indexOf(code) === -1 ? code + ' ' + head : head;
}

/* ================= IPC: 链接体检与清理（reparse point） =================
 * 只读为主：枚举 reparse point、逐个判定，僵尸链接可批量清理，
 * 其余类型只提示不动手。
 *
 * 【清理的硬约束】删链接必须用 links.removeLinkOnly()，
 * 它内部复核「这确实是链接本身」并拒绝任何解析后的目标路径。
 * 实测：对 realpath 结果做 recursive 删除会删光真实数据（连 junction 也没了）。
 * 所以本模块**不允许**自己写 fs.rm —— 所有删除都经那一层。
 */

/* 遍历目录树，收集所有 reparse point。不进入链接目标（避免把目标里的
 * 链接也算进来、也避免环导致的死循环）。 */

;

;

/* 把链接集合转成「相对源根的 posix 相对路径」映射，便于目标侧重建。 */

/* 判断某个路径是否落在「被排除的链接」列表里。
 * 用规范化后的相对路径做精确比较，避免前缀误伤
 * （/a/link 不应把 /a/link2 也算进去）。 */

/**
 * 复制目录树，但**跳过**给定的链接路径（不跟随、不重建）。
 *
 * 为什么不用 fs.cp：它没有 exclude 参数，且遇到 reparse point 会尝试
 * symlink() 而失败（见调用处的实测）。这里自己 walk：
 *   - 目录：mkdir + 递归
 *   - 普通文件：copyFile
 *   - 链接：完全跳过（交给 restoreLinksIntoTarget 重建）
 *
 * @param {string} srcAbs
 * @param {string} dstAbs
 * @param {string[]} linkList 源侧链接的绝对路径
 * @returns {Promise<{files:number, dirs:number, skippedDisappeared:number, disappeared:string[]}>}
 */

/**
 * 在目标侧按相对路径重建源目录树里的链接。
 *
 * 【按链接的性质重建，不能一律用 junction】
 * 目录链接用 'junction'：Windows 上创建 junction **不需要**
 * SeCreateSymbolicLinkPrivilege（这正是它能在非管理员下工作的原因）。
 * 文件链接必须用符号链接：junction 只能指向目录，把文件链接重建为 junction
 * 会得到一个打不开的坏链接，而创建本身**不报错** —— 搬家说成功、
 * 用户却发现那个链接成了死链。这类失败现在就如实报出来（走 failed 中止流程）。
 *
 * 目标解析不到（例如指向另一个盘、该盘现在不在）时：目录链接仍能建出来
 * （Windows 允许悬空 junction），文件链接则要特权、失败即上报。
 *
 * @param {string} srcAbs
 * @param {string} dstAbs
 * @param {string[]} linkList
 * @param {Map<string,string>} [natures] linkNatures 的结果（缺省时当场判定）
 * @returns {Promise<{created:number, failed:Array, fileLinks:number}>}
 */

/**
 * 链接声明的目标，绝对化。
 *
 * 【相对目标必须按链接所在目录解析】path.resolve(target) 是按**当前工作目录**
 * 解析的 —— 对一个目标写成相对路径的符号链接，算出来的位置和它真正的指向
 * 可以完全无关（进程 cwd 是什么就是什么）。这里显式用链接所在目录。
 *
 * @param {string} linkPath 链接自身路径
 * @returns {string} 绝对目标路径
 */

/**
 * 供比较用的路径归一：把 8.3 短名、subst 虚拟盘、经由符号链接父目录写出的
 * 路径都解析成同一种字面量，再比较。
 *
 * 【为什么不能直接比字符串】fs.readlinkSync 返回的是链接**声明的原始字符串**。
 * 它可能是：
 *   - 8.3 短名：C:\...\VERYLO~1\sub（实测本机 Temp 下必然出现）
 *   - subst 出来的虚拟盘：X:\sub
 *   - 经由符号链接父目录写出的路径
 * 这些写法都不是源目录字面量的「扩展」，path.relative 判不出来 ——
 * 于是「目标在源树内部」的链接被照抄，源改名后变成死链。
 * 实测：源 C:\...\VeryLongSourceDirectoryName，用短名建的 junction
 * readlink 返回 ...\VERYLO~1\sub，纯字符串比较判成 false。
 *
 * 解析失败（悬空链接、无权限）时退回 path.resolve —— 保持原来的字面比较行为，
 * 不能因为解析不了就把「悬空内链」漏判掉。
 *
 * @param {string} p
 * @returns {string} 归一后的绝对路径
 */

/**
 * 目标是否落在源目录树内部（含源目录自身）。
 * 两侧都先过 normalizeForComparePath，再交给 path.relative 判前缀关系
 * （Windows 上大小写不敏感，且不会被「同前缀」骗过：C:\a\b 与
 *  C:\a\bc 是两回事）。
 *
 * @param {string} absPath
 * @param {string} rootAbs
 * @returns {boolean}
 */

/* 收集「可以安全注册给 Restart Manager」的探测路径。
 *
 * 【为什么只收普通文件】实测二分：注册普通文件 -> 正常返回占用进程；
 * 注册目录（哪怕只是父目录）-> ERR list 5；注册 junction/符号链接 -> ERR list 5；
 * 混合注册 -> 整批 ERR 5。
 * 这类条目会让**整个查询**失败，而不是「这一项没查到」。
 * 用 readdir 的 withFileTypes 判断，不额外 stat，也不跟随链接。
 *
 * @param {string} dir 源目录
 * @returns {Promise<{files:string[], error:string|null}>}
 */

/**
 * 判断一个链接指向的是**目录还是文件**（dir / file / unknown）。
 *
 * 【为什么必须区分】重建时一律用 junction 是错的：junction 只能指向目录，
 * 把一个「文件符号链接」重建为 junction，得到的是一个打不开的坏链接，
 * 而创建本身不报错 —— 搬家显示成功、用户却发现某个链接变成了死链。
 * 判据用 statSync（跟随链接）拿到目标类型；目标不在（悬空链接）或没权限时
 * 返回 unknown，由调用方再用 PowerShell 的 Attributes 兜底（见 linkNatures）。
 *
 * @param {string} p 链接自身路径
 * @returns {'dir'|'file'|'unknown'}
 */

/**
 * 批量判定链接性质。先走 statSync 这条零成本的路，剩下的（悬空/无权限）
 * 用**一次** Get-Item 批量取 Attributes —— 即使目标不存在，
 * reparse point 自身带的 FILE_ATTRIBUTE_DIRECTORY 仍能告诉我们它是目录链接。
 *
 * @param {string[]} list 链接绝对路径
 * @returns {Promise<Map<string,string>>} 小写路径 → 'dir' | 'file'
 */

/* ================= IPC: 目录搬家（建链接替身） =================
 * 高危能力（dir-move），默认关闭。流程见 lib/dir-move.js 顶部注释。
 * 每一步都通过 job:progress 回报，界面上逐步显示而不是一个转圈。
 */
;

/* 【为什么需要一个模块级单飞标志】
 * 渲染层的 state.running 只在**当前页面实例**里有效：用户离开工具页再回来，
 * 会拿到全新的 state（running=false），于是能对同一对路径再发起一次搬家，
 * 与主进程里仍在跑的那次重叠 —— cp 与 rename 交叉，结果不可预测。
 * 所以互斥必须放在主进程。
 *
 * 不用 jobs map 的 cancel 机制：这条流程不支持中途取消（复制/改名/建链接
 * 做到一半被 cancel 会留下危险中间态），所以这里只拒绝、不取消。 */

/* 实际执行搬家。**严格按 dir-move.js 的状态机走**，每一步失败都按
 * rollbackPlan 给的 actions 回退，不许临时发挥。
 *
 * 回报方式：通过 job:stream 逐条推送进度（界面上逐步显示，而不是转圈）。
 * 任何一步失败都会：① 执行回退 ② 把「数据现在在哪」如实告诉用户。 */
;

/* 搬家的实际流程。拆成独立函数，让上面的单飞包装保持简洁：
 * 置位/复位与业务逻辑分开，避免以后有人在流程里 return 时忘了复位。 */

/* 把 .bak 改回原名；成功与否都要如实回报。 */
/* ================= IPC: 权限修复与取得所有权 =================
 * 「文件删不掉」的另一半原因（另一半是占用，见 file:who-locks）。
 *
 * 【分寸】只处理用户**显式选中的那一个**路径：
 *   - 不枚举、不全盘扫描、不批量套用（这是刻意的，见 lib/acl-repair.js 注释）；
 *   - 执行前必须把「会影响多少子项」算出来，界面上大字提示；
 *   - 递归必须是用户自己勾的，不默认递归。
 *
 * 复用 path-guard：它本来就是所有删除的必经闸门。它拒绝时，
 * 除了报「拒绝操作」，还把「可以提权修复」作为可选下一步递出去
 * （系统关键目录除外 —— 那些不该引导用户去改权限）。
 */

/* 是否以管理员身份运行。用 PowerShell 查 WindowsPrincipal，比 fs 探测可靠。
 *
 * 【返回三态：true / false / null（未知）】
 * 原实现 catch 里写死 `_isAdminCache = false`，而 _isAdminCache 是模块级变量、
 * 永不失效 —— 首次调用时 PowerShell 只要出一次瞬时问题（超时、被杀软拦、
 * 组策略覆盖了 ExecutionPolicy），这个进程余下的整个生命周期都认定
 * 「不是管理员」，于是 acl:repair 一直报「修复权限需要管理员权限」，
 * 直到用户重启应用。用户明明是管理员却被告知不是，没有任何办法自证。
 *
 * 这与本文件反复强调的原则（读不到就说读不到，不要编造）正好相反。
 * 现在：只有**真的拿到了明确的 '0'/'1'** 才缓存；查询失败返回 null 且不缓存，
 * 下次调用会重新尝试。调用方把 null 当作「未知」处理（不要当成 false 去拦人）。 */

/* 读当前所有者与 ACL 摘要。读不到就如实返回 null，不编造。
 *
 * 【为什么先取当前用户名，再解析 icacls】
 * parseIcacls 的第二个参数 userName 决定每条 ACE 的 mine 归属，而
 * hasFull 的语义是「当前用户自己有没有完全控制」（见 lib/acl-repair.js 里
 * 那段说明）。早期这里把取用户名的 ps 放在解析**之后**，解析时 userName
 * 恒为 undefined —— 于是 hasFull 恒 false，两条判据连带着全错：
 *   acl:diagnose 对权限正常的文件也报「缺少写入权限」；
 *   acl:repair 修完复核 gained 恒 false，界面永远说「复核没读到完全控制」。
 * 这是「结论必错」的 bug，所以顺序是硬的：先拿 me，再解析。 */

;

;


/* 把 .bak 改回原名；成功与否都要如实回报。 */

/* 逐文件校验：每个文件比大小；再抽样若干做 SHA-256。 */


/* 验证「链接可读」：真的从原路径读一遍文件，而不是只看链接存不存在。
 * 这一步能抓住「链接建立了但指向空/指向错地方」的情况。 */
/**
 * 抽验目标树里的链接是不是都能打开。
 *
 * 【为什么需要它】verifyLinkReadable 只看「原路径那个链接」，
 * 而搬家搬的是一整棵树，树里可能还嵌着别的链接。这些链接在复制阶段
 * 是跳过、在 restoreLinksIntoTarget 里重建的 —— 一旦重建时目标算错
 * （例如照抄了源侧的旧绝对路径，而源目录随后改名成 .hehe-bak），
 * 它们就会指向一个已经不存在的位置。此时流程其余步骤全都看不出问题：
 * verifyCopy 跳过链接、verifyLinkReadable 只看顶层，界面最后显示「搬家完成」。
 *
 * 调用时机必须是**源目录改名之后**（否则旧路径仍然有效，坏链看不出来）。
 *
 * 【只要求「源侧本来就可读」的那些】
 * 源侧本来就悬空的链接（目标盘没插、目标已被删）在搬家前就是坏的，
 * 搬家把它原样保留，不该因此判这次搬家失败。哪些链接源侧可读，
 * 由 restoreLinksIntoTarget 在重建时逐个探好并回传，这里直接用。
 *
 * @param {string} dstRoot 目标根目录（源已改名，这里只剩新位置）
 * @param {string[]} srcReadableLinks 源侧可读的链接（源侧路径，用来在目标侧定位与报错）
 * @returns {Promise<{ok:boolean, reason:string, sampled:number, checked:number}>}
 */


/* 打开文件、读前 n 个字节就关掉。返回实际读到的字节数（0 也算成功：
 * 空文件通过链接读得到 0 字节，这恰恰说明链接是通的）。 */

/* ================= IPC: 7z 压缩包（7za / 系统 7-Zip） ================= */
const sevenZa = (() => { try { return require('7zip-bin').path7za; } catch (e) { return null; } })();
// 7z 会按引号解析参数：密码里的 " 必须双写，否则整条命令被截断
// （实测密码含一个 " 时报 "Cannot find archive name"）
function sevenPwdArg(password) {
  if (!password) return '-p'; // 裸 -p 阻止交互式等待输入
  return '-p' + String(password).replace(/"/g, '""');
}
function findSevenFull() {
  for (const c of ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe']) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

/* ---------- 归档子进程沙箱 ----------
 * 借鉴 YourCatFileAssistant 的归档设计，但受引擎能力限制做了取舍：
 *
 * 1) 密码无法完全离开命令行 —— 7za/7z 只提供 `-p{Password}`，
 *    没有 `--password-file`，也不读 stdin 取密码
 *    （已用 `7za -h` 确认：只有 -p 与 -si，-si 是"从 stdin 读数据"不是读密码）。
 *    所以现实可做的三件事：
 *      · 密码只出现在英文参数位，绝不写日志、不进设置、不进临时文件内容；
 *      · 参数里做引号双写转义，避免被截断成注入；
 *      · 任务结束立即释放引用，不做任何持久化。
 * 2) 子进程加超时（runCmd 的 timeout）与取消后强杀兜底，
 *    避免 7z 卡在坏包或超大包上不退。
 * 3) 解压结果先落到任务专属子目录，全部成功后再合并到目标目录，
 *    避免"解了一半失败"留下半成品（见 seven:extract）。
 */
/* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
const ARCHIVE_JOB_LIMITS = {
  cancelGraceMs: 5000 // 取消后 5 秒仍未退出则强杀
};

/* 统一的归档调用入口：集中处理密码参数与超时，避免各处重复且不一致。 */
async function runSeven(bin, args, opts = {}) {
  const { password, timeout = 600000 } = opts;
  const realArgs = args.slice();
  // Password switches must precede `--`, which ends 7z switch parsing.
  const stopSwitches = realArgs.indexOf('--');
  realArgs.splice(stopSwitches < 0 ? realArgs.length : stopSwitches, 0, password ? sevenPwdArg(password) : '-p');
  try {
    if (opts.outputDir) {
      return await archiveProcess.extractLimited(bin, realArgs, { root: opts.outputDir, timeout });
    }
    return await runCmd(bin, realArgs, { timeout });
  } catch (err) {
    /* 密码脱敏：execFile 失败时 err.message 是**完整命令行**，
       里面有 -p<密码> 明文。这个 err 会被 handle() 包装成
       {ok:false,error} 返回渲染层，渲染层再 toast 出去 ——
       等于把用户密码弹在屏幕上（还会进日志）。
       另外进程管理器里也能看到命令行，这点无法完全消除（7za 只支持 -p 传参），
       但至少不能让它回显到 UI。 */
    const msg = String((err && err.message) || err || '');
    const clean = password
      ? msg.split(String(password)).join('***').split(sevenPwdArg(password)).join('-p***')
      : msg;
    const e = new Error(clean || '7z 操作失败');
    e.code = (err && err.code) || 'SEVEN_FAILED';
    throw e;
  }
}

/* 递归扫描一个目录，产出 archive-guard 需要的条目清单（相对名 + 是否目录 + 大小）。
 * 用于解压后复查：即使引擎自己解出来了，也可能带着穿越名/设备名。 */
async function scanDirForGuard(root, relBase = '') {
  const out = [];
  let items;
  try { items = await fsp.readdir(path.join(root, relBase), { withFileTypes: true }); } catch (e) { return out; }
  for (const it of items) {
    const rel = relBase ? relBase + '/' + it.name : it.name;
    if (it.isDirectory()) {
      out.push({ name: rel, isDir: true, size: 0 });
      out.push(...await scanDirForGuard(root, rel));
    } else if (it.isSymbolicLink()) {
      out.push({ name: rel, isFile: false, isSymlink: true });
    } else {
      let size = 0;
      try { size = (await fsp.stat(path.join(root, relBase, it.name))).size; } catch (e) {}
      out.push({ name: rel, isDir: false, size });
    }
  }
  return out;
}

/* 生成不覆盖的目标路径（定义在文件上部，此处不再重复） */

handle(CH.SEVEN.STATUS, () => ({ za: sevenZa, full: findSevenFull() }));
handle(CH.SEVEN.COMPRESS, async (e, { files, out, password, volumeMB }) => {
  const bin = findSevenFull() || sevenZa;
  if (!bin) throw new Error('未找到 7z 引擎');
  if (!/\.7z$/i.test(out)) out += '.7z';
  const args = ['a', '-y', '-bd'];
  if (password) args.push(sevenPwdArg(password), '-mhe=on');
  if (volumeMB) args.push('-v' + Math.max(1, volumeMB) + 'm');
  args.push(out, ...files);
  const r = await runCmd(bin, args, { timeout: 600000 });
  if (r.code !== 0) throw new Error('压缩失败：' + (r.stderr || r.stdout).split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' '));
  const first = volumeMB ? out + '.001' : out;
  let size = 0; try { size = (await fsp.stat(first)).size; } catch (e) {}
  return { out: first, size };
});
handle(CH.SEVEN.EXTRACT, async (e, { archive, outDir, password }) => {
  const bin = findSevenFull() || sevenZa;
  if (!bin) throw new Error('未找到 7z 引擎');
  const listing = await runSeven(bin, ['l', '-slt', '-ba', '-sccUTF-8', '--', archive], { password });
  if (listing.code !== 0) throw new Error('无法读取压缩包目录：' + (listing.stderr || listing.stdout));
  const declared = archiveGuard.inspectSevenListing(listing.stdout, (await fsp.stat(archive)).size);
  await fsp.mkdir(outDir, { recursive: true });

  /* 先解到任务专属临时目录，全部成功后再合并到 outDir。
     原实现直接 -o<outDir>：中途出错（缺卷、CRC 错、磁盘满）会在目标目录
     留下半截文件，用户无法分辨哪些是完整的。
     这样失败时只需删掉自己的临时目录，目标目录一个字节都不会被污染。

     重要：staging 必须与 outDir **同卷**。原先放在 %TEMP%（通常 C:），
     而用户常把压缩包解到 D:/E: 盘，此时 fsp.rename 会抛 EXDEV（跨设备链接不允许），
     等于「解压到非 C 盘」100% 失败。放在 outDir 下的隐藏目录即可同卷。 */
  const staging = tempNames.sevenStagingDir(outDir);
  await fsp.mkdir(staging, { recursive: true });
  const movedTo = [];   // 已搬到 outDir 的目标路径，用于失败回滚
  try {
    const args = ['x', '-y', '-bd', '-o' + staging, archive];
    const r = await runSeven(bin, args, { password, outputDir: staging });
    if (r.code !== 0) throw new Error('解压失败：' + (r.stderr || r.stdout).split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' '));

    // 预检：解出来的条目也要过一遍安全判定（防 7z 里藏的穿越/设备名条目）
    const scanned = await scanDirForGuard(staging);
    const verdict = archiveGuard.inspectEntries(scanned);
    const declaredFiles = new Map(declared.entries.filter(entry => !entry.isDir).map(entry => [entry.name.replace(/\\/g, '/'), entry.size]));
    const actualFiles = verdict.entries.filter(entry => !entry.isDir);
    if (actualFiles.length !== declaredFiles.size || actualFiles.some(entry => declaredFiles.get(entry.name) !== entry.size)) {
      throw new Error('解压后的文件清单或大小与预检不一致，已拒绝提交');
    }
    // 同 1314 行：inspectEntries 只 return ok:true 或 throw，此处为防御性死代码
    if (!verdict.ok) throw new Error('解压内容预检未通过');

    /* 目录条目与文件条目必须路由到同一个父目录：
       若目录 sub/ 因冲突改名为 sub(1)/，而文件 sub/b.txt 仍写进原来的 sub/，
       归档内容就会混进用户已有目录（zip:extract 那边踩过同样的坑）。
       所以：目录条目一律不改名（已存在就复用），只有文件冲突才编号。 */
    const dirFor = async (rel) => {
      return pathGuard.ensureDirectoryInside(outDir, rel);
    };
    let moved = 0;
    for (const ent of verdict.entries) {
      const src = archiveGuard.resolveTarget(staging, ent.name);
      if (ent.isDir) { await dirFor(ent.name); continue; }
      const parentRel = path.dirname(ent.name);
      const parentAbs = await dirFor(parentRel || '.');
      // 只有文件需要唯一化；目录层已确定，文件落进对应目录
      const dst = await uniqueTarget(parentAbs, path.basename(ent.name));
      await fsp.rename(src, dst);
      movedTo.push(dst);
      moved++;
    }
    return { outDir, entries: moved };
  } catch (err) {
    /* 合并阶段失败：把已经搬出去的条目**搬回 staging**，让 outDir 不留半成品。
     * 【为什么是「搬回」而不是「删掉」】
     * 原实现直接 fsp.rm(dst)。dst 是 uniqueTarget 生成的新名字，正常情况下
     * 删掉它就是删掉我们刚解出来的那份，没问题。但「正常情况下」这个前提
     * 一旦不成立（uniqueTarget 的存在性判断因权限/瞬时错误返回了「不存在」，
     * 而文件其实在），rm 删掉的就是**用户原有的文件** —— 解压失败不但没保护
     * 现场，反而毁数据。搬回 staging 则两种情形都安全：是我们的就还给 staging
     * 由 finally 清掉，是用户的就物归原位（改名回去，内容不动）。
     * 失败也只影响这一次清理，不影响已经抛出去的原始错误。 */
    for (const dst of movedTo.reverse()) {
      try {
        const back = path.join(staging, path.basename(dst));
        await fsp.rename(dst, back);
      } catch (e) {
        /* 搬不回去（被占用）就保持原样：宁可多留一份，也不误删。 */
      }
    }
    throw err;
  } finally {
    try { await fsp.rm(staging, { recursive: true, force: true }); } catch (err) {}
  }
});

/* ================= IPC: WiFi 密码查看 ================= */
handle(CH.WIFI.PROFILES, async () => {
  const r = await runCmd('netsh', ['wlan', 'show', 'profiles'], { timeout: 15000, encoding: 'gbk' });
  const names = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/(?:所有用户配置文件|All User Profile)\s*:\s*(.+)$/);
    if (m) names.push(m[1].trim());
  }
  if (!names.length) throw new Error('未找到已保存的 WiFi 配置文件（可能没有无线网卡或未连接过 WiFi）');
  return { names };
});
handle(CH.WIFI.KEY, async (e, name) => {
  const r = await runCmd('netsh', ['wlan', 'show', 'profile', 'name=' + name, 'key=clear'], { timeout: 15000, encoding: 'gbk' });
  const out = r.stdout;
  /* 【必须逐行取，不能对整段跑 /...$/】
   * netsh 的输出是**多行**文本（配置信息 / 连接性设置 / 安全设置 / 安全密钥 几节）。
   * 没有 /m 标志时，`$` 只匹配整个字符串的末尾，而 stdout 结尾是换行符 ——
   * 于是 `关键内容 : P@ssw0rd123` 永远匹配不上，key 恒为 undefined。
   * 渲染层拿到空字符串后显示「（开放网络无密码）」，也就是**所有加密 WiFi
   * 都会被报成开放网络**：不是报错，而是一个确定的错误结论。
   * 同文件的 wifi:profiles 就是按行 split 的，两处写法不一致印证这是遗漏。
   * 用逐行 + 冒号（中英文）取值，比加 /m 更稳：还能避开行尾 \r。 */
  const kvOf = (re) => {
    const line = String(out || '').split(/\r?\n/).find((l) => re.test(l)) || '';
    const m = line.match(/[:：]\s*(.*)$/);
    return m ? m[1].trim() : '';
  };
  const key = kvOf(/关键内容|Key Content/i);
  const auth = kvOf(/身份验证|Authentication/i);
  return { key, auth, raw: out };
});

/* ================= IPC: 文本朗读（System.Speech 本地 TTS） ================= */
handle(CH.TTS.VOICES, async () => {
  const r = await ps(`Add-Type -AssemblyName System.Speech; $p=New-Object System.Speech.Synthesis.SpeechSynthesizer; @($p.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }) | ConvertTo-Json -Compress`, 25000);
  let arr; try { arr = JSON.parse(r.stdout || '[]'); } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [arr];
  return { voices: arr.filter(Boolean) };
});
function ttsEsc(s) { return String(s).replace(/'/g, "''"); }
handle(CH.TTS.SPEAK, (e, { text, voice, rate, volume }) => {
  const id = 'tts' + (++jobSeq);
  const script = `Add-Type -AssemblyName System.Speech; $p=New-Object System.Speech.Synthesis.SpeechSynthesizer;` +
    (voice ? `try{$p.SelectVoice('${ttsEsc(voice)}')}catch{};` : '') +
    `$p.Rate=[int]${Math.max(-10, Math.min(10, rate || 0))};$p.Volume=[int]${Math.max(0, Math.min(100, volume == null ? 100 : volume))};$p.Speak('${ttsEsc(text)}')|Out-Null`;
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
  const kill = () => { try { spawnDetached('taskkill', ['/pid', String(proc.pid), '/t', '/f']); } catch (e) {} };
  jobs.set(id, { cancel: kill });
  /* 【必须挂 error 监听】powershell.exe 起不来时（被安全软件拦住、PATH 被改）
   * 这个 spawn 会 emit 'error'，而这里原来只有 'exit' ——
   * 没有 error 监听时它会升级成 uncaughtException，用户点「朗读」
   * 换来的是整个程序崩掉 + 下次启动标「上次异常退出」。
   * 与 exit 同样要销账并回一个 done:true，否则渲染层的朗读按钮永远处于
   * 「正在朗读」状态（它靠 done:true 复位）。 */
  proc.on('error', () => { jobs.delete(id); send('job:stream', { id, data: JSON.stringify({ done: true }) }); });
  proc.on('exit', () => { jobs.delete(id); send('job:stream', { id, data: JSON.stringify({ done: true }) }); });
  return { id };
});
handle(CH.TTS.WAV, async (e, { text, out, voice, rate }) => {
  const script = `Add-Type -AssemblyName System.Speech; $p=New-Object System.Speech.Synthesis.SpeechSynthesizer;` +
    (voice ? `try{$p.SelectVoice('${ttsEsc(voice)}')}catch{};` : '') +
    `$p.Rate=[int]${Math.max(-10, Math.min(10, rate || 0))};$p.SetOutputToWaveFile('${ttsEsc(out)}');$p.Speak('${ttsEsc(text)}');$p.Dispose();Write-Output OK`;
  const r = await ps(script, 300000);
  if (!(await pathExists(out))) throw new Error('导出失败' + (r.stderr ? '：' + r.stderr.slice(0, 200) : ''));
  return { out, size: (await fsp.stat(out)).size };
});

/* ================= IPC: 服务与电源计划 ================= */
// ServiceControllerStatus 枚举：1=Stopped 2=StartPending 3=StopPending 4=Running 5=ContinuePending 6=PausePending 7=Paused
// ConvertTo-Json 会把枚举序列化成数字，直接传给渲染端会与字符串 'Running' 比对不上，
// 导致所有服务都显示成「已停止」、「停止」按钮永远不出现。这里统一转成字符串。
const SVC_STATUS = { 1: 'Stopped', 2: 'StartPending', 3: 'StopPending', 4: 'Running', 5: 'ContinuePending', 6: 'PausePending', 7: 'Paused' };
handle(CH.SVC.LIST, async () => {
  const r = await ps(`@(Get-Service | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress)`, 30000);
  let arr; try { arr = JSON.parse(r.stdout || '[]'); } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [arr];
  return arr.map(s => ({
    Name: s.Name,
    DisplayName: s.DisplayName || s.Name,
    Status: typeof s.Status === 'number' ? (SVC_STATUS[s.Status] || String(s.Status)) : String(s.Status || ''),
    StartType: s.StartType
  }));
});
/* 关键服务黑名单：停掉它们会造成难以察觉的长期系统损坏
 *   rpcss/dcomlaunch -> RPC 与 COM 基础，停掉大量程序立即失效
 *   eventsystem/eventlog -> 事件日志，丢了就查不到故障记录
 *   bits -> 后台传输，停掉 Windows Update / 商店更新全挂
 *   windefend -> Defender，停掉等于裸奔
 *   schedule -> 任务计划，所有计划任务失效
 *   plugplay / power -> 设备即插即用与电源管理
 *   cryptsvc -> 加密服务，证书/HTTPS 相关全线异常
 *   wuauserv -> Windows Update
 *   msiserver -> Windows Installer，装/卸软件会失败 */
const PROTECTED_SVCS = new Set([
  'rpcss', 'dcomlaunch', 'eventsystem', 'eventlog', 'bits', 'windefend',
  'schedule', 'plugplay', 'power', 'cryptsvc', 'wuauserv', 'msiserver',
  'lsm', 'samss', 'winmgmt', 'themes', 'audiosrv', 'dhcp', 'dnscache',
  'lanmanworkstation', 'nsi'
]);
handle(CH.SVC.ACTION, async (e, name, action) => {
  if (!['start', 'stop'].includes(action)) throw new Error('不支持的操作');
  // 启动服务是无害的恢复操作；停止服务会让依赖它的程序异常退出，才需要高危授权
  if (action === 'stop' && !dangerousEnabled('service-stop')) throw new Error(dangerousDenied('service-stop'));
  if (action === 'stop' && PROTECTED_SVCS.has(String(name || '').toLowerCase())) {
    throw new Error(`拒绝停止系统关键服务：${name}。停止它会导致系统功能异常（网络/DNS/更新/安全组件等），且难以察觉。`);
  }
  const r = await runCmd('sc.exe', [action, name], { timeout: 30000, encoding: 'gbk' });
  /* 【sc.exe 的失败信息会走 stdout，不能只看 stderr】
   * `sc.exe stop X` 出错时打印的是
   *   [SC] OpenService 失败 5:
   *   拒绝访问。
   * 而这类文本在 Windows 上常常出现在 **stdout** 里。原实现写的是
   * `(r.stderr || r.stdout)` —— stderr 非空时**只取 stderr**，stdout 里的
   * 真正原因被丢掉，用户看到一句不相干的话（或「操作失败」）。
   * 另外 sc.exe 对「服务尚未启动」等情况会给出非零码 + 明确文案，
   * 直接把两路合并再取最后几行，比猜哪一路有内容可靠。 */
  const text = [String(r.stdout || ''), String(r.stderr || '')].filter((s) => s.trim()).join('\n');
  if (r.code !== 0) {
    const tail = text.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' ');
    throw new Error(tail || '操作失败（启动/停止服务通常需要管理员权限）');
  }
  /* 退出码为 0 但输出里带「失败」的情形（少见但确实有过）也算失败，
   * 否则界面会 toast「已停止」而服务其实没动。 */
  if (/失败\s*\d+|FAILED\s+\d+/i.test(text)) {
    const tail = text.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' ');
    throw new Error(tail);
  }
  return true;
});
handle(CH.POWER.LIST, async () => {
  const r = await runCmd('powercfg', ['/list'], { timeout: 15000, encoding: 'gbk' });
  const plans = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/([0-9a-fA-F-]{36})\s+(.+?)\s*(\*)?\s*$/);
    if (m) plans.push({ guid: m[1], name: m[2].trim(), active: !!m[3] });
  }
  return plans;
});
handle(CH.POWER.SET, async (e, guid) => {
  await runCmd('powercfg', ['/setactive', guid], { timeout: 15000, encoding: 'gbk' });
  return true;
});

/* 断点续传下载器（共享基础设施）。
 * 它同时被 net:download（通用文件下载）与 ipc/media-ffmpeg.js 的
 * ffmpeg:download（下载 ffmpeg 包）使用，所以**留在 main.js**、由 deps 注入。
 * 任务 6 一开始把它整段搬进了媒体域，net:download 立刻变成 ReferenceError ——
 * 语法检查完全看不见（运行时才炸），是 ESLint 的 no-undef 抓到的。 */
function downloadToFile(url, dest, id, ctrl, label) {
  return downloadLib.download(url, dest, id, ctrl, label, { send });
}
/* ================= IPC: 通用文件下载（断点续传） ================= */
handle(CH.NET.DOWNLOAD, (e, { url, out }) => {
  /* 【下载前必须查覆盖】downloadToFile 最后是 fsp.rename(tmp, dest)，
   * 而 Windows 上 rename 目标已存在会直接覆盖 —— 用户手输的保存路径
   * 一旦撞上已有文件，那个文件会被静默抹掉，界面上只显示「下载完成」。
   * 这里用与其它写文件通道一致的 checkOverwritable 闸门：
   * 命中关键目录或已存在同名文件时抛错，让用户换个路径。 */
  const bad = pathGuard.checkOverwritable(out);
  if (bad) throw pathGuard.err(bad.code, bad.reason, '请换一个保存路径');
  if (fs.existsSync(out)) throw new Error('目标文件已存在，为避免覆盖已拒绝：' + out);
  const id = 'dlg' + (++jobSeq);
  const ctrl = new AbortController();
  jobs.set(id, { cancel: () => ctrl.abort() });
  latestCancelable = () => ctrl.abort();
  (async () => {
    try {
      await downloadToFile(url, out, id, ctrl, path.basename(out));
      send('job:stream', { id, data: JSON.stringify({ done: true, ok: true, out }) });
    } catch (err) {
      send('job:stream', { id, data: JSON.stringify({ done: true, ok: false, error: err.name === 'AbortError' ? '已取消' : err.message }) });
    } finally { jobs.delete(id); }
  })();
  return { id };
});

/* ================= IPC: 区域截图 + 标注（snip.html 全屏覆盖窗） ================= */
let snipWin = null;
/* 当前截图窗用的临时 PNG（全屏原图，4K 屏约 5~15MB）。
 * 【必须记下来并在窗口关闭时删掉】
 * 原实现只把路径塞进 URL query，之后再也不管：`snip:finish` 的 cancel 分支
 * 直接 return，`snipWin.on('closed')` 只把变量置空。于是按一次快捷键、
 * 随手按 Esc 取消，就在 %TEMP% 留下一张全屏 PNG；用户一天截几十次就是几百 MB。
 * 启动清扫虽然会按 24 小时清理，但前提是「下次启动」，且期间一直占着盘。
 * 这里在窗口关闭时统一收口 —— 无论用户是取消、完成、还是直接点窗口关闭。 */
let snipSrcFile = null;
const snipTmp = () => tempNames.snipTmp({ tempDir: app.getPath('temp') });
async function dropSnipSrc() {
  const f = snipSrcFile;
  snipSrcFile = null;
  if (!f) return;
  try { await fsp.rm(f, { force: true }); } catch (e) { /* 被占用就留给启动清扫 */ }
}
async function captureDisplay(display) {
  const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      // getSources 在连续调用时可能偶发挂起，加超时保护
      const sources = await Promise.race([
        desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('屏幕捕获超时')), 8000))
      ]);
      const src = sources.find(s => s.display_id === String(display.id)) || sources[0];
      if (src) return src.thumbnail;
      lastErr = new Error('屏幕捕获失败');
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('屏幕捕获失败');
}
async function snipStart(mode) {
  if (snipWin && !snipWin.isDestroyed()) { snipWin.close(); snipWin = null; }
  await dropSnipSrc();   // 上一张没清掉的，先收口
  const pt = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(pt);
  const img = await captureDisplay(display);
  const file = snipTmp();
  await fsp.writeFile(file, img.toPNG());
  snipSrcFile = file;
  /* 【窗口必须精确覆盖屏幕，且不要再 setFullScreen】
   * 实测（187.5% 缩放、逻辑 1366×854 的机器）：
   *   · 按 display.bounds 建窗 → getBounds() 返回 1369×818（不是 1366×854）
   *   · 再调 setFullScreen(true) → 变成 1367×855，而 isFullScreen() 仍返回 false
   * 也就是说 setFullScreen 在这个"已经精确定位到屏幕区域"的 frameless 窗口上
   * 既不生效、又把尺寸改坏。窗口比屏幕大一点点时，截图会露出黑边/错位，
   * 用户看到的就是"屏幕变形"。
   *
   * 【实测：DPI 取整会让窗口永远差 1px，这是系统级限制】
   * 在 187.5% 缩放的机器上（逻辑 1366×854），无论用不用 useContentSize、
   * 无论怎么 setBounds，getBounds() 都稳定返回 **1367×855**（多 1px），
   * getContentSize() 返回 1365×854（少 1px）：
   *   1366 × 1.875 = 2561.25 物理像素 → Windows 取整成 2561 或 2562，
   *   再除回 1.875 就不等于 1366。这个误差无法通过参数消除。
   *
   * 所以策略是"宁可多不能少"：
   *   · 多出的 1px 在屏幕外，被系统裁掉，用户看不到；
   *   · 少 1px 则会在边缘露出一条没被覆盖的旧画面（正是"变形"的观感）。
   * 配合 setContentBounds 让**内容区**尽量贴近屏幕（内容区才是用户看的东西）。 */
  const bounds = {
    x: Math.round(display.bounds.x), y: Math.round(display.bounds.y),
    width: Math.round(display.bounds.width), height: Math.round(display.bounds.height),
  };
  snipWin = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame: false, transparent: true, alwaysOnTop: true, resizable: false, skipTaskbar: true, hasShadow: false,
    useContentSize: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false,
      additionalArguments: ['--hehe-packaged=' + (app.isPackaged ? '1' : '0')] }
  });
  hardenWindow(snipWin);
  snipWin.setAlwaysOnTop(true, 'screen-saver');
  /* 用 setContentBounds 而不是 setBounds：用户看的是内容区，
   * 而 setBounds 管的是"含边框的外框"——frame:false 时两者理论上相等，
   * 但 DPI 取整会让它们各差 1px（见上）。直接约束内容区更贴近意图。 */
  try {
    if (typeof snipWin.setContentBounds === 'function') snipWin.setContentBounds(bounds);
    else snipWin.setBounds(bounds);
  } catch (e) { /* 某些平台在 ready 前不可设，忽略 */ }
  /* 保留原来的语义说明：这里**刻意不调 setFullScreen**（见上方实测）。 */
  /* 关窗即清临时图。走到这里说明截图源图已经没用了
   * （pin/save/ocr 分支会各自另存一份新文件，不复用这张）。 */
  snipWin.on('closed', () => { snipWin = null; dropSnipSrc(); });
  await snipWin.loadFile('snip.html', { query: {
    src: file, mode: mode === 'region' ? 'region' : 'annotate',
    dx: String(display.bounds.x), dy: String(display.bounds.y),
    scale: String(display.scaleFactor), w: String(display.bounds.width), h: String(display.bounds.height),
    accent: currentAccent
  } });
  snipWin.show();
  return { ok: true };
}
handle(CH.SNIP.START, (e, mode) => snipStart(mode));
handle(CH.SNIP.FINISH, async (e, { action, dataUrl, rect }) => {
  const winToClose = snipWin;
  snipWin = null;
  try { if (winToClose && !winToClose.isDestroyed()) winToClose.close(); } catch (err) {}
  /* 【取消也必须回一条 snip:region，否则调用方会干等到超时】
   * 渲染层（screen-rec 的 pickRegion）用 Promise 等两个出口之一：
   *   · 'snip:region' 事件
   *   · 120 秒定时器
   * 而 cancel 分支原来直接 return，一个事件都不发 ——
   * 用户按 Esc 取消后，状态行会停在「请在屏幕上框选录制区域…」整整两分钟，
   * 那期间订阅与定时器都不释放，切页也不会清（App.onCleanup 没登记它们）。
   * 现在：cancel 也发一条 snip:region 且载荷为 null，
   * 让调用方立刻按「未选择区域」收尾。 */
  if (action === 'cancel' || action === 'region') {
    /* rect 只有在真框选了区域时才存在；取消时传 null，语义是"用户放弃了" */
    if (action === 'region' && rect) send('snip:region', rect); // 区域录制等用途
    else send('snip:region', null);
    return { ok: true };
  }
  if (!dataUrl) return { ok: false };
  if (action === 'copy') {
    clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
    return { ok: true };
  }
  const file = snipTmp();
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1] || '', 'base64'));
  if (action === 'pin') {
    await new Promise(r => setTimeout(r, 120));
    await createPinWindow(file);
    return { ok: true, path: file };
  }
  if (action === 'ocr') { send('snip:ocr', file); return { ok: true, path: file }; }
  if (action === 'save') {
    const p = await dialog.showSaveDialog(win || null, { defaultPath: '截图-' + Date.now() + '.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
    try {
      if (!p.canceled && p.filePath) {
        fs.copyFileSync(file, p.filePath);
        return { ok: true, path: p.filePath };
      }
      return { ok: false };
    } finally {
      /* 【"另存为"这条路必须自己收尾】
       * 上面那张 file 是为「落盘」临时写的；用户点了保存/取消之后它就没用了。
       * 原实现不删，于是每执行一次「保存截图」都在 %TEMP% 留一张：
       * 保存成功留一张（和用户要的那份重复）、取消也留一张（纯垃圾）。 */
      try { fs.rmSync(file, { force: true }); } catch (e) {}
    }
  }
  /* 走到这里说明 action 不认识：刚写的临时文件同样要清掉 */
  try { fs.rmSync(file, { force: true }); } catch (e) {}
  return { ok: false };
});
// 贴剪贴板图片（托盘/工具用）
async function pinClipboardImage() {
  const img = clipboard.readImage();
  if (img.isEmpty()) throw new Error('剪贴板中没有图片');
  const file = snipTmp();
  fs.writeFileSync(file, img.toPNG());
  const r = await createPinWindow(file);
  return { ok: true, ...r };
}
handle(CH.SNIP.PIN_CLIPBOARD, () => pinClipboardImage());

/* ================= IPC: 检查更新（GitHub Releases；NSIS 安装版走 electron-updater） ================= */
// ETag 条件请求 + 本地缓存：命中缓存/304 时不消耗匿名限流配额（60 次/时/IP）
/* 【缓存时长可配置】设置 → 通用 → 更新检查缓存（0~72 小时）。
 * 0 表示不缓存（每次都真查），这是"我想第一时间拿到新版"的人要的。
 * 现读而不是在模块加载时算一次：设置页改完立刻生效。
 * 默认值来自 lib/prefs-spec.js 的规格表，这里不再写第二份。 */
function updateTtlMs() {
  const h = prefsGet('updateTtlHours');
  const hours = (typeof h === 'number' && h >= 0) ? h : 6;
  return hours * 3600 * 1000;
}
const UPDATE_API = 'https://api.github.com/repos/xiaohetaoo/hehe-toolbox/releases/latest';
function updateCacheGet() {
  const c = storeGet('updateCache', null);
  return c && typeof c === 'object' ? c : null;
}
function updateCacheSet(patch) {
  storeSet('updateCache', Object.assign({}, updateCacheGet() || {}, patch));
}
// force 节流：设置页连点「检查更新」不应连发请求（防止打满限流配额）
const UPDATE_FORCE_MIN_GAP = 10 * 1000;
let lastForceCheckAt = 0;
/* 【检查更新抽成函数，供 IPC handler 与「启动时自动检查」共用】
 * 原来整段逻辑内联在 handle(CH.UPDATE.CHECK) 里；启动自动检查也要用同一套
 * （缓存、ETag、节流、双引擎），复制一份必然会漂移。
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<object>} 与 IPC 返回的数据同形
 */
async function updateCheckImpl(opts) {
  const o = opts || {};
  const current = app.getVersion();
  const force = !!o.force;
  if (force) {
    const since = Date.now() - lastForceCheckAt;
    if (since < UPDATE_FORCE_MIN_GAP) {
      const cached = updateCacheGet();
      if (cached && cached.payload) {
        return Object.assign({}, cached.payload, { cached: true, throttled: true, retryAfter: Math.ceil((UPDATE_FORCE_MIN_GAP - since) / 1000) });
      }
      throw new Error('检查更新太频繁，请稍后再试（' + Math.ceil((UPDATE_FORCE_MIN_GAP - since) / 1000) + ' 秒后可用）');
    }
    lastForceCheckAt = Date.now();
  }

  // 安装版：electron-updater（可用则直接通知升级）
  try {
    if (process.env.HEHE_PORTABLE !== '1' && app.isPackaged && fs.existsSync(path.join(process.resourcesPath || '', 'app-update.yml'))) {
      const { autoUpdater } = require('electron-updater');
      const res = await autoUpdater.checkForUpdates();
      if (res && res.updateInfo && res.updateInfo.version && cmpVer(res.updateInfo.version, current) > 0) {
        return { current, latest: res.updateInfo.version, hasUpdate: true, engine: 'electron-updater', notes: String(res.updateInfo.releaseNotes || '').slice(0, 4000) };
      }
    }
  } catch (e) { console.warn('[update] electron-updater 不可用，回退 GitHub API：', e.message); }
  // 缓存未过期且非强制刷新：直接返回，完全不发请求
  const cached = updateCacheGet();
  if (cached && cached.payload && !force && Date.now() - (cached.checkedAt || 0) < updateTtlMs()) {
    return Object.assign({}, cached.payload, { cached: true, cacheAge: Math.round((Date.now() - cached.checkedAt) / 60000) });
  }
  // 便携版/兜底：查最新 Release（带 If-None-Match，304 时复用缓存）
  try {
    const headers = { 'User-Agent': 'hehe-update', Accept: 'application/vnd.github+json' };
    if (cached && cached.etag) headers['If-None-Match'] = cached.etag;
    const r = await fetch(UPDATE_API, { headers, signal: AbortSignal.timeout(15000) });
    if (r.status === 304 && cached && cached.payload) {
      updateCacheSet({ checkedAt: Date.now() });
      return Object.assign({}, cached.payload, { cached: true, notModified: true, cacheAge: 0 });
    }
    if (!r.ok) throw new Error('GitHub API HTTP ' + r.status);
    const j = await r.json();
    const latest = (j.tag_name || '').replace(/^v/, '');
    const asset = (j.assets || []).find(a => /^hehe-toolbox-Portable-.*\.exe$/.test(a.name));
    /* GitHub 现在会给每个 Release 资产带上 digest 字段（形如 "sha256:<hex>"）。
     * 拿它做下载后完整性校验：体积相同但内容被替换（中间人、CDN 缓存污染、
     * 上传时截断）都能被发现。拿不到时 assetSha256 为 null，
     * 应用阶段仍校验可信体积与 PE 头，并固定本次文件的摘要供替换前复查。 */
    const rawDigest = (asset && asset.digest) || '';
    const mDigest = /^sha256:([0-9a-f]{64})$/.exec(rawDigest);
    const assetSha256 = mDigest ? mDigest[1] : null;
    const payload = {
      current, latest, hasUpdate: cmpVer(latest, current) > 0, engine: 'github',
      notes: (j.body || '').slice(0, 4000), assetUrl: asset ? asset.browser_download_url : null, assetName: asset ? asset.name : null,
      assetSize: asset ? asset.size : null, assetSha256, htmlUrl: j.html_url || ''
    };
    updateCacheSet({ etag: r.headers.get('etag') || null, checkedAt: Date.now(), payload });
    return payload;
  } catch (err) {
    // 网络失败但手上有旧缓存：降级返回缓存并标注 stale，至少还能看到已知最新版
    if (cached && cached.payload) {
      throw new Error('检查更新失败（网络）：' + err.message + '（已使用 ' + Math.round((Date.now() - (cached.checkedAt || 0)) / 3600000) + ' 小时前的缓存，当前已知最新 v' + cached.payload.latest + '）');
    }
    throw new Error('检查更新失败（网络）：' + err.message);
  }
}

handle(CH.UPDATE.CHECK, async (e, opts = {}) => updateCheckImpl(opts));
// 便携版引导替换：下载好的新版 exe 覆盖当前 exe，随后自动重启
// 便携版无静默自升级能力（electron-builder portable 每次启动都解压到临时目录），
// 只能在进程退出后用外部脚本完成替换，因此走 PowerShell 脚本 + app.exit()。
function psSingleQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
/* 【升级应用必须单飞】
 * 这个 handler 的结尾会 spawn 一个替换脚本、1 秒后 app.exit()。
 * 渲染层那个「立即重启升级」按钮在拿到返回值之前是可以连点的（它当时还没被
 * disable），两次 IPC 会在那 1 秒窗口里都走到 spawn —— 两个 PowerShell 脚本
 * 同时 Copy-Item 同一个 target.exe，各自先写 target.bak.<时间戳>，
 * 中途可能读到半个 exe 触发「替换后大小不符」，回滚用的又是对方刚写了一半的
 * 备份。最坏结果是 target.exe 变成半截，用户再也打不开。
 * 用一个模块级标志挡住第二次即可 —— 升级本来就不可能并行。 */
let updateApplying = false;
let updateApplyingCommitted = false;
handle(CH.UPDATE.APPLY, async (e, opts = {}) => {
  if (updateApplying) throw new Error('升级已经在进行中，请稍候（应用即将自动重启）。');
  updateApplying = true;
  try {
    return await updateApplyImpl(opts);
  } catch (err) {
    /* 校验失败等「还没开始替换」的错误要把标志放开，让用户能重试；
     * 一旦走到 spawn 脚本那一步，进程 1 秒后就退出了，放不放开都无所谓。 */
    if (!updateApplyingCommitted) updateApplying = false;
    throw err;
  }
});
async function updateApplyImpl(opts = {}) {
  const newExe = opts && opts.newExe;
  if (!newExe || !fs.existsSync(newExe)) throw new Error('新版文件不存在，请先完成下载');
  const metadata = (updateCacheGet() || {}).payload;
  const updateDir = path.join(app.getPath('userData'), 'update');
  if (!metadata || path.basename(newExe) !== metadata.assetName ||
      pathGuard.canonical(path.dirname(newExe)) !== pathGuard.canonical(updateDir)) {
    throw new Error('更新包与检查结果不匹配，请重新检查并下载更新');
  }
  // Trust metadata held by the main process, not a digest supplied by a renderer.
  const verified = await updateFile.verifyUpdateFile(newExe, metadata);
  // 便携版启动时 electron-builder 注入 PORTABLE_EXECUTABLE_FILE 指向原始 exe
  const target = process.env.PORTABLE_EXECUTABLE_FILE || (opts && opts.target) || app.getPath('exe');
  if (!/\.exe$/i.test(target)) throw new Error('目标不是可执行文件，无法自动替换：' + target);
  if (path.resolve(target).toLowerCase() === path.resolve(newExe).toLowerCase()) throw new Error('新旧文件相同，无需替换');
  const scriptDir = path.join(app.getPath('userData'), 'update');
  await fsp.mkdir(scriptDir, { recursive: true });
  const script = path.join(scriptDir, 'apply-update.ps1');
  // 备份原 exe：升级失败时用户可双击回滚，脚本自身也会在启动失败时尝试回滚
  const backup = target + '.bak';
  const rollbackScript = path.join(scriptDir, 'rollback.ps1');
  const myPid = process.pid;
  // 注意：$PID 是 PowerShell 自动变量（只读），这里必须换个名字
  /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '$targetPid = ' + myPid,
    '$newExe = ' + psSingleQuote(newExe),
    '$target = ' + psSingleQuote(target),
    '$backup = ' + psSingleQuote(backup),
    '$expectedSha256 = ' + psSingleQuote(verified.sha256),
    '$expectedSize = ' + verified.size,
    '$replacing = $false',
    '$log = Join-Path $env:TEMP ("hehe-update-" + [DateTime]::Now.ToString("yyyyMMdd-HHmmss") + ".log")',
    'try {',
    '  $deadline = [DateTime]::Now.AddSeconds(90)',
    '  while ((Get-Process -Id $targetPid -ErrorAction SilentlyContinue) -and ([DateTime]::Now -lt $deadline)) { Start-Sleep -Milliseconds 300 }',
    '  Start-Sleep -Milliseconds 600',
    '  if ((Get-Item -LiteralPath $newExe).Length -ne $expectedSize -or (Get-FileHash -LiteralPath $newExe -Algorithm SHA256).Hash -ne $expectedSha256) { throw "更新包在校验后发生变化，已拒绝替换" }',
    // 1) 备份旧版，但**不要覆盖上一份备份**：
    //    原实现是 Copy-Item -Force 直接盖掉 .bak，用户连续升级两次后，
    //    更早的那个版本就永久丢了（回滚只能回到上一个版本）。
    //    改成带时间戳的多份备份：target.bak（最近一次）+ target.bak.<时间戳>（历史）
    '  if (Test-Path -LiteralPath $target) {',
    '    $stamp = [DateTime]::Now.ToString("yyyyMMdd-HHmmss")',
    '    Copy-Item -LiteralPath $target -Destination ($backup + "." + $stamp) -Force',
    '    Copy-Item -LiteralPath $target -Destination $backup -Force',
    '  }',
    // 2) 记录源文件大小，替换后校验：Copy-Item 中途失败会留下半个 exe，
    //    而 target.exe 正是用户唯一的启动入口
    '  $srcLen = (Get-Item -LiteralPath $newExe).Length',
    '  $replacing = $true',
    '  Copy-Item -LiteralPath $newExe -Destination $target -Force',
    '  $dstLen = (Get-Item -LiteralPath $target).Length',
    '  if ($dstLen -ne $srcLen) { throw ("替换后大小不符：" + $dstLen + " != " + $srcLen) }',
    '  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $expectedSha256) { throw "替换后摘要不符" }',
    '  Add-Content -LiteralPath $log -Value ("replaced: " + $target)',
    '} catch {',
    '  Add-Content -LiteralPath $log -Value ("failed: " + $_.Exception.Message)',
    // 替换失败则把备份还原回去
    '  try { if ($replacing -and (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $backup -Destination $target -Force; Add-Content -LiteralPath $log -Value "restored-from-backup" } } catch {}',
    '  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
    '  exit 1',
    '}',
    // 3) 启动新版。启动失败时**保留下载包**：用户手里还得有新版可以手动重试，
    //    原实现是无条件删除 newExe，等于把用户唯一的「新版文件」也弄没了。
    '$launched = $false',
    'try { Start-Process -FilePath $target; $launched = $true }',
    'catch { Add-Content -LiteralPath $log -Value ("launch-failed: " + $_.Exception.Message) }',
    'if (-not $launched) {',
    '  Add-Content -LiteralPath $log -Value "kept-new-exe-for-retry"',
    '} else {',
    // 新版成功拉起后删除下载包（避免每次升级都留一份 90MB+）
    '  try { if ($newExe -ne $target) { Remove-Item -LiteralPath $newExe -Force -ErrorAction SilentlyContinue } } catch {}',
    '}',
    'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue'
  ].join('\r\n');
  // 回滚脚本：任何时候双击即可退回升级前的版本
  const rb = [
    '$ErrorActionPreference = "Stop"',
    '$target = ' + psSingleQuote(target),
    '$backup = ' + psSingleQuote(backup),
    '$log = Join-Path $env:TEMP ("hehe-rollback-" + [DateTime]::Now.ToString("yyyyMMdd-HHmmss") + ".log")',
    'try {',
    '  if (-not (Test-Path -LiteralPath $backup)) { throw "备份文件不存在：$backup" }',
    // 停进程必须按 exe 的完整路径匹配：便携版进程名是 hehe-toolbox-Portable-x.y.z
    // （即 exe 文件名），写死 "核核工具箱" 永远匹配不上 → 旧 exe 被占用 → Copy-Item 失败
    // → 回滚中止。便携版恰是主要分发形态，等于回滚脚本对绝大多数用户都不可用。
    '  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target } | Stop-Process -Force -ErrorAction SilentlyContinue',
    '  Start-Sleep -Milliseconds 800',
    '  Copy-Item -LiteralPath $backup -Destination $target -Force',
    '  Add-Content -LiteralPath $log -Value ("rolled-back: " + $target)',
    '  Start-Process -FilePath $target',
    '} catch { Add-Content -LiteralPath $log -Value ("rollback-failed: " + $_.Exception.Message) }'
  ].join('\r\n');
  await fsp.writeFile(script, ps, 'utf8');
  await fsp.writeFile(rollbackScript, rb, 'utf8');
  const spawnArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script];
  if (opts && opts.dryRun) {
    return { ok: true, dryRun: true, script, rollbackScript, target, newExe, backup, args: spawnArgs };
  }
  /* 【走 spawnDetached，不要裸 spawn().unref()】
   * 这句是「让替换脚本脱离父进程活下去」的典型写法，原来只有 unref ——
   * powershell.exe 起不来时异步 emit 的 'error' 没有任何监听，
   * 会升级成 uncaughtException。而这里恰好在**即将退出**的时刻：
   * 崩溃日志会写进一份本该是「正常退出完成更新」的记录里，
   * 用户下次看到「上次异常退出」却完全找不到对应现象。
   * spawnDetached 已经挂了空 error 监听并 unref。 */
  spawnDetached('powershell.exe', spawnArgs, { detached: true, stdio: 'ignore' });
  /* 替换脚本已经起来了：此后不再允许第二次 apply（标志也就不必再放开） */
  updateApplyingCommitted = true;
  /* 【退出前必须手动清会话标记】
   * 这里用的是 app.exit(0) 而不是 app.quit()：更新替换要尽快让出文件句柄，
   * 而 app.exit 会**跳过 will-quit 等所有退出钩子**（Electron 文档明确如此）。
   * 而会话标记正是在 will-quit 里删的 —— 不补这一句的话：
   *   每次自动更新重启 → 标记残留 → 下次启动误报「上次异常退出」，
   *   用户会以为程序坏了。这是最容易误报的一条路径，因为更新重启很常见。
   * （实测：app.exit 不触发 will-quit；app.quit 触发。） */
  try { crashLog.clearMarker(crashLogDir()); } catch (err) {}
  // 给脚本 ~1 秒启动时间后退出，脚本会等待本进程消失再替换
  setTimeout(() => { try { isQuitting = true; app.exit(0); } catch (err) { app.quit(); } }, 1000);
  return { ok: true, target, newExe, backup, rollbackScript, script };
}
// 清理 update 下载目录里「已经应用过」的旧安装包。
// 关键：刚下载、还没安装的新包绝不能删——它正是接下来 update:apply 要用的文件。
// 原实现把该目录下所有 hehe-toolbox-Portable-*.exe 一律删光，于是“下载完切走再回关于页”
// 就把 90MB+ 白下了一遍，而且没有任何提示。
// 判据：文件名里的版本号 <= 当前运行版本，说明那份包要么是当前版本、要么早已被取代，
// 留着纯属占地方；只有版本号 > 当前版本、且没被 update:apply 记录为已应用的，才保留。
function updatePendingGet() { return updateCacheGet() || {}; }
/* .bak 回收：每次升级都会在 exe 旁留下两套备份
 *   <exe>.bak              最近一次（回滚用）
 *   <exe>.bak.<时间戳>      历史（防「连续升级两次把更早那版挤掉」）
 * 时间戳那套**从来没人清理**，升几次就在用户目录里堆几份 100MB。
 * 这里只保留最近 N 份时间戳备份：
 *   - 最新的 1 份一定留（万一刚升级的新版起不来，还要靠它）；
 *   - .bak 本身永远不动（那是脚本自动回滚会读的那份）。
 * 只看文件名里的时间戳（yyyyMMdd-HHmmss），不依赖文件时间 ——
 * 拷来拷去会改 mtime，但那不代表「备份的新旧顺序」。 */
async function pruneExeBackups(exePath, keep = 3) {
  const dir = path.dirname(exePath);
  const base = path.basename(exePath);
  const prefix = base + '.bak.';
  let names;
  try { names = await fsp.readdir(dir); } catch (e) { return { removed: 0, bytes: 0 }; }

  const stamped = names
    .filter((n) => n.startsWith(prefix))
    .map((n) => ({ n, stamp: n.slice(prefix.length) }))
    .filter((x) => /^\d{8}-\d{6}$/.test(x.stamp))
    // 时间戳字符串可以直接按字典序比较（定宽、从大到小 = 新到旧）
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));

  let removed = 0, bytes = 0;
  for (const item of stamped.slice(keep)) {
    const full = path.join(dir, item.n);
    try {
      const st = await fsp.stat(full);
      await fsp.unlink(full);
      removed++; bytes += st.size;
    } catch (e) { /* 被占用/已删除：跳过 */ }
  }
  return { removed, bytes };
}

handle(CH.UPDATE.CLEANUP, async () => {
  const dir = path.join(app.getPath('userData'), 'update');
  const current = app.getVersion();
  const pendingName = updatePendingGet().pendingName || null; // 正在等待安装的那份
  let removed = 0, bytes = 0, kept = 0;
  try {
    for (const n of await fsp.readdir(dir)) {
      if (!/^hehe-toolbox-Portable-.*\.exe$/i.test(n)) continue;
      const vm = n.match(/hehe-toolbox-Portable-(.+?)\.exe$/i);
      const ver = vm ? vm[1] : '';
      // 待安装的包一律保留，哪怕它版本号看起来不新
      if (pendingName && n === pendingName) { kept++; continue; }
      // 版本号解析不出来就保守保留，不做“猜着删”
      if (!/^\d+\.\d+\.\d+/.test(ver)) { kept++; continue; }
      if (cmpVer(ver, current) > 0) { kept++; continue; }
      const full = path.join(dir, n);
      try {
        const st = await fsp.stat(full);
        await fsp.unlink(full);
        removed++; bytes += st.size;
      } catch (e) {}
    }
  } catch (e) { /* 目录不存在 */ }

  /* 顺手回收 exe 旁边的历史 .bak（见 pruneExeBackups 的注释）。
   * 目标取便携版原始 exe：PORTABLE_EXECUTABLE_FILE 指向用户双击的那个文件，
   * 升级脚本替换的也是它。取不到（开发态/非便携版）就跳过，不猜路径。 */
  let bakRemoved = 0, bakBytes = 0;
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portableExe) {
    try {
      const r = await pruneExeBackups(portableExe, 3);
      bakRemoved = r.removed; bakBytes = r.bytes;
    } catch (e) {}
  }
  return { removed, bytes, kept, bakRemoved, bakBytes };
});
// 记下“已下载、等待安装”的那份包名，供 update:cleanup 豁免
handle(CH.UPDATE.MARK_PENDING, (e, name) => {
  updateCacheSet({ pendingName: name ? String(name) : null });
  return true;
});
/* 版本号比较：只比前三段数字，返回 -1 / 0 / 1。
 *
 * 【必须剥掉预发布后缀，且不能让 NaN 参与运算】
 * 原实现是 `String(a).split('.').map(Number)`，然后 `pa[i] || 0`。
 * 遇到 `0.3.5-beta` 这种（GitHub Release 上很常见：rc / beta / hotfix 标记），
 * 第三段 parse 成 NaN，而 `NaN || 0` 得 0 —— 于是
 *   cmpVer('0.3.5-beta', '0.3.4') === -4
 * 把「比上一版新」判成了「比上一版旧」，检查更新的结论直接反过来。
 * 另外 `x - y` 返回的是差值而不是 -1/1，浮点/特殊值下调用方若写 `=== 1`
 * 就永远不成立；统一收成三态更安全。
 * @param {string} a
 * @param {string} b
 * @returns {number} a>b 返回 1，a<b 返回 -1，相等返回 0
 */
function cmpVer(a, b) {
  const seg = (v) => String(v == null ? '' : v)
    .trim()
    .replace(/^v/i, '')            // 容忍 'v0.3.5'
    .split('.')
    .slice(0, 3)
    /* 【真正挡住 -beta 的是 parseInt，不是 split】
     * `parseInt('5-beta', 10)` 得 5（它读到非数字就停），所以后缀天生被忽略。
     * 早期写法 `.map(Number)` 才是根因：Number('5-beta') 是 NaN，而 `NaN || 0`
     * 得 0 —— 于是 `0.3.5-beta` 被当成 `0.3.0`，比 `0.3.4` 还旧。
     * 别再往这里加 split(/[-+]/) 之类的预处理：实测它一行结果都改不了，
     * 只是把「为什么对」说得更绕。（反向验证时确认过它是死代码。） */
    .map((s) => {
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const pa = seg(a), pb = seg(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/* ================= IPC: 周期任务（主进程持久化调度） ================= */
const schedTimers = new Map(); // id -> {timeout, interval?}
function schedFire(s) {
  try {
    if (s.type === 'clean') {
      (async () => {
        try {
          const tmp = app.getPath('temp');
          const now = Date.now();
          // 与启动清扫的 24 小时保留策略保持一致：刚写出来的分段目录可能正在录制，
          // 一律端掉会把 hehe-rec-* 连锅端（录制进程还在写，删了直接丢整段录像）。
          const KEEP_MS = 24 * 3600 * 1000;
          let removed = 0, bytes = 0, skipped = 0;
          const entries = await fsp.readdir(tmp).catch(() => []);
          for (const n of entries) {
            if (!isOwnTempName(n)) continue; // 只清本应用自己的产物
            const full = path.join(tmp, n);
            try {
              const st = await fsp.stat(full);
              if (now - st.mtimeMs <= KEEP_MS) { skipped++; continue; } // 最近的保留
              if (st.isDirectory()) {
                const r = await dirSizeFast(full);
                await fsp.rm(full, { recursive: true, force: true });
                bytes += r.size;
              } else {
                await fsp.unlink(full);
                bytes += st.size;
              }
              removed++;
            } catch (e) {}
          }
          send('sched:fire', { id: s.id, type: s.type, message: `自动清理完成，释放 ${Math.round(bytes / 1048576)} MB（${removed} 个本应用临时文件${skipped ? '，' + skipped + ' 个 24 小时内的保留' : ''}）` });
        } catch (err) { send('sched:fire', { id: s.id, type: s.type, message: '自动清理失败：' + err.message }); }
      })();
    } else {
      send('sched:fire', { id: s.id, type: s.type, message: s.message || '定时提醒' });
    }
  } catch (e) {}
  armSchedule(s, true);
}
function armSchedule(s, isRefire) {
  const t = schedTimers.get(s.id);
  if (t) { clearTimeout(t.timeout); if (t.interval) clearInterval(t.interval); }
  if (s.type === 'loop') {
    const mins = Number(s.everyMin);
    // 兜底：历史数据可能带着 NaN/0（旧版本、手改 hehe-data.json），
    // NaN 会让 setInterval 退化成 ~1ms 一次
    const ms = Number.isFinite(mins) && mins >= SCHED_MIN_EVERY_MIN
      ? Math.min(mins, SCHED_MAX_EVERY_MIN) * 60000
      : 30 * 60000;
    schedTimers.set(s.id, { interval: setInterval(() => schedFire(s), ms) });
    if (!isRefire) schedFire(s); // 立即触发一次作为确认提示
  } else {
    // daily：计算下一次 hh:mm
    const [hh, mm] = String(s.hhmm || '09:00').split(':').map(Number);
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh || 0, mm || 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    schedTimers.set(s.id, { timeout: setTimeout(() => schedFire(s), next - now) });
  }
}
function armAllSchedules() {
  const list = storeGet('settings.schedules', []);
  for (const s of list) armSchedule(s, false);
}
handle(CH.SCHED.LIST, () => storeGet('settings.schedules', []));
// 周期任务参数校验：渲染层有过滤不代表 IPC 层安全。
// everyMin 传 NaN 时 Math.max(60000, NaN) 得 NaN，setInterval(fn, NaN) 退化为约 1ms 一次，
// 会把主进程变成提醒风暴（还连带不断写 store）。这里统一收口成合法值或直接拒绝。
const SCHED_TYPES = ['loop', 'daily', 'clean'];
const SCHED_MIN_EVERY_MIN = 1, SCHED_MAX_EVERY_MIN = 7 * 24 * 60;
function normSchedule(s) {
  if (!s || typeof s !== 'object') throw new Error('任务参数无效');
  if (!SCHED_TYPES.includes(s.type)) throw new Error('任务类型无效：' + s.type);
  const out = { type: s.type, message: String(s.message || '').slice(0, 500) };
  if (s.type === 'loop') {
    const n = Number(s.everyMin);
    if (!Number.isFinite(n)) throw new Error('循环间隔必须是数字（分钟）');
    const mins = Math.floor(n);
    if (mins < SCHED_MIN_EVERY_MIN) throw new Error(`循环间隔不能小于 ${SCHED_MIN_EVERY_MIN} 分钟`);
    out.everyMin = Math.min(mins, SCHED_MAX_EVERY_MIN);
  } else if (s.type === 'daily' || s.type === 'clean') {
    /* 【clean 也必须保留 hhmm】armSchedule 对非 loop 类型一律按 `s.hhmm` 算
     * 「下一次几点」，缺了就退回默认 '09:00'。早期这里只给 daily 走时间分支，
     * clean 的 hhmm 被直接丢掉，后果有两个且都不会报错：
     *   ① 用户在「每天自动清理」里选的 03:00 静默变成 09:00（凌晨清理 ← 上班时间清理）；
     *   ② 周期任务列表的文案是 `每天 ${s.hhmm} 自动清理…`，于是显示成
     *      「每天 undefined 自动清理本应用临时文件」。
     * 两者都是「看起来设置成功了，实际没生效」。 */
    const m = String(s.hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) throw new Error('时间格式应为 HH:MM');
    const hh = +m[1], mm = +m[2];
    if (hh > 23 || mm > 59) throw new Error('时间超出范围：' + s.hhmm);
    out.hhmm = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }
  return out;
}
/* 生成不重复的本地 id。
 * 【为什么不用纯 Date.now()】同一毫秒并发添加两条会得到相同 id：
 * 定时任务里 `sched:remove` 按 id 找定时器，撞号就会删错/只删一条；
 * 快捷启动与命令收藏同理。时间戳 + 进程内自增序号即可彻底避免。 */
let _localIdSeq = 0;
function nextLocalId(prefix) {
  return prefix + Date.now() + '-' + (++_localIdSeq);
}

handle(CH.SCHED.ADD, (e, s) => {
  const clean = normSchedule(s);
  clean.id = nextLocalId('sc');
  const list = storeGet('settings.schedules', []);
  list.push(clean);
  storeSet('settings.schedules', list);
  armSchedule(clean, false);
  return list;
});
handle(CH.SCHED.REMOVE, (e, id) => {
  const t = schedTimers.get(id);
  if (t) { clearTimeout(t.timeout); if (t.interval) clearInterval(t.interval); schedTimers.delete(id); }
  const list = storeGet('settings.schedules', []).filter(x => x.id !== id);
  storeSet('settings.schedules', list);
  return list;
});

/* ================= 一次性定时（睡眠 / 锁屏）=================
 *
 * 【为什么放主进程而不是渲染层】
 * 原来睡眠/锁屏靠页面的 setInterval 计时，而 App.onCleanup 在切页时会清掉它：
 * 用户设了「30 分钟后睡眠」→ 切到别的工具页 → 回来发现倒计时没了、
 * 睡眠也不会发生。同一个卡片里关机/重启走系统 shutdown 计划（切页不影响），
 * 两种行为不一致最容易让用户不信任。
 *
 * 【存什么】{ id, action: 'sleep'|'lock', fireAt: <ms>, label }
 * 持久化到 settings.schedulesOnce，重启应用后依然生效（与周期任务一致）。
 * 【恢复时怎么处理过期项】启动时若 fireAt 已过去（应用关着的时候到点了），
 * 直接执行一次并移除 —— 用户的意图是"到那个时刻做这件事"，
 * 悄悄跳过比晚一点执行更让人困惑。但超过 12 小时的不再补执行
 * （昨天设的睡眠，今天启动时突然把电脑睡掉是惊吓，不是服务）。 */
const ONCE_CATCHUP_MS = 12 * 3600 * 1000;
const schedOnceTimers = new Map(); // id -> timeout

function onceActionLabel(a) { return a === 'lock' ? '锁屏' : '睡眠'; }

function runOnceAction(action) {
  try {
    if (action === 'lock') {
      spawnDetached('rundll32.exe', ['user32.dll,LockWorkStation']);
    } else {
      spawnDetached('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
    }
  } catch (e) { console.warn('[sched] 一次性定时执行失败：', fmtErr(e)); }
}

function armOnce(item) {
  const old = schedOnceTimers.get(item.id);
  if (old) clearTimeout(old);
  const delay = Math.max(0, Number(item.fireAt) - Date.now());
  /* setTimeout 的上限是 2^31-1 ms（约 24.8 天）。超过就分段重挂，
   * 否则 Node 会把它当成 1ms 立刻触发 —— 那是灾难性误触发。 */
  const MAX = 2147483647;
  const step = Math.min(delay, MAX);
  const t = setTimeout(() => {
    if (Date.now() < Number(item.fireAt)) { armOnce(item); return; }
    runOnceAction(item.action);
    /* 执行完就从表里清掉：一次性任务不该留在列表里 */
    const list = storeGet('settings.schedulesOnce', []).filter((x) => x.id !== item.id);
    storeSet('settings.schedulesOnce', list);
    schedOnceTimers.delete(item.id);
    /* 事件名直接用字面量：它是**推送**（send），不需要注册 handle，
     * 所以不进 CH 通道表（表里只登记可调用的 handle 通道）。
     * 渲染层用 window.api.on('sched:once-fired', …) 订阅。 */
    send('sched:once-fired', { id: item.id, action: item.action });
  }, step);
  schedOnceTimers.set(item.id, t);
}

/** 启动/新增后统一挂一遍，并处理"应用关着的时候到点了"的过期项。 */
function armOnceAll() {
  const list = storeGet('settings.schedulesOnce', []);
  const keep = [];
  const now = Date.now();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || !item.id || !item.fireAt) continue;
    if (Number(item.fireAt) <= now) {
      if (now - Number(item.fireAt) <= ONCE_CATCHUP_MS) runOnceAction(item.action);
      continue;   // 已过期：补执行（或放弃）后不再挂
    }
    keep.push(item);
    armOnce(item);
  }
  if (keep.length !== list.length) storeSet('settings.schedulesOnce', keep);
  return keep;
}

handle(CH.SCHED.ONCE_LIST, () => storeGet('settings.schedulesOnce', []));
handle(CH.SCHED.ONCE_ADD, (e, payload) => {
  const p = payload || {};
  const action = p.action === 'lock' ? 'lock' : 'sleep';
  const mins = Number(p.minutes);
  if (!Number.isFinite(mins) || mins < 1 || mins > 60 * 24 * 7) {
    throw new Error('定时时长不合法（1 ~ 10080 分钟）');
  }
  const item = {
    id: nextLocalId('so'),
    action,
    fireAt: Date.now() + Math.round(mins * 60000),
    label: onceActionLabel(action),
  };
  const list = storeGet('settings.schedulesOnce', []);
  list.push(item);
  storeSet('settings.schedulesOnce', list);
  armOnce(item);
  return { item, list };
});
handle(CH.SCHED.ONCE_REMOVE, (e, id) => {
  const t = schedOnceTimers.get(id);
  if (t) { clearTimeout(t); schedOnceTimers.delete(id); }
  const list = storeGet('settings.schedulesOnce', []).filter((x) => x.id !== id);
  storeSet('settings.schedulesOnce', list);
  return list;
});

/* ================= IPC: 7z 压缩包内容预览 ================= */
handle(CH.SEVEN.LIST, async (e, { archive, password }) => {
  const bin = findSevenFull() || sevenZa;
  if (!bin) throw new Error('未找到 7z 引擎');
  const args = ['l', '-bd', '-slt'];
  args.push(sevenPwdArg(password));
  args.push(archive);
  const r = await runCmd(bin, args, { timeout: 60000 });
  if (r.code !== 0) throw new Error('读取压缩包失败：' + (r.stderr || r.stdout).split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' '));
  const rows = [];
  let cur = null;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^(Path|Size|Attributes) = (.*)$/);
    if (!m) continue;
    if (m[1] === 'Path') { if (cur) rows.push(cur); cur = { path: m[2], size: 0, attr: '' }; }
    else if (cur && m[1] === 'Size') cur.size = Number(m[2]) || 0;
    else if (cur && m[1] === 'Attributes') cur.attr = m[2];
  }
  if (cur) rows.push(cur);
  return { entries: rows.filter(x => x.path), total: rows.length };
});

/* ================= IPC: 笔记导出 PDF（离屏渲染 printToPDF） =================
 *
 * 【三个必须处理的点】
 * ① 离屏窗口要关掉 JS。它渲染的是用户笔记正文，不该执行脚本；
 *    printToPDF 本身不需要 JS（布局是纯 CSS）。
 * ② 不能靠固定 300ms 等"渲染完成"。笔记里带本地图片时，300ms 内图片
 *    可能还没解码完，导出的 PDF 里图片是空白 —— 慢机器更容易命中。
 *    改成等 did-finish-load + 所有 <img> 解码完成，再设一个硬超时兜底。
 * ③ 原始 html 直接拼进 data: URL 等于让任意脚本进入这个文档。
 *    净化放在主进程：剥掉 <script>、事件属性、javascript: 协议。
 *    不能假设上游（渲染层）一定净化过 —— 那是另一个进程的承诺。 */
function sanitizeNoteHtml(html) {
  let s = String(html == null ? '' : html);
  /* 剥 script/style 整块（style 里可能有 expression() 之类的老 IE 手法，
   * 现代 Chromium 不认，但剥掉更省心；保留 style 的属性写法不影响排版）。 */
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  s = s.replace(/<script\b[^>]*\/?>/gi, '');
  s = s.replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, '');
  s = s.replace(/<object\b[\s\S]*?<\/object\s*>/gi, '');
  s = s.replace(/<embed\b[^>]*\/?>/gi, '');
  /* 事件属性：onclick / onerror / onload …（引号可以是单/双/无） */
  s = s.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  /* javascript: / vbscript: / data:text/html 协议。
   * 【回调必须按 (whole, attr, offset, str) 取值，不要取 val】
   * 上面那条正则只有 **两个捕获组**：(href|src|action) 与……没有第二个 ——
   * 引号部分写的是 `"[^"]*"|'[^']*'|[^\s>]+` 的**交替**，整体在外层非捕获
   * 结构里。于是回调的第三个参数是 match offset（一个数字），
   * 不是属性值 —— 之前误当成 val 来判，`v` 恒为 "3"，永远不命中，
   * javascript: 就一路放行（实测抓到的）。
   * 现在统一从 whole 里再切一次值，不依赖回调参数个数。 */
  s = s.replace(/\b(href|src|action)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, function (whole, attr) {
    const eq = whole.indexOf('=');
    const raw = eq >= 0 ? whole.slice(eq + 1) : '';
    const v = raw.replace(/^["']|["']$/g, '').trim().toLowerCase();
    if (/^(?:javascript|vbscript)\s*:/.test(v) || /^data\s*:\s*text\/html/.test(v)) return attr + '="#"';
    return whole;
  });
  return s;
}

handle(CH.NOTES.PDF, async (e, { title, html, outPath }) => {
  let outFile = outPath || '';
  if (!outFile) {
    const out = await dialog.showSaveDialog(win || null, { defaultPath: (title || '笔记') + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (out.canceled || !out.filePath) return null;
    outFile = out.filePath;
  }
  /* sandbox:true + javascript:false + 无 preload —— 这个窗口只是排版器，
   * 不需要任何脚本能力。加上之后即使净化漏掉一处，也没有执行面。 */
  const bw = hardenWindow(new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false }
  }));
  try {
    const safeHtml = sanitizeNoteHtml(html);
    const safeTitle = String(title || '').replace(/[<>]/g, '');
    await bw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head>` +
      `<body style="max-width:720px;margin:32px auto;font-family:'Microsoft YaHei',sans-serif;line-height:1.75;font-size:14px;color:#222">` +
      `${safeHtml}</body></html>`));
    /* 【等图片解码完，不要睡 300ms】
     * javascript:false 之后 executeJavaScript 还能不能用？
     * 能 —— 关的是页面自己的脚本，主进程通过调试协议注入仍然有效。
     * 这里注入的是一段"等所有图 decode() 完成"的 Promise，最多等 8 秒；
     * 失败/超时都不阻断导出（宁可少一张图，也不要整次导出失败）。 */
    await bw.webContents.executeJavaScript(
      `Promise.race([
        Promise.all(Array.from(document.images).map(function (i) {
          return i.decode ? i.decode().catch(function () {}) : Promise.resolve();
        })),
        new Promise(function (r) { setTimeout(r, 8000); })
      ]).then(function () { return true; })`
    ).catch(() => {});
    /* 再等一帧让布局稳定（比固定 300ms 短得多，而且有确定依据） */
    await new Promise(r => setTimeout(r, 80));
    const buf = await bw.webContents.printToPDF({ printBackground: true, margins: { marginType: 'default' } });
    // 用原子写：writeFileSync 是 O_TRUNC 覆盖，导出中途磁盘满/进程被杀
    // 会把用户原有的那份 PDF 截断成半截甚至空文件。
    await writeFileAtomic(outFile, buf);
    return { out: outFile, size: buf.length };
  } finally { bw.destroy(); }
});

/* ================= IPC: 剪贴板图片转文件（防 store JSON 膨胀） ================= */
handle(CH.CLIP.SAVE_IMAGE, async (e, dataUrl) => {
  const dir = path.join(app.getPath('userData'), 'clip-img');
  await fsp.mkdir(dir, { recursive: true });
  const name = 'clip-' + Date.now() + '-' + (++clipImgSeq) + '.png';
  await fsp.writeFile(path.join(dir, name), Buffer.from(dataUrl.split(',')[1] || '', 'base64'));
  return { path: path.join(dir, name) };
});
let clipImgSeq = 0;
// 删除剪贴板历史图片文件。只允许删 clip-img 目录内的文件，防止越权删除任意路径
const clipImgDir = () => path.join(app.getPath('userData'), 'clip-img');
function isClipImgPath(p) {
  try {
    const abs = path.resolve(p), dir = path.resolve(clipImgDir());
    return abs.startsWith(dir + path.sep) && /\.png$/i.test(abs);
  } catch (e) { return false; }
}
handle(CH.CLIP.REMOVE_IMAGES, async (e, files) => {
  let removed = 0, failed = 0;
  for (const f of (Array.isArray(files) ? files : [files])) {
    if (!f || !isClipImgPath(f)) { failed++; continue; }
    try { await fsp.unlink(f); removed++; } catch (err) { if (err.code !== 'ENOENT') failed++; }
  }
  return { removed, failed };
});
// 孤儿图片清扫：store 里已无引用的 clip-img 文件（崩溃/旧版本遗留）
/* clip:gc-images 通道已移除：全项目无调用方 —— 孤图清扫在启动时由
 * sweepClipImages()（lifecycle 里调用）执行，那条路径有同样的两道保护，
 * 没必要再对外保留一个「删剪贴板图片」的可达入口。 */

/* ================= IPC: Win11 经典右键菜单切换 ================= */
// Win11 的右键菜单由 CLSID {86ca1aa0-34aa-4e8b-a509-50c905bae2a2} 这个 COM 处理器负责。
// 在 HKCU 里为它建一个空的 InprocServer32 子键（默认值留空），COM 激活时找不到实现，
// 资源管理器就回落到 Win10 经典菜单。这是社区验证过的唯一有效做法。
// 早前写成 \InnoServerSetup —— 那个子键名不存在于任何已知做法，对 COM 激活毫无影响，
// 于是写了个废键、UI 却报“已切换”，状态检测又只查父键是否存在，三处全是假阳性。
// reg.exe **支持** HKCU\ 简写（实测 add/query/delete 都正常），
// 这里用全称只是为了输出可读、与 HKCR 那套解析保持一致。
// 曾经误判成「reg 不认简写」—— 那是因为当时查的键正好不存在，
// 把 "系统找不到指定的注册表项" 误读成了 "Invalid key name"。
const WIN11_CTX_KEY = 'HKEY_CURRENT_USER\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}';
const WIN11_CTX_HANDLER = WIN11_CTX_KEY + '\\InprocServer32';
handle(CH.CTXMENU.CLASSIC, async (e, on, restart) => {
  if (on) {
    // /ve /d "" /f：建 InprocServer32 并把默认值显式置为空字符串（不置空则可能继承旧值）
    await runCmd('reg', ['add', WIN11_CTX_HANDLER, '/ve', '/t', 'REG_SZ', '/d', '', '/f'], { timeout: 10000 });
  } else {
    // 只删我们建的处理器子键，保留系统原始的 CLSID 键
    await runCmd('reg', ['delete', WIN11_CTX_HANDLER, '/f'], { timeout: 10000 }).catch(() => {});
  }
  if (restart) {
    spawnDetached('taskkill', ['/f', '/im', 'explorer.exe']);
    /* 【不能只靠 try/catch】explorer.exe 找不到时 spawn 是**异步** emit 'error'，
     * 外面这层 try/catch 接不到 —— 一次「恢复右键菜单」的收尾动作会把主进程带崩。
     * opts 里的 detached 保留（explorer 要脱离本进程存活）。 */
    setTimeout(() => { spawnDetached('explorer.exe', [], { detached: true }); }, 800);
  }
  return { on: await ctxClassicState() };
});
// 真正的判据是 InprocServer32 存在且默认值为空——只看父键存在会把
// 系统自带的那个 CLSID 也算成“经典模式”，永远显示已开启。
//
// 解码注意：reg.exe 按系统 ANSI 代码页输出，中文环境下 (默认) 那一行必须按 gbk 解，
// 用 utf8 解会得到乱码（但 REG_SZ 关键字仍可匹配，容易让人以为没问题）。
async function ctxClassicState() {
  try {
    const r = await runCmd('reg', ['query', WIN11_CTX_HANDLER, '/ve'], { timeout: 8000, encoding: 'gbk' });
    if (r.code !== 0) return false;
    // 输出形如：    (默认)    REG_SZ    <值>
    // 值为空时该行末尾没有内容，视为“已禁用 COM 处理器” = 经典菜单
    const line = String(r.stdout || '').split(/\r?\n/).find(l => /REG_SZ/i.test(l));
    if (!line) return false;
    return line.replace(/.*REG_SZ\s*/i, '').trim() === '';
  } catch (e) { return false; }
}
handle(CH.CTXMENU.CLASSIC_STATUS, async () => ({ on: await ctxClassicState() }));

/* ============ 目录搬家 + 权限/链接 两个域（任务 5 搬到 ipc/dir-acl-links.js）============
 * dir:move 的实现也在那个模块里（历史原因见该文件头部）。
 * 这两个域原来在这里占 1561 行。搬走之后 main.js 只留这一处注册调用。
 *
 * 【为什么传 deps 而不是让模块自己 require】
 * handle 带着统一的高危门禁与结构化错误包装，ps / runCmd / pathExists 是
 * main.js 的通用实现（runCmd 的「非零不抛」语义被几十处依赖）。让模块
 * 自己再写一份必然分叉 —— 所以显式传入。
 *
 * 【返回值只取 isRunningAsAdmin】sys:disk-health 留在 main.js（它与
 * disk-health 缓存、硬件面板耦合更紧），但需要管理员判定。
 * 其余 20 个函数搬走后 main.js 已无调用方，不导出（导出越多越容易被顺手引用，
 * 又把耦合接回去）。 */
const aclLinks = require('./ipc/dir-acl-links')(ipcCtx, {
  handle,
  /* 同 mediaIpc：必须用 ALS 版 send，否则「目录搬家」的 7 个阶段进度
   * 只会发给主窗口，独立工具窗口里点了没反应。 */
  send,
  ps,
  runCmd,
  pathExists,
  shortErr,
  PS_PATH_BATCH,
  /* 「文件占用解锁」要用同一个结束进程实现 —— 安全判据只此一份。
   * 注入函数而不是让它自己 taskkill：那样白名单与低 PID 拦截会变成两份。 */
  killProc: killProcessChecked,
});
const isRunningAsAdmin = aclLinks.isRunningAsAdmin;

/* ================= 启动清扫（临时文件 / 孤儿录制目录 / 孤儿剪贴板图片） ================= */
// 截图临时 PNG 与录制分段是「写一次就丢」的产物；崩溃或强杀会留下残骸。
// 只在启动时清一次，且按 mtime 保留最近的，避免误删正在进行的会话。
// 只处理本应用自己的临时产物（hehe- 前缀白名单），绝不整目录清空。
async function sweepTempFiles(maxAgeMs = 24 * 3600 * 1000) {
  const tmp = app.getPath('temp');
  const now = Date.now();
  let removed = 0;
  const entries = await fsp.readdir(tmp).catch(() => []);
  for (const n of entries) {
    if (!isOwnTempName(n)) continue;
    const full = path.join(tmp, n);
    try {
      const st = await fsp.stat(full);
      if (now - st.mtimeMs <= maxAgeMs) continue; // 最近的保留
      if (st.isDirectory()) await fsp.rm(full, { recursive: true, force: true });
      else await fsp.unlink(full);
      removed++;
    } catch (e) {}
  }
  return removed;
}
/* 文档预览的转换产物清扫：doc-preview 每预览一个 Office 文档，
 * 就会在 userData/preview-tmp 下留一份 LibreOffice 转出的 PDF
 * （渲染层 office.js 的 preview() 把 outDir 指到这里，预览完没人删）。
 * 几次预览体积不大，但 PPT/大 Word 转出的 PDF 可能几十 MB，
 * 长期使用会一直堆积。清扫按 mtime 保留 24 小时内的 ——
 * 正在预览的那份不会被误删（刚转换出来的文件 mtime 是新的）。 */
async function sweepPreviewTmp(maxAgeMs = 24 * 3600 * 1000) {
  const dir = path.join(app.getPath('userData'), 'preview-tmp');
  const now = Date.now();
  let removed = 0;
  let entries;
  try { entries = await fsp.readdir(dir); } catch (e) { return 0; }
  for (const n of entries) {
    const full = path.join(dir, n);
    try {
      const st = await fsp.stat(full);
      if (now - st.mtimeMs <= maxAgeMs) continue;
      await fsp.rm(full, { force: true });
      removed++;
    } catch (e) {}
  }
  return removed;
}

async function sweepClipImages() {
  // 依赖 store 已加载：删掉 clipHistory 里已无引用的图片文件
  // store 没读出来时 clipHistory 是空数组，used 为空 → 所有图片都被判成孤儿。
  // 这种情况下宁可一个都不删（留点垃圾可以接受，把用户剪贴板历史删光不行）。
  if (storeLoadFailed) { console.warn('[sweep] store 加载失败，跳过孤儿剪贴板图片清扫'); return 0; }
  // JSON 解析成功但缺 clipHistory 字段（手工编辑/旧版本升级）时同样会删光，必须单独判断。
  const hist = storeGet('clipHistory', null);
  if (!Array.isArray(hist)) { console.warn('[sweep] clipHistory 缺失或类型异常，跳过清扫'); return 0; }
  // 历史里一条图片引用都没有、而目录里确实有图片：几乎肯定是数据异常，不清理
  const hasImgRef = hist.some(it => it && it.file);
  try {
    const dir = path.join(app.getPath('userData'), 'clip-img');
    const names = await fsp.readdir(dir);
    const pngs = names.filter(n => /\.png$/i.test(n));
    if (!hasImgRef && pngs.length > 0) {
      console.warn('[sweep] clipHistory 里没有任何图片引用，但 clip-img 有', pngs.length, '个文件，跳过清扫');
      return 0;
    }
    const used = new Set();
    for (const it of hist) {
      if (it && it.file) used.add(path.resolve(it.file));
    }
    let removed = 0;
    for (const n of pngs) {
      const full = path.resolve(path.join(dir, n));
      if (used.has(full)) continue;
      try { await fsp.unlink(full); removed++; } catch (e) {}
    }
    return removed;
  } catch (e) { return 0; }
}

/* ================= lifecycle ================= */
// 测试隔离：HEHE_TEST_DATA 指定独立的 userData 目录（不影响正式数据与单实例锁）
if (process.env.HEHE_TEST_DATA) app.setPath('userData', process.env.HEHE_TEST_DATA);
const gotLock = app.requestSingleInstanceLock();
/* 拿不到锁 = 已经有一个实例在跑（用户重复点了图标 / 双击了多次）。
 *
 * 【踩过的坑】原来这里直接 `app.quit()` 静默退出，用户看到的现象就是
 * 「双击了没反应、打不开了」—— 应用其实一直在后台好好跑着，只是新进程悄悄退了。
 *
 * 【为什么不在这个分支弹对话框】实测：拿不到锁时 **app.whenReady() 不会 resolve**
 * （没有窗口、没有挂起句柄，进程直接自然退出，退出码 0）。
 * 所以 dialog.showMessageBoxSync / whenReady().then(...) 全都执行不到，
 * 加了等于没加。已验证：加框前后行为完全一样，都是一瞬间静默退出。
 *
 * 【正确做法】反馈交给**主实例**做 —— 它有窗口、有渲染层，能真正把界面亮出来：
 *   主实例收到 second-instance → 还原/显示窗口 → 再给一条 toast 说明。
 * 第二个进程只负责把事件转发出去然后退出，这是 Electron 的标准模式。
 */
if (!gotLock) {
  app.quit();
} else {
  /* 第二个实例被拉起时，主实例收到这个事件：把窗口提到前面 + 说明原因。
   * 注意 whenReady() 之前也可能收到（启动瞬间又被双击一次），此时还没有 win，
   * showMainWindow → createWindow，而 createWindow 依赖 app ready。
   * 所以套一层 ready 判断，没就绪就等就绪后再显示，避免抛异常。 */
  const onSecondInstance = () => {
    if (app.isReady()) {
      showMainWindow();
      // 窗口已经可见时再给一条 toast：用户双击图标至少能看到"有反应"
      send('app:already-running', {});
    } else {
      app.whenReady().then(() => { showMainWindow(); send('app:already-running', {}); }).catch(() => {});
    }
  };
  app.on('second-instance', onSecondInstance);
  app.whenReady().then(() => {
    bootMark('app-ready');
    /* ---- 会话标记：判断上次是不是异常退出 ----
     * 顺序很关键：**先读旧标记、再写新标记**。
     * 反过来的话会读到刚写的那份，永远判定"正常"。
     *
     * 判断依据是「标记存在」而不是「日志非空」：进程被系统强杀时
     * 异常处理器来不及执行，日志里是空的，但标记一定还在。
     * 用户最常报的「它自己关了」正好属于这一类。
     *
     * 冒烟测试（HEHE_SMOKE）与多次启动并存时不写标记：
     * 测试进程是脚本杀死的，会污染下次真实启动的判定。 */
    if (!process.env.HEHE_SMOKE) {
      try {
        const prev = crashLog.readMarker(crashLogDir());
        lastSessionCrashed = !!prev;
        if (lastSessionCrashed) {
          recordCrash('previous-session-abnormal-exit', {
            detail: '上次会话没有走完正常退出流程（可能是被系统终止、断电或崩溃）。' +
              '上次启动时间：' + (prev && prev.startedAt ? prev.startedAt : '未知')
          });
        }
        crashLog.writeMarker(crashLogDir(), {
          startedAt: new Date().toISOString(),
          pid: process.pid,
          version: app.getVersion(),
          electron: process.versions.electron
        });
      } catch (e) { /* 标记失败不能挡住启动 */ }
    }
    loadStore();
    bootMark('store-loaded');
    // themeSource 必须在建窗之前设置：主窗的 backgroundColor 和启动窗的明暗
    // 都直接读 nativeTheme.shouldUseDarkColors，设晚了会按系统默认值画一帧再跳变。
    nativeTheme.themeSource = storeGet('settings.theme', 'system');
    createSplash(); // 配置读完后起启动窗（要用到用户选的配色），页面极小，抢在加载主界面前画出进度
    splashSend('splash:step', { pct: 62, label: '读取配置…' });
    createWindow();
    splashSend('splash:step', { pct: 70, label: '加载界面…' });
    createTray();
    // 启动清扫：延迟执行，不阻塞窗口首帧
    setTimeout(() => {
      Promise.all([sweepTempFiles(), sweepClipImages(), sweepPreviewTmp()])
        .then(([n1, n2]) => { if (n1 || n2) console.log('[sweep] 清理临时文件', n1, '个，孤儿剪贴板图片', n2, '个'); })
        .catch(() => {});
    }, 4000);
    applyHotkey(storeGet('settings.hotkey', 'Alt+Shift+H'));
    /* 周期任务（每日提醒/循环提醒/自动清理）。
     * 【必须等渲染层加载完再武装 loop 任务】
     * armSchedule(s, false) 会对 loop 类型立即 schedFire(s) 一次，作为
     * 「设置生效了」的确认提示；而 schedFire → send('sched:fire', …) 只检查
     * win 是否存在，不检查页面是否已加载完。
     * 这里被调用时 createWindow() 里的 loadFile 还在异步进行 —— 那条确认提示
     * 发出去时渲染层还没有订阅 sched:fire，用户永远看不到。
     * 表现为「添加了循环提醒，重启后没有任何反馈」，像是没生效。
     * 改成等 did-finish-load 之后再武装；若已经加载完（从托盘重建窗口等），
     * 直接武装。 */
    if (win && !win.webContents.isLoading()) {
      armAllSchedules();
    } else if (win) {
      win.webContents.once('did-finish-load', () => { try { armAllSchedules(); } catch (e) {} });
    }
    /* 【一次性定时（睡眠/锁屏）不等渲染层】
     * 它执行的是主进程动作（rundll32），不依赖 toast 订阅 ——
     * 所以立刻武装，包括处理"应用关着的时候到点了"的过期项。 */
    try { armOnceAll(); } catch (e) { console.warn('[sched] 一次性定时恢复失败：', fmtErr(e)); }
    /* 启动时自动检查更新（设置 → 通用 → 启动时自动检查更新，**默认关**）。
     *
     * 【为什么默认关】本项目一直把「检查更新」做成手动（设置→关于→检查更新）。
     * 改成默认开会给所有用户增加一次后台网络请求，属于行为变更 ——
     * 按本项目的规矩，行为变更要用户明确要求。所以做成开关，默认保持原样。
     *
     * 【为什么延迟 8 秒】启动瞬间窗口还在建、首帧还没画完。
     * 这时候发网络请求会和 UI 抢资源；而且检查结果要推给渲染层，
     * 渲染层此时可能还没订阅。8 秒足够首帧完成，用户也感觉不到延迟。
     *
     * 【静默失败】自动检查失败不弹任何提示 —— 用户没主动点，不该被打扰。
     * 只在控制台留一行，排障时能查到。 */
    if (prefsGet('updateCheckOnStart') === true) {
      setTimeout(() => {
        try {
          updateCheckImpl({ force: false }).then((r) => {
            if (r && r.hasUpdate) send('update:available', r);
          }).catch((e) => { console.log('[update] 启动自动检查失败（静默）', e && e.message); });
        } catch (e) { /* 不阻塞启动 */ }
      }, 8000);
    }
// 冒烟测试：遍历全部工具页 + 非工具视图，捕获渲染异常 + 校验关键布局。
// 注意：主窗启动时 show:false，隐藏窗口里 requestAnimationFrame 不触发，
// 所以这里用 setTimeout(0) 让出事件循环（渲染同步完成，无需长等待）。
if (process.env.HEHE_SMOKE) {
  setTimeout(async () => {
    try {
      const r = await win.webContents.executeJavaScript(`(async () => {
        const errs = [];
        const tick = () => new Promise(res => setTimeout(res, 0));
        for (const t of window.Registry.all) {
          try { window.App.openTool(t.id); await tick(); } catch (e) { errs.push(t.id + ': ' + e.message); }
        }
        for (const v of ['home', 'fav', 'settings']) {
          try { window.App.showView({ type: v }); await tick(); } catch (e) { errs.push('view:' + v + ': ' + e.message); }
        }
        // 兼容路由：'about' 已并入设置的「关于」分区，仍应能正常渲染而不是白屏
        try { window.App.showView({ type: 'about' }); await tick(); } catch (e) { errs.push('view:about: ' + e.message); }
        // 布局校验：页面不抛异常 ≠ 布局没崩。
        // 之前出现过 CSS 出问题时「页面渲染成功但排版全乱」（元素失去 block/flex），
        // 只查异常完全测不出来，所以这里补上关键布局属性的断言。
        const styleErrs = [];
        const expect = (sel, prop, want, label) => {
          const el = document.querySelector(sel);
          if (!el) { styleErrs.push(label + ': 找不到 ' + sel); return; }
          const got = getComputedStyle(el)[prop];
          if (got !== want) styleErrs.push(label + ': ' + sel + ' 的 ' + prop + ' 应为 ' + want + '，实际 ' + got);
        };
        window.App.showView({ type: 'home' });
        await tick();
        expect('.home-hero h1', 'display', 'block', '首页标题');
        expect('.home-hero p', 'display', 'block', '首页副标题');
        // 首页现在是「搜索主导」：主入口是 .hs-input，分类是 .home-cat 紧凑条。
        // .tool-card / .tool-grid 仍在模块页与收藏页使用，所以下面单独去模块页断言，
        // 不能再在首页上找它们（首页已不渲染工具卡片网格）。
        expect('.home-search .hs-input', 'display', 'inline-block', '首页搜索框');
        expect('.home-cat', 'display', 'flex', '首页分类条');
        expect('.home-cats', 'display', 'grid', '首页分类网格');
        const catIcon = document.querySelector('.home-cat .hc-icon');
        if (catIcon && !catIcon.querySelector('svg')) styleErrs.push('分类条图标缺失');
        // 搜索交互：输入后结果区必须出现、分类区必须让位
        const hsInp = document.querySelector('.hs-input');
        if (hsInp) {
          hsInp.value = '压缩';
          hsInp.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(res => setTimeout(res, 260));
          const resBox = document.querySelector('.home-results');
          const browseBox = document.querySelector('.home-browse');
          if (!resBox || !resBox.classList.contains('show')) styleErrs.push('首页搜索后结果区未出现');
          if (browseBox && getComputedStyle(browseBox).display !== 'none') styleErrs.push('首页搜索后分类区未让位');
          const rowCount = document.querySelectorAll('.home-results .hs-row').length;
          if (rowCount === 0) styleErrs.push('搜索「压缩」无结果行');
          hsInp.value = '';
          hsInp.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(res => setTimeout(res, 260));
        }
        // 工具卡片网格改到模块页验证（首页已不再渲染它）
        window.App.showView({ type: 'module', moduleId: 'file' });
        await tick();
        expect('.tool-card', 'display', 'flex', '工具卡片');
        expect('.tool-card .tc-name', 'display', 'block', '卡片标题');
        expect('.tool-card .tc-desc', 'display', 'block', '卡片描述');
        expect('.tool-grid', 'display', 'grid', '工具网格');
        const icon = document.querySelector('.tool-card .tc-icon');
        if (icon && getComputedStyle(icon).width !== '38px') styleErrs.push('卡片图标尺寸异常: ' + getComputedStyle(icon).width);
        // 卡片顺序：模块页渲染出来的顺序必须与 Registry.ORDER 一致。
        // ORDER 是手写的，写成「相邻同类」的意图如果被改坏，界面上看不出来 ——
        // 卡片还是那些卡片，只是顺序乱了。这里逐模块比对渲染顺序与表内顺序。
        /* 【比较基准必须与渲染取值一致】v0.4.2 起卡片标题走 Registry.toolName()
         * （英文界面取 nameEn），而这段冒烟原来直接拿 t.name 比 —— 只要界面语言
         * 不是中文就会全部「顺序不一致」。冒烟跑在默认语言下，所以本地看不出来，
         * CI 上才暴露。修法：两边都走同一个取值函数。 */
        const orderMismatch = [];
        for (const m of window.Registry.MODULES) {
          window.App.showView({ type: 'module', moduleId: m.id });
          await tick();
          const rendered = [...document.querySelectorAll('.tool-card .tc-name')].map(e => e.textContent.trim());
          const want = window.Registry.byModule(m.id).map(t => window.Registry.toolName(t));
          if (rendered.length !== want.length) {
            orderMismatch.push(m.id + ': 卡片数 ' + rendered.length + ' ≠ ' + want.length);
          } else if (rendered.join('|') !== want.join('|')) {
            orderMismatch.push(m.id + ': 渲染顺序与 ORDER 不一致');
          }
          // 未登记的工具会排到末尾（靠 MAX_SAFE_INTEGER 兜底），这属于设计疏漏
          if (!window.Registry.ORDER[m.id]) orderMismatch.push(m.id + ': 没有 ORDER 分组');
        }
        orderMismatch.forEach(x => styleErrs.push('卡片顺序 ' + x));
        // 标题栏窗口按钮必须贴右边缘（各视图都要）。
        // 首页会隐藏 .search-wrap，原来靠它的 flex:1 撑开右侧；一旦它消失，
        // 最小化/最大化/关闭就紧贴面包屑跑到左半边。这类「只在一个视图下坏」
        // 的布局问题必须逐视图断言，只看首页或只看工具页都会漏。
        for (const view of [{ type: 'home' }, { type: 'module', moduleId: 'file' }, { type: 'settings' }]) {
          window.App.showView(view);
          await tick();
          const tb = document.querySelector('.tb-right');
          if (!tb) { styleErrs.push('标题栏按钮容器缺失 @' + view.type); continue; }
          const r = tb.getBoundingClientRect();
          const gap = window.innerWidth - r.right;
          if (gap > 24) styleErrs.push('标题栏按钮未贴右 @' + view.type + '：距右边缘 ' + Math.round(gap) + 'px');
          if (r.width === 0) styleErrs.push('标题栏按钮不可见 @' + view.type);
        }
        window.App.showView({ type: 'settings' });
        await tick();
        expect('.settings-wrap', 'display', 'flex', '设置布局');
        expect('.settings-nav', 'width', '180px', '设置导航宽度');
        expect('.settings-nav-item', 'display', 'block', '设置导航项');
        // CSS 是否被完整解析（解析中断会让后续规则全部失效）
        const sheet = [...document.styleSheets].find(s => (s.href || '').includes('app.css'));
        let ruleCount = -1;
        try { ruleCount = sheet ? sheet.cssRules.length : -1; } catch (e) {}
        if (ruleCount < 250) styleErrs.push('app.css 规则数异常（可能解析中断）: ' + ruleCount);
        return { total: window.Registry.all.length, errs, styleErrs, ruleCount };
      })()`, true);
      const fail = (r.errs.length || r.styleErrs.length) ? 1 : 0;
      console.log('SMOKE_RESULT: pages=' + r.total + ' cssRules=' + r.ruleCount + ' ' + (fail ? 'FAIL' : 'PASS'));
      r.errs.forEach(e => console.log('SMOKE_RESULT: FAIL ' + e));
      r.styleErrs.forEach(e => console.log('SMOKE_RESULT: LAYOUT ' + e));

      /* 辅助窗口校验：snip / pin / ruler 三个窗口没有主界面的冒烟覆盖，
       * 但它们也承载功能（截图标注、贴图、标尺）。尤其是加了 CSP 之后，
       * 必须确认「脚本仍能跑、本地图片仍能加载」，否则等于把功能改坏。
       * 用主进程创建窗口（与产品实际路径一致），检查 CSP 是否生效、
       * 内联脚本是否被执行。 */
      let auxFail = 0;
      for (const f of ['snip.html', 'pin.html', 'ruler.html']) {
        let aux = null;
        try {
          aux = hardenWindow(new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { offscreen: false } }));
          await aux.loadFile(f);
          await new Promise((res) => setTimeout(res, 300));
          const info = await aux.webContents.executeJavaScript(
            'JSON.stringify({scripts: document.querySelectorAll("script").length,' +
            ' csp: !!document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\'),' +
            ' bodyKids: document.body.children.length})'
          );
          const o = JSON.parse(info);
          if (!o.csp) { console.log('SMOKE_RESULT: AUX ' + f + ' 缺少 CSP'); auxFail++; }
          if (o.scripts < 1) { console.log('SMOKE_RESULT: AUX ' + f + ' 内联脚本未加载'); auxFail++; }
          if (o.bodyKids < 1) { console.log('SMOKE_RESULT: AUX ' + f + ' 页面主体为空（可能被 CSP 拦死）'); auxFail++; }
          else console.log('SMOKE_RESULT: AUX ' + f + ' OK (scripts=' + o.scripts + ', csp=on)');
        } catch (e) {
          console.log('SMOKE_RESULT: AUX ' + f + ' ERR ' + e.message); auxFail++;
        } finally {
          try { if (aux && !aux.isDestroyed()) aux.destroy(); } catch (e) {}
        }
      }

      app.exit((fail || auxFail) ? 3 : 0);
    } catch (e) {
      console.log('SMOKE_RESULT: ERR ' + e.message);
      app.exit(3);
    }
  }, 2000);
}

if (process.env.HEHE_SHOT) {
      // 截图输出目录：开发态写到项目根，打包后 asar 内部不可写，改写到 userData
      const shotDir = (() => {
        try {
          if (!app.isPackaged) return __dirname;
          const d = path.join(app.getPath('userData'), 'shots');
          fs.mkdirSync(d, { recursive: true });
          return d;
        } catch (e) { return app.getPath('temp'); }
      })();
      setTimeout(async () => {
        try {
          if (win && !win.isDestroyed()) {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(path.join(shotDir, 'diag-shot.png'), img.toPNG());
            console.log('[shot] saved', path.join(shotDir, 'diag-shot.png'));
          }
        } catch (e) { console.error('[shot] failed:', e.message); }
      }, 8000);
      if (process.env.HEHE_OPEN && win) {
        const ids = process.env.HEHE_OPEN.split(',');
        let i = 0;
        const step = async () => {
          if (!win || win.isDestroyed()) return;
          // 拍完就退出：旧实现走完列表后进程继续挂着，一直占着单实例锁，
          // 下一次截图模式启动会被判「已在运行」直接退出 —— 这正是 0 张截图事故的成因。
          if (i >= ids.length) {
            console.log('[shot] all done, exiting');
            setTimeout(() => app.exit(0), 500);
            return;
          }
          const id = ids[i];
          try {
            if (id === 'theme-toggle') {
              const support = await win.webContents.executeJavaScript(`(() => { document.querySelectorAll('.tb-btn')[0].click(); return typeof document.startViewTransition; })()`);
              console.log('[shot] theme-toggle clicked, startViewTransition:', support);
            } else if (id.startsWith('view:')) {
              // 视图页不是注册工具，用 showView 打开（如 view:settings / view:about / view:home / view:fav）
              // view:settings/about 支持二级子页：view:settings:about
              const parts = id.slice(5).split(':');
              const base = parts[0], sub = parts[1] || null;
              await win.webContents.executeJavaScript(
                `(async () => { window.App.showView({ type: ${JSON.stringify(base)} }); ` +
                (sub ? `await new Promise(r => setTimeout(r, 300)); const it = document.querySelector('.settings-nav-item[data-sid="${sub}"]'); if (it) { it.click(); await new Promise(r => setTimeout(r, 300)); } ` : '') +
                `return 'ok'; })()`, true);
            } else {
              await win.webContents.executeJavaScript(`window.App.openTool('${id}'); 'ok'`);
            }
            await new Promise(r => setTimeout(r, 2500));
            const img = await win.webContents.capturePage();
            // Windows 文件名不允许 : \ / * ? " < > |，view:settings 会变成 NTFS 备用数据流，必须净化
            const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, '-');
            fs.writeFileSync(path.join(shotDir, `shot-${i}-${safe}.png`), img.toPNG());
            console.log('[shot]', id, 'saved', path.join(shotDir, `shot-${i}-${safe}.png`));
          } catch (e) { console.error('[shot]', id, 'failed:', e.message); }
          i++;
          setTimeout(step, 400);
        };
        setTimeout(step, 5500);
      }
    }
  });
  app.on('before-quit', () => { isQuitting = true; destroySplash(); });
  /* 走到 will-quit 说明是**正常退出**（用户点关闭 / 托盘退出 / 自动更新重启）。
   * 此时删掉会话标记，下次启动就不会误报「上次异常退出」。
   *
   * 反过来：如果进程是被强杀的，这个回调不会执行，标记留着 —— 正是我们要的信号。
   * flushStore 放在前面，确保数据先落盘；删标记失败也不影响退出。 */
  app.on('will-quit', () => {
    flushStore();
    try { crashLog.clearMarker(crashLogDir()); } catch (err) {}
    try { globalShortcut.unregisterAll(); } catch (err) {}
  });
  app.on('window-all-closed', () => { app.quit(); });
}

/* ================= 崩溃日志 =================
 *
 * 【原来这里只有一行】
 *     process.on('uncaughtException', (err) => console.error('uncaught', err));
 * 打包后的 exe 是**没有控制台**的（`console.error` 写进一个不存在的终端），
 * 所以主进程出异常时：用户看到「点了没反应」或「窗口自己没了」，
 * 而现场一个字节都没留下 —— 既没有文件，也没有界面入口，完全无法排查。
 *
 * 现在三类事件都落盘到 userData/logs/：
 *   1) 主进程未捕获异常 / 未处理的 Promise 拒绝
 *   2) 渲染进程崩溃（OOM、被杀、asar 被动过）
 *   3) 上次会话异常退出（靠 session.lock 标记，见下）
 *
 * 【为什么 uncaughtException 不能直接 app.quit()】
 * 主进程的异常大多来自**单个 IPC handler**（例如某个工具读文件失败抛了错）。
 * 立刻退出等于把 99 个正常工具一起关掉，用户会认为整个软件崩了。
 * 所以这里的策略是「记录 + 保持运行」：写日志、通知界面可查，
 * 进程继续跑。真正无法恢复的状态（渲染进程没了）由 Electron 自己处理。
 *
 * 【marker 的用途】
 * 进程被系统强杀（OOM killer / 断电 / 任务管理器）时，异常处理器
 * 根本来不及执行，日志里什么都不会有。而用户最常报的恰恰是「它自己关了」。
 * 所以启动时写一个标记、正常退出时删掉：
 * 下次启动发现标记还在 = 上次没走完退出流程 → 界面上提醒一次。 */
function recordCrash(kind, payload) {
  try {
    const entry = crashLog.formatEntry(kind, payload, {
      tempDir: os.tmpdir(),
      user: (() => { try { return os.userInfo().username; } catch (e) { return ''; } })()
    });
    /* 保留份数可配置（设置 → 通用 → 崩溃日志保留份数 1~20）。
   * 【为什么要把它传给 crash-log 而不是让那个模块自己读】
   * lib/crash-log.js 的约定是纯逻辑、不依赖全局状态（见其文件头），
   * 否则测试要先 mock 一个 store 才能验轮转。 */
  const ok = crashLog.append(crashLogDir(), entry, { keepMax: prefsGet('crashLogKeep') });
    // 写盘失败时至少退回 console —— 开发态（npm start）还看得见
    if (!ok) console.error('[crash-log]', kind, payload && payload.err);
    return ok;
  } catch (e) {
    // 记录日志本身失败绝不能再抛出，否则会形成异常循环
    console.error('[crash-log] 写入失败', e && e.message);
    return false;
  }
}

/* ============ 全局崩溃兜底 ============
 * 这两处的唯一职责是**落盘**（recordCrash），不再向渲染层推事件。
 *
 * 【为什么删掉了那段 webContents.send('app:crash-logged')】
 * 它推了整整两个版本，而渲染层从来没有任何地方订阅这个事件 ——
 * 全项目 0 个监听器。也就是说那段代码的作用是：判窗口是否还活着、
 * 拼消息、跨进程发一条没人收的消息，然后被 try/catch 吞掉。
 *
 * 危害不是"白跑几行"。它让这段兜底逻辑看起来**已经通知了用户**，
 * 于是没人再去想"用户到底怎么知道刚才崩了"。事实是：
 * 界面上唯一能看到崩溃的入口是「设置 → 崩溃日志」，
 * 那里读的是 recordCrash 写下的标记文件（见 crashLog 模块），
 * 与这个 IPC 推送毫无关系。真正在起作用的链路一直只有落盘这一条。
 *
 * 【死推送为什么难发现】
 * 推送和订阅分居两个进程，删掉一边不会有任何报错：
 * ipcRenderer.on 一个从不发的事件 = 静默无操作；
 * 发一个没人监听的事件 = 静默丢弃。两边都不会抛，
 * 也都不影响任何一条行为测试。所以由 scripts/test-ipc-channels.js
 * 做静态对账：主进程 send 的每个事件名，渲染层必须有对应订阅。
 */
process.on('uncaughtException', (err) => {
  // 先落盘再决定后续：写日志可能失败，但不能因为失败就丢掉原始错误信息
  recordCrash('uncaughtException', { err: err });
  console.error('uncaught', err);
});

process.on('unhandledRejection', (reason) => {
  recordCrash('unhandledRejection', { err: reason });
  console.error('unhandledRejection', reason);
});
