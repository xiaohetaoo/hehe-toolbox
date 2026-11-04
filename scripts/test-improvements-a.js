'use strict';
/* A 组改进的回归测试：文件夹展开 / 英文提示 / 滚轮守卫 / 参数记忆。
 *
 * ============ 为什么必须是 E2E ============
 * 这四项的共同点是「跑起来才知道对不对」：
 *   · 文件夹递归展开依赖真实 fs:stat / fs:list 的返回形状
 *   · 滚轮守卫依赖真实事件冒泡与 defaultPrevented
 *   · 参数记忆依赖渲染 → 事件 → 防抖写盘 → 再渲染的完整链路
 * 静态扫源码只能证明「写了这段代码」，证明不了它真的生效。
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimprove-'));

/* 造一棵真实目录树：两个顶层文件 + 一层子目录 */
const tree = path.join(tmp, 'photos');
fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
fs.writeFileSync(path.join(tree, 'a.txt'), 'a');
fs.writeFileSync(path.join(tree, 'b.txt'), 'b');
fs.writeFileSync(path.join(tree, 'sub', 'c.txt'), 'c');

/* 主进程桩：必须返回 {ok:true,data} 信封，否则每个工具页都停在初始化失败 */
fs.writeFileSync(path.join(tmp, 'probe.js'), `
const fs = require('fs');
const path = require('path');
const TREE = ${JSON.stringify(tree)};
let store = {};
module.exports = {
  'store:get': (e,k,d) => ({ ok:true, data: (k in store) ? store[k] : d }),
  'store:set': (e,k,v) => { store[k]=v; return { ok:true, data:true }; },
  'store:health': () => ({ ok:true, data:{ ok:true } }),
  'app:get-autostart': () => ({ ok:true, data:false }),
  'app:set-lang': () => ({ ok:true, data:true }),
  'app:set-accent': () => ({ ok:true, data:true }),
  'app:set-theme': () => ({ ok:true, data:true }),
  'dangerous:list': () => ({ ok:true, data:{} }),
  'dangerous:tool-caps': () => ({ ok:true, data:{} }),
  'update:cleanup': () => ({ ok:true, data:0 }),
  'sys:stats': () => ({ ok:true, data:{cpu:0,mem:0} }),
  'app:get-info': () => ({ ok:true, data:{appVersion:'0.4.0',electron:'43',chrome:'140',node:'22',
    v8:'14',username:'u',hostname:'h',userData:TREE,platform:'win32',isDev:false} }),
  'app:crash-info': () => ({ ok:true, data:{lastSessionCrashed:false,dir:'/x',count:0,totalBytes:0,latest:null} }),
  'fs:stat': (e,p) => { try { const st=fs.statSync(p);
      return {ok:true,data:{size:st.size,isDir:st.isDirectory(),mtime:st.mtimeMs}}; }
    catch(err){ return {ok:false,error:err.message}; } },
  'fs:list': (e,p) => { try {
      const ns = fs.readdirSync(p,{withFileTypes:true});
      const out = ns.map(d=>{ const full=path.join(p,d.name); let sz=0;
        try{sz=fs.statSync(full).size;}catch(x){}
        return {name:d.name,path:full,isDir:d.isDirectory(),size:sz,mtime:0}; });
      return {ok:true,data:out};
    } catch(err){ return {ok:false,error:err.message}; } },
  'fs:read-text': () => ({ ok:true, data:{content:'x'} }),
  'fs:mkdir': () => ({ ok:true, data:true })
};
`, 'utf8');

const PROBE = `(async function () {
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
  const out = { checks: [] };
  const chk = (n, ok, d) => out.checks.push({ n, ok: !!ok, d: d == null ? null : String(d) });

  // ---- A1: 文件夹递归展开 ----
  const ex = await window.ui.expandDroppedPaths([window.__TREE]);
  chk('A1 文件夹被递归展开', ex.files.length === 3, '展开出 ' + ex.files.length + ' 个');
  chk('A1 统计了目录数', ex.dirs >= 2, 'dirs=' + ex.dirs);
  const names = ex.files.map(f => f.split(/[\\\\/]/).pop()).sort().join(',');
  chk('A1 含子目录里的文件', names === 'a.txt,b.txt,c.txt', names);

  // 单个文件不该被"展开"或丢失
  const single = await window.ui.expandDroppedPaths([window.__TREEFILE]);
  chk('A1b 单个文件原样保留', single.files.length === 1 && single.dirs === 0);

  // 不存在的路径不该抛异常（拖入已删除的文件）
  let threw = false;
  try { await window.ui.expandDroppedPaths(['Z:/definitely-not-exist-xyz']); }
  catch (e) { threw = true; }
  chk('A1c 不存在的路径不抛异常', !threw);

  // ---- A2: 英文提示 ----
  // lang 是 app.js 的模块变量，页面外改不了；这里验证文案与样式就位，
  // 渲染条件由自动化测试的源码断言覆盖。
  const noteText = window.i18n.t('tool.bodyNotTranslated');
  chk('A2 英文提示文案已定义', !!(noteText && noteText.length), String(noteText).slice(0, 40));
  let hasStyle = false;
  for (const s of document.styleSheets) {
    try { if ([...s.cssRules].some(r => (r.selectorText || '').indexOf('.tool-i18n-note') >= 0)) { hasStyle = true; break; } }
    catch (e) {}
  }
  chk('A2 提示样式已定义', hasStyle);

  // ---- A4: 滚轮守卫 ----
  window.App.showView({ type: 'tool', toolId: 'img-compress' });
  await tick(700);
  const num = document.querySelector('input[type=number]');
  chk('A4 页面里有 number 输入框', !!num);
  if (num) {
    const before = num.value;
    num.blur();
    const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    num.dispatchEvent(ev);
    chk('A4 未聚焦时滚轮被拦截', ev.defaultPrevented);
    chk('A4 值未被滚轮改变', num.value === before, before + ' -> ' + num.value);
  }

  // ---- B6: 进度条剩余时间 ----
  const prog = window.ui.progressEl();
  chk('B6 progressEl 返回 el', !!prog.el);
  chk('B6 el 里含剩余时间节点', !!prog.el.querySelector('.progress-eta'));
  // 喂几次进度，让速率推算跑起来
  prog.set(0);
  await tick(120);
  prog.set(20);
  await tick(120);
  prog.set(50);
  await tick(60);
  const eta = prog.el.querySelector('.progress-eta');
  chk('B6 达到一定进度后显示剩余时间', !!eta && eta.style.display !== 'none',
    eta ? ('text=' + eta.textContent) : 'no node');
  chk('B6 剩余时间文案可读', !!eta && /约|即将/.test(eta.textContent), eta ? eta.textContent : '');

  // ---- B2: 拖入文件夹时的样式类存在 ----
  let hasDirStyle = false;
  for (const sh of document.styleSheets) {
    try { if ([...sh.cssRules].some(r => (r.selectorText || '').indexOf('.dragover-dir') >= 0)) { hasDirStyle = true; break; } }
    catch (e) {}
  }
  chk('B2 拖入目录的区分样式已定义', hasDirStyle);
  // 拖拽区实例上应有 dragover 监听（通过 dropzone 构造后能加类来验证）
  const dz = window.ui.dropzone({ onFiles: () => {} });
  chk('B2 dropzone 可构造', !!dz && dz.classList.contains('dropzone'));

  // ---- B1: 参数记忆 ----
  const q = document.querySelector('input[type=number]');
  if (q) {
    q.value = '42';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    q.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await tick(900); // 等防抖写盘
  window.App.showView({ type: 'home' });
  await tick(300);
  window.App.showView({ type: 'tool', toolId: 'img-compress' });
  await tick(900);
  const q2 = document.querySelector('input[type=number]');
  chk('B1 参数被记住并回填', !!q2 && q2.value === '42', q2 ? ('恢复值=' + q2.value) : 'no input');

  return JSON.stringify(out);
})()`;

fs.writeFileSync(path.join(tmp, 'runner.js'), `
process.on('unhandledRejection', (e) => console.log('REJ ' + e));
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'), fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const PROBE = ${JSON.stringify(PROBE)};
const PROBE_FILE = ${JSON.stringify(path.join(tmp, 'probe.js'))};
const OUT = ${JSON.stringify(path.join(tmp, 'out.json'))};
const TREE = ${JSON.stringify(tree)};
const TREEFILE = ${JSON.stringify(path.join(tree, 'a.txt'))};

app.whenReady().then(async () => {
 try {
  const H = require(PROBE_FILE);
  for (const k of Object.keys(H)) ipcMain.handle(k, H[k]);
  const w = new BrowserWindow({ width: 1200, height: 860, show: false, useContentSize: true,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await w.loadFile(path.join(ROOT, 'index.html'));
  await new Promise(r => setTimeout(r, 1800));
  await w.webContents.executeJavaScript(
    'window.__TREE = ' + JSON.stringify(TREE) + '; window.__TREEFILE = ' + JSON.stringify(TREEFILE) + '; true', true);
  const raw = await w.webContents.executeJavaScript(PROBE, true);
  fs.writeFileSync(OUT, raw, 'utf8');
  console.log('A_DONE');
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

let out = null;
try { out = JSON.parse(fs.readFileSync(path.join(tmp, 'out.json'), 'utf8')); }
catch (e) {
  console.log('没拿到探测结果');
  console.log(raw.split(/\r?\n/).filter((l) => !/ERROR:net|WSALookup/.test(l)).join('\n').slice(-1200));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

let fail = 0;
for (const c of out.checks) {
  console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.n + (c.ok || c.d == null ? '' : '  -> ' + c.d));
  if (!c.ok) fail++;
}
console.log('\n结果: ' + (out.checks.length - fail) + ' 通过 / ' + fail + ' 失败');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
