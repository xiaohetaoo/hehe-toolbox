'use strict';
/* 【守卫：E2E 里只匹配中文界面文案的断言】
 *
 * 为什么需要这条：
 *   GitHub 的 windows-latest 是**英文**系统，应用启动后按 navigator.language
 *   自动切英文。于是「/共 3 项/」「/约|即将/」这类只认中文的断言在本地全绿、
 *   CI 上必挂 —— 2026-11-26 的 v0.9.7 Release 就是因为这个失败了两次。
 *
 * 判据（只报**真会随语言变**的那些）：
 *   · 断言里出现中文字面量
 *   · 且比较对象是「界面文案」（.textContent / .text / .innerText 之类）
 *   · 且同一行没有英文备选（About/Almost/Enable/Open 等）
 *   · 且不是纯函数测试（不启 Electron 的文件不在本次扫描范围）
 *
 * 豁免方式：在该行上方 3 行内写 `锁的是` 并说明为何中文是必须的
 *   （例如断言的是中文词表本身，而不是界面渲染结果）。 */
const fs = require('fs');
const path = require('path');
const { readSrc } = require('./lib/harness');

const DIR = path.join(__dirname);
const ZH = /[\u4e00-\u9fa5]/;
const EN_ALT = /\b(About|Almost|Enable|Open|Settings|Clear|Notice|OK|Cancel|Close|Copy|Save|Delete|High-risk|items|files|Done|Ready|Total)\b/i;
/* 只看「比较界面文案」的行 */
const UI_TEXT = /\.(textContent|innerText|text|label)\b/;
/* 纯函数/不启 Electron 的测试不受语言影响 */
const LAUNCHES_ELECTRON = /execFileSync\s*\(\s*(EXE|ELECTRON_EXE|ELECTRON|electronExe)|require\('electron'\)/;

const offenders = [];
/* 递归收集：scripts/ 下的测试已经按主题分到子目录（media/、ui/ 等），
 * 只扫顶层会让子目录里的中文断言整片漏检 —— 这道守卫的假绿比报错更贵。 */
function collectTests(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      collectTests(abs, out);
    } else if (/^test-.*\.js$/.test(ent.name)) {
      out.push(abs);
    }
  }
}
const files = [];
collectTests(DIR, files);

for (const abs of files) {
  /* 锁的是：不启 Electron 的测试不受界面语言影响。用 readSrc 剥注释，
   * 行为断言不可替代——要先从脚本源码识别宿主类型。 */
  const rel = path.relative(path.join(__dirname, '..'), abs).replace(/\\/g, '/');
  const src = readSrc(rel);
  if (!LAUNCHES_ELECTRON.test(src)) continue;   // 锁的是：不启 Electron 的测试不受界面语言影响
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    /* 锁的是：本守卫的判定链——只有 chk/assert 行才可能依赖界面语言。 */
    if (!/(chk|assert\.\w+)\s*\(/.test(ln)) continue;
    if (!ZH.test(ln)) continue;
    /* 锁的是：只有比较界面文案的行才可能随语言变；纯逻辑断言不受影响。
     * 同段 EN_ALT 是「已有英文备选」的豁免判据，两条必须成对。 */
    if (!UI_TEXT.test(ln)) continue;
    if (EN_ALT.test(ln)) continue;             // 已有英文备选
    /* 中文只出现在**断言说明文字**里（第二个参数）也算安全 —— 那不影响判定 */
    /* 锁的是：只有 /.../.test(...) 里的中文才是真依赖语言；说明文字里的中文不算。
     * 这是守卫自身的判据，行为断言替代不了（要解析断言表达式）。 */
    const regexHasZh = /\/[^/\n]*[\u4e00-\u9fa5][^/\n]*\/[gimsuy]*\s*\.test/.test(ln);
    if (!regexHasZh) continue;
    /* 锁的是：负向断言（!/中文/）在任何语言下都成立，不属于依赖界面语言。
     * 例如 !/健康度/ —— 英文版同样不该冒出「健康度」。 */
    if (/!\s*\/[^/\n]*[\u4e00-\u9fa5]/.test(ln)) continue;
    /* 锁的是：A || B 双分支已能走英文/数字分支，不会因语言假红。 */
    if (/\|\|/.test(ln) && /\.test\(/.test(ln.slice(ln.indexOf('||')))) continue;
    /* 有没有 锁的是 豁免说明 */
    const ctx = lines.slice(Math.max(0, i - 3), i).join('\n');
    if (/锁的是/.test(ctx)) continue;
    offenders.push({ file: path.relative(DIR, abs).replace(/\\/g, '/'), line: i + 1, text: ln.trim() });
  }
}

if (offenders.length) {
  console.log('FAIL  有 ' + offenders.length + ' 处断言只匹配中文界面文案，在英文系统上会假红：');
  for (const o of offenders) {
    console.log('  ' + o.file + ':' + o.line + '  ' + o.text.slice(0, 110));
  }
  console.log('\n修法：正则里加英文备选（About|Almost|Enable|...），');
  console.log('或在该行上方 3 行内写「锁的是 …」说明为何只能匹配中文。');
  process.exit(1);
}
console.log('PASS  ' + files.length + ' 个测试里，没有「只匹配中文界面文案」的断言');
