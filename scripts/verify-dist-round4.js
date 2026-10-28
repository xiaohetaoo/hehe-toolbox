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
chk(main.includes('passlogFile'), '主进程使用 passlogfile');
chk(main.includes('pass1Done'), '主进程有「分析只做一次」的复用开关');
chk(main.includes('buildSinglePassArgs'), '分析失败能回退单遍');
// 两遍路径不该再叠 maxrate（会与两遍法的码率控制打架）
chk(!/buildPass2Args[\s\S]{0,600}-maxrate/.test(main), '两遍路径未叠加 maxrate');

/* ---- 渲染层文案如实反映两遍法 ---- */
const tsui = read('js/tools/target-size.js') || '';
chk(tsui.includes('两遍编码'), '界面说明了使用两遍编码');

/* ---- 安装包命名守卫仍在 ----
 * 注意：asar 里的 package.json 是被 electron-builder 裁剪过的（build 字段被移除），
 * 所以这里必须读**源码**的 package.json，不能读包内的。 */
const srcPkg = require(path.join(__dirname, '..', 'package.json'));
const nsisName = srcPkg.build && srcPkg.build.nsis && srcPkg.build.nsis.artifactName;
chk(!!nsisName && /^[\x20-\x7E]+$/.test(nsisName), 'nsis.artifactName 为 ASCII：' + nsisName);

/* ---- 不重复注册 ---- */
const handles = main.match(/^handle\('/gm) || [];
chk(handles.length >= 150, 'IPC 通道数正常（' + handles.length + '）');
const names = (main.match(/^handle\('([^']+)'/gm) || []).map(s => s.replace(/^handle\('/, '').replace(/'$/, ''));
chk(new Set(names).size === names.length, '没有重复注册的 IPC 通道（' + names.length + ' 个）');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
cleanup();
process.exit(fail === 0 ? 0 : 1);
