'use strict';
/* 从 zip 里抽出 app.asar，用 asar 包读源码，验证「修复真的进了产物」。
 *
 * 【为什么需要这个脚本】
 * 发布最容易犯的错误不是代码写错，而是**发了旧包**：源码改了、测试全绿，
 * 但 dist 是上一次构建的产物。只看文件时间戳不够（时钟、拷贝都可能骗人），
 * 唯一可靠的验证是拆开包看里面的代码。
 *
 * 【用法】node scripts/verify-fixes-in-package.js [版本号]
 * 版本号缺省取 package.json 的 version，据此定位 dist 里的 zip。
 *
 * 【历史】
 * v0.8.3 首次写这个脚本（当时硬编码版本号与 6 个修复）。
 * v0.8.4 起改成按版本自动定位，并把两代的检查项都保留在表里 ——
 * 旧版本的包仍可用 `node scripts/verify-fixes-in-package.js 0.8.3` 校验。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const Z7 = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

const version = process.argv[2] || require(path.join(ROOT, 'package.json')).version;
const ZIP = path.join(ROOT, 'dist', 'hehe-toolbox-' + version + '-win-x64.zip');
if (!fs.existsSync(ZIP)) {
  console.log('找不到产物：' + ZIP);
  process.exit(1);
}

/* 每个版本的检查项：[文件, 说明, 判据]。
 * 判据一律是「某段代码形态是否存在」—— 这是唯一能从产物里验证的东西。 */
const CHECKS_BY_VERSION = {
  '0.8.3': [
    ['lib/power-gate.js', '横杠写法（shutdown -a / -s 对称）',
      (s) => /const SAFE_ARGS_RE = \/\\s\[\/-\]\(a\|\\\?\)/.test(s)
        && /UNSAFE_SWITCH_RE = \/\(\^\|\\s\)\[\/\|\-\]/.test(s)],
    ['js/drop-open.js', 'bind 幂等标记',
      (s) => /__dropOpenBound/.test(s)],
    ['css/app.css', '拖拽遮罩用 --card-bg（无 --bg-1 引用）',
      (s) => {
        /* 剥注释再判：修复说明里会写「没有 --bg-1 这个变量」，直接搜会假阳性 */
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
  ],
  '0.8.4': [
    ['lib/power-gate.js', 'F1 if 条件剥离（stripIfCondition）',
      (s) => /function stripIfCondition/.test(s)],
    ['lib/power-gate.js', 'F1 PS 花括号块（extractBraces）',
      (s) => /function extractBraces/.test(s)],
    ['lib/power-gate.js', 'F1 iex / Invoke-Expression fail-closed',
      (s) => /invoke-expression/.test(s) && /iex/.test(s)],
    ['lib/path-guard.js', 'F2 深层保护不再受 recursive 限定',
      (s) => {
        /* 剥注释后不应再有 `recursive && isCriticalDeep` 这种限定 */
        const decl = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        return !/recursive\s*&&\s*isCriticalDeep/.test(decl)
          && /if \(isCriticalDeep\(abs\)\)/.test(decl);
      }],
    ['lib/path-guard.js', 'F5 共用 stringPathOrError 助手',
      (s) => /function stringPathOrError/.test(s)],
    ['js/ui.js', 'F4 expandNotice 缺省自取上限',
      (s) => /maxFiles\s*>\s*0\s*\)\s*\?\s*maxFiles\s*:\s*expandMaxFiles\(\)/.test(s)],
    ['js/tools/mojibake-fix.js', 'F3 不再引用 --fill-1',
      (s) => !/var\(--fill-1\)/.test(s.replace(/\/\*[\s\S]*?\*\//g, ''))],
    ['js/tools/disk-health.js', 'F3 不再引用 --fill-1',
      (s) => !/var\(--fill-1\)/.test(s.replace(/\/\*[\s\S]*?\*\//g, ''))],
    ['js/drop-open.js', 'F6 takePending 按 toolId 过滤',
      (s) => /p\.toolId\s*&&\s*toolId\s*&&\s*p\.toolId\s*!==\s*toolId/.test(s)],
    ['js/clip-actions.js', 'F6 takePendingClip 按 toolId 过滤',
      (s) => /p\.toolId\s*&&\s*toolId\s*&&\s*p\.toolId\s*!==\s*toolId/.test(s)],
  ],
  '0.8.5': [
    ['lib/power-gate.js', 'R1 递归可执行位判定（textHasDanger）',
      (s) => /function textHasDanger/.test(s) && /textHasDanger\(/.test(s)],
    ['lib/power-gate.js', 'R1 iex 出现即拦',
      (s) => /invoke-expression/.test(s) && /iex/.test(s)],
    ['lib/power-gate.js', 'R1 引号感知的条件剥离',
      (s) => /function stripIfCondition/.test(s)],
    ['lib/fs-ops.js', 'R2 单引号路径转义（concatFileLine）',
      (s) => {
        if (!/function concatFileLine/.test(s)) return false;
        /* 判据：函数体里必须有 `'\\''` 这段转义序列。
         * 【不用正则写这个判据】转义在正则字面量里要套四层反斜杠，
         * 写错一次就会变成永远匹配不上（假红）或永远匹配（假绿）。
         * 直接数源码里的字符码：两个反斜杠 + 两个单引号。 */
        const fn = s.slice(s.indexOf('function concatFileLine'), s.indexOf('module.exports'));
        const need = '\\'.repeat(2) + "''";
        return fn.indexOf(need) !== -1;
      }],
    ['ipc/media-ffmpeg.js', 'R2 concat 清单改用 concatFileLine',
      (s) => /concatFileLine/.test(s)],
    ['lib/sensitive.js', 'R3 GitHub fine-grained token 判据',
      (s) => /github_pat_/.test(s)],
    ['css/app.css', 'R4 首页分类网格响应式断点',
      (s) => /@media\s*\(max-width:\s*1023px\)[\s\S]{0,120}\.home-cats/.test(s)],
    ['css/app.css', 'R6 拖拽区 busy 状态样式',
      (s) => /\.dropzone\.busy/.test(s)],
    ['main.js', 'R5 preview-tmp 清扫',
      (s) => /function sweepPreviewTmp/.test(s) && /sweepPreviewTmp\(\)/.test(s)],
    ['js/auxwin/snip-2.js', '死代码 W/H 已清理',
      (s) => !/const W = \+params\.get/.test(s)],
    ['js/channels.js', '陈旧迁移注释已修正',
      (s) => !/只迁移了两个域/.test(s)],
  ],
};

const CHECKS = CHECKS_BY_VERSION[version];
if (!CHECKS) {
  console.log('没有为版本 ' + version + ' 定义检查项。已定义：' + Object.keys(CHECKS_BY_VERSION).join(', '));
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hehe-verify-'));
try {
  execFileSync(Z7, ['e', ZIP, '-o' + tmp, '-r', 'app.asar', '-y'], { stdio: 'pipe' });
  const asarPath = path.join(tmp, 'app.asar');
  if (!fs.existsSync(asarPath)) {
    console.log('zip 里没找到 app.asar');
    process.exit(1);
  }
  console.log('产物：hehe-toolbox-' + version + '-win-x64.zip');
  console.log('已解出 app.asar: ' + (fs.statSync(asarPath).size / 1048576).toFixed(1) + ' MB\n');

  const asar = require(path.join(ROOT, 'node_modules', '@electron', 'asar'));

  /* asar 内路径是「反斜杠分隔、无前导分隔符」形式（js\tools\x.js）。
   * 三种拼法都试，避免因分隔符差异误报"读不到"。 */
  function readFromAsar(rel) {
    for (const p of [rel, rel.split('/').join('\\'), rel.replace(/^[\\/]+/, '').split('/').join('\\')]) {
      try { return asar.extractFile(asarPath, p).toString('utf8'); } catch (e) { /* 换下一种 */ }
    }
    return null;
  }

  let pass = 0, fail = 0, skip = 0;
  for (const [rel, label, test] of CHECKS) {
    const src = readFromAsar(rel);
    if (src == null) { console.log('SKIP  ' + rel + '  ' + label + '（产物里读不到该文件）'); skip++; continue; }
    const ok = test(src);
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + rel.padEnd(26) + label);
  }
  console.log('\n产物校验: ' + pass + ' 通过 / ' + fail + ' 失败' + (skip ? ' / ' + skip + ' 跳过' : ''));
  process.exit(fail ? 1 : 0);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响判定 */ }
}
