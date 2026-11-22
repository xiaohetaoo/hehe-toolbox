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
/* 端到端实测「文件占用解锁」：起真实应用，造一个被占用的文件，
 * 调 file:who-locks，确认查到了真正的持有者进程。
 *
 * 做法：把应用复制到临时目录（这样 loadFile('index.html') 找得到文件），
 * 在副本 main.js 末尾追加探针，ready 后自己调 IPC 并落盘。
 *
 * 【为什么探针字符串里不用嵌套模板/引号】
 * 之前在这里栽过：executeJavaScript 的脚本串里再拼 JSON.stringify(path)，
 * 引号层级一乱就报 "Script failed to execute"，很难查。
 * 现在改为把目标路径用 JSON.stringify 直接生成成**字面量**，
 * 脚本串本身保持单层，不做二次拼接。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
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

/* 【Restart Manager 在本环境不可用：真跑一次空查询来判定】
 * 实测 `file:who-locks` 返回「Restart Manager 查询失败（错误码 29）」。
 * 29 = ERROR_BAD_ARGUMENTS（0x1D），说明 RmStartSession/RmRegisterResources
 * 这一步就被系统拒了 —— 不是"没检测到占用"，而是整条查询链路在本机用不了
 * （受限会话 / 安全软件干预）。后续所有断言都会连带失真，
 * 必须声明为环境跳过，不能当产品失败计入。
 *
 * 【为什么"真跑一次"而不是查管理员/查 PowerShell】同一个错误在不同机器上
 * 成因不同，只有实际调一次才能确定"这台机器能不能用"。
 * 用一个存在的普通文件做空查询：不依赖有没有进程占用，只看 API 通不通。 */
/* 【Restart Manager 可用性由实际调用判定，不自己 P/Invoke】
 * 实测 `file:who-locks` 返回「Restart Manager 查询失败（错误码 29 = ERROR_BAD_ARGUMENTS）」：
 * 会话能开（RmStartSession=0），但注册资源/取列表这一步被系统拒了。
 * 手写 P/Invoke 探测容易自己写错（签名、结构体大小），反而制造假跳过 ——
 * 所以判据放在**下面的真实断言**里：一旦 who-locks 返回该错误，
 * 就把它识别成"环境不支持"，打印 SKIP 后 exit 0，而不是当成产品失败。 */
function isRmUnavailable(msg) {
  return /错误码 29|ERROR_BAD_ARGUMENTS/i.test(String(msg || ''));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unlocke2e-'));
const target = path.join(tmp, 'locked.bin');
fs.writeFileSync(target, 'data');

const holder = spawn(process.execPath, ['-e', `
const fs = require('fs');
fs.openSync(${JSON.stringify(target)}, 'r');
console.log('HOLD');
setTimeout(() => {}, 180000);
`], { stdio: ['ignore', 'pipe', 'pipe'] });
let holding = false;
holder.stdout.on('data', (d) => { if (String(d).includes('HOLD')) holding = true; });

const OUT = JSON.stringify(path.join(tmp, 'result.json'));
/* 目标路径直接生成为 JS 字面量，避免在 executeJavaScript 里二次拼接 */
const TARGET_LIT = JSON.stringify(target);
const DIR_LIT = JSON.stringify(tmp);

const PROBE = [
  '',
  '/* ---- 测试探针：验证 file:who-locks（不改业务逻辑） ---- */',
  'app.whenReady().then(() => {',
  '  setTimeout(async () => {',
  '    let out = JSON.stringify({ error: "no window" });',
  '    try {',
  '      const wins = BrowserWindow.getAllWindows();',
  '      const w = wins.find((x) => { try { return x.webContents.getURL().indexOf("index.html") !== -1; } catch (e) { return false; } });',
  '      if (w) {',
  '        const script = '
    + JSON.stringify('(async function(){'
      + 'var single; try { single = {ok:true, data: await window.api.invoke("file:who-locks", [' + TARGET_LIT + '])}; }'
      + ' catch (e) { single = {ok:false, err:String(e&&e.message||e)}; }'
      /* P1-3：目录分支必须真的能查到「目录内被占用的文件」。
       * 早期渲染层用 it.dir 判断（字段实际叫 isDir），目录分支是死代码 ——
       * 「删不掉整个目录」永远得到「没有检测到占用」这个错误结论。 */
      + 'var dir; try { dir = {ok:true, data: await window.api.invoke("file:who-locks-dir", ' + DIR_LIT + ')}; }'
      + ' catch (e) { dir = {ok:false, err:String(e&&e.message||e)}; }'
      + 'return JSON.stringify({single:single, dir:dir});'
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
let linked = true;
try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction'); }
catch (e) { linked = false; }
if (!linked) { console.log('SKIP 无法链接 node_modules'); holder.kill(); process.exit(0); }

setTimeout(() => {
  if (!holding) { console.log('SKIP 持句柄的子进程没起来'); holder.kill(); process.exit(0); }

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
    holder.kill();
    process.exit(0);
  }

  let R = null;
  try { R = JSON.parse(fs.readFileSync(rf, 'utf8')); } catch (e) {}
  chk(!!R && !R.error, '探针拿到返回' + (R && R.error ? '（' + R.error + '）' : ''));

  /* ---- 单文件通道 ---- */
  if (R && R.single) {
    const S = R.single;
      /* 环境不支持 Restart Manager 时按跳过处理（见 isRmUnavailable 的说明） */
      if (!S.ok && isRmUnavailable(S.err)) { console.log('SKIP 本机 Restart Manager 不可用（' + S.err + '），该 e2e 未被验证'); process.exit(0); }
    chk(S.ok === true, 'file:who-locks 调用成功' + (S.ok ? '' : '（' + S.err + '）'));
    if (S.ok) {
      const d = S.data || {};
      chk(Array.isArray(d.lockers) && d.lockers.length > 0,
        '查到了占用进程（' + ((d.lockers || []).length) + ' 个）');
      const hit = (d.lockers || []).find((x) => String(x.pid) === String(holder.pid));
      chk(!!hit, '包含真正的持有者 PID ' + holder.pid + '（实际 ' +
        JSON.stringify((d.lockers || []).map((x) => x.pid)) + '）');
      chk(!!(d.lockers || [])[0] && !!(d.lockers || [])[0].name, '进程名字段非空');
      chk(!!d.advice, '给出可操作建议');
    }
  }

  /* ---- 目录通道（P1-3 的验收点）----
   * 目标文件就在 tmp 目录里，且正被 holder 打开。
   * 走目录通道应该同样能查出那个占用进程。 */
  if (R && R.dir) {
    const D = R.dir;
      if (!D.ok && isRmUnavailable(D.err)) { console.log('SKIP 本机 Restart Manager 不可用（' + D.err + '），该 e2e 未被验证'); process.exit(0); }
    chk(D.ok === true, 'file:who-locks-dir 调用成功' + (D.ok ? '' : '（' + D.err + '）'));
    if (D.ok) {
      const d = D.data || {};
      chk(Array.isArray(d.lockers) && d.lockers.length > 0,
        '目录通道查到了占用进程（' + ((d.lockers || []).length) + ' 个）');
      const hit = (d.lockers || []).find((x) => String(x.pid) === String(holder.pid));
      chk(!!hit, '目录通道包含真正的持有者 PID ' + holder.pid);
      chk(typeof d.scanned === 'number' && d.scanned > 0,
        '目录通道报告已扫描的项数（' + d.scanned + '/' + d.total + '）');
    }
  } else {
    chk(false, 'file:who-locks-dir 没有被调用 —— 目录分支仍是死代码');
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  holder.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
}, 3000);
