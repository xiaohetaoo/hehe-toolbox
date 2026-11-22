
/* 【把 TEMP/TMP 指向工作区】本机安全软件拦 Chromium 子进程写 %TEMP%
 * （EPERM），而本脚本要把探针与结果落盘。工作区不在拦截名单里。
 * 详见 scripts/lib/electron-launch.js。进程退出时删除。 */
(function () {
  if (process.env.HEHE_TEST_TMP_READY) return;
  var p = require('path'), f = require('fs');
  var d = p.join(p.resolve(__dirname, '..'), '.tmp-testrun-' + process.pid);
  try {
    f.mkdirSync(d, { recursive: true });
    process.env.TEMP = d; process.env.TMP = d;
    process.env.HEHE_TEST_TMP_READY = '1';
    process.on('exit', function () { try { f.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  } catch (e) { /* 建不了就让失败如实暴露 */ }
})();
/* 逐个打开所有「有文件输入」的工具，确认新的待处理列表真的渲染出来了。
 *
 * 冒烟只检查「页面不抛异常」，一个把工具页骨架都渲染出来、但 picker
 * 因为变量顺序问题根本没挂进 DOM 的情况，冒烟是发现不了的。
 * 这里对每个工具断言：.picker 存在、空状态文案在、拖拽区在。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
/* 【Chromium 兼容参数 —— 见 scripts/lib/electron-launch.js 的实测根因】
 * 本机 Chromium 进程级沙箱起不来：不带 --no-sandbox 时 electron.exe 直接以
 * 0x80000003 崩掉，stdout/stderr 全空，测试只能报「没拿到渲染层结果」。
 * --disable-gpu/--disable-dev-shm-usage 同理（远程会话的 GPU 进程、受限的 /dev/shm）。
 * 这些参数只影响测试探针，不影响产品打包后的启动参数。 */
const CHROMIUM_FLAGS = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];

/* 【把子进程的 TEMP/TMP 与 --user-data-dir 切到工作区内】
 * 本机 Chromium 子进程写 %TEMP% 会被安全软件拦（EPERM），而探针都要把结果
 * 落盘再读，于是全部卡在"写不了结果文件"。工作区不在拦截名单里。
 * 详见 scripts/lib/electron-launch.js。用完即删。 */
let __scratchDir = null;
function __ensureScratch(env) {
  if (!__scratchDir) {
    __scratchDir = path.join(path.resolve(__dirname, '..'), '.tmp-e2e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    try { require('fs').mkdirSync(__scratchDir, { recursive: true }); } catch (e) {}
    process.on('exit', () => { try { require('fs').rmSync(__scratchDir, { recursive: true, force: true }); } catch (e) {} });
  }
  env.TEMP = __scratchDir;
  env.TMP = __scratchDir;
  return ['--user-data-dir=' + path.join(__scratchDir, 'udd')];
}

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-sweep-'));

/* 这些工具是「先攒文件再处理」的，改版后必须出现 .picker */
const TOOLS = [
  'img-batch', 'img-watermark', 'img-stitch', 'img-compress', 'target-size',
  'av-convert', 'video-press', 'video-frames', 'audio-cut', 'av-info',
  'exif-view', 'screenshot-ocr', 'pdf-tools', 'img2pdf', 'pdf2img',
  'doc-preview', 'pdf-office-convert',
  'batch-rename', 'file-crypt', 'file-split', 'zip-tool', 'archive-7z',
  'hash-tool', 'qr-scan'
];

const PROBE = `
(async () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  const out = [];
  for (const id of window.__TOOLS) {
    const rec = { id };
    try {
      window.App.openTool(id);
      await tick(120);
      const picker = document.querySelector('.picker');
      rec.ok = !!picker;
      rec.hasDropzone = !!document.querySelector('.dropzone');
      rec.hasList = !!document.querySelector('.file-list');
      rec.emptyText = (document.querySelector('.file-list .fl-empty') || {}).textContent || '';
      rec.dzMain = (document.querySelector('.dropzone .dz-main') || {}).textContent || '';
      // 空列表时不应有数据行，也不该把删除按钮露出来
      rec.rows = document.querySelectorAll('.file-list .fl-row').length;
    } catch (e) {
      rec.ok = false;
      rec.err = String(e && e.message || e);
    }
    out.push(rec);
  }
  return out;
})()
`;

const runner = [
  "const { app, BrowserWindow, ipcMain } = require('electron');",
  "const path = require('path');",
  'const ROOT = ' + JSON.stringify(ROOT) + ';',
  'const TOOLS = ' + JSON.stringify(TOOLS) + ';',
  'const PROBE = ' + JSON.stringify(PROBE) + ';',
  'app.whenReady().then(async () => {',
  "  ipcMain.handle('store:get', (e, k, d) => ({ ok: true, data: d }));",
  "  ipcMain.handle('fs:stat', () => ({ ok: true, data: { size: 1, mtime: 0, isDir: false } }));",
  "  const w = new BrowserWindow({ width: 1100, height: 800, show: true, x: 40, y: 40,",
  "    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });",
  "  await w.loadFile(path.join(ROOT, 'index.html'));",
  '  await new Promise(r => setTimeout(r, 1500));',
  '  await w.webContents.executeJavaScript("window.__TOOLS = " + JSON.stringify(TOOLS) + "; true").catch(() => {});',
  '  let res;',
  '  try { res = await w.webContents.executeJavaScript(PROBE, true); }',
  "  catch (e) { res = { fatal: String(e && e.message || e) }; }",
  "  console.log('SWEEP ' + JSON.stringify(res));",
  '  app.exit(0);',
  '});'
].join('\n');

const scriptPath = path.join(tmp, 'run.js');
fs.writeFileSync(scriptPath, runner, 'utf8');

const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON_EXE)) { console.log('SKIP 无 electron.exe'); process.exit(0); }

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');
env.HEHE_NOSPLASH = '1';

let raw = '';
try {
  raw = execFileSync(ELECTRON_EXE, [...CHROMIUM_FLAGS, ...__ensureScratch(env), scriptPath], { env, encoding: 'utf8', timeout: 180000 });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

const line = String(raw).split(/\r?\n/).find((l) => l.startsWith('SWEEP '));
if (!line) { console.log('未拿到 SWEEP'); console.log(raw.slice(-2000)); process.exit(1); }
const rows = JSON.parse(line.slice('SWEEP '.length));

let fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

for (const r of rows) {
  if (!r.ok) {
    chk(false, r.id + ' 没有渲染出 .picker' + (r.err ? ' -> ' + r.err : ''));
    continue;
  }
  const bad = [];
  if (!r.hasDropzone) bad.push('无拖拽区');
  if (!r.hasList) bad.push('无列表');
  if (!r.emptyText) bad.push('空状态文案缺失');
  if (r.rows !== 0) bad.push('空列表却有 ' + r.rows + ' 行');
  chk(bad.length === 0, r.id + ' 列表就绪（' + r.dzMain.slice(0, 22) + '…）' + (bad.length ? ' [' + bad.join('、') + ']' : ''));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n结果: ' + rows.length + ' 个工具，' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
