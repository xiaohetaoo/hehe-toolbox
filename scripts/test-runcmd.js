'use strict';
const assert = require('assert');
const { t, done, readMain } = require('./lib/harness');
const { handlerIndex } = require('./lib/seg-from-handler');
const { scanBrace } = require('../lib/src-scan');
const mainSrc = readMain({ raw: true });

/* runCmd 退出码语义的行为测试（原 test-round13 的 11a / 11b）。
 *
 * 锁的是本项目一个刻意的设计：runCmd 默认「非零不抛」
 * （很多命令用非零码表达"没查到"），需要抛时必须显式 throwOnNonZero。
 * 11b 锁的是 office:status 必须打开这个开关 —— 否则它恒返回 office:true，
 * 用户看到"Office 可用"但一点就失败。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

/* ---------------- 以下助手随 round13 的用例一起迁来 ----------------
 * 都从主进程/渲染层源码里抽出**真实现**来跑，不是手写副本
 * （副本会与实现分叉，那样测试就假绿了）。 */
function loadSanitize() {
  /* 【不用注释当右边界】原实现找 '// Windows PowerShell 输出默认是 OEM'
   * 作为函数结束位置。那条注释一旦改写（换行/措辞/翻译），indexOf 返回 -1，
   * 这条报「找不到 sanitizeCmdError」—— 纯误报，而实现完全正常。
   * 改成括号配平：sanitizeCmdError 是顶层函数，配平它的函数体即可。 */
  return new Function(segFromFn('function sanitizeCmdError', 'sanitizeCmdError') +
    '\nreturn sanitizeCmdError;')();
}

function segFromFn(needle, label) {
  const i = mainSrc.indexOf(needle);
  assert.ok(i > 0, '找不到 ' + (label || needle));
  /* 【不能直接取 needle 之后的第一个 '{'】
   * 函数签名里可能有默认参数对象：function runCmd(cmd, args, opts = {}) {
   * 第一个 '{' 是那个空对象 —— 用它配平只能得到 36 个字符
   * （实测：抽出的是 "function runCmd(cmd, args, opts = {}"）。
   * 正确做法是先把参数括号配平掉，再取之后的第一个 '{'：
   *   function foo(a, b = {}) {        ← 参数里的 { 在括号内部，不属于函数体
   *   const foo = (a) => {             ← 箭头函数同理
   * 这里统一处理：找 needle 之后的第一个 '('，配平到 ')'，再从那里往后找 '{'。 */
  let cursor = i;
  const paren = mainSrc.indexOf('(', i);
  if (paren > 0) {
    let depth = 0, k = paren;
    for (; k < mainSrc.length; k++) {
      const c = mainSrc[k];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { k++; break; } }
    }
    if (k > paren) cursor = k;
  }
  const open = mainSrc.indexOf('{', cursor);
  assert.ok(open > i, (label || needle) + ' 没有函数体');
  const end = scanBrace(mainSrc, open);
  assert.ok(end > open, (label || needle) + ' 括号不配平');
  return mainSrc.slice(i, end);
}


t('11a runCmd：默认「非零不抛」，打开 throwOnNonZero 后必须抛', async () => {
  /* 【不用注释当右边界】原实现靠「命令行脱敏」那条注释定位 runCmd 的结束，
   * 注释一改就报「找不到 runCmd」。改用括号配平。 */
  const build = () => {
    const sanitize = loadSanitize();
    return new Function('execFile', 'sanitizeCmdError', 'TextDecoder', 'Buffer',
      segFromFn('function runCmd(', 'runCmd') + '\nreturn runCmd;')(
      require('child_process').execFile, sanitize, TextDecoder, Buffer);
  };
  const runCmd = build();

  /* 用 node -e 'process.exit(3)' 造一个「有输出 + 非零退出码」的真实进程 */
  const r = await runCmd(process.execPath, ['-e', 'console.log("out"); process.exit(3)'], { timeout: 10000 });
  assert.strictEqual(r.code, 3, '默认路径应把退出码如实返回而不是抛');
  assert.ok(String(r.stdout).includes('out'), '默认路径应带回输出');

  await assert.rejects(
    () => runCmd(process.execPath, ['-e', 'console.log("out"); process.exit(3)'], { timeout: 10000, throwOnNonZero: true }),
    /Command failed|process\.exit/,
    'throwOnNonZero 打开后，非零退出码必须变成异常');
});

t('11b office:status 必须用 throwOnNonZero，否则恒返回 office:true', () => {
  const seg = mainSrc.slice(handlerIndex(mainSrc, 'office:status'), handlerIndex(mainSrc, 'office:convert'));
  assert.ok(/throwOnNonZero:\s*true/.test(seg),
    'office:status 没打开 throwOnNonZero —— PowerShell 里 catch{exit 1} 完全不起作用，没装 Office 也报「可用」');
});

done();
