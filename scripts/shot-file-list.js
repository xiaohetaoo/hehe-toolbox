/* 视觉验证：给「待处理文件列表」截图，确认排版没崩、能被人工一眼看清。
 *
 * 这个脚本不追求自动化断言（排版好坏本来就该人看），它只做三件事：
 * 1. 用真 Electron 打开一个工具页，往列表灌入若干文件；
 * 2. 把窗口截成 PNG；
 * 3. 打印几个关键布局数字（行高、列宽），供快速判断「有没有塌成一坨」。
 * 输出到 D:/zcode/hehe/.shots/（已 gitignore）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(ROOT, '.shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));

const { makeWhiteImage, writeNoisePng } = require('./e2e-helpers');
const files = [];
for (let i = 1; i <= 5; i++) {
  const p = path.join(tmp, `照片${i}.png`);
  if (i === 4) writeNoisePng(p, 400, 300);
  else makeWhiteImage(p, 300 + i * 40, 200 + i * 20);
  files.push(p);
}
const bigTxt = path.join(tmp, '很长的文件名示例_2024年度总结报告最终版修订稿.docx');
fs.writeFileSync(bigTxt, 'x'.repeat(300), 'utf8');
files.push(bigTxt);

const PROBE = `
(async () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  // 打开「目标体积压缩」：它的列表带状态标签/进度条，最能暴露排版问题
  window.App.openTool('target-size');
  await tick(300);
  const pickerEl = document.querySelector('.picker');
  if (!pickerEl) return { fatal: '页面上没有 .picker' };
  const picker = pickerEl.__picker;
  picker.add(window.__FILES);
  await tick(500);

  // 测量：行高、各列是否在同一行内、是否溢出容器
  const rows = [...document.querySelectorAll('.file-list .fl-row')];
  const box = document.querySelector('.file-list');
  const head = document.querySelector('.file-list .fl-header, .file-list .fl-head');
  const info = {
    rowCount: rows.length,
    rowHeights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
    rowOverflows: rows.map((r) => r.scrollWidth > r.clientWidth + 1),
    listWidth: Math.round(box ? box.getBoundingClientRect().width : 0),
    dropzoneCompact: !!document.querySelector('.dropzone.compact'),
    dropzoneHeight: Math.round((document.querySelector('.dropzone') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height),
    headText: head ? head.textContent.trim() : '',
    delButtons: document.querySelectorAll('.file-list .fl-del').length,
    fillWidths: [...document.querySelectorAll('.file-list .progress-fill')].map((e) => { const st = getComputedStyle(e); return { w: st.width, pct: (e.style.width || '(none)') }; }),
    fillBox: [...document.querySelectorAll('.file-list .progress-fill')].map((e) => Math.round(e.getBoundingClientRect().width)),
    sizes: [...document.querySelectorAll('.file-list .fl-size')].map((e) => e.textContent.trim())
  };
  return info;
})()
`;

const runner = [
  "const { app, BrowserWindow, ipcMain } = require('electron');",
  "const path = require('path');",
  "const fs = require('fs');",
  'const ROOT = ' + JSON.stringify(ROOT) + ';',
  'const FILES = ' + JSON.stringify(files) + ';',
  'const PROBE = ' + JSON.stringify(PROBE) + ';',
  'app.whenReady().then(async () => {',
  "  ipcMain.handle('store:get', (e, k, d) => ({ ok: true, data: d }));",
  "  ipcMain.handle('store:set', () => ({ ok: true, data: true }));",
  "  ipcMain.handle('fs:stat', async (e, p) => {",
  "    try { const st = fs.statSync(p); return { ok: true, data: { size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() } }; }",
  "    catch (err) { return { ok: false, error: err.message }; }",
  '  });',
  "  const w = new BrowserWindow({ width: 1040, height: 760, show: true, x: 40, y: 40,",
  "    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });",
  "  await w.loadFile(path.join(ROOT, 'index.html'));",
  '  await new Promise(r => setTimeout(r, 1600));',
  '  await w.webContents.executeJavaScript("window.__FILES = " + JSON.stringify(FILES) + "; true").catch(() => {});',
  '  let info;',
  '  try { info = await w.webContents.executeJavaScript(PROBE, true); }',
  "  catch (e) { info = { fatal: String(e && e.message || e) }; }",
  '  await new Promise(r => setTimeout(r, 800));',
  '  console.log("SHOT dir = " + ' + JSON.stringify(SHOT_DIR) + ');',
  '  try {',
  '    fs.mkdirSync(' + JSON.stringify(SHOT_DIR) + ', { recursive: true });',
  '    const img = await w.webContents.capturePage();',
  "    fs.writeFileSync(" + JSON.stringify(path.join(SHOT_DIR, 'file-list.png')) + ", img.toPNG());",
  "    console.log('SHOT saved');",
  '  } catch (e) { console.log("SHOT failed " + (e && e.stack || e)); }',
  "  console.log('SHOT_INFO ' + JSON.stringify(info));",
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
  raw = execFileSync(ELECTRON_EXE, [scriptPath], { env, encoding: 'utf8', timeout: 180000 });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

const line = String(raw).split(/\r?\n/).find((l) => l.startsWith('SHOT_INFO'));
if (!line) { console.log('没拿到 SHOT_INFO'); console.log(raw.slice(-2000)); process.exit(1); }
const info = JSON.parse(line.slice('SHOT_INFO '.length));
console.log(JSON.stringify(info, null, 2));

let fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };
if (!info.fatal) {
  chk(info.rowCount === 6, '6 个文件渲染 6 行（实际 ' + info.rowCount + '）');
  chk(info.delButtons === 6, '每行一个删除按钮（实际 ' + info.delButtons + '）');
  chk(info.rowHeights.every((h) => h >= 28 && h <= 64), '行高在合理区间: ' + JSON.stringify(info.rowHeights));
  chk(!info.rowOverflows.some(Boolean), '没有行横向溢出: ' + JSON.stringify(info.rowOverflows));
  chk(info.dropzoneCompact, '有内容后拖拽区收窄');
  chk(info.dropzoneHeight <= 80, '拖拽区高度已收缩（' + info.dropzoneHeight + 'px）');
  chk(/共 6 项/.test(info.headText), '表头显示总数: ' + info.headText);
  // 回归：进度条默认宽度必须是 0，否则「没开始」的行会显示成实心满格
  chk(info.fillWidths && info.fillWidths.every((f) => f.w === '0px'),
      '未处理行的进度条宽度为 0（不是默认撑满）: ' + JSON.stringify(info.fillWidths));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? '视觉检查通过，截图见 .shots/file-list.png' : fail + ' 项异常'));
process.exit(fail === 0 ? 0 : 1);
