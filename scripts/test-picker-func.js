/* 功能验证：改版后「选了文件 → 点开始 → 真的产出结果」这条链路还通。
 *
 * 列表组件是新的，工具里的处理逻辑被我动过（原来读 `paths` 数组，
 * 现在读 `picker.paths`）。只测「页面能渲染」不足以证明这一点 ——
 * 图片压缩必须真的压出文件、进度必须真的写回那一行。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-func-'));
const outDir = path.join(tmp, 'out');

const { writeNoisePng } = require('./e2e-helpers');
const src1 = path.join(tmp, 'noise1.png');
const src2 = path.join(tmp, 'noise2.png');
writeNoisePng(src1, 700, 500);
writeNoisePng(src2, 600, 400);
const srcSize = fs.statSync(src1).size;

const PROBE = `
(async () => {
  const out = { steps: [] };
  const log = (n, d) => out.steps.push(Object.assign({ name: n }, d));
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  const S = window.__SRC;

  /* ---- 图片压缩：加入 → 开始 → 产出文件，进度写回行 ---- */
  window.App.openTool('img-compress');
  await tick(300);
  const picker = document.querySelector('.picker').__picker;
  if (!picker) return { fatal: '.picker 上没有 __picker' };
  document.querySelector('.picker .dropzone'); // 确认结构

  picker.add(S);
  await tick(250);
  log('added', { count: picker.count, rows: document.querySelectorAll('.file-list .fl-row').length });

  // 输出目录填到临时目录，避免写到源文件旁边
  const outIn = [...document.querySelectorAll('input.input')].find((i) => (i.placeholder || '').includes('输出目录'));
  if (outIn) { outIn.value = window.__OUTDIR; outIn.dispatchEvent(new Event('input', { bubbles: true })); }

  const startBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('开始压缩'));
  if (!startBtn) return { fatal: '找不到「开始压缩」按钮' };

  // 运行中列表应被锁定
  startBtn.click();
  // 锁定是在 run() 第一段同步代码里做的，但 click 到 handler 执行之间
  // 还有一帧；串行跑（整套测试连着跑）时机器更忙，60ms 可能不够 —— 轮询等它生效。
  let lockWait = 0;
  while (lockWait < 4000 && !document.querySelector('.file-list .fl-del').disabled) {
    await tick(50); lockWait += 50;
  }
  log('locked-during', { delDisabled: !!document.querySelector('.file-list .fl-del').disabled });

  // 等压缩跑完（两张几百 KB 的噪声图，几秒足够）
  let waited = 0;
  while (waited < 20000) {
    if (!startBtn.disabled) break;
    await tick(200);
    waited += 200;
  }
  log('finished', { waitedMs: waited, stillBusy: startBtn.disabled });

  const tags = [...document.querySelectorAll('.file-list .tag')].map((t) => t.textContent.trim());
  const sizes = [...document.querySelectorAll('.file-list .comp-size')].map((t) => t.textContent.trim());
  log('rows-after', { tags, sizes, delDisabled: !!document.querySelector('.file-list .fl-del').disabled });

  /* 磁盘上真的产出了文件？ */
  let files = [];
  try {
    const r = await window.api.invoke('fs:list', window.__OUTDIR);
    files = (r || []).map((x) => ({ name: x.name || x, size: x.size }));
  } catch (e) { files = [{ err: String(e && e.message || e) }]; }
  log('disk', { count: files.length, files: files.slice(0, 4) });

  return out;
})()
`;

const runner = [
  "const { app, BrowserWindow, ipcMain } = require('electron');",
  "const path = require('path');",
  "const fs = require('fs');",
  'const ROOT = ' + JSON.stringify(ROOT) + ';',
  'const SRC = ' + JSON.stringify([src1, src2]) + ';',
  'const OUTDIR = ' + JSON.stringify(outDir) + ';',
  'const PROBE = ' + JSON.stringify(PROBE) + ';',
  'app.whenReady().then(async () => {',
  "  ipcMain.handle('store:get', (e, k, d) => ({ ok: true, data: d }));",
  "  ipcMain.handle('fs:stat', async (e, p) => {",
  "    try { const st = fs.statSync(p); return { ok: true, data: { size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() } }; }",
  "    catch (err) { return { ok: false, error: err.message }; }",
  '  });',
  "  ipcMain.handle('fs:list', async (e, p) => {",
  '    const names = fs.readdirSync(p);',
  '    return { ok: true, data: names.map((n) => { const fp = path.join(p, n); const st = fs.statSync(fp); return { name: n, size: st.size, isDir: st.isDirectory(), path: fp }; }) };',
  '  });',
  "  ipcMain.handle('fs:mkdir', async (e, p) => { fs.mkdirSync(p, { recursive: true }); return { ok: true, data: true }; });",
  "  ipcMain.handle('fs:read-file-b64', (e, p) => fs.existsSync(p) ? { ok: true, data: { b64: fs.readFileSync(p).toString('base64') } } : { ok: false, error: 'ENOENT: ' + p });",
  "  ipcMain.handle('fs:write-file-b64', async (e, p, b64) => { fs.writeFileSync(p, Buffer.from(b64, 'base64')); return { ok: true, data: true }; });",
  "  ipcMain.handle('fs:unique-path', (e, p) => {",
  '    let cand = p, i = 1;',
  "    while (fs.existsSync(cand)) { const d = path.dirname(p), b = path.basename(p); const ext = path.extname(b); cand = path.join(d, b.slice(0, b.length - ext.length) + \'(\' + (i++) + \')\' + ext); }",
  '    return { ok: true, data: cand };',
  '  });',
  "  const w = new BrowserWindow({ width: 1100, height: 820, show: true, x: 40, y: 40,",
  "    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });",
  "  await w.loadFile(path.join(ROOT, 'index.html'));",
  '  await new Promise(r => setTimeout(r, 1500));',
  '  await w.webContents.executeJavaScript("window.__SRC = " + JSON.stringify(SRC) + "; window.__OUTDIR = " + JSON.stringify(OUTDIR) + "; true").catch(() => {});',
  "  w.webContents.on('console-message', (ev, lvl, msg) => console.log('CONSOLE[' + lvl + '] ' + msg));",
  '  let res;',
  '  try { res = await w.webContents.executeJavaScript(PROBE, true); }',
  "  catch (e) { res = { fatal: String(e && e.message || e) }; }",
  "  console.log('FUNC ' + JSON.stringify(res));",
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

const line = String(raw).split(/\r?\n/).find((l) => l.startsWith('FUNC '));
if (!line) { console.log('未拿到 FUNC'); console.log(raw.slice(-2500)); process.exit(1); }
const R = JSON.parse(line.slice('FUNC '.length));

let fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

if (R.fatal) { console.log('FAIL  ' + R.fatal); fail++; }
else {
  const by = {};
  for (const s of R.steps) by[s.name] = s;
  chk(by.added && by.added.count === 2 && by.added.rows === 2, '两个图片进入列表并渲染两行');
  chk(by['locked-during'] && by['locked-during'].delDisabled, '压缩过程中列表被锁定（不能删文件）');
  chk(by.finished && !by.finished.stillBusy, '压缩在超时前跑完（' + (by.finished && by.finished.waitedMs) + 'ms）');
  chk(by['rows-after'] && by['rows-after'].tags.every((t) => /完成|-|%/.test(t)),
      '每行状态都被写回（不是一直「待压缩」）: ' + JSON.stringify(by['rows-after'] && by['rows-after'].tags));
  chk(by['rows-after'] && by['rows-after'].sizes.every((s) => /\d/.test(s) && s.includes('→')),
      '每行都显示了压缩前后体积: ' + JSON.stringify(by['rows-after'] && by['rows-after'].sizes));
  chk(by['rows-after'] && !by['rows-after'].delDisabled, '结束后列表解锁');
  chk(by.disk && by.disk.count >= 2, '磁盘上真的产出了输出文件（' + (by.disk && by.disk.count) + ' 个）');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
