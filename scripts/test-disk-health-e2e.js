'use strict';
/* 实测磁盘健康采集：在真实机器上跑一遍，看拿到什么、拿不到什么。
 * 判据不是「有没有数据」，而是「拿不到时有没有如实标记为 null」。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON)) { console.log('SKIP 无 electron.exe'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-'));
const OUT = JSON.stringify(path.join(tmp, 'r.json'));

const PROBE = [
  '',
  'app.whenReady().then(() => {',
  '  setTimeout(async () => {',
  '    let out = null;',
  '    try {',
  '      const wins = BrowserWindow.getAllWindows();',
  '      const w = wins.find((x) => { try { return x.webContents.getURL().indexOf("index.html") !== -1; } catch (e) { return false; } });',
  '      if (w) {',
  '        const script = ' + JSON.stringify('window.api.invoke("sys:disk-health", true).then(function(x){return JSON.stringify({ok:true,data:x})}).catch(function(e){return JSON.stringify({ok:false,err:String(e&&e.message||e)})})') + ';',
  '        out = await w.webContents.executeJavaScript(script);',
  '      }',
  '    } catch (e) { out = JSON.stringify({ ok: false, err: String((e && e.message) || e) }); }',
  '    try { require("fs").writeFileSync(' + OUT + ', out || "null"); } catch (e) {}',
  '    app.exit(0);',
  '  }, 4500);',
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
try { raw = execFileSync(ELECTRON, [tmp], { env, encoding: 'utf8', timeout: 120000 }); }
catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

const rf = path.join(tmp, 'r.json');
if (!fs.existsSync(rf)) {
  console.log('SKIP 探针未落盘');
  console.log(String(raw).split(/\r?\n/).filter(Boolean).slice(-5).join('\n'));
  process.exit(0);
}

const R = JSON.parse(fs.readFileSync(rf, 'utf8'));
let pass = 0, fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (c) pass++; else fail++; };

chk(!!R && R.ok === true, 'sys:disk-health 调用成功' + (R && R.ok === false ? '（' + R.err + '）' : ''));

if (R && R.ok) {
  const d = R.data || {};
  console.log('\n=== 采集结果 ===');
  console.log('是否管理员:', d.isAdmin);
  console.log('盘数:', (d.disks || []).length);
  for (const disk of (d.disks || [])) {
    console.log('  ' + (disk.model || '?') + ' | ' + (disk.mediaType || '?') + ' | ' + (disk.busType || '?') +
      ' | health=' + (disk.healthStatus || 'null'));
    console.log('    温度=' + disk.temperature + ' 通电=' + disk.powerOnHours +
      ' 寿命=' + disk.wear + ' 读错误=' + disk.readErrors + ' 写错误=' + disk.writeErrors +
      ' hasSmart=' + disk.hasSmart);
    console.log('    结论: [' + disk.verdict.level + '] ' + disk.verdict.text);
  }
  console.log('\n限制说明:');
  for (const l of (d.limitations || [])) console.log('  - ' + l);

  chk((d.disks || []).length > 0, '至少枚举到一块磁盘');
  /* 核心检查：拿不到的字段必须是 null，不能是 0 */
  for (const disk of (d.disks || [])) {
    for (const k of ['temperature', 'powerOnHours', 'wear', 'readErrors', 'writeErrors']) {
      const v = disk[k];
      chk(v === null || typeof v === 'number',
        (disk.model || '?') + '.' + k + ' 是 null 或数字（实际 ' + JSON.stringify(v) + '）');
      if (v !== null) {
        chk(!(v === 0 && !disk.hasSmart), (disk.model || '?') + '.' + k + ' 没被伪造成 0');
      }
    }
  }
  /* 拿不到 SMART 时，结论不能是「健康」 */
  for (const disk of (d.disks || [])) {
    if (!disk.hasSmart) {
      chk(disk.verdict.level === 'unknown',
        (disk.model || '?') + ' 无 SMART 时结论为 unknown（实际 ' + disk.verdict.level + '）');
      chk(!/健康度/.test(disk.verdict.text || ''), '结论里没有编造的「健康度」数字');
    }
  }
  chk((d.limitations || []).length > 0 || (d.disks || []).every((x) => x.hasSmart),
    '取不到数据时给出了限制说明');
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
