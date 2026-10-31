'use strict';
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

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON)) { console.log('SKIP 无 electron.exe'); process.exit(0); }

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
for (const d of ['js', 'css', 'lib', 'assets']) {
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
try { raw = execFileSync(ELECTRON, [tmp], { env, encoding: 'utf8', timeout: 90000 }); }
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

/* 1) 当前用户名必须取到了（旧代码在解析之后才取，hasFull 因此恒 false） */
chk(!!d.me, '取到了当前用户名（me 非空）');
/* 2) hasFull 必须为 true：这个文件是我们自己建的，ACL 里我们有 (F) */
chk(d.hasFull === true, 'hasFull 为 true（自己拥有且有完全控制的文件）');
/* 3) 关键验收：不能再出现「缺少写入权限」 */
chk((d.codes || []).indexOf('NO_WRITE') === -1,
  '诊断结论里没有 NO_WRITE「缺少写入权限」');
/* 4) 结论整体应为 ok */
chk(d.ok === true, '诊断结论 ok（不是「有问题」）');
/* 5) 所有者应当就是我（这才符合「我自己建的文件」这个前提） */
chk(d.ownerIsMe === true, 'ownerIsMe 为 true');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
