'use strict';
const { t, done } = require('./lib/harness');
/* 取色坐标换算的行为测试（原 test-round15 的 4a / 4b / 4c）。
 *
 * 锁的是：早期用 clientX/clientY（**窗口内**坐标）当屏幕坐标，
 * 于是在副屏、或窗口有偏移时取到的颜色是错的位置；越界时还去取色，
 * 取到的是别的显示器上的一点。
 * 修法是 calcPickPoint 用 screenX/screenY 并夹取越界。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const stripComments = require('../lib/src-scan').stripComments;
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

t('4a calcPickPoint：窗口偏移与副屏都正确', () => {
  const code = stripComments(read('js/tools/dev.js'));
  /* 锁的是：「4a calcPickPoint：窗口偏移与副屏都正确」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/function calcPickPoint/.test(code), '没有抽出 calcPickPoint 纯函数');
  /* 锁的是：「4a calcPickPoint：窗口偏移与副屏都正确」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/screenX/.test(code) && /screenY/.test(code), '仍在用 clientX/clientY（窗口内坐标）');
  /* 【不能用 extractFn 抽它】它的参数是解构对象 { screenX, ... }，
   * extractFn 会把第一个 '{' 当成函数体起点，抽出来只有参数那一小段。
   * 这里按 '参数表) {' 定位真正的函数体。 */
  const i = code.indexOf('function calcPickPoint');
  const bodyStart = code.indexOf(') {', i) + 2;      // 指向 '{'
  let depth = 0, j = bodyStart, inS = null;
  while (j < code.length) {
    const c = code[j];
    if (inS) { if (c === '\\') j++; else if (c === inS) inS = null; j++; continue; }
    if (c === "'" || c === '"' || c === '`') { inS = c; j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
    j++;
  }
  const f = new Function(code.slice(i, j) + '\nreturn calcPickPoint;')();

  // 情形 1：窗口贴住主显示器左上角
  let r = f({ screenX: 100, screenY: 50, bounds: { x: 0, y: 0 }, dpr: 1, canvasW: 1920, canvasH: 1080 });
  assert.strictEqual(r.px, 100); assert.strictEqual(r.py, 50); assert.strictEqual(r.inRange, true);
  // 情形 2：窗口右移 300px（旧实现会整体偏 300）
  r = f({ screenX: 400, screenY: 250, bounds: { x: 0, y: 0 }, dpr: 1, canvasW: 1920, canvasH: 1080 });
  assert.strictEqual(r.px, 400, '窗口位置不该影响屏幕坐标换算');
  assert.strictEqual(r.py, 250);
  // 情形 3：副屏（bounds.x = 1920），鼠标在副屏上
  r = f({ screenX: 2000, screenY: 100, bounds: { x: 1920, y: 0 }, dpr: 1.5, canvasW: 2880, canvasH: 1620 });
  assert.strictEqual(r.px, Math.round((2000 - 1920) * 1.5), '副屏上应相对该显示器原点换算');
  assert.strictEqual(r.inRange, true);
  // 情形 4：越界（鼠标在别的显示器上）必须夹取且标记 inRange=false
  r = f({ screenX: -50, screenY: 10, bounds: { x: 0, y: 0 }, dpr: 2, canvasW: 1920, canvasH: 1080 });
  assert.strictEqual(r.inRange, false, '越界必须标记出来（不能让界面画一个黑点当结果）');
  assert.strictEqual(r.cx, 0, '越界时应夹到最近的合法像素');
});

t('4b 越界时不取色、给出提示', () => {
  const code = stripComments(read('js/tools/dev.js'));
  /* 锁的是：「4b 越界时不取色、给出提示」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/inRange/.test(code), '没有使用 inRange 标记');
  /* 锁的是：「4b 越界时不取色、给出提示」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/已超出屏幕范围/.test(code), '越界时没有给出可读提示');
});

t('4c 调用点必须传 e.screenX/e.screenY（不能退回 clientX）', () => {
  /* 【这条是把 4a 漏掉的一半补上】
   * 4a 跑的是 calcPickPoint 纯函数，它的形参就叫 screenX/screenY ——
   * 所以即使调用点退回成 `screenX: e.clientX`，纯函数行为完全不变，4a 照样绿。
   * 实测反向验证证实了这点（MISSED）。必须单独断言调用点。
   * clientX 是窗口内坐标，与 display.bounds（屏幕坐标）相减只在窗口贴住
   * 显示器左上角时成立 —— 窗口一挪就整体偏移，副屏还会变成负数。 */
  const code = stripComments(read('js/tools/dev.js'));
  /* 【必须从函数定义之后开始找，否则会命中函数声明本身】
   * `indexOf('calcPickPoint({')` 在第一处就是 `function calcPickPoint({ ... })`，
   * 那段里自然没有 `e.screenX` —— 会误报（第一次写就踩了这个）。 */
  const defEnd = code.indexOf(')', code.indexOf('function calcPickPoint')) + 1;
  const i = code.indexOf('calcPickPoint({', defEnd);
  assert.ok(i > 0, '没有找到 calcPickPoint 的调用点');
  /* 只取到实参对象闭合处（"})"），不要扫到后面 mag.style.left 那几行 ——
   * 那里用 e.clientX 是**正确**的（放大镜要跟着鼠标在窗口里画）。 */
  const close = code.indexOf('})', i);
  const seg = code.slice(i, close > i ? close + 1 : i + 300);
  /* 锁的是：「4c 调用点必须传 e.screenX/e.screenY（不能退回 clientX）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/screenX:\s*e\.screenX/.test(seg), '调用点没有用 e.screenX（用了窗口坐标 clientX）');
  /* 锁的是：「4c 调用点必须传 e.screenX/e.screenY（不能退回 clientX）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/screenY:\s*e\.screenY/.test(seg), '调用点没有用 e.screenY');
  /* 锁的是：「4c 调用点必须传 e.screenX/e.screenY（不能退回 clientX）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/clientX/.test(seg), 'calcPickPoint 的实参里用了 clientX（窗口内坐标与屏幕坐标混用）');
});

/* ==================== 5. 静态服务状态回填 ==================== */

done();
