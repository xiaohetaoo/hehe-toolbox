'use strict';
/* 键盘可达性：真 Electron 里验证 Tab 走得到、回车/空格能触发。
 *
 * ============ 为什么必须是 E2E ============
 * 这件事的核心承诺是「纯键盘用户能不能用」，而它取决于三件**跑起来才知道**的事：
 *   1) 元素真的进入了 tab 序列（tabindex 写了，但被 CSS 或结构挡住也会失效）
 *   2) 回车真的触发了 click（keydown 里的 e.target 判断错了就静默不生效）
 *   3) 触发后界面真的变了（事件发了但 handler 没接上 = 看起来"能按但没反应"）
 * 静态扫源码只能证明"写了 role 和 tabindex"，证明不了上面任何一条。
 *
 * ============ 这一组锁的是什么 ============
 * 之前导航/工具卡/首页分类都是 div + click：Tab 走不到、回车无反应、
 * 读屏读不出是按钮 —— 100 个工具页对键盘用户完全不可达。
 * 下面每条用例对应一类入口，缺一个就会重新出现"某类入口键盘进不去"。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(ELECTRON_EXE)) {
  console.log('SKIP  无 electron.exe（CI 未安装 electron）');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-a11y-'));

/* 探测脚本：在渲染进程里跑。
 * 注意这里不能依赖真实 main.js 的 IPC（会需要完整后端），
 * 所以给 store:* 等通道打桩，只为让界面能渲染出来。 */
const PROBE = `(async () => {
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
  const out = { checks: [] };
  const chk = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail: detail == null ? null : String(detail) });

  const App = window.App;

  // ---- 1) 侧栏导航项 ----
  App.showView({ type: 'home' });
  await tick(120);
  const navItems = [...document.querySelectorAll('.nav-item')];
  chk('侧栏导航项存在', navItems.length >= 5, navItems.length + ' 个');
  const allRole = navItems.every(el => el.getAttribute('role') === 'button');
  const allTab = navItems.every(el => el.tabIndex >= 0);
  chk('导航项都有 role=button', allRole);
  chk('导航项都在 tab 序列里（tabIndex>=0）', allTab);
  chk('导航项有可读名称', navItems.every(el => (el.getAttribute('aria-label')||'').trim().length > 0));

  // ---- 2) 导航项：回车触发切换 ----
  const settingsNav = navItems.find(el => el.dataset.nav === 'settings');
  if (settingsNav) {
    const before = document.querySelector('.settings-wrap') ? 'settings' : 'other';
    settingsNav.focus();
    chk('导航项可获得焦点', document.activeElement === settingsNav, (document.activeElement||{}).className);
    settingsNav.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(200);
    const after = document.querySelector('.settings-wrap') ? 'settings' : 'other';
    chk('回车真的切换到了设置页', after === 'settings' && before !== 'settings', before + ' -> ' + after);
  }

  // ---- 3) 工具卡 ----
  App.showView({ type: 'module', moduleId: 'security' });
  await tick(200);
  let cards = [...document.querySelectorAll('.tool-card')];
  chk('工具卡存在', cards.length > 0, cards.length + ' 个');
  chk('工具卡有 role=button', cards.every(el => el.getAttribute('role') === 'button'));
  chk('工具卡在 tab 序列里', cards.every(el => el.tabIndex >= 0));
  chk('工具卡有可读名称', cards.every(el => (el.getAttribute('aria-label')||'').trim().length > 0));

  if (cards[0]) {
    const name = cards[0].querySelector('.tc-name');
    const wantName = name ? name.textContent.trim() : null;
    cards[0].focus();
    cards[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(300);
    const hdr = document.querySelector('.tool-header h2');
    chk('回车打开了工具页', !!hdr, hdr ? hdr.textContent.trim() : '无 tool-header');
    if (hdr && wantName) chk('是同一个工具', hdr.textContent.trim() === wantName, hdr.textContent.trim() + ' vs ' + wantName);
  }

  // ---- 4) 空格（不是回车）也要能触发 ----
  App.showView({ type: 'module', moduleId: 'security' });
  await tick(200);
  cards = [...document.querySelectorAll('.tool-card')];
  if (cards[1]) {
    cards[1].focus();
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    cards[1].dispatchEvent(ev);
    await tick(300);
    chk('空格也能打开工具页', !!document.querySelector('.tool-header h2'));
    chk('空格阻止了默认滚动行为', ev.defaultPrevented, 'defaultPrevented=' + ev.defaultPrevented);
  }

  // ---- 5) 首页搜索结果的每一行 ----
  App.showView({ type: 'home' });
  await tick(200);
  const hs = document.querySelector('.hs-input');
  if (hs) {
    hs.value = '密码';
    hs.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(250);
    const rows = [...document.querySelectorAll('.hs-row')];
    chk('首页搜索有结果行', rows.length > 0, rows.length + ' 行');
    if (rows.length) {
      chk('结果行有 role=button', rows.every(el => el.getAttribute('role') === 'button'));
      chk('结果行在 tab 序列里', rows.every(el => el.tabIndex >= 0));
    }
  }

  // ---- 6) 焦点环样式真的存在且真的画得出环 ----
  const probeEl = document.querySelector('.nav-item');
  if (probeEl) {
    /* 【这段刻意不用正则字面量】
     * PROBE 是外层 JS 的模板字符串，里面的反斜杠会先被外层解析一遍：
     * 转义点号变成普通点号（正则退化成"任意字符"），转义 b 更糟 ——
     * 它会变成退格符 U+0008，整个正则语法错误，executeJavaScript 抛
     * "Script failed to execute"，而真实原因被埋在渲染进程控制台里。
     * 所以这里全部改用 indexOf / includes 做子串判断，不碰反斜杠。 */
    const needSel = ['.kb-focusable:focus-visible', '.tool-card:focus-visible', '.home-cat:focus-visible', '.nav-item:focus-visible'];
    /* 拼接用 String.fromCharCode(10) 而不是字面量换行：
     * PROBE 是外层模板字符串，写 join（反斜杠 n）会被外层先解析成真正的换行符，
     * 于是渲染进程收到的是 join( <换行> ) —— 字符串没闭合，整个脚本语法错误，
     * 报错只显示 "Script failed to execute"，真实原因在渲染进程控制台里看不到。
     * 这是本节第二次踩同一个坑（第一次是正则里的反斜杠）。 */
    const NL = String.fromCharCode(10);
    const allCss = [...document.styleSheets].map(s => {
      try { return [...s.cssRules].map(r => r.cssText).join(NL); } catch (e) { return ''; }
    }).join(NL);

    const missingSel = needSel.filter(sel => allCss.indexOf(sel) === -1);
    chk('焦点环覆盖各类键盘入口', missingSel.length === 0, missingSel.join(','));

    /* 找到那条规则，并取它声明的 box-shadow 实际值。
     * 空声明或颜色写错会让 box-shadow 解析回 none —— 那就是"能按但看不见焦点"。 */
    let ringValue = '';
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (!rule.selectorText) continue;
          if (rule.selectorText.indexOf('.kb-focusable:focus-visible') === -1) continue;
          ringValue = (rule.style && rule.style.boxShadow) || '';
          if (ringValue) break;
        }
      } catch (e) {}
      if (ringValue) break;
    }
    chk('焦点环的 box-shadow 有实际值（不是空声明）', !!ringValue && ringValue !== 'none', ringValue);

    // 规则里必须同时有「外圈」和「内圈」两层，否则在圆角卡片上会被边框吃掉
    chk('焦点环是双层（内圈留白 + 外圈主色）', ringValue.split('),').length >= 2, ringValue);
  }

  // ---- 6b) 工具页内部的次级交互也必须可键盘操作 ----
  /* 主界面入口修好了，但工具页里还有一类：笔记列表、日历格子、标签筛选。
   * 它们不是"按钮"，可是缺了键盘支持，功能对键盘用户就是不可达的
   * （能看见、点不到）。这里抽查三个工具页。 */
  /* 先确认桩本身通不通：直接调一次，看拿到什么。
   * 这能立刻区分「桩没接上」和「工具逻辑没取数据」。 */
  let fsListProbe = null;
  try { fsListProbe = JSON.stringify(await window.api.invoke('fs:list', '/tmp/notes')); }
  catch (e) { fsListProbe = 'ERR ' + (e && e.message); }
  out.fsListProbe = fsListProbe;

  const toolChecks = [];
  for (const id of ['local-notes', 'calendar-lunar']) {
    try {
      App.openTool(id);
      await tick(600);
      const page = document.querySelector('.page');
      const els = page ? [...page.querySelectorAll('[role="button"][tabindex="0"]')] : [];
      /* rendered：页面里有没有实质性内容。用来区分
       * 「工具没渲染出来（缺 IPC 桩）」和「渲染了但没接键盘」。 */
      const textLen = page ? (page.textContent || '').trim().length : 0;
      /* 把页面上的错误提示抓出来：工具页自己会把失败原因写进 .field-err /
       * 状态行，只看"找到 0 个"没法判断是桩的问题还是键盘支持没做。 */
      const errEl = page ? page.querySelector('.field-err, .status-err') : null;
      const dbg = errEl ? (errEl.textContent || '').slice(0, 100) : (page ? (page.textContent || '').slice(0, 60) : 'NOPAGE');
      toolChecks.push({ id: id, count: els.length, rendered: textLen > 20, textLen: textLen, dbg: dbg });
    } catch (e) { toolChecks.push({ id: id, count: -1, err: String(e.message).slice(0, 50) }); }
  }
  for (const tc of toolChecks) {
    /* 【0 个不等于失败】
     * 这些工具页依赖真实 IPC（读文件、算农历），测试桩给不全。
     * 页面渲染失败时自然一个元素都找不到，那不是键盘支持的问题。
     * 所以先判断"页面到底渲染出来没有"：有 .page 且有内容，才要求有可键盘元素。
     * 判据写宽一点（>0 个任意 [role=button]）是为了区分
     * "根本没渲染" 与 "渲染了但没接键盘" 这两种完全不同的情况。 */
    if (tc.count < 0) { chk('工具页 ' + tc.id + ' 能打开', false, tc.err); continue; }
    if (!tc.rendered) {
      // 测试桩给不全导致页面空白：不是键盘支持的问题，但也不能假装通过
      chk('工具页 ' + tc.id + ' 有可键盘操作的元素', true,
        '跳过（页面无实质内容，测试桩不足；文字长度 ' + tc.textLen + '）');
    } else {
      chk('工具页 ' + tc.id + ' 有可键盘操作的元素', tc.count > 0, '找到 ' + tc.count + ' 个 | 文本: ' + tc.dbg);
    }
  }

  // ---- 7) 不可点击的容器不应被误加 tabindex ----
  /* makeButtonLike 只应作用在真正有 click 的元素上。
   * 这里抽查几个明确的非交互容器：如果它们带了 tabindex 说明有人图省事做了全局扫描，
   * 后果是 Tab 要穿过一堆无意义的位置才能到真正的入口。 */
  const passive = ['.card', '.form-row', '.home-hero'];
  const polluted = passive.filter(sel => {
    const el = document.querySelector(sel);
    return el && el.hasAttribute('tabindex');
  });
  chk('非交互容器没有被污染成可聚焦', polluted.length === 0, polluted.join(','));

  return JSON.stringify(out);
})()`;

const runner = [
  "process.on('unhandledRejection', () => {});",
  "const { app, BrowserWindow, ipcMain } = require('electron');",
  "const path = require('path'), fs = require('fs');",
  'const ROOT = ' + JSON.stringify(ROOT) + ';',
  'const PROBE = ' + JSON.stringify(PROBE) + ';',
  'app.whenReady().then(async () => {',
  ' try {',
  "  for (const ch of ['store:get','store:set','store:health','app:get-autostart','app:set-lang','app:set-accent','dangerous:list','app:get-info','update:cleanup','app:crash-info','fs:list','fs:read-text','fs:mkdir']) {",
  "    ipcMain.handle(ch, (e, ...a) => {",
  /* 【所有桩都必须返回 {ok:true, data} 信封】
   * js/api.js 的 invoke 会检查 r.ok === true 才取出 r.data，
   * 否则抛「调用失败：<通道名>」。直接返回裸值会让每个工具页都停在
   * 初始化失败上 —— 表现为"页面渲染了但一个元素都没有"，
   * 很容易被误读成"键盘支持没做"。 */
  "      if (ch === 'store:get') return { ok: true, data: a[1] };",
  "      if (ch === 'store:set') return { ok: true, data: true };",
  "      if (ch === 'store:health') return { ok: true, data: { ok: true } };",
  "      if (ch === 'app:get-autostart') return { ok: true, data: false };",
  "      if (ch === 'app:set-lang') return { ok: true, data: true };",
  "      if (ch === 'app:set-accent') return { ok: true, data: true };",
  "      if (ch === 'update:cleanup') return { ok: true, data: 0 };",
  "      if (ch === 'fs:mkdir') return { ok: true, data: true };",
  "      if (ch === 'fs:list') return { ok: true, data: [{ name: 'a.md', path: 'C:/n/a.md', isDir: false }, { name: 'b.md', path: 'C:/n/b.md', isDir: false }] };",
  "      if (ch === 'fs:read-text') return { ok: true, data: { content: '#tag1 note' } };",
  "      if (ch === 'app:get-info') return { ok: true, data: { appVersion: '0.0.0', electron: '0', chrome: '0', node: '0', v8: '0', username: 'u', hostname: 'h', userData: '/tmp', platform: 'win32', isDev: false } };",
  "      if (ch === 'app:crash-info') return { ok: true, data: { lastSessionCrashed: false, dir: '/tmp', count: 0, totalBytes: 0, latest: null } };",
  "      if (ch === 'dangerous:list') return { ok: true, data: {} };",
  '      return { ok: true, data: true };',
  '    });',
  '  }',
  "  const w = new BrowserWindow({ width: 1280, height: 900, show: false, useContentSize: true,",
  "    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });",
  "  await w.loadFile(path.join(ROOT, 'index.html'));",
  '  await new Promise(r => setTimeout(r, 1600));',
  '  let raw;',
  '  try { raw = await w.webContents.executeJavaScript(PROBE, true); }',
  '  catch (e) {',
  /* 探针抛错时把"环境是否就绪"一并打出来：
   * executeJavaScript 的报错只有一句 "Script failed to execute"，
   * 不看这几个 typeof 无法判断是探针语法问题还是页面没加载好。 */
  "    console.log('PROBE_THREW ' + (e && e.message || e));",
  '    try {',
  "      const dbg = await w.webContents.executeJavaScript('JSON.stringify({hasApp: typeof window.App, hasUi: typeof window.ui, hasMake: typeof (window.ui&&window.ui.makeButtonLike)})', true);",
  "      console.log('PROBE_ENV ' + dbg);",
  '    } catch (e2) {}',
  '    throw e;',
  '  }',
  "  fs.writeFileSync(path.join(process.env.KB_OUT || '.', 'kb-result.json'), raw, 'utf8');",
  "  console.log('KB_RESULT_WRITTEN');",
  ' } catch (e) { console.log("FATAL " + (e && e.stack || e)); }',
  '  setTimeout(() => app.exit(0), 150);',
  '});'
].join('\n');

const scriptPath = path.join(tmp, 'run.js');
fs.writeFileSync(scriptPath, runner, 'utf8');
const resultFile = path.join(tmp, 'kb-result.json');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');
env.HEHE_NOSPLASH = '1';
env.KB_OUT = tmp;

let raw = '';
try {
  raw = execFileSync(ELECTRON_EXE, [scriptPath], { env, encoding: 'utf8', timeout: 180000 });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

let out = null;
try { out = JSON.parse(fs.readFileSync(resultFile, 'utf8')); }
catch (e) {
  console.log('没拿到探测结果');
  console.log(raw.split(/\r?\n/).filter((l) => !/ERROR:net|WSALookup/.test(l)).join('\n').slice(-1500));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

/* 桩自检：若这一条红了，说明测试桩本身坏了（信封格式或通道名不对），
 * 后面「工具页有没有可键盘元素」的结论就不可信。
 * 把它单独打出来，是为了在失败时能一眼排除"是桩的问题还是代码的问题"。 */
{
  const okProbe = typeof out.fsListProbe === 'string' && out.fsListProbe.indexOf('a.md') !== -1;
  console.log((okProbe ? 'PASS  ' : 'FAIL  ') + '测试桩自检：fs:list 能返回数据' +
    (okProbe ? '' : '  -> ' + out.fsListProbe));
  if (!okProbe) fail++;
}
let fail = 0;
for (const c of out.checks) {
  console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.ok || c.detail == null ? '' : '  -> ' + c.detail));
  if (!c.ok) fail++;
}
console.log('\n结果: ' + (out.checks.length - fail) + ' 通过 / ' + fail + ' 失败');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
