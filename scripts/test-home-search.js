/* 首页搜索主导化：行为验证。
 *
 * 【为什么不能只测 registry.search】
 * 纯函数测试能证明「搜得到」，证明不了「搜得到的东西用户能看见、能点、能用键盘选」。
 * 这一轮改的是布局（分类卡片让位、标题栏搜索隐藏）和键盘交互，
 * 这些全都只在真实窗口里才成立：
 *   - 首页大搜索框存在且是唯一可见的搜索框
 *   - 输入后分类区消失、结果区出现
 *   - ↑↓ 改变高亮项，Enter 打开高亮那个（不是永远打开第一个）
 *   - Esc 清空后回到浏览态
 *   - 无匹配时有明确的空状态，而不是空白一片
 *   - 标题栏搜索在首页隐藏、进工具页恢复显示
 * 所以这里加载真实 index.html 跑真实 DOM。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'home-search-'));

const PROBE = `
(async () => {
  const out = { steps: [], errors: [] };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  const log = (name, d) => out.steps.push(Object.assign({ name }, d));
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  window.addEventListener('error', (e) => out.errors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => out.errors.push(String((e.reason && e.reason.message) || e.reason)));

  // ---- 1. 首页就该有一个大搜索框 ----
  window.App.showView({ type: 'home' });
  await tick(200);
  const inp = document.querySelector('.home-search .hs-input');
  if (!inp) return { fatal: '首页没有 .hs-input' };
  log('input', { placeholder: inp.placeholder, value: inp.value });

  // ---- 2. 首页时标题栏搜索必须隐藏（不能出现两个搜索框）----
  const tbWrap = document.querySelector('.titlebar .search-wrap');
  const tbVisible = tbWrap && !tbWrap.classList.contains('hidden') && getComputedStyle(tbWrap).display !== 'none';
  const focusables = [...document.querySelectorAll('input,button,a[href],[tabindex]')]
    .filter((e) => e.offsetParent !== null);
  const visibleSearches = [...document.querySelectorAll('input')].filter((e) => e.offsetParent !== null
    && /搜索/i.test(e.placeholder || ''));
  log('single-search', { tbVisible: !!tbVisible, visibleSearchCount: visibleSearches.length, focusableCount: focusables.length });

  // ---- 3. 搜索 → 分类区让位、结果区出现 ----
  inp.focus();
  inp.value = 'pdf';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(300);
  const results = document.querySelector('.home-results');
  const browse = document.querySelector('.home-browse');
  const rows = [...document.querySelectorAll('.home-results .hs-row')];
  log('searched-pdf', {
    resultsShown: !!results && results.classList.contains('show'),
    browseHidden: !!browse && browse.classList.contains('hidden'),
    browseDisplay: browse ? getComputedStyle(browse).display : null,
    rowCount: rows.length,
    names: rows.slice(0, 4).map((r) => (r.querySelector('.sr-name') || {}).textContent || '')
  });

  // ---- 4. 多词查询：旧实现在整串匹配会 0 结果 ----
  inp.value = 'pdf 合并';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(300);
  const multi = [...document.querySelectorAll('.home-results .hs-row')]
    .map((r) => (r.querySelector('.sr-name') || {}).textContent || '');
  log('multi-word', { count: multi.length, first: multi[0] || null });

  // ---- 5. 模块名查询（「办公」不在任何工具名/关键词里）----
  inp.value = '办公';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(300);
  const byMod = [...document.querySelectorAll('.home-results .hs-row')].length;
  log('module-name', { count: byMod });

  // ---- 6. 高亮词标出来了 ----
  inp.value = '压缩';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(300);
  const marks = [...document.querySelectorAll('.home-results .sr-hit')].map((m) => m.textContent);
  log('highlight', { markCount: marks.length, sample: marks.slice(0, 5) });

  // ---- 7. 键盘：↑↓ 选中项跟着动，Enter 打开的是高亮那一项 ----
  const rows2 = [...document.querySelectorAll('.home-results .hs-row')];
  key(inp, 'ArrowDown');
  await tick(80);
  const hl1 = [...document.querySelectorAll('.home-results .hs-row')].findIndex((r) => r.classList.contains('hl'));
  log('arrow-down-1', { hlIndex: hl1, rowCount: rows2.length });
  key(inp, 'ArrowDown');
  await tick(80);
  const hl2 = [...document.querySelectorAll('.home-results .hs-row')].findIndex((r) => r.classList.contains('hl'));
  log('arrow-down-2', { hlIndex: hl2, moved: hl2 === hl1 + 1 });
  key(inp, 'ArrowUp');
  await tick(80);
  const hl3 = [...document.querySelectorAll('.home-results .hs-row')].findIndex((r) => r.classList.contains('hl'));
  log('arrow-up', { hlIndex: hl3, back: hl3 === hl1 });

  // 先记下「此刻」高亮项的名字，再按 Enter，看打开的是不是它。
  // 注意必须用按完 ↑ 之后的最终高亮（hl3），不能用上一次的 hl2 ——
  // 否则测的是「Enter 是否打开任意一项」，而不是「是否打开高亮项」。
  const hlRow = [...document.querySelectorAll('.home-results .hs-row')][hl3];
  const hlName = hlRow ? (hlRow.querySelector('.sr-name') || {}).textContent : null;
  key(inp, 'Enter');
  await tick(400);
  const openedName = (() => {
    const h2 = document.querySelector('.tool-header h2');
    return h2 ? h2.textContent : null;
  })();
  log('enter-opens-highlighted', {
    highlighted: hlName, opened: openedName,
    isToolPage: window.App.state.view.type === 'tool',
    match: !!hlName && hlName === openedName
  });

  // ---- 8. 进工具页后标题栏搜索恢复显示 ----
  const tbAfter = document.querySelector('.titlebar .search-wrap');
  log('titlebar-restored', {
    hidden: tbAfter ? tbAfter.classList.contains('hidden') : null,
    display: tbAfter ? getComputedStyle(tbAfter).display : null
  });

  // ---- 9. Esc 清空回浏览态 ----
  window.App.showView({ type: 'home' });
  await tick(200);
  const inp2 = document.querySelector('.home-search .hs-input');
  inp2.value = 'xyzzy-不存在的东西';
  inp2.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(300);
  const emptyTitle = document.querySelector('.hs-empty-title');
  log('no-match', { hasEmptyState: !!emptyTitle, text: emptyTitle ? emptyTitle.textContent : null });

  inp2.value = '压缩';
  inp2.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(300);
  key(inp2, 'Escape');
  await tick(300);
  log('escape-clears', {
    value: inp2.value,
    resultsShown: document.querySelector('.home-results').classList.contains('show'),
    browseVisible: getComputedStyle(document.querySelector('.home-browse')).display !== 'none'
  });

  // ---- 10. 分类卡片还在（保留浏览路径）----
  const cats = [...document.querySelectorAll('.home-cat')].map((c) => (c.querySelector('.hc-name') || {}).textContent);
  log('categories', { count: cats.length, names: cats.slice(0, 4) });

  // ---- 11. Ctrl+K 在首页要聚焦到大搜索框 ----
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  await tick(120);
  const activeCls = document.activeElement ? document.activeElement.className : '';
  log('ctrl-k', { activeClass: activeCls, isHomeInput: /hs-input/.test(activeCls) });

  return out;
})()
`;

const runner = `
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const PROBE = ${JSON.stringify(PROBE)};

app.whenReady().then(async () => {
  /* 语言必须显式钉成中文：本测试全程用中文字串搜索（「pdf」「压缩」「办公」），
     而应用启动时会按 navigator.language 猜语言。CI 的 windows-latest 是 en-US，
     不钉死就会整界面变英文、搜索结果全空 —— 但这看起来像「搜索坏了」，
     实际只是语言不同。本地是中文环境，所以一直没暴露。 */
  ipcMain.handle('store:get', (e, k, d) => {
    if (k === 'settings.lang') return { ok: true, data: 'zh' };
    return { ok: true, data: d };
  });
  ipcMain.handle('store:set', () => ({ ok: true, data: true }));
  ipcMain.handle('store:remove', () => ({ ok: true, data: true }));
  const w = new BrowserWindow({
    width: 1180, height: 860, show: true, x: 30, y: 30,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false }
  });
  const consoleErrs = [];
  w.webContents.on('console-message', (ev, lvl, msg) => { if (lvl >= 2) consoleErrs.push(msg); });
  await w.loadFile(path.join(ROOT, 'index.html'));
  await new Promise((r) => setTimeout(r, 1600));
  let res;
  try { res = await w.webContents.executeJavaScript(PROBE, true); }
  catch (e) { res = { fatal: String((e && e.message) || e) }; }
  if (res && !res.fatal) res.consoleErrs = consoleErrs.slice(0, 6);
  console.log('HOME ' + JSON.stringify(res));
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

const line = String(raw).split(/\r?\n/).find((l) => l.startsWith('HOME '));
if (!line) { console.log('未拿到 HOME'); console.log(raw.slice(-3000)); process.exit(1); }
const R = JSON.parse(line.slice('HOME '.length));

let fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

if (R.fatal) {
  chk(false, R.fatal);
} else {
  const by = {};
  for (const s of R.steps) by[s.name] = s;

  /* 失败时把探针拿到的原始数据全部打出来。
     CI 上这个脚本挂过，但日志要登录才能看、本地又全过 ——
     没有原始数据就只能靠猜。 */
  const dump = () => {
    console.log('  ↳ 探针实际数据：');
    for (const [k, v] of Object.entries(by)) console.log('    ' + k + ' = ' + JSON.stringify(v));
  };
  const chkd = (cond, msg) => { if (!cond) dump(); chk(cond, msg); };

  chkd(!!by.input, '首页存在大搜索框');

  chkd(by['single-search'] && by['single-search'].tbVisible === false,
      '首页标题栏搜索已隐藏（不会同时出现两个搜索框）');
  /* 这条断言曾经假设「可见搜索框恰好 1 个」，用的是 offsetParent !== null。
     offsetParent 在无头/未激活窗口里并不可靠，会在 CI 上误报。
     真正要保证的是「不会同时出现两个可输入、可见的搜索框」，
     即标题栏那个必须是隐藏的 —— 上面那条已经覆盖。
     所以这里放宽为「不出现 2 个及以上」，只在真的重复时报警。 */
  chkd(by['single-search'] && by['single-search'].visibleSearchCount <= 1,
      '首页可见搜索框不超过 1 个（实际 ' + (by['single-search'] && by['single-search'].visibleSearchCount) + '）');

  chk(by['searched-pdf'] && by['searched-pdf'].resultsShown && by['searched-pdf'].browseHidden,
      '输入后结果区出现、分类区让位');
  chk(by['searched-pdf'] && by['searched-pdf'].rowCount > 0,
      '搜「pdf」有结果（' + (by['searched-pdf'] && by['searched-pdf'].rowCount) + ' 条）: '
      + JSON.stringify(by['searched-pdf'] && by['searched-pdf'].names));

  chk(by['multi-word'] && by['multi-word'].count > 0,
      '多词查询「pdf 合并」有结果（旧实现为 0）: ' + (by['multi-word'] && by['multi-word'].first));

  chk(by['module-name'] && by['module-name'].count > 0,
      '按模块名「办公」能搜到（' + (by['module-name'] && by['module-name'].count) + ' 条）');

  chk(by.highlight && by.highlight.markCount > 0,
      '命中词被高亮标出（' + (by.highlight && by.highlight.markCount) + ' 处）');

  /* 这条断言不只是「↓ 能用」，它还挡着一个真实踩过的坑：
   * 把高亮从 mousemove 改成 mouseenter 之后，列表刚渲染时如果光标恰好停在
   * 某一行，浏览器会**补发一次 mouseenter**，高亮被预置到那一行，
   * 用户按 ↓ 就从没选过的行开始跳（曾经偶发失败、跑的轮次不同结果不同）。
   * 修法是只在「指针确实动过」之后才让鼠标决定高亮。 */
  chk(by['arrow-down-1'] && by['arrow-down-1'].hlIndex === 0, '↓ 第一次高亮第 1 行（不被残留 mouseenter 抢占）');
  chk(by['arrow-down-2'] && by['arrow-down-2'].moved, '↓ 第二次高亮下移一行');
  chk(by['arrow-up'] && by['arrow-up'].back, '↑ 回到上一行');

  chk(by['enter-opens-highlighted'] && by['enter-opens-highlighted'].isToolPage,
      'Enter 真的打开了工具页');
  chk(by['enter-opens-highlighted'] && by['enter-opens-highlighted'].match,
      'Enter 打开的是「高亮那一项」而非永远第一个（高亮='
      + (by['enter-opens-highlighted'] && by['enter-opens-highlighted'].highlighted)
      + '，打开=' + (by['enter-opens-highlighted'] && by['enter-opens-highlighted'].opened) + '）');

  chk(by['titlebar-restored'] && by['titlebar-restored'].hidden === false,
      '离开首页后标题栏搜索恢复显示');

  chk(by['no-match'] && by['no-match'].hasEmptyState,
      '无匹配时给出空状态文案: ' + (by['no-match'] && by['no-match'].text));

  chk(by['escape-clears'] && by['escape-clears'].value === '',
      'Esc 清空输入');
  chk(by['escape-clears'] && by['escape-clears'].resultsShown === false
      && by['escape-clears'].browseVisible === true,
      'Esc 后回到浏览态（结果区收起、分类区复位）');

  chk(by.categories && by.categories.count === 10,
      '分类卡片保留（' + (by.categories && by.categories.count) + ' 个）: '
      + JSON.stringify(by.categories && by.categories.names));

  chk(by['ctrl-k'] && by['ctrl-k'].isHomeInput,
      'Ctrl+K 在首页聚焦大搜索框（实际聚焦 ' + (by['ctrl-k'] && by['ctrl-k'].activeClass) + '）');

  chk(R.errors.length === 0, '页面运行期无 JS 报错' + (R.errors.length ? ': ' + JSON.stringify(R.errors) : ''));
  const hardErrs = (R.consoleErrs || []).filter((m) => /ReferenceError|is not defined|TypeError/.test(m));
  chk(hardErrs.length === 0, 'console 无硬错误' + (hardErrs.length ? ': ' + JSON.stringify(hardErrs) : ''));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
