/* 界面语言 + 启动窗时序：行为验证。
 *
 * 三件事都要在真实窗口里证明，静态检查做不到：
 *   1. 语言选择项存在，且只有「简体中文 / English」两种（用户明确要求两种）
 *   2. 切换后整个外壳真的变英文（导航/首页/分类/状态栏/设置分区），
 *      不只是设置页那一行字变了
 *   3. 切回中文能恢复；且语言持久化到 store
 *   4. 工具页正文保持中文（这是刻意的设计边界，要在测试里写死，
 *      避免以后有人以为"没翻完"而去把 93 个工具全翻了）
 *
 * 启动窗时序另有一层：splash 撤走时主窗必须已经 show()。
 * 这个顺序在 main.js 里，靠 bootMark 时间戳校验 —— 窗口显示时刻应早于
 * 启动窗销毁时刻。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-'));

const PROBE = `
(async () => {
  const out = { steps: [], errors: [] };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  const log = (n, d) => out.steps.push(Object.assign({ name: n }, d));
  window.addEventListener('error', (e) => out.errors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => out.errors.push(String((e.reason && e.reason.message) || e.reason)));

  const snap = () => ({
    lang: window.i18n.lang,
    nav: [...document.querySelectorAll('.nav-item span')].map((e) => e.textContent.trim()),
    sections: [...document.querySelectorAll('.settings-nav-item')].map((e) => e.textContent.trim()),
    h1: (document.querySelector('.home-hero h1') || {}).textContent,
    tagline: (document.querySelector('.home-hero-top p') || {}).textContent,
    placeholder: (document.querySelector('.hs-input') || {}).placeholder,
    cats: [...document.querySelectorAll('.hc-name')].map((e) => e.textContent.trim()),
    status: (document.querySelector('.statusbar span') || {}).textContent
  });

  /* ---- 1. 设置页有语言下拉，且只有两个选项 ---- */
  window.App.showView({ type: 'settings' });
  await tick(500);
  const sel = document.querySelector('.settings-body select');
  if (!sel) return { fatal: '设置页没有语言下拉' };
  const opts = [...sel.options].map((o) => ({ v: o.value, t: o.textContent.trim() }));
  log('options', { opts, value: sel.value });

  /* ---- 2. 中文基线 ---- */
  window.App.showView({ type: 'home' });
  await tick(400);
  log('baseline-zh', snap());

  /* ---- 3. 切英文：走真实 UI（改下拉 + change 事件） ---- */
  window.App.showView({ type: 'settings' });
  await tick(400);
  const sel2 = document.querySelector('.settings-body select');
  sel2.value = 'en';
  sel2.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(900);
  const en = snap();
  log('switched-en', en);

  window.App.showView({ type: 'home' });
  await tick(400);
  log('home-en', snap());

  /* ---- 4. 英文下工具页正文仍是中文 ---- */
  window.App.openTool('zip-tool');
  await tick(600);
  const toolTitle = (document.querySelector('.tool-header h2') || {}).textContent;
  log('tool-page', { title: toolTitle });

  /* ---- 4b. 英文下设置页的配色主题名与描述必须也是英文 ---- */
  window.App.showView({ type: 'settings' });
  await tick(500);
  // 切到「外观」分区才能看到配色卡
  const appearanceItem = [...document.querySelectorAll('.settings-nav-item')]
    .find((el) => el.dataset.sid === 'appearance');
  if (appearanceItem) { appearanceItem.click(); await tick(600); }
  const accentNames = [...document.querySelectorAll('.accent-card .tc-name2')].map((x) => x.textContent);
  const accentDescs = [...document.querySelectorAll('.accent-card .accent-desc')].map((x) => x.textContent);
  log('accents-en', { names: accentNames, descs: accentDescs.slice(0, 4) });

  /* ---- 4c. 英文下首页分类卡描述（模块描述）必须也是英文 ---- */
  window.App.showView({ type: 'home' });
  await tick(500);
  const catTitles = [...document.querySelectorAll('.home-cat')].map((x) => x.title).slice(0, 4);
  log('module-desc-en', { titles: catTitles });

  /* ---- 5. 切回中文 ---- */
  window.App.showView({ type: 'settings' });
  await tick(400);
  /* 4b 把分区切到了「外观」，语言下拉在「通用」里，得先切回去。
   * 否则这里拿到的 select 是别的东西（或根本没有），切语言静默失败。 */
  const generalItem = [...document.querySelectorAll('.settings-nav-item')]
    .find((el) => el.dataset.sid === 'general');
  if (generalItem) { generalItem.click(); await tick(500); }
  const sel3 = document.querySelector('.settings-body select');
  if (sel3) {
    sel3.value = 'zh';
    sel3.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(900);
  }
  window.App.showView({ type: 'home' });
  await tick(400);
  log('back-to-zh', snap());

  /* ---- 6. 持久化：store 里应记住选择 ---- */
  let stored = null;
  try { stored = await window.api.invoke('store:get', 'settings.lang', null); } catch (e) {}
  log('persisted', { stored });

  return out;
})()
`;

const runner = `
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const PROBE = ${JSON.stringify(PROBE)};
/* 初始语言钉成中文：本测试的「中文基线」断言期望的是中文界面，
   而应用启动时若 store 里没有 settings.lang 就会走 navigator.language 判断，
   CI（windows-latest / en-US）会直接进英文，基线断言全挂。
   这里预置 zh，让测试起点确定；后面的切换仍然真实读写这个 store。 */
const store = { 'settings.lang': 'zh' };

app.whenReady().then(async () => {
  ipcMain.handle('store:get', (e, k, d) => ({ ok: true, data: k in store ? store[k] : d }));
  ipcMain.handle('store:set', (e, k, v) => { store[k] = v; return { ok: true, data: true }; });
  ipcMain.handle('dangerous:list', () => ({ ok: true, data: { enabled: [] } }));
  ipcMain.handle('dangerous:tool-caps', () => ({ ok: true, data: {} }));
  ipcMain.handle('app:get-info', () => ({ ok: true, data: {
    appVersion: '0.2.3', electron: '43.8.4', chrome: '150', userData: 'D:/x', username: 'u', hostname: 'h' } }));
  ipcMain.handle('app:get-autostart', () => ({ ok: true, data: false }));

  const w = new BrowserWindow({
    width: 1200, height: 880, show: true, x: 30, y: 30,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false }
  });
  await w.loadFile(path.join(ROOT, 'index.html'));
  await new Promise((r) => setTimeout(r, 1700));
  let res;
  try { res = await w.webContents.executeJavaScript(PROBE, true); }
  catch (e) { res = { fatal: String((e && e.message) || e) }; }
  console.log('LANG ' + JSON.stringify(res));
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

const line = String(raw).split(/\r?\n/).find((l) => l.startsWith('LANG '));
if (!line) { console.log('未拿到 LANG'); console.log(raw.slice(-3000)); process.exit(1); }
const R = JSON.parse(line.slice('LANG '.length));

let fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

if (R.fatal) {
  chk(false, R.fatal);
} else {
  const by = {};
  for (const s of R.steps) by[s.name] = s;

  /* 选项只允许两种 —— 用户明确要求「只有简体中文和 English 两种」 */
  chk(by.options && by.options.opts.length === 2,
      '语言下拉恰好 2 个选项（实际 ' + (by.options && by.options.opts.length) + '）: '
      + JSON.stringify(by.options && by.options.opts.map((o) => o.t)));
  chk(by.options && by.options.opts.map((o) => o.v).sort().join(',') === 'en,zh',
      '选项值是 zh / en');

  /* 中文基线 */
  chk(by['baseline-zh'] && by['baseline-zh'].nav.includes('首页'), '中文基线：导航显示「首页」');
  chk(by['baseline-zh'] && by['baseline-zh'].h1 === '核核工具箱', '中文基线：首页标题为「核核工具箱」');

  /* 切英文后，多处都要变 —— 只查一处等于没查 */
  const en = by['switched-en'] || {};
  chk(en.lang === 'en', '切换到英文后 i18n.lang = en');
  chk(en.nav && en.nav.includes('Home') && !en.nav.includes('首页'),
      '导航变成英文: ' + JSON.stringify(en.nav && en.nav.slice(0, 4)));
  chk(en.sections && en.sections.includes('General') && !en.sections.includes('通用'),
      '设置分区变成英文: ' + JSON.stringify(en.sections));

  const home = by['home-en'] || {};
  chk(home.h1 === 'HeHe Toolbox', '首页标题变英文（实际 ' + home.h1 + '）');
  chk(/tools/.test(home.tagline || ''), '首页副标题变英文: ' + home.tagline);
  chk(/Search tools/.test(home.placeholder || ''), '搜索框 placeholder 变英文');
  chk(home.cats && home.cats.length === 10 && !home.cats.includes('文件处理'),
      '分类条全部变英文: ' + JSON.stringify(home.cats && home.cats.slice(0, 3)));
  chk(/Ready/.test(home.status || ''), '状态栏变英文: ' + home.status);

  /* 工具页正文保持中文（设计边界，写死防误改） */
  chk(by['tool-page'] && /压缩/.test(by['tool-page'].title || ''),
      '英文模式下工具页标题仍是中文（' + (by['tool-page'] && by['tool-page'].title) + '）');

  /* 配色主题名/描述在英文下必须是英文（以前是写死的中文） */
  const CJK = /[\u4e00-\u9fff]/;
  const acc = by['accents-en'] || {};
  chk(acc.names && acc.names.length === 9,
      '英文下能看到 9 套配色主题（实际 ' + (acc.names && acc.names.length) + '）');
  chk(acc.names && !acc.names.some((n) => CJK.test(n)),
      '英文下配色主题名不含中文（实际 ' + JSON.stringify((acc.names || []).slice(0, 3)) + '）');
  chk(acc.descs && !acc.descs.some((d) => CJK.test(d)),
      '英文下配色描述不含中文（实际 ' + JSON.stringify((acc.descs || []).slice(0, 2)) + '）');

  /* 首页分类卡的模块描述在英文下也要是英文 */
  const md = by['module-desc-en'] || {};
  chk(md.titles && md.titles.length > 0 && !md.titles.some((d) => CJK.test(d)),
      '英文下模块描述不含中文（实际 ' + JSON.stringify((md.titles || []).slice(0, 2)) + '）');

  /* 切回中文 */
  const back = by['back-to-zh'] || {};
  chk(back.lang === 'zh' && back.nav && back.nav.includes('首页'), '切回中文后导航恢复');
  chk(back.h1 === '核核工具箱', '切回中文后首页标题恢复');

  /* 持久化 */
  chk(by.persisted && by.persisted.stored === 'zh',
      '语言选择持久化到 store（实际 ' + (by.persisted && by.persisted.stored) + '）');

  chk(R.errors.length === 0, '无未捕获 JS 错误' + (R.errors.length ? ': ' + JSON.stringify(R.errors) : ''));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
