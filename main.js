'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, Tray, Menu, screen, globalShortcut, nativeTheme, desktopCapturer } = require('electron');
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
let saveTimer = null;
function loadStore() {
  try { storeData = Object.assign(storeData, JSON.parse(fs.readFileSync(storeFile(), 'utf8'))); } catch (e) { /* first run */ }
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
  try { return { ok: true, data: await fn(e, ...args) }; }
  catch (err) { return { ok: false, error: fmtErr(err) }; }
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
      if (err && !stdout) reject(err); else resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? err.code || 1 : 0 });
    });
  });
}
// Windows PowerShell 输出默认是 OEM 代码页（GBK），强制其以 UTF-8 输出，避免中文乱码
function ps(script, timeout = 30000, cwd) {
  return runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + script], { timeout, encoding: 'utf8', cwd });
}

/* ---------------- window ---------------- */
// 系统主题变化时广播到渲染端（跟随系统模式下同步深浅色）
nativeTheme.on('updated', () => {
  send('settings.theme-changed', nativeTheme.shouldUseDarkColors);
});
function createWindow() {
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
  win.loadFile('index.html');
  win.webContents.on('console-message', (...args) => {
    let level, message, source, line;
    if (typeof args[1] === 'number') { level = args[1]; message = args[2]; line = args[3]; source = args[4]; }
    else { const ev = args[0]; level = ev.level; message = ev.message; source = ev.sourceId; line = ev.lineNumber; }
    console.log(`[renderer:${level}]`, message, `(${source}:${line})`);
  });
  win.once('ready-to-show', () => win.show());
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

/* ---------------- cpu sampler ---------------- */
function sampleCpu() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  if (lastCpuSample) {
    const idleD = idle - lastCpuSample.idle, totalD = total - lastCpuSample.total;
    return totalD > 0 ? Math.min(100, Math.max(0, (1 - idleD / totalD) * 100)) : 0;
  }
  return 0;
}
setInterval(() => {
  const cpu = sampleCpu();
  lastCpuSample = { idle: os.cpus().reduce((s, c) => s + c.times.idle, 0), total: os.cpus().reduce((s, c) => s + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq, 0) };
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
handle('fs:write-text', async (e, p, content) => { await fsp.writeFile(p, content, 'utf8'); return true; });
handle('fs:read-file-b64', async (e, p) => {
  const st = await fsp.stat(p);
  if (st.size > BIN_LIMIT) throw new Error('文件超过 64MB 限制');
  return { b64: (await fsp.readFile(p)).toString('base64'), size: st.size };
});
handle('fs:write-file-b64', async (e, p, b64) => { await fsp.writeFile(p, Buffer.from(b64, 'base64')); return true; });
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
handle('fs:rename', async (e, from, to) => { await fsp.rename(from, to); return true; });
handle('fs:delete', async (e, p, recursive) => { await fsp.rm(p, { recursive: !!recursive, force: true }); return true; });
handle('fs:open-path', async (e, p) => { const err = await shell.openPath(p); if (err) throw new Error(err); return true; });
handle('fs:show-item', (e, p) => { shell.showItemInFolder(p); return true; });
handle('shell:open-url', (e, url) => { shell.openExternal(url); return true; });
handle('fs:unique-path', async (e, p) => {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p), ext = path.extname(p), base = path.basename(p, ext);
  for (let i = 1; i < 1000; i++) { const np = path.join(dir, `${base}(${i})${ext}`); if (!fs.existsSync(np)) return np; }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
});

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
      if (now - lastEmit > 250) { lastEmit = now; send('job:progress', { id, files, size: totalSize }); }
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
    try { await fsp.rmdir(p); deleted++; } catch (err) { if (err.code !== 'ENOENT') errors.push(`${p}: ${fmtErr(err)}`); }
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
    { id: 'temp', label: '用户临时文件', path: os.tmpdir() },
    { id: 'chrome', label: 'Chrome 浏览器缓存', path: path.join(local, 'Google', 'Chrome', 'User Data'), pattern: /Cache|Code Cache|GPUCache/ },
    { id: 'edge', label: 'Edge 浏览器缓存', path: path.join(local, 'Microsoft', 'Edge', 'User Data'), pattern: /Cache|Code Cache|GPUCache/ },
    { id: 'thumb', label: '缩略图缓存', path: path.join(local, 'Microsoft', 'Windows', 'Explorer'), pattern: /thumbcache|thumbcache_.*\.db/i }
  ];
  const out = [];
  for (const c of cands) {
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
  for (const t of targets) {
    try {
      const before = (await dirSizeFast(t)).size;
      const st = await fsp.stat(t).catch(() => null);
      if (st && st.isFile()) {
        await fsp.rm(t, { force: true }); // 文件目标（缩略图缓存）直接删除
      } else if (keepRoot) {
        const entries = await fsp.readdir(t).catch(() => []);
        for (const n of entries) await fsp.rm(path.join(t, n), { recursive: true, force: true });
      } else {
        await fsp.rm(t, { recursive: true, force: true });
      }
      cleaned++; bytes += before;
    } catch (err) { errors.push(`${t}: ${fmtErr(err)}`); }
  }
  return { cleaned, bytes, errors };
});

/* hash / encrypt / split / dedupe */
const HASH_ALGOS = ['md5', 'sha1', 'sha256', 'sha512'];
handle('fs:hash-file', async (e, p, algo = 'sha256') => {
  if (!HASH_ALGOS.includes(algo)) throw new Error('不支持的算法');
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    const st = fs.statSync(p); let done = 0; let last = 0;
    const rs = fs.createReadStream(p, { highWaterMark: 1 << 20 });
    rs.on('data', (chunk) => { hash.update(chunk); done += chunk.length; if (Date.now() - last > 200) { last = Date.now(); send('job:progress', { id: p, done, total: st.size }); } });
    rs.on('end', () => resolve({ hex: hash.digest('hex'), size: st.size, algo }));
    rs.on('error', reject);
  });
});
handle('fs:hash-text', (e, text, algo = 'sha256') => {
  return { hex: crypto.createHash(algo).update(text, 'utf8').digest('hex') };
});

const ENC_MAGIC = Buffer.from('HEHEENC1');
function deriveKey(password, salt) { return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }); }
async function cryptStream(p, outPath, password, decrypt) {
  const st = await fsp.stat(p);
  if (path.resolve(p) === path.resolve(outPath)) throw new Error('输出路径不能与源文件相同');
  let srcStart = 0, cipher, header = null;
  if (!decrypt) {
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(16);
    header = Buffer.concat([ENC_MAGIC, salt, iv]);
    cipher = crypto.createCipheriv('aes-256-cbc', deriveKey(password, salt), iv);
  } else {
    // 先读取 40 字节文件头，再从第 40 字节起进入解密管道
    const fh = await fsp.open(p, 'r');
    const head = Buffer.alloc(40);
    try { await fh.read(head, 0, 40, 0); } finally { await fh.close().catch(() => {}); }
    if (!head.subarray(0, 8).equals(ENC_MAGIC)) throw new Error('不是有效的核核加密文件（缺少文件头）');
    cipher = crypto.createDecipheriv('aes-256-cbc', deriveKey(password, head.subarray(8, 24)), head.subarray(24, 40));
    srcStart = 40;
  }
  const rs = fs.createReadStream(p, { highWaterMark: 1 << 20, start: srcStart });
  const ws = fs.createWriteStream(outPath);
  if (header) ws.write(header);
  let done = 0;
  const total = Math.max(1, st.size - srcStart);
  rs.on('data', (chunk) => { done += chunk.length; send('job:progress', { id: p, done, total }); });
  try {
    await new Promise((resolve, reject) => {
      require('stream').pipeline(rs, cipher, ws, (err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    try { fs.rmSync(outPath, { force: true }); } catch (e) {}
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
  const st = fs.statSync(p);
  const chunkSize = Math.max(1, chunkMB) * 1024 * 1024;
  const base = path.basename(p);
  const parts = Math.ceil(st.size / chunkSize);
  const pad = String(parts).length;
  await fsp.mkdir(outDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(p, { highWaterMark: 1 << 20 });
    let idx = 1, ws = null, done = 0, pausedFor = null;
    const openPart = () => { ws = fs.createWriteStream(path.join(outDir, `${base}.part${String(idx).padStart(pad, '0')}`)); };
    openPart();
    rs.on('data', (chunk) => {
      let off = 0;
      while (off < chunk.length) {
        if (ws.bytesWritten >= chunkSize) { ws.end(); idx++; openPart(); if (pausedFor && pausedFor !== ws) { pausedFor = null; rs.resume(); } }
        const n = Math.min(chunk.length - off, chunkSize - ws.bytesWritten);
        const piece = chunk.subarray(off, off + n); off += n;
        if (!ws.write(piece)) { // 背压：慢盘上防止内存无界堆积
          pausedFor = ws; rs.pause();
          ws.once('drain', () => { if (pausedFor === ws) { pausedFor = null; rs.resume(); } });
        }
      }
      done += chunk.length; send('job:progress', { id: p, done, total: st.size });
    });
    rs.on('end', () => { ws.end(); ws.on('finish', resolve); });
    rs.on('error', reject);
  });
  const manifest = { tool: 'hehe-split', name: base, size: st.size, chunkSize, parts };
  const manifestPath = path.join(outDir, `${base}.manifest.hehe.json`);
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { parts, manifestPath, outDir, chunkSize };
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
  // 默认输出「原名.merged.扩展名」，且被占用时自动加序号，避免覆盖原始文件
  let finalOut = outPath;
  if (!finalOut) {
    const ext = path.extname(man.name);
    const stem = path.basename(man.name, ext);
    finalOut = path.join(dir, `${stem}.merged${ext}`);
    for (let i = 1; i < 1000 && fs.existsSync(finalOut); i++) finalOut = path.join(dir, `${stem}.merged(${i})${ext}`);
  }
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(finalOut);
    let i = 1, done = 0;
    const next = () => {
      if (i > man.parts) { ws.end(); ws.on('finish', resolve); return; }
      const part = path.join(dir, `${man.name}.part${String(i).padStart(String(man.parts).length, '0')}`);
      const rs = fs.createReadStream(part);
      rs.on('data', (c) => { done += c.length; send('job:progress', { id: finalOut, done, total: man.size }); });
      rs.on('end', () => { i++; next(); });
      rs.on('error', reject);
      rs.pipe(ws, { end: false });
    };
    next();
  });
  return { outPath: finalOut, size: man.size, parts: man.parts };
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
      if (now - lastEmit > 300) { lastEmit = now; send('job:progress', { id, files: scanned }); }
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
            const fd = fs.openSync(f, 'r');
            try {
              const sz = fs.fstatSync(fd).size;
              const len = Math.min(8192, sz);
              const buf = Buffer.alloc(len * 2);
              fs.readSync(fd, buf, 0, len, 0);
              fs.readSync(fd, buf, len, len, Math.max(0, sz - len));
            } finally { fs.closeSync(fd); }
            k = crypto.createHash('md5').update(buf).digest('hex');
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
      const st = await fsp.stat(files[0]).catch(() => null);
      groups.push({ size: st ? st.size : 0, hash: mode === 'content' ? 'md5' : mode, files });
    }
    groups.sort((a, b) => b.size * b.files.length - a.size * a.files.length);
    return { groups, mode, totalWasted: groups.reduce((s, g) => s + g.size * (g.files.length - 1), 0) };
  } finally { jobs.delete(id); }
});

/* zip */
handle('zip:compress', async (e, paths, outZip) => {
  const zip = new AdmZip();
  for (const p of paths) {
    const st = await fsp.stat(p);
    if (st.isDirectory()) zip.addLocalFolder(p, path.basename(p));
    else zip.addLocalFile(p);
  }
  zip.writeZip(outZip);
  return { outZip, size: (await fsp.stat(outZip)).size };
});
handle('zip:extract', async (e, zipPath, outDir) => {
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(outDir, true);
  return { outDir };
});

/* ================= IPC: exec / process ================= */
handle('exec:run', async (e, { cmd, args, shellType, cwd, timeoutMs }) => {
  if (shellType === 'ps') return await ps(cmd, timeoutMs || 30000, cwd);
  if (shellType === 'cmd') {
    return await runCmd('cmd.exe', ['/c', cmd], { cwd, timeout: timeoutMs || 30000, encoding: 'gbk' });
  }
  return await runCmd(cmd, args || [], { cwd, timeout: timeoutMs || 30000, encoding: 'gbk' });
});
handle('exec:stream', (e, { command, args, cwd }) => {
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
      if (dt > 0 && dCpu >= 0) cpuPct = Math.round(Math.min(100, (dCpu / dt / os.cpus().length) * 100) * 10) / 10;
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
handle('proc:kill', async (e, pid) => {
  await runCmd('taskkill', ['/pid', String(pid), '/f'], { timeout: 10000 });
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
      if (done % 100 === 0) send('job:progress', { id, done, total: ports.length, open: open.length });
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
      if (fp !== absRoot && !fp.startsWith(absRoot + path.sep)) { res.writeHead(403); res.end('403'); return; }
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
  await runCmd('reg', ['add', item.key, '/v', item.name, '/t', item.type || 'REG_SZ', '/d', item.cmd, '/f'], { timeout: 10000 });
  const bak = storeGet('autostartBackup', []).filter(b => !(b.hive === item.hive && b.name === item.name));
  storeSet('autostartBackup', bak);
  return true;
});
handle('autostart:disabled-list', () => storeGet('autostartBackup', []));

/* hosts */
const HOSTS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
handle('hosts:read', async () => ({ content: await fsp.readFile(HOSTS_PATH, 'utf8'), path: HOSTS_PATH }));
handle('hosts:write', async (e, content) => {
  await fsp.writeFile(HOSTS_PATH, content, 'utf8');
  try { await runCmd('ipconfig', ['/flushdns'], { timeout: 10000 }); } catch (err) {}
  return true;
});
handle('hosts:backup', async () => {
  const dir = path.join(app.getPath('userData'), 'hosts-backup');
  await fsp.mkdir(dir, { recursive: true });
  const name = `hosts-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.bak`;
  await fsp.copyFile(HOSTS_PATH, path.join(dir, name));
  return { name };
});
handle('hosts:backups', async () => {
  const dir = path.join(app.getPath('userData'), 'hosts-backup');
  try { return (await fsp.readdir(dir)).map(n => path.join(dir, n)).reverse(); } catch (err) { return []; }
});
handle('hosts:restore', async (e, backupPath) => {
  await fsp.copyFile(backupPath, HOSTS_PATH);
  try { await runCmd('ipconfig', ['/flushdns'], { timeout: 10000 }); } catch (err) {}
  return true;
});

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
  rulerWin.loadFile('ruler.html', { query: { dir: horizontal ? 'h' : 'v' } });
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
  const QRCode = require('qrcode');
  await QRCode.toFile(outPath, text, { width: opts.size || 640, margin: opts.margin != null ? opts.margin : 2, errorCorrectionLevel: opts.level || 'M' });
  return { outPath };
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
  const sameDir = findFfmpeg() && path.join(path.dirname(findFfmpeg()), 'ffprobe.exe');
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
    let attempt = 0, got = 0, total = 0, lastEmit = 0;
    const emit = (force) => {
      const now = Date.now();
      if (force || now - lastEmit > 400) {
        lastEmit = now;
        send('job:stream', { id, data: JSON.stringify({ pct: total ? got / total * 100 : 0, mb: got / 1048576, totalMB: total / 1048576, label }) });
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
        const ws = fs.createWriteStream(dest, { flags: got > 0 && r.status === 206 ? 'a' : 'w' });
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
        try { await tryOnce(); emit(true); resolve(); return; }
        catch (err) {
          if (ctrl.signal.aborted || err.message === 'ABORTED') { reject(new Error('下载已取消')); return; }
          attempt++;
          if (attempt >= MAX_RETRY) { reject(new Error('下载失败（已重试 ' + MAX_RETRY + ' 次）：' + err.message)); return; }
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
      for (let k = 1; fs.existsSync(out); k++) out = path.join(outDir, `${base}(${k}).${ext}`);
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
        const ac = opts.acodec || (opts.format === 'webm' ? 'libopus' : opts.format === 'mp3' ? 'libmp3lame' : 'aac');
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
        let lastPct = 0, errOut = '';
        proc.stdout.on('data', (d) => {
          const m = String(d).match(/out_time_us=(\d+)/);
          if (m && dur > 0) {
            lastPct = Math.min(99, parseInt(m[1]) / 1e6 / dur * 100);
            send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: lastPct }) });
          }
        });
        proc.stderr.on('data', (d) => { errOut += String(d); if (errOut.length > 20000) errOut = errOut.slice(-8000); });
        proc.on('exit', (code) => resolve({ code, errOut }));
        proc.on('error', (err) => resolve({ code: -1, errOut: err.message }));
      });
      if (state.cancel) { results.push({ input, out: null, ok: false, err: '已取消' }); break; }
      const ok = r.code === 0 && fs.existsSync(out);
      results.push({ input, out: ok ? out : null, ok, err: ok ? '' : (r.errOut.split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' ') || ('退出码 ' + r.code)) });
      send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok }) });
    }
  } finally { jobs.delete(id); }
  return { results, canceled: state.cancel };
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
      for (let k = 1; fs.existsSync(out); k++) out = path.join(outDir, `${base}_pressed(${k}).mp4`);
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
        let lastPct = 0, errOut = '';
        proc.stdout.on('data', (d) => {
          const m = String(d).match(/out_time_us=(\d+)/);
          if (m && dur > 0) {
            lastPct = Math.min(99, parseInt(m[1]) / 1e6 / dur * 100);
            send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: lastPct }) });
          }
        });
        proc.stderr.on('data', (d) => { errOut += String(d); if (errOut.length > 20000) errOut = errOut.slice(-8000); });
        proc.on('exit', (code) => resolve({ code, errOut }));
        proc.on('error', (err) => resolve({ code: -1, errOut: err.message }));
      });
      if (state.cancel) { results.push({ input, out: null, ok: false, err: '已取消' }); break; }
      const ok = r.code === 0 && fs.existsSync(out);
      let inSize = 0, outSize = 0;
      try { inSize = fs.statSync(input).size; if (ok) outSize = fs.statSync(out).size; } catch (err) {}
      results.push({ input, out: ok ? out : null, ok, inSize, outSize, err: ok ? '' : (r.errOut.split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' ') || ('退出码 ' + r.code)) });
      send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok }) });
    }
  } finally { jobs.delete(id); }
  return { results, canceled: state.cancel };
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
      try {
        await runCmd(soffice, ['--headless', '--norestore', '--convert-to', target, '--outdir', outDir, f], { timeout: 180000 });
        const out = path.join(outDir, path.basename(f).replace(/\.[^.]+$/, '') + '.' + target);
        results.push({ input: f, out: fs.existsSync(out) ? out : null, ok: fs.existsSync(out), err: '' });
      } catch (err) { results.push({ input: f, out: null, ok: false, err: fmtErr(err) }); }
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
    const out = path.join(outDir, base + '.' + target);
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
      const ok = fs.existsSync(out);
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
      let cur = null;
      for (const raw of r.stdout.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        if (/^HKEY_CLASSES_ROOT/i.test(line)) {
          // reg 输出使用全称 HKEY_CLASSES_ROOT\...，而 CTX_ROOTS 里是 HKCR 短名；按全称前缀截取
          const rootFull = key.replace(/^HKCR/i, 'HKEY_CLASSES_ROOT');
          const sub = line.slice(rootFull.length).replace(/^\\/, '');
          if (sub && !sub.includes('\\')) {
            cur = { key, keyPath: line, name: sub, display: '', command: '', disabled: false, hasCommand: false };
            items.push(cur);
          } else if (cur && sub === cur.name + '\\command') cur.hasCommand = true;
          continue;
        }
        const m = line.match(/^\s{4}(.+?)\s{2,4}REG_(\S+)\s*(.*)$/);
        if (!m || !cur) continue;
        const vn = m[1].replace(/^\(默认\)$|^\(Default\)$/i, '');
        const vd = m[3].trim();
        if (vn === '') cur.display = vd;
        else if (vn === 'LegacyDisable') cur.disabled = true;
        else if (vn === 'Command' && !cur.command) cur.command = vd;
      }
      if (cur && cur.hasCommand && !cur.command) {
        const cmdLine = r.stdout.match(new RegExp(escapeRegExp(cur.keyPath + '\\command') + '\\r?\\n\\s{4}(?:\\(默认\\)|\\(Default\\))\\s{2,4}REG_\\S+\\s{1,4}(.*)$', 'i'));
        if (cmdLine) cur.command = cmdLine[1].trim();
      }
    } catch (err) { /* 键不存在或无权限读取 */ }
    groups.push({ key, label, items });
  }
  return groups;
});
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
handle('ctxmenu:toggle', async (e, item, disable) => {
  if (disable) {
    await runCmd('reg', ['add', item.keyPath, '/v', 'LegacyDisable', '/t', 'REG_SZ', '/d', '', '/f'], { timeout: 10000 });
  } else {
    await runCmd('reg', ['delete', item.keyPath, '/v', 'LegacyDisable', '/f'], { timeout: 10000 });
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
  try {
    const r = spawnSync('where', ['es'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    const p = (r.stdout || '').split(/\r?\n/).find(l => l.trim().toLowerCase().endsWith('es.exe'));
    if (p) return p.trim();
  } catch (e) {}
  return null;
}
handle('search:env', async () => {
  const admin = (() => { try { return spawnSync('net', ['session'], { windowsHide: true, timeout: 6000 }).status === 0; } catch (e) { return false; } })();
  const es = findEsExe();
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
      IntPtr h = CreateFileW("\\\\\\\\.\\\\" + driveRoot, 0x80000000u, 1u, IntPtr.Zero, 3u, 0x02000000u, IntPtr.Zero);
      if (h == (IntPtr)(-1)) { Console.Out.WriteLine("E\\t" + Marshal.GetLastWin32Error()); return; }
      byte[] inData = new byte[8];
      GCHandle pin = GCHandle.Alloc(inData, GCHandleType.Pinned);
      byte[] outBuf = new byte[0x10000];
      GCHandle pout = GCHandle.Alloc(outBuf, GCHandleType.Pinned);
      long count = 0; int lastP = 0;
      try {
        while (true) {
          uint ret;
          bool ok = DeviceIoControl(h, 0x900B3u, pin.AddrOfPinnedObject(), 8u, pout.AddrOfPinnedObject(), (uint)outBuf.Length, out ret, IntPtr.Zero);
          if (!ok) { int err = Marshal.GetLastWin32Error(); if (err == 38 || err == 0) break; Console.Out.WriteLine("E\\t" + err); break; }
          if (ret == 0) break;
          if (ret > 8) {
            int off = 8; // 输出前 8 字节是下一次查询的起始 USN
            while (off + 60 <= ret) {
              uint recLen = BitConverter.ToUInt32(outBuf, off);
              if (recLen == 0 || off + (int)recLen > ret) break;
              long frn = BitConverter.ToInt64(outBuf, off + 8);
              long parent = BitConverter.ToInt64(outBuf, off + 16);
              uint attr = BitConverter.ToUInt32(outBuf, off + 52);
              int nameLen = BitConverter.ToUInt16(outBuf, off + 56);
              int nameOff = BitConverter.ToUInt16(outBuf, off + 58);
              if (nameLen > 0 && off + nameOff + nameLen <= ret) {
                string name = Encoding.Unicode.GetString(outBuf, off + nameOff, nameLen);
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
    proc.stdout.on('data', (d) => {
      out += d.toString('utf8');
      let i;
      while ((i = out.indexOf('\n')) >= 0) { const line = out.slice(0, i).replace(/\r$/, ''); out = out.slice(i + 1); handleLine(line); }
    });
    proc.stderr.on('data', (d) => { errOut += d.toString('utf8'); if (errOut.length > 8000) errOut = errOut.slice(-4000); });
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
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
  const es = findEsExe();
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
    try { await walk(root, 0); } catch (err) { sendBatch(); send('job:stream', { id, data: JSON.stringify({ done: true, error: err.message }) }); return; }
    sendBatch();
    send('job:stream', { id, data: JSON.stringify({ done: true, matched, scanned, ms: Date.now() - t0, canceled: cancelRef.canceled }) });
  })();
  return { id };
});

/* ================= lifecycle ================= */
// 测试隔离：HEHE_TEST_DATA 指定独立的 userData 目录（不影响正式数据与单实例锁）
if (process.env.HEHE_TEST_DATA) app.setPath('userData', process.env.HEHE_TEST_DATA);
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  app.on('second-instance', showMainWindow);
  app.whenReady().then(() => {
    loadStore();
    createWindow();
    createTray();
    nativeTheme.themeSource = storeGet('settings.theme', 'system');
    applyHotkey(storeGet('settings.hotkey', 'Alt+Shift+H'));
if (process.env.HEHE_SHOT) {
      setTimeout(async () => {
        try {
          if (win && !win.isDestroyed()) {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(path.join(__dirname, 'diag-shot.png'), img.toPNG());
            console.log('[shot] saved');
          }
        } catch (e) { console.error('[shot] failed:', e.message); }
      }, 8000);
      if (process.env.HEHE_OPEN && win) {
        const ids = process.env.HEHE_OPEN.split(',');
        let i = 0;
        const step = async () => {
          if (i >= ids.length || !win || win.isDestroyed()) return;
          const id = ids[i];
          try {
            if (id === 'theme-toggle') {
              const support = await win.webContents.executeJavaScript(`(() => { document.querySelectorAll('.tb-btn')[0].click(); return typeof document.startViewTransition; })()`);
              console.log('[shot] theme-toggle clicked, startViewTransition:', support);
            } else {
              await win.webContents.executeJavaScript(`window.App.openTool('${id}'); 'ok'`);
            }
            await new Promise(r => setTimeout(r, 2500));
            const img = await win.webContents.capturePage();
            fs.writeFileSync(path.join(__dirname, `shot-${i}-${id}.png`), img.toPNG());
            console.log('[shot]', id, 'saved');
          } catch (e) { console.error('[shot]', id, 'failed:', e.message); }
          i++;
          setTimeout(step, 400);
        };
        setTimeout(step, 5500);
      }
    }
  });
  app.on('before-quit', () => { isQuitting = true; });
  app.on('will-quit', () => { flushStore(); try { globalShortcut.unregisterAll(); } catch (err) {} });
  app.on('window-all-closed', () => { app.quit(); });
}
process.on('uncaughtException', (err) => console.error('uncaught', err));
