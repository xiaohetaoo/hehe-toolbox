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
const jobId = require('./lib/job-id');               // 后台任务 id 前缀登记（供测试校验归属规则）
const fsOps = require('./lib/fs-ops');               // 唯一名/临时名等文件命名纯逻辑
bootMark('deps-loaded');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
let win = null;
let tray = null;
let isQuitting = false;
let jobSeq = 0;
const jobs = new Map(); // id -> {cancel()}
const serverMap = new Map();
let lastCpuSample = null;
let lastProcSnap = null;

/* ---------------- data store ---------------- */
const storeFile = () => path.join(app.getPath('userData'), 'hehe-data.json');
let storeData = { settings: {}, favorites: [], recents: [], quicklaunch: [], commands: [], clipHistory: [], notes: [], autostartBackup: [] };
// 记录 store 是否加载成功。损坏的 hehe-data.json 会让 loadStore 静默回退默认值，
// 此时 clipHistory 是空的——若照常跑清扫，clip-img 里的所有图片都会被当孤儿删光。
let storeLoadFailed = false;
let saveTimer = null;
function loadStore() {
  try {
    storeData = Object.assign(storeData, JSON.parse(fs.readFileSync(storeFile(), 'utf8')));
  } catch (e) {
    // 首次运行（ENOENT）是正常的；解析失败才是真问题，必须标记出来
    if (e && e.code !== 'ENOENT') {
      storeLoadFailed = true;
      console.error('[store] 读取失败，本次禁用依赖 store 的清扫：', e.message);
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
function runCmd(cmd, args, opts = {}) {
  const enc = opts.encoding || 'utf8';
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 30000, maxBuffer: 32 * 1024 * 1024, cwd: opts.cwd, encoding: enc === 'gbk' ? 'buffer' : enc }, (err, stdout, stderr) => {
      if (enc === 'gbk') {
        const dec = new TextDecoder('gbk');
        stdout = dec.decode(stdout || Buffer.alloc(0));
        stderr = dec.decode(stderr || Buffer.alloc(0));
      }
      if (err && !stdout) reject(sanitizeCmdError(err, args)); else resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? err.code || 1 : 0 });
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
  let clean = msg
    .replace(/\s-p\S+/g, ' -p***')                       // 7z 密码
    .replace(/\s--password[=\s]\S+/gi, ' --password=***')
    .replace(/(password|passwd|token|secret|apikey|api_key)\s*[=:]\s*\S+/gi, '$1=***');
  // 参数里若有长字符串（>=6 位）也抹掉，防止未命中上面模式的传递方式
  for (const a of (args || [])) {
    const s = String(a);
    if (s.length >= 6 && /^[A-Za-z0-9!@#$%^&*()_+\-=\[\]{};:'",.<>\/?\\|`~]{6,}$/.test(s) && clean.includes(s)) {
      clean = clean.split(s).join('***');
    }
  }
  const e = new Error(clean);
  e.code = (err && err.code) || 'CMD_FAILED';
  if (err && err.stack) e.stack = err.stack;
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

/* 本应用在系统临时目录里创建的临时产物（统一 hehe- 前缀）。
   自动清理只允许碰这些文件，绝不能整目录清空——%TEMP% 是全机器共享的，
   里面还有别的程序正在使用的文件，整目录删除会导致它们崩溃或丢数据。

   白名单必须覆盖**所有**本应用会创建的临时产物，否则会出现两种糟糕情况：
     - 漏登记 -> 自己的垃圾永远清不掉
     - 登记太宽 -> 把别人的东西也清了
   新增临时产物目录时，记得在这里加一条。 */
const OWN_TEMP_PATTERNS = [
  /^hehe-snip-\d+\.png$/i,       // 区域截图临时图
  /^hehe-rec-\d+$/i,             // 录制分段目录
  /^hehe-ffmpeg-.*\.zip$/i,      // FFmpeg 下载包
  /^hehe-ffmpeg-win.*\.gz$/i,    // FFmpeg 压缩包
  /^hehe-update-.*\.log$/i,      // 升级脚本日志
  /^hehe-rollback-.*\.log$/i,    // 回滚脚本日志
  /^\.?hehe-7zx-.+/i,           // 7z 解压暂存目录（可能带前导点，见 seven:extract）
  /^hehe-tgt-.+/i,               // 目标体积压缩暂存目录
  /^hehe-uniq-.+/i,              // 通用解压暂存目录
  /^\.?hehe-w-.+/i               // 原子写入的临时文件（实际名带前导点）
];
function isOwnTempName(name) { return OWN_TEMP_PATTERNS.some(re => re.test(name)); }

/* ---------------- 高危功能开关 ----------------
   高危 = 可能造成数据丢失或系统级不可逆影响（删文件、清空回收站、杀进程、
   改 hosts、重启系统…）。这类能力默认关闭，必须先在「设置 → 高危功能」里
   显式开启才能使用。
   门禁放在主进程而不是渲染层：渲染层的 if 只是界面约束，任何一次误改或
   绕过都可能让删文件的 IPC 直接生效。主进程这里是最后一道闸。 */
const DANGEROUS_CAPS = {
  'file-delete': { name: '删除文件', desc: '删除重复文件、空目录、笔记、剪贴板图片等（不进回收站）' },
  'junk-clean': { name: '垃圾清理', desc: '清理系统临时文件、浏览器缓存、缩略图缓存' },
  'recycle-empty': { name: '清空回收站', desc: '永久清空系统回收站，不可恢复' },
  'process-kill': { name: '结束进程', desc: '强制结束任意进程，未保存数据会丢失' },
  'service-stop': { name: '停止系统服务', desc: '停止正在运行的 Windows 服务，依赖它的程序可能异常退出' },
  'system-power': { name: '关机 / 重启 / 休眠', desc: '执行关机、重启、休眠等系统电源操作（锁屏与睡眠不受限制）' },
  'hosts-edit': { name: '编辑 Hosts', desc: '写入系统 hosts 文件并刷新 DNS，影响全机解析' },
  'registry-edit': { name: '注册表与右键菜单', desc: '删除开机自启项、切换 Win11 经典右键菜单' }
};
const DANGEROUS_CAP_IDS = Object.keys(DANGEROUS_CAPS);
// 默认全部关闭；用户在设置里开启的存到 settings.dangerousCaps（数组）
function dangerousEnabled(cap) {
  const list = storeGet('settings.dangerousCaps', []);
  return Array.isArray(list) && list.indexOf(cap) !== -1;
}
// 需要高危权限的 IPC 通道 → 所属能力
const CAP_GATED_CHANNELS = {
  'fs:delete': 'file-delete',
  'fs:delete-empty': 'file-delete',
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
  'ctxmenu:toggle': 'registry-edit'
};
// sys:power 通道里既有危险动作（关机/重启/休眠）也有无害动作（锁屏/睡眠），
// 睡眠只是把内存转成待机状态、不会丢数据，所以不纳入高危门禁。
const DANGEROUS_POWER_ACTIONS = ['hibernate', 'restart', 'shutdown'];
function dangerousDenied(cap) {
  return `「${DANGEROUS_CAPS[cap].name}」属于高危功能，已默认关闭。请到「设置 → 高危功能」中开启后再使用。`;
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
  'dedupe': ['file-delete'],
  'local-notes': ['file-delete'],
  'clipboard-history': ['file-delete'],
  'process-manager': ['process-kill'],
  'port-occupy': ['process-kill'],
  'services-power': ['service-stop'],
  'quick-ops': ['system-power', 'recycle-empty'],
  'hosts-edit': ['hosts-edit'],
  'autostart': ['registry-edit'],
  'win-classic-menu': ['registry-edit']
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
        contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false
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

// 主窗显示：先让启动窗淡出，再显示主窗，避免中间出现一帧空白
function showWindowAfterSplash() {
  if (mainShown) return;
  mainShown = true;
  const reveal = () => {
    if (!win || win.isDestroyed()) return;
    try { win.show(); } catch (e) {}
    bootMark('window-shown');
    destroySplash();
  };
  // 启动窗根本没显示过（启动太快）→ 直接显示主窗，不做任何淡出等待
  if (!splashVisible || !splashWin || splashWin.isDestroyed()) { reveal(); return; }
  splashSend('splash:done', {});
  // CSS transition 要到下一帧才开始计时，0.18s 的淡出实际完成时间更晚；
  // 原来用 180ms 会在动画还差最后一点时 destroy()，视觉上是一次硬消失。
  // 留出启动窗隐藏的 await 时间，取 260ms 与 transition 时长匹配。
  setTimeout(reveal, 260);
}

function createWindow() {
  bootMark('create-window-start');
  mainShown = false; // 窗口可能被销毁后重建（从托盘重新打开），需要重新走一次显示流程
  win = new BrowserWindow({
    width: 1000, height: 660, minWidth: 860, minHeight: 580,
    frame: false, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#F2F3F5',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: '核核工具箱',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
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
function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'assets', 'icon32.png'));
    tray.setToolTip('核核工具箱');
    const menu = Menu.buildFromTemplate([
      { label: '显示主界面', click: showMainWindow },
      { type: 'separator' },
      { label: '✂️ 截图标注', click: () => { snipStart('annotate').catch(() => {}); } },
      { label: '📌 贴剪贴板图片', click: () => { pinClipboardImage().catch((e2) => { showMainWindow(); send('tray:err', e2.message); }); } },
      { label: '📝 记事', click: () => { showMainWindow(); send('app:open-tool', 'local-notes'); } },
      { label: '🔍 OCR 剪贴板图片', click: async () => {
          const img = clipboard.readImage();
          if (img.isEmpty()) { showMainWindow(); send('tray:err', '剪贴板中没有图片'); return; }
          const file = snipTmp();
          await fsp.writeFile(file, img.toPNG());
          showMainWindow();
          send('snip:ocr', file);
        } },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', showMainWindow);
  } catch (e) { console.error('tray failed', e); tray = null; }
}

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
handle('win:is-maximized', () => win ? win.isMaximized() : false);
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
handle('store:remove', (e, key) => { storeSet(key, undefined); return true; });
handle('app:set-theme', (e, mode) => { nativeTheme.themeSource = mode; return nativeTheme.shouldUseDarkColors; });
handle('app:open-devtools', () => { win && win.webContents.toggleDevTools(); });
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
handle('dialog:message', async (e, opts) => {
  const r = await dialog.showMessageBox(win, Object.assign({ type: 'info', buttons: ['确定'], title: '核核工具箱', noLink: true }, opts));
  return r.response;
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
  const tmp = path.join(dir, '.hehe-w-' + tag + '.tmp');
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
    const bak = path.join(dir, '.hehe-bak-' + tag);
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
   * 只放宽「忽略大小写后完全相同」的情形；FILE.TXT → OTHER.TXT 仍然拒绝。 */
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
        while (cur.length >= root.length) {
          if (dirSize.has(cur)) dirSize.set(cur, dirSize.get(cur) + item.size);
          if (cur === path.parse(cur).root || cur === root) break;
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
  const topDirs = [...dirSize.entries()].filter(([p]) => p !== root).map(([p, size]) => ({ path: p, size }))
    .sort((a, b) => b.size - a.size).slice(0, 30);
  if (cancelRef.canceled) throw new Error('已取消');
  return { id, root, totalSize, files, dirCount, topFiles: topFiles.slice(0, 30), topDirs };
});

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
  for (const p of dirs) { // deepest first (caller sorts)
    // 闸门：不允许删系统关键目录 / 盘符根 / 用户主目录本身
    const bad = pathGuard.checkDeletable(p, false);
    if (bad) { errors.push(`${p}: ${bad.reason}`); continue; }
    /* 删空目录。这里【不能】用 fsp.rm —— 它对目录只在 recursive:true 时才成功，
     * 而 recursive:true 会把目录里的内容一起删掉，语义完全不同（会毁数据）。
     * fsp.rmdir 在 Node 24 上仍然可用（只是被标记为将来可能弃用）。
     * 所以：优先 rmdir，万一将来真的移除，再退到「先确认目录为空再删」的写法。 */
    try {
      if (typeof fsp.rmdir === 'function') {
        await fsp.rmdir(p);
      } else {
        // 降级：先读目录，确认确实是空的再删（绝不用 recursive:true）
        const ents = await fsp.readdir(p);
        if (ents.length !== 0) throw new Error('目录非空，跳过');
        await fsp.rmdir(p);
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
  return out;
});
handle('fs:clean-junk', async (e, targets, keepRoot) => {
  let cleaned = 0, bytes = 0; const errors = [];
  const tmpRoot = path.resolve(os.tmpdir());
  for (const t of targets) {
    try {
      const abs = path.resolve(String(t || ''));
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
        await fsp.rm(abs, { recursive: true, force: true });
      }
      cleaned++; bytes += before;
    } catch (err) { errors.push(`${t}: ${fmtErr(err)}`); }
  }
  return { cleaned, bytes, errors };
});

/* hash / encrypt / split / dedupe */
const HASH_ALGOS = ['md5', 'sha1', 'sha256', 'sha512'];
/* 单算法：内部走多算法实现，保证两条通道行为完全一致 */
handle('fs:hash-file', async (e, p, algo = 'sha256') => {
  const r = await hashFileMulti(p, [algo]);
  return { hex: r.hex[algo], size: r.size, algo };
});

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

handle('fs:hash-text', (e, text, algo = 'sha256') => {
  if (!HASH_ALGOS.includes(algo)) throw new Error('不支持的算法');
  return { hex: crypto.createHash(algo).update(text, 'utf8').digest('hex') };
});
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
    if (st.size < 64) throw new Error('文件不完整：加密文件至少应有 64 字节（当前 ' + st.size + ' 字节），可能下载或复制时被截断');
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
  const cryptTmp = outPath + '.hehe-crypt-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
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
    // 分片必须排他创建（flags: 'wx'）：默认的 'w' 会截断已存在的同名分片，
    // 用户重复分割同一个文件时，旧分片被静默覆盖，合并结果就是新旧混合。
    const openPart = () => {
      const partPath = path.join(outDir, `${base}.part${String(idx).padStart(pad, '0')}`);
      ws = fs.createWriteStream(partPath, { flags: 'wx' });
      ws.on('error', (e) => {
        if (e && e.code === 'EEXIST') {
          reject(new Error('目标目录已存在同名分片：' + path.basename(partPath) + '（为避免覆盖已中止，请换个输出目录或先清理旧分片）'));
          return;
        }
        reject(e); // 磁盘满/权限错误时让 Promise 落定，而非悬挂
      });
      realParts = idx;
    };
    openPart();
    rs.on('data', (chunk) => {
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
    rs.on('end', () => { ws.end(); ws.on('finish', resolve); });
    rs.on('error', reject);
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
      const maxSize = sizes.length ? Math.max(...sizes) : 0;
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
  const used = new Set();
  for (const p of paths) {
    const st = await fsp.stat(p);
    if (st.isDirectory()) zip.addLocalFolder(p, path.basename(p));
    else {
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
function isPowerCommand(cmd) {
  return powerGate.isPowerCommand(cmd);
}
function assertPowerAllowed(cmd) {
  const denyMsg = powerGate.checkPowerGate(cmd, dangerousEnabled('system-power'));
  if (denyMsg) {
    const e = new Error(denyMsg);
    e.code = 'CAP_DENIED';
    throw e;
  }
}
handle('exec:run', async (e, { cmd, args, shellType, cwd, timeoutMs }) => {
  // 关机/重启/休眠必须先在设置里开启「系统电源操作」
  assertPowerAllowed(cmd);
  if (args && args.length) assertPowerAllowed(args.join(' '));
  if (shellType === 'ps') return await ps(cmd, timeoutMs || 30000, cwd);
  if (shellType === 'cmd') {
    return await runCmd('cmd.exe', ['/c', cmd], { cwd, timeout: timeoutMs || 30000, encoding: 'gbk' });
  }
  return await runCmd(cmd, args || [], { cwd, timeout: timeoutMs || 30000, encoding: 'gbk' });
});
handle('exec:stream', (e, { command, args, cwd }) => {
  // 流式通道同样要过电源门禁
  assertPowerAllowed(command);
  if (args && args.length) assertPowerAllowed(args.join(' '));
  const id = 'job' + (++jobSeq);
  const proc = spawn(command, args || [], { windowsHide: true, cwd });
  jobs.set(id, {
    cancel: () => { try { if (isWin) spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true }); else proc.kill('SIGKILL'); } catch (err) {} }
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
let latestCancelable = null;
handle('job:cancel-latest', () => { if (latestCancelable) { latestCancelable(); return true; } return false; });

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
  // 查进程名，命中系统关键进程直接拒绝。注意 taskkill 的 /f 对 lsass 这类
  // 受保护进程会触发系统强制重启（蓝屏），是不可逆破坏。
  try {
    const r = await ps(`try{(Get-Process -Id ${n} -ErrorAction Stop).ProcessName}catch{''}`, 10000);
    const pname = String(r.stdout || '').trim().toLowerCase();
    if (pname && PROTECTED_PROC_NAMES.has(pname)) {
      throw new Error(`拒绝结束系统关键进程：${pname}（ID ${n}）。结束它会导致系统蓝屏或强制重启。`);
    }
    if (n <= PROTECTED_PROC_PID_MAX) {
      throw new Error(`拒绝结束 PID ${n}：低 PID 区（≤${PROTECTED_PROC_PID_MAX}）通常是系统进程，误杀会造成不可逆损坏。如确认无误请用任务管理器操作。`);
    }
  } catch (err) {
    // 查不到进程名时放行（进程可能已退出），但低 PID 拦截仍然生效
    if (/拒绝结束/.test(String(err.message))) throw err;
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
      stream.on('error', () => { try { res.destroy(); } catch (e) {} });
      stream.pipe(res);
      send('server:log', { time: Date.now(), text: `200  ${req.method} ${urlPath}  ${st.size}B` });
    } catch (err) { res.writeHead(500); res.end('500'); }
  });
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(p, '127.0.0.1', () => resolve()); });
  serverMap.set('s', srv);
  return { port: p, url: `http://127.0.0.1:${p}` };
});
handle('server:stop', () => {
  const s = serverMap.get('s');
  if (s) { s.close(); serverMap.delete('s'); }
  return true;
});
handle('server:status', () => serverMap.has('s'));

/* ================= IPC: system ================= */
let hwCache = null, hwCacheAt = 0;
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
    os: j.os || {}, nic: norm(j.nic).filter(n => n.Name),
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
handle('app:get-accent', () => currentAccent);

/* screen ruler floating window */
let rulerWin = null;
handle('win:ruler', (e, dir) => {
  if (rulerWin && !rulerWin.isDestroyed()) rulerWin.close();
  const horizontal = dir !== 'v';
  rulerWin = new BrowserWindow({
    width: horizontal ? 600 : 56, height: horizontal ? 56 : 600,
    frame: false, transparent: true, alwaysOnTop: true, resizable: false,
    skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false }
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
handle('qr:save', async (e, text, outPath, opts = {}) => {
  /* 这个通道目前 UI 已经不走（前端改用 fs:write-file-b64 自己编码），
   * 但保留以免旧调用方失效。既然仍可达，就必须和别的写文件通道一样过闸门：
   * 参数直接来自渲染层，不校验就等于留了一个「任意路径写文件」的入口。 */
  const bad = pathGuard.checkOverwritable(outPath);
  if (bad) throw pathGuard.err(bad.code, bad.reason);
  const target = await fsOps.uniquePath(outPath); // 不覆盖已有文件
  const QRCode = require('qrcode');
  await QRCode.toFile(target, text, { width: opts.size || 640, margin: opts.margin != null ? opts.margin : 2, errorCorrectionLevel: opts.level || 'M' });
  return { outPath: target };
});

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
    // 用户可能选了任意名字的 ffmpeg，按主程序判断：能执行 -version 的当作 ffmpeg
    const first = picked.filePaths[0];
    try {
      await runCmd(first, ['-version'], { timeout: 8000 });
      await fsp.copyFile(first, path.join(binDir(), 'ffmpeg.exe'));
      copied.push('ffmpeg.exe');
    } catch (err) {}
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
  return new Promise(async (resolve, reject) => {
    const MAX_RETRY = 6;
    /* 先写任务专属临时文件，校验通过后才原子改名为最终名。
       原实现直接写 dest：下载中断或重试耗尽时，dest 会留下体积不足的残缺文件，
       用户以为下好了（尤其 .exe），要等运行才发现损坏。
       现在失败/取消一律删临时文件，dest 要么不存在、要么是完整内容。 */
    const tmp = dest + '.part-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
    const cleanup = () => { try { fs.rmSync(tmp, { force: true }); } catch (e) {} };
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
        if (r.status === 416) { res(); return; } // 已下载完整
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
    const zipPath = path.join(app.getPath('temp'), 'hehe-ffmpeg-' + Date.now() + '.zip');
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
      const srcSize = (await fsp.stat(input)).size;
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

      const tmpDir = path.join(app.getPath('temp'), 'hehe-tgt-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'));
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
          // 校验通过才提交：改成最终名（同名自动编号，不覆盖已有文件）
          const dst = await uniqueTarget(outDir, base + '.mp4');
          await fsp.rename(finalOut.file, dst);
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
      if (opts.format === 'mp3' || opts.format === 'm4a' || opts.mute) args.push('-vn');
      if (opts.mute) { args.push('-an'); }
      else {
        // 音频编码按容器选择：wav→PCM、flac→无损 flac（aac 进这两个容器会被拒绝/非标）
        const ac = opts.acodec || (opts.format === 'webm' ? 'libopus' : opts.format === 'mp3' ? 'libmp3lame' : opts.format === 'wav' ? 'pcm_s16le' : opts.format === 'flac' ? 'flac' : 'aac');
        args.push('-c:a', ac);
        if (ac === 'aac') args.push('-b:a', '160k');
        if (ac === 'libmp3lame') args.push('-q:a', '2');
        if (ac === 'libopus') args.push('-b:a', '128k');
      }
      const isAudioOut = ['mp3', 'm4a', 'wav', 'flac'].includes(opts.format);
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
  const r = await runCmd(ffmpeg, args, { timeout: 300000 });
  if (r.code !== 0) throw new Error('截帧失败：' + (r.stderr || r.stdout).split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' '));
  let n = 0;
  try { n = (await fsp.readdir(outDir)).filter(f => f.startsWith(base + '_') && f.endsWith('.jpg')).length; } catch (e) {}
  return { outDir, count: n, first: path.join(outDir, mode === 'single' ? `${base}_frame.jpg` : `${base}_001.jpg`) };
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
  let office = false;
  try { await runCmd('powershell.exe', ['-NoProfile', '-Command', 'try{$w=New-Object -ComObject Word.Application;$w.Quit();exit 0}catch{exit 1}'], { timeout: 20000 }); office = true; } catch (err) {}
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
      const stage = path.join(app.getPath('temp'), 'hehe-uniq-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'));
      try {
        await fsp.mkdir(stage, { recursive: true });
        await runCmd(soffice, ['--headless', '--norestore', '--convert-to', target, '--outdir', stage, f], { timeout: 180000 });
        const produced = path.join(stage, path.basename(f).replace(/\.[^.]+$/, '') + '.' + target);
        if (!(await pathExists(produced))) {
          results.push({ input: f, out: null, ok: false, err: '转换未产出文件（格式可能不支持）' });
          continue;
        }
        const out = await uniqueTarget(outDir, path.basename(produced));
        await fsp.mkdir(path.dirname(out), { recursive: true });
        await fsp.rename(produced, out);
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
handle('rec:video-devices', async () => {
  const d = await listDshowDevices();
  return { devices: d.video };
});
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
handle('rec:start', async (e, { outPath, fps, rect, audio, camera, camPos, camScale }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  if (recProc && recProc.exitCode === null) throw new Error('已有录制进行中');
  recOut = outPath;
  // yuv420p 要求偶数尺寸/偏移，框选结果向下取偶
  if (rect && typeof rect === 'object') {
    rect = { x: Math.max(0, Math.round(rect.x)) & ~1, y: Math.max(0, Math.round(rect.y)) & ~1,
      w: Math.max(64, Math.round(rect.w)) & ~1, h: Math.max(64, Math.round(rect.h)) & ~1 };
  } else rect = null;
  recOpts = { fps: fps || 30, rect, audio: audio || null, camera: camera || null, camPos: camPos || 'rb', camScale: camScale || 0.25 };
  recSegs = [];
  recSegDir = path.join(app.getPath('temp'), 'hehe-rec-' + Date.now());
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
      const gifTarget = recOut.replace(/\.mp4$/i, '.gif');
      try {
        const ffmpeg = findFfmpeg();
        const r = await runCmd(ffmpeg, ['-y', '-hide_banner', '-i', recOut, '-vf', 'fps=10,scale=480:-2:flags=lanczos', gifTarget], { timeout: 300000 });
        if (r.code !== 0) throw new Error('GIF 转码失败');
        gifOut = gifTarget;
      } catch (err) {
        // 失败时 ffmpeg 会留下体积不足的残缺 .gif，必须删掉，
        // 否则用户看到「录制完成」却发现目录里多了一个打不开的文件。
        await fsp.rm(gifTarget, { force: true }).catch(() => {});
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
const pinWins = new Map();
async function createPinWindow(srcPath) {
  const img = nativeImage.createFromPath(srcPath);
  const size = img.getSize();
  if (!size.width) throw new Error('无法读取图片');
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const scale = Math.min(1, (wa.width * 0.5) / size.width, (wa.height * 0.7) / size.height);
  const bw = new BrowserWindow({
    width: Math.max(80, Math.round(size.width * scale)), height: Math.max(60, Math.round(size.height * scale)),
    frame: false, transparent: true, alwaysOnTop: true, resizable: false, skipTaskbar: true, hasShadow: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false }
  });
  bw.setAlwaysOnTop(true, 'screen-saver');
  pinWins.set(bw.id, bw);
  bw.on('closed', () => pinWins.delete(bw.id));
  await bw.loadFile('pin.html', { query: { id: String(bw.id), src: srcPath, accent: currentAccent } });
  return { id: bw.id, w: size.width, h: size.height };
}
handle('win:pin-image', (e, srcPath) => createPinWindow(srcPath));
handle('win:pin-move', (e, id, x, y) => { const bw = pinWins.get(id); if (bw && !bw.isDestroyed()) bw.setPosition(Math.round(x), Math.round(y)); return true; });
handle('win:pin-resize', (e, id, w, h) => { const bw = pinWins.get(id); if (bw && !bw.isDestroyed()) bw.setSize(Math.max(80, Math.round(w)), Math.max(60, Math.round(h))); return true; });
handle('win:pin-close', (e, id) => { const bw = pinWins.get(id); if (bw && !bw.isDestroyed()) bw.close(); return true; });

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
  const staging = path.join(outDir, '.hehe-7zx-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'));
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
    // 合并阶段失败：把已经搬出去的条目撤回去，让 outDir 不留半成品
    for (const dst of movedTo.reverse()) {
      try { await fsp.rm(dst, { force: true }); } catch (e) {}
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
  const key = (out.match(/(?:关键内容|Key Content)\s*:\s*(.*)$/) || [])[1];
  const auth = (out.match(/(?:身份验证|Authentication)\s*:\s*(.*)$/) || [])[1];
  return { key: key ? key.trim() : '', auth: auth ? auth.trim() : '', raw: out };
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
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || '').split(/\r?\n/).filter(l => l.trim()).slice(-1).join(' ') || '操作失败（启动/停止服务通常需要管理员权限）');
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
  const id = 'dl2' + (++jobSeq);
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
const snipTmp = () => path.join(app.getPath('temp'), 'hehe-snip-' + Date.now() + '.png');
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
  const pt = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(pt);
  const img = await captureDisplay(display);
  const file = snipTmp();
  await fsp.writeFile(file, img.toPNG());
  snipWin = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
    frame: false, transparent: true, alwaysOnTop: true, resizable: false, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false }
  });
  snipWin.setAlwaysOnTop(true, 'screen-saver');
  snipWin.setFullScreen(true);
  snipWin.on('closed', () => { snipWin = null; });
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
    if (!p.canceled && p.filePath) {
      fs.copyFileSync(file, p.filePath);
      return { ok: true, path: p.filePath };
    }
    return { ok: false };
  }
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
    const payload = {
      current, latest, hasUpdate: cmpVer(latest, current) > 0, engine: 'github',
      notes: (j.body || '').slice(0, 4000), assetUrl: asset ? asset.browser_download_url : null, assetName: asset ? asset.name : null, htmlUrl: j.html_url || ''
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
handle('update:apply', async (e, opts = {}) => {
  const newExe = opts && opts.newExe;
  if (!newExe || !fs.existsSync(newExe)) throw new Error('新版文件不存在，请先完成下载');
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
  // 给脚本 ~1 秒启动时间后退出，脚本会等待本进程消失再替换
  setTimeout(() => { try { isQuitting = true; app.exit(0); } catch (err) { app.quit(); } }, 1000);
  return { ok: true, target, newExe, backup, rollbackScript, script };
});
// 清理 update 下载目录里「已经应用过」的旧安装包。
// 关键：刚下载、还没安装的新包绝不能删——它正是接下来 update:apply 要用的文件。
// 原实现把该目录下所有 hehe-toolbox-Portable-*.exe 一律删光，于是“下载完切走再回关于页”
// 就把 90MB+ 白下了一遍，而且没有任何提示。
// 判据：文件名里的版本号 <= 当前运行版本，说明那份包要么是当前版本、要么早已被取代，
// 留着纯属占地方；只有版本号 > 当前版本、且没被 update:apply 记录为已应用的，才保留。
function updatePendingGet() { return updateCacheGet() || {}; }
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
  return { removed, bytes, kept };
});
// 记下“已下载、等待安装”的那份包名，供 update:cleanup 豁免
handle('update:mark-pending', (e, name) => {
  updateCacheSet({ pendingName: name ? String(name) : null });
  return true;
});
function cmpVer(a, b) {
  const pa = String(a || '').split('.').map(Number), pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
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
  } else if (s.type === 'daily') {
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
handle('clip:gc-images', async () => {
  // 必须确认 clipHistory 是**真正的数组**。JSON 解析成功但缺这个字段
  // （手工编辑、旧版本升级）时 storeGet 返回默认 []，used 为空 ->
  // 目录里每一张图片都会被当成孤儿删光。
  const hist = storeGet('clipHistory', null);
  if (!Array.isArray(hist)) {
    console.warn('[gc] clipHistory 缺失或类型异常，跳过清扫');
    return { removed: 0, kept: 0, skipped: true };
  }
  const dir = clipImgDir();
  let names = [];
  try { names = await fsp.readdir(dir); } catch (e) { return { removed: 0, kept: 0 }; }
  const used = new Set();
  for (const it of hist) {
    if (it && it.file && isClipImgPath(it.file)) used.add(path.resolve(it.file));
  }
  // 二次保险：历史里一条图片都没有时不清理（很可能是数据异常而非真的全空）
  if (used.size === 0 && names.filter(n => /\.png$/i.test(n)).length > 0) {
    console.warn('[gc] clipHistory 里没有任何图片引用，但目录里有文件，跳过清扫以防止误删');
    return { removed: 0, kept: 0, skipped: true };
  }
  let removed = 0;
  for (const n of names) {
    if (!/\.png$/i.test(n)) continue;
    const full = path.resolve(path.join(dir, n));
    if (used.has(full)) continue;
    try { await fsp.unlink(full); removed++; } catch (err) {}
  }
  return { removed, kept: used.size };
});

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
    armAllSchedules(); // 周期任务（每日提醒/循环提醒/自动清理）
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
