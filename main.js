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
const targetSize = require('./lib/target-size');     // 目标体积压缩的多轮逼近算法
const errorInfo = require('./lib/errors');           // 结构化错误（稳定错误码 + 建议操作）
const pathGuard = require('./lib/path-guard');       // 破坏性操作的路径安全网（删/写/覆盖）
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
/* 崩溃日志：打包后的 exe 没有控制台，异常只写 console 等于没记。
 * 这个模块负责脱敏、截断、轮转，主进程这边只提供目录与时机。 */
const crashLog = require('./lib/crash-log');
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
const jobs = new Map(); // id -> {cancel()}
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
const ipcCtx = require('./ipc/ctx').createIpcCtx({
  getWin: () => win,
  getJobs: () => jobs,
  nextJobSeq: () => ++jobSeq,
  getIsWin: () => isWin,
  getIsMac: () => isMac,
});

/* 【send 现在走 ipcCtx.send】是为了让 ctx.send **此刻就在链路里**，
 * 而不是一份"将来才用"的平行实现 —— 两份逻辑各写一遍的话，
 * ctx 那份要等搬完才第一次执行，差异也会一起推迟到那时才暴露。 */
function send(ev, data) { ipcCtx.send(ev, data); }

function fmtErr(e) { return (e && e.message) || String(e); }
const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
  // 高危能力门禁：未在设置里开启的能力，其 IPC 一律拒绝。
  // 放在统一包装里而不是逐个 handler 里，避免以后新增 handler 时忘了加。
  // sys:power / svc:action 由各自 handler 按 action 精细判定（锁屏、启动服务无害）。
  const cap = CAP_GATED_CHANNELS[ch];
  if (cap && !dangerousEnabled(cap)) {
    return { ok: false, error: dangerousDenied(cap) };
  }
  try { return { ok: true, data: await fn(e, ...args) }; }
  catch (err) {
    /* 结构化错误：除了原来给渲染端用的 error 字符串，再附带稳定错误码与建议操作。
       渲染端 window.api.invoke 仍然 throw new Error(error)，旧代码零改动；
       需要更细信息的地方可以读 err.code / err.advice。 */
    const payload = errorInfo.toPayload(err);
    return { ok: false, error: payload.message, code: payload.code, advice: payload.advice };
  }
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
  'clip:gc-images': 'file-delete',
  'fs:clean-junk': 'junk-clean',
  'sys:recycle-empty': 'recycle-empty',
  'proc:kill': 'process-kill',
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
handle('dangerous:list', () => ({
  caps: DANGEROUS_CAP_IDS.map(id => ({
    id, name: DANGEROUS_CAPS[id].name, desc: DANGEROUS_CAPS[id].desc, enabled: dangerousEnabled(id)
  })),
  enabled: DANGEROUS_CAP_IDS.filter(dangerousEnabled)
}));
handle('dangerous:set', (e, cap, on) => {
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
handle('dangerous:tool-caps', () => {
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
 * 只重建托盘菜单，不动别的状态。语言值不认识时保守回中文。 */
handle('app:set-lang', (e, lang) => {
  const next = lang === 'en' ? 'en' : 'zh';
  if (next === uiLang && tray) return true; // 没变就不用重建
  uiLang = next;
  if (tray) {
    try { tray.destroy(); } catch (err) {}
    tray = null;
    createTray();
  }
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
handle('win:minimize', () => { win && win.minimize(); });
handle('win:maximize', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
handle('win:close', () => { win && win.close(); });
/* 让渲染层知道「这次是从默认值起来的」。
 * 不加这条的话，用户只会看到笔记/收藏/剪贴板历史全空了，却不知道
 * 是数据文件损坏、也不知道原文件已被另存到哪 —— 只会以为程序把数据弄丢了。
 * 正常启动时 storeLoadFailed 为 false，界面不受任何影响。 */
handle('store:health', () => ({
  ok: !storeLoadFailed,
  corruptCopy: storeCorruptCopy,
  file: storeFile(),
}));
handle('app:get-info', () => ({
  appVersion: app.getVersion(),
  electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome,
  platform: process.platform,
  userData: app.getPath('userData'),
  exePath: app.getPath('exe'),
  hostname: os.hostname(),
  username: os.userInfo().username
}));
handle('store:get', (e, key, def) => storeGet(key, def));
handle('store:set', (e, key, val) => storeSet(key, val));
/* store:remove 已移除：全项目没有任何调用方（渲染层只删收藏/历史时用的是
 * store:set 置空）。js/api.js 的浏览器模拟分支曾保留它，也一并删掉。 */
handle('app:set-theme', (e, mode) => { nativeTheme.themeSource = mode; return nativeTheme.shouldUseDarkColors; });
handle('app:set-autostart', (e, enable) => {
  if (isWin || isMac) app.setLoginItemSettings({ openAtLogin: !!enable });
  return app.getLoginItemSettings().openAtLogin;
});
handle('app:get-autostart', () => (isWin || isMac) ? app.getLoginItemSettings().openAtLogin : false);
handle('app:set-hotkey', (e, acc) => applyHotkey(acc));

/* ---- 崩溃日志的界面入口 ----
 * 只读为主，不需要门禁（清空也只删 logs/ 下的 crash*.log，不碰用户数据）。
 * 四个通道：
 *   info   上次是否异常退出 + 日志文件列表（设置页显示一行摘要）
 *   read   最近一条日志的尾部（用户点「查看」时按需读，不预热）
 *   reveal 在文件管理器里定位日志目录（用户要发给开发者）
 *   clear  清空已有日志（会话标记是另一套语义，不受影响） */
handle('app:crash-info', () => {
  const logs = crashLog.listLogs(crashLogDir());
  return {
    lastSessionCrashed: lastSessionCrashed,
    dir: crashLogDir(),
    count: logs.length,
    totalBytes: logs.reduce((a, b) => a + b.size, 0),
    latest: logs.length ? { name: logs[0].name, size: logs[0].size, mtime: logs[0].mtime } : null
  };
});
handle('app:crash-read', (e, maxBytes) => {
  // 上限夹一下：渲染层传大值也不能让它把几 MB 文本塞进 IPC
  const n = Math.min(64 * 1024, Math.max(1024, Number(maxBytes) || 16 * 1024));
  return crashLog.tail(crashLogDir(), n);
});
handle('app:crash-reveal', async () => {
  const dir = crashLogDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  // showItemInFolder 需要文件路径；目录直接 openPath 更稳
  try { await shell.openPath(dir); return true; } catch (e) { return false; }
});
handle('app:crash-clear', () => {
  // 清空日志：删除所有 crash*.log。会话标记不动（那是另一套语义）
  const logs = crashLog.listLogs(crashLogDir());
  let n = 0;
  for (const l of logs) {
    try { fs.rmSync(l.path, { force: true }); n++; } catch (e) {}
  }
  return n;
});

/* ================= IPC: dialog ================= */
handle('dialog:open', async (e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: opts.title, defaultPath: opts.defaultPath,
    properties: opts.properties || ['openFile'],
    filters: opts.filters
  });
  return r.canceled ? null : r.filePaths;
});
handle('dialog:save', async (e, opts = {}) => {
  const r = await dialog.showSaveDialog(win, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
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
handle('text:detect-encoding', async (e, input, opts = {}) => {
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
handle('text:can-reencode', async (e, text, enc) => {
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
handle('exec:run', async (e, { cmd, args, shellType, cwd, timeoutMs }) => {
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
handle('exec:stream', (e, { command, args, cwd }) => {
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
        if (isWin) spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true });
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
handle('job:kill', (e, id) => { const j = jobs.get(id); if (j) j.cancel(); return true; });
// 取消最近一次启动的可取消任务（扫描/测速等，renderer 拿不到 job id 时使用）
/* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
let latestCancelable = null;
/* job:cancel-latest 已移除：全项目没有调用方 —— 渲染层的取消按钮一律走
 * job:kill <id>（带归属校验，不会误杀别人的任务）。
 * latestCancelable 本身保留：各长任务仍在装它，将来若要加「一键取消全部」
 * 可以直接读这个变量，不必再开一条无人使用的通道。 */

/* process list with cpu% (PS based) */
handle('proc:list', async () => {
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
handle('proc:detail', async (e, pid) => {
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

handle('proc:kill', async (e, pid) => {
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
});

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
handle('server:start', async (e, root, port) => {
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
handle('server:stop', () => {
  const s = serverMap.get('s');
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
handle('server:status', () => {
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

handle('sys:disk-health', async (e, force) => {
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
handle('sys:hw-info', async (e, force) => {
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
handle('sys:power', async (e, action) => {
  // 关机/重启/休眠会造成数据丢失或系统状态中断，必须先在高危功能里开启；
  // 锁屏、睡眠只是待机，不丢数据，不纳入门禁。
  if (DANGEROUS_POWER_ACTIONS.includes(action) && !dangerousEnabled('system-power')) {
    throw new Error(dangerousDenied('system-power'));
  }
  switch (action) {
    case 'lock': await runCmd('rundll32.exe', ['user32.dll,LockWorkStation'], { timeout: 5000 }); return true;
    case 'sleep': await runCmd('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { timeout: 5000 }); return true;
    case 'hibernate': spawn('shutdown', ['/h'], { windowsHide: true }); return true;
    case 'restart': spawn('shutdown', ['/r', '/t', '0'], { windowsHide: true }); return true;
    case 'shutdown': spawn('shutdown', ['/s', '/t', '0'], { windowsHide: true }); return true;
    default: throw new Error('未知操作');
  }
});
handle('sys:recycle-empty', async () => {
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
  const r = await ps(`Clear-RecycleBin -Force -ErrorAction Stop`, 20000);
  return true;
});
/* autostart via registry */
const RUN_KEYS = [
  { hive: 'HKCU', key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', label: '当前用户' },
  { hive: 'HKLM', key: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', label: '所有用户' }
];
handle('autostart:list', async () => {
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
handle('autostart:delete', async (e, item, permanent) => {
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
handle('autostart:enable', async (e, item) => {
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
handle('autostart:disabled-list', () => storeGet('autostartBackup', []));

/* hosts */
const HOSTS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
handle('hosts:read', async () => ({ content: await fsp.readFile(HOSTS_PATH, 'utf8'), path: HOSTS_PATH }));
handle('hosts:write', async (e, content) => {
  // 直接覆盖系统 hosts 有风险（写入中途失败会留下半截文件，影响全机 DNS）。
  // 先自动备份，再写临时文件后原子替换。
  const dir = path.join(app.getPath('userData'), 'hosts-backup');
  let backedUp = false;
  try {
    await fsp.mkdir(dir, { recursive: true });
    // 备份名精确到毫秒 + 随机后缀：只到秒的话，同一秒内连点两次保存会互相覆盖备份，
    // 第一次那份（可能才是正确的）就没了。
    const name = `hosts-${new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 23)}-${crypto.randomBytes(2).toString('hex')}.bak`;
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
handle('hosts:backup', async () => {
  const dir = path.join(app.getPath('userData'), 'hosts-backup');
  await fsp.mkdir(dir, { recursive: true });
  const name = `hosts-${new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 23)}-${crypto.randomBytes(2).toString('hex')}.bak`;
  await fsp.copyFile(HOSTS_PATH, path.join(dir, name));
  return { name };
});
handle('hosts:backups', async () => {
  const dir = path.join(app.getPath('userData'), 'hosts-backup');
  try { return (await fsp.readdir(dir)).map(n => path.join(dir, n)).reverse(); } catch (err) { return []; }
});
handle('hosts:restore', async (e, backupPath) => {
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
  const stamp = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 23) + '-' + crypto.randomBytes(2).toString('hex');
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
handle('app:set-accent', (e, id) => {
  const accent = ACCENT_IDS.indexOf(id) !== -1 ? id : 'polar';
  currentAccent = accent;
  broadcastAccent(accent);
  return accent;
});
/* app:get-accent 已移除：渲染层自己知道当前强调色（它是自己 set 的），
 * 辅助窗口通过 loadFile 的 query 参数拿到，不需要回头问主进程。 */

/* screen ruler floating window */
let rulerWin = null;
handle('win:ruler', (e, dir) => {
  if (rulerWin && !rulerWin.isDestroyed()) rulerWin.close();
  const horizontal = dir !== 'v';
  rulerWin = new BrowserWindow({
    width: horizontal ? 600 : 56, height: horizontal ? 56 : 600,
    frame: false, transparent: true, alwaysOnTop: true, resizable: false,
    skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false,
      additionalArguments: ['--hehe-packaged=' + (app.isPackaged ? '1' : '0')] }
  });
  rulerWin.setAlwaysOnTop(true, 'screen-saver');
  const self = rulerWin;
  self.on('closed', () => { if (rulerWin === self) rulerWin = null; });
  rulerWin.loadFile('ruler.html', { query: { dir: horizontal ? 'h' : 'v', accent: currentAccent } });
  return true;
});
handle('win:ruler:close', () => {
  if (rulerWin && !rulerWin.isDestroyed()) rulerWin.close();
  return true;
});
handle('win:ruler:move', (e, x, y) => {
  if (!rulerWin || rulerWin.isDestroyed()) return false;
  const px = Math.round(Number(x) || 0), py = Math.round(Number(y) || 0);
  const disp = screen.getDisplayNearestPoint({ x: px + 20, y: py + 20 });
  const wa = disp.workArea;
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
  const [bw, bh] = rulerWin.getSize();
  const cx = Math.min(Math.max(px, wa.x - bw + 40), wa.x + wa.width - 40);
  const cy = Math.min(Math.max(py, wa.y), wa.y + wa.height - 40);
  rulerWin.setPosition(cx, cy);
  return true;
});

/* screen */
handle('screen:cursor', () => {
  const pt = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt);
  return { x: pt.x, y: pt.y, display: { bounds: d.bounds, scaleFactor: d.scaleFactor } };
});
handle('screen:capture', async () => {
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
handle('clip:write-text', (e, text) => { clipboard.writeText(text); return true; });
handle('clip:read-text', () => clipboard.readText());
handle('clip:write-image', (e, dataUrl) => { clipboard.writeImage(nativeImage.createFromDataURL(dataUrl)); return true; });
handle('clip:read-image', () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  return img.toDataURL();
});

/* lunar */
handle('lunar:s2l', (e, y, m, d) => solarlunar.solar2lunar(y, m, d));
handle('lunar:l2s', (e, y, m, d, leap) => solarlunar.lunar2solar(y, m, d, !!leap));

/* qrcode (main side, lib is CJS) */
handle('qr:generate', async (e, text, opts = {}) => {
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
handle('office:status', async () => {
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
handle('office:convert', async (e, { files, target, outDir }) => {
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
handle('ctxmenu:list', async () => {
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
handle('ctxmenu:toggle', async (e, item, disable) => {
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
handle('sys:battery-detail', async () => {
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
handle('search:env', async () => {
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
handle('search:index-status', () => {
  const out = {};
  for (const [drive, idx] of searchIndexes) out[drive] = { count: idx.count, builtAt: idx.builtAt };
  return out;
});
handle('search:free', () => { searchIndexes.clear(); return true; });
handle('search:build', async (e, driveLetter) => {
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
  const kill = () => { try { spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true }); } catch (err) {} };
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
handle('search:query', async (e, { q, drive, limit, stat }) => {
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
handle('search:es', async (e, { q, limit }) => {
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
handle('search:quick', (e, { root, q, limit }) => {
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
handle('content:search', (e, { root, q, useRegex, ci, exts, limit }) => {
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
  bw.setAlwaysOnTop(true, 'screen-saver');
  pinWins.set(pinKey(bw.id), bw);
  bw.on('closed', () => pinWins.delete(pinKey(bw.id)));
  await bw.loadFile('pin.html', { query: { id: String(bw.id), src: srcPath, accent: currentAccent } });
  return { id: bw.id, w: size.width, h: size.height };
}
/* win:pin-image 通道已移除：截图「贴图」与「贴剪贴板图片」都直接调
 * createPinWindow()，没有渲染层调用方。函数本身保留，它是这两条路径的实现。 */
handle('win:pin-move', (e, id, x, y) => {
  const bw = pinWinOf(id);
  if (!bw) return false;   // 找不到就如实说没做到，不再假装成功
  bw.setPosition(Math.round(x), Math.round(y));
  return true;
});
handle('win:pin-resize', (e, id, w, h) => {
  const bw = pinWinOf(id);
  if (!bw) return false;
  bw.setSize(Math.max(80, Math.round(w)), Math.max(60, Math.round(h)));
  return true;
});
handle('win:pin-close', (e, id) => {
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
handle('winmgr:list', async () => {
  const out = await winmgrRun('[HeheWin.Util]::List()');
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const p = line.split('\t');
    if (p.length >= 5 && /^\d+$/.test(p[0])) rows.push({ hwnd: p[0], pid: +p[1], topmost: p[2] === '1', proc: p[3], title: p.slice(4).join('\t') });
  }
  return rows;
});
handle('winmgr:topmost', (e, hwnd, on) => winmgrRun(`[HeheWin.Util]::Topmost(${+hwnd}, ${on ? '$true' : '$false'})`));
handle('winmgr:bottom', (e, hwnd) => winmgrRun(`[HeheWin.Util]::Bottom(${+hwnd})`));
handle('winmgr:opacity', (e, hwnd, alpha) => winmgrRun(`[HeheWin.Util]::Opacity(${+hwnd}, ${Math.max(20, Math.min(255, alpha | 0))})`));

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
  realArgs.push(password ? sevenPwdArg(password) : '-p');
  try {
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

handle('seven:status', () => ({ za: sevenZa, full: findSevenFull() }));
handle('seven:compress', async (e, { files, out, password, volumeMB }) => {
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
handle('seven:extract', async (e, { archive, outDir, password }) => {
  const bin = findSevenFull() || sevenZa;
  if (!bin) throw new Error('未找到 7z 引擎');
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
    const r = await runSeven(bin, args, { password });
    if (r.code !== 0) throw new Error('解压失败：' + (r.stderr || r.stdout).split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' '));

    // 预检：解出来的条目也要过一遍安全判定（防 7z 里藏的穿越/设备名条目）
    const scanned = await scanDirForGuard(staging);
    const verdict = archiveGuard.inspectEntries(scanned);
    // 同 1314 行：inspectEntries 只 return ok:true 或 throw，此处为防御性死代码
    if (!verdict.ok) throw new Error('解压内容预检未通过');

    /* 目录条目与文件条目必须路由到同一个父目录：
       若目录 sub/ 因冲突改名为 sub(1)/，而文件 sub/b.txt 仍写进原来的 sub/，
       归档内容就会混进用户已有目录（zip:extract 那边踩过同样的坑）。
       所以：目录条目一律不改名（已存在就复用），只有文件冲突才编号。 */
    const dirSet = new Set();
    const dirFor = async (rel) => {
      const abs = pathGuard.resolveInside(outDir, rel);
      if (!dirSet.has(abs)) { await fsp.mkdir(abs, { recursive: true }); dirSet.add(abs); }
      return abs;
    };
    let moved = 0;
    for (const ent of verdict.entries) {
      const src = archiveGuard.resolveTarget(staging, ent.name);
      if (ent.isDir) { await dirFor(ent.name); continue; }
      const parentRel = path.dirname(ent.name);
      const parentAbs = parentRel && parentRel !== '.' ? await dirFor(parentRel) : path.resolve(outDir);
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
handle('wifi:profiles', async () => {
  const r = await runCmd('netsh', ['wlan', 'show', 'profiles'], { timeout: 15000, encoding: 'gbk' });
  const names = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/(?:所有用户配置文件|All User Profile)\s*:\s*(.+)$/);
    if (m) names.push(m[1].trim());
  }
  if (!names.length) throw new Error('未找到已保存的 WiFi 配置文件（可能没有无线网卡或未连接过 WiFi）');
  return { names };
});
handle('wifi:key', async (e, name) => {
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
handle('tts:voices', async () => {
  const r = await ps(`Add-Type -AssemblyName System.Speech; $p=New-Object System.Speech.Synthesis.SpeechSynthesizer; @($p.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }) | ConvertTo-Json -Compress`, 25000);
  let arr; try { arr = JSON.parse(r.stdout || '[]'); } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [arr];
  return { voices: arr.filter(Boolean) };
});
function ttsEsc(s) { return String(s).replace(/'/g, "''"); }
handle('tts:speak', (e, { text, voice, rate, volume }) => {
  const id = 'tts' + (++jobSeq);
  const script = `Add-Type -AssemblyName System.Speech; $p=New-Object System.Speech.Synthesis.SpeechSynthesizer;` +
    (voice ? `try{$p.SelectVoice('${ttsEsc(voice)}')}catch{};` : '') +
    `$p.Rate=[int]${Math.max(-10, Math.min(10, rate || 0))};$p.Volume=[int]${Math.max(0, Math.min(100, volume == null ? 100 : volume))};$p.Speak('${ttsEsc(text)}')|Out-Null`;
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
  const kill = () => { try { spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true }); } catch (e) {} };
  jobs.set(id, { cancel: kill });
  proc.on('exit', () => { jobs.delete(id); send('job:stream', { id, data: JSON.stringify({ done: true }) }); });
  return { id };
});
handle('tts:wav', async (e, { text, out, voice, rate }) => {
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
handle('svc:list', async () => {
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
handle('svc:action', async (e, name, action) => {
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
handle('power:list', async () => {
  const r = await runCmd('powercfg', ['/list'], { timeout: 15000, encoding: 'gbk' });
  const plans = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/([0-9a-fA-F-]{36})\s+(.+?)\s*(\*)?\s*$/);
    if (m) plans.push({ guid: m[1], name: m[2].trim(), active: !!m[3] });
  }
  return plans;
});
handle('power:set', async (e, guid) => {
  await runCmd('powercfg', ['/setactive', guid], { timeout: 15000, encoding: 'gbk' });
  return true;
});

/* 断点续传下载器（共享基础设施）。
 * 它同时被 net:download（通用文件下载）与 ipc/media-ffmpeg.js 的
 * ffmpeg:download（下载 ffmpeg 包）使用，所以**留在 main.js**、由 deps 注入。
 * 任务 6 一开始把它整段搬进了媒体域，net:download 立刻变成 ReferenceError ——
 * 语法检查完全看不见（运行时才炸），是 ESLint 的 no-undef 抓到的。 */
function downloadToFile(url, dest, id, ctrl, label) {
  /* eslint-disable-next-line no-async-promise-executor -- 历史写法：async 作 Promise executor。改成非 async 会变更异常传播路径，属行为改动，本轮不动 */
  return new Promise(async (resolve, reject) => {
    const MAX_RETRY = 6;
    /* 先写任务专属临时文件，校验通过后才原子改名为最终名。
       原实现直接写 dest：下载中断或重试耗尽时，dest 会留下体积不足的残缺文件，
       用户以为下好了（尤其 .exe），要等运行才发现损坏。
       现在失败/取消一律删临时文件，dest 要么不存在、要么是完整内容。 */
    const tmp = tempNames.downloadPart(dest);
    /* 【取消路径上删除可能失败，必须重试】
     * 取消时 `ws.destroy()` 是异步的，写流句柄还没释放就调 rmSync ——
     * Windows 上会抛 EPERM。原实现 catch 里什么都不做，于是每次取消下载
     * （59MB 的 ffmpeg 包很常见）都在 %TEMP% 留一个几十 MB 的 .part 文件；
     * 而且它有 dest 前缀（不是 hehe- 开头），不在本应用临时产物白名单里，
     * 自动清理永远扫不到 —— 只能用户自己去 %TEMP% 挖。
     * 现在：先等一小会再删，失败则登记到一个延迟清理队列，进程退出前再试一次。 */
    const cleanup = () => {
      try { fs.rmSync(tmp, { force: true }); return; } catch (e) { /* 句柄可能还没释放 */ }
      const tryLater = (left) => {
        setTimeout(() => {
          try { fs.rmSync(tmp, { force: true }); }
          catch (e2) { if (left > 1) tryLater(left - 1); }
        }, 200);
      };
      tryLater(5);
    };
    let attempt = 0, got = 0, total = 0, lastEmit = 0;
    const emit = (force) => {
      const now = Date.now();
      if (force || now - lastEmit > 400) {
        lastEmit = now;
        // 进度封顶 99%：只有提交成功才算 100%
        const pct = total ? Math.min(99, got / total * 100) : 0;
        send('job:stream', { id, data: JSON.stringify({ pct, mb: got / 1048576, totalMB: total / 1048576, label }) });
      }
    };
    const tryOnce = () => new Promise((res, rej) => {
      const headers = {};
      if (got > 0 && total > 0) headers.Range = 'bytes=' + got + '-';
      fetch(url, { signal: ctrl.signal, redirect: 'follow', headers }).then(async (r) => {
        /* 416 = 请求的 Range 超出资源范围。原实现直接 res() 当成「已下载完整」，
         * 但如果本地文件其实比 got/total 记的少（写流被截断过），下一轮体积校验
         * 必然失败 → attempt++ 重试 → got 仍是旧值、header 仍是非法 Range →
         * 又 416 → 每一轮都失败，直到耗尽 6 次重试报「下载校验失败」。
         * 一个「重头下就能好」的故障被拖成必定失败。
         * 正确做法：把断点清零，下一轮从头下。 */
        if (r.status === 416) {
          got = 0; total = 0;
          rej(new Error('服务器拒绝续传（416），将从零重新下载'));
          return;
        }
        if (!r.ok) { rej(new Error('下载源响应 ' + r.status)); return; }
        if (r.status === 200) got = 0; // 服务器不支持续传，重头下
        if (r.headers.get('content-length')) total = got + (Number(r.headers.get('content-length')) || 0);
        const reader = r.body.getReader();
        const ws = fs.createWriteStream(tmp, { flags: got > 0 && r.status === 206 ? 'a' : 'w' });
        ws.on('error', rej);
        while (true) {
          const { done, value } = await reader.read();
          if (ctrl.signal.aborted) { try { reader.cancel(); } catch (err) {} ws.destroy(); rej(new Error('ABORTED')); return; }
          if (done) { ws.end(() => res()); return; }
          got += value.length;
          if (!ws.write(Buffer.from(value))) {
            await new Promise((res2, rej2) => { ws.once('drain', res2); ws.once('error', rej2); });
          }
          emit();
        }
      }).catch(rej);
    });
    (async () => {
      while (true) {
        try {
          await tryOnce(); emit(true);
          // 提交前校验：体积必须与服务器声明的 content-length 一致，且不能为空
          let ok = true, why = '';
          try {
            const st = await fsp.stat(tmp);   // 异步，避免下载收尾时卡住事件循环
            if (st.size === 0) { ok = false; why = '下载内容为空'; }
            else if (total > 0 && st.size !== total) { ok = false; why = `体积不符（${st.size}/${total} 字节）`; }
          } catch (e) { ok = false; why = e.message; }
          if (!ok) {
            /* 【体积不符必须重试，不能直接 reject】
             * 传输中途被截断（代理断流、连接被掐）会得到 got < total 的临时文件。
             * 旧实现在这里直接 reject 退出整个循环 —— MAX_RETRY 那套重试对
             * 「下载成功但长度不对」这个最常见的中断形态完全无效。
             * 现在把它当作一次可重试的失败：保留已下载字节（Range 续传），
             * 下一轮从断点继续。 */
            attempt++;
            if (attempt >= MAX_RETRY) {
              cleanup();
              reject(new Error('下载校验失败（已重试 ' + MAX_RETRY + ' 次）：' + why));
              return;
            }
            send('job:stream', { id, data: JSON.stringify({ stage: 'retry', attempt, label, reason: why }) });
            await new Promise(r2 => setTimeout(r2, 1500));
            continue;
          }
          await fsp.rename(tmp, dest); // 原子改名：不会出现"半个文件"
          resolve({ size: got });
          return;
        } catch (err) {
          if (ctrl.signal.aborted || err.message === 'ABORTED') { cleanup(); reject(new Error('下载已取消')); return; }
          attempt++;
          if (attempt >= MAX_RETRY) { cleanup(); reject(new Error('下载失败（已重试 ' + MAX_RETRY + ' 次）：' + err.message)); return; }
          send('job:stream', { id, data: JSON.stringify({ stage: 'retry', attempt, label }) });
          await new Promise(r2 => setTimeout(r2, 1500));
        }
      }
    })();
  });
}
/* ================= IPC: 通用文件下载（断点续传） ================= */
handle('net:download', (e, { url, out }) => {
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
  snipWin = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
    frame: false, transparent: true, alwaysOnTop: true, resizable: false, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false,
      additionalArguments: ['--hehe-packaged=' + (app.isPackaged ? '1' : '0')] }
  });
  snipWin.setAlwaysOnTop(true, 'screen-saver');
  snipWin.setFullScreen(true);
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
handle('snip:start', (e, mode) => snipStart(mode));
handle('snip:finish', async (e, { action, dataUrl, rect }) => {
  const winToClose = snipWin;
  snipWin = null;
  try { if (winToClose && !winToClose.isDestroyed()) winToClose.close(); } catch (err) {}
  if (action === 'cancel' || action === 'region') {
    if (action === 'region' && rect) send('snip:region', rect); // 区域录制等用途
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
handle('snip:pin-clipboard', () => pinClipboardImage());

/* ================= IPC: 检查更新（GitHub Releases；NSIS 安装版走 electron-updater） ================= */
// ETag 条件请求 + 本地缓存：命中缓存/304 时不消耗匿名限流配额（60 次/时/IP）
const UPDATE_TTL = 6 * 3600 * 1000; // 缓存有效期 6 小时
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
handle('update:check', async (e, opts = {}) => {
  const current = app.getVersion();
  const force = !!(opts && opts.force);
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
  if (cached && cached.payload && !force && Date.now() - (cached.checkedAt || 0) < UPDATE_TTL) {
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
     * 应用阶段会退回「只比体积」并在日志里注明，不阻断流程。 */
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
});
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
handle('update:apply', async (e, opts = {}) => {
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
  /* 完整性校验：update:check 从 Release 资产里取到的 sha256 记在这里。
   * 下载包来自 GitHub HTTPS，风险不高，但「只比体积」挡不住内容被替换
   * （体积相同即可蒙混）。拿不到 digest 时退回体积校验并在日志里注明，
   * 不阻断升级 —— 老版本 Release 没有 digest 字段，不能因此让用户升不了级。 */
  const expectSha = typeof opts.expectSha256 === 'string' ? opts.expectSha256.toLowerCase() : null;
  if (expectSha) {
    if (!/^[0-9a-f]{64}$/.test(expectSha)) throw new Error('更新校验值格式无效，拒绝替换');
    const actual = await new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const rs = fs.createReadStream(newExe);
      rs.on('data', (c) => h.update(c));
      rs.on('end', () => resolve(h.digest('hex')));
      rs.on('error', reject);
    });
    if (actual !== expectSha) {
      throw new Error('新版文件校验失败（SHA-256 不符），已拒绝替换。\n期望：' + expectSha + '\n实际：' + actual +
        '\n请删除该下载包后重新检查更新。');
    }
    console.log('[update] SHA-256 校验通过：' + actual.slice(0, 16) + '…');
  } else {
    console.warn('[update] 本次更新没有可用的 SHA-256（Release 未提供 digest），仅做体积校验 —— 已知取舍');
  }
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
    '$log = Join-Path $env:TEMP ("hehe-update-" + [DateTime]::Now.ToString("yyyyMMdd-HHmmss") + ".log")',
    'try {',
    '  $deadline = [DateTime]::Now.AddSeconds(90)',
    '  while ((Get-Process -Id $targetPid -ErrorAction SilentlyContinue) -and ([DateTime]::Now -lt $deadline)) { Start-Sleep -Milliseconds 300 }',
    '  Start-Sleep -Milliseconds 600',
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
    '  Copy-Item -LiteralPath $newExe -Destination $target -Force',
    '  $dstLen = (Get-Item -LiteralPath $target).Length',
    '  if ($dstLen -ne $srcLen) { throw ("替换后大小不符：" + $dstLen + " != " + $srcLen) }',
    '  Add-Content -LiteralPath $log -Value ("replaced: " + $target)',
    '} catch {',
    '  Add-Content -LiteralPath $log -Value ("failed: " + $_.Exception.Message)',
    // 替换失败则把备份还原回去
    '  try { if (Test-Path -LiteralPath $backup) { Copy-Item -LiteralPath $backup -Destination $target -Force; Add-Content -LiteralPath $log -Value "restored-from-backup" } } catch {}',
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
  spawn('powershell.exe', spawnArgs, { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
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

handle('update:cleanup', async () => {
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
handle('update:mark-pending', (e, name) => {
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
handle('sched:list', () => storeGet('settings.schedules', []));
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

handle('sched:add', (e, s) => {
  const clean = normSchedule(s);
  clean.id = nextLocalId('sc');
  const list = storeGet('settings.schedules', []);
  list.push(clean);
  storeSet('settings.schedules', list);
  armSchedule(clean, false);
  return list;
});
handle('sched:remove', (e, id) => {
  const t = schedTimers.get(id);
  if (t) { clearTimeout(t.timeout); if (t.interval) clearInterval(t.interval); schedTimers.delete(id); }
  const list = storeGet('settings.schedules', []).filter(x => x.id !== id);
  storeSet('settings.schedules', list);
  return list;
});

/* ================= IPC: 7z 压缩包内容预览 ================= */
handle('seven:list', async (e, { archive, password }) => {
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

/* ================= IPC: 笔记导出 PDF（离屏渲染 printToPDF） ================= */
handle('notes:pdf', async (e, { title, html, outPath }) => {
  let outFile = outPath || '';
  if (!outFile) {
    const out = await dialog.showSaveDialog(win || null, { defaultPath: (title || '笔记') + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (out.canceled || !out.filePath) return null;
    outFile = out.filePath;
  }
  const bw = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await bw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${(title || '').replace(/</g, '')}</title></head>` +
      `<body style="max-width:720px;margin:32px auto;font-family:'Microsoft YaHei',sans-serif;line-height:1.75;font-size:14px;color:#222">` +
      `${html}</body></html>`));
    await new Promise(r => setTimeout(r, 300));
    const buf = await bw.webContents.printToPDF({ printBackground: true, margins: { marginType: 'default' } });
    // 用原子写：writeFileSync 是 O_TRUNC 覆盖，导出中途磁盘满/进程被杀
    // 会把用户原有的那份 PDF 截断成半截甚至空文件。
    await writeFileAtomic(outFile, buf);
    return { out: outFile, size: buf.length };
  } finally { bw.destroy(); }
});

/* ================= IPC: 剪贴板图片转文件（防 store JSON 膨胀） ================= */
handle('clip:save-image', async (e, dataUrl) => {
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
handle('clip:remove-images', async (e, files) => {
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
handle('ctxmenu:classic', async (e, on, restart) => {
  if (on) {
    // /ve /d "" /f：建 InprocServer32 并把默认值显式置为空字符串（不置空则可能继承旧值）
    await runCmd('reg', ['add', WIN11_CTX_HANDLER, '/ve', '/t', 'REG_SZ', '/d', '', '/f'], { timeout: 10000 });
  } else {
    // 只删我们建的处理器子键，保留系统原始的 CLSID 键
    await runCmd('reg', ['delete', WIN11_CTX_HANDLER, '/f'], { timeout: 10000 }).catch(() => {});
  }
  if (restart) {
    spawn('taskkill', ['/f', '/im', 'explorer.exe'], { windowsHide: true });
    setTimeout(() => { try { spawn('explorer.exe', [], { windowsHide: true, detached: true }); } catch (e) {} }, 800);
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
handle('ctxmenu:classic-status', async () => ({ on: await ctxClassicState() }));

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
  ps,
  runCmd,
  pathExists,
  shortErr,
  PS_PATH_BATCH,
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
      Promise.all([sweepTempFiles(), sweepClipImages()])
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
        const orderMismatch = [];
        for (const m of window.Registry.MODULES) {
          window.App.showView({ type: 'module', moduleId: m.id });
          await tick();
          const rendered = [...document.querySelectorAll('.tool-card .tc-name')].map(e => e.textContent.trim());
          const want = window.Registry.byModule(m.id).map(t => t.name);
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
          aux = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { offscreen: false } });
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
    const ok = crashLog.append(crashLogDir(), entry);
    // 写盘失败时至少退回 console —— 开发态（npm start）还看得见
    if (!ok) console.error('[crash-log]', kind, payload && payload.err);
    return ok;
  } catch (e) {
    // 记录日志本身失败绝不能再抛出，否则会形成异常循环
    console.error('[crash-log] 写入失败', e && e.message);
    return false;
  }
}

process.on('uncaughtException', (err) => {
  // 先落盘再决定后续：写日志可能失败，但不能因为失败就丢掉原始错误信息
  const written = recordCrash('uncaughtException', { err: err });
  console.error('uncaught', err);
  if (!written) return;
  /* 尝试让界面知道（窗口可能还没建好，所以兜底判空）。
   * 只发事件、不弹模态框：多数异常是局部的，弹框比异常本身更烦人。 */
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('app:crash-logged', { kind: 'uncaughtException', message: String(err && err.message || err) });
    }
  } catch (e) {}
});

process.on('unhandledRejection', (reason) => {
  const written = recordCrash('unhandledRejection', { err: reason });
  console.error('unhandledRejection', reason);
  if (!written) return;
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('app:crash-logged', { kind: 'unhandledRejection', message: String(reason && reason.message || reason) });
    }
  } catch (e) {}
});
