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

/* ---- 5. 卡死机理：抛在 try 之前，finally 不执行 ---- */
const runBody = src.slice(src.indexOf('async function run()'), src.indexOf('async function run()') + 900);
const beforeTry = runBody.slice(0, runBody.indexOf('try {'));
chk(/running = true/.test(beforeTry), 'running 在 try 之前被置 true');
chk(/dz\.el\.classList\.add|dz\.classList\.add/.test(beforeTry), 'busy 状态也在 try 之前设置');
chk(!/finally/.test(beforeTry), 'try/finally 在 busy 设置之后才开始 → 抛异常时不会走到 finally');
chk(/running = false/.test(runBody), 'running 只在 finally 里复位（所以抛异常就永久卡住）');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
