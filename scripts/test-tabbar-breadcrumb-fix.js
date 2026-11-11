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
   *
   * 【本段断言条数必须与窗口宽度无关 —— 这里踩过一次真坑】
   * 最初写成 if (overflowing) { 5 条 } else { 2 条 }：本机窗口窄、必然溢出，
   * 数到 18 条；CI 上窗口/字体不同、可能不溢出，只数到 15 条。
   * 同一个文件在两台机器上条数不同，于是 scripts/check-assertion-count.js
   * 把它判成「悄悄删掉 3 条测试」而挂红 —— v0.8.1 首次 CI 正是这样红的，
   * 而代码其实一条没删。
   *
   * 现在改成：五条断言**无条件全发**，判据自身随溢出状态取值。
   * 这样无论窗口多宽都是恒定条数，守卫只对「真的少测了」报警。 */
  const minW = parseFloat(getComputedStyle(tabs[0]).minWidth);
  const widths = tabs.map(t => t.getBoundingClientRect().width);
  /* 锁的是：可读下限被击穿（min-width:44px 失效）→ 又回到「一排死图标」。 */
  chk('F10a 每个标签保住可读下限（min-width 44px 生效）',
    widths.every(w => w >= 43.5) && minW >= 43.5,
    'minWidth=' + minW + ' 最窄=' + Math.round(Math.min(...widths)));

  const barRect = bar.getBoundingClientRect();
  const sw = bar.scrollWidth, cw = bar.clientWidth;
  const overflowing = sw > cw + 1;
  const cls = bar.className;
  const slNow = bar.scrollLeft;

  /* 锁的是：单个标签吃掉半个标签栏 —— CSS 的 max-width:200px 失效时，
   * 只开两三个工具也会把后面的标签全挤出去。 */
  chk('F10b 没有标签超过 max-width 200px（压缩上限生效）',
    widths.every(w => w <= 200.5), '最宽=' + Math.round(Math.max(...widths)));

  /* 锁的是：方向类与实际滚动位置脱节（mask 画在没内容的那一侧，
   * 或溢出却没有提示）。判据与 js/app.js 的 updateTabOverflowHint 逐字对应：
   *   left  ⟺ scrollLeft > 1
   *   right ⟺ scrollLeft + clientWidth < scrollWidth - 1
   * 不溢出时两者都应为 false —— 空挂会让 mask 常驻裁掉边缘标签。 */
  const wantLeft = slNow > 1;
  const wantRight = slNow + cw < sw - 1;
  chk('F10c 方向类与滚动位置自洽（left ⟺ scrollLeft>0，right ⟺ 右侧仍有内容）',
    bar.classList.contains('overflow-left') === wantLeft
    && bar.classList.contains('overflow-right') === wantRight,
    'cls=' + cls + ' scrollLeft=' + Math.round(slNow) + ' sw=' + sw + ' cw=' + cw);

  /* 锁的是：用户拿不到「还有标签」的信号 —— 滚动条全局隐藏（本项目
   * 的通配规则写了 scrollbar-width: none），渐隐方向类是没有提示时的唯一线索。
   * 判据：有方向类 ⟺ 确实还有内容在可视区外。 */
  chk('F10d 渐隐方向类按「是否还有内容」出现/缺席',
    /overflow-(left|right)/.test(cls) === (wantLeft || wantRight),
    'cls=' + cls + ' 期望=' + (wantLeft || wantRight));

  /* 锁的是：有标签脱离了 flex 的 max-width 约束（总宽逼近「按内容自然宽度
   * 全部展开」的量级，说明压缩完全没生效）。上界取「标签数 × max-width +
   * 标签间距」，与窗口宽度无关，因此本机与 CI 都能成立。 */
  chk('F10e 总宽未突破「标签数 × max-width」上限（压缩仍在生效）',
    sw <= widths.length * 200.5 + widths.length * 2,
    'sw=' + sw + ' 上限=' + Math.round(widths.length * 200.5 + widths.length * 2) + ' 溢出=' + overflowing);

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
