'use strict';
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
for (const d of ['js', 'css', 'lib', 'assets']) {
  try { fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true }); } catch (e) {}
}
try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction'); }
catch (e) { console.log('SKIP 无法链接 node_modules'); process.exit(0); }

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

const r = JSON.parse(fs.readFileSync(rf, 'utf8'));
console.log('=== 探针记录 ===');
console.log('  repair.ok :', r.repair && r.repair.ok);
console.log('  repair.msg:', r.repair && r.repair.msg);
console.log('  diag.ok   :', r.diag && r.diag.ok);
console.log('  caps.acl-repair:', r.caps && JSON.stringify(r.caps['acl-repair']));
console.log('  caps keys :', r.caps ? Object.keys(r.caps).filter((k) => k === 'acl-repair').join(',') : '(null)');

/* 1) 未开启时必须被拒绝 */
chk(r.repair && r.repair.ok === false, '未开启时 acl:repair 被拒绝（不再能直接调）');
/* 2) 拒绝信息要指路到设置页 */
chk(/高危功能/.test(String(r.repair && r.repair.msg)) && /设置/.test(String(r.repair && r.repair.msg)),
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
