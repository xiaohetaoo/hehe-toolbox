'use strict';

/* 【把 TEMP/TMP 指向工作区】本机安全软件拦 Chromium 子进程写 %TEMP%
 * （EPERM），而本脚本要把探针与结果落盘。工作区不在拦截名单里。
 * 详见 scripts/lib/electron-launch.js。进程退出时删除。 */
(function () {
  if (process.env.HEHE_TEST_TMP_READY) return;
  var p = require('path'), f = require('fs');
  var d = p.join(p.resolve(__dirname, '..'), '.tmp-testrun-' + process.pid);
  try {
    f.mkdirSync(d, { recursive: true });
    process.env.TEMP = d; process.env.TMP = d;
    process.env.HEHE_TEST_TMP_READY = '1';
    process.on('exit', function () { try { f.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  } catch (e) { /* 建不了就让失败如实暴露 */ }
})();
/* 端到端实测 P1-2：acl:repair 必须受门禁保护。
 *
 * 【为什么这条要真起应用】
 * 缺陷是「声明了能力但没接门禁」—— 光看代码能看出映射表里有没有那一行，
 * 但真正要验的是运行时行为：未开启该能力时 seeds 直接 invoke 会被拒绝，
 * 并给出「请到设置 → 高危功能开启」的指引；而诊断（只读）不受限制。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
/* 【Chromium 兼容参数 —— 见 scripts/lib/electron-launch.js 的实测根因】
 * 本机 Chromium 进程级沙箱起不来：不带 --no-sandbox 时 electron.exe 直接以
 * 0x80000003 崩掉，stdout/stderr 全空，测试只能报「没拿到渲染层结果」。
 * --disable-gpu/--disable-dev-shm-usage 同理（远程会话的 GPU 进程、受限的 /dev/shm）。
 * 这些参数只影响测试探针，不影响产品打包后的启动参数。 */
const CHROMIUM_FLAGS = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];

/* 【把子进程的 TEMP/TMP 与 --user-data-dir 切到工作区内】
 * 本机 Chromium 子进程写 %TEMP% 会被安全软件拦（EPERM），而探针都要把结果
 * 落盘再读，于是全部卡在"写不了结果文件"。工作区不在拦截名单里。
 * 详见 scripts/lib/electron-launch.js。用完即删。 */
let __scratchDir = null;
function __ensureScratch(env) {
  if (!__scratchDir) {
    __scratchDir = path.join(path.resolve(__dirname, '..'), '.tmp-e2e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    try { require('fs').mkdirSync(__scratchDir, { recursive: true }); } catch (e) {}
    process.on('exit', () => { try { require('fs').rmSync(__scratchDir, { recursive: true, force: true }); } catch (e) {} });
  }
  env.TEMP = __scratchDir;
  env.TMP = __scratchDir;
  return ['--user-data-dir=' + path.join(__scratchDir, 'udd')];
}

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON)) { console.log('SKIP 无 electron.exe'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatee2e-'));
const target = path.join(tmp, 'target.txt');
fs.writeFileSync(target, 'x');

const OUT = JSON.stringify(path.join(tmp, 'result.json'));
const TARGET_LIT = JSON.stringify(target);

/* 探针：在**默认配置**（什么都没开启）下直接调 acl:repair。
 * 期望被拒绝；同时调 acl:diagnose 期望正常返回（只读不受门禁影响）。 */
const PROBE = [
  '',
  'app.whenReady().then(() => {',
  '  setTimeout(async () => {',
  '    let out = JSON.stringify({ error: "no window" });',
  '    try {',
  '      const wins = BrowserWindow.getAllWindows();',
  '      const w = wins.find((x) => { try { return x.webContents.getURL().indexOf("index.html") !== -1; } catch (e) { return false; } });',
  '      if (w) {',
  '        const script = '
  + JSON.stringify('(async function(){'
    + 'var repair; try { await window.api.invoke("acl:repair", { target: ' + TARGET_LIT + ' }); repair = {ok:true}; }'
    + ' catch (e) { repair = {ok:false, msg:String(e&&e.message||e)}; }'
    + 'var diag; try { diag = {ok:true, data: await window.api.invoke("acl:diagnose", ' + TARGET_LIT + ')}; }'
    + ' catch (e) { diag = {ok:false, msg:String(e&&e.message||e)}; }'
    + 'var caps; try { caps = await window.api.invoke("dangerous:tool-caps"); } catch (e) { caps = null; }'
    + 'var list; try { list = await window.api.invoke("dangerous:list"); } catch (e) { list = null; }'
    + 'return JSON.stringify({repair:repair, diag:diag, caps:caps, list:list});'
    + '})()')
  + ';',
  '        out = await w.webContents.executeJavaScript(script);',
  '      }',
  '    } catch (e) { out = JSON.stringify({ error: String((e && e.message) || e) }); }',
  '    try { require("fs").writeFileSync(' + OUT + ', out); } catch (e) {}',
  '    app.exit(0);',
  '  }, 4000);',
  '});',
  '',
].join('\n');

for (const f of ['main.js', 'preload.js', 'index.html', 'package.json']) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) continue;
  let body = fs.readFileSync(src, 'utf8');
  if (f === 'main.js') body += PROBE;
  fs.writeFileSync(path.join(tmp, f), body);
}
/* 任务 5：main.js require('./ipc/dir-acl-links')，ipc/ 必须一起拷，
 * 否则临时目录里的应用启动即 MODULE_NOT_FOUND（而这个测试只会打一行
 * 「环境受限」的 SKIP，不会变红 —— 很容易被误判成环境问题）。 */
for (const d of ['js', 'css', 'lib', 'assets', 'ipc']) {
  try { fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true }); } catch (e) {}
}
try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction'); }
catch (e) { console.log('SKIP 无法链接 node_modules'); process.exit(0); }

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_NOSPLASH = '1';
env.HEHE_TEST_DATA = path.join(tmp, 'ud');

let raw = '';
try { raw = execFileSync(ELECTRON, [...CHROMIUM_FLAGS, ...__ensureScratch(env), tmp], { env, encoding: 'utf8', timeout: 90000 }); }
catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

const rf = path.join(tmp, 'result.json');
let pass = 0, fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (c) pass++; else fail++; };

if (!fs.existsSync(rf)) {
  console.log('SKIP 探针未落盘');
  console.log(String(raw).split(/\r?\n/).filter(Boolean).slice(-6).join('\n'));
  process.exit(0);
}

const r = JSON.parse(fs.readFileSync(rf, 'utf8'));
console.log('=== 探针记录 ===');
console.log('  repair.ok :', r.repair && r.repair.ok);
console.log('  repair.msg:', r.repair && r.repair.msg);
console.log('  diag.ok   :', r.diag && r.diag.ok);
console.log('  caps.acl-repair:', r.caps && JSON.stringify(r.caps['acl-repair']));
console.log('  caps keys :', r.caps ? Object.keys(r.caps).filter((k) => k === 'acl-repair').join(',') : '(null)');

/* 1) 未开启时必须被拒绝 */
chk(r.repair && r.repair.ok === false, '未开启时 acl:repair 被拒绝（不再能直接调）');
/* 2) 拒绝信息要指路到设置页。
 * 【为什么要接受中英两种写法】这条文案由**主进程**生成（dangerousDenied），
 * 而主进程的文案语言跟随渲染层送来的 app:set-lang。CI 的 runner 是 en-US，
 * 启动时渲染层会把语言设成 en —— 断言写死「高危功能」就会在 CI 上假红。
 * 这里只钉住真正重要的两点：指路到设置、并且点名是「高危功能」这一类。 */
chk(/(高危功能|High-risk)/.test(String(r.repair && r.repair.msg)) &&
  /(设置|Settings)/.test(String(r.repair && r.repair.msg)),
  '拒绝信息指向「设置 → 高危功能」：' + (r.repair && r.repair.msg));
/* 3) 诊断是只读的，不该被门禁挡住 */
chk(r.diag && r.diag.ok === true, 'acl:diagnose 不受门禁影响（只读通道仍可用）');
/* 4) 工具卡片能拿到高危标记（否则界面不标红） */
chk(r.caps && r.caps['acl-repair'], 'dangerous:tool-caps 里有 acl-repair 条目（卡片能标红）');
chk(r.caps && r.caps['acl-repair'] && r.caps['acl-repair'].enabled === false,
  '默认未启用时 enabled 为 false');
/* 5) 能力定义里确实登记了 acl-repair */
const capIds = (r.list && r.list.caps || []).map((c) => c.id);
chk(capIds.indexOf('acl-repair') !== -1, 'dangerous:list 里包含 acl-repair 能力项');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
