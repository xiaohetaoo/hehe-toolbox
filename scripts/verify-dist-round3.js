'use strict';
/* 校验打包产物确实包含本轮（破坏性 bug 审查）的全部修复。
 * 用法：node scripts/verify-dist-round3.js
 */
const AdmZip = require('adm-zip');
const fs = require('fs');
const { readTree } = require('./lib/harness');
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
/* 【搬走的模块要单独读】rec:* / ffmpeg:* 域在任务 6 搬到了 ipc/media-ffmpeg.js。
 * 校验脚本必须跟着读那里，否则断言永远是假红 —— 而假红到最后就是整段被忽略。 */
const mediaSrc = read('ipc/media-ffmpeg.js') || read('ipc\\media-ffmpeg.js') || '';
const tempNamesSrc = read('lib/temp-names.js') || read('lib\\temp-names.js') || '';
chk(!!mediaSrc, 'ipc/media-ffmpeg.js 可读（rec/ffmpeg 域的实际位置）');
chk(!!tempNamesSrc, 'lib/temp-names.js 可读（暂存目录构造的实际位置）');
chk(!!main, 'main.js 可读');

/* --- 本轮核心修复 --- */
chk(main.includes('lib/path-guard'), '已引入 path-guard 模块');
chk(main.includes('async function writeFileAtomic'), '有原子写函数');
chk(!/fsp\.rm\(dest, \{ force: true \}\)\.catch\(\(\) => \{\}\);\s*\n\s*await fsp\.rename\(tmp, dest\)/.test(main),
  'writeFileAtomic 不再「先删后改名」');
chk(main.includes('.hehe-bak-'), 'writeFileAtomic 有备份中转');
/* 【rec:stop 的降级保护现在在 ipc/media-ffmpeg.js，不在 main.js】
 * 这条断言原来查 main.js，任务 6 把 rec:* 域整体搬走后它就永远假红。
 * 但一个「反正一直红」的构建产物校验等于没有校验 —— 人会直接忽略它。
 * 改成查真正的位置，并且**搬走这件事本身也要断言**（否则哪天又搬回来，
 * 这条会静默变成永真）。 */
chk(/if \(!degraded\) \{\s*\n\s*await fsp\.rm\(recSegDir/.test(mediaSrc.replace(/\r/g, '')),
  'rec:stop 降级时保留分段（实现在 ipc/media-ffmpeg.js）');
/* 同时确认它确实搬走了：两个都查，防止「两处都有」或「两处都没有」 */
chk(!/if \(!degraded\) \{\s*\n\s*await fsp\.rm\(recSegDir/.test(main.replace(/\r/g, '')),
  'rec:stop 已整体搬到 ipc/media-ffmpeg.js（不应在 main.js 里再留一份）');
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
/* 【staging 现在通过 lib/temp-names.js 的 sevenStagingDir(outDir) 构造】
 * 原来断言的是 `const staging = path.join(outDir,` —— 把「7z 暂存目录」这个
 * 实现细节抽到 temp-names 之后，这个字面形态就不存在了。
 * 断言真正要守的是「暂存目录跟 outDir 同卷」，所以改成查两件事：
 *   ① main.js 调用了 sevenStagingDir(outDir)
 *   ② temp-names.js 里那个函数确实把目录建在 baseDir 下（而不是 %TEMP%） */
chk(/const staging = tempNames\.sevenStagingDir\(outDir\)/.test(main),
  'staging 由 sevenStagingDir(outDir) 构造（不得退回 %TEMP%）');
chk(/function sevenStagingDir\s*\(outDir/.test(tempNamesSrc) &&
   /return outDir \? path\.join\(outDir, name\)/.test(tempNamesSrc),
  'sevenStagingDir 建在传入的 outDir 下（同卷），不退回 %TEMP%');
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

const media = readTree('js/tools/media') || '';
/* 锁的是「打包后 media 工具目录里的路径归一化函数被漏掉/改名」这个回归：
 * 它是 media 全家（压缩/去重/水印）处理长路径与中文路径的共同前提。
 * 只能看源码形态 —— 真跑要一张 260 字符以上的深路径素材。 */
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
