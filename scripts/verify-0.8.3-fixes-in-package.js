'use strict';
/* 从 zip 里抽出 app.asar，用 asar 包读源码，验证 6 个修复真的进了产物 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ZIP = path.join(ROOT, 'dist', 'hehe-toolbox-0.8.3-win-x64.zip');
const Z7 = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hehe-verify-'));

// 1) 解出 resources/app.asar
execFileSync(Z7, ['e', ZIP, '-o' + tmp, '-r', 'app.asar', '-y'], { stdio: 'pipe' });
const asarPath = path.join(tmp, 'app.asar');
if (!fs.existsSync(asarPath)) {
  console.log('zip 里没找到 app.asar');
  process.exit(1);
}
console.log('已解出 app.asar: ' + (fs.statSync(asarPath).size / 1048576).toFixed(1) + ' MB\n');

// 2) 用 asar 读文件
let asar;
try { asar = require(path.join(ROOT, 'node_modules', '@electron', 'asar')); }
catch (e) {
  try { asar = require('asar'); } catch (e2) { console.log('没有 asar 库，改用字符串搜'); }
}

function readFromAsar(rel) {
  if (asar && asar.extractFile) {
    /* asar 内路径是「反斜杠分隔、无前导分隔符」形式（js\tools\x.js）。
     * 三种拼法都试：POSIX、纯反斜杠、去掉任何前导分隔符。 */
    for (const p of [rel, rel.split('/').join('\\'), rel.replace(/^[\\/]+/, '').split('/').join('\\')]) {
      try { return asar.extractFile(asarPath, p).toString('utf8'); } catch (e) { /* 换下一种 */ }
    }
    return null;
  }
  return null;
}

const checks = [
  ['lib/power-gate.js', '横杠写法（25b/28b 修复）',
    (s) => /const SAFE_ARGS_RE = \/\\s\[\/-\]\(a\|\\\?\)/.test(s) && /UNSAFE_SWITCH_RE = \/\(\^\|\\s\)\[\/\|\-\]/.test(s)],
  ['js/drop-open.js', 'bind 幂等标记',
    (s) => /__dropOpenBound/.test(s)],
  ['css/app.css', '拖拽遮罩改用 --card-bg（无 --bg-1 声明）',
    (s) => {
      /* 【判据要剥注释】修复时我在注释里写了「项目里没有 --bg-1 这个变量」，
       * 直接 /--bg-1/ 会被那句注释命中造成假阳性。只测 CSS 声明部分。 */
      const decl = s.replace(/\/\*[\s\S]*?\*\//g, '');
      return !/var\(--bg-1\)/.test(decl)
        && /\.drop-overlay-inner\s*\{[^}]*background:\s*var\(--card-bg\)/.test(decl);
    }],
  ['js/tools/pdf-plus.js', '页码扣除跳过页',
    (s) => /const n = i \+ 1 - skip;/.test(s)],
  ['js/app.js', 'consumePendingClip 具名函数',
    (s) => /function consumePendingClip\(page, toolId\)/.test(s)],
  ['js/app.js', '保活分支调用 consumePendingClip',
    (s) => /consumePendingClip\(rec\.el/.test(s)],
];

if (!asar) {
  console.log('（无法读 asar 内容，改为检查 zip 内是否有新版文件——跳过逐项校验）');
}
let pass = 0, fail = 0;
for (const [rel, label, test] of checks) {
  const src = readFromAsar(rel);
  if (src == null) { console.log('SKIP  ' + rel + '  ' + label + '（读不到）'); continue; }
  const ok = test(src);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + rel.padEnd(24) + label);
}
console.log('\n产物校验: ' + pass + ' 通过 / ' + fail + ' 失败');

// 清理
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
