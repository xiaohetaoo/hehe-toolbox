'use strict';
/* 三个用户反馈的回归测试（v0.6.1）：
 *   ① 面包屑点击无反应 —— .titlebar 是窗口拖拽区，子元素继承 drag，
 *      事件在系统层就被拿走，onclick 永远不触发
 *   ② 标签拖出无反应 —— 逐标签绑 mousedown 不可靠，改委托
 *   ③ 标签超出窗口不压缩 —— 只有 overflow-x:auto，而滚动条全局隐藏
 *
 * ============ 为什么必须端到端 ============
 * ① 的根因是 CSS 的 -webkit-app-region（一个只有 Chromium 认识、
 *    且会被子元素继承的属性）。源码里 onclick 写得完全正确，
 *    静态断言查不出"事件到不了"。
 * ③ 必须量真实布局：innerHTML 里标签一个不少，但用户看不见 ——
 *    只有比 scrollWidth 与 clientWidth 才知道有没有溢出。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(EXE)) {
  console.log('SKIP  无 electron.exe（CI 未安装 electron）');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uifix-'));

fs.writeFileSync(path.join(tmp, 'probe.js'), `
const openReqs = [];
let store = { 'settings.dangerousCaps': [] };
module.exports = {
  'store:get': (e,k,d) => ({ ok:true, data: (k in store) ? store[k] : d }),
  'store:set': (e,k,v) => { store[k]=v; return { ok:true, data:true }; },
  'store:health': () => ({ ok:true, data:{ ok:true } }),
  'dangerous:list': () => ({ ok:true, data:{ caps: [], enabled: [] } }),
  'dangerous:tool-caps': () => ({ ok:true, data:{} }),
  'app:get-autostart': () => ({ ok:true, data:false }),
  'app:set-lang': () => ({ ok:true, data:true }),
  'app:set-accent': () => ({ ok:true, data:true }),
  'app:set-theme': () => ({ ok:true, data:true }),
  'update:cleanup': () => ({ ok:true, data:0 }),
  'sys:stats': () => ({ ok:true, data:{cpu:0,mem:0} }),
  'app:get-info': () => ({ ok:true, data:{appVersion:'0.6.1',electron:'43',chrome:'140',node:'22',
    v8:'14',username:'u',hostname:'h',userData:'/x',platform:'win32',isDev:false} }),
  'app:crash-info': () => ({ ok:true, data:{lastSessionCrashed:false,dir:'/x',count:0,totalBytes:0,latest:null} }),
  'app:open-tool-window': (e, id) => { openReqs.push(id); return { ok:true, data:{ } }; },
  'test:open-reqs': () => ({ ok:true, data: openReqs })
};
`);

const PROBE = `(async function(){
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
  const out = { checks: [] };
  const chk = (n, ok, d) => out.checks.push({ n, ok: !!ok, d: d == null ? null : String(d) });

  /* ---------- ① 面包屑可点 ---------- */
  window.App.openTool('json-format');
  await tick(700);
  const nodes = [...document.querySelectorAll('.titlebar .breadcrumb .bc-node')];
  chk('F1 工具页有面包屑', nodes.length >= 2, '节点数=' + nodes.length);

  const bc = document.querySelector('.titlebar .breadcrumb');
  const cs = bc ? getComputedStyle(bc) : null;
  /* 这是 ① 的核心：-webkit-app-region 必须是 no-drag，
   * 否则整条落进窗口拖拽区，点击被系统吞掉。 */
  chk('F2 面包屑声明了 -webkit-app-region: no-drag',
    !!cs && cs.webkitAppRegion === 'no-drag',
    cs ? ('appRegion=' + cs.webkitAppRegion) : 'no breadcrumb');
  /* 反向确认：标题栏本身仍是 drag（否则窗口拖不动了） */
  const tb = document.querySelector('.titlebar');
  const tbCs = tb ? getComputedStyle(tb) : null;
  chk('F3 标题栏本身仍是 drag（窗口仍可拖动）',
    !!tbCs && tbCs.webkitAppRegion === 'drag',
    tbCs ? ('appRegion=' + tbCs.webkitAppRegion) : 'no titlebar');

  // 点中间级（模块名）应当回到模块页
  const mid = nodes[1];
  if (mid) {
    mid.click();
    await tick(500);
    const v = window.App.state.view;
    chk('F4 点面包屑中间级能跳转（回到模块页）', v.type === 'module', JSON.stringify(v));
  }

  // 点末级（当前页）回到上一级
  window.App.openTool('json-format');
  await tick(600);
  const ns2 = [...document.querySelectorAll('.titlebar .breadcrumb .bc-node')];
  const last = ns2[ns2.length - 1];
  chk('F5 末级带 bc-link（可点）', !!last && last.classList.contains('bc-link'),
    last ? last.className : 'missing');
  if (last) {
    last.click();
    await tick(500);
    const v2 = window.App.state.view;
    chk('F6 点末级回到上一级', v2.type === 'module', JSON.stringify(v2));
  }

  /* ---------- ② 拖拽委托已挂上 ---------- */
  const bar = document.querySelector('.tabbar');
  chk('F7 标签栏已挂上拖拽委托', !!bar && bar.__heheTabDrag === true,
    bar ? ('flag=' + bar.__heheTabDrag) : 'no tabbar');
  const anyTab = document.querySelector('.tabbar .tab');
  chk('F8 标签带 data-tool-id（委托靠它反查工具）',
    !!anyTab && !!anyTab.dataset.toolId, anyTab ? ('id=' + anyTab.dataset.toolId) : 'no tab');

  /* ---------- ③ 标签溢出策略：可读下限 + 横向滚动 + 渐隐提示 ---------- */
  // 先打开很多工具，制造溢出
  const ids = ['json-format','port-occupy','acl-repair','hosts-edit','static-server','base64','hash-tool','qr-generate','regex-test','clipboard-history'];
  for (const id of ids) { try { window.App.openTool(id); } catch (e) {} await tick(160); }
  await tick(600);

  const tabs = [...document.querySelectorAll('.tabbar .tab')];
  chk('F9 打开了足够多的标签（用于测溢出）', tabs.length >= 8, '实际 ' + tabs.length + ' 个');

  /* 【策略已从「无限压缩」改为「可读下限 + 滚动」】
   * 无限压缩（min-width:0）实测 13 个标签时 tab-label 只剩 0~6px，
   * 一排死图标毫无信息量。新策略：
   *   a) 每个标签保住可读下限 min-width:44px；
   *   b) 超出栏宽转入 overflow-x 滚动（滚动条全局隐藏）；
   *   c) 溢出的一侧做 18px 渐隐 mask，提示「另一侧还有标签」。
   * 所以「没有标签被挤出可视区」这条旧断言的语义被三段取代：
   *   F10a 下限不被击穿 —— 每个标签至少 44px，文字最少露 1~2 个字；
   *   F10b 图标仍完整 —— 旧 F12 保留（下限策略下更应成立）；
   *   F10c 溢出可感知 —— 溢出时 tabbar 必须挂 overflow-right（或 overflow-left）
   *        方向类，CSS 据此画渐隐；没有类 = 用户不知道还有标签。
   *   F10d 总宽可超栏宽（允许滚动），但超出量必须有限：不能比「下限总和」
   *        还宽出离谱的量（说明压缩完全没生效）。 */
  const minW = parseFloat(getComputedStyle(tabs[0]).minWidth);
  chk('F10a 每个标签保住可读下限（min-width 44px 生效）',
    tabs.every(t => t.getBoundingClientRect().width >= 43.5) && minW >= 43.5,
    'minWidth=' + minW + ' 最窄=' + Math.round(Math.min(...tabs.map(t => t.getBoundingClientRect().width))));

  const barRect = bar.getBoundingClientRect();
  const sw = bar.scrollWidth, cw = bar.clientWidth;
  const overflowing = sw > cw + 1;
  const cls = bar.className;
  if (overflowing) {
    /* 锁的是：溢出时方向类必须出现 —— 渐隐提示是隐藏滚动条下唯一的
     * 「还有标签」信号；类没挂上 = 用户不知道右边还有标签。 */
    chk('F10c 溢出时挂上渐隐方向类（overflow-right/left）',
      /overflow-(left|right)/.test(cls), 'cls=' + cls + ' sw=' + sw + ' cw=' + cw);
    /* 锁的是：可读下限策略下总宽允许超出栏宽（转入滚动），但标签本身
     * 必须仍在按 flex 压缩 —— 判据：单个标签不得宽于「内容自然宽度的上限
     * max-width:200px」，且总宽不得等于「全部按内容宽度展开」的量级。
     * 实测 10 个标签总宽 481px（压缩后），完全不压缩时约 800px+；
     * 取 600px 作为「压缩仍然生效」的上界（10 标签 × 44px 下限 = 440，
     * 加上长名标签按内容撑到 max-width 的合理余量）。 */
    const overW = tabs.filter(t => t.getBoundingClientRect().width > 200.5);
    chk('F10d 压缩仍然生效（没有标签超过 max-width 200px）',
      sw <= 600 && overW.length === 0, 'sw=' + sw + ' 超宽标签=' + overW.length);
    /* 锁的是：溢出时必须有渐隐方向类（mask 是隐藏滚动条下唯一的溢出提示）。
     * 至少挂 overflow-right 或 overflow-left 之一；方向由 scrollIntoView
     * （活跃标签滚入可视区）之后的滚动位置决定 ——
     *   · 滚动位置在起点        → 只挂 overflow-right
     *   · 活跃标签被滚到可视区  → overflow-left + overflow-right（两侧都有内容）
     * 两种都是正确形态，不再锁死「必须只有 right」—— 那是 active-scroll
     * 修复之前的旧行为，修复后活跃标签默认被滚进来，两侧渐隐才对。 */
    chk('F10e 溢出时挂上渐隐方向类（overflow-right/left 至少其一）',
      /overflow-(left|right)/.test(cls), 'cls=' + cls);
    /* 锁的是：方向类与实际滚动位置必须自洽 —— 左类成立当且仅当 scrollLeft>0。
     * 这条防止「类挂上了但 mask 方向画错」的静默失效。 */
    const slNow = bar.scrollLeft;
    chk('F10f 方向类与滚动位置自洽（left ⟺ scrollLeft>0）',
      bar.classList.contains('overflow-left') === (slNow > 1),
      'cls=' + cls + ' scrollLeft=' + Math.round(slNow));
  } else {
    /* 锁的是：不溢出时不得挂任何方向类 —— 空挂会让 mask 常驻裁掉边缘标签。 */
    chk('F10c 不溢出时不挂渐隐类', !/overflow-(left|right)/.test(cls), 'cls=' + cls);
  }

  /* 【压缩的样子（新策略）：总宽可以超出栏宽转入滚动，但要有限度】
   * 允许 1px 误差（亚像素舍入）。滚动策略下这一条只在「未溢出」时有意义，
   * 溢出场景由上面 F10d 锁「下限总和」上限。 */
  if (!(sw > cw + 1)) {
    const totalW = tabs.reduce((n, t) => n + t.getBoundingClientRect().width, 0);
    const availW = barRect.width - 32;  // 减去左右 padding
    chk('F11 标签总宽不超过标签栏宽度', totalW <= availW + 2,
      '总宽=' + Math.round(totalW) + ' 可用=' + Math.round(availW));
  }

  /* 【判据是「图标仍完整可见」，不是「够宽」】
   * 窄窗口下宽度的下限和"绝不溢出"必然冲突（实测：327px 放 10 个标签，
   * 平均只有 32px）。而用户真正需要的是"认得出这是哪个工具"——
   * 那由不参与压缩的图标保证，不是由标签宽度保证。 */
  const badIcon = tabs.filter((t) => {
    const ic = t.querySelector('.icon');
    if (!ic) return true;
    const r = ic.getBoundingClientRect();
    /* SVG 图标是 16×16。允许亚像素误差；被压到 12px 以下就说明它参与了收缩 */
    return r.width < 12;
  });
  chk('F12 压缩后每个标签的图标仍完整可见（不被压缩）', badIcon.length === 0,
    '图标被压 ' + badIcon.length + ' 个');
  /* 每个标签都要有 title 提示，否则窄到只剩图标时用户没法知道全名 */
  /* 【这里原来写的是「没有 title 且没有 aria-label」—— 一条永远不会失败的断言】
   * renderTabs 一直都会调 makeButtonLike(tab, …)，而它必定设置 aria-label。
   * 于是「没有 title 且没有 aria-label」恒为 false，这条断言从建立起就没红过。
   *
   * 实际后果（2026-11-06 真机量到）：8 个标签时 .tab-label 只有 16px，
   * 文字全被截断，只剩图标；aria-label 只对读屏器生效，
   * **鼠标悬停没有任何提示** —— 而 css/app.css 的注释明确承诺了
   * 「配合 title 悬停提示读全名」。承诺存在、实现不存在。
   *
   * 所以拆成两条：aria-label 必须继续有（读屏器），title 也必须真的有（鼠标）。 */
  const noAria = tabs.filter((t) => !t.getAttribute('aria-label'));
  chk('F12b 每个标签都有 aria-label（读屏器要能读出全名）',
    noAria.length === 0, '缺 aria-label ' + noAria.length + ' 个');
  /* 锁的是：只靠 aria-label 撑过断言，鼠标用户拿不到全名。 */
  const noTitle = tabs.filter((t) => !t.getAttribute('title'));
  chk('F12c 每个标签都有 title 提示（窄到只剩图标时鼠标能看到全名）',
    noTitle.length === 0, '缺 title ' + noTitle.length + ' 个');

  /* 标签名有省略号容器 */
  const hasLabel = tabs.every(t => !!t.querySelector('.tab-label'));
  chk('F13 标签名包在 .tab-label 里（才有省略号）', hasLabel);

  return JSON.stringify(out);
})()`;

fs.writeFileSync(path.join(tmp, 'runner.js'), `
process.on('unhandledRejection', (e) => console.log('REJ ' + e));
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const PROBE = ${JSON.stringify(PROBE)};
app.whenReady().then(async () => {
  try {
    const H = require(${JSON.stringify(path.join(tmp, 'probe.js'))});
    for (const k of Object.keys(H)) ipcMain.handle(k, H[k]);
    const w = new BrowserWindow({ width: 1100, height: 760, show: false, useContentSize: true,
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
    await w.loadFile(path.join(ROOT, 'index.html'));
    await new Promise(r => setTimeout(r, 1800));
    console.log('RESULT ' + await w.webContents.executeJavaScript(PROBE, true));
  } catch (e) { console.log('FATAL ' + (e && e.stack || e)); }
  setTimeout(() => app.exit(0), 200);
});
`, 'utf8');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');
env.HEHE_NOSPLASH = '1';

let raw = '';
try { raw = execFileSync(EXE, [path.join(tmp, 'runner.js')], { env, encoding: 'utf8', timeout: 180000 }); }
catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  -> ' + (detail || '')); }
}

const m = /RESULT (.+)/.exec(raw);
if (m) {
  for (const c of JSON.parse(m[1]).checks) chk(c.n, c.ok, c.d);
} else {
  console.log('FATAL ' + raw.slice(-1200));
  fail++;
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
