'use strict';
/* v0.1.6 打包态校验：确认 Electron 升级、两遍法、安装包命名都真的进了产物。
 * 用法：node scripts/verify-dist-round4.js
 *
 * 为什么要有这个：单元测试跑的是源码，打包后 asar 里少了文件、或构建脚本
 * 没把新模块收进去，单测照样全绿。这类"源码对、产物错"的问题只能这样抓。
 */
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const os = require('os');
const asarLib = require('@electron/asar');

const BS = String.fromCharCode(92);
const distDir = path.join(__dirname, '..', 'dist');
const zips = fs.readdirSync(distDir).filter(n => /^hehe-toolbox-.*-win-x64\.zip$/.test(n));
if (!zips.length) { console.log('dist 里没有 zip 产物，先构建'); process.exit(1); }
if (zips.length > 1) { console.log('dist 里有多个 zip，请先清理：' + zips.join(', ')); process.exit(1); }
const zipPath = path.join(distDir, zips[0]);
console.log('校验对象:', zips[0]);

const z = new AdmZip(zipPath);
const ent = z.getEntries().find(e => /resources.app\.asar$/.test(e.entryName));
if (!ent) { console.log('未找到 app.asar'); process.exit(1); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vd4-'));
const asarPath = path.join(tmp, 'app.asar');
fs.writeFileSync(asarPath, ent.getData());
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} };

function read(rel) {
  const cands = [rel, BS + rel, rel.replace(/\//g, BS), BS + rel.replace(/\//g, BS)];
  for (const c of cands) { try { return asarLib.extractFile(asarPath, c).toString('utf8'); } catch (e) {} }
  return null;
}

let pass = 0, fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; else pass++; };

/* ---- 版本 ---- */
const pkg = JSON.parse(read('package.json') || '{}');
const wantVer = require(path.join(__dirname, '..', 'package.json')).version;
chk(pkg.version === wantVer, '包内版本 = ' + wantVer + '（实际 ' + pkg.version + '）');

/* ---- 两遍法进了产物 ---- */
const lib = read('lib/target-size.js') || '';
chk(!!lib, 'lib/target-size.js 可读');
chk(lib.includes('buildPass1Args'), '含两遍法 pass1 参数构造');
chk(lib.includes('buildPass2Args'), '含两遍法 pass2 参数构造');
chk(lib.includes('buildSinglePassArgs'), '含单遍兜底参数构造');
chk(lib.includes("'-pass', '1'"), 'pass1 参数带 -pass 1');
chk(lib.includes("'-pass', '2'"), 'pass2 参数带 -pass 2');

const main = read('main.js') || '';
chk(!!main, 'main.js 可读');
/* 【这三项现在都在 ipc/media-ffmpeg.js，不在 main.js】
 * 任务 6 把 ffmpeg:* / target:* 域整体搬走了。原来查 main.js 的写法会让
 * 这三条永远假红 —— 而一个「反正一直红」的产物校验等于没有校验。
 * 改成读真正的位置；同时断言 main.js 里不再留副本（防止两处各一份）。 */
const mediaSrc = read('ipc/media-ffmpeg.js') || read('ipc\\media-ffmpeg.js') || '';
/* fs:* / zip:* 域（任务 7）也搬到了 ipc/fs-ops.js，通道计数要一起算 */
const fsOpsSrc = read('ipc/fs-ops.js') || read('ipc\\fs-ops.js') || '';
chk(!!fsOpsSrc, 'ipc/fs-ops.js 可读（fs/zip 域的实际位置）');
chk(!!mediaSrc, 'ipc/media-ffmpeg.js 可读（ffmpeg/target 域的实际位置）');
chk(mediaSrc.includes('passlogFile'), '两遍法使用 passlogfile（ipc/media-ffmpeg.js）');
chk(mediaSrc.includes('pass1Done'), '有「分析只做一次」的复用开关（ipc/media-ffmpeg.js）');
chk(mediaSrc.includes('buildSinglePassArgs'), '分析失败能回退单遍（ipc/media-ffmpeg.js）');
chk(!main.includes('passlogFile') && !main.includes('pass1Done'),
  '两遍法已整体搬到 ipc/media-ffmpeg.js（main.js 里不应再有副本）');
// 两遍路径不该再叠 maxrate（会与两遍法的码率控制打架）
chk(!/buildPass2Args[\s\S]{0,600}-maxrate/.test(mediaSrc), '两遍路径未叠加 maxrate');

/* ---- 渲染层文案如实反映两遍法 ---- */
const tsui = read('js/tools/target-size.js') || '';
chk(tsui.includes('两遍编码'), '界面说明了使用两遍编码');

/* ---- 安装包命名守卫仍在 ----
 * 注意：asar 里的 package.json 是被 electron-builder 裁剪过的（build 字段被移除），
 * 所以这里必须读**源码**的 package.json，不能读包内的。 */
const srcPkg = require(path.join(__dirname, '..', 'package.json'));
const nsisName = srcPkg.build && srcPkg.build.nsis && srcPkg.build.nsis.artifactName;
chk(!!nsisName && /^[\x20-\x7E]+$/.test(nsisName), 'nsis.artifactName 为 ASCII：' + nsisName);

/* ---- 不重复注册 ----
 * 【通道现在分两处注册】任务 5/6 把 dir-move、acl、ffmpeg、rec 等域搬到了
 * ipc/*.js，所以只扫 main.js 会漏掉 17 个。而且那两个文件里用的是
 * handle(dirMoveCh.X.Y) / handle(CH.X.Y) 这类常量键，字面量匹配也抓不到。
 * 这里改成「两处都扫 + 允许常量键」，与 test-ipc-channels.js 的口径一致。
 * 阈值也不再写死 140：真实总数由 main.js + ipc/*.js 现算，只防「掉了一半」。 */
function collectHandles(src) {
  const out = [];
  for (const m of src.matchAll(/^[ \t]*handle\('([^']+)'/gm)) out.push(m[1]);
  /* 【键名可能含数字】READ_FILE_B64 / L2S / S2L 这类键用 [A-Z_]+ 匹配不到，
   * 会把「已迁移」误算成 0 —— 表现为「IPC 通道数掉了」，其实一个没少。
   * 与 scripts/test-channels-sync.js、test-ipc-channels.js 的写法保持一致。 */
  for (const m of src.matchAll(/^[ \t]*handle\((?:dirMoveCh|CH)\.[A-Z0-9_]+\.\s*[A-Z0-9_]+\s*,/gm)) out.push(m[0].trim());
  return out;
}
const handles = collectHandles(main).concat(collectHandles(mediaSrc)).concat(collectHandles(fsOpsSrc));
chk(handles.length >= 150, 'IPC 通道数正常（main ' + collectHandles(main).length
  + ' + media ' + collectHandles(mediaSrc).length
  + ' + fs ' + collectHandles(fsOpsSrc).length + '）');
/* 重复判定只看字面量那些（常量键每处文本都不同，比进来没意义） */
const names = collectHandles(main).filter((n) => !/\bdirl?MoveCh|CH\./.test(n));
chk(new Set(names).size === names.length, 'main.js 里没有重复注册的字面量通道（' + names.length + ' 个）');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
cleanup();
process.exit(fail === 0 ? 0 : 1);
