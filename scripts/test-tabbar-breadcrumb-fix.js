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

  /* ---------- ③ 标签溢出时压缩 ---------- */
  // 先打开很多工具，制造溢出
  const ids = ['json-format','port-occupy','acl-repair','hosts-edit','static-server','base64','hash-tool','qr-generate','regex-test','clipboard-history'];
  for (const id of ids) { try { window.App.openTool(id); } catch (e) {} await tick(160); }
  await tick(600);

  const tabs = [...document.querySelectorAll('.tabbar .tab')];
  chk('F9 打开了足够多的标签（用于测溢出）', tabs.length >= 8, '实际 ' + tabs.length + ' 个');

  const barRect = bar.getBoundingClientRect();
  const overflow = tabs.filter(t => t.getBoundingClientRect().right > barRect.right + 1);
  chk('F10 没有标签被挤出可视区（压缩生效）', overflow.length === 0,
    '溢出 ' + overflow.length + ' 个；bar.right=' + Math.round(barRect.right));

  /* 压缩的样子：标签总宽应当不超过标签栏可用宽度。
   * 允许 1px 误差（亚像素舍入）。 */
  const totalW = tabs.reduce((n, t) => n + t.getBoundingClientRect().width, 0);
  const availW = barRect.width - 32;  // 减去左右 padding
  chk('F11 标签总宽不超过标签栏宽度', totalW <= availW + 2,
    '总宽=' + Math.round(totalW) + ' 可用=' + Math.round(availW));

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
  const noTitle = tabs.filter((t) => !t.getAttribute('title') && !t.getAttribute('aria-label'));
  chk('F12b 每个标签都有 title/aria-label（窄到只剩图标时仍可知全名）',
    noTitle.length === 0, '缺名称 ' + noTitle.length + ' 个');

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
