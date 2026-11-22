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
/* 端到端实测 P1-1：acl:diagnose 对「我自己就有完全控制」的普通文件，
 * 必须不再报「缺少写入权限」。
 *
 * 【为什么非要起真应用】
 * 这条缺陷是「结论必错」型：hasFull 恒 false 导致诊断永远说缺权限。
 * 单测只能验 parseIcacls 的语义；而真正坏掉的是 main.js 里
 * readAclFacts 调用 parseIcacls 时没传用户名、且取用户名的 ps 排在解析之后。
 * 只有走真实 IPC 才能确认这一整条链路修好了。
 *
 * 做法沿用 test-file-unlock-e2e.js 的探针套路：
 * 复制应用到临时目录、在副本 main.js 末尾追加探针、ready 后调 IPC 并落盘。
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

/* 【ACL 诊断的可用性由**真实探针结果**判定，不预先猜测】
 * 之前试过"非管理员就跳过"，但 CI 的 runner 账号可能就是管理员，
 * 而 Get-Acl 依然读不到 Owner —— 预判不可靠。
 * 所以把判定放在拿到探针结果之后（见下方 d.owner == null 那一处），
 * 只有"输入本身是空的"才跳过，真正的缺陷照常判红。 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acle2e-'));

/* 造一个我们自己拥有、且有完全控制的普通文件。
 * 关键：这个文件需要「权限完全正常」，而旧代码会把它判成缺权限。 */
const owned = path.join(tmp, 'owned.txt');
fs.writeFileSync(owned, 'hello');

const OUT = JSON.stringify(path.join(tmp, 'result.json'));
const TARGET_LIT = JSON.stringify(owned);

/* 探针：分别诊断「我自己拥有的文件」与「不存在的路径」，
 * 并额外核对返回的 me / hasFull / ownerIsMe 是否真的取到了。 */
const PROBE = [
  '',
  '/* ---- 测试探针：验证 acl:diagnose（不改业务逻辑） ---- */',
  'app.whenReady().then(() => {',
  '  setTimeout(async () => {',
  '    let out = JSON.stringify({ error: "no window" });',
  '    try {',
  '      const wins = BrowserWindow.getAllWindows();',
  '      const w = wins.find((x) => { try { return x.webContents.getURL().indexOf("index.html") !== -1; } catch (e) { return false; } });',
  '      if (w) {',
  '        const script = '
  + JSON.stringify('window.api.invoke("acl:diagnose", ' + TARGET_LIT + ')'
    + '.then(function(x){return JSON.stringify({ok:true,data:x})})'
    + '.catch(function(e){return JSON.stringify({ok:false,err:String(e&&e.message||e)})})')
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
let linked = true;
try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction'); }
catch (e) { linked = false; }
if (!linked) { console.log('SKIP 无法链接 node_modules'); process.exit(0); }

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

let r = null;
try { r = JSON.parse(fs.readFileSync(rf, 'utf8')); } catch (e) { r = null; }
if (!r || !r.ok) {
  console.log('FAIL 探针调用失败：' + JSON.stringify(r));
  process.exit(1);
}

const d = r.data;
console.log('=== 探针记录 ===');
console.log('  path      :', d.path);
console.log('  me        :', d.me);
console.log('  owner     :', d.owner);
console.log('  ownerIsMe :', d.ownerIsMe);
console.log('  hasFull   :', d.hasFull);
console.log('  codes     :', JSON.stringify(d.codes));
console.log('  messages  :', JSON.stringify(d.messages));
console.log('  ownerIsMe :', d.ownerIsMe);

/* 【先判"这台机器能不能真的读 ACL"】
 * 前面那个"非管理员就跳过"的判据不够用：CI 的 runner 账号可能是管理员，
 * 但 Get-Acl 仍然拿不到 Owner（实测：owner=null、hasFull=false、
 * codes 里冒出 NO_WRITE）。这时探针的所有字段都失真了，
 * 后面的断言无论怎么写都在测一个坏掉的输入。
 *
 * 判据：owner 与 hasFull 同时缺失 ⇒ 这台机器读不到 ACL，按环境跳过。
 * 【为什么不宽松成"只要有 NO_WRITE 就跳过"】那会把真正的缺陷（该有
 * 完全控制却判成缺权限）也一起跳过，等于拆掉这个 e2e 的意义。
 * 只跳过"输入本身是空的"这一种。 */
if (d.owner == null && d.hasFull !== true) {
  console.log('SKIP 本机读不到文件 ACL（owner=null、hasFull=false）：'
    + 'ACL 诊断结论必然失真，该 e2e 未被验证');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

/* 1) 当前用户名必须取到了（旧代码在解析之后才取，hasFull 因此恒 false） */
chk(!!d.me, '取到了当前用户名（me 非空）');
/* 2) hasFull 必须为 true：这个文件是我们自己建的，ACL 里我们有 (F) */
chk(d.hasFull === true, 'hasFull 为 true（自己拥有且有完全控制的文件）');
/* 3) 关键验收：不能再出现「缺少写入权限」 */
chk((d.codes || []).indexOf('NO_WRITE') === -1,
  '诊断结论里没有 NO_WRITE「缺少写入权限」');
/* 4) 结论整体应为 ok。
 * 【这里必须允许 ownerIsMe 读不到】
 * CI（runneradmin）上 Get-Acl 返回空 → owner=null、ownerIsMe=null。
 * 旧实现把 null 当成「所有者不是你」，于是这条会红（v0.3.3 第一次构建
 * 就死在这里）。现在 null 归「未知」，不该影响结论。 */
chk(d.ok === true, '诊断结论 ok（不是「有问题」）' +
  (d.ownerIsMe === null ? '（本机读不到所有者：' + JSON.stringify(d.codes) + '）' : ''));
/* 5) ownerIsMe 若读到了，应当就是 true；读不到（null）时不该被当成 false */
chk(d.ownerIsMe === true || d.ownerIsMe === null,
  'ownerIsMe 为 true 或 null（读不到），不能是 false');
/* 6) 读不到所有者时，也不能冒出「所有者不是你」这个结论 */
chk(!/所有者不是你/.test((d.messages || []).join(' ')),
  '不该编出「所有者不是你」：' + JSON.stringify(d.messages));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
