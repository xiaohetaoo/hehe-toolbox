'use strict';
const cp = require('child_process');
const assert = require('assert');
const { t, done, readMain } = require('./lib/harness');
const { scanBrace } = require('../lib/src-scan');
const mainSrc = readMain({ raw: true });

/* 命令行脱敏的行为测试（原 test-round13 的 2a / 2b / 2c）。
 *
 * 锁的是：execFile 的 err.message 与 err.stack **都含完整命令行**，
 * 而 7z 只支持 -p<密码> 传参 —— 密码必然出现在 argv 里，
 * 也就必然出现在错误消息里，最终被 toast 到屏幕上。
 * 2b 特别锁住 stack：早期只清了 message，stack 首行原样带着密码。 */

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


/* realExecError：真的起一个会失败的命令，拿到 execFile 的原始 err ——
 * 只有真 err 才有「message 与 stack 都含完整命令行」这个属性。
 * 手造 Error 复现不出这一点，那样测脱敏就测不到真问题。 */
function realExecError(args) {
  return new Promise((resolve) => {
    cp.execFile(process.execPath, ['-e', 'process.exit(9)', ...args], () => {});
    cp.execFile(process.execPath, ['-e', 'process.exit(9)', ...args], (err) => resolve(err));
  });
}

t('2a 脱敏：密码含空格时 message 里不能残留密码片段', async () => {
  const sanitize = loadSanitize();
  for (const pw of ['has space', 'p@ss word!', 'ab cd', 'a b c d e f']) {
    const args = ['a', '-y', '-bd', '-p' + pw, '-mhe=on', 'out.7z', 'in.txt'];
    const err = await realExecError(args);
    assert.ok(err && err.message.includes(pw), '前置条件：原始错误里应含密码，实际 ' + (err && err.message));
    const clean = sanitize(err, args);
    assert.ok(!clean.message.includes(pw), '密码泄漏在 message 里：' + clean.message);
    /* 逐词检查：密码被空格切开后，任何一个词都不该单独留在输出里 */
    for (const word of pw.split(/\s+/)) {
      if (word.length < 3) continue;   // 太短的词会与命令本身巧合，跳过
      assert.ok(!clean.message.includes(word), '密码片段「' + word + '」仍泄漏：' + clean.message);
    }
  }
});

t('2b 脱敏：stack 里也不能残留密码（execFile 的 stack 首行就是整条命令行）', async () => {
  const sanitize = loadSanitize();
  const pw = 'my secret pass';
  const args = ['a', '-y', '-bd', '-p' + pw, '-mhe=on', 'out.7z'];
  const err = await realExecError(args);
  assert.ok(String(err.stack).includes(pw), '前置条件：原始 stack 里应含密码');
  const clean = sanitize(err, args);
  assert.ok(!String(clean.stack).includes(pw), '密码泄漏在 stack 里：' + String(clean.stack).split('\n')[0]);
});

t('2c 脱敏：原有规则未被破坏（-p 无空格、--password=、裸长串）', () => {
  const sanitize = loadSanitize();
  const r1 = sanitize(new Error('Command failed: 7z a -psecret123 out.7z'), ['a', '-psecret123', 'out.7z']);
  assert.ok(!r1.message.includes('secret123'), '普通密码未遮住：' + r1.message);
  const r2 = sanitize(new Error('bad --password=hunter2 in arg'), ['--password=hunter2']);
  assert.ok(!r2.message.includes('hunter2'), '--password= 未遮住：' + r2.message);
  const r3 = sanitize(new Error('token abcdefghij failed'), ['abcdefghij']);
  assert.ok(!r3.message.includes('abcdefghij'), '裸长串未遮住：' + r3.message);
});

/* ==================== 3. clean 周期任务保留 hhmm ==================== */

done();
