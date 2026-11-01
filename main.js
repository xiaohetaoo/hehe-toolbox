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
const zlib = require('zlib');
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
const rmLockers = require('./lib/rm-lockers');       // 查文件被哪个进程占用（Restart Manager 内嵌 C#）
const links = require('./lib/links');                 // junction/symlink 识别、体检、「只删链接」安全删除
const dirMove = require('./lib/dir-move');            // 目录搬家的校验规则与回退状态机（纯逻辑）
const mojibake = require('./lib/mojibake');           // 乱码识别与编码探测（纯逻辑）
const aclRepair = require('./lib/acl-repair');        // 权限修复：判据与命令构造（纯逻辑）
const diskHealth = require('./lib/disk-health');      // 磁盘健康：诚实区分「拿到了/拿不到」（纯逻辑）
const lanScanLib = require('./lib/lan-scan');         // 局域网扫描：ARP 解析与结果合并（纯逻辑）
/* 临时产物命名的**唯一来源**：生成函数与清理白名单在同一个模块里，
 * 避免"新增一种产物忘了登记白名单"（.hehe-7zx-* 那次残留事故的根因）。 */
const tempNames = require('./lib/temp-names');
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
function send(ev, data) { if (win && !win.isDestroyed()) win.webContents.send(ev, data); }
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

/* ================= IPC: fs ================= */
const TEXT_LIMIT = 8 * 1024 * 1024, BIN_LIMIT = 64 * 1024 * 1024;
handle('fs:read-text', async (e, p) => {
  const st = await fsp.stat(p);
  if (st.size > TEXT_LIMIT) throw new Error('文件超过 8MB，请使用文本分批读取或文件处理工具');
  const buf = await fsp.readFile(p);
  let content = buf.toString('utf8');
  if (content.includes('\uFFFD')) {
    try { content = new TextDecoder('gbk').decode(buf); } catch (err) {}
  }
  return { content, size: st.size };
});
// 写文件（覆盖式）。三个风险要挡住：
//   1) 目标是系统关键目录里的文件 -> 拒绝
//   2) 写入中途失败会留下半截文件，破坏用户原有内容
//   3) 替换过程中目标路径出现「空窗期」，此时任何中断都会让原文件彻底消失
// 做法：写同目录临时文件 -> 原子改名；Windows 上 rename 不能覆盖已存在目标，
// 就用「把原文件改名备份 -> 临时文件改名到位 -> 删备份」三段式，
// 任何一步失败都能把原文件恢复回去。
async function writeFileAtomic(dest, data, encoding) {
  const bad = pathGuard.checkOverwritable(dest);
  if (bad) throw pathGuard.err(bad.code, bad.reason);
  // 目标文件名本身也要过一遍：挡住 NTFS ADS（file.txt:stream）等写进去
  // 却看不见的形态。目前所有调用点传的都是我们自己的文件名，属于纵深防御。
  const nameBad = pathGuard.checkFileName(path.basename(String(dest || '')));
  if (nameBad) throw pathGuard.err(nameBad.code, nameBad.reason);
  const dir = path.dirname(dest);
  await fsp.mkdir(dir, { recursive: true });
  const tag = process.pid + '-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const tmp = tempNames.writeTmp(dest, tag);
  try {
    if (encoding) await fsp.writeFile(tmp, data, encoding);
    else await fsp.writeFile(tmp, data);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  try {
    await fsp.rename(tmp, dest);   // POSIX 语义：直接覆盖
    return dest;
  } catch (err) {
    // Windows：目标已存在时 rename 失败。绝不能「先 rm(dest) 再 rename」——
    // 那样中途失败会留下空目录项，原文件永久丢失。
    // 改为把原文件挪到备份名，新文件就位后再删备份。
    const bak = tempNames.writeBak(dest, tag);
    let moved = false;
    try {
      await fsp.rename(dest, bak);
      moved = true;
    } catch (e2) { /* 目标不存在或无法改名，直接尝试下一步 */ }
    try {
      await fsp.rename(tmp, dest);
      if (moved) await fsp.rm(bak, { force: true }).catch(() => {});
      return dest;
    } catch (err2) {
      // 新文件没能就位：把原文件搬回去。若搬回**也失败**，绝不能静默吞掉 ——
      // 原文件还躺在 .hehe-bak-* 隐藏文件里，按原路径找不到，等同于丢失。
      // 必须把备份路径明确告诉用户。
      if (moved) {
        try {
          await fsp.rename(bak, dest);
        } catch (e3) {
          await fsp.rm(tmp, { force: true }).catch(() => {});
          const e = new Error('写入失败且原文件回滚失败。原文件已保全在：' + bak + '（请手动改回原名）');
          e.code = 'ROLLBACK_FAILED';
          throw e;
        }
      }
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err2;
    }
  }
}
handle('fs:write-text', async (e, p, content) => { await writeFileAtomic(p, content, 'utf8'); return true; });
handle('fs:read-file-b64', async (e, p) => {
  const st = await fsp.stat(p);
  if (st.size > BIN_LIMIT) throw new Error('文件超过 64MB 限制');
  return { b64: (await fsp.readFile(p)).toString('base64'), size: st.size };
});
handle('fs:write-file-b64', async (e, p, b64) => { await writeFileAtomic(p, Buffer.from(b64, 'base64')); return true; });
handle('fs:stat', async (e, p) => { const st = await fsp.stat(p); return { size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() }; });
/* 批量取体积/类型：文件列表一次拖入 500 个文件时，逐个 fs:stat 就是 500 次
 * IPC 往返，主进程排队处理，列表体积长时间停在「…」。
 * 这里一次传一批（渲染层按 50 个一批分片），并发受限地 stat，
 * 单个路径失败只让那一项返回 null，不打断整批。
 * 【为什么限并发】500 个路径全开 Promise 会瞬间打满文件句柄；
 * 8 路足够快，也不会挤掉主进程里别的 IO。 */
handle('fs:stat-multi', async (e, paths) => {
  const list = Array.isArray(paths) ? paths : [];
  /* 一次最多 2000 个。
   *
   * 上限存在的理由：这个通道是渲染层传什么主进程就 stat 什么，没有天花板。
   * 正常用法（最近文件、工具页几十个）离 2000 很远；一旦哪里写错把整盘
   * 的结果全投进来（或用户选了上万项的目录），主进程会被这 8 路 worker
   * 长时间占住 —— 那是唯一跑 IPC 的进程，它忙起来整个界面都在排队。
   * 直接报错比默默卡住好查：报错能指出「谁传多了」，卡住只能靠猜。
   * 阈值取 2000：比任何现实调用高一个量级，又不至于让主进程排太久。 */
  const MAX_STAT_BATCH = 2000;
  if (list.length > MAX_STAT_BATCH) {
    throw new Error('批量查询文件信息一次最多 ' + MAX_STAT_BATCH + ' 个，收到 ' + list.length + ' 个');
  }
  const CONCURRENCY = 8;
  const out = new Array(list.length).fill(null);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= list.length) return;
      try {
        const st = await fsp.stat(list[i]);
        out[i] = { size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() };
      } catch (err) {
        out[i] = null; // 不存在/无权限：只影响这一项
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length || 1) }, worker));
  return out;
});
handle('fs:exists', async (e, p) => { try { await fsp.access(p); return true; } catch (err) { return false; } });
handle('fs:list', async (e, p) => {
  const names = await fsp.readdir(p, { withFileTypes: true });
  const out = [];
  for (const d of names) {
    const full = path.join(p, d.name);
    try {
      const st = await fsp.stat(full);
      out.push({ name: d.name, path: full, isDir: d.isDirectory(), size: st.size, mtime: st.mtimeMs });
    } catch (err) { out.push({ name: d.name, path: full, isDir: d.isDirectory(), size: 0, mtime: 0 }); }
  }
  out.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
  return out;
});
handle('fs:mkdir', async (e, p) => { await fsp.mkdir(p, { recursive: true }); return true; });
// Unix 的 rename() 目标存在就覆盖，Windows 上 Node 也照这个语义走：
// 批量改名/改后缀撞上已存在的同名文件时，会把别人的文件悄无声息地抹掉。
// 这里默认拒绝覆盖（overwrite 需显式传 true），把“静默毁文件”变成可见的错误。
handle('fs:rename', async (e, from, to, overwrite) => {
  if (!from || !to) throw new Error('缺少重命名路径');
  const rf = path.resolve(from), rt = path.resolve(to);
  if (rf === rt) return true;
  /* 【纯大小写改名必须放行】Windows 文件系统大小写不敏感：
   * 磁盘上只有 FILE.TXT 时 fs.existsSync('file.txt') 同样返回 true，
   * 于是「批量转小写/转大写」「.JPG → .jpg」这类改名会被下面那句
   * 「目标文件已存在」全部拒绝 —— 报错指向一个并不存在的冲突。
   * 判据：两个路径解析后除了大小写完全相同，即视为同一文件的重命名，
   * 底层 rename 在 NTFS 上能正确改写大小写。
   * 只放宽「忽略大小写后完全相同」的情形；FILE.TXT → OTHER.TXT 仍然拒绝。
   *
   * 【这道闸门必须放在大小写分支之前】
   * 纯大小写改名虽然不会新建路径，但它同样是"往 rt 这个位置写"，
   * 而 rt 与 rf 只差大小写 —— 也就是说如果不拦，就能把一个文件
   * 改成系统目录里某个文件的镜像名（例如把 C:\evil.exe 改成 C:\Windows\x.exe
   * 只有在大小写不同时才走得通，这恰恰是要防的那类事情）。
   * 放在前面既能拦住越权目标，又不会挡住正常的同目录改名
   * （同一目录里的正常改名，rf 与 rt 都在同一个"可写"位置）。 */
  const guard = pathGuard.checkOverwritable(rt);
  if (guard) {
    throw pathGuard.err(guard.code, guard.reason, '请换一个目标路径（不要指向系统目录或盘符根）');
  }
  if (rf.toLowerCase() === rt.toLowerCase()) {
    await fsp.rename(from, to);
    return true;
  }
  if (!overwrite && fs.existsSync(to)) {
    throw new Error('目标文件已存在，为避免覆盖已拒绝：' + to);
  }
  await fsp.rename(from, to);
  return true;
});
// 删除文件/目录。路径来自渲染层，必须设闸门：
//   - 递归删除整个磁盘根目录、系统关键目录、用户主目录 -> 直接拒绝
//   - 非递归删除单个文件时，仍然要挡住关键目录里的文件
// 原实现是 fsp.rm(p, {recursive, force:true}) 裸调用，
// 配合高危开关「文件删除」一旦开启，构造路径就能删掉 C:\Users 或整个 C 盘。
handle('fs:delete', async (e, p, recursive) => {
  const bad = pathGuard.checkDeletable(p, recursive);
  if (bad) throw pathGuard.err(bad.code, bad.reason, '如确需删除该路径，请手动在资源管理器中操作');
  await fsp.rm(p, { recursive: !!recursive, force: true });
  return true;
});
handle('fs:open-path', async (e, p) => { const err = await shell.openPath(p); if (err) throw new Error(err); return true; });
handle('fs:show-item', (e, p) => { shell.showItemInFolder(p); return true; });
// 只允许 http/https：shell.openExternal 会把任意协议交给系统处理，
// file:// 能直接打开本地文件，smb:// / ms-msdt: 等还能被系统协议处理器放大成提权或 RCE 链。
handle('shell:open-url', async (e, url) => {
  const s = String(url || '').trim();
  let u;
  try { u = new URL(s); } catch (err) { throw new Error('网址格式不正确'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只允许打开 http/https 网址');
  await shell.openExternal(u.toString());
  return true;
});
/* 唯一名生成：实现已抽到 lib/fs-ops.js（与 test-round2-fixes 共享同一份，
 * 避免测试复刻逻辑导致「改了主实现、测试照旧全绿」的假绿）。 */
handle('fs:unique-path', async (e, p) => fsOps.uniquePath(p));

/* recursive walk with cancel + progress */
async function walkDir(root, opts, onItem) {
  const cancel = opts && opts._cancelRef;
  let dirs = 0, files = 0, total = 0;
  async function rec(dir, depth) {
    if (cancel && cancel.canceled) return;
    if (depth > (opts.maxDepth || 64)) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { return; }
    for (const d of entries) {
      if (cancel && cancel.canceled) return;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        dirs++;
        if (onItem) await onItem({ type: 'dir', path: full, depth });
        await rec(full, depth + 1);
      } else if (d.isFile()) {
        let size = 0;
        try { size = (await fsp.stat(full)).size; } catch (err) {}
        files++; total += size;
        if (onItem) await onItem({ type: 'file', path: full, size, depth });
      }
    }
  }
  await rec(root, 0);
  return { dirs, files, total };
}

/* disk/tree analysis job */
handle('fs:scan-tree', async (e, root, opts = {}) => {
  const id = 'scan' + (++jobSeq);
  const cancelRef = { canceled: false };
  jobs.set(id, { cancel: () => { cancelRef.canceled = true; } });
  latestCancelable = () => { cancelRef.canceled = true; };
  /* 【根路径必须先归一，尤其是去掉尾随分隔符】
   * 原实现拿 root **原样**用，而聚合祖先时是这样判包含的：
   *     while (cur.length >= root.length) { ... }
   * 用**字符串长度**做包含判断。当 root = 'D:\foo\'（用户从地址栏复制
   * 过来就带尾斜杠，而占位提示写的正是「如 D:\」）时：
   *   root.length = 8，而 path.dirname('D:\foo\a.txt') = 'D:\foo'（长度 7），
   *   7 >= 8 为假 → 循环一次都不进 → 根目录累计恒为 0。
   * 同理 dirSize 的键是带尾斜杠的原字符串，而 cur 不带，dirSize.has(cur)
   * 永远不命中 —— 不是"算错一点"，而是这一整支统计全是 0。
   * 现在：先 path.resolve 归成绝对路径，再去掉尾随分隔符（盘符根本身除外）；
   * 包含判断改成 cur === root || cur.startsWith(root + sep)。
   * 返回的 root 也用归一后的值，界面显示才与实际统计口径一致。 */
  const scanRoot = normalizeRootForScan(root);
  const dirSize = new Map();
  let files = 0, totalSize = 0, dirCount = 0, lastEmit = 0;
  const topFiles = [];
  try {
    await walkDir(root, { maxDepth: opts.maxDepth || 64, _cancelRef: cancelRef }, async (item) => {
      if (item.type === 'dir') {
        dirCount++;
        dirSize.set(item.path, 0);
      } else {
        files++; totalSize += item.size;
        topFiles.push({ path: item.path, size: item.size });
        if (topFiles.length > 400) { topFiles.sort((a, b) => b.size - a.size); topFiles.length = 200; }
        // aggregate to ancestors
        let cur = path.dirname(item.path);
        while (cur === scanRoot || cur.startsWith(scanRoot + path.sep)
               || cur === path.parse(cur).root) {
          if (dirSize.has(cur)) dirSize.set(cur, dirSize.get(cur) + item.size);
          if (cur === path.parse(cur).root || cur === scanRoot) break;
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
      }
      if (onProgressTick(item)) emitProgress();
    });
    function onProgressTick(item) { return item.type === 'file'; }
    function emitProgress() {
      const now = Date.now();
      if (now - lastEmit > 250) { lastEmit = now; send('job:progress', { id, kind: 'scan', files, size: totalSize }); }
    }
  } finally { jobs.delete(id); }
  topFiles.sort((a, b) => b.size - a.size);
  const topDirs = [...dirSize.entries()].filter(([p]) => p !== scanRoot).map(([p, size]) => ({ path: p, size }))
    .sort((a, b) => b.size - a.size).slice(0, 30);
  if (cancelRef.canceled) throw new Error('已取消');
  return { id, root: scanRoot, totalSize, files, dirCount, topFiles: topFiles.slice(0, 30), topDirs };
});

/* 扫描用的根路径归一：绝对化 + 去尾随分隔符（盘符根本身保留 'X:\' 形态）。 */
function normalizeRootForScan(root) {
  let s = path.resolve(String(root == null ? '' : root));
  const volRoot = path.parse(s).root;
  /* path.resolve 对 'D:\foo\' 已经会去掉尾斜杠；这里额外处理
   * 用户可能传的正斜杠与重复分隔符（'D:/foo//' 之类）。 */
  if (s.length > volRoot.length && /[\\/]$/.test(s)) s = s.slice(0, -1);
  return s;
}

/* empty dirs */
handle('fs:scan-empty-dirs', async (e, root) => {
  const id = 'empty' + (++jobSeq);
  const cancelRef = { canceled: false };
  jobs.set(id, { cancel: () => { cancelRef.canceled = true; } });
  latestCancelable = () => { cancelRef.canceled = true; };
  const empty = [];
  async function rec(dir, depth) {
    if (cancelRef.canceled) return false;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { return false; }
    if (entries.length === 0) { empty.push({ path: dir, depth }); return true; }
    let hasFile = false;
    for (const d of entries) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { const childEmpty = await rec(full, depth + 1); if (!childEmpty) hasFile = true; }
      else hasFile = true;
    }
    if (!hasFile && !cancelRef.canceled) { empty.push({ path: dir, depth }); return true; }
    return false;
  }
  try { await rec(root, 0); } finally { jobs.delete(id); }
  if (cancelRef.canceled) throw new Error('已取消');
  empty.sort((a, b) => b.depth - a.depth);
  return { dirs: empty };
});
handle('fs:delete-empty', async (e, dirs) => {
  let deleted = 0; const errors = [];
  /* 【入参必须是字符串数组 —— 这里曾出现过「一个都删不掉还报成功」】
   * 渲染层早期把扫描结果 { path, depth } 对象数组原样发过来，
   * 于是 checkDeletable(obj) 里 String(obj) 变成 "[object Object]" 一路放行，
   * fsp.rmdir(obj) 抛 ERR_INVALID_ARG_TYPE 被 catch 收进 errors，deleted 恒 0。
   * 调用点已改对，这里再加一道显式校验：把「调用方传错类型」当场报出来，
   * 而不是靠 String() 悄悄降级成一个看起来正常、实际毫无意义的路径。 */
  if (!Array.isArray(dirs)) return { deleted: 0, errors: ['参数必须是路径数组'] };
  for (const p of dirs) { // deepest first (caller sorts)
    if (typeof p !== 'string' || !p.trim()) {
      errors.push(`非法参数：${typeof p === 'object' ? JSON.stringify(p) : String(p)}（路径必须是字符串）`);
      continue;
    }
    // 闸门：不允许删系统关键目录 / 盘符根 / 用户主目录本身
    const bad = pathGuard.checkDeletable(p, false);
    if (bad) { errors.push(`${p}: ${bad.reason}`); continue; }
    /* 删空目录。这里【不能】用 recursive:true 的 fsp.rm ——
     * 它会把目录里的内容一起删掉，语义完全不同（会毁数据）。
     * 实测（Node 24.19）：`await fsp.rm(dir, { recursive: false })` 对**目录**
     * 直接抛 ERR_FS_EISDIR（"Path is a directory"），并不会删掉目录；
     * 能删目录的只有 fsp.rmdir 或 recursive:true。
     * 所以要保住「只删空目录」的语义，rmdir 仍是唯一正确选择
     * （它在 Node 24 上只是被标记为将来可能弃用，并未移除）。
     * 降级分支原先又调了一次 rmdir —— 那等于是说「rmdir 没了就用 rmdir」，
     * 根本走不通；改成「先读目录确认确实为空，再尝试删除」的真实路径。 */
    try {
      if (typeof fsp.rmdir === 'function') {
        await fsp.rmdir(p);
      } else {
        // 降级：先读目录，确认确实是空的再删（绝不用 recursive:true）
        const ents = await fsp.readdir(p);
        if (ents.length !== 0) throw new Error('目录非空，跳过');
        await fsp.rm(p); // recursive 默认为 false，只删这个空目录
      }
      deleted++;
    } catch (err) { if (err.code !== 'ENOENT') errors.push(`${p}: ${fmtErr(err)}`); }
  }
  return { deleted, errors };
});

/* junk scan */
async function dirSizeFast(p, maxFiles = 50000) {
  let size = 0, files = 0;
  // 目标本身是文件时直接返回其大小（如缩略图缓存 .db 文件）
  try { const st = await fsp.stat(p); if (st.isFile()) return { size: st.size, files: 1, truncated: false }; } catch (err) { return { size: 0, files: 0, truncated: false }; }
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch (err) { continue; }
    for (const d of entries) {
      const full = path.join(cur, d.name);
      if (d.isDirectory()) stack.push(full);
      else { try { size += (await fsp.stat(full)).size; files++; } catch (err) {} }
      if (files > maxFiles) return { size, files, truncated: true };
    }
  }
  return { size, files, truncated: false };
}
/* 【扫描结果要留下来，clean-junk 只认这一份】
 * 清扫通道的语义是「清临时文件 / 浏览器缓存 / 缩略图缓存」，能力范围很窄。
 * 但早期 renderer 直接把 targets 传回来，主进程只做了三道检查
 * （%TEMP% 白名单、checkDeletable、存在性）—— 没有任何「必须来自本次扫描」的校验。
 * 于是传 D:\\照片 或 C:\\Users\\me\\Documents\\工作 都能过：
 * keepRoot=false 时甚至 fsp.rm(abs, { recursive: true, force: true }) 连根删。
 * 对比 fs:delete 走的是 file-delete 门禁，这个通道的能力范围严重不匹配。
 * 现在缓存上一轮扫描的候选集合，clean-junk 只接受集合内的路径。 */
let junkScanCache = { at: 0, paths: new Set() };
/* 清理通道的路径比较键：绝对路径 + 统一分隔符 + 小写
 * （Windows 路径不区分大小写，纯字符串比较会被大小写变体绕过）。 */
function normForJunk(p) {
  try { return path.resolve(p).replace(/\//g, '\\').toLowerCase(); }
  catch (e) { return String(p == null ? '' : p).toLowerCase(); }
}
handle('fs:scan-junk', async () => {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const cands = [
    // 临时文件：**只扫本应用自己的产物**（hehe- 前缀白名单）。
    // 原实现把整个 os.tmpdir() 当成一个清理目标，keepRoot 模式下会把 %TEMP%
    // 下所有条目删光——实测本机 984 个条目里 908 个属于别的程序
    // （浏览器、Office、安装程序正在用的临时文件），全被误删。
    // v0.0.10 修过"清空整个 %TEMP%"，但这条路径绕过了那个白名单。
    { id: 'temp', label: '本应用临时文件', path: os.tmpdir(), ownOnly: true },
    { id: 'chrome', label: 'Chrome 浏览器缓存', path: path.join(local, 'Google', 'Chrome', 'User Data'), pattern: /Cache|Code Cache|GPUCache/ },
    { id: 'edge', label: 'Edge 浏览器缓存', path: path.join(local, 'Microsoft', 'Edge', 'User Data'), pattern: /Cache|Code Cache|GPUCache/ },
    { id: 'thumb', label: '缩略图缓存', path: path.join(local, 'Microsoft', 'Windows', 'Explorer'), pattern: /thumbcache|thumbcache_.*\.db/i }
  ];
  const out = [];
  for (const c of cands) {
    if (c.ownOnly) {
      // 只列本应用自己的临时产物
      let size = 0, files = 0;
      const targets = [];
      const entries = await fsp.readdir(c.path).catch(() => []);
      for (const n of entries) {
        if (!isOwnTempName(n)) continue;   // 白名单：绝不动别人的东西
        const full = path.join(c.path, n);
        const r = await dirSizeFast(full);
        size += r.size; files += r.files;
        targets.push(full);
      }
      if (files > 0) out.push({ id: c.id, label: c.label, path: c.path, size, files, targets });
      continue;
    }
    if (c.pattern) {
      // aggregate matching subdirs
      let size = 0, files = 0;
      const stack = [c.path];
      const targets = [];
      while (stack.length) {
        const cur = stack.pop();
        let entries; try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch (err) { continue; }
        for (const d of entries) {
          const full = path.join(cur, d.name);
          if (d.isDirectory()) { if (c.pattern.test(d.name)) targets.push(full); else stack.push(full); }
          else if (c.pattern.test(d.name)) targets.push(full);
        }
      }
      for (const t of targets) { const r = await dirSizeFast(t); size += r.size; files += r.files; }
      if (files > 0) out.push({ id: c.id, label: c.label, path: c.path, size, files, targets });
    } else {
      const r = await dirSizeFast(c.path);
      if (r.files > 0) out.push({ id: c.id, label: c.label, path: c.path, size: r.size, files: r.files, targets: [c.path] });
    }
  }
  /* 记下本轮扫描命中的全部候选路径，供 fs:clean-junk 校验来源。
   * 用绝对路径归一后的形态比较（大小写不敏感，符合 Windows 路径语义）。 */
  const cachePaths = new Set();
  for (const g of out) for (const t of (g.targets || [])) cachePaths.add(normForJunk(t));
  junkScanCache = { at: Date.now(), paths: cachePaths };
  return out;
});
handle('fs:clean-junk', async (e, targets, keepRoot) => {
  let cleaned = 0, bytes = 0; const errors = [];
  const tmpRoot = path.resolve(os.tmpdir());
  if (!Array.isArray(targets)) return { cleaned: 0, bytes: 0, errors: ['参数必须是路径数组'] };
  for (const t of targets) {
    try {
      if (typeof t !== 'string' || !t.trim()) { errors.push(`非法参数：${String(t)}（路径必须是字符串）`); continue; }
      const abs = path.resolve(t);
      /* 【只接受本次扫描命中的候选，其他一律拒绝】
       * 这是能力范围的边界，不是可选的"额外保险"：
       * 这个通道叫「清理垃圾」，它该动的只有临时文件、浏览器缓存、缩略图缓存。
       * 没有这道校验时，传入任意用户目录都会被递归删除（见上面的注释）。
       * 缓存为空（没扫过 / 进程刚起来）时一律拒绝 —— 没有扫描结果就没有清理依据。 */
      if (!junkScanCache.paths.size) {
        errors.push(`${t}: 没有扫描结果作为依据，请先执行扫描`);
        continue;
      }
      if (!junkScanCache.paths.has(normForJunk(abs))) {
        errors.push(`${t}: 不在本次扫描结果内，拒绝清理（该功能只能清扫描出来的垃圾）`);
        continue;
      }
      // 最后一道防线：绝不允许把 %TEMP% 整体（或其子目录）当作清理目标。
      // %TEMP% 是全机器共享的，里面有别的程序正在用的文件。
      // 允许的只有「本应用自己的产物」这一项。
      if (abs === tmpRoot || abs.startsWith(tmpRoot + path.sep)) {
        const base = path.basename(abs);
        if (!isOwnTempName(base)) {
          errors.push(`${t}: 拒绝清理非本应用产物（%TEMP% 是全机器共享的）`);
          continue;
        }
      }
      // 系统关键目录也不许动
      const crit = pathGuard.checkDeletable(abs, true);
      if (crit) { errors.push(`${t}: ${crit.reason}`); continue; }
      const before = (await dirSizeFast(abs)).size;
      const st = await fsp.stat(abs).catch(() => null);
      if (st && st.isFile()) {
        await fsp.rm(abs, { force: true }); // 文件目标（缩略图缓存）直接删除
      } else if (keepRoot) {
        const entries = await fsp.readdir(abs).catch(() => []);
        for (const n of entries) await fsp.rm(path.join(abs, n), { recursive: true, force: true });
      } else {
        /* 【keepRoot=false 的「连根删」分支已移除】
         * 唯一调用方（js/tools/junk-clean.js）恒传 true，这个分支从来没被用过，
         * 而它是这个通道里最危险的一段（递归删除传入的整个目录）。
         * 删掉它，把这个能力范围外的入口直接消灭，而不是靠"没人传 false"。
         * 如将来真需要删整个根，请走 fs:delete（那条有完整的删除门禁）。 */
        errors.push(`${t}: 不支持删除根目录本身（只清理其中的内容）`);
        continue;
      }
      cleaned++; bytes += before;
    } catch (err) { errors.push(`${t}: ${fmtErr(err)}`); }
  }
  return { cleaned, bytes, errors };
});

/* hash / encrypt / split / dedupe */
const HASH_ALGOS = ['md5', 'sha1', 'sha256', 'sha512'];
/* 单算法通道 fs:hash-file 已移除：渲染层早就改用 -multi 版本一次读盘算多个
 * 摘要（校验 1GB 文件要读 4GB 的老问题），全项目没有调用方了。 */
/* 多算法：**一次读盘**同时算 md5/sha1/sha256/sha512。
 *
 * 【为什么需要】原渲染层的文件校验页对同一个文件连续调用 4 次
 * `fs:hash-file`，每次都完整读一遍盘 —— 校验一个 1GB 文件要读 4GB。
 * 这里改成一次流式读取、多个 hasher 并行 update，磁盘 IO 降到 1/4。
 *
 * 【顺带修】原来用 `fs.statSync(p)` 在主进程同步阻塞：大文件操作期间
 * 整个 UI（含 1.5 秒一次的 sys:stats 推送）都会卡住。改成 await fsp.stat。 */
async function hashFileMulti(p, algos) {
  const list = (Array.isArray(algos) && algos.length ? algos : ['sha256']);
  for (const a of list) if (!HASH_ALGOS.includes(a)) throw new Error('不支持的算法: ' + a);
  const uniq = [...new Set(list)];
  const hashers = Object.fromEntries(uniq.map((a) => [a, crypto.createHash(a)]));
  const st = await fsp.stat(p);          // 异步，不阻塞事件循环
  return await new Promise((resolve, reject) => {
    let done = 0, last = 0;
    const rs = fs.createReadStream(p, { highWaterMark: 1 << 20 });
    rs.on('data', (chunk) => {
      for (const a of uniq) hashers[a].update(chunk);
      done += chunk.length;
      if (Date.now() - last > 200) {
        last = Date.now();
        send('job:progress', { id: p, kind: 'hash', done, total: st.size });
      }
    });
    rs.on('end', () => {
      const hex = {};
      for (const a of uniq) hex[a] = hashers[a].digest('hex');
      resolve({ hex, size: st.size });
    });
    rs.on('error', reject);
  });
}
handle('fs:hash-file-multi', async (e, p, algos) => hashFileMulti(p, algos));

/* 单算法通道 fs:hash-text 已移除，理由同上：文本页走 -multi 版本。 */
// 一次算多个算法：文本页每次输入都要出 3 个摘要，逐个 invoke 会有 3 次 IPC 往返
handle('fs:hash-text-multi', (e, text, algos = ['md5', 'sha1', 'sha256']) => {
  const out = {};
  for (const algo of algos) {
    if (!HASH_ALGOS.includes(algo)) continue;
    out[algo] = crypto.createHash(algo).update(String(text ?? ''), 'utf8').digest('hex');
  }
  return out;
});

const ENC_MAGIC = Buffer.from('HEHEENC1');
function deriveKey(password, salt) { return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }); }
async function cryptStream(p, outPath, password, decrypt) {
  const st = await fsp.stat(p);
  if (path.resolve(p) === path.resolve(outPath)) throw new Error('输出路径不能与源文件相同');
  // Windows 大小写不敏感 + 结尾点/空格差异：realpath 归一后按小写比较，防止同名变体绕过
  let sameFile = false;
  try {
    const rp = fs.realpathSync(p), ro = fs.realpathSync(path.dirname(outPath)) + path.sep + path.basename(outPath);
    sameFile = rp.toLowerCase() === ro.toLowerCase();
  } catch (e) { /* 输出目录尚不存在等情况按字符串比较兜底 */ }
  if (sameFile) throw new Error('输出路径不能与源文件相同');
  let srcStart = 0, cipher, header = null;
  if (!decrypt) {
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(16);
    header = Buffer.concat([ENC_MAGIC, salt, iv]);
    cipher = crypto.createCipheriv('aes-256-cbc', deriveKey(password, salt), iv);
  } else {
    // 先读取 40 字节文件头，再从第 40 字节起进入解密管道
    /* 【最小合法长度是 40 + 16 = 56，不是 64】
     * 文件头固定 40 字节（8 魔数 + 16 salt + 16 iv），其后是一个 AES-CBC 密文。
     * PKCS#7 一定会补齐，所以哪怕原文是空文件（0 字节）也会产出整整一个 16 字节块。
     * 早期这里写死 64，于是「加密 0~15 字节的文件」得到的 56 字节密文被判成
     * 「文件不完整，可能下载时被截断」—— 加密是成功的，解密却永远拒绝，
     * 用户会以为文件坏了、转而去找别的工具重下。实测 15 字节以内全部复现。 */
    const MIN_ENC_SIZE = 40 + 16;
    if (st.size < MIN_ENC_SIZE) throw new Error('文件不完整：加密文件至少应有 ' + MIN_ENC_SIZE + ' 字节（当前 ' + st.size + ' 字节），可能下载或复制时被截断');
    const fh = await fsp.open(p, 'r');
    const head = Buffer.alloc(40);
    try {
      const { bytesRead } = await fh.read(head, 0, 40, 0);
      if (bytesRead < 40) throw new Error('文件不完整：无法读取完整的加密文件头（只读到 ' + bytesRead + ' 字节）');
    } finally { await fh.close().catch(() => {}); }
    if (!head.subarray(0, 8).equals(ENC_MAGIC)) throw new Error('不是有效的核核加密文件（缺少文件头）');
    cipher = crypto.createDecipheriv('aes-256-cbc', deriveKey(password, head.subarray(8, 24)), head.subarray(24, 40));
    srcStart = 40;
  }
  const rs = fs.createReadStream(p, { highWaterMark: 1 << 20, start: srcStart });
  // 先写同目录临时文件，成功后才改名到 outPath。
  // 原来直接写 outPath：失败时 catch 里 rmSync(outPath) 会把**用户原本就存在**的
  // 同名文件一起删掉（探测脚本 t7 复现过：解密失败后用户的重要文件消失）。
  const cryptTmp = tempNames.cryptTmp(outPath);
  const ws = fs.createWriteStream(cryptTmp);
  if (header) ws.write(header);
  let done = 0;
  const total = Math.max(1, st.size - srcStart);
  rs.on('data', (chunk) => { done += chunk.length; send('job:progress', { id: p, kind: 'crypt', done, total }); });
  try {
    await new Promise((resolve, reject) => {
      require('stream').pipeline(rs, cipher, ws, (err) => (err ? reject(err) : resolve()));
    });
    await fsp.rename(cryptTmp, outPath);
  } catch (err) {
    // 只清理我们自己的临时文件；目标位置的原有文件保持不动
    try { fs.rmSync(cryptTmp, { force: true }); } catch (e) {}
    if (decrypt && /bad decrypt|BAD_DECRYPT|wrong final block/.test(String(err.message))) throw new Error('解密失败：密码错误或文件已损坏');
    throw err;
  }
  return { outPath, size: (await fsp.stat(outPath)).size };
}
handle('fs:encrypt-file', async (e, p, outPath, password) => {
  if (!password) throw new Error('请输入密码');
  return await cryptStream(p, outPath, password, false);
});
handle('fs:decrypt-file', async (e, p, outPath, password) => {
  return await cryptStream(p, outPath, password, true);
});

handle('fs:split-file', async (e, p, chunkMB, outDir) => {
  // 异步 stat：大文件分片期间不能阻塞主进程事件循环（UI 与 sys:stats 都要响应）
  const st = await fsp.stat(p);
  const chunkSize = Math.max(1, chunkMB) * 1024 * 1024;
  const base = path.basename(p);
  // 空文件没有可分割的内容：parts 记为 1 并与实际产生的 part1 保持一致，
  // 否则清单 parts=0 而磁盘上留着 0 字节 part1，合并时会按 0 片处理，分片成为孤儿文件。
  const parts = Math.max(1, Math.ceil(st.size / chunkSize));
  const pad = String(parts).length;
  await fsp.mkdir(outDir, { recursive: true });
  let realParts = 0;      // 实际产出的分片数
  let writtenBytes = 0;   // 实际写入的总字节数
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(p, { highWaterMark: 1 << 20 });
    let idx = 1, ws = null, done = 0, pausedFor = null;
    /* 【本次产出的分片路径】失败时要逐个清掉，否则输出目录里留下半截分片，
     * 用户下次分割会撞上 flags:'wx' 的 EEXIST 而永远失败。 */
    const madePaths = [];
    /* 【统一失败收口：读流必须销毁，否则 fd 挂到进程退出】
     * 原实现里 ws 的 error 直接 reject —— 既没 rs.destroy() 也没清半截分片。
     * 触发点很常见：默认输出目录是「源文件 + '.parts'」，同一个文件分两次
     * 必然命中 flags:'wx' 的 EEXIST。
     * 更隐蔽的是：如果 reject 发生在**背压暂停之后**，那个 drain 监听挂在
     * 一个已经出错的 ws 上，永远不会触发，rs 就再也不 resume ——
     * 读流停在暂停态、fd 不释放，直到进程退出。 */
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try { rs.destroy(); } catch (x) {}
      try { if (ws) ws.destroy(); } catch (x) {}
      for (const fp of madePaths) { try { fs.unlinkSync(fp); } catch (x) {} }
      reject(e);
    };
    // 分片必须排他创建（flags: 'wx'）：默认的 'w' 会截断已存在的同名分片，
    // 用户重复分割同一个文件时，旧分片被静默覆盖，合并结果就是新旧混合。
    const openPart = () => {
      const partPath = path.join(outDir, `${base}.part${String(idx).padStart(pad, '0')}`);
      ws = fs.createWriteStream(partPath, { flags: 'wx' });
      /* 【只登记"确实由我们创建成功"的分片】
       * createWriteStream 是异步打开的，'error' 可能要过一会儿才到。
       * 早期这里在 createWriteStream 之后立刻 push，于是 EEXIST 的情况下
       * 那个**别人已有的同名分片**也被当成"本次产出"，fail() 会把它删掉 ——
       * 用户明明只想"中止、别覆盖"，结果旧分片被清理掉了，这正是 wx 要防的事。
       * 现在等 'open' 事件（文件确实建成了）才登记。 */
      ws.on('open', () => { if (!settled) madePaths.push(partPath); });
      ws.on('error', (e) => {
        if (e && e.code === 'EEXIST') {
          fail(new Error('目标目录已存在同名分片：' + path.basename(partPath) + '（为避免覆盖已中止，请换个输出目录或先清理旧分片）'));
          return;
        }
        fail(e); // 磁盘满/权限错误也让 Promise 落定，并清掉半截分片
      });
      realParts = idx;
    };
    openPart();
    rs.on('data', (chunk) => {
      if (settled) return;
      let off = 0;
      while (off < chunk.length) {
        if (ws.bytesWritten >= chunkSize) { ws.end(); idx++; openPart(); if (pausedFor && pausedFor !== ws) { pausedFor = null; rs.resume(); } }
        const n = Math.min(chunk.length - off, chunkSize - ws.bytesWritten);
        const piece = chunk.subarray(off, off + n); off += n;
        writtenBytes += n;
        if (!ws.write(piece)) {
          // 背压：慢盘上防止内存无界堆积。
          // 注意 rs.pause() 只阻止后续 'data' 事件，当前这块 chunk 的 while 仍在继续写，
          // 所以每次 write 返回 false 都会走到这里 —— 必须判断是否已经为这个 ws 注册过
          // drain 监听，否则同一个 ws 上的监听器会无限累积（MaxListenersExceededWarning，
          // 且触发 drain 时会重复注册/重复 resume）。
          if (pausedFor !== ws) {
            pausedFor = ws;
            rs.pause();
            ws.once('drain', () => { if (pausedFor === ws) { pausedFor = null; rs.resume(); } });
          }
        }
      }
      done += chunk.length; send('job:progress', { id: p, kind: 'split', done, total: st.size });
    });
    rs.on('end', () => { ws.end(); ws.on('finish', () => { if (!settled) { settled = true; resolve(); } }); });
    rs.on('error', (e) => fail(e));
  });
  /* 源文件在分割期间被追加/截断会让「清单声明」与「磁盘实际」脱节：
     清单说 3 片、磁盘却有 5 片，合并时只读前 3 片 —— 合并结果少 20MB，
     而 UI 还显示「合并完成」。这里直接核对实际字节数与起始大小。 */
  if (writtenBytes !== st.size) {
    throw new Error(`源文件在分割期间发生变化（开始时 ${st.size} 字节，实际写出 ${writtenBytes} 字节），已中止。请重新分割。`);
  }
  // 分片数以磁盘实际为准，避免清单声明值与磁盘不符
  const finalParts = realParts || parts;
  const manifest = { tool: 'hehe-split', name: base, size: st.size, chunkSize, parts: finalParts };
  const manifestPath = path.join(outDir, `${base}.manifest.hehe.json`);
  // 清单必须原子写：它是合并分片的唯一索引。直接 writeFile 中途失败会把
  // 原本有效的清单改成非法 JSON，分片还在但再也合不回来了。
  await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { parts: finalParts, manifestPath, outDir, chunkSize };
});
handle('fs:merge-parts', async (e, pickedPath, outPath) => {
  let manifestPath;
  if (pickedPath.endsWith('.manifest.hehe.json')) manifestPath = pickedPath;
  else {
    const m = pickedPath.match(/^(.*)\.part\d+$/);
    if (!m) throw new Error('请选择分片文件（.partNNN）或清单文件');
    manifestPath = m[1] + '.manifest.hehe.json';
  }
  const man = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  if (man.tool !== 'hehe-split') throw new Error('清单文件无效');
  const dir = path.dirname(manifestPath);
  // man.name 来自清单文件（内容可被构造），必须限制在清单所在目录内，
  // 否则 .. 分片名能把读取路径指向目录外。
  const safeName = pathGuard.resolveInside(dir, String(man.name || '').replace(/[\\/]/g, path.sep));
  /* 清单里的 parts / size 也必须校验：
     - parts 少了会把磁盘上真实存在的分片静默丢掉（合并结果缺数据，UI 还说"完成"）
     - size 是非数值时 UI 会显示离谱的体积
     - parts 无上限时能触发上亿次 open 调用 */
  const parts = Number(man.parts);
  if (!Number.isInteger(parts) || parts < 1 || parts > 100000) {
    throw new Error('清单文件损坏：分片数量非法（' + String(man.parts) + '）');
  }
  const declSize = Number(man.size);
  if (!Number.isFinite(declSize) || declSize < 0) {
    throw new Error('清单文件损坏：原始大小非法（' + String(man.size) + '）');
  }
  // 磁盘上实际有几个分片？少于清单声明说明中间丢片，必须明确拒绝而不是少合几片。
  const partBase = path.basename(safeName);
  let onDisk = 0;
  try {
    const names = await fsp.readdir(dir);
    const re = new RegExp('^' + partBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.part(\\d+)$');
    for (const n of names) if (re.test(n)) onDisk++;
  } catch (e) {}
  if (onDisk !== 0 && onDisk < parts) {
    throw new Error(`分片不完整：清单声明 ${parts} 片，目录里只有 ${onDisk} 片`);
  }
  // 默认输出「原名.merged.扩展名」，且被占用时自动加序号，避免覆盖原始文件
  let finalOut = outPath;
  if (!finalOut) {
    const ext = path.extname(safeName);
    const stem = path.basename(safeName, ext);
    finalOut = path.join(dir, `${stem}.merged${ext}`);
    for (let i = 1; i < 1000 && fs.existsSync(finalOut); i++) finalOut = path.join(dir, `${stem}.merged(${i})${ext}`);
  } else {
    // 用户显式指定了输出路径：仍要挡住系统关键目录
    const bad = pathGuard.checkOverwritable(finalOut);
    if (bad) throw pathGuard.err(bad.code, bad.reason);
    // 已存在的文件不静默覆盖，改名加序号（与默认路径的行为一致）
    if (fs.existsSync(finalOut)) {
      const ext = path.extname(finalOut), stem = path.basename(finalOut, ext);
      for (let i = 1; i < 1000; i++) {
        const cand = path.join(path.dirname(finalOut), `${stem}.merged(${i})${ext}`);
        if (!fs.existsSync(cand)) { finalOut = cand; break; }
      }
    }
  }
  await fsp.mkdir(path.dirname(finalOut), { recursive: true });
  // 先写到临时名，全部合并成功后再改名到 finalOut。
  // 否则中途遇到缺失/损坏的分片，最终文件名下会留下一个「看起来正常」的半截文件，
  // 用户拿去用才发现内容不全（探测脚本 t8 复现过：4000 字节的残留文件）。
  const partTmp = fsOps.tempPathFor(finalOut, 'merging');
  try {
    let mergedBytes = 0;
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(partTmp);
      ws.on('error', reject);
      let i = 1, done = 0, failed = false;
      const fail = (e) => { if (!failed) { failed = true; try { ws.destroy(); } catch (err) {} reject(e); } };
      const next = () => {
        if (failed) return;
        if (i > parts) { ws.end(); ws.on('finish', resolve); return; }
        const part = path.join(dir, `${path.basename(safeName)}.part${String(i).padStart(String(parts).length, '0')}`);
        const rs = fs.createReadStream(part);
        rs.on('data', (c) => { done += c.length; mergedBytes += c.length; send('job:progress', { id: finalOut, kind: 'merge', done, total: declSize }); });
        rs.on('end', () => { i++; next(); });
        rs.on('error', (e) => fail(new Error(`分片缺失或无法读取：${path.basename(part)}`)));
        rs.pipe(ws, { end: false });
      };
      next();
    });
    // 合并后的字节数必须与清单声明一致：不一致说明分片被改过或清单过期，
    // 宁可报错也不要交出一个"看起来正常"的残缺文件。
    if (declSize > 0 && mergedBytes !== declSize) {
      throw new Error(`合并结果大小不符：实际 ${mergedBytes} 字节，清单声明 ${declSize} 字节（分片可能已被修改）`);
    }
    await fsp.rename(partTmp, finalOut);
  } catch (err) {
    await fsp.rm(partTmp, { force: true }).catch(() => {});
    throw err;
  }
  // 返回真实体积，而不是清单里的声明值
  let realSize = 0;
  try { realSize = (await fsp.stat(finalOut)).size; } catch (e) {}
  return { outPath: finalOut, size: realSize, parts };
});

handle('fs:dedupe', async (e, root, opts = {}) => {
  const mode = opts.mode || 'content';
  const cancelRef = { canceled: false };
  const id = 'dedupe' + (++jobSeq);
  jobs.set(id, { cancel: () => { cancelRef.canceled = true; } });
  latestCancelable = () => { cancelRef.canceled = true; };
  try {
    const byKey = new Map();
    let scanned = 0, lastEmit = Date.now();
    await walkDir(root, { _cancelRef: cancelRef }, async (item) => {
      if (item.type !== 'file') return;
      scanned++;
      const now = Date.now();
      if (now - lastEmit > 300) { lastEmit = now; send('job:progress', { id, kind: 'dedupe', files: scanned }); }
      let key;
      if (mode === 'name') key = path.basename(item.path).toLowerCase();
      else if (mode === 'size') key = 's' + item.size;
      else key = 's' + item.size;
      if (mode !== 'name' && item.size === 0 && mode === 'content') return;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(item.path);
    });
    if (cancelRef.canceled) throw new Error('已取消');
    let candidates = [...byKey.values()].filter(a => a.length > 1);
    if (mode === 'content') {
      // quick filter: head+tail hash
      const quick = new Map();
      for (const group of candidates) {
        for (const f of group) {
          if (cancelRef.canceled) throw new Error('已取消');
          let k = 'err' + f;
          try {
            // 用异步文件句柄读头尾 8KB，避免大目录查重时阻塞主进程
            const fh = await fsp.open(f, 'r');
            try {
              const sz = (await fh.stat()).size;
              const len = Math.min(8192, sz);
              const buf = Buffer.alloc(len * 2);
              await fh.read(buf, 0, len, 0);
              await fh.read(buf, len, len, Math.max(0, sz - len));
              k = crypto.createHash('md5').update(buf).digest('hex');
            } finally { await fh.close(); }
          } catch (err) { /* 文件被删/锁定：跳过快筛 */ }
          if (!quick.has(k)) quick.set(k, []);
          quick.get(k).push(f);
        }
      }
      candidates = [...quick.values()].filter(a => a.length > 1);
      // full hash
      const full = new Map();
      for (const group of candidates) {
        for (const f of group) {
          if (cancelRef.canceled) throw new Error('已取消');
          const h = crypto.createHash('md5');
          await new Promise((res, rej) => {
            fs.createReadStream(f).on('data', c => h.update(c)).on('end', res).on('error', rej);
          });
          const k = h.digest('hex');
          if (!full.has(k)) full.set(k, []);
          full.get(k).push(f);
        }
      }
      candidates = [...full.values()].filter(a => a.length > 1);
    }
    const groups = [];
    for (const files of candidates) {
      // 按名称分组时组内各文件大小可以不同，必须逐个统计，否则「可省空间」会失真。
      // 保守估计：删掉除「最大一份」外的其余文件，因此可省 = 组内总和 - 最大文件大小。
      const sizes = [];
      for (const f of files) {
        const st = await fsp.stat(f).catch(() => null);
        sizes.push(st ? st.size : 0);
      }
      const groupSize = sizes.reduce((a, b) => a + b, 0);
      /* 【不能用 Math.max(...sizes)】sizes 收的是整棵树的文件大小，
       * 查重一个大目录很容易过十万项。实测
       *   Math.max(...new Array(130000).fill(1))
       * 直接抛 RangeError: Maximum call stack size exceeded（13 万之前正常）。
       * 过线即整轮查重失败，而报错跟"文件太多"毫无关系，用户根本猜不到原因。
       * reduce 版没有参数个数上限。 */
      const maxSize = sizes.reduce((a, b) => (a > b ? a : b), 0);
      groups.push({
        size: maxSize, totalSize: groupSize, waste: Math.max(0, groupSize - maxSize),
        hash: mode === 'content' ? 'md5' : mode, files, sizes
      });
    }
    groups.sort((a, b) => b.waste - a.waste);
    return { groups, mode, totalWasted: groups.reduce((s, g) => s + g.waste, 0) };
  } finally { jobs.delete(id); }
});

/* zip */
handle('zip:compress', async (e, paths, outZip) => {
  // 输出文件不得静默覆盖（outZip 来自渲染层，IPC 本身也要设闸门）
  const bad = pathGuard.checkOverwritable(outZip);
  if (bad) throw pathGuard.err(bad.code, bad.reason);
  if (fs.existsSync(outZip)) throw new Error('输出文件已存在，为避免覆盖已拒绝：' + outZip);
  const zip = new AdmZip();
  /* 【目录也要做重名编号，不能只给文件编号】
   * 早期目录直接用 `zip.addLocalFolder(p, path.basename(p))`：把
   *   D:\项目A\docs  和  E:\项目B\docs
   * 一起拖进来时，两者的条目前缀都是 `docs/`，adm-zip 会按条目名合并，
   * 于是其中一份 docs\x.txt 被另一份同名文件覆盖 —— 实测压完只剩一份，
   * 返回结果还报「压缩完成」，属于静默丢数据。文件那条支路早就加了 used
   * 去重，目录这条漏了。这里对顶层目录名用同一套 used 集合编号。 */
  const used = new Set();
  const uniqEntryDir = (base) => {
    if (!used.has(base.toLowerCase())) { used.add(base.toLowerCase()); return base; }
    for (let i = 1; i < 10000; i++) {
      const cand = `${base}(${i})`;
      if (!used.has(cand.toLowerCase())) { used.add(cand.toLowerCase()); return cand; }
    }
    return base + '(' + Date.now() + ')';
  };
  for (const p of paths) {
    const st = await fsp.stat(p);
    if (st.isDirectory()) {
      zip.addLocalFolder(p, uniqEntryDir(path.basename(p)));
    } else {
      // addLocalFile 不传 zipPath 时条目名 = basename。两个不同目录下的同名文件
      // 会命中同一个条目名，adm-zip 直接覆盖前一个 —— 压缩完只剩一份，静默丢数据。
      // 这里重名时自动加序号，保证每个源文件都有条目。
      const base = path.basename(p);
      let entryName = base;
      const stem = path.basename(base, path.extname(base));
      const ext = path.extname(base);
      for (let i = 1; used.has(entryName.toLowerCase()); i++) entryName = `${stem}(${i})${ext}`;
      used.add(entryName.toLowerCase());
      zip.addLocalFile(p, '', entryName);
    }
  }
  if (!zip.getEntries().length) throw new Error('没有可压缩的文件');
  zip.writeZip(outZip);
  return { outZip, size: (await fsp.stat(outZip)).size };
});
handle('zip:extract', async (e, zipPath, outDir) => {
  const zip = new AdmZip(zipPath);
  /* 安全预检：先枚举全部条目并做静态判定，通过后才真正写盘。
     原实现直接 extractAllTo(outDir, true)：overwrite=true（静默覆盖同名文件）
     且没有任何预检，构造过的压缩包可以穿越写出目标目录、用 ADS 藏内容、
     用设备名/UNC 写到任意位置。详见 lib/archive-guard.js。 */
  const raw = zip.getEntries().map((en) => ({
    name: en.entryName,
    isDir: en.isDirectory,
    size: en.header && typeof en.header.size === 'number' ? en.header.size : 0,
    // 压缩大小用于压缩比判定：zip bomb 的特征就是一个极小的压缩体
    // 声称解压出极大内容（adm-zip 会按声明 size 一次性 Buffer.alloc）
    compressedSize: en.header && typeof en.header.compressedSize === 'number' ? en.header.compressedSize : 0,
    isSymlink: false,   // AdmZip 未暴露 Unix 模式，ZIP 符号链接由下方前缀判定兜底
    isHardLink: false
  }));
  const verdict = archiveGuard.inspectEntries(raw);
  /* archive-guard.inspectEntries() 的契约是「要么 return {ok:true}，要么直接 throw」，
   * 不存在 ok:false 的返回。所以下面这行是**死代码**（永不成立），
   * 保留只为防御将来 guard 改成返回 {ok:false} —— 那时这一行会自动生效。
   * 不要因为「看起来没用到」而删掉，也不要误以为这里有失败返回值分支。 */
  if (!verdict.ok) throw new Error('压缩包预检未通过');

  await fsp.mkdir(outDir, { recursive: true });
  /* 两个必须同时成立的性质：
     1) 同名不覆盖（用户原有文件不能被归档内容冲掉）
     2) 目录条目与文件条目路由到同一父目录
        若目录 sub/ 因冲突改名成 sub(1)/，而文件 sub/b.txt 仍写进原来的 sub/，
        归档内容就混进了用户已有目录。
    所以：目录条目一律复用（不编号），只有文件在冲突时加序号。
     3) 中途失败要回滚，不能留半成品（与 seven:extract 行为一致） */
  const dirSet = new Set();
  const dirFor = async (rel) => {
    const abs = pathGuard.resolveInside(outDir, rel);
    if (!dirSet.has(abs)) { await fsp.mkdir(abs, { recursive: true }); dirSet.add(abs); }
    return abs;
  };
  const writtenPaths = [];
  try {
    let written = 0;
    for (const en of zip.getEntries()) {
      const name = archiveGuard.normalizeName(en.entryName);
      if (!name || name === '.' || name === './') continue;
      if (en.isDirectory) { await dirFor(name); continue; }
      const parentRel = path.dirname(name);
      const parentAbs = parentRel && parentRel !== '.' ? await dirFor(parentRel) : path.resolve(outDir);
      const target = await uniqueTarget(parentAbs, path.basename(name));
      const data = en.getData();   // 可能抛 CRC 错，此刻尚未落盘
      await fsp.writeFile(target, data);
      writtenPaths.push(target);
      written++;
    }
    return { outDir, entries: written };
  } catch (err) {
    for (const p of writtenPaths) { try { await fsp.rm(p, { force: true }); } catch (e) {} }
    throw err;
  }
});

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

/* ================= IPC: network ================= */
handle('net:interfaces', async () => {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      out.push({ name, family: a.family, address: a.address, mac: a.mac, internal: a.internal, cidr: a.cidr });
    }
  }
  let ipall = '';
  try { ipall = (await runCmd('ipconfig', ['/all'], { timeout: 15000, encoding: 'gbk' })).stdout; } catch (err) {}
  const info = parseIpconfig(ipall);
  return { addrs: out, adapters: info, hostname: os.hostname() };
});
function parseIpconfig(text) {
  // very tolerant parse of Chinese ipconfig /all
  const adapters = [];
  let cur = null;
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^[^\s].*:/.test(line) && !/^\s{2,}/.test(line)) {
      // adapter header contains 网卡/适配器 (zh) or adapter (en)
      if (/网卡|适配器|adapter/i.test(line) && line.includes(':')) {
        if (cur) adapters.push(cur);
        cur = { name: line.replace(/[:：].*$/, '').replace(/^\d+\.?/, '').trim(), status: '', ipv4: [], gateway: [], dns: [], dhcp: '', mac: '', desc: '' };
        const m = line.match(/[:：]\s*(.*)$/); if (m && /已启用|已连接|connected/i.test(m[1])) cur.status = m[1].trim();
        continue;
      }
    }
    if (!cur) continue;
    const kv = line.match(/^\s*(.+?)\s*[.·]*\s*[:：]\s*(.*)$/);
    if (!kv) continue;
    const k = kv[1], v = kv[2].trim();
    if (/描述|Description/i.test(k)) cur.desc = v;
    else if (/物理地址|Physical Address/i.test(k)) cur.mac = v;
    else if (/DHCP 已启用/.test(k)) cur.dhcpEnabled = v;
    else if (/DHCP 服务器/.test(k)) cur.dhcp = v;
    else if (/IPv4/.test(k)) cur.ipv4.push(v.replace(/\(首选\)/, '').trim());
    else if (/默认网关|Default Gateway/i.test(k)) { if (v) cur.gateway.push(v); }
    else if (/DNS 服务器|DNS Servers/i.test(k)) { if (v) cur.dns.push(v); }
    else if (/媒体状态|Media State/i.test(k)) cur.status = v;
  }
  if (cur) adapters.push(cur);
  return adapters.filter(a => a.ipv4.length || a.mac);
}
handle('net:public-ip', async () => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
    const j = await r.json();
    return { ip: j.ip };
  } finally { clearTimeout(t); }
});
handle('net:tcp-test', (e, host, port, timeoutMs = 4000) => {
  const net = require('net');
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (open) => { if (done) return; done = true; sock.destroy(); resolve({ open, ms: Date.now() - start }); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(parseInt(port, 10), host);
  });
});
/* ================= IPC: 局域网设备扫描 =================
 * 「网里有谁」—— 现有 net 模块只有「我这台机器」的视角（端口/连通/路由）。
 *
 * 【方法】ARP + ping 合并（原因见 lib/lan-scan.js 顶部注释）：
 *   1. 先并发 ping 一轮本机所在 /24 段，把 ARP 缓存催起来；
 *   2. 读 arp -a 拿到 IP + MAC（这是最可靠的来源）；
 *   3. 合并两者，ARP 为主、ping 补充。
 *
 * 【并发】复用 net:scan 的分批并发模型：254 个地址一次全发会打满句柄，
 * 按 20 个一批、每批等完成再下一批。
 */
handle('lan:scan', async (e, opts = {}) => {
  const net = require('net');
  const o = opts || {};

  /* 取本机 IPv4 与默认网关：用 ipconfig 而不是 WMI，因为 ipconfig 更稳且已在本项目里用了 */
  let selfIp = '';
  let adapterName = '';
  let ifaces = [];
  try {
    const r = await runCmd('ipconfig', ['/all'], { timeout: 15000, encoding: 'gbk' });
    const txt = String(r.stdout || '');
    /* 交给 lib 解析出**全部** IPv4 与网卡名，不再取第一个（见下方注释） */
    ifaces = lanScanLib.parseIpconfig(txt);
  } catch (err) { ifaces = []; }

  /* 【必须收集全部 IPv4 再挑，不能取第一个】
   * 装了 VMware / Hyper-V / VirtualBox / WSL 的机器上，虚拟网卡常排在前面，
   * 直接取第一个会去扫虚拟网段（结果「一台设备都没有」，用户以为工具坏了），
   * 本机在公网地址上还会去打别人的 /24。
   * 所以：解析全部候选 → 默认选第一个私有网段 → 没有私有网段就明确报错。
   * 渲染层也可以用 opts.ip 指定网卡（多网卡机器上要让用户能切换）。 */
  const wanted = String(o.ip || o.iface || '').trim();
  if (wanted) {
    const hit = ifaces.find((x) => x.ip === wanted || (x.adapter && x.adapter.indexOf(wanted) !== -1));
    if (hit) { selfIp = hit.ip; adapterName = hit.adapter || ''; }
  }
  if (!selfIp) {
    const pick = lanScanLib.pickScanTarget(ifaces);
    if (pick) { selfIp = pick.ip; adapterName = pick.adapter || ''; }
  }
  if (!selfIp) {
    /* 没有私有网段：明确报错，不要退回去照扫一个公网 /24。
     * 把找到了哪些地址一并说明，用户才知道为什么被拒。 */
    const found = ifaces.map((x) => x.ip).filter(Boolean);
    throw new Error('本机没有可扫描的私有网段（10/8、172.16/12、192.168/16）。' +
      (found.length
        ? '当前检测到的 IPv4：' + found.join('、') + '。请连回内网后重试。'
        : '未能从 ipconfig 读到任何 IPv4 地址，请检查网络连接。'));
  }

  const sub = lanScanLib.subnetOf(selfIp);
  if (!sub) throw new Error('本机 IP 不属于常规 IPv4 地址：' + selfIp);

  const hosts = lanScanLib.hostsToScan(selfIp);
  const id = 'lanscan' + (++jobSeq);
  const cancelRef = { canceled: false };
  jobs.set(id, { cancel: () => { cancelRef.canceled = true; } });

  /* ---- 1) 并发 ping ---- */
  const pinged = [];
  const BATCH = 20;
  const TIMEOUT = 1200;
  let done = 0;

  async function pingOne(ip) {
    return new Promise((resolve) => {
      const s = new net.Socket();
      let finished = false;
      const fin = (ok) => {
        if (finished) return;
        finished = true;
        try { s.destroy(); } catch (err) {}
        resolve(ok);
      };
      s.setTimeout(TIMEOUT);
      s.once('connect', () => fin(true));
      s.once('timeout', () => fin(false));
      s.once('error', () => fin(false));
      try { s.connect(80, ip); } catch (err) { fin(false); }
      /* 用 TCP 80 而不是 ICMP ping：Node 没有原生 ICMP，
       * 且很多设备不响应 ICMP 但开了 80/443。
       * 端口不通不代表设备不在线 —— 那一部分靠 ARP 兜底，
       * 而「催 ARP 缓存」这个目的也达到了（连过就会进 ARP 表）。 */
    });
  }

  try {
    for (let i = 0; i < hosts.length; i += BATCH) {
      if (cancelRef.canceled) break;
      const slice = hosts.slice(i, i + BATCH);
      const res = await Promise.all(slice.map(pingOne));
      for (let k = 0; k < res.length; k++) if (res[k]) pinged.push(slice[k]);
      done += slice.length;
      send('job:progress', { id, kind: 'lan', done, total: hosts.length, found: pinged.length });
    }
  } finally {
    jobs.delete(id);
  }
  if (cancelRef.canceled) throw new Error('已取消');

  /* ---- 2) 读 ARP 表 ---- */
  let arpRows = [];
  try {
    const r = await runCmd('arp', ['-a'], { timeout: 15000, encoding: 'gbk' });
    arpRows = lanScanLib.parseArp(String(r.stdout || ''));
  } catch (err) { arpRows = []; }

  /* ---- 3) 反查主机名（只查前若干个，避免拖太久） ---- */
  const names = {};
  const toResolve = arpRows.slice(0, 30);
  for (const row of toResolve) {
    if (cancelRef.canceled) break;
    try {
      const r = await ps(`(Resolve-DnsName -Name '${row.ip}' -NameType A -ErrorAction SilentlyContinue).NameHost`, 6000);
      const n = String(r.stdout || '').trim().split(/\r?\n/)[0];
      if (n && !/^\d+\./.test(n)) names[row.ip] = n;
    } catch (err) { /* 反查失败很常见，忽略即可 */ }
  }

  /* ---- 4) 合并 ---- */
  const devices = lanScanLib.mergeDevices({ arp: arpRows, pinged, selfIp, names });
  const arpOnly = devices.filter((d) => d.source === 'arp').length;
  const pingOnly = devices.filter((d) => d.source === 'ping').length;

  return {
    selfIp, subnet: sub, scanned: hosts.length,
    /* adapter：本机实际用的网卡名（多网卡时用户要知道扫的是哪张）
     * ifaces：全部候选地址，界面据此给一个网卡切换下拉 ——
     * 默认判断可能仍有偏差（比如虚拟网卡也报了私有段），让用户能自己改。 */
    adapter: adapterName || null,
    ifaces,
    devices,
    stats: { total: devices.length, arpOnly, pingOnly, pingedCount: pinged.length },
    caveats: lanScanLib.caveats({ arpOnly, pingOnly }),
  };
});

handle('net:scan', async (e, host, ports, opts = {}) => {
  const net = require('net');
  const concurrency = opts.concurrency || 300, timeout = opts.timeout || 500;
  const id = 'scanp' + (++jobSeq);
  const cancelRef = { canceled: false };
  jobs.set(id, { cancel: () => { cancelRef.canceled = true; } });
  const open = [];
  let idx = 0, done = 0;
  async function worker() {
    while (!cancelRef.canceled) {
      const i = idx++;
      if (i >= ports.length) return;
      const port = ports[i];
      await new Promise((res) => {
        const s = new net.Socket();
        const fin = () => { s.destroy(); res(); };
        s.setTimeout(timeout); s.once('connect', () => { open.push(port); fin(); });
        s.once('timeout', fin); s.once('error', fin);
        try { s.connect(port, host); } catch (err) { fin(); }
      });
      done++;
      if (done % 100 === 0) send('job:progress', { id, kind: 'ports', done, total: ports.length, open: open.length });
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker));
  } finally { jobs.delete(id); }
  if (cancelRef.canceled) throw new Error('已取消');
  return { open: open.sort((a, b) => a - b), scanned: ports.length };
});
handle('net:http', async (e, opts) => {
  const { method = 'GET', url, headers = {}, body, timeoutMs = 30000 } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const r = await fetch(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body, signal: ctrl.signal });
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.length > 1024 * 512 ? buf.toString('utf8', 0, 1024 * 512) + '\n…[已截断，共 ' + buf.length + ' 字节]' : buf.toString('utf8');
    return { status: r.status, statusText: r.statusText, headers: Object.fromEntries(r.headers.entries()), body: text, bytes: buf.length, ms: Date.now() - start };
  } finally { clearTimeout(timer); }
});
/* speedtest job */
handle('net:speedtest', async (e, { direction, url, seconds = 10 }) => {
  const id = 'speed' + (++jobSeq);
  const ctrl = new AbortController();
  jobs.set(id, { cancel: () => ctrl.abort() });
  latestCancelable = () => ctrl.abort();
  const started = Date.now();
  try {
    if (direction === 'down') {
      const r = await fetch(url || 'https://speed.cloudflare.com/__down?bytes=104857600', { signal: ctrl.signal });
      if (!r.ok) throw new Error('测速服务器响应 ' + r.status);
      const reader = r.body.getReader();
      let bytes = 0, samples = [];
      let lastT = Date.now(), lastB = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        const now = Date.now();
        if (now - lastT > 300) {
          const inst = (bytes - lastB) / ((now - lastT) / 1000) * 8 / 1e6;
          samples.push({ t: now - started, mbps: inst });
          send('job:stream', { id, data: JSON.stringify({ bytes, elapsed: now - started, samples: samples.slice(-40) }) });
          lastT = now; lastB = bytes;
          if ((now - started) / 1000 > seconds + 5) break;
        }
      }
      const elapsed = (Date.now() - started) / 1000;
      return { mbps: bytes * 8 / 1e6 / elapsed, bytes, elapsed, samples };
    } else {
      const size = 10 * 1024 * 1024;
      const payload = Buffer.alloc(size, 1);
      const r = await fetch(url || 'https://speed.cloudflare.com/__up', { method: 'POST', body: payload, signal: ctrl.signal });
      await r.arrayBuffer();
      const elapsed = (Date.now() - started) / 1000;
      return { mbps: size * 8 / 1e6 / elapsed, bytes: size, elapsed, samples: [] };
    }
  } finally { jobs.delete(id); }
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

/* ================= IPC: ffmpeg 环境与音视频处理 ================= */
function binDir() { return path.join(app.getPath('userData'), 'bin'); }
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
handle('ffmpeg:status', async () => {
  const ffmpeg = findFfmpeg(), ffprobe = findFfprobe();
  let version = null;
  if (ffmpeg) {
    try { version = ((await runCmd(ffmpeg, ['-version'], { timeout: 8000 })).stdout || '').split(/\r?\n/)[0]; } catch (e) {}
  }
  return { ffmpeg, ffprobe, binDir: binDir(), version };
});
handle('ffmpeg:pick', async (e) => {
  const picked = await dialog.showOpenDialog(win, {
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
// 带断点续传与自动重试的下载（大文件在国内网络下易断连）
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
handle('ffmpeg:download', async (e, sourceId) => {
  const src = FFMPEG_SOURCES[sourceId] || FFMPEG_SOURCES.npmmirror;
  const id = 'dl' + (++jobSeq);
  const ctrl = new AbortController();
  jobs.set(id, { cancel: () => ctrl.abort() });
  latestCancelable = () => ctrl.abort();
  await fsp.mkdir(binDir(), { recursive: true });
  try {
    if (src.type === 'gz-pair') {
      const files = [['ffmpeg-win32-x64.gz', 'ffmpeg.exe'], ['ffprobe-win32-x64.gz', 'ffprobe.exe']];
      let idx = 0;
      for (const [gzName, exeName] of files) {
        idx++;
        const tmp = path.join(app.getPath('temp'), 'hehe-' + gzName);
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
    const zipPath = tempNames.ffmpegZip({ tempDir: app.getPath('temp') });
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
handle('ffmpeg:remove', async () => {
  await fsp.rm(binDir(), { recursive: true, force: true });
  storeSet('settings.ffmpegPath', undefined);
  storeSet('settings.ffprobePath', undefined);
  return true;
});
handle('ffmpeg:probe', async (e, p) => {
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
handle('target:compress-av', async (e, { items, outDir, targetBytes, mode, ratio }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  const ffprobe = findFfprobe();
  const id = 'tgt' + (++jobSeq);
  const state = { cancel: false, proc: null };
  const killProc = () => {
    try { state.proc && state.proc.kill && state.proc.kill(); } catch (err) {}
    if (isWin && state.proc && state.proc.pid) spawn('taskkill', ['/pid', String(state.proc.pid), '/t', '/f'], { windowsHide: true });
  };
  jobs.set(id, { cancel: () => { state.cancel = true; killProc(); } });
  latestCancelable = () => { state.cancel = true; killProc(); };

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

      const tmpDir = tempNames.tgtTmpDir({ tempDir: app.getPath('temp') });
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
handle('target:plan-image', (e, { round }) => {
  const q = targetSize.planImageQuality(round);
  return { quality: q.quality, scale: q.scale, round, maxRounds: targetSize.MAX_ROUNDS };
});
handle('target:eval-image', (e, { outBytes, targetBytes, round }) => {
  return targetSize.evaluateRound({ outBytes, targetBytes, round });
});

handle('ffmpeg:convert', async (e, { items, outDir, opts }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  const id = 'avc' + (++jobSeq);
  const state = { cancel: false, proc: null };
  jobs.set(id, { cancel: () => { state.cancel = true; try { state.proc && state.proc.kill && state.proc.kill(); } catch (err) {} if (isWin && state.proc && state.proc.pid) spawn('taskkill', ['/pid', String(state.proc.pid), '/t', '/f'], { windowsHide: true }); } });
  latestCancelable = () => { state.cancel = true; try { if (isWin && state.proc && state.proc.pid) spawn('taskkill', ['/pid', String(state.proc.pid), '/t', '/f'], { windowsHide: true }); } catch (err) {} };
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
      if (!isAudioOut) {
        if (opts.vcodec === 'copy') args.push('-c:v', 'copy');
        else if (opts.format === 'webm') { args.push('-c:v', 'libvpx-vp9', '-crf', String(opts.crf || 34), '-b:v', '0', '-row-mt', '1'); }
        else if (opts.format === 'gif') { args.push('-an', '-vf', `fps=${opts.fps || 12},scale=${opts.gifWidth || 480}:-2:flags=lanczos`); }
        else { args.push('-c:v', opts.vcodec === 'libx265' ? 'libx265' : 'libx264', '-crf', String(opts.crf || 23), '-preset', 'veryfast'); if (opts.scale) args.push('-vf', `scale=${opts.scale}:-2`); if (opts.fps) args.push('-r', String(opts.fps)); if (opts.format === 'mp4') args.push('-movflags', '+faststart'); }
      }
      args.push('-progress', 'pipe:1', out);
      send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), stage: 'start' }) });
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
handle('ffmpeg:press', async (e, { items, outDir, opts }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  const id = 'prs' + (++jobSeq);
  const state = { cancel: false, proc: null };
  const killProc = () => { try { state.proc && state.proc.kill && state.proc.kill(); } catch (err) {} if (isWin && state.proc && state.proc.pid) spawn('taskkill', ['/pid', String(state.proc.pid), '/t', '/f'], { windowsHide: true }); };
  jobs.set(id, { cancel: () => { state.cancel = true; killProc(); } });
  latestCancelable = () => { state.cancel = true; killProc(); };
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
      const args = ['-hide_banner', '-y', '-nostats', '-i', input,
        '-c:v', opts.vcodec === 'libx265' ? 'libx265' : 'libx264',
        '-crf', String(opts.crf || 23),
        '-preset', String(opts.preset || 'veryfast'),
        '-pix_fmt', 'yuv420p'];
      if (opts.vcodec === 'libx265') args.push('-tag:v', 'hvc1');
      if (opts.scale) args.push('-vf', `scale=${opts.scale}:-2`);
      if (opts.fps) args.push('-r', String(opts.fps));
      if (opts.stripMeta !== false) args.push('-map_metadata', '-1');
      if (opts.audio === 'mute') args.push('-an');
      else if (opts.audio === 'copy') args.push('-c:a', 'copy');
      else args.push('-c:a', 'aac', '-b:a', opts.audio === '96k' ? '96k' : '128k');
      args.push('-movflags', '+faststart', '-progress', 'pipe:1', out);
      send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), stage: 'start' }) });
      const r = await new Promise((resolve) => {
        const proc = spawn(ffmpeg, args, { windowsHide: true });
        state.proc = proc;
        let lastPct = 0, errOut = '', progBuf = '';
        proc.stdout.on('data', (d) => {
          progBuf += String(d);
          const lines = progBuf.split('\n');
          progBuf = lines.pop() || '';
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
      let inSize = 0, outSize = 0;
      try { inSize = (await fsp.stat(input)).size; if (ok) outSize = (await fsp.stat(out)).size; } catch (err) {}
      results.push({ input, out: ok ? out : null, ok, inSize, outSize, err: ok ? '' : (r.errOut.split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' ') || ('退出码 ' + r.code)) });
      send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok }) });
    }
  } finally { jobs.delete(id); }
  return { id, results, canceled: state.cancel };
});

/* 视频截帧：单帧或帧序列 */
handle('ffmpeg:frames', async (e, { input, outDir, mode, ss, every, count, width }) => {
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

/* 音频剪辑：截取 + 淡入淡出 + 增益 */
handle('ffmpeg:audio-cut', async (e, { input, out, ss, dur, fadeIn, fadeOut, gain, format }) => {
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
async function listDshowDevices() {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return { audio: [], video: [] };
  const r = await new Promise((resolve) => {
    let out = '';
    const p = spawn(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true });
    p.stderr.on('data', d => { out += String(d); });
    p.on('exit', () => resolve(out));
    p.on('error', () => resolve(''));
  });
  return parseDshowDevices(r);
}
handle('rec:audio-devices', async () => {
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
  return { proc: spawn(ffmpeg, args, { windowsHide: true }), args };
}
handle('rec:start', async (e, { outPath, fps, rect, audio, camera, camPos, camScale, overwrite }) => {
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
  recSegDir = tempNames.recSegDir({ tempDir: app.getPath('temp') });
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
  proc.stderr.on('data', (d) => { errOut += String(d); if (errOut.length > 12000) errOut = errOut.slice(-6000); });
  await new Promise(r => setTimeout(r, 1200));
  if (proc.exitCode !== null) {
    recProc = null;
    throw new Error('录制启动失败：' + errOut.split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' '));
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
    setTimeout(() => { try { spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true }); } catch (err) {} }, 5000);
  });
  await new Promise(r => setTimeout(r, 300));
}
handle('rec:pause', async () => { await recStopSeg(); return { ok: true, paused: true }; });
handle('rec:resume', async () => {
  // rec:stop 的 finally 会把 recOpts/recSegDir 置空；只检查 recOpts 会漏掉 recSegDir 已失效的情况
  if (!recOpts || !recSegDir) throw new Error('没有进行中的录制会话');
  return await recStartSeg();
});
handle('rec:stop', async (e, makeGif) => {
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

async function rmQueryLockers(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string' && p.trim());
  if (!list.length) throw new Error('没有要查询的路径');

  /* 先确认文件存在：Restart Manager 对不存在的路径会返回成功但空列表，
   * 那会让用户误以为「没有进程占用」，其实是路径本身错了。 */
  const missing = [];
  for (const p of list) {
    if (!(await pathExists(p))) missing.push(p);
  }
  if (missing.length === list.length) throw new Error('路径不存在：' + missing.join('、'));

  // 单引号转义（PowerShell 里 '' 表示一个字面单引号）
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  /* 无条件带上 Add-Type：每次 ps() 都是新进程，类型不会跨进程留存 */
  const addType = `Add-Type -TypeDefinition @'\n${rmLockers.FILES_CS}\n'@\n`;

  /* 【必须分块，否则深路径必然 spawn ENAMETOOLONG】
   * 早期这里把 list 全部拼成一个数组字面量。file:who-locks-dir 允许注册
   * 200 个文件（见上面 `files.length >= 200` 的上限），而 Windows 命令行
   * 上限约 32767 字符：200 个 200 字符的路径拼出来接近 4 万字符，
   * execFile 直接抛 ENAMETOOLONG，PowerShell 根本没启动 ——
   * 用户看到的是一个 spawn 错误，而不是占用列表。
   * 同一文件的 link:scan / linkNatures 早就为此做了 PS_PATH_BATCH 分块，
   * 这里保持一致；每块单独起一次 ps，结果合并。
   *
   * 【分块不能改变结论】RM 是「整批注册再取进程列表」，分块后每块各自
   * 给出该块内文件被谁占用；把各块的 lockers 按 pid+type 去重合并即可，
   * 与整批查询的语义等价（我们本来也无法把进程一一对应到具体文件）。 */
  const rows = [];
  const blockErrors = [];
  for (let i = 0; i < list.length; i += PS_PATH_BATCH) {
    const chunk = list.slice(i, i + PS_PATH_BATCH);
    const arr = chunk.map(q).join(',');
    let r;
    try {
      r = await ps(`${addType}[HeheFiles.Util]::Lockers(@(${arr}))`, 45000);
    } catch (err) {
      blockErrors.push(shortErr(err));
      continue;
    }
    const out = String(r.stdout || '');
    if (/^ERR\t/m.test(out)) {
      const parts = out.trim().split('\t');
      const code = parts[2];
      /* 某一块的 RM 失败（例如混进了目录/链接导致整批 ERR 5）不应该
       * 让整次查询作废 —— 其余块的结果仍然有效，如实记下这一块失败即可。 */
      blockErrors.push('错误码 ' + code);
      continue;
    }
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const p = line.split('\t');
      const pid = parseInt(p[0], 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      rows.push({ pid, name: p[1] || '', type: p[2] || 'app' });
    }
  }
  /* 一块都没成功、且确实有分块 → 说明查询整体不可用（不是「没有占用」）。
   * 必须抛出去，否则会被当成「查了，没占用」。 */
  if (blockErrors.length && blockErrors.length === Math.ceil(list.length / PS_PATH_BATCH) && !rows.length) {
    throw new Error('Restart Manager 查询失败（' + blockErrors.slice(0, 2).join('；') + '）');
  }

  /* 补上进程的可执行路径与启动时间，方便用户判断「这是不是我自己开的」。
   * RM 只给 PID 和名字，路径要从进程表取。取不到（已退出/无权限）就留空。
   *
   * 【一次 PowerShell 取回整批，不要每个 pid 起一次】
   * 早期这里是循环里逐个 ps()，5 个占用进程就是 5 次 powershell.exe 启动，
   * 拖到四五秒才出结果。而 RM 一次就能给出全部 pid，没有理由逐条查。
   * 现在把整批 pid 拼成一次调用的 `-Id 1,2,3`，每行回一个
   * `pid \t ProcessName \t Path \t WorkingSet`，再按 pid 合并回去。
   * 取不到的字段照旧留空，不因为某个进程没权限/已退出就中断整批。 */
  const needPath = rows.filter((r) => r.type !== 'service');
  if (needPath.length) {
    const ids = needPath.map((r) => r.pid).join(',');
    try {
      const r2 = await ps(
        `foreach($id in @(${ids})){` +
        `$p=Get-Process -Id $id -ErrorAction SilentlyContinue;` +
        `if($p){ $path=''; try{$path=$p.Path}catch{}; ` +
        `@($p.Id, $p.ProcessName, $path, [int]$p.WorkingSet64) -join "\`t" } }`,
        Math.max(8000, needPath.length * 400));
      for (const line of String(r2.stdout || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const seg = line.split('\t');
        const pid = parseInt(seg[0], 10);
        if (!Number.isFinite(pid)) continue;
        const row = rows.find((r) => r.pid === pid);
        if (!row) continue;
        if (seg[1]) row.procName = seg[1];
        if (seg[2]) row.path = seg[2];
        if (seg[3]) row.mem = parseInt(seg[3], 10) || 0;
      }
    } catch (err) { /* 整批取不到不影响主结果：pid 与名字已经有 */ }
  }

  // 按 pid 去重（同一进程可能被 RM 列多次）
  const seen = new Set();
  const uniq = [];
  for (const row of rows) {
    const k = row.pid + '|' + row.type;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(row);
  }
  return { paths: list, missing, lockers: uniq };
}

handle('file:who-locks', async (e, paths) => {
  const r = await rmQueryLockers(paths);
  // 有占用进程时给一条可操作的建议，而不是只回一堆 pid
  if (!r.lockers.length) {
    return Object.assign(r, { advice: '没有进程占用这些文件。若仍然删不掉，可能是权限不足或路径被其它程序（如杀软）临时拦截。' });
  }
  const names = [...new Set(r.lockers.map((x) => x.name || x.procName || ('PID ' + x.pid)))];
  return Object.assign(r, {
    advice: '被以下进程占用：' + names.join('、') + '。确认是你自己的程序后可以结束它；系统服务请勿随意结束。',
  });
});

/* 一次查多个文件时，也要能查「目录里所有被占用的文件」——
 * 删目录删不掉时最有用。这里只扫一层，避免大目录卡死。 */
handle('file:who-locks-dir', async (e, dir) => {
  if (!(await pathExists(dir))) throw new Error('目录不存在：' + dir);
  const st = await fsp.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('不是目录：' + dir);
  /* 只取前 200 个：Restart Manager 单次注册太多文件会明显变慢，
   * 而用户真常见的是「目录里有一两个文件被占用」。
   *
   * 【只注册普通文件，不注册子目录和链接 —— 实测这是必须的】
   * 逐个二分验证过，RmGetList 返回错误码 5（Access denied）的条件是：
   *   注册一个普通文件            → 正常返回占用进程
   *   注册一个目录（哪怕只是父目录）→ ERR list 5
   *   注册一个 junction/符号链接    → ERR list 5
   *   注册 文件+目录 / 文件+链接    → 同样整批 ERR 5
   * 这类条目会让**整个查询**失败，而不是「这一项没查到」。
   * 而这恰恰是最常见的情形：用「目录搬家」搬过的目录里就有一个 junction，
   * 于是用户点「查占用」只看到「Restart Manager 查询失败」。
   *
   * 跳过它们不影响结论：用户要的是「删目录删不掉时，里面哪个文件被占」，
   * 文件被占用才是 RM 能定位的情形；目录被占用（有程序把它当工作目录）
   * RM 本来就查不到。跳过的项在 advice 里如实说明，不假装扫过全部。 */
  let files = [];
  let skipped = 0;
  let total = 0;
  try {
    const raw = await fsp.readdir(dir, { withFileTypes: true });
    total = raw.length;
    for (const ent of raw) {
      if (files.length >= 200) break;
      /* 用 Dirent 判断：不额外 stat，也不会跟随链接 */
      if (!ent.isFile()) { skipped++; continue; }
      files.push(path.join(dir, ent.name));
    }
  } catch (err) { throw new Error('读取目录失败：' + err.message); }

  if (!files.length) {
    return {
      paths: [], missing: [], lockers: [], scanned: 0, total, skipped,
      advice: total
        ? '目录内没有可查询的普通文件（共 ' + total + ' 项，其中 ' + skipped +
          ' 项是子目录或链接）。'
        : '目录是空的，没有被占用的文件。',
    };
  }
  const r = await rmQueryLockers(files);
  return Object.assign(r, {
    scanned: files.length, total, skipped,
    advice: r.lockers.length
      ? '目录内有 ' + r.lockers.length + ' 个进程占用的文件。' +
        (skipped ? '（另有 ' + skipped + ' 项子目录/链接未纳入查询）' : '')
      : '目录内没有检测到文件被占用（已检查 ' + files.length + ' 个普通文件' +
        (skipped ? '，跳过 ' + skipped + ' 项子目录/链接' : '') + '）。',
  });
});

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
async function collectLinks(root, opts) {
  const o = opts || {};
  const maxEntries = o.maxEntries || 200000;
  const wantSize = !!o.wantSize;
  const found = [];
  let scanned = 0, truncated = false;
  /* 【wantSize：一次遍历同时给出体积与链接】
   * 搬家预检本来既要「要复制多少字节」（links.dirSize）又要「有几个链接」
   * （collectLinks），于是就同一棵树走两遍 —— 目录项读两遍、文件还各 stat 一遍。
   * 大目录上预检要等很久，而两个数的遍历规则（不跟随链接）本来就一样。
   * 需要体积时在这里顺带累加，两份数据出自同一次遍历。 */
  let bytes = 0, files = 0, dirs = 0;
  const stack = [path.resolve(root)];

  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = await fsp.readdir(cur, { withFileTypes: true }); }
    catch (err) { continue; }   // 无权限/已消失的目录跳过即可
    dirs++;

    for (const d of ents) {
      scanned++;
      if (scanned > maxEntries) { truncated = true; break; }
      const full = path.join(cur, d.name);

      /* isSymbolicLink() 对 junction 也返回 true —— 这正是我们要找的 */
      if (d.isSymbolicLink()) {
        found.push(full);
        continue;    // 关键：不进入链接，否则会把目标树当成本目录树
      }
      if (d.isDirectory()) { stack.push(full); continue; }
      if (wantSize && d.isFile()) {
        /* 与 lib/links.js 的 dirSize 同规则：链接不占本卷空间，跳过；
         * 普通文件按真实大小累加（读不到就跳过，不编数字）。 */
        try { const st = await fsp.stat(full); bytes += st.size; files++; } catch (err) {}
      }
    }
    if (truncated) break;
  }
  return { links: found, scanned, truncated, bytes, files, dirs };
}

handle('link:scan', async (e, root, opts = {}) => {
  if (!(await pathExists(root))) throw new Error('目录不存在：' + root);
  const r0 = await fsp.stat(root).catch(() => null);
  if (!r0 || !r0.isDirectory()) throw new Error('不是目录：' + root);

  const { links: found, scanned, truncated } = await collectLinks(root, opts);

  /* 【为什么不再对每个链接起一次 PowerShell】
   * 原来在循环里调 links.linkInfo(p, ps)，每一项都是一次新的
   * powershell.exe 启动（约 0.3~1 秒）。200 个链接就是几分钟，
   * 耗时随链接数线性膨胀。
   *
   * 现在改成：
   *   1) 目标用 fs.readlinkSync —— 它直接读 reparse point 的 target，
   *      junction 同样支持（已实测：readlinkSync 返回 junction 的目标）；
   *   2) 类型与属性用**一次** Get-ChildItem 批量取回整个 root 的所有
   *      reparse point，不再放进循环。
   * 某个链接读不到目标就标 null，绝不因此中断整批。
   *
   * 分类逻辑（links.classifyLink）保持原样，只换数据来源。 */
  const targetByName = new Map();   // 小写路径 → 目标
  const typeByName = new Map();

  for (const p of found) {
    try {
      /* readlinkSync 返回的是目标路径；读不到（权限/损坏）就留 null */
      targetByName.set(p.toLowerCase(), fs.readlinkSync(p));
    } catch (err) {
      targetByName.set(p.toLowerCase(), null);
    }
  }

  /* 【不再用 Get-ChildItem -Recurse 重扫一遍全树】
   * 早期这里为了拿到 LinkType，又用 PowerShell 把整个 root 递归遍历一次 ——
   * 而 collectLinks 已经用 Node 完整遍历过了，等于双倍 IO，
   * 大目录上这一趟就是几十秒的纯浪费。
   * 现在只对**已经收集到的链接**做一次批量 Get-Item（数量通常是个位数到几十），
   * 并把 Node 侧就能判断的特征先填上：
   *   - readlink 得到的 target 若是目录且能在盘符内解析 → 极可能是 junction；
   *   - 但真正的 LinkType 交给 PowerShell 批量取，取不到就留空（只是展示信息）。
   * 注意：targetByName 已经有了 readlink 的结果，这里只用它兜底。 */
  let typeQueryError = null;
  try {
    const q = (x) => "'" + String(x).replace(/'/g, "''") + "'";
    /* 【必须分块】几百个路径拼成一条会撞命令行上限（spawn ENAMETOOLONG），
     * 那时整趟查询作废、所有链接的 LinkType 都空着（只是展示信息，
     * 但用户会以为「这些链接没类型」，而真相是查询根本没跑起来）。 */
    for (let i = 0; i < found.length; i += PS_PATH_BATCH) {
      const chunk = found.slice(i, i + PS_PATH_BATCH);
      try {
        const arr = chunk.map(q).join(',');
        const r = await ps(
          /* 结尾的 exit 0：悬空链接（Get-Item 拿不到）本来就会让 PowerShell
           * 返回非零，而那是**正常状态**，不该被算成「查询失败」。 */
          `Get-Item -LiteralPath @(${arr}) -Force -ErrorAction SilentlyContinue | ` +
          `ForEach-Object { @($_.FullName, [string]$_.LinkType, [string]$_.Target) -join [char]9 }; exit 0`,
          Math.max(15000, chunk.length * 300));
        for (const line of String(r.stdout || '').split(/\r?\n/)) {
          if (!line.trim()) continue;
          const seg = line.split('\t');
          if (seg.length < 2) continue;
          const key = seg[0].toLowerCase();
          typeByName.set(key, seg[1] || '');
          /* PowerShell 的 Target 只在 readlink 失败时作为兜底 */
          if (!targetByName.get(key) && seg[2]) targetByName.set(key, seg.slice(2).join('\t'));
        }
      } catch (err) {
        /* 单块失败不影响其它块，但要记下来如实告知（不能再全静默）。
         * 截断：err.message 里通常带着整条命令行（几千字符），
         * 原样塞进界面没人读得下去；错误码才是关键信息。 */
        typeQueryError = (typeQueryError ? typeQueryError + '；' : '') + shortErr(err);
      }
    }
  } catch (err) { typeQueryError = err.message; }

  const items = [];
  for (const p of found) {
    const key = p.toLowerCase();
    const info = {
      type: typeByName.get(key) || '',
      target: targetByName.get(key) || '',
    };
    const cls = links.classifyLink(p, info);
    items.push({
      path: p,
      kind: cls.kind,
      reason: cls.reason,
      target: cls.target || info.target || null,
      linkType: info.type || null,
      notLink: !!cls.notLink,
      crossVolume: !!cls.crossVolume,
    });
  }

  /* 分五类汇总（前端按这个顺序分组）。
   * 【新增 opaque 必须在这里登记】漏登记的类别会被下面的
   * `groups[it.kind] ? it.kind : 'ok'` 兜底塞进「正常」——
   * 一个「读不到、无法判断」的链接被显示成「正常」，比不显示更糟。 */
  const groups = { ok: [], dead: [], loop: [], system: [], crossvol: [], opaque: [] };
  for (const it of items) {
    const k = groups[it.kind] ? it.kind : 'ok';
    groups[k].push(it);
  }
  const counts = {};
  for (const k of Object.keys(groups)) counts[k] = groups[k].length;

  return {
    root, scanned, truncated,
    total: items.length,
    counts,
    groups,
    kinds: links.LINK_KINDS,
    /* 链接类型（junction / symlink）是**展示**字段，查询失败不影响判定结果，
     * 但必须让用户知道「类型那列是空的」是因为查询失败，而不是真的没有类型。 */
    typeQueryError,
    advice: items.length
      ? '共 ' + items.length + ' 个链接：' +
        Object.entries(counts).filter(([, n]) => n).map(([k, n]) => links.LINK_KINDS[k].label + ' ' + n).join('、')
      : '这个目录里没有找到任何链接（目录联接或符号链接）。',
  };
});

handle('link:remove', async (e, paths, opts = {}) => {
  /* 只允许清理僵尸链接。这一条必须在主进程强制 —— 前端过滤只是体验，
   * 渲染层完全可能构造任意路径调过来。 */
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string' && p);
  if (!list.length) throw new Error('没有要清理的链接');

  const removed = [];
  const skipped = [];

  /* 【不再对每个链接起一次 PowerShell，但复核一步都不能省】
   * 早期这里是循环里 `await links.linkInfo(p, ps)`：每项启动一个新的
   * powershell.exe（约 0.3~1 秒），50 个僵尸链接就要一两分钟，
   * 和刚修好的 link:scan 形成反差 —— 用户点下去长时间没反馈，会重复点。
   *
   * 现在目标用 fs.readlinkSync 直接读 reparse point 的 target（junction 也支持），
   * 这是纯文件系统操作，不起进程；类型只是展示信息，清理路径根本不用它。
   * classifyLink 仍**逐项**重新跑一遍：扫描结论是渲染层带过来的历史数据，
   * 不能当授权依据 —— 二次校验这道闸必须留着，只是换掉了慢的那一层。 */
  for (const p of list) {
    let target = '';
    try { target = fs.readlinkSync(p); } catch (err) { target = ''; }
    const info = { target };
    const cls = links.classifyLink(p, info);
    if (cls.kind !== 'dead') {
      /* 非僵尸链接一律不动：ok 是不必删，loop/system/crossvol 是需要人工判断。
       * 用户明确只想清僵尸，这里替他把关。 */
      skipped.push({ path: p, kind: cls.kind, reason: cls.reason });
      continue;
    }
    if (opts.dryRun) { removed.push({ path: p, dryRun: true, target: cls.target }); continue; }
    const r = await links.removeLinkOnly(p);
    removed.push({ path: p, target: r.target, method: r.method });
  }
  return {
    removed, skipped,
    advice: removed.length
      ? '已清理 ' + removed.length + ' 个僵尸链接（只删链接本身，未触碰任何目标数据）' +
        (skipped.length ? '；跳过 ' + skipped.length + ' 个非僵尸链接' : '')
      : '没有可清理的僵尸链接' + (skipped.length ? '（' + skipped.length + ' 个链接不属于僵尸类）' : ''),
  };
});

/* 把链接集合转成「相对源根的 posix 相对路径」映射，便于目标侧重建。 */
function relKey(root, full) {
  const r = path.resolve(root);
  const f = path.resolve(full);
  return path.relative(r, f).split(path.sep).join('/');
}

/* 判断某个路径是否落在「被排除的链接」列表里。
 * 用规范化后的相对路径做精确比较，避免前缀误伤
 * （/a/link 不应把 /a/link2 也算进去）。 */
function buildLinkKeySet(root, linkList) {
  const set = new Set();
  for (const l of linkList) set.add(relKey(root, l).toLowerCase());
  return set;
}

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
async function copyTreeExcludingLinks(srcAbs, dstAbs, linkList) {
  const skip = buildLinkKeySet(srcAbs, linkList);
  /* 【复制期间源条目消失不是"搬家失败"】
   * 源目录往往是活的：用户一边搬一边在往里写日志、删临时文件，
   * 或者别的程序在清理缓存。readdir 拿到了目录项，等到 copyFile 时
   * 那个文件可能已经不在了 —— 抛 ENOENT。
   * 早期这里没有兜底，一个 ENOENT 就让整次搬家中止并回滚：
   * 大目录搬了半小时，因为一个被删掉的临时文件全白费，
   * 而报错是裸的「ENOENT: no such file or directory, copyfile ...」。
   * 现在的口径：
   *   · ENOENT（源条目已消失）→ 跳过并计数，最后如实告诉用户跳了几个；
   *   · EBUSY/EPERM/EACCES（真被占用/没权限）→ 仍然抛出，因为这必须
   *     让用户去处理（关闭程序/提权），静默跳过会得到一份悄悄变少的副本。
   */
  /* 【消失的条目要按类型分开计数】
   * 早期把文件与目录都算进一个 skippedDisappeared，界面文案却统一写成
   * 「N 个文件在复制期间从源目录消失」—— 一个目录被删掉时这句话是错的，
   * 而且用户会去数文件，数不出来。所以文件与目录各记一份，界面按两者组合说话。 */
  const stats = {
    files: 0, dirs: 0,
    skippedFiles: 0, skippedDirs: 0,
    disappeared: [],
  };
  const noteGone = (rel, kind) => {
    if (kind === 'dir') stats.skippedDirs++;
    else stats.skippedFiles++;
    if (stats.disappeared.length < 20) stats.disappeared.push(rel);
  };
  /** 兼容汇总：两个计数之和（调用方与界面按这个判断「要不要提示」）。 */
  const totalGone = () => stats.skippedFiles + stats.skippedDirs;

  async function walk(relPosix) {
    const srcDir = relPosix ? path.join(srcAbs, ...relPosix.split('/')) : srcAbs;
    const dstDir = relPosix ? path.join(dstAbs, ...relPosix.split('/')) : dstAbs;
    await fsp.mkdir(dstDir, { recursive: true });

    let ents;
    try { ents = await fsp.readdir(srcDir, { withFileTypes: true }); }
    catch (err) { throw new Error('读取目录失败（' + srcDir + '）：' + err.message); }

    for (const ent of ents) {
      const childRel = relPosix ? relPosix + '/' + ent.name : ent.name;
      const srcChild = path.join(srcDir, ent.name);
      const dstChild = path.join(dstDir, ent.name);

      if (skip.has(childRel.toLowerCase())) continue;  // 链接：跳过，稍后重建
      if (ent.isSymbolicLink()) continue;               // 兜底：任何漏网的链接

      if (ent.isDirectory()) {
        try {
          await walk(childRel);
          stats.dirs++;
        } catch (err) {
          /* 子目录整个消失（被删了）也算「复制期间消失」，不当致命错。
           * walk 内部把 readdir 失败包装成了可读文案（不再带 err.code），
           * 所以这里靠原文里是否含 ENOENT 来判定；其它读取失败照旧上抛。
           *
           * 【必须把刚才建出来的空目录删掉】
           * walk(childRel) 第一件事就是 fsp.mkdir(dstDir, { recursive: true })，
           * 之后才 readdir —— 也就是说目录不存在这件事是**readdir 时**才发现的，
           * 那时目标侧的空目录已经建好了。不删的话目标树里就多一个源里没有的
           * 空目录，而 verifyCopy 只从**源侧**往目标侧对，永远发现不了它。
           * 安全性：只删「刚由 walk 创建、且确认为空」的目录 —— 先 readdir 确认
           * 为空，再用 rm 且不开 recursive，绝不递归删掉可能存在的别的东西。 */
          const msg = (err && err.message) || '';
          if (err && (err.code === 'ENOENT' || /ENOENT/.test(msg))) {
            noteGone(childRel, 'dir');
            const dstDirGone = path.join(dstDir, ent.name);
            try {
              const left = await fsp.readdir(dstDirGone);
              if (left.length === 0) await fsp.rm(dstDirGone, { force: true });
            } catch (e2) { /* 已经不在/没权限：不影响搬运，忽略即可 */ }
          } else throw err;
        }
      } else if (ent.isFile()) {
        try {
          await fsp.copyFile(srcChild, dstChild);
          stats.files++;
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            /* 源文件在 readdir 之后、copyFile 之前被删掉了 —— 跳过它继续搬，
             * 最后把「跳了几个」如实告诉用户（静默跳过等于悄悄少拷文件）。*/
            noteGone(childRel, 'file');
            /* 目标侧可能有这次 copy 留下的半成品，清掉以免校验阶段对不上 */
            try { await fsp.unlink(dstChild); } catch (e) {}
          } else if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
            /* 真被占用/没权限：必须让用户处理，不能静默跳过 ——
             * 否则用户拿到一份"成功"但少了文件的副本。换成能看懂的文案。 */
            const why = err.code === 'EBUSY' ? '文件正被其它程序占用'
              : (err.code === 'EACCES' ? '没有读取权限' : '没有权限或被安全软件拦截');
            const e2 = new Error('复制失败（' + childRel + '）：' + why +
              '。请关闭占用它的程序（或检查权限）后重试；本次搬家已回滚，源目录未受影响。');
            e2.cause = err;
            throw e2;
          } else throw err;
        }
      }
      /* 其它类型（设备/管道等）在普通目录里不常见，跳过即可 */
    }
  }

  await walk('');
  /* 对外的返回结构保持一个总数（调用方与 emit 都用它），
   * 但也把分类计数带回去，界面可以用更准确的说法。 */
  return Object.assign({}, stats, { skippedDisappeared: totalGone() });
}

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
async function restoreLinksIntoTarget(srcAbs, dstAbs, linkList, natures) {
  const nat = natures || new Map();
  const created = { count: 0, failed: [], fileLinks: 0, innerRewritten: 0, srcReadableLinks: [] };
  for (const l of linkList) {
    const rel = relKey(srcAbs, l);
    try {
      /* 【目标落在源目录树内部时必须改写】
       * 搬家第 3 步把源目录改名成 .hehe-bak、第 6 步删掉它。所以任何
       * 「目标在源树内部」的链接（指向源自身、源内子目录、源内兄弟目录）
       * 如果照抄旧的绝对目标，重建出来的链接指向的是一个**马上就会消失**
       * 的路径 —— 搬家全程不报错、界面说「搬家完成」，目标侧那个链接却是死的。
       * 这类链接的正确目标是「新位置里的对应路径」：src\sub → dst\sub。
       * 目标在源树之外的（别的盘、别的目录）才保持原样。 */
      let absTarget = linkTargetAbs(l);
      if (isInsideTree(absTarget, srcAbs)) {
        /* 【相对路径必须用**归一后**的两端算】
         * 只把 isInsideTree 改成归一比较还不够：这里若拿原始字面量算
         * path.relative，8.3 短名的目标（...\VERYLO~1\sub）会算成
         * '..\VERYLO~1\sub'，path.join 出来的是一条指回旧位置的怪路径 ——
         * 链接建得成功、源一改名就成死链（实测：readlink 仍是短名旧路径）。
         * 两端都过 normalizeForComparePath，relative 才知道它们同源。 */
        const srcNorm = normalizeForComparePath(srcAbs);
        const tgtNorm = normalizeForComparePath(absTarget);
        absTarget = path.join(dstAbs, path.relative(srcNorm, tgtNorm));
        created.innerRewritten++;
      }
      const dstChild = path.join(dstAbs, ...rel.split('/'));
      await fsp.mkdir(path.dirname(dstChild), { recursive: true });
      /* 【目标侧同名项要按类型清，清不掉必须记账】
       * 原写法是 `try { fs.unlinkSync(dstChild); } catch (e) { 空 catch }`：
       *   · unlinkSync 只能删文件/链接，同名项是**目录**时必然 EPERM/EISDIR，
       *     然后被空 catch 吃掉 —— 接着 symlink 撞上已存在的目录而失败，
       *     报出来的错是「重建链接失败」+ 一句跟真正原因无关的 EEXIST；
       *   · 真要删时用同步调用阻塞主进程（这里已经在 async 函数里）。
       * 现在先 lstat 判类型再删，仍失败就把可读原因 push 进 failed，
       * 让上层能如实说出「目标侧已有同名项且清不掉」，而不是吞掉。
       * 理论上这个分支不该走到（目标目录树是我们刚建的），但
       * 「刚建好的树」和「此刻磁盘上的树」可能被第三方改过，不能假设。 */
      if (await pathExists(dstChild)) {
        try {
          const st = fs.lstatSync(dstChild);
          if (st.isDirectory() && !st.isSymbolicLink()) {
            /* junction / 目录链接在 Windows 上 lstat 也报 directory，
             * 但带 reparse 标记；用 rmSync 递归删对两者都安全
             * （它删的是这个条目本身，不会跟着链接进去删目标）。 */
            fs.rmSync(dstChild, { recursive: true, force: true });
          } else {
            fs.unlinkSync(dstChild);
          }
        } catch (e) {
          /* 不吞：这里失败就等于后面的 symlink 注定失败，
           * 早一点把真正的原因（清不掉同名项）说出来。 */
          throw new Error('目标侧已有同名项且无法清除（' + dstChild + '）：' + ((e && e.message) || e));
        }
      }
      /* 源侧这个链接本来是活的吗？两个用途：
       *   1) 建完自检（见下）只对活的做要求；
       *   2) 把「源侧可读」的链接收集起来回传给调用方 —— 源目录改名之后，
       *      这些链接在目标侧也必须可读（那时才看得出「照抄旧路径」的坏链）。
       *
       * 【判据必须是 stat，不能用 access/readdir 组合】
       * 实测（本机）：一个目标已被删的悬空 junction，
       *   lstat → ok   access → ok   readdir → ENOENT   stat → ENOENT
       * access 判的是「这个**条目**能不能访问」，悬空链接的条目当然在，
       * 于是它一路返回成功 —— 拿它当「活得成」的判据会把悬空链接当成活的。
       * stat 会跟随链接、目标不在就抛 ENOENT，这才是「能不能读到东西」。
       * readdir 也能判，但它对**文件**链接无效（不是目录），
       * 所以统一用 stat。 */
      const isLive = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };
      const srcReadable = isLive(l);
      if (srcReadable) created.srcReadableLinks.push(l);
      const kind = nat.get(l.toLowerCase()) || linkNature(l);
      if (kind === 'dir') {
        await fsp.symlink(absTarget, dstChild, 'junction');
      } else if (kind === 'file') {
        /* 文件符号链接：不加类型参数（Node 默认按 file 语义创建）。
         * 需要 SeCreateSymbolicLinkPrivilege，失败会被下面的 catch 记入 failed。 */
        await fsp.symlink(absTarget, dstChild);
        created.fileLinks++;
      } else {
        /* 连「目录还是文件」都判不出来：宁可不建，也不造一个坏链接。
         * junction 与符号链接在目标类型上不通用，猜错的代价是
         * 「搬家成功但链接打不开」这种最难排查的形态。 */
        throw new Error('无法判断这个链接指向目录还是文件，拒绝重建（避免造出打不开的链接）');
      }
      /* 【建完当场验一次：源侧可读的，目标侧也必须可读】
       * 这一层抓的是「链接建出来了，但它指向的东西此刻就不存在」——
       * 典型是目标盘的对应目录没被复制过去，或者目标路径拼错。
       * 这类失败很隐蔽：symlink 调用本身会成功（Windows 允许悬空 junction），
       * 不做自检的话 created 会 +1，一路「成功」到界面上。
       *
       * 【它抓不到「内部链接照抄旧路径」那个 bug，说清楚免得误以为有保险】
       * 那种情况下，链接目标此刻（源目录还没改名）完全有效，readdir 会成功；
       * 链接是等到第 3 步源目录改名 .hehe-bak 之后才变死的。
       * 那个 bug 由**目标改写**（上面的 isInsideTree 分支）解决，
       * 不是靠这里兜住的 —— 真正的兜底是最后 verifyLinkReadable 之后
       * 对目标侧整树链接的抽查（那时源已经改名，坏链会露出来）。
       *
       * 只对源侧本来可读的链接做要求：源侧本来就悬空的，重建出来悬空是
       * 「保持现状」，不该判失败。 */
      if (srcReadable && !isLive(dstChild)) {
        throw new Error('重建后的链接打不开（源侧是可读的）：' + dstChild);
      }
      created.count++;
    } catch (err) {
      created.failed.push({ link: l, error: err.message });
    }
  }
  return {
    created: created.count, failed: created.failed, fileLinks: created.fileLinks,
    innerRewritten: created.innerRewritten, srcReadableLinks: created.srcReadableLinks,
  };
}

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
function linkTargetAbs(linkPath) {
  const raw = String(fs.readlinkSync(linkPath));
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(path.dirname(linkPath), raw);
}

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
function normalizeForComparePath(p) {
  let abs;
  try { abs = path.resolve(String(p || '')); } catch (e) { return String(p || ''); }
  try {
    return fs.realpathSync.native(abs);
  } catch (e) {
    /* 目标本身不存在时，至少把**父目录**解析掉：
     * C:\...\VERYLO~1\sub（sub 还不存在）也能归一到长名形态。
     * 这是重建链接时最常见的状态 —— 目标此刻可能还没被复制过去。 */
    try {
      const dir = path.dirname(abs);
      const base = path.basename(abs);
      return path.join(fs.realpathSync.native(dir), base);
    } catch (e2) { return abs; }
  }
}

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
function isInsideTree(absPath, rootAbs) {
  const rel = path.relative(normalizeForComparePath(rootAbs), normalizeForComparePath(absPath));
  if (!rel) return true;                                  // 就是源目录自身
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

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
async function collectLockProbe(dir) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (err) { return { files: [], error: '读取目录失败：' + err.message }; }
  const files = [];
  for (const ent of ents) {
    if (files.length >= 64) break;   // 只看前 64 个普通文件，够覆盖常见情形
    if (!ent.isFile()) continue;     // 目录/链接一律不注册（会让整批失败）
    files.push(path.join(dir, ent.name));
  }
  return { files, error: null };
}

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
function linkNature(p) {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() ? 'dir' : 'file';
  } catch (err) { return 'unknown'; }
}

/**
 * 批量判定链接性质。先走 statSync 这条零成本的路，剩下的（悬空/无权限）
 * 用**一次** Get-Item 批量取 Attributes —— 即使目标不存在，
 * reparse point 自身带的 FILE_ATTRIBUTE_DIRECTORY 仍能告诉我们它是目录链接。
 *
 * @param {string[]} list 链接绝对路径
 * @returns {Promise<Map<string,string>>} 小写路径 → 'dir' | 'file'
 */
async function linkNatures(list) {
  const out = new Map();
  const unknown = [];
  for (const l of list) {
    const n = linkNature(l);
    if (n === 'unknown') unknown.push(l);
    else out.set(l.toLowerCase(), n);
  }
  if (!unknown.length) return { natures: out, error: null };

  /* 【分批查 + 如实上报失败】
   * 早期这里把全部路径拼成一条命令、并用一个空 catch 吞掉所有异常：
   *   - 路径一多就 spawn ENAMETOOLONG（命令行超限），整趟查询根本没跑；
   *   - 失败与「个别链接查不到」被抹成同一个状态，调用方无从区分，
   *     而「查不到性质」会让重建直接拒绝 —— 于是源目录里链接一多，
   *     这个目录就永远搬不动，界面只说「无法判断这个链接指向目录还是文件」。
   * 现在按 PS_PATH_BATCH 分批，失败的批次记进 error 由调用方展示。 */
  const errors = [];
  for (let i = 0; i < unknown.length; i += PS_PATH_BATCH) {
    const chunk = unknown.slice(i, i + PS_PATH_BATCH);
    try {
      const q = (x) => "'" + String(x).replace(/'/g, "''") + "'";
      const arr = chunk.map(q).join(',');
      const r = await ps(
        /* 结尾的 exit 0：悬空链接会让 PowerShell 返回非零，而那是正常状态
         * （搬到别处的目录里本来就可能留着指向已消失目标的链接）。 */
        `Get-Item -LiteralPath @(${arr}) -Force -ErrorAction SilentlyContinue | ` +
        `ForEach-Object { @($_.FullName, ('' + $_.Attributes)) -join [char]9 }; exit 0`,
        Math.max(15000, chunk.length * 300));
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const seg = line.split('\t');
        if (seg.length < 2) continue;
        const attrs = seg.slice(1).join('\t').trim();
        /* 【Attributes 读不到时不能猜成 'file'】
         * 原实现是 `(/Directory/i.test(attrs) ? 'dir' : 'file')` —— 空串走 else，
         * 于是「读不到」被当成「它是文件」。
         * 实测差异（本机 vs GitHub windows-latest runner）：
         *   本机：悬空 junction 的 Attributes 含 Directory，判出 'dir'（正确）
         *   CI：  同一操作 Attributes 返回空串，被判成 'file'
         * 后果不是「显示不对」，而是**重建走错分支**：文件链接要用
         * fsp.symlink(absTarget, dstChild)（需要 SeCreateSymbolicLinkPrivilege），
         * 非管理员下必然 EPERM，整个搬家中止并回滚 —— 一台机器能不能搬成功，
         * 竟然取决于 PowerShell 能否读到那个 Attributes。
         * 判不出来就不该登记：让调用方显式看到「性质未知」，由
         * restoreLinksIntoTarget 的 unknown 分支拒绝重建并如实报错，
         * 而不是偷偷按文件处理。 */
        if (!attrs) continue;
        out.set(seg[0].trim().toLowerCase(), /Directory/i.test(attrs) ? 'dir' : 'file');
      }
    } catch (err) {
      errors.push(shortErr(err));
    }
  }
  return {
    natures: out,
    /* 部分批次失败时也带上：调用方要能说清「这不代表没有文件链接」 */
    error: errors.length ? (errors.length + ' 批链接性质查询失败：' + errors.slice(0, 2).join('；')) : null,
  };
}

/* ================= IPC: 目录搬家（建链接替身） =================
 * 高危能力（dir-move），默认关闭。流程见 lib/dir-move.js 顶部注释。
 * 每一步都通过 job:progress 回报，界面上逐步显示而不是一个转圈。
 */
handle('dir:move-precheck', async (e, { src, dst } = {}) => {
  if (!dirMove) throw new Error('内部错误：搬家模块未加载');
  const srcAbs = path.resolve(String(src || ''));
  const dstAbs = path.resolve(String(dst || ''));

  const sst = await fsp.stat(srcAbs).catch(() => null);
  const lst = links.linkStat(srcAbs);
  const srcExists = !!sst;
  const srcIsDir = !!sst && sst.isDirectory();
  const srcIsRoot = links.isVolumeRootOnly(srcAbs);
  /* 【这里用 isProtectedForModify 而不是 isCriticalPath】
   * isCriticalPath 把「关键目录的直接子目录」也算危险，而 criticalDirs()
   * 含用户家目录 —— 于是「把 Documents 搬到 D 盘」这种完全正常的操作
   * 会被 SRC_CRITICAL 拒掉。搬家的破坏面是「搬错地方」，不是「毁掉系统」，
   * 边界应当比删除更窄：系统目录/盘符根/别人的家目录/自己家目录本身才拦。
   * path-guard 内部做 realpath 归一，能挡住 junction 绕行。 */
  const protectedMod = pathGuard.isProtectedForModify(srcAbs);
  const srcIsCritical = protectedMod.protected;
  /* 【目标侧同样过闸门】源有保护判据，目标一直没有 ——
   * 在「新位置」里填 C:\Windows\moved 就能往系统目录里写整棵树。
   * 用同一份判据（isProtectedForModify），预检与执行两处都传。 */
  const dstProtectedMod = pathGuard.isProtectedForModify(dstAbs);
  const dstExists = await pathExists(dstAbs);

  /* 目标盘的剩余空间（同卷时没有意义，但校验里同卷会先被拒） */
  let freeBytes = null;
  try {
    if (typeof fs.statfsSync === 'function') {
      const sf = fs.statfsSync(path.parse(dstAbs).root || dstAbs);
      freeBytes = sf.bavail * sf.bsize;
    }
  } catch (err) { freeBytes = null; }

  /* 【一次遍历同时拿到「要复制多少字节」与「树里有几个链接」】
   * 早期这里是 links.dirSize(srcAbs) + collectLinks(srcAbs)：同一棵树走两遍
   * （目录项读两遍、文件各 stat 一遍）。大目录上光是预检就要等很久，
   * 而这两个数的遍历规则（不跟随链接）本来就完全一致。 */
  let needBytes = null;
  let treeLinks = [];
  if (srcExists && srcIsDir && !lst.isLink) {
    try {
      const walk = await collectLinks(srcAbs, { wantSize: true });
      needBytes = walk.bytes;
      treeLinks = walk.links;
    } catch (err) { needBytes = null; }
  }
  /* 其中有多少是「文件符号链接」：这类在目标侧必须重建为符号链接，
   * 而 Windows 创建符号链接需要特权 —— 提前告诉用户，
   * 免得搬家在这一步失败（失败会回退，但白等一次完整拷贝）。
   * 【性质查询失败要如实说】否则 fileLinkCount 恒 0，
   * 把一个「可能失败」的操作显示成「没有文件链接、应该没问题」。 */
  let fileLinkCount = 0;
  let linkNaturesError = null;
  try {
    const ln = await linkNatures(treeLinks);
    linkNaturesError = ln.error;
    for (const [, n] of ln.natures) if (n === 'file') fileLinkCount++;
  } catch (err) { linkNaturesError = err.message; }

  /* 有多少链接的目标落在源目录树内部 —— 这些会被**改写**成新位置的对应路径
   * （照抄旧路径的话，旧路径随 .bak 一起被删，重建出来的就是死链）。
   * 提前告诉用户，界面文案才和实际行为对得上。 */
  let innerLinkCount = 0;
  for (const l of treeLinks) {
    try { if (isInsideTree(linkTargetAbs(l), srcAbs)) innerLinkCount++; } catch (err) { /* 读不到的链接不计数 */ }
  }

  /* 占用检查：只看顶层**普通文件**，查得快且覆盖绝大多数情况。
   *
   * 【两个必须守住的点】
   * 1) 只注册普通文件。实测：Restart Manager 的注册列表里只要混进一个
   *    目录或 junction，RmGetList 就整批返回错误码 5（Access denied），
   *    整批失败 —— 不是「这一项没查到」，而是整个查询作废。
   *    而「目录搬家」搬过的目录里恰好就有一个 junction。
   *    同文件的 file:who-locks-dir 早已改成 ent.isFile() 过滤，这里对齐。
   * 2) 探测失败不许静默吞。早期写成 .catch(() => null) 再判空，
   *    查询失败和「没有占用」长得一模一样，于是 lockedPaths 恒为空、
   *    lib/dir-move.js 的 LOCKED 判定永远不触发 —— 预检成了摆设。
   *    现在把错误带进 lockCheckError，由调用方告知用户「查询失败」，
   *    并明确说「这不代表没有占用」。 */
  let lockedPaths = [];
  let lockCheckError = null;
  if (srcExists && srcIsDir && !lst.isLink) {
    const probe = await collectLockProbe(srcAbs);
    if (probe.error) {
      lockCheckError = probe.error;
    } else if (probe.files.length) {
      try {
        const lr = await rmQueryLockers(probe.files);
        if (lr && lr.lockers && lr.lockers.length) {
          /* 【lockedPaths 存的是「进程」而不是文件路径】
           * rmQueryLockers 返回的元素是 { pid, name, type }，
           * 根本没有 files 字段（早期这里写 x.files 永远走不到，
           * 于是 map 出来其实一直是 pid）。RM 是整批注册再取列表，
           * 进程与路径的对应关系拿不到，所以这里就按「进程」表达，
           * 文案也改成「N 个进程占用」，不再假装知道是哪些文件。 */
          lockedPaths = lr.lockers.map((x) => (x.pid || 0) + ':' + (x.name || x.procName || ''));
        }
      } catch (err) {
        lockCheckError = err.message;
      }
    }
  }

  const verdict = dirMove.validateMove({
    src: srcAbs, dst: dstAbs,
    srcExists, srcIsDir, srcIsLink: lst.isLink, srcIsRoot, srcIsCritical,
    /* 把「为什么受保护」的原因交给 validateMove 拼进 reason（与目标侧对齐） */
    srcProtectedReason: protectedMod.protected ? protectedMod.reason : '',
    srcProtectedKind: protectedMod.protected ? protectedMod.kind : '',
    dstExists, needBytes: needBytes || 0, freeBytes, lockedPaths,
    allowSameVolume: false,
    bakExists: await pathExists(tempNames.dirmoveBak(srcAbs)),
    bakPath: tempNames.dirmoveBak(srcAbs),
    dstProtected: dstProtectedMod.protected,
    dstProtectedReason: dstProtectedMod.protected ? dstProtectedMod.reason : '',
  });

  return Object.assign(verdict, {
    src: srcAbs, dst: dstAbs,
    srcExists, srcIsDir, srcIsLink: lst.isLink, srcIsRoot, srcIsCritical,
    /* 保护原因带上，界面能说清「为什么这块不能搬」（区分系统目录/家目录） */
    srcProtectedKind: protectedMod.protected ? protectedMod.kind : null,
    srcProtectedReason: protectedMod.protected ? protectedMod.reason : null,
    /* 目标侧的保护原因同理 */
    dstProtected: dstProtectedMod.protected,
    dstProtectedKind: dstProtectedMod.protected ? dstProtectedMod.kind : null,
    dstProtectedReason: dstProtectedMod.protected ? dstProtectedMod.reason : null,
    /* 占用查询本身失败时要让界面能看到（不能与「没有占用」混同） */
    lockCheckError,
    /* 源目录树里有多少链接 —— 搬家时这些会被原样重建，
     * 提前告诉用户，免得事后看到「多了一个链接」以为是 bug。
     * 用的是上面那次遍历的结果，不再走第二遍。 */
    linkCount: treeLinks.length,
    fileLinkCount,
    innerLinkCount,
    linkNaturesError,
    dstExists, needBytes, freeBytes, lockedPaths,
    plan: dirMove.movePlan(srcAbs, dstAbs),
  });
});

/* 【为什么需要一个模块级单飞标志】
 * 渲染层的 state.running 只在**当前页面实例**里有效：用户离开工具页再回来，
 * 会拿到全新的 state（running=false），于是能对同一对路径再发起一次搬家，
 * 与主进程里仍在跑的那次重叠 —— cp 与 rename 交叉，结果不可预测。
 * 所以互斥必须放在主进程。
 *
 * 不用 jobs map 的 cancel 机制：这条流程不支持中途取消（复制/改名/建链接
 * 做到一半被 cancel 会留下危险中间态），所以这里只拒绝、不取消。 */
let dirMoveBusy = false;

/* 实际执行搬家。**严格按 dir-move.js 的状态机走**，每一步失败都按
 * rollbackPlan 给的 actions 回退，不许临时发挥。
 *
 * 回报方式：通过 job:stream 逐条推送进度（界面上逐步显示，而不是转圈）。
 * 任何一步失败都会：① 执行回退 ② 把「数据现在在哪」如实告诉用户。 */
handle('dir:move', async (e, { src, dst, jobId: clientJob } = {}) => {
  if (dirMoveBusy) throw new Error('已有搬家任务在进行，请等待它完成后再试（或重启应用）。');
  dirMoveBusy = true;
  try {
    return await dirMoveRun({ src, dst, jobId: clientJob });
  } finally {
    /* 必须无条件复位：失败、成功、抛异常都要能再次搬家 */
    dirMoveBusy = false;
  }
});

/* 搬家的实际流程。拆成独立函数，让上面的单飞包装保持简洁：
 * 置位/复位与业务逻辑分开，避免以后有人在流程里 return 时忘了复位。 */
async function dirMoveRun({ src, dst, jobId: clientJob } = {}) {
  const id = clientJob || ('dirmv' + (++jobSeq));
  const srcAbs = path.resolve(String(src || ''));
  const dstAbs = path.resolve(String(dst || ''));

  const emit = (stage, extra) => {
    try { send('job:stream', { id, data: JSON.stringify(Object.assign({ stage }, extra || {})) }); } catch (err) {}
  };

  /* 源侧可读的链接清单（复制阶段填，第 5 步用来抽查目标侧）。
   * 提到函数作用域是因为它跨越「复制」和「验证链接」两个阶段。 */
  let innerLinkCheckList = [];

  /* 【目标目录的所有权标记】
   * 只有当我们确认「目标原本不存在，是我们复制出来的」之后，才允许在失败时
   * 回滚删除它。没有这个标记，任何在「目标已存在」处抛出的错误都会被
   * catch 里的回滚当成「删掉半成品」，把用户原有目录递归删光。
   * 两个阶段（复制 / 校验 / 改名）的失败回滚都必须过这一层。 */
  let dstOwned = false;
  const rollbackDst = async () => {
    if (!dstOwned) return;      // 不是我们建的，绝不删
    dstOwned = false;
    try { await fsp.rm(dstAbs, { recursive: true, force: true }); } catch (e2) {}
  };

  // 前置校验必须在主进程重做一遍：渲染层的历史结论不能当授权依据。
  // 直接复用 dirMove.validateMove（不通过 IPC 回调另一个 handler，
  // 那样会依赖 ipcMain 的内部结构，也没必要）。
  {
    const sst = await fsp.stat(srcAbs).catch(() => null);
    const lst = links.linkStat(srcAbs);
    const dstExists = await pathExists(dstAbs);
    let freeBytes = null;
    try {
      if (typeof fs.statfsSync === 'function') {
        const sf = fs.statfsSync(path.parse(dstAbs).root || dstAbs);
        freeBytes = sf.bavail * sf.bsize;
      }
    } catch (err) {}
    let needBytes = 0;
    if (sst && sst.isDirectory() && !lst.isLink) {
      try { needBytes = (await links.dirSize(srcAbs)).bytes; } catch (err) {}
    }
    /* 【执行阶段也要真的查一次占用，不能恒传空数组】
     * 早期这里写死 lockedPaths: []，等于预检的占用结论和执行现实完全脱节：
     * 预检说「可以搬」，执行时 fsp.cp 撞到被占用文件才失败，白拷一遍再删掉。
     * 但**不能**改成「必须无占用才允许执行」—— 占用可能在这几秒内消失，
     * 那样会把本来能成功的搬家拒掉。所以这里只做「再核一次」：
     * 有占用就带着 lockedPaths 进 validateMove，由它按原有规则给出 LOCKED 结论
     * （提示先关闭占用它的程序），行为和预检一致，用户不会看到两套说法。 */
    let lockedPaths = [];
    if (sst && sst.isDirectory() && !lst.isLink) {
      const probe = await collectLockProbe(srcAbs);
      if (!probe.error && probe.files.length) {
        try {
          const lr = await rmQueryLockers(probe.files);
          if (lr && lr.lockers && lr.lockers.length) {
            lockedPaths = lr.lockers.map((x) => (x.pid || 0) + ':' + (x.name || x.procName || ''));
          }
        } catch (err) {
          /* 执行阶段查询失败不阻断搬家：占用本来就可能在几秒内消失，
           * 这里再查只是「再核一次」。失败就当作没查到，但仍要如实记下来，
           * 由下面 emit 出去，别让用户以为「已确认无占用」。 */
          emit('check', { ok: true, lockCheckError: err.message });
        }
      }
    }
    const v = dirMove.validateMove({
      src: srcAbs, dst: dstAbs,
      srcExists: !!sst, srcIsDir: !!sst && sst.isDirectory(),
      srcIsLink: lst.isLink, srcIsRoot: links.isVolumeRootOnly(srcAbs),
      /* 与预检用同一判据（isProtectedForModify），保证两阶段说法一致。
       * 原因也要带上：SRC_CRITICAL 的笼统文案对用户没有指导意义。 */
      srcIsCritical: pathGuard.isProtectedForModify(srcAbs).protected,
      srcProtectedReason: pathGuard.isProtectedForModify(srcAbs).reason || '',
      srcProtectedKind: pathGuard.isProtectedForModify(srcAbs).kind || '',
      dstExists, needBytes, freeBytes, lockedPaths,
      allowSameVolume: false,
      bakExists: await pathExists(tempNames.dirmoveBak(srcAbs)),
      bakPath: tempNames.dirmoveBak(srcAbs),
      /* 目标闸门在执行阶段**必须重算**：渲染层的历史结论不能当授权依据 */
      dstProtected: pathGuard.isProtectedForModify(dstAbs).protected,
      dstProtectedReason: pathGuard.isProtectedForModify(dstAbs).reason || '',
    });
    if (!v.ok) {
      emit('check', { ok: false, error: v.reason });
      throw new Error(v.reason);
    }
  }

  const bakPath = tempNames.dirmoveBak(srcAbs);
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
  const ctx = { srcPath: srcAbs, dstPath: dstAbs, bakPath, linkPath: srcAbs };
  emit('check', { ok: true });

  /* 【cpStats 必须在两个 try 之外声明】
  * 它在「1) 复制」的 try 里被赋值，却要在「2) 校验」的 try 里读取
  * （合并两阶段的"消失"计数）。写在第一个 try 内的话，第二个 try
  * 根本访问不到它 —— 正是 js/app.js 里 finally 读 try 内 let 那类
  * 块级作用域错误（那里每次必抛 ReferenceError）。这里提前声明。 */
  let cpStats = null;

  /* ---------- 1) 复制到目标 ---------- */
  try {
    emit('copy', { ok: null, started: true });
    /* 【不要先 mkdir，也不要用 errorOnExist】
     * 实测（本机 Node 24 / Windows）：fsp.cp 的目标**已存在**且
     * errorOnExist:true 时，不是抛异常，而是让 Node 进程直接崩溃
     * （退出码 127，无任何 JS 栈）。先 mkdir 再 cp 正好制造这个组合。
     *
     * 所以：目标存在性由我们自己先判（上面的 validateMove 已经查过 dstExists，
     * 这里再兜一次，防并发），cp 只负责「往不存在的路径写」。
     * 去掉 errorOnExist 后，目标若意外存在会被 cp 合并写入 ——
     * 但那已经被前置的 EEXIST 检查挡住了，不会走到这里。 */
    /* 【这道防覆盖检查必须在「标记已创建」之前，且不能进回滚范围】
     * 原来它就写在这个 try 的第一行：预检通过后、执行前若目标路径上冒出了
     * 东西（用户在预检后自己建了 D:\backup\photos，或两个请求抢同一个 dst），
     * 这里抛异常 → 立刻被同一 try 的 catch 接住 → catch 第一件事是
     *   fsp.rm(dstAbs, { recursive: true, force: true })
     * 于是「为避免覆盖已拒绝」变成了「把那个已存在的目录整个删掉」，
     * 用户目标侧的数据当场消失，报错还写着「源目录未受影响」。
     * 现在用 dstOwned 记录「这个目标是我们自己建的」，只有它为 true 才回滚删除。 */
    if (await pathExists(dstAbs)) {
      throw new Error('目标位置已存在，为避免覆盖已拒绝：' + dstAbs);
    }
    dstOwned = true;   // 从这里往下，dstAbs 才可能是我们创建的

    /* 【必须先找出源目录树里的链接，复制时把它们排除掉】
     * fs.cp 对 reparse point 默认按符号链接处理，要调用 symlink() 重建，
     * 而 Windows 创建**符号链接**需要 SeCreateSymbolicLinkPrivilege。
     * 实测（非管理员）：源目录含一个 junction 时 fsp.cp 直接抛
     *   EPERM: operation not permitted, symlink ...
     * 加 verbatimSymlinks: true 同样 EPERM；只有 dereference: true 能过，
     * 但那会把链接目标的内容整个复制进来 —— 语义错误（多出副本，
     * 目标在别的盘时还会失败）。
     *
     * 所以分两步：先把「除链接之外」的内容复制过去（链接一概不参与），
     * 再按相对路径在目标侧用 fs.symlinkSync(target, dest, 'junction') 重建
     * —— junction 类型不需要那个特权。
     */
    const treeLinks = await collectLinks(srcAbs);
    cpStats = await copyTreeExcludingLinks(srcAbs, dstAbs, treeLinks.links);
    /* 链接不在 cp 的范围里了，所以 cp 不会再碰 symlink()，EPERM 消失。
     * 重建前先判定每个链接指向目录还是文件 —— 目录用 junction（免特权），
     * 文件用符号链接（用 junction 会造出打不开的坏链接且不报错）。 */
    const ln = await linkNatures(treeLinks.links);
    /* 性质查询失败不阻断搬家（受限的都是「重建时会不会被判成性质不明」），
     * 但必须报出来：否则用户只会看到「无法判断这个链接指向目录还是文件」。 */
    if (ln.error) emit('check', { ok: true, linkNaturesError: ln.error });
    const linkRestore = await restoreLinksIntoTarget(srcAbs, dstAbs, treeLinks.links, ln.natures);
    /* 留给第 5 步：源改名之后要按这份清单抽查目标侧的链接 */
    innerLinkCheckList = linkRestore.srcReadableLinks || [];
    /* 【重建失败必须报出来，不能静默】
     * 若某个链接没建起来，目标侧就少一个条目，而源侧还有 ——
     * 这会让「校验」步骤觉得文件对不上，也可能让用户以为搬家成功但
     * 实际少了东西。所以这里直接失败并回退，而不是记一笔继续走。 */
    if (linkRestore.failed && linkRestore.failed.length) {
      const first = linkRestore.failed[0];
      throw new Error('目标侧重建链接失败（' + linkRestore.failed.length + ' 个）：' +
        path.basename(first.link) + ' —— ' + first.error);
    }
    emit('copy', { ok: true, links: treeLinks.links.length, fileLinks: linkRestore.fileLinks,
      innerRewritten: linkRestore.innerRewritten,
      files: cpStats.files, dirs: cpStats.dirs,
      /* 【跳过的条目数必须如实报出去】
       * 静默跳过等于让用户拿到一份悄悄变少了的副本，而且事后对不上数
       * （源侧还在、目标侧少了）会让人以为是搬家本身坏了。
       * 只说个数和一个样例，不把几十条路径全塞进提示。
       * 文件与目录分开给：一个目录被删掉时，说成「N 个文件消失」是错的。 */
      skippedDisappeared: cpStats.skippedDisappeared,
      skippedFiles: cpStats.skippedFiles, skippedDirs: cpStats.skippedDirs,
      skippedExamples: cpStats.disappeared });
  } catch (err) {
    // 源完好，只需要删掉拷了一半的目标（且只在目标确实是本进程创建时才删）
    await rollbackDst();
    emit('copy', { ok: false, error: err.message });
    throw new Error('复制失败（源目录未受影响）：' + err.message);
  }

  /* ---------- 2) 逐文件校验：大小 + 抽样哈希 ----------
   * 【为什么不能只比字节数】复制工具/文件系统可能截断或粘贴出等长的坏块，
   * 大小相同但内容不同是真实存在的（尤其跨盘 + 压缩/加密卷）。
   * 全量哈希对大目录太慢，所以：**每个文件都比大小**，
   * 再对其中若干文件（按大小排序取头尾 + 随机）做 SHA-256 抽样。 */
  try {
    emit('verify', { ok: null, started: true });
    const vr = await verifyCopy(srcAbs, dstAbs);
    if (!vr.ok) throw new Error(vr.reason);
    /* 【复制阶段与校验阶段「消失」的数字必须合并显示，不能出现两套】
     * 两个阶段都可能遇到源条目被删：复制时 catcher 记一份、校验时又记一份。
     * 如果各报各的，用户会看到「跳过 2 个」然后「跳过 3 个」，不知道哪个算数。
     * 这里把校验阶段的增量加上去，一次性报总数（UI 只认这一处）。
     * 注意 cpStats 与 vr 统计的都是**不同**条目（校验阶段多出来的是
     * "复制完之后才被删"的那批），相加不会重复计数。 */
    const goneFiles = ((cpStats && cpStats.skippedFiles) || 0) + (vr.skippedFiles || 0);
    const goneDirs = ((cpStats && cpStats.skippedDirs) || 0) + (vr.skippedDirs || 0);
    emit('verify', {
      ok: true, files: vr.files, hashed: vr.hashed, bytes: vr.bytes,
      skippedFiles: goneFiles, skippedDirs: goneDirs,
      skippedDisappeared: goneFiles + goneDirs,
      skippedExamples: ((cpStats && cpStats.disappeared) || []).concat(vr.skippedList || []).slice(0, 20),
    });
  } catch (err) {
    await rollbackDst();
    emit('verify', { ok: false, error: err.message });
    throw new Error('校验失败（已删除目标副本，源目录未受影响）：' + err.message);
  }

  /* ---------- 3) 源改名为 .bak ---------- */
  try {
    emit('rename', { ok: null, started: true });
    await fsp.rename(srcAbs, bakPath);
    emit('rename', { ok: true });
  } catch (err) {
    await rollbackDst();
    emit('rename', { ok: false, error: err.message });
    throw new Error('源目录改名失败（已删除目标副本，源目录未变）：' + err.message);
  }

  /* ---------- 4) 在原位置建目录联接 ----------
   * 从这一刻起进入「危险中间态」：原路径是空的。任何失败都必须
   * 先把 .bak 改回原名。 */
  try {
    emit('link', { ok: null, started: true });
    /* 【不用 cmd /c mklink】那条命令要把路径拼进 PowerShell 字符串，
     * 双引号内的 $ 会被当变量/子表达式展开、反引号会被当转义符 ——
     * 而 Windows 允许目录名含这两个字符。一个叫 $(...) 的目录会被执行，
     * 既是功能失效也是注入风险。
     * 这里直接用 Node 原生 API，路径作为**参数**传递，不经过任何 shell 解析。
     * 注意参数顺序是 (target, path)：symlink 先给目标，再给链接自身位置。
     * junction 类型不需要管理员权限。 */
    await fsp.symlink(dstAbs, srcAbs, 'junction');
    // 建完再确认一次：API 返回成功但链接没出现的情况也要当失败处理
    if (!(await pathExists(srcAbs))) throw new Error('创建目录联接后路径仍不存在：' + srcAbs);
    emit('link', { ok: true });
  } catch (err) {
    // 关键回退：先保证原路径能打开东西
    const back = await restoreBak(bakPath, srcAbs);
    emit('link', { ok: false, error: err.message, restored: back.ok });
    throw new Error(
      '建链接失败' + (back.ok
        ? '（已把源目录改回原名，原路径可正常打开，数据未丢）'
        : '（且回退失败：原始数据完整保存在 ' + bakPath + '，请手动把它改名为 ' + srcAbs + '）') +
      '：' + err.message);
  }

  /* ---------- 5) 验证链接真的可读 ----------
   * 建了链接不代表链接是好的：要真的读一遍其中的文件。
   *
   * 【这里才是「树内部的链接」真正的兜底】
   * 到这一步源目录已经改名成 .hehe-bak，所以任何「照抄旧绝对路径」
   * 重建出来的链接此刻都是死的 —— 而 verifyLinkReadable 只看顶层那个链接，
   * 树内部的坏链它一个都看不到（那正是问题 1 能一路「搬家完成」的原因）。
   * 所以再抽验一遍**目标树里的链接**：源侧可读的，搬到目标侧后也必须可读。
   * 这一步排在源改名之后，才具有判据意义。 */
  try {
    emit('linkcheck', { ok: null, started: true });
    const r = await verifyLinkReadable(srcAbs, dstAbs);
    if (!r.ok) throw new Error(r.reason);
    const inner = await verifyInnerLinksReadable(dstAbs, srcAbs, innerLinkCheckList);
    if (!inner.ok) throw new Error(inner.reason);
    emit('linkcheck', { ok: true, sampled: r.sampled, innerSampled: inner.sampled });
  } catch (err) {
    /* 回退：先拆链接（必须用「只删链接」的安全入口），再把 .bak 改回原名 */
    let linkRemoved = false;
    try { await links.removeLinkOnly(srcAbs); linkRemoved = true; } catch (e2) {}
    const back = await restoreBak(bakPath, srcAbs);
    emit('linkcheck', { ok: false, error: err.message, linkRemoved, restored: back.ok });
    throw new Error(
      '链接验证未通过' + (back.ok
        ? '（已拆除链接并把源目录改回原名，原路径可正常打开）'
        : '（且回退失败：数据完整保存在 ' + bakPath + '，请手动改名为 ' + srcAbs + '）') +
      '：' + err.message);
  }

  /* ---------- 6) 最后才删 .bak ---------- */
  let dropped = false;
  try {
    emit('dropbak', { ok: null, started: true });
    await fsp.rm(bakPath, { recursive: true, force: true });
    dropped = true;
    emit('dropbak', { ok: true });
  } catch (err) {
    // 删不掉备份不影响可用性，只是多占空间，如实提示即可
    emit('dropbak', { ok: false, error: err.message });
  }

  emit('done', { ok: true });
  return {
    ok: true, src: srcAbs, dst: dstAbs, bakRemoved: dropped,
    advice: '搬家完成：原路径现在是指向新位置的目录联接，打开它看到的就是新位置的内容。' +
      (dropped ? '备份已清理。' : '（备份 .bak 未能删除，可在确认无误后手动删除）'),
  };
}

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
let _isAdminCache = null;
async function isRunningAsAdmin() {
  if (_isAdminCache != null) return _isAdminCache;
  try {
    const r = await ps(`$id=[Security.Principal.WindowsIdentity]::GetCurrent();` +
      `$p=New-Object Security.Principal.WindowsPrincipal($id);` +
      `if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){'1'}else{'0'}`, 15000);
    const v = String(r.stdout || '').trim();
    if (v === '1' || v === '0') { _isAdminCache = (v === '1'); return _isAdminCache; }
    return null;   // 输出不是预期的 0/1：当作未知，不缓存
  } catch (err) { return null; }
}

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
async function readAclFacts(target) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const out = { owner: null, ownerIsMe: null, acl: null, aclRaw: null, me: null };

  /* 第一步：当前用户名。取不到就留 null —— parseIcacls 在 userName 缺失时
   * 不猜测归属（entry.mine 全部为 false，hasFull 保持 false），
   * 而 diagnose 会把「找不到我那条 ACE」当作「无法确定」处理，不会误判为正常。 */
  try {
    const r = await ps(`[Security.Principal.WindowsIdentity]::GetCurrent().Name`, 10000);
    const me = String(r.stdout || '').trim();
    if (me) out.me = me;
  } catch (err) { out.me = null; }

  try {
    const r = await ps(`(Get-Acl -LiteralPath ${q(target)}).Owner`, 15000);
    const owner = String(r.stdout || '').trim();
    if (owner) out.owner = owner;
  } catch (err) { /* 取不到就留 null */ }

  try {
    const r = await ps(`icacls ${q(target)}`, 15000);
    out.aclRaw = String(r.stdout || '');
    /* 把 me 传进去：这是 hasFull / deniedForMe 能正确工作的前提。
     * path 也一并传：icacls 的第一行是「路径 + 空格 + 主体」，
     * 而我们**本来就知道**查的是哪个路径 —— 拿它剥前缀，路径里的空格
     * 就不再是解析难点（靠空白猜边界在路径含空格时必错）。 */
    out.acl = aclRepair.parseIcacls(out.aclRaw, out.me || undefined, { path: target });
  } catch (err) { out.acl = null; }

  /* 所有者是不是当前用户。
   * 【用 principalEq，不要自己写后缀匹配】
   * 早期这里是
   *   a === b || a.endsWith('\\' + b.split('\\').pop())
   * 仍是「后缀包含」的老写法：DOMAIN\\admin 会命中
   * BUILTIN\\Administrators 的尾巴，判成「所有者是你」。
   * 而 parseIcacls 里判 mine 用的是另一套写法 —— 两处各写一套，
   * 一旦其中一处改错，诊断结论会自相矛盾。
   * 现在统一收到 lib/acl-repair.js 的 principalEq（同一份判据）。 */
  if (out.me && out.owner) {
    out.ownerIsMe = aclRepair.principalEq(out.owner, out.me);
  }
  return out;
}

handle('acl:diagnose', async (e, target) => {
  const p = String(target || '');
  if (!p) throw new Error('没有指定路径');
  const exists = await pathExists(p);
  let isDir = false, childCount = -1;
  if (exists) {
    const st = await fsp.stat(p).catch(() => null);
    isDir = !!st && st.isDirectory();
    if (isDir) {
      try { childCount = (await fsp.readdir(p)).length; } catch (err) { childCount = -1; }
    }
  }

  const facts = exists ? await readAclFacts(p) : { owner: null, ownerIsMe: null, acl: null };
  const isAdmin = await isRunningAsAdmin();

  /* 占用检查：和权限问题长得一样，但修复方式完全不同，必须区分。
   * 【查询失败不能静默吞】早期是 .catch(() => null) 再判空 ——
   * 查询失败与「确实没有占用」在这里长得一模一样，于是诊断会漏掉
   * 「其实是占用问题」这一整类原因，还让用户以为已经排查过了。
   * 现在把错误单独带出去（lockCheckError），界面上如实说明。 */
  let lockedPaths = [];
  let lockCheckError = null;
  if (exists && !isDir) {
    try {
      const lr = await rmQueryLockers([p]);
      if (lr && lr.lockers && lr.lockers.length) {
        lockedPaths = lr.lockers.map((x) => x.pid + ':' + (x.name || ''));
      }
    } catch (err) {
      lockCheckError = err.message;
    }
  }

  const diag = aclRepair.diagnose({
    exists, isDir, childCount,
    ownerIsMe: facts.ownerIsMe, ownerName: facts.owner,
    acl: facts.acl, isAdmin, lockedPaths,
  });

  return Object.assign({
    path: p, isAdmin,
    /* 占用查询失败要能被界面看到（不能与「没有占用」混同） */
    lockCheckError,
    owner: facts.owner, me: facts.me || null, ownerIsMe: facts.ownerIsMe,
    aclEntries: (facts.acl && facts.acl.entries || []).slice(0, 20),
    hasFull: !!(facts.acl && facts.acl.hasFull),
    hasDeny: !!(facts.acl && facts.acl.hasDeny),
  }, diag);
});

handle('acl:repair', async (e, opts = {}) => {
  const target = String(opts.target || '');
  if (!target) throw new Error('没有指定路径');
  if (!(await pathExists(target))) throw new Error('路径不存在：' + target);

  /* 第一道闸：不该改权限的地方一律拒绝。
   * 【为什么不用 isCriticalPath】它把「关键目录的直接子目录」也算危险，
   * 而 criticalDirs() 含用户家目录 —— 于是 C:\Users\<你>\Documents 被拒，
   * 提示语还是「改错会导致系统更新失败或被安全软件拦截」，对这个目标
   * 完全是误导（用户就是想修自己 Documents 里某个文件）。
   * isProtectedForModify 只拦系统目录、盘符根、别人的家目录、以及
   * 自己家目录本身，并给出**分情形**的说明。 */
  const protectedMod = pathGuard.isProtectedForModify(target);
  if (protectedMod.protected) {
    let msg;
    if (protectedMod.kind === 'SYSTEM') {
      msg = '拒绝：' + protectedMod.reason + '。' +
        '即便有管理员权限也不该让工具去改系统目录的 ACL —— ' +
        '改错会导致系统更新失败或被安全软件拦截，而且没有恢复路径。';
    } else if (protectedMod.kind === 'OWN_HOME') {
      msg = '拒绝：' + protectedMod.reason + '。' +
        '如果你想修某个删不掉的文件，请直接选中那个文件或它所在的子文件夹。';
    } else if (protectedMod.kind === 'OTHER_HOME') {
      msg = '拒绝：' + protectedMod.reason + '。' +
        '需要访问别的用户的数据时，请用那个账号登录后操作。';
    } else {
      msg = '拒绝：' + protectedMod.reason + '。';
    }
    throw new Error(msg);
  }

  /* 第二道闸：递归必须由调用方**显式**要求，且是目录 */
  const st = await fsp.stat(target).catch(() => null);
  const isDir = !!st && st.isDirectory();
  const recursive = !!opts.recursive && isDir;

  const admin = await isRunningAsAdmin();
  /* admin 是三态：true / false / null（查询失败，见 isRunningAsAdmin 注释）。
   * 只有确定**不是**管理员时才说「请以管理员身份运行」——那是可执行的建议；
   * 查询失败时说这句等于让用户去重装/重开一遍也没用，得如实说「没查出来」。 */
  if (admin === false) {
    throw new Error('修复权限需要管理员权限。请右键「以管理员身份运行」核核工具箱后重试。' +
      '（改所有者 takeown 这一步普通权限做不了）');
  }
  if (admin === null) {
    throw new Error('无法确认当前是否以管理员身份运行（权限查询失败），已拒绝执行以免白跑一趟。' +
      '请确认核核工具箱是「以管理员身份运行」后重试；若反复失败，可能是 PowerShell 被安全策略限制。');
  }

  const me = (await ps(`[Security.Principal.WindowsIdentity]::GetCurrent().Name`, 10000)
    .then((r) => String(r.stdout || '').trim())
    .catch(() => '')) || '';
  if (!me) throw new Error('无法取得当前用户名，已放弃修复');

  const plan = aclRepair.buildRepairCommands({ path: target, isDir, recursive, user: me });
  const log = [];
  for (const step of plan.steps) {
    try {
      const r = await runCmd(step.tool, step.args, { timeout: 60000 });
      const text = (String(r.stdout || '') + String(r.stderr || '')).trim();
      if (r.code !== 0) {
        log.push({ tool: step.tool, ok: false, text: text.slice(-500) });
        throw new Error(step.tool + ' 执行失败：' + (text.split(/\r?\n/).filter(Boolean).slice(-1)[0] || ('退出码 ' + r.code)));
      }
      log.push({ tool: step.tool, ok: true, text: text.slice(-300) });
    } catch (err) {
      return { ok: false, steps: log, user: me,
        advice: '修复中止。' + (err.code === 'ENOENT' ? '系统里找不到 ' + step.tool + ' 命令。' : err.message) };
    }
  }

  /* 复核：修完再读一遍 ACL，确认真的拿到了完全控制 */
  const after = await readAclFacts(target).catch(() => null);
  const gained = !!after && !!after.ownerIsMe && !!(after.acl && after.acl.hasFull);
  return {
    ok: true, steps: log, user: me, recursive,
    gained,
    owner: after && after.owner, ownerIsMe: after && after.ownerIsMe,
    advice: gained
      ? '已取得所有权并授予完全控制。现在可以重新尝试删除或修改这个路径。'
      : '命令已执行完毕，但复核时没有读到完全控制权限 —— 可能被组策略或安全软件拦截了。' +
        '请用当前权限再试操作，或查看下方命令输出。',
  };
});


/* 把 .bak 改回原名；成功与否都要如实回报。 */
async function restoreBak(bakPath, srcPath) {
  try {
    if (!(await pathExists(bakPath))) return { ok: false, reason: '备份目录不存在' };
    if (await pathExists(srcPath)) return { ok: false, reason: '原路径已被占用，无法改名回去' };
    await fsp.rename(bakPath, srcPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/* 逐文件校验：每个文件比大小；再抽样若干做 SHA-256。 */
async function verifyCopy(srcDir, dstDir) {
  const stack = [[path.resolve(srcDir), path.resolve(dstDir)]];
  let files = 0, bytes = 0, hashed = 0;
  const toHash = [];
  const SIZE_LIMIT = 512 * 1024 * 1024;   // 单个文件超过 512MB 不做全量哈希（太慢）
  const HASH_BUDGET = 12;                 // 最多抽样 12 个不同大小的文件

  /* 【源侧条目在复制与校验之间消失，必须与我刚加的容忍策略一致】
   * copyTreeExcludingLinks 已经允许「readdir 之后文件被删」并记进
   * skippedFiles/skippedDirs，注释写着「源目录往往是活的」。但这一步
   * verifyCopy 会重新遍历**源树**：同一个场景立刻抛「读取源文件失败」，
   * dirMoveRun 的 catch 接着回滚并报「校验失败 … 读取源文件失败：…」。
   * 于是用户先看到「跳过 N 个」，再看到「读取源文件失败」—— 两句自相矛盾，
   * 而且整个搬家白做。这里必须按同一口径处理：
   *   · 源侧 stat 失败、但**目标侧存在** → 视为「源侧已消失」，计数跳过；
   *   · 源侧在、目标侧缺 → 才是真正的校验失败（副本不完整）。
   * 目录同理：源子目录整个没了，跳过它那棵子树，不当失败。 */
  const skipped = { files: 0, dirs: 0, list: [] };
  const noteGone = (rel, kind) => {
    if (kind === 'dir') skipped.dirs++; else skipped.files++;
    if (skipped.list.length < 20) skipped.list.push(rel);
  };

  while (stack.length) {
    const [s, d] = stack.pop();
    let ents;
    try { ents = await fsp.readdir(s, { withFileTypes: true }); }
    catch (err) {
      /* 源子目录在遍历过程中被删掉了：按「已消失」处理，继续校验其它部分。
       * ENOENT 才算消失；权限/IO 错误仍然要抛（那是环境问题，不是数据消失）。 */
      if (err && err.code === 'ENOENT') {
        noteGone(path.relative(path.resolve(srcDir), s), 'dir');
        continue;
      }
      throw new Error('读取源目录失败：' + s + '（' + err.message + '）');
    }
    for (const ent of ents) {
      const sp = path.join(s, ent.name);
      const dp = path.join(d, ent.name);
      if (ent.isSymbolicLink()) continue;   // 不跟随链接（目标内容不在这次复制里）
      if (ent.isDirectory()) { stack.push([sp, dp]); continue; }
      if (!ent.isFile()) continue;

      const stDst = await fsp.stat(dp).catch(() => null);
      const sst = await fsp.stat(sp).catch(() => null);
      if (!sst) {
        /* 源文件没了。判定口径：
         *   目标侧有 → 复制阶段确实拷过它、之后源被删 → 记「已消失」，通过；
         *   目标侧也没有 → 它从来没被成功复制，让后面的检查照常报失败。 */
        if (stDst) { noteGone(path.relative(path.resolve(srcDir), sp), 'file'); continue; }
        throw new Error('读取源文件失败：' + sp);
      }
      if (!stDst) throw new Error('目标缺少文件：' + dp);
      if (sst.size !== stDst.size) {
        throw new Error('大小不一致：' + path.basename(sp) + '（源 ' + sst.size + ' / 目标 ' + stDst.size + '）');
      }
      files++; bytes += sst.size;
      /* 抽样哈希前再 stat 一次会更准，但这里有竞态：源可能正好在此时被删。
       * hashFile 失败会被下面的 catch 归到「已消失」，不误判成内容不一致。 */
      if (sst.size > 0 && sst.size <= SIZE_LIMIT) toHash.push({ sp, dp, size: sst.size });
    }
  }

  /* 抽样策略：按大小排序后取「最大几个 + 中间均匀取样」，
   * 这样既能覆盖大文件（最容易复制出问题），也覆盖中小文件。 */
  toHash.sort((a, b) => b.size - a.size);
  const pick = [];
  const seenSize = new Set();
  for (const it of toHash) {
    if (pick.length >= HASH_BUDGET) break;
    // 尽量从不同大小里取，避免 12 个都是同尺寸的日志文件
    const bucket = Math.floor(Math.log2(it.size + 1));
    if (seenSize.has(bucket) && pick.length >= 4) continue;
    seenSize.add(bucket);
    pick.push(it);
  }
  for (const it of pick) {
    let a, b;
    try { a = await hashFile(it.sp); }
    catch (e) {
      if (e && e.code === 'ENOENT') { noteGone(path.relative(path.resolve(srcDir), it.sp), 'file'); continue; }
      throw e;
    }
    b = await hashFile(it.dp);
    if (a !== b) throw new Error('内容校验失败（哈希不一致）：' + path.basename(it.sp));
    hashed++;
  }
  return {
    ok: true, files, hashed, bytes,
    skippedFiles: skipped.files, skippedDirs: skipped.dirs,
    skippedDisappeared: skipped.files + skipped.dirs, skippedList: skipped.list,
  };
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(p);
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => resolve(h.digest('hex')));
    rs.on('error', reject);
  });
}

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
async function verifyInnerLinksReadable(dstRoot, srcAbs, srcReadableLinks) {
  const list = Array.isArray(srcReadableLinks) ? srcReadableLinks : [];
  if (!list.length) return { ok: true, reason: '', sampled: 0, checked: 0 };

  /* 【判据用 stat，不用 access / readdir】见 restoreLinksIntoTarget 里的实测：
   * 悬空链接的 access 是成功的（条目本身可访问），readdir 对文件链接无效。
   * stat 跟随链接、目标不在就 ENOENT —— 这才是「能不能读到东西」。 */
  const canRead = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };
  for (const l of list) {
    const dstChild = path.join(dstRoot, ...relKey(srcAbs, l).split('/'));
    if (!canRead(dstChild)) {
      let tgt = '未知目标';
      try { tgt = fs.readlinkSync(dstChild); } catch (e) { /* 读不到就保持「未知目标」 */ }
      return {
        ok: false,
        reason: '目标树里的链接打不开：' + dstChild + '（它指向 ' + tgt + '）',
        sampled: 0, checked: list.length,
      };
    }
  }
  return { ok: true, reason: '', sampled: list.length, checked: list.length };
}

async function verifyLinkReadable(linkPath, expectTarget) {
  const st = await fsp.lstat(linkPath).catch(() => null);
  if (!st || !st.isSymbolicLink()) return { ok: false, reason: '原路径不是链接' };
  let real;
  try { real = fs.realpathSync.native(linkPath); } catch (err) { return { ok: false, reason: '链接无法解析：' + err.message }; }
  /* 【两侧都要 realpath 归一，不能只对一侧做字符串比较】
   * realpathSync 返回的是**规范长名**，而 expectTarget 可能是调用方
   * 从别处拿到的 8.3 短名（Agent 机 / CI 的 runneradmin 上尤其常见：
   * Temp 下会生成 SHORT~1 这种短目录名）。直接比字符串就会把
   * 「指向完全正确」的链接判成「指向非预期位置」——
   * 而这条判据位于「源已改名、链接已建」之后，误判会触发回滚，
   * 让一次本已成功的搬家白折腾一遍。
   * 两侧各自 realpath 后再比；某一侧解析不了（比如目标已被删）时，
   * 退回到字面比较，保持「真僵尸链接仍能被判失败」这个能力。 */
  const canon = (s) => {
    const abs = path.resolve(String(s || ''));
    try { return fs.realpathSync.native(abs).toLowerCase(); }
    catch (e) { return abs.toLowerCase(); }
  };
  if (canon(real) !== canon(expectTarget)) {
    return { ok: false, reason: '链接指向了非预期位置：' + real };
  }
  // 真的读几个文件
  let sampled = 0;
  try {
    const ents = await fsp.readdir(linkPath, { withFileTypes: true });
    for (const ent of ents) {
      if (sampled >= 3) break;
      if (!ent.isFile()) continue;
      const full = path.join(linkPath, ent.name);
      /* 【只读前 4KB，不要整份读进内存】
       * 判据是「通过链接能不能真的读到字节」，不需要读完整个文件。
       * 早期这里用 fsp.readFile(full)，等于把每个抽样文件整个塞进内存：
       * 目录里有 VM 镜像 / ISO / 大视频时就是几个 GB。
       * 而这一步正好发生在「源已改名、链接已建」之后 —— 主进程 OOM 直接崩，
       * 连回退逻辑都跑不到，流程就停在最危险的中间态。
       * 用 open + 定长 read 后 close：占用内存与文件大小无关（固定 4KB 缓冲区）。
       * 抽样数量和抽样策略保持不变（仍是前 3 个文件）。 */
      /* 注意读出来的**字节数**可能是 0（空文件），那不代表失败 ——
       * 空文件通过链接能打开、能读，恰恰说明链接是通的。
       * 所以判据是「有没有抛出」，而不是「读到的字节数是不是真值」：
       * 失败时 readHeadBytes 会 reject，上面的 .catch 把它变成 null。 */
      const got = await readHeadBytes(full, 4096).catch(() => null);
      if (got === null) return { ok: false, reason: '通过链接读取文件失败：' + ent.name };
      sampled++;
    }
  } catch (err) {
    return { ok: false, reason: '通过链接列目录失败：' + err.message };
  }
  return { ok: true, sampled };
}

/* 打开文件、读前 n 个字节就关掉。返回实际读到的字节数（0 也算成功：
 * 空文件通过链接读得到 0 字节，这恰恰说明链接是通的）。 */
async function readHeadBytes(file, n) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(n);
    const r = await fh.read(buf, 0, n, 0);
    return r.bytesRead;
  } finally {
    await fh.close().catch(() => {});
  }
}

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
  app.on('will-quit', () => { flushStore(); try { globalShortcut.unregisterAll(); } catch (err) {} });
  app.on('window-all-closed', () => { app.quit(); });
}
process.on('uncaughtException', (err) => console.error('uncaught', err));
