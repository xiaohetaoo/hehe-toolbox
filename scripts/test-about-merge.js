/* 验证「关于」已并入设置页，且原独立页面确实消失。
 *
 * 【为什么需要】
 * 合并页面最容易出的错不是「新分区渲染不出来」，而是**只删了一半**：
 * 侧栏入口删了、路由还留着；路由删了、面包屑还指向不存在的页面；
 * 或者反过来，侧栏还挂着「关于」但点进去什么都没有。
 * 这些在静态检查里都看不出来，必须在真实窗口里逐个点。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'about-merge-'));

const PROBE = `
(async () => {
  const out = { steps: [], errors: [] };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  const log = (n, d) => out.steps.push(Object.assign({ name: n }, d));
  window.addEventListener('error', (e) => out.errors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => out.errors.push(String((e.reason && e.reason.message) || e.reason)));

  /* ---- 1. 侧栏不应再有「关于」一级入口 ---- */
  const navTexts = [...document.querySelectorAll('.nav-item')].map((e) => e.textContent.trim());
  log('sidebar', { texts: navTexts, hasAbout: navTexts.some((t) => t === '关于') });

  /* ---- 2. 设置页应出现「关于」分区 ---- */
  window.App.showView({ type: 'settings' });
  await tick(450);
  const secTexts = [...document.querySelectorAll('.settings-nav-item')].map((e) => e.textContent.trim());
  log('sections', { texts: secTexts, hasAbout: secTexts.some((t) => t.includes('关于')) });

  /* ---- 3. 点开分区，内容齐全（版本号 / 运行环境 / 检查更新）---- */
  const aboutNav = [...document.querySelectorAll('.settings-nav-item')].find((e) => e.textContent.includes('关于'));
  if (aboutNav) aboutNav.click();
  await tick(600);
  const bodyText = (document.querySelector('.settings-body') || {}).textContent || '';
  log('content', {
    hasName: !!document.querySelector('.about-name'),
    hasVersion: /v\\d+\\.\\d+\\.\\d+/.test(bodyText),
    hasElectron: /Electron/.test(bodyText),
    hasCheckBtn: !![...document.querySelectorAll('.settings-body button')].some((b) => (b.textContent || '').includes('检查更新')),
    text: bodyText.slice(0, 100)
  });

  /* ---- 4. 「检查更新」按钮要贴在右边（不能因为类名丢失而挤在标题旁）---- */
  const btn = [...document.querySelectorAll('.settings-body button')].find((b) => (b.textContent || '').includes('检查更新'));
  const bodyEl = document.querySelector('.settings-body');
  if (btn && bodyEl) {
    const br = btn.getBoundingClientRect();
    const pr = bodyEl.getBoundingClientRect();
    /* 无头/未激活窗口里，窗口没有被真正绘制时布局可能全是 0：
       此时 right 差值为 0，会伪装成「完美对齐」通过，
       或者在被最小化时给出异常大值造成误报。
       把「盒子尺寸有效」作为前提，无效就标记 unavailable，
       由下面断言跳过而不是判失败。 */
    const valid = pr.width > 0 && pr.height > 0 && br.width > 0;
    log('btn-align', {
      gap: Math.round(pr.right - br.right),
      aligned: valid ? (pr.right - br.right) < 60 : null,
      unavailable: !valid,
      box: { bodyW: Math.round(pr.width), bodyH: Math.round(pr.height), btnW: Math.round(br.width) }
    });
  }

  /* ---- 5. 旧路由 'about' 仍能渲染（不能白屏），且落到设置的关于分区 ---- */
  window.App.showView({ type: 'about' });
  await tick(500);
  const bodyAfter = (document.querySelector('.settings-body') || {}).textContent || '';
  log('legacy-route', {
    rendered: bodyAfter.length > 0,
    showsAbout: /Electron|HeHe Toolbox/.test(bodyAfter),
    isSettings: !!document.querySelector('.settings-wrap')
  });

  /* ---- 6. 侧栏「设置」高亮（不是空高亮）---- */
  const activeNav = [...document.querySelectorAll('.nav-item.active')].map((e) => e.textContent.trim());
  log('nav-active', { active: activeNav });

  /* ---- 7. 面包屑 ---- */
  const bc = document.querySelector('.breadcrumb');
  log('breadcrumb', { text: bc ? bc.textContent.trim() : null });

  return out;
})()
`;

const runner = `
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const PROBE = ${JSON.stringify(PROBE)};

app.whenReady().then(async () => {
  /* 语言必须显式钉成中文。
     store:get 拿着返回默认值（这里是 null），应用启动时会走
    i18n.detect() 按 navigator.language 猜 —— CI 是 windows-latest、
    系统语言 en-US，于是整个界面变成英文，而本测试断言的都是中文字串
    （「关于」「检查更新」「设置」），全部匹配不上直接失败。
    本地是中文环境所以一直绿，这类「只在 CI 挂」的问题极难靠猜排查。 */
  ipcMain.handle('store:get', (e, k, d) => {
    if (k === 'settings.lang') return { ok: true, data: 'zh' };
    return { ok: true, data: d };
  });
  ipcMain.handle('store:set', () => ({ ok: true, data: true }));
  ipcMain.handle('dangerous:list', () => ({ ok: true, data: { enabled: [] } }));
  ipcMain.handle('dangerous:tool-caps', () => ({ ok: true, data: {} }));
  ipcMain.handle('app:get-info', () => ({ ok: true, data: {
    appVersion: '0.2.1', electron: '43.8.4', chrome: '150.0.0.0',
    userData: 'D:/tmp/ud', username: 'tester', hostname: 'host'
  } }));
  ipcMain.handle('app:get-autostart', () => ({ ok: true, data: false }));
  ipcMain.handle('update:cleanup', () => ({ ok: true, data: { removed: 0 } }));
  ipcMain.handle('update:check', () => ({ ok: true, data: { hasUpdate: false, current: '0.2.1', latest: '0.2.1' } }));

  const w = new BrowserWindow({
    width: 1200, height: 880, show: true, x: 30, y: 30,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false }
  });
  await w.loadFile(path.join(ROOT, 'index.html'));
  await new Promise((r) => setTimeout(r, 1600));
  let res;
  try { res = await w.webContents.executeJavaScript(PROBE, true); }
  catch (e) { res = { fatal: String((e && e.message) || e) }; }
  console.log('AB ' + JSON.stringify(res));
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

const line = String(raw).split(/\r?\n/).find((l) => l.startsWith('AB '));
if (!line) { console.log('未拿到 AB'); console.log(raw.slice(-2500)); process.exit(1); }
const R = JSON.parse(line.slice('AB '.length));

let fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

if (R.fatal) {
  chk(false, R.fatal);
} else {
  const by = {};
  for (const s of R.steps) by[s.name] = s;

  chk(by.sidebar && by.sidebar.hasAbout === false,
      '侧栏不再有「关于」一级入口');
  chk(by.sidebar && by.sidebar.texts.includes('设置'),
      '侧栏仍有「设置」入口');

  chk(by.sections && by.sections.hasAbout,
      '设置页出现「关于」分区: ' + JSON.stringify(by.sections && by.sections.texts));

  chk(by.content && by.content.hasName && by.content.hasVersion,
      '关于分区显示名称与版本号');
  chk(by.content && by.content.hasElectron,
      '关于分区显示运行环境（Electron）');
  chk(by.content && by.content.hasCheckBtn,
      '关于分区保留「检查更新」按钮（仍是唯一更新入口）');

  /* 布局类断言：无头环境拿不到有效盒子尺寸时跳过，不算失败。
     否则 CI 会因为「测量不到」被判成「功能坏了」——
     这两件事完全不同，不该用同一个红灯。 */
  const ba = by['btn-align'];
  if (!ba) {
    chk(false, '「检查更新」按钮或设置面板没找到');
  } else if (ba.unavailable) {
    console.log('SKIP  「检查更新」按钮对齐（无头环境布局不可测：' + JSON.stringify(ba.box) + '）');
  } else {
    chk(ba.aligned,
        '「检查更新」按钮右对齐（距右边缘 ' + ba.gap + 'px）');
  }

  chk(by['legacy-route'] && by['legacy-route'].rendered && by['legacy-route'].isSettings,
      '旧 about 路由仍能渲染，且落到设置页（不白屏）');
  chk(by['legacy-route'] && by['legacy-route'].showsAbout,
      '旧 about 路由显示的是关于内容');

  chk(by['nav-active'] && by['nav-active'].active.includes('设置'),
      '显示关于时侧栏「设置」仍高亮（不是空高亮）: '
      + JSON.stringify(by['nav-active'] && by['nav-active'].active));

  chk(by.breadcrumb && /设置/.test(by.breadcrumb.text || ''),
      '面包屑含「设置」: ' + (by.breadcrumb && by.breadcrumb.text));

  chk(R.errors.length === 0, '无未捕获 JS 错误' + (R.errors.length ? ': ' + JSON.stringify(R.errors) : ''));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
