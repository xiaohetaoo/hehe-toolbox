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
const fsOpsSrc = read('ipc/fs-ops.js') || read('ipc\\fs-ops.js') || '';
chk(!!tempNamesSrc, 'lib/temp-names.js 可读（暂存目录构造的实际位置）');
chk(!!fsOpsSrc, 'ipc/fs-ops.js 可读（fs:* / zip:* 域的实际位置）');
chk(!!main, 'main.js 可读');

/* 【主进程侧全量源码：main.js + 搬出去的各个域】
 * 下面那批断言的语义是「打包后的主进程里有没有这个实现」，
 * 与它在 main.js 还是 ipc/*.js 无关。任务 5/6/7 搬走三个域之后，
 * 只查 main.js 会让它们全部变成永久假红 —— 而假红到最后就是整段被忽略。 */
const mainAll = [main, mediaSrc, fsOpsSrc].join(String.fromCharCode(10));

/* --- 本轮核心修复 --- */
chk(main.includes('lib/path-guard'), '已引入 path-guard 模块');
chk(mainAll.includes('async function writeFileAtomic'), '有原子写函数');
chk(!/fsp\.rm\(dest, \{ force: true \}\)\.catch\(\(\) => \{\}\);\s*\n\s*await fsp\.rename\(tmp, dest\)/.test(main),
  'writeFileAtomic 不再「先删后改名」');
  /* 锁的是「原子写没有备份中转」—— 目标已存在时 rename 会失败，
   * 没有 .hehe-bak- 中转就只能先删后改，中途失败原文件就没了。 */
chk(mainAll.includes('.hehe-bak-'), 'writeFileAtomic 有备份中转');
/* 【rec:stop 的降级保护现在在 ipc/media-ffmpeg.js，不在 main.js】
 * 任务 6 搬走后这条原来永远假红 —— 而「反正一直红」的校验等于没有校验。
 * 改成查真正位置，同时断言它确实搬走了（否则哪天搬回来会变成永真）。 */
/* 锁的是「降级时删掉分段目录」—— 只保住第一段时删掉，等于销毁剩下的录像。 */
chk(/if \(!degraded\) \{\s*\n\s*await fsp\.rm\(recSegDir/.test(mediaSrc.replace(/\r/g, '')),
  'rec:stop 降级时保留分段（实现在 ipc/media-ffmpeg.js）');
/* 同时确认它确实搬走了：两个都查，防止「两处都有」或「两处都没有」 */
chk(!/if \(!degraded\) \{\s*\n\s*await fsp\.rm\(recSegDir/.test(main.replace(/\r/g, '')),
  'rec:stop 已整体搬到 ipc/media-ffmpeg.js（不应在 main.js 里再留一份）');
chk(main.includes('copyFile(tmp, HOSTS_PATH)'), 'hosts 兜底会先用 tmp 补回');
chk(main.indexOf('copyFile(tmp, HOSTS_PATH)') < main.indexOf("rm(tmp, { force: true })", main.indexOf('copyFile(tmp, HOSTS_PATH)')),
  'hosts 兜底顺序正确（先补再删）');
  /* 锁的是「垃圾扫描列出别人的文件」—— ownOnly 是唯一那道闸门。
   * 真跑要往 %TEMP% 里放别人的文件，会污染真实环境。 */
chk(mainAll.includes('ownOnly: true'), '垃圾扫描只列本应用产物');
  /* 锁的是「clean-junk 缺 %TEMP% 闸门」—— 没有它就会删到全盘临时文件。
   * 真跑是不可逆的数据销毁，只能用源码断言。 */
chk(mainAll.includes('isOwnTempName') && mainAll.includes('tmpRoot'), 'clean-junk 有 %TEMP% 闸门');
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
  /* 锁的是「解压没有压缩比上限」（zip 炸弹）—— 真跑要造一个炸弹包。 */
chk(mainAll.includes('BOMB_RATIO') || mainAll.includes('compressedSize'), 'zip 解压传入压缩比信息');
  /* 锁的是「merge-parts 不校验 parts 清单」—— 缺了它会把残缺的合并结果
   * 当成完整文件写出去。真跑要伪造一份损坏的清单。 */
chk(mainAll.includes('清单文件损坏：分片数量非法'), 'merge-parts 校验 parts');
  /* 锁的是「split 不校验源文件未变」—— 分割期间源被改动会得到无法还原的
   * 分片。真跑要制造竞态。 */
chk(mainAll.includes('源文件在分割期间发生变化'), 'split 校验源文件未变');
  /* 锁的是「zip:compress 静默覆盖已有文件」—— 用户原有压缩包会被毁。 */
chk(mainAll.includes('if (fs.existsSync(outZip))'), 'zip:compress 拒绝覆盖');
  /* 锁的是「zip:compress 同名条目丢失」—— 大小写不同的同名文件会被合并成一个。
   * 真跑要造一个含 A.txt 与 a.txt 的目录树。 */
chk(mainAll.includes('used.has(entryName.toLowerCase())'), 'zip:compress 同名不丢');

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

/* --- 重复注册检查 ---
 * 通道在 v0.4.2 全部换成了 CH.<组>.<键> 常量，所以这里要同时扫字面量与常量，
 * 否则「重复注册」这项检查会退化成「一次都没扫到」然后永远通过（最糟的假绿）。
 * 统计时把常量路径还原成真实通道名，才能真的比较是否重复。 */
const chTable = require('../lib/channels').flatten();
const re = /handle\('([^']+)'/g;
const reConst = /handle\((?:dirMoveCh|CH)\.([A-Z0-9_]+)\.([A-Z0-9_]+)\s*,/g;
const seen = new Map();
let m;
while ((m = re.exec(main))) {
  if (!seen.has(m[1])) seen.set(m[1], 0);
  seen.set(m[1], seen.get(m[1]) + 1);
}
while ((m = reConst.exec(main))) {
  const key = m[1] + '.' + m[2];
  const name = chTable[key] || ('(未登记 ' + key + ')');
  if (!seen.has(name)) seen.set(name, 0);
  seen.set(name, seen.get(name) + 1);
}
const dups = [...seen.entries()].filter(([, n]) => n > 1);
chk(dups.length === 0, '没有重复注册的 IPC 通道' + (dups.length ? '（' + dups.map(d => d[0]).join(',') + '）' : ''));
console.log('  IPC 通道数:', seen.size);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
