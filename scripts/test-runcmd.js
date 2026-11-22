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


t('11a runCmd：非零退出码默认必须抛（防"假成功"），allowNonZero 才返回结果', async () => {
  /* 【语义已在 R16 修正，本用例随之更新】
   * 旧语义是"默认非零不抛"，理由是"很多命令用非零码表达没查到"。
   * 但那条设计有个严重副作用：**只要进程打印过任何东西**，非零退出就会被
   * resolve 成 {code}，而绝大多数调用方 `await runCmd(...)` 就当成功继续。
   * 于是 `shutdown /s /t 1800` 被系统拒绝（1116 无权限 / 1190 已有计划）时，
   * 界面照样启动倒计时并承诺关机 —— 定时关机"假成功"。
   * 现在改成：
   *   · 默认按退出码判定，非零一律 reject（带 stdout/stderr/code）；
   *   · 确实需要"非零也要拿结果"的查询类调用显式传 allowNonZero: true
   *     （reg query / where / sc query 等 7 处已逐一标注理由）。
   * 本用例锁的正是这两条新契约。 */
  const build = () => {
    const sanitize = loadSanitize();
    return new Function('execFile', 'sanitizeCmdError', 'TextDecoder', 'Buffer',
      segFromFn('function runCmd(', 'runCmd') + '\nreturn runCmd;')(
      require('child_process').execFile, sanitize, TextDecoder, Buffer);
  };
  const runCmd = build();

  /* ---- 默认路径：非零必须抛 ---- */
  await assert.rejects(
    () => runCmd(process.execPath, ['-e', 'console.log("out"); process.exit(3)'], { timeout: 10000 }),
    (e) => {
      /* 锁的是：非零退出被当成成功（定时关机"假成功"的根因）。 */
      assert.ok(e, '非零退出码必须抛错');
      /* 锁的是：错误对象里丢了退出码（调用方无法区分 1116/1190）。 */
      assert.strictEqual(e.code, 3, '错误对象必须带上退出码，实际 ' + e.code);
      /* 锁的是：错误对象里丢了程序的输出（排错时最需要它）。 */
      assert.ok(String(e.stdout || '').includes('out'), '错误对象必须带上 stdout');
      return true;
    },
    '非零退出码默认必须抛错（否则会出现"假成功"）'
  );

  /* ---- allowNonZero：显式要求时才返回结果 ---- */
  const r = await runCmd(process.execPath, ['-e', 'console.log("out"); process.exit(3)'],
    { timeout: 10000, allowNonZero: true });
  /* 锁的是：查询类调用拿不到结果（reg query/where 会在"查不到"时非零）。 */
  assert.strictEqual(r.code, 3, 'allowNonZero 时应把退出码如实返回');
  assert.ok(String(r.stdout).includes('out'), 'allowNonZero 时应带回输出');

  /* ---- 零退出：两条路径都正常返回 ---- */
  const ok = await runCmd(process.execPath, ['-e', 'console.log("fine")'], { timeout: 10000 });
  assert.strictEqual(ok.code, 0);
  /* 锁的是：正常成功被错误地抛成失败。 */
  assert.ok(String(ok.stdout).includes('fine'));
});

t('11b office:status 必须用 throwOnNonZero，否则恒返回 office:true', () => {
  const seg = mainSrc.slice(handlerIndex(mainSrc, 'office:status'), handlerIndex(mainSrc, 'office:convert'));
  assert.ok(/throwOnNonZero:\s*true/.test(seg),
    'office:status 没打开 throwOnNonZero —— PowerShell 里 catch{exit 1} 完全不起作用，没装 Office 也报「可用」');
});

done();
