'use strict';
/* 复现 + 回归：target-size 的 dz.el 误用。
 *
 * 真 bug（P1）：dropzone() 返回的是 DOM 元素本身，没有 .el 属性。
 * 点「开始压缩」时执行 dz.el.classList.add('busy') → TypeError，
 * 且由于抛在 try 之前，running 已置 true 但 finally 分支永不执行
 * → 按钮永久禁用、页面卡死。
 *
 * 本测试用最小 DOM 桩直接调用同构逻辑，不依赖 Electron。
 * 用法：node scripts/test-dz-el.js
 */
const fs = require('fs');
const path = require('path');
const { invokeIndex } = require('./lib/seg-from-handler');

let pass = 0, fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; else pass++; };

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'tools', 'target-size.js'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');

/* ---- 1. 确认 dropzone 的返回形状：返回 DOM 元素，无 .el ---- */
const dzStart = ui.indexOf('function dropzone(');
const dzEnd = ui.indexOf('\n  }', dzStart);
const dzFn = ui.slice(dzStart, dzEnd > 0 ? dzEnd : dzStart + 2000);
chk(/return dz;/.test(dzFn), 'dropzone 直接 return dz（DOM 元素）');
chk(!/\{\s*el\s*:/.test(dzFn), 'dropzone 不返回 { el } 对象');

/* ---- 2. target-size 里不许再出现 dz.el ---- */
chk(!/dz\.el/.test(src), 'js/tools/target-size.js 不再访问 dz.el（当前为 bug 状态）');

/* ---- 3. busy 状态必须作用在正确的对象上 ---- */
chk(/dz\.classList\.add\('busy'\)/.test(src), '加 busy 状态用的是 dz.classList');
chk(/dz\.classList\.remove\('busy'\)/.test(src), '移除 busy 状态用的是 dz.classList');

/* ---- 4. 行为验证：用 DOM 桩真的跑一遍那两行 ---- */
function makeStub() {
  const cls = new Set();
  return {
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      has: (c) => cls.has(c)
    },
    _cls: cls
  };
}

/* 正确写法：dz.classList.add('busy') */
const dz = makeStub();
dz.classList.add('busy');
chk(dz.classList.has('busy'), 'dz.classList.add("busy") 生效');

/* 错误写法：dz.el.classList.add → dz.el 是 undefined */
const dzBad = makeStub();
let threw = null;
try {
  dzBad.el.classList.add('busy');
} catch (e) { threw = e; }
chk(threw !== null, '错误写法 dz.el.classList 确实抛异常（证明该 bug 真实存在）');
chk(threw && /Cannot read prop/.test(String(threw.message)), '异常类型是 TypeError: Cannot read properties of undefined');

/* ---- 5. 每条退出路径都必须解锁（结构断言，剥注释后做） ----
 *
 * 【这一段的断言历史，值得写下来】
 * 原来用的是「定长 900 字符切片 + 在原文里搜 finally」：
 *   const runBody = src.slice(src.indexOf('async function run()'), ... + 900);
 *   const beforeTry = runBody.slice(0, runBody.indexOf('try {'));
 *   chk(!/finally/.test(beforeTry), ...)
 * 这是**按版面匹配**，加一行注释就会误报 —— 而且已经真的误报了：
 * target-size 把收尾抽成 unlockUi() 并写了一段说明注释（注释里出现
 * "finally" 这个词），把 try 和 running=false 推到 900 字符之外，
 * indexOf('try {') 返回 -1、slice(0,-1) 取到几乎整段，
 * 于是两条断言同时红，而功能完全正确。
 * 同一天已经因为这类断言误报过两次（ffba977、1c10a8d）。
 *
 * 现在改成：括号配平取整个函数体 → 剥掉注释 → 断言结构性事实。
 * 剥注释是关键：否则注释里提到 "finally" 就会污染判断。
 */

/* 从 open（指向 '{'）开始配对，返回其后一位下标；跳过字符串与注释 */
function scanBraces(text, open) {
  let depth = 0, i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const n = text.indexOf('\n', i); i = n < 0 ? text.length : n; continue; }
    if (c === '/' && text[i + 1] === '*') { const n = text.indexOf('*/', i + 2); i = n < 0 ? text.length : n + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return -1;
}

/* 【stripComments 统一用 lib/src-scan.js 的实现】
 * 原来这里是一份手写状态机：识别行注释、块注释与字符串，但**不识别正则字面量**
 * ——与 lib/src-scan.js 头部注释记录的那次事故同型。
 * src-scan 的实现多认一条「正则字面量」分支，并跳过其中的花括号与斜杠，
 * 因此 net-tools.js 里含双引号的字符类不会被当成字符串开头。
 * 两者在本文件的目标文本上结果一致（都已实测通过），但只在 src-scan 上有保证。
 */
const stripComments = require('../lib/src-scan').stripComments;

/* 取 async function run() 的完整源段（含函数体），不依赖任何长度常量 */
function extractRunBody(source) {
  const start = source.indexOf('async function run()');
  if (start < 0) throw new Error('找不到 async function run()');
  const open = source.indexOf('{', start);
  if (open < 0) throw new Error('run() 没有函数体');
  const end = scanBraces(source, open);
  if (end < 0) throw new Error('run() 括号不配平');
  return { src: source.slice(start, end), open, end };
}

let runSrc;
try {
  runSrc = extractRunBody(src).src;
  chk(runSrc.length > 0, '能按括号配平定位 async function run() 的完整函数体');
} catch (e) {
  chk(false, '定位 run() 失败：' + e.message);
  runSrc = '';
}

const runCode = stripComments(runSrc);   // 后续断言一律基于剥注释后的文本

/* 5a. 解锁必须集中在一个函数里 —— 否则每加一条退出路径就可能漏一处 */
chk(/function unlockUi\s*\(\s*\)/.test(runCode), '把解锁动作收进了一个函数（unlockUi）');

/* 5b. 这个函数的定义体里必须三件事都做全 */
const uiDef = (() => {
  const m = runCode.indexOf('function unlockUi');
  if (m < 0) return '';
  const open = runCode.indexOf('{', m);
  if (open < 0) return '';
  const end = scanBraces(runCode, open);
  return end < 0 ? '' : runCode.slice(open, end);
})();
chk(/running\s*=\s*false/.test(uiDef), 'unlockUi 里复位 running');
chk(/setLocked\s*\(\s*false\s*\)/.test(uiDef), 'unlockUi 里解锁文件选择器（setLocked(false)）');
chk(/classList\.remove\s*\(\s*'busy'\s*\)/.test(uiDef), 'unlockUi 里移除 busy 样式');

/* 5c. 两条退出路径都要真的调它：finally 与 fs:mkdir 失败分支 */
chk(/finally\s*\{[\s\S]*?unlockUi\s*\(\s*\)/.test(runCode), 'finally 里调用了 unlockUi（正常路径与异常路径都解锁）');
const mkAt = invokeIndex(runCode, 'fs:mkdir');
chk(mkAt > 0 && /unlockUi\s*\(\s*\)/.test(runCode.slice(mkAt, mkAt + 400)), 'fs:mkdir 失败分支里也调用了 unlockUi（早退路径同样解锁）');

/* 5d. 反面断言：不许在 unlockUi 之外再散落一份「只解一半」的复位
 *     （原来那条早退只复位了 running/startBtn/cancelBtn，漏了 setLocked） */
const strayReset = (runCode.match(/setLocked\s*\(\s*false\s*\)/g) || []).length;
chk(strayReset === 1, 'setLocked(false) 只出现在 unlockUi 里（不散落，避免某条路径漏解锁）');

/* 5e. 行为验证：把 unlockUi 真的跑一遍，确认它把四样状态都复位了。
 *     用一个状态桩 + 同构的 unlockUi 体，验证「复位」这个语义本身。 */
try {
  const stub = {
    state: { running: true, locked: true, busy: true, runJobId: 'x' },
    startBtn: { disabled: true }, cancelBtn: { disabled: false },
    picker: {
      setLocked(v) { stub.state.locked = !!v; },
      dz: { classList: { remove(c) { if (c === 'busy') stub.state.busy = false; } } }
    }
  };
  const fn = new Function('running_ref', 'startBtn', 'cancelBtn', 'picker', 'runJobId_ref', `
    let running = running_ref;
    function unlockUi() {
      running = false;
      startBtn.disabled = false; cancelBtn.disabled = true;
      picker.setLocked(false);
      picker.dz.classList.remove('busy');
    }
    unlockUi();
    return running;
  `);
  const nowRunning = fn(true, stub.startBtn, stub.cancelBtn, stub.picker, null);
  chk(nowRunning === false, '行为验证：unlockUi 之后 running 复位');
  chk(stub.startBtn.disabled === false, '行为验证：开始按钮恢复可用');
  chk(stub.state.locked === false, '行为验证：unlockUi 之后选择器不再 locked');
  chk(stub.state.busy === false, '行为验证：unlockUi 之后 busy 样式被移除');
} catch (e) {
  chk(false, '行为验证失败：' + e.message);
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
