'use strict';
/* 校验打包产物确实包含本轮（破坏性 bug 审查）的全部修复。
 * 用法：node scripts/verify-dist-round3.js
 */
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const os = require('os');
const asarLib = require('@electron/asar');

const BS = String.fromCharCode(92);
const distDir = path.join(__dirname, '..', 'dist');
const zips = fs.readdirSync(distDir).filter((n) => /^hehe-toolbox-.*-win-x64\.zip$/.test(n));
if (!zips.length) { console.log('dist 里没有 zip 产物'); process.exit(1); }
const zipPath = path.join(distDir, zips[0]);
console.log('校验对象:', zips[0]);

const z = new AdmZip(zipPath);
const ent = z.getEntries().find((e) => /resources.app\.asar$/.test(e.entryName));
if (!ent) { console.log('未找到 app.asar'); process.exit(1); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vd3-'));
const asarPath = path.join(tmp, 'app.asar');
fs.writeFileSync(asarPath, ent.getData());

function read(rel) {
  const cands = [rel, BS + rel, rel.replace(/\//g, BS), BS + rel.replace(/\//g, BS)];
  for (const c of cands) { try { return asarLib.extractFile(asarPath, c).toString('utf8'); } catch (e) {} }
  return null;
}

let pass = 0, fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; else pass++; };

const pkg = JSON.parse(read('package.json') || '{}');
/* 版本号从源码 package.json 动态取，不再硬编码 —— 硬编码会让每次发版这个
   校验必然 FAIL，久而久之就被当成"本来就失败"而忽略掉，校验形同虚设。 */
const wantVer = require(path.join(__dirname, '..', 'package.json')).version;
chk(pkg.version === wantVer, '包内版本 = ' + wantVer + '（实际 ' + pkg.version + '）');

const main = read('main.js') || '';
chk(!!main, 'main.js 可读');

/* --- 本轮核心修复 --- */
chk(main.includes('lib/path-guard'), '已引入 path-guard 模块');
chk(main.includes('async function writeFileAtomic'), '有原子写函数');
chk(!/fsp\.rm\(dest, \{ force: true \}\)\.catch\(\(\) => \{\}\);\s*\n\s*await fsp\.rename\(tmp, dest\)/.test(main),
  'writeFileAtomic 不再「先删后改名」');
chk(main.includes('.hehe-bak-'), 'writeFileAtomic 有备份中转');
chk(/if \(!degraded\) \{\s*\n\s*await fsp\.rm\(recSegDir/.test(main.replace(/\r/g, '')), 'rec:stop 降级时保留分段');
chk(main.includes('copyFile(tmp, HOSTS_PATH)'), 'hosts 兜底会先用 tmp 补回');
chk(main.indexOf('copyFile(tmp, HOSTS_PATH)') < main.indexOf("rm(tmp, { force: true })", main.indexOf('copyFile(tmp, HOSTS_PATH)')),
  'hosts 兜底顺序正确（先补再删）');
chk(main.includes('ownOnly: true'), '垃圾扫描只列本应用产物');
chk(main.includes('isOwnTempName') && main.includes('tmpRoot'), 'clean-junk 有 %TEMP% 闸门');
chk(main.includes('$launched'), '升级脚本启动失败时保留包');
chk(main.includes('$srcLen'), '升级脚本校验替换后大小');
chk(main.includes('$stamp'), '升级脚本保留历史备份');
chk(main.includes('hehe-7zx-') && !/hehe-7zx-' \+ Date\.now\(\)[^;]*app\.getPath\('temp'\)/.test(main),
  'seven:extract 暂存目录不再放 %TEMP%');
chk(main.includes('const staging = path.join(outDir,'), 'staging 建在 outDir 下（同卷）');
chk(main.includes('BOMB_RATIO') || main.includes('compressedSize'), 'zip 解压传入压缩比信息');
chk(main.includes('清单文件损坏：分片数量非法'), 'merge-parts 校验 parts');
chk(main.includes('源文件在分割期间发生变化'), 'split 校验源文件未变');
chk(main.includes('if (fs.existsSync(outZip))'), 'zip:compress 拒绝覆盖');
chk(main.includes('used.has(entryName.toLowerCase())'), 'zip:compress 同名不丢');

const guardFile = read('lib/path-guard.js') || '';
chk(!!guardFile, 'lib/path-guard.js 已打包');
chk(guardFile.includes('normalizeForCompare'), 'path-guard 有尾点归一化');
chk(guardFile.includes('checkDeletable') && guardFile.includes('checkOverwritable'), 'path-guard 导出完整');

const arch = read('lib/archive-guard.js') || '';
chk(arch.includes('maxRatio'), 'archive-guard 有压缩比限额');
chk(arch.includes('maxEntryBytes'), 'archive-guard 有单条目上限');
chk(/maxTotalBytes:\s*8\s*\*\s*1024/.test(arch), '总大小上限收紧到 8GB');

const office = read('js/tools/office.js') || '';
chk(office.includes('-split-' + "' + stamp") || office.includes("-split-' + stamp"), 'PDF 拆分目录带时间戳');

const media = read('js/tools/media.js') || '';
chk(media.includes('function normAbs'), 'media.js 有路径归一化函数');

/* --- 重复注册检查 --- */
const re = /handle\('([^']+)'/g;
const seen = new Map();
let m;
while ((m = re.exec(main))) {
  if (!seen.has(m[1])) seen.set(m[1], 0);
  seen.set(m[1], seen.get(m[1]) + 1);
}
const dups = [...seen.entries()].filter(([, n]) => n > 1);
chk(dups.length === 0, '没有重复注册的 IPC 通道' + (dups.length ? '（' + dups.map(d => d[0]).join(',') + '）' : ''));
console.log('  IPC 通道数:', seen.size);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
