'use strict';
/* 「前往设置 → 高危功能」必须落到**那个开关**上，而不是设置页顶部。
 *
 * ============ 这个缺陷长什么样 ============
 * 剪贴板历史页提示：「本工具的『删除文件』属于高危操作，需在设置中开启」，
 * 下面是「前往设置 → 高危功能」按钮。点下去以前只做一件事：切到设置页，
 * 分区默认停在「通用」。
 *
 * 用户的处境：提示语点名了「删除文件」，落地点却是一屏十来个开关
 * （删除文件 / 清理垃圾 / 取得所有权 / 编辑 hosts / 写注册表…），
 * 而且分区还错了。他得先找到「高危功能」，再在十几行里逐个读标签
 * 去找名字对得上的那一行 —— 提示语已经把答案告诉他了，界面却不认。
 *
 * ============ 为什么必须端到端 ============
 * 要验的是三件只有跑起来才知道的事：
 *   1) 点按钮之后**分区**切到了 danger（不是默认的 general）
 *   2) 目标那一行真的被滚动到可视区内（scrollIntoView 对游离节点无效，
 *      而且 danger 分区是异步画的，时机错了就滚不动）
 *   3) 那一行拿到了高亮类，且**过一会儿会自动消失**（常驻高亮会让人
 *      以为这一项被选中了）
 * 静态断言只能证明「代码里写了 scrollIntoView」，证明不了它生效。
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dangerjump-'));

/* 主进程桩：高危能力清单要给全，才能验证「找对了那一行」而不是「只有一行」。
 * file-delete 放在**中间**（前面还有两个），这样如果实现是"滚到第一行"
 * 或"滚到最后一个"，断言会失败。 */
fs.writeFileSync(path.join(tmp, 'probe.js'), `
let store = {
  'settings.dangerousCaps': []
};
const CAPS = [
  { id: 'junk-clean',    name: '清理系统垃圾', desc: '删除临时文件与日志', enabled: false },
  { id: 'recycle-empty', name: '清空回收站',   desc: '永久删除回收站内容', enabled: false },
  { id: 'file-delete',   name: '删除文件',     desc: '删除文件与目录',     enabled: false },
  { id: 'hosts-edit',    name: '编辑 hosts',   desc: '写入 hosts 文件',    enabled: false },
  { id: 'registry-edit', name: '写注册表',     desc: '修改注册表键值',     enabled: false }
];
const enabledSet = () => new Set(Array.isArray(store['settings.dangerousCaps']) ? store['settings.dangerousCaps'] : []);
module.exports = {
  'store:get': (e,k,d) => ({ ok:true, data: (k in store) ? store[k] : d }),
  'store:set': (e,k,v) => { store[k]=v; return { ok:true, data:true }; },
  'store:health': () => ({ ok:true, data:{ ok:true } }),
  'dangerous:list': () => ({ ok:true, data:{ caps: CAPS.map(c => Object.assign({}, c, { enabled: enabledSet().has(c.id) })) } }),
  'dangerous:set': (e, id, on) => {
    const s = enabledSet(); if (on) s.add(id); else s.delete(id);
    store['settings.dangerousCaps'] = [...s];
    return { ok:true, data:{ id, enabled: !!on } };
  },
  'dangerous:tool-caps': () => ({ ok:true, data:{ 'clipboard-history': { caps:['file-delete'], enabled:false } } }),
  'app:get-autostart': () => ({ ok:true, data:false }),
  'app:set-lang': () => ({ ok:true, data:true }),
  'app:set-accent': () => ({ ok:true, data:true }),
  'app:set-theme': () => ({ ok:true, data:true }),
  'update:cleanup': () => ({ ok:true, data:0 }),
  'sys:stats': () => ({ ok:true, data:{cpu:0,mem:0} }),
  'app:get-info': () => ({ ok:true, data:{appVersion:'0.5.0',electron:'43',chrome:'140',node:'22',
    v8:'14',username:'u',hostname:'h',userData:'/x',platform:'win32',isDev:false} }),
  'app:crash-info': () => ({ ok:true, data:{lastSessionCrashed:false,dir:'/x',count:0,totalBytes:0,latest:null} }),
  'fs:stat': () => ({ ok:true, data:{size:0,isDir:false,mtime:0} })
};
`, 'utf8');

const PROBE = `(async function(){
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
  const out = { checks: [] };
  const chk = (n, ok, d) => out.checks.push({ n, ok: !!ok, d: d == null ? null : String(d) });

  // 打开剪贴板历史（一个"部分锁"的工具页，会显示 dangerNoticeCard）
  window.App.openTool('clipboard-history');
  await tick(900);

  // 找到那张提示卡里的「前往设置」按钮，按文案匹配（中英都认）
  const btns = [...document.querySelectorAll('button')];
  const go = btns.find(b => /前往设置|Open Settings/i.test(b.textContent || ''));
  chk('C1 工具页有「前往设置」按钮', !!go, '按钮数=' + btns.length);
  if (!go) return JSON.stringify(out);

  go.click();
  await tick(1200);   // drawDanger 要 await 主进程要能力清单

  // ---- 分区正确 ----
  const activeNav = document.querySelector('.settings-nav-item.active');
  chk('C2 跳到的是「高危功能」分区', !!activeNav && /高危|High-risk/i.test(activeNav.textContent || ''),
    activeNav ? activeNav.textContent.trim() : '没有 active 导航项');

  // ---- 行存在且可寻址 ----
  const rows = [...document.querySelectorAll('.danger-row')];
  chk('C3 高危分区列出了全部 5 个开关', rows.length === 5, '实际 ' + rows.length + ' 行');
  const target = rows.find(r => r.dataset.cap === 'file-delete');
  chk('C4 目标行带 data-cap=file-delete', !!target,
    '各行 data-cap: ' + rows.map(r => r.dataset.cap).join(','));

  // ---- 高亮生效 ----
  chk('C5 目标行被高亮（danger-row-focus）',
    !!target && target.classList.contains('danger-row-focus'),
    target ? target.className : 'no target');

  // ---- 滚动落到了可视区 ----
  if (target) {
    const r = target.getBoundingClientRect();
    const vh = window.innerHeight;
    chk('C6 目标行滚动到了可视区内', r.top >= -4 && r.bottom <= vh + 4,
      'top=' + Math.round(r.top) + ' bottom=' + Math.round(r.bottom) + ' vh=' + vh);
  }

  // ---- 焦点落在那个开关上（键盘用户可以直接按空格） ----
  const swInTarget = target && target.querySelector('.switch');
  chk('C7 焦点在目标行的开关上',
    !!swInTarget && document.activeElement === swInTarget,
    swInTarget ? ('active=' + (document.activeElement && document.activeElement.className)) : 'no switch');
  chk('C8 开关有 role=switch 与 aria-checked',
    !!swInTarget && swInTarget.getAttribute('role') === 'switch'
      && (swInTarget.getAttribute('aria-checked') === 'false' || swInTarget.getAttribute('aria-checked') === 'true'),
    swInTarget ? ('role=' + swInTarget.getAttribute('role') + ' checked=' + swInTarget.getAttribute('aria-checked')) : '');

  // ---- 高亮会自动消失（不能常驻） ----
  await tick(2200);
  chk('C9 高亮在约 1.6 秒后自动消失',
    !!target && !target.classList.contains('danger-row-focus'),
    target ? target.className : '');

  // ---- 其它行不该被高亮 ----
  chk('C10 只有目标行被高亮，其它行不受影响',
    rows.filter(r => r.classList.contains('danger-row-focus')).length === 0,
    '仍高亮 ' + rows.filter(r => r.classList.contains('danger-row-focus')).length + ' 行');

  return JSON.stringify(out);
})()`;

fs.writeFileSync(path.join(tmp, 'runner.js'), `
process.on('unhandledRejection', (e) => console.log('REJ ' + e));
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'), fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const PROBE = ${JSON.stringify(PROBE)};
const PROBEFILE = ${JSON.stringify(path.join(tmp, 'probe.js'))};
app.whenReady().then(async () => {
  try {
    const H = require(PROBEFILE);
    for (const k of Object.keys(H)) ipcMain.handle(k, H[k]);
    const w = new BrowserWindow({ width: 1180, height: 780, show: false, useContentSize: true,
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
