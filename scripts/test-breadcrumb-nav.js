'use strict';
/* 面包屑导航：每一级都要真的能点回去，末级点击 = 回到上一级。
 *
 * ============ 为什么必须端到端 ============
 * 「能不能点」不是源码里有没有 onclick 那么简单，要验的是：
 *   1) 点一下**视图真的变了**（有 onclick 但 handler 写错，界面毫无反应）
 *   2) 点末级（当前页）是回到**上一级**，而不是重开当前页
 *      —— 后者会让工具页整页重绘，用户刚输入的内容全丢
 *   3) 「首页」这一级在首页自己身上不可点（点了什么都不会发生，
 *      留着可点反而让人以为坏了）
 * 这三件事都只有在真实 DOM 里点一遍才知道。
 *
 * ============ 第二个主题：侧栏与内容区的分隔 ============
 * 两块区域底色相同，没有分隔线时看不出边界。这里断言那条线**真的渲染出来了**
 * （计算样式上有 1px 的右边框、颜色不是 transparent），
 * 而不是只检查源码里写了 border-right。
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'breadcrumb-'));

fs.writeFileSync(path.join(tmp, 'probe.js'), `
let store = { 'settings.dangerousCaps': [] };
const CAPS = [{ id: 'file-delete', name: '删除文件', desc: 'd', enabled: false }];
module.exports = {
  'store:get': (e,k,d) => ({ ok:true, data: (k in store) ? store[k] : d }),
  'store:set': (e,k,v) => { store[k]=v; return { ok:true, data:true }; },
  'store:health': () => ({ ok:true, data:{ ok:true } }),
  'dangerous:list': () => ({ ok:true, data:{ caps: CAPS } }),
  'dangerous:set': () => ({ ok:true, data:true }),
  'dangerous:tool-caps': () => ({ ok:true, data:{} }),
  'app:get-autostart': () => ({ ok:true, data:false }),
  'app:set-lang': () => ({ ok:true, data:true }),
  'app:set-accent': () => ({ ok:true, data:true }),
  'app:set-theme': () => ({ ok:true, data:true }),
  'update:cleanup': () => ({ ok:true, data:0 }),
  'sys:stats': () => ({ ok:true, data:{cpu:0,mem:0} }),
  'app:get-info': () => ({ ok:true, data:{appVersion:'0.5.2',electron:'43',chrome:'140',node:'22',
    v8:'14',username:'u',hostname:'h',userData:'/x',platform:'win32',isDev:false} }),
  'app:crash-info': () => ({ ok:true, data:{lastSessionCrashed:false,dir:'/x',count:0,totalBytes:0,latest:null} })
};
`, 'utf8');

const PROBE = `(async function(){
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
  const out = { checks: [] };
  const chk = (n, ok, d) => out.checks.push({ n, ok: !!ok, d: d == null ? null : String(d) });

  const bc = () => document.querySelector('.titlebar .breadcrumb');
  const nodes = () => [...bc().querySelectorAll('.bc-node')];
  const texts = () => nodes().map(n => n.textContent.trim());
  const view = () => window.App.state.view;

  // ---- 起点：首页 ----
  window.App.showView({ type: 'home' });
  await tick(400);
  chk('B1 首页面包屑只有一项', nodes().length === 1, '实际 ' + nodes().length + ' 项：' + texts().join(' | '));
  chk('B2 首页那一项不可点（没有上一级）',
    nodes().length === 1 && !nodes()[0].classList.contains('bc-link'),
    nodes()[0] ? nodes()[0].className : '');

  // ---- 进入模块 ----
  window.App.showView({ type: 'module', moduleId: 'security' });
  await tick(400);
  chk('B3 模块页有两级', nodes().length === 2, texts().join(' | '));
  chk('B4 模块页的「首页」可点', nodes()[0] && nodes()[0].classList.contains('bc-link'),
    nodes()[0] ? nodes()[0].className : '');

  // ---- 进入工具：三级 ----
  window.App.openTool('clipboard-history');
  await tick(800);
  chk('B5 工具页有三级面包屑', nodes().length === 3, texts().join(' | '));

  const [n0, n1, n2] = nodes();
  chk('B6 三级都可点（含末级当前页）',
    !!(n0 && n0.classList.contains('bc-link')) &&
    !!(n1 && n1.classList.contains('bc-link')) &&
    !!(n2 && n2.classList.contains('bc-link')),
    [n0, n1, n2].map(n => n ? n.className : 'missing').join(' / '));

  // ---- 点末级 = 回上一级（模块页），而不是重开工具 ----
  n2.click();
  await tick(500);
  chk('B7 点末级（当前页）回到上一级模块页',
    view().type === 'module' && view().moduleId === 'security',
    JSON.stringify(view()));

  // ---- 点中间级：回模块 ----
  window.App.openTool('clipboard-history');
  await tick(700);
  nodes()[1].click();
  await tick(500);
  chk('B8 点中间级（模块名）回到模块页',
    view().type === 'module' && view().moduleId === 'security', JSON.stringify(view()));

  // ---- 点首页：回首页 ----
  window.App.openTool('clipboard-history');
  await tick(700);
  nodes()[0].click();
  await tick(500);
  chk('B9 点「首页」回首页', view().type === 'home', JSON.stringify(view()));

  // ---- 键盘可达 ----
  window.App.openTool('clipboard-history');
  await tick(700);
  const lastNode = nodes()[nodes().length - 1];
  chk('B10 面包屑项有 role=link 与 tabindex',
    lastNode.getAttribute('role') === 'link' && lastNode.getAttribute('tabindex') === '0',
    'role=' + lastNode.getAttribute('role') + ' tabindex=' + lastNode.getAttribute('tabindex'));
  lastNode.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(500);
  chk('B11 在末级按 Enter 也能回上一级',
    view().type === 'module' && view().moduleId === 'security', JSON.stringify(view()));

  // ---- 侧栏与内容区之间的分隔线 ----
  const sb = document.querySelector('.sidebar');
  const cs = sb ? getComputedStyle(sb) : null;
  chk('B12 侧栏有右边框（与内容区的分隔）', !!cs && parseFloat(cs.borderRightWidth) >= 0.5,
    cs ? ('width=' + cs.borderRightWidth + ' style=' + cs.borderRightStyle) : 'no sidebar');
  /* 【B13 必须挂着「线真的存在」这个前提】
   * 单独判颜色是无效的：把 border-right 改成 none 之后，
   * getComputedStyle 仍然返回原来的 borderRightColor —— 颜色属性还在，
   * 只是没有宽度、不画出来。实测确认过：只判颜色的版本在变异下照样绿。
   * 所以这里要求「有宽度 且 颜色不透明」同时成立。 */
  chk('B13 分隔线真的画出来了（有宽度且颜色不透明）',
    !!cs && parseFloat(cs.borderRightWidth) >= 0.5
      && cs.borderRightColor && cs.borderRightColor !== 'transparent'
      && !/rgba\(0, 0, 0, 0\)/.test(cs.borderRightColor),
    cs ? ('width=' + cs.borderRightWidth + ' color=' + cs.borderRightColor) : '');
  // 宽度没被边框撑开（border-box）
  chk('B14 侧栏总宽仍是 224px（边框不撑开布局）',
    !!sb && Math.round(sb.getBoundingClientRect().width) === 224,
    sb ? Math.round(sb.getBoundingClientRect().width) + 'px' : 'no sidebar');

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
    const w = new BrowserWindow({ width: 1180, height: 800, show: false, useContentSize: true,
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
    await w.loadFile(path.join(ROOT, 'index.html'));
    await new Promise(r => setTimeout(r, 1600));
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
try {
  raw = execFileSync(ELECTRON_EXE, [path.join(tmp, 'runner.js')], { env, encoding: 'utf8', timeout: 180000 });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  -> ' + (detail || '')); }
}

const m = /RESULT (.+)/.exec(raw);
if (m) {
  const out = JSON.parse(m[1]);
  for (const c of out.checks) chk(c.n, c.ok, c.d);
} else {
  console.log('FATAL ' + raw.slice(-1200));
  fail++;
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
