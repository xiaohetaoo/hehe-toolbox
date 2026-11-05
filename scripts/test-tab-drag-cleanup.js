'use strict';
/* 拖标签在 document 上挂的三个监听必须能退订；截图回包的时序必须绑住那一次拖拽。
 *
 * ============ 锁的是哪个回归 ============
 * ① 监听泄漏（P3）：attachTabDragDelegation 把 pointermove / pointerup /
 *    pointercancel 挂在 **document** 上，却不返回退订函数。而 tabbarEl 是
 *    buildShell() 每次新建的元素 —— 切一次语言（applyLangLabels →
 *    body.innerHTML='' → buildShell）就换一个新标签栏，旧元素上的
 *    __heheTabDrag 标记随元素一起消失，于是新元素会再挂一次。
 *    挂上去的三个 document 监听永不退订：切 N 次语言之后，
 *    一次拖动会发出 N 次开窗请求，用户得到 N 个独立窗口。
 *    shellCleanup 早就收口了 click / keydown 与 9 个 IPC 订阅，唯独这三个漏了。
 *
 * ② 截图回包的时序（P3）：captureContentThumb().then(...) 里判断
 *    「还要不要显示预览」用的是**当前**的 dragState。若用户在等待期间松手、
 *    再重新按下另一个标签并拖出，新的一轮同样满足 `dragState.out === true`，
 *    于是上一轮的截图盖到这一轮的预览上 —— 预览里是错的工具页。
 *    fallback 卡片里的工具名从全局 dragState 读，错的是**名字**：
 *    用户看到"图标对、名字错"。
 *
 * ============ 验证方式 ============
 * 用最小 DOM 桩把 attachTabDragDelegation 从源码里取出来**真的执行**：
 *   · 记录它在 document 上挂了哪些监听（监听器数量是可数的行为事实）
 *   · 调用返回的 unsub 之后，数量必须归零
 *   · 连挂两次 → 一次 pointermove 只让一份逻辑执行（用开窗请求计数衡量）
 * 比"源码里有没有 removeEventListener"强得多：后者写了个空函数也能过。
 */
const { t, done, assert, readSrc } = require('./lib/harness');
const srcScan = require('../lib/src-scan');

const appSrc = readSrc('js/app.js');

/* 从源码读常量值 —— 理由见下面沙箱里那段注释。 */
function readConst(name, fallback) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*(-?[0-9.]+)').exec(appSrc);
  return m ? Number(m[1]) : fallback;
}

t('T1 attachTabDragDelegation 返回退订函数（不再只挂不退）', () => {
  /* 锁的是：函数末尾没有 return，调用方拿不到任何东西，
   * 于是这三个监听只能永远挂着。 */
  const fn = srcScan.extractFn(appSrc, 'function attachTabDragDelegation(', 'attachTabDragDelegation');
  /* 锁的是：函数从不返回退订函数 —— 三个 document 监听只能永远挂着，
   * 切 N 次语言后拖一次弹 N 个窗口。行为测在 T5/T6，形态本身读源码最直接，
   * 真跑需要 DOM + 反复整壳重建。 */
  assert.ok(/return\s+function\s+\w*[Uu]nsub|return\s+\(\s*\)\s*=>/.test(fn),
    'attachTabDragDelegation 没有返回退订函数');
  for (const ev of ['pointermove', 'pointerup', 'pointercancel']) {
    /* 锁的是：退订里漏掉某一个 pointer 事件 —— 那一类监听就一直累积。
     * 只能用源码断言：行为上只能验证"总量归零"，无法指出漏了哪一个。 */
    assert.ok(new RegExp("removeEventListener\\(\\s*'" + ev + "'").test(fn),
      '退订里漏了 ' + ev + ' —— 那一类监听会一直累积');
  }
});

t('T2 退订函数存到模块级，并由 shellCleanup 调用', () => {
  /* 只返回 unsub 不够：renderTabs 里的调用点必须把它存下来，
   * 而 shellCleanup 是唯一在整壳重建前被调用的地方。
   * 少了这一段，返回的 unsub 会被直接丢掉（调完即忘），等于没改。
   *
   * 【注意 shellCleanup 有两份】独立窗的 buildStandaloneShell 里也定义了一份，
   * 而它不该管标签拖拽（独立窗没有标签栏）。所以这里取**最后**一份 ——
   * 主窗 buildShell 里那份。用第一份会让这条断言永远红，且理由还是错的。 */
  /* 锁的是：返回了 unsub 却没人接收（调完即忘），等于没改。
   * 只能用源码断言：三个环节分散在模块级变量、renderTabs、shellCleanup，
   * 要验的是它们有没有串起来，而行为测（T5/T6）只覆盖前两个。 */
  assert.ok(/let\s+tabDragUnsub/.test(appSrc),
    '没有模块级的 tabDragUnsub —— 返回的退订函数会被丢掉');
  /* 锁的是：renderTabs 没有保存返回值 —— unsub 调完即忘。 */
  assert.ok(/tabDragUnsub\s*=\s*attachTabDragDelegation\(/.test(appSrc),
    'renderTabs 没有保存 attachTabDragDelegation 的返回值');
  const at = appSrc.lastIndexOf('shellCleanup = () =>');
  assert.ok(at > 0, '找不到主窗的 shellCleanup');
  const shell = srcScan.extractFn(appSrc.slice(at), 'shellCleanup = () =>', 'shellCleanup');
  /* 锁的是：shellCleanup 没调用它 —— 整壳重建时不会退订，回到累积状态。 */
  assert.ok(/tabDragUnsub\(\)/.test(shell),
    'shellCleanup 没有调用 tabDragUnsub —— 整壳重建时不会退订');
});

t('T3 截图回包校验的是「同一次拖拽」，不是「当前还在拖」', () => {
  /* 锁的是：`if (!dragState || !dragState.out) return;` ——
   * 只判 out 会让上一轮的截图盖到新一轮的预览上（两轮 out 都是 true）。 */
  const fn = srcScan.extractFn(appSrc, 'function attachTabDragDelegation(', 'attachTabDragDelegation');
  /* 锁的是：`if (!dragState || !dragState.out) return;` —— 只判 out 会让
   * 上一轮的截图盖到新一轮的预览上（两轮 out 都是 true）。
   * 只能用源码断言：这个窗口只有 5ms 宽，要稳定复现必须控制截图返回的时机，
   * 而 captureContentThumb 走的是真实 IPC。 */
  const i = fn.indexOf('captureContentThumb()');
  assert.ok(i > 0, '找不到截图调用');
  const tail = fn.slice(i, i + 1200);
  /* 锁的是：只判 `dragState.out` —— 上一轮的截图会盖到新一轮的预览上
   * （两轮 out 都是 true）。只能用源码断言：这个窗口只有 5ms 宽，
   * 稳定复现必须控制截图返回的时机，而 captureContentThumb 走真实 IPC。 */
  assert.ok(/dragState\s*!==\s*st/.test(tail),
    '截图回包没有比对 dragState 身份 —— 上一轮的图会盖到新一次拖拽上');
  /* 锁的是：没有先把当轮的 dragState 抓成局部常量 —— 后续所有判断都会
   * 退化成"读当前状态"，上一轮的图就分不清是谁的了。 */
  assert.ok(/const\s+st\s*=\s*dragState/.test(fn.slice(0, i + 200)),
    '没有先把当轮的 dragState 抓成局部常量');
});

t('T4 fallback 卡片的工具名取自当轮快照，不读全局 dragState', () => {
  /* 读全局时名字会错：用户看到"图标对、名字错"，比不显示还困惑。
   * 【断言窗口要往前取】标记 'tab-drag-ghost-fallback' 出现在
   * div(...) 调用之后 —— 而工具名是在它**前面**算出来的
   * （const t = R.get(st.toolId)），所以往后再截 400 字看不到那行。 */
  const fn = srcScan.extractFn(appSrc, 'function attachTabDragDelegation(', 'attachTabDragDelegation');
  /* 锁的是：fallback 卡片从全局 dragState 读名字 —— 用户看到"图标对、名字错"。
   * 只能用源码断言：这条只在截图失败**且**两轮拖拽重叠时才显形，
   * 而 captureContentThumb 走真实 IPC，无法在单测里稳定造出失败时序。 */
  const i = fn.indexOf('tab-drag-ghost-fallback');
  assert.ok(i > 0, '找不到降级卡片');
  const around = fn.slice(Math.max(0, i - 400), i + 400);
  /* 锁的是：降级卡片从全局 dragState 读名字 —— 用户看到"图标对、名字错"。
   * 只能用源码断言：这条只在截图失败**且**两轮拖拽重叠时才显形，
   * 而 captureContentThumb 走真实 IPC，无法稳定造出失败时序。 */
  assert.ok(/R\.get\(\s*st\.toolId\s*\)/.test(around), '降级卡片没用当轮快照的 toolId');
  /* 锁的是同一条回归的反面写法：仍在读全局。 */
  assert.ok(!/R\.get\(\s*dragState\.toolId\s*\)/.test(around), '降级卡片仍在读全局 dragState');
});

/* ---------- 行为：真的执行一遍 ---------- */

/* 把 attachTabDragDelegation 及其依赖抽出来在桩里跑。
 *
 * 【为什么要 eval 这一段，而不是重写一份等价逻辑】重写一份等于测副本：
 * 实现改了、副本没改，测试照样绿（本项目历史上踩过多次）。
 * 这里直接从项目源码里取函数体，把它放进一个受控的作用域执行 ——
 * 跑的是**将来真会跑的那段代码**。
 */
function makeSandbox() {
  /* document 桩：记录挂上去的监听，用来数数量。 */
  const docListeners = new Map();   // type -> Set<fn>
  const document = {
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      const s = docListeners.get(type);
      if (s) s.delete(fn);
    },
    body: { appendChild() {} },
    querySelector() { return null; },
  };
  const barListeners = new Map();
  /* 【必须用有原型的方法，不能用 Object.assign 拼】Object.assign 只复制
   * 自有可枚举属性，而对象字面量里的方法确实是自有属性 —— 但下面 T6 要
   * 造第二个 bar 时如果写成 Object.assign({}, sb.bar)，拿到的是一份
   * 共享同一个 Map 的浅拷贝，两个 bar 的监听会混在一起，
   * 于是"一次拖拽只发一次"这条断言永远成立（假绿）。
   * 所以做成工厂：每个 bar 有自己的监听表。 */
  const makeBar = () => {
    const listeners = new Map();
    return {
      __heheTabDrag: false,
      _listeners: listeners,
      /* 标签栏的几何：36px 高、横向 x=0..600。被测代码用它判断
       * "指针有没有离开标签栏"（v0.6.5 的拖出判据），桩必须给出真实矩形，
       * 否则 isOutsideBar 会一直报错或恒真。 */
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 36, width: 600, height: 36 }),
      querySelectorAll: () => [],
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        const s = listeners.get(type);
        if (s) s.delete(fn);
      },
    };
  };

  const opened = [];                 // 开窗请求（工具 id）
  /* 重排相关的记录：落点指示条被显示过几次、最后落在哪个 x。 */
  const markers = { shown: 0, hidden: 0, lastX: null };
  const sandbox = {
    document,
    div: () => ({ appendChild() {}, classList: { add() {}, remove() {}, toggle() {} }, style: {}, innerHTML: '', isConnected: true }),
    h: () => ({ appendChild() {} }),
    icon: () => ({}),
    toast: () => {},
    requestAnimationFrame: (fn) => { fn(); return 1; },
    invoke: (ch, id) => { opened.push(id); return Promise.resolve({}); },
    Channels: { CHANNELS: { APP: { OPEN_TOOL_WINDOW: 'app:open-tool-window' } } },
    R: { get: (id) => ({ id, name: '工具-' + id, icon: 'x' }) },
    TN: (tt) => (tt && tt.name) || '',
    hideDragGhost: () => {},
    ensureDragGhost: () => ({ style: {}, classList: { add() {} }, appendChild() {}, innerHTML: '', isConnected: true }),
    /* v0.6.5 新增的重排依赖。桩要能观测"指示条被调用了没有"，
     * 否则重排分支在这个沙箱里等于没跑过。 */
    ensureDropMarker: () => {
      const el = { style: {}, isConnected: true };
      return el;
    },
    hideDropMarker: () => { markers.hidden++; },
    showDropMarker: (bar, x) => { markers.shown++; markers.lastX = x; },
    computeDropTarget: (bar, id, clientX) => {
      /* 简化版：把左右两侧各算一个落点回来，够驱动 reorder 分支 */
      return { index: clientX > 300 ? 1 : 0, beforeEl: null, x: clientX };
    },
    captureContentThumb: () => Promise.resolve(null),
    /* 【阈值从源码读，不要在这里写死】
     * 写死的话，"把源码里的阈值改掉"这类变异传不进沙箱，断言照样绿 ——
     * 测的就是测试文件自己的数字，不是实现。见 test-tab-drag-reorder.js 里
     * readConst 的说明（那里踩过一次）。 */
    TAB_DRAG_THRESHOLD: readConst('TAB_DRAG_THRESHOLD', 40),
    TAB_REORDER_THRESHOLD: readConst('TAB_REORDER_THRESHOLD', 6),
    dragGhostEl: null,
    opened,
    docListeners,
    barListeners,
    makeBar,
    markers,
  };
  /* 【这两个必须在沙箱对象建好之后再挂】
   * 它们要读写 sandbox 自己（state.tabs / renderTabsCalls），
   * 写在对象字面量里的话那个 const 还在 TDZ，运行到箭头函数时才会报
   * ReferenceError —— 而且只在重排分支触发，普通拖出路径看不见。 */
  sandbox.state = { tabs: ['a', 'b', 'c'] };
  sandbox.renderTabsCalls = 0;
  sandbox.renderTabs = () => { sandbox.renderTabsCalls++; };
  /* 与 app.js 的 reorderTabs 等价（它是模块级函数，不在被测函数体内）。
   * targetIndex 是"去掉被拖那一个之后"的下标，splice 直接按它插回即可。 */
  sandbox.reorderTabs = (movingId, targetIndex) => {
    const from = sandbox.state.tabs.indexOf(movingId);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(targetIndex, sandbox.state.tabs.length - 1));
    if (from === to) return false;
    sandbox.state.tabs.splice(from, 1);
    sandbox.state.tabs.splice(to, 0, movingId);
    return true;
  };
  return sandbox;
}

/* 从源码里取出函数体，包成一个可调用函数。
 *
 * 【为什么用 new Function 把真源码装进去，而不是另写一份等价逻辑】
 * 另写一份等于测副本：实现改了副本没改，测试照样绿（本项目历史上踩过多次）。
 * 这里直接从 js/app.js 取出 attachTabDragDelegation 的函数体执行 ——
 * 跑的是将来真会跑的那段代码，只是把外部世界换成桩。
 *
 * 形参只列**函数自身直接引用**的名字；dragGhostEl 是模块级变量（函数内部
 * 靠闭包读它），在这里用局部 let 顶上，等价于闭包变量。 */
function compileAttach() {
  const fn = srcScan.extractFn(appSrc, 'function attachTabDragDelegation(', 'attachTabDragDelegation');
  return new Function(
    'document', 'div', 'h', 'icon', 'toast', 'requestAnimationFrame',
    'invoke', 'Channels', 'R', 'TN', 'hideDragGhost', 'ensureDragGhost',
    'captureContentThumb', 'TAB_DRAG_THRESHOLD', 'TAB_REORDER_THRESHOLD',
    /* v0.6.5 重排新增的依赖。不注入会 ReferenceError —— 实测踩过，
     * 而且它只在重排分支里用到，普通拖出路径不会碰到。 */
    'ensureDropMarker', 'hideDropMarker', 'showDropMarker', 'computeDropTarget',
    'reorderTabs', 'state', 'renderTabs',
    'let dragGhostEl = null;\nlet dropMarkerEl = null;\n' + fn + '\nreturn attachTabDragDelegation;');
}

/* 统一的接线：把桩按 compileAttach 的形参顺序传进去。 */
function attachWith(sb, bar) {
  const compile = compileAttach();
  return compile(
    sb.document, sb.div, sb.h, sb.icon, sb.toast, sb.requestAnimationFrame,
    sb.invoke, sb.Channels, sb.R, sb.TN, sb.hideDragGhost, sb.ensureDragGhost,
    sb.captureContentThumb, sb.TAB_DRAG_THRESHOLD, sb.TAB_REORDER_THRESHOLD,
    sb.ensureDropMarker, sb.hideDropMarker, sb.showDropMarker, sb.computeDropTarget,
    sb.reorderTabs, sb.state, sb.renderTabs)(bar);
}

t('T5 行为：挂上之后 document 上有三个监听，调用 unsub 后归零', () => {
  const sb = makeSandbox();
  const bar = sb.makeBar();
  const unsub = attachWith(sb, bar);
  assert.strictEqual(typeof unsub, 'function', '挂上之后没拿到退订函数');
  const count = (m) => [...m.values()].reduce((n, s) => n + s.size, 0);
  const afterAttach = count(sb.docListeners);
  assert.strictEqual(afterAttach, 3,
    'document 上应挂 3 个监听（move/up/cancel），实际 ' + afterAttach);

  unsub();
  assert.strictEqual(count(sb.docListeners), 0,
    '退订之后 document 上还剩 ' + count(sb.docListeners) + ' 个监听 —— 会一直累积');
  assert.strictEqual(count(bar._listeners), 0, 'bar 上的 pointerdown 没有退订');
});

t('T6 行为：旧壳退订后重新挂，一次拖拽只发一次开窗请求', async () => {
  /* 这条直接对应"切 N 次语言后拖一次弹出 N 个窗口"的用户体验。
   * 场景：壳重建 → 旧标签栏退订 → 新标签栏挂上 → 用户拖一次。
   * 若旧监听没退，两个 handler 都会响应，opened 里出现两次。 */
  const sb = makeSandbox();
  const barA = sb.makeBar();
  const uA = attachWith(sb, barA);
  assert.strictEqual(typeof uA, 'function');

  /* 整壳重建：旧壳退订。 */
  uA();
  assert.strictEqual([...sb.docListeners.values()].reduce((n, s) => n + s.size, 0), 0,
    '退订后 document 上仍有监听');

  /* 新壳：新的 bar 元素（__heheTabDrag 自然不存在）。 */
  const barB = sb.makeBar();
  const uB = attachWith(sb, barB);
  assert.strictEqual(typeof uB, 'function');

  const tabEl = {
    dataset: { toolId: 'base64' },
    classList: { add() {}, remove() {}, toggle() {} },
    setPointerCapture() {},
  };
  const downs = [...(barB._listeners.get('pointerdown') || [])];
  assert.strictEqual(downs.length, 1, 'bar 上的 pointerdown 数量异常：' + downs.length);
  downs[0]({ button: 0, pointerId: 1, clientX: 10, clientY: 10,
    target: { closest: (sel) => (sel === '.tab' ? tabEl : null) } });

  const moves = [...(sb.docListeners.get('pointermove') || [])];
  assert.strictEqual(moves.length, 1, 'document 上的 pointermove 应只有 1 份，实际 ' + moves.length);
  moves[0]({ pointerId: 1, clientX: 10, clientY: 80 });   // 纵向 70px > 阈值

  const ups = [...(sb.docListeners.get('pointerup') || [])];
  assert.strictEqual(ups.length, 1, 'document 上的 pointerup 应只有 1 份，实际 ' + ups.length);
  ups[0]({ pointerId: 1 });
  await Promise.resolve();

  assert.strictEqual(sb.opened.length, 1,
    '一次拖拽发出了 ' + sb.opened.length + ' 次开窗请求 —— 说明旧壳的监听没退订');
  assert.strictEqual(sb.opened[0], 'base64');
  uB();
});

done();
