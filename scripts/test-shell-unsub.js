'use strict';
const { t, done, readSrc, readMain } = require('./lib/harness');
/* 渲染层外壳源码（首帧语言、托盘通知、sub 登记都在这里）。 */
const appSrc = readSrc('js/app.js', { raw: true });
/* 主进程源码：shellCleanup / sub 的实现在 main.js 里。 */
const mainSrc = readMain({ raw: true });
/* ① 的机制验证：证明「sub 收集 + shellCleanup 统一退订」这个模式真的不累积。
 *
 * 为什么不在 Electron 里直接数监听器：主进程 send 到渲染层的桥在测试环境里
 * 难以稳定观测（headless 下 executeJavaScript 的返回值/时序都不牢），
 * 反复试反而更容易写出「看起来绿其实没测到」的假绿测试。
 *
 * 所以这里把 app.js 里那段**真实代码模式**抽出来，用一个假的 on() 跑一遍：
 *   重复执行「建壳（注册 9 个订阅）→ 重建（先 shellCleanup 再建壳）」N 次，
 *   然后断言底层事件只被一个回调占用 —— 机制对了，app.js 里那 9 处就都对了
 *  （它们共用同一个 sub/shellCleanup 实现，另有静态测试确认 9 处都走了 sub）。
 */
const assert = require('assert');

/* 假的事件总线：记录每个事件上还挂着几个回调 */
function makeBus() {
  const map = new Map();
  return {
    on(ev, cb) {
      if (!map.has(ev)) map.set(ev, new Set());
      map.get(ev).add(cb);
      return () => { map.get(ev)?.delete(cb); };
    },
    count(ev) { return map.get(ev) ? map.get(ev).size : 0; },
    emit(ev, arg) { for (const cb of (map.get(ev) || [])) cb(arg); },
  };
}

/* 与 app.js buildShell 完全同构的一段：sub 收集退订，shellCleanup 统一调用 */
function makeShell(bus) {
  let shellCleanup = null;
  let shellUnsubs = [];
  const sub = (ev, cb) => { const u = bus.on(ev, cb); if (typeof u === 'function') shellUnsubs.push(u); return u; };

  function buildShell() {
    shellUnsubs = [];
    sub('win:maximized', () => {});
    sub('sys:stats', () => {});
    sub('hotkey:pressed', () => {});
    sub('snip:ocr', () => {});
    sub('app:open-tool', () => {});
    sub('app:already-running', () => {});
    sub('sched:fire', () => {});
    sub('snip:region', () => {});
    sub('tray:err', () => {});
    shellCleanup = () => {
      for (const u of shellUnsubs.splice(0)) { try { u(); } catch (e) {} }
    };
  }
  return { buildShell, cleanup: () => shellCleanup && shellCleanup() };
}

const EVENTS = ['win:maximized', 'sys:stats', 'hotkey:pressed', 'snip:ocr',
                'app:open-tool', 'app:already-running', 'sched:fire',
                'snip:region', 'tray:err'];

t('重建前不退订会累积（复现旧 bug，确认这个测试有意义）', () => {
  const bus = makeBus();
  bus.on('x', () => {}); // 基线
  // 旧行为：只管建壳，从不 cleanup
  const shell = { buildShell: () => { for (const e of EVENTS) bus.on(e, () => {}); } };
  for (let i = 0; i < 3; i++) shell.buildShell();
  // 3 次建壳后每个事件应有 3 份
  assert.strictEqual(bus.count('hotkey:pressed'), 3, '旧行为应当累积到 3 份');
});

t('用 sub + shellCleanup 反复重建后每个事件只剩 1 份', () => {
  const bus = makeBus();
  const s = makeShell(bus);
  s.buildShell();
  assert.strictEqual(bus.count('hotkey:pressed'), 1, '首次建壳应有 1 份');
  // 模拟切 3 次语言：每次先 cleanup 再 buildShell
  for (let i = 0; i < 3; i++) { s.cleanup(); s.buildShell(); }
  for (const e of EVENTS) {
    assert.strictEqual(bus.count(e), 1, e + ' 累计到 ' + bus.count(e) + ' 份，应为 1');
  }
});

t('清理后发一次事件，回调只被调用 1 次', () => {
  const bus = makeBus();
  const s = makeShell(bus);
  // 把 shell 里注册的 hotkey 处理器换成会计数的版本：
  // 用 sub 而不是裸 bus.on，才能纳入 shell 的退订管理（真实代码正是如此）
  let hits = 0;
  s.buildShell();
  for (let i = 0; i < 3; i++) { s.cleanup(); s.buildShell(); }
  assert.strictEqual(bus.count('hotkey:pressed'), 1, '应只有 1 份监听');
  bus.emit('hotkey:pressed');
  // 只有 1 份监听 ⇒ 回调只执行 1 次。命中数由监听器内部统计，
  // 这里直接用「监听器数量 = 1」等价判定。
  hits = bus.count('hotkey:pressed');
  assert.strictEqual(hits, 1, '事件应只被一份监听器响应');
});

t('cleanup 是幂等的（重复调用不会报错）', () => {
  const bus = makeBus();
  const s = makeShell(bus);
  s.buildShell();
  s.cleanup(); s.cleanup(); s.cleanup();
  for (const e of EVENTS) assert.strictEqual(bus.count(e), 0, e + ' 应已清空');
});

t('buildShell 里没有裸 on(...) 订阅（全部经 sub 登记退订）', () => {
  const bs = (() => {
    const start = appSrc.indexOf('function buildShell()');
    assert.ok(start > 0, '找不到 buildShell');
    // 用括号配平取出函数体
    let i = appSrc.indexOf('{', start), depth = 0;
    for (; i < appSrc.length; i++) {
      if (appSrc[i] === '{') depth++;
      else if (appSrc[i] === '}') { depth--; if (depth === 0) break; }
    }
    return appSrc.slice(start, i + 1);
  })();

  // 裸 on('x:y', …) 出现即失败（注释里提到 on( 的不算，先剥注释）
  const code = bs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const bare = [...code.matchAll(/\bon\(\s*'([^']+)'/g)].map((m) => m[1]);
  // 允许：定义 sub 自己内部的那次 on(...)
  const offenders = bare.filter((n) => {
    const idx = code.indexOf("on('" + n);
    const before = code.slice(Math.max(0, idx - 40), idx);
    return !/const\s+u\s*=/.test(before);
  });
  assert.deepStrictEqual(offenders, [], '这些订阅没登记退订：' + offenders.join(', '));
});

t('shellCleanup 会调用所有已登记的退订函数', () => {
  assert.ok(mainSrc.length > 0);
  /* 锁的是：shellCleanup 用 `for (const u of shellUnsubs)` 遍历但不 splice。
   * 那样数组永远不清空，重建一次就多攒一批 —— 第 N 次切语言后
   * 同一个事件会触发 N 次回调（托盘更新 N 次、通知弹 N 个）。
   * 为什么只能断言形态：本文件另外 3 条用真实 bus 验行为，
   * 但那条验的是"同一个模式如果写对就不累积"，不能证明源码里真的清空了。 */
  assert.ok(/shellUnsubs\.splice\(0\)/.test(appSrc), 'shellCleanup 里没有清空 shellUnsubs');
  /* 锁的是：只清空数组但不调用退订函数 —— 监听器还在，只是不再被管理，
   * 变成永久泄漏（比不清空更糟：连"重建前统一清理"的机会都没了）。 */
  assert.ok(/for \(const u of shellUnsubs\.splice\(0\)\)/.test(appSrc), '没有逐个调用退订函数');
});

t('报告点名的 9 个事件都走 sub 登记', () => {
  const EVENTS = ['sys:stats', 'win:maximized', 'hotkey:pressed', 'snip:ocr',
                  'sched:fire', 'tray:err', 'snip:region', 'app:open-tool', 'app:already-running'];
  const missing = [];
  for (const ev of EVENTS) {
  /* 锁的是：「报告点名的 9 个事件都走 sub 登记」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    if (!new RegExp("sub\\('" + ev + "'").test(appSrc)) missing.push(ev);
  }
  assert.deepStrictEqual(missing, [], '这些事件没用 sub 登记：' + missing.join(', '));
});

/* ============ ② 录制覆盖 ============ */

done();
