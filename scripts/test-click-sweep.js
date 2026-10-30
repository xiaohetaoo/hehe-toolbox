/* 点击下发验证：列表里放好文件后点「开始」，不允许抛出 ReferenceError/TypeError。
 *
 * 【为什么需要这一层】
 * picker-sweep 只验证「列表渲染出来了」。而 office.js 里曾残留
 * `items: [...files]` —— `files` 这个变量早已随重构删除。
 * 列表显示完全正常，一点「开始转换」就抛 ReferenceError。
 * 这类「渲染正常、交互即崩」的残留引用，只能靠真的点按钮才能抓到。
 *
 * 做法：在隐藏以外的真实窗口里加载 index.html，用最小 IPC 桩喂数据，
 * 点主操作按钮，监听 renderer 的 error / unhandledrejection，
 * 只要出现 ReferenceError / is not defined / TypeError 就判失败。
 * 外部引擎（LibreOffice / ffmpeg）缺失属预期，归为 soft 噪声不计失败。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'click-sweep-'));
const outDir = path.join(tmp, 'out');
fs.mkdirSync(outDir, { recursive: true });

const { writeNoisePng } = require('./e2e-helpers');
const IMG = path.join(tmp, 'p1.png');
const TXT = path.join(tmp, 'doc1.txt');
writeNoisePng(IMG, 320, 240);
fs.writeFileSync(TXT, 'hello', 'utf8');

const CASES = [
  { id: 'pdf-office-convert', files: 'txt', btn: '开始转换' },
  { id: 'img-compress', files: 'img', btn: '开始压缩' },
  { id: 'target-size', files: 'img', btn: '开始压缩' },
  { id: 'pdf-tools', files: 'txt', btn: '合并为一个 PDF' },
  { id: 'img2pdf', files: 'img', btn: '转换为 PDF' },
  { id: 'hash-tool', files: 'txt', btn: null },
  { id: 'zip-tool', files: 'txt', btn: '压缩' },
  { id: 'batch-rename', files: 'txt', btn: '执行重命名' },
  // ⑤ 重入防护：这些工具双击「开始」不应并发跑第二遍
  { id: 'img-batch', files: 'img', btn: '开始处理', dbl: true },
  { id: 'img-watermark', files: 'img', btn: '添加水印', dbl: true },
  { id: 'file-crypt', files: 'txt', btn: '开始加密', dbl: true },
  { id: 'audio-cut', files: 'txt', btn: '开始剪辑', dbl: true },
  { id: 'pdf-office-convert', files: 'txt', btn: '开始转换', dbl: true }
];

const PROBE = `
(async () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  const errs = [];
  window.addEventListener('error', (e) => errs.push('error: ' + (e.message || e)));
  window.addEventListener('unhandledrejection', (e) => errs.push('reject: ' + ((e.reason && e.reason.message) || e.reason)));
  const out = [];
  for (const c of window.__CASES) {
    const rec = { id: c.id };
    const before = errs.length;
    try {
      window.App.openTool(c.id);
      await tick(250);
      const pe = document.querySelector('.picker');
      const picker = pe && pe.__picker;
      if (!picker) {
        rec.err = 'no picker (pickerEl=' + !!pe + ', errs=' + JSON.stringify(errs.slice(-3)) + ')';
        out.push(rec);
        continue;
      }
      picker.add(c.files === 'img' ? window.__IMG : window.__TXT);
      await tick(150);
      rec.added = picker.count;
      if (c.btn) {
        const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes(c.btn));
        if (!b) { rec.err = 'button not found: ' + c.btn; }
        else {
          rec.clicked = true;
          if (c.dbl) {
            // 双击：立刻连点两次，第二次应被 running 守卫挡下
            b.click(); b.click();
            rec.dblClicked = true;
          } else {
            b.click();
          }
          await tick(600);
        }
      }
    } catch (e) { rec.err = String((e && e.message) || e); }
    await tick(200);
    const news = errs.slice(before);
    // 工具的 run() 内部有 try/catch，ReferenceError 会被吞进界面上的错误文本，
    // 不会冒泡到 window.onerror —— 必须自己扫页面上的错误文案。
    const errText = [...document.querySelectorAll('.status-err, .field-err, .field-err *')]
      .map((e) => e.textContent || '').join(' | ');
    rec.hard = news.filter((m) => /ReferenceError|is not defined|TypeError/.test(m));
    if (/is not defined|ReferenceError|Cannot read propert|undefined is not/i.test(errText)) {
      rec.hard.push('界面错误文本: ' + errText.trim().slice(0, 160));
    }
    out.push(rec);
  }
  return out;
})()
`;

const runner = `
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const CASES = ${JSON.stringify(CASES)};
const IMG = ${JSON.stringify(IMG)};
const TXT = ${JSON.stringify(TXT)};
const PROBE = ${JSON.stringify(PROBE)};

app.whenReady().then(async () => {
  // 只补「文件列表 + 页面初始化」必需的通道。
  // 早期版本这里给几十个通道都挂了返回 {} 的桩，结果把 app 自己的初始化流程
  // 搞坏 —— openTool 静默失败、页面根本没切过去，测试从头到尾看不到 picker。
  // 缺失的通道只会产生 soft 噪声，不影响我们要抓的硬错误。
  ipcMain.handle('store:get', (e, k, d) => ({ ok: true, data: d }));
  ipcMain.handle('store:set', () => ({ ok: true, data: true }));
  ipcMain.handle('store:remove', () => ({ ok: true, data: true }));
  ipcMain.handle('fs:stat', (e, p) => {
    try {
      const st = fs.statSync(p);
      return { ok: true, data: { size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() } };
    } catch (err) { return { ok: false, error: String(err.message) }; }
  });
  ipcMain.handle('fs:list', (e, p) => {
    try {
      return { ok: true, data: fs.readdirSync(p).map((x) => {
        const fp = path.join(p, x);
        const st = fs.statSync(fp);
        return { name: x, size: st.size, isDir: st.isDirectory(), path: fp };
      }) };
    } catch (err) { return { ok: false, error: String(err.message) }; }
  });
  ipcMain.handle('fs:mkdir', (e, p) => {
    try { fs.mkdirSync(p, { recursive: true }); return { ok: true, data: true }; }
    catch (err) { return { ok: false, error: String(err.message) }; }
  });
  ipcMain.handle('fs:read-file-b64', (e, p) => {
    try { return { ok: true, data: { b64: fs.readFileSync(p).toString('base64') } }; }
    catch (err) { return { ok: false, error: String(err.message) }; }
  });
  ipcMain.handle('fs:unique-path', (e, p) => ({ ok: true, data: p }));
  ipcMain.handle('dialog:open', () => ({ ok: true, data: null }));
  ipcMain.handle('dialog:save', () => ({ ok: true, data: null }));
  ipcMain.handle('office:status', () => ({ ok: true, data: { soffice: '/x', office: false } }));
  ipcMain.handle('office:convert', (e, o) => ({
    ok: true,
    data: {
      engine: 'stub',
      results: ((o && o.files) || []).map((f) => ({ ok: true, input: f, out: f + '.pdf' }))
    }
  }));

  const w = new BrowserWindow({
    width: 1150, height: 860, show: true, x: 30, y: 30,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false }
  });
  await w.loadFile(path.join(ROOT, 'index.html'));
  await new Promise((r) => setTimeout(r, 1600));
  await w.webContents.executeJavaScript(
    'window.__CASES = ' + JSON.stringify(CASES) +
    '; window.__IMG = ' + JSON.stringify(IMG) +
    '; window.__TXT = ' + JSON.stringify(TXT) + '; true'
  ).catch(() => {});
  let res;
  try { res = await w.webContents.executeJavaScript(PROBE, true); }
  catch (e) { res = { fatal: String((e && e.message) || e) }; }
  console.log('CLICK ' + JSON.stringify(res));
  app.exit(0);
});
`;

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

const line = String(raw).split(/\r?\n/).find((l) => l.startsWith('CLICK '));
if (!line) { console.log('未拿到 CLICK'); console.log(raw.slice(-2500)); process.exit(1); }
const R = JSON.parse(line.slice('CLICK '.length));

let fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

if (!Array.isArray(R)) {
  chk(false, '探针未返回数组: ' + JSON.stringify(R).slice(0, 200));
} else {
  for (const r of R) {
    if (r.err) { chk(false, r.id + ' -> ' + r.err); continue; }
    if (r.hard && r.hard.length) { chk(false, r.id + ' 点按钮触发硬错误: ' + JSON.stringify(r.hard)); }
    else chk(true, r.id + ' 放 ' + r.added + ' 个文件、' + (r.clicked ? '点「开始」后' : '自动计算后') + '无 ReferenceError/TypeError');
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
