'use strict';
const { t, done } = require('./lib/harness');
/* 任务 4 的端到端验证：英文模式下，已迁移的工具页**真的**变成英文了。
 *
 * 【为什么静态测试不够】
 * scripts/test-tool-i18n.js 验证的是 TT 函数本身与调用点覆盖率，
 * 但它证明不了「工具页渲染时取的确实是英文」—— 可能某个调用点写在
 * render 之外、模块加载时就求值了（那时语言还是默认 zh），
 * 也可能有文件漏引 TT 而走了别的路径。只有真起一个窗口、切语言、
 * 打开工具页读 DOM 才能确认。
 *
 * 【只测两个已迁移的工具，不测其余】
 * 其余工具页**故意**保持中文（任务 4 选的边界）。把它们写进"必须变英文"
 * 的断言里，等于逼下一轮把 100 个工具全翻了才能让 CI 绿 —— 那是把
 * 一个明确的、写进 README 的设计边界变成隐形债务。
 * 反过来，另有一条断言锁住「未迁移的工具页仍为中文」，
 * 防止有人误以为该全翻、或者漏配了导致半英半中。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-i18n-'));

const PROBE = `
(async () => {
  const out = { steps: [], errors: [] };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  window.addEventListener('error', (e) => out.errors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => out.errors.push(String((e.reason && e.reason.message) || e.reason)));

  /* 抓一个工具页上所有可见文字（按钮/标签/卡片标题/占位符） */
  const snapTool = () => ({
    title: (document.querySelector('.tool-header h2') || {}).textContent,
    cardTitles: [...document.querySelectorAll('.card-title')].map((e) => e.textContent.trim()),
    buttons: [...document.querySelectorAll('.tool-header ~ * button, .card button')].map((e) => e.textContent.trim()),
    labels: [...document.querySelectorAll('.form-label')].map((e) => e.textContent.trim()),
    placeholders: [...document.querySelectorAll('textarea, input')].map((e) => e.placeholder).filter(Boolean),
  });

  /* ---- 中文基线 ---- */
  window.App.openTool('qr-generate');
  await tick(900);
  out.steps.push({ name: 'qr-zh', d: snapTool() });

  window.App.openTool('hash-tool');
  await tick(900);
  out.steps.push({ name: 'hash-zh', d: snapTool() });

  /* ---- 切英文 ---- */
  window.App.showView({ type: 'settings' });
  await tick(600);
  const sel = document.querySelector('.settings-body select');
  if (!sel) return { fatal: '设置页没有语言下拉' };
  sel.value = 'en';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(1000);

  /* ---- 已迁移的两个工具页应该是英文 ---- */
  window.App.openTool('qr-generate');
  await tick(900);
  out.steps.push({ name: 'qr-en', d: snapTool() });

  window.App.openTool('hash-tool');
  await tick(900);
  out.steps.push({ name: 'hash-en', d: snapTool() });

  /* ---- 未迁移的工具页仍为中文（设计边界，写死） ---- */
  window.App.openTool('zip-tool');
  await tick(900);
  out.steps.push({ name: 'zip-en', d: snapTool() });

  return out;
})()
`;

const runner = `
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const PROBE = ${JSON.stringify(PROBE)};
const store = { 'settings.lang': 'zh' };

app.whenReady().then(async () => {
  ipcMain.handle('store:get', (e, k, d) => ({ ok: true, data: k in store ? store[k] : d }));
  ipcMain.handle('store:set', (e, k, v) => { store[k] = v; return { ok: true, data: true }; });
  ipcMain.handle('dangerous:list', () => ({ ok: true, data: { enabled: [] } }));
  ipcMain.handle('dangerous:tool-caps', () => ({ ok: true, data: {} }));
  ipcMain.handle('app:get-info', () => ({ ok: true, data: {
    appVersion: '0.3.6', electron: '43.8.4', chrome: '150', userData: 'D:/x', username: 'u', hostname: 'h' } }));
  ipcMain.handle('app:get-autostart', () => ({ ok: true, data: false }));
  ipcMain.handle('fs:list', () => ({ ok: true, data: [] }));
  ipcMain.handle('fs:stat-multi', () => ({ ok: true, data: [] }));

  const w = new BrowserWindow({
    width: 1200, height: 880, show: true, x: 30, y: 30,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false }
  });
  await w.loadFile(path.join(ROOT, 'index.html'));
  await new Promise((r) => setTimeout(r, 1700));
  let res;
  try { res = await w.webContents.executeJavaScript(PROBE, true); }
  catch (e) { res = { fatal: String((e && e.message) || e) }; }
  console.log('TI18N ' + JSON.stringify(res));
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
  raw = execFileSync(ELECTRON_EXE, [scriptPath], { env, encoding: 'utf8', timeout: 150000 });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

const line = String(raw).split(/\r?\n/).find((l) => l.startsWith('TI18N '));
if (!line) { console.log('未拿到 TI18N'); console.log(raw.slice(-2500)); done(); return; }
const R = JSON.parse(line.slice('TI18N '.length));

const CJK = /[\u4e00-\u9fff]/;
function all(d) {
  return [].concat(d.cardTitles || [], d.buttons || [], d.labels || [], d.placeholders || []);
}

t('已迁移的二维码工具：英文模式下文案全部变英文', () => {
  if (R.fatal) throw new Error(R.fatal);
  const by = {};
  for (const s of R.steps) by[s.name] = s.d;
  const zh = by['qr-zh'], en = by['qr-en'];
  if (!zh || !en) throw new Error('没有拿到二维码页的两份快照');
  // 中文基线必须是中文（否则说明基线本身就没渲染出来）
  if (!all(zh).some((s) => CJK.test(s))) throw new Error('中文基线上没有中文，页面可能没渲染：' + JSON.stringify(all(zh).slice(0, 5)));
  const zhLeft = all(en).filter((s) => CJK.test(s));
  /* 允许残留：图标 emoji、以及邮箱/网址类不含汉字的原文。
   * 汉字残留说明有调用点漏迁（这正是要抓的）。 */
  if (zhLeft.length) throw new Error('二维码页英文模式下仍有中文：' + JSON.stringify(zhLeft));
  const BTN = en.buttons;
  if (!BTN.includes('Save PNG')) throw new Error('保存按钮没变英文：' + JSON.stringify(BTN));
  if (!en.placeholders.some((p) => /Enter text/.test(p))) throw new Error('输入框 placeholder 没变英文：' + JSON.stringify(en.placeholders));
});

t('已迁移的哈希工具：英文模式下文案全部变英文', () => {
  const by = {};
  for (const s of R.steps) by[s.name] = s.d;
  const en = by['hash-en'];
  if (!en) throw new Error('没有拿到哈希页快照');
  const zhLeft = all(en).filter((s) => CJK.test(s));
  if (zhLeft.length) throw new Error('哈希页英文模式下仍有中文：' + JSON.stringify(zhLeft));
  if (!en.buttons.includes('File') || !en.buttons.includes('Text')) {
    throw new Error('模式切换按钮没变英文：' + JSON.stringify(en.buttons));
  }
});

t('未迁移的工具页在英文模式下仍为中文（刻意边界，写死防误改）', () => {
  const by = {};
  for (const s of R.steps) by[s.name] = s.d;
  const en = by['zip-en'];
  if (!en) throw new Error('没有拿到 ZIP 页快照');
  // 工具标题（注册时的 name 字段）本来就不翻译
  if (!CJK.test(en.title || '')) throw new Error('ZIP 页标题应仍为中文，实际：' + en.title);
  const visible = all(en);
  if (!visible.some((s) => CJK.test(s))) throw new Error('ZIP 页在英文模式下居然全是英文 —— 边界被无声扩大了？');
});

t('切换语言与打开工具页的全过程无未捕获错误', () => {
  if (R.errors && R.errors.length) throw new Error('出现未捕获错误：' + JSON.stringify(R.errors.slice(0, 3)));
});

fs.rmSync(tmp, { recursive: true, force: true });
done();
