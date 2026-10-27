#!/usr/bin/env node
'use strict';
/* 把 electron-builder 产出的 win-unpacked 目录压成 ASCII 命名的 zip（免安装目录版）。
 *
 * 为什么不直接用 electron-builder 的 zip target：
 *   1) electron-builder 26 的配置 schema 里没有 root 级 `zip` 配置项
 *      （写 "zip": { "artifactName": ... } 会被 validateSchema 直接拒绝）；
 *   2) 默认产名是「核核工具箱-0.0.10-win.zip」，含中文，
 *      而 GitHub Release 的 asset 名要求 ASCII。
 *   所以：electron-builder 只出 portable（顺带产出 win-unpacked），由本脚本再压一次。
 *
 * 用法：node scripts/pack-zip.js [win-unpacked 目录] [输出目录]
 *   默认 win-unpacked 与输出目录都取 package.json 里 build.directories.output（即 dist）。
 *
 * 为什么 -mx=5 而不是最大压缩：
 *   zip 版存在的意义就是「解压一次，之后启动快」。压缩率过高会明显拉长首次解压时间，
 *   而 5 级已经能把 300MB+ 压到 125MB 左右，是体积与解压速度的平衡点。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const outDir = path.resolve(root, process.argv[3] || pkg.build.directories.output || 'dist');
const srcDir = path.resolve(root, process.argv[2] || path.join(outDir, 'win-unpacked'));

if (!fs.existsSync(srcDir)) {
  console.error('[pack-zip] 找不到 win-unpacked 目录：' + srcDir);
  process.exit(1);
}

const zipName = `hehe-toolbox-${pkg.version}-win-x64.zip`;
const zipPath = path.join(outDir, zipName);

// 7za 的 a 命令会「更新已有压缩包」，不删旧包可能带着上一次的残留文件进去
try { fs.unlinkSync(zipPath); } catch (e) { /* 本来就不存在 */ }

let sevenZa;
try {
  sevenZa = require('7zip-bin').path7za;
} catch (e) {
  console.error('[pack-zip] 找不到 7zip-bin：' + e.message);
  process.exit(1);
}

console.log('[pack-zip] 源目录：' + srcDir);
console.log('[pack-zip] 输出：' + zipPath);

// cwd 设为 srcDir，保证 zip 内顶层直接是 exe，而不是嵌套一层 win-unpacked
execFileSync(sevenZa, ['a', '-tzip', '-mx=5', zipPath, '.'], {
  cwd: srcDir,
  stdio: 'ignore'
});

const st = fs.statSync(zipPath);
console.log('[pack-zip] 完成：' + zipName + '  ' + (st.size / 1048576).toFixed(1) + ' MB');
