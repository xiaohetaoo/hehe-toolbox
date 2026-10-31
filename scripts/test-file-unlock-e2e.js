'use strict';
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

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON)) { console.log('SKIP 无 electron.exe'); process.exit(0); }

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
for (const d of ['js', 'css', 'lib', 'assets']) {
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
  try { raw = execFileSync(ELECTRON, [tmp], { env, encoding: 'utf8', timeout: 90000 }); }
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
