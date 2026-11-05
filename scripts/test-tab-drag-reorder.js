'use strict';
/* 标签拖拽的两种结果：左右重排 / 上下左右任一方向拖出成独立窗口。
 *
 * ============ 锁的是哪个回归 ============
 * v0.6.4 之前只有一条判据：`dy > 40 && dy > |dx|` —— 也就是**只认向下拖**。
 *   · 向上拖：dy 是负数，`dy > 40` 恒假，怎么拖都不会弹窗
 *   · 向左/右拖：dy≈0，判据不成立，而且**没有任何重排逻辑** ——
 *     用户把标签往右挪一小段，既不开窗也不会换位置，什么反应都没有
 * 而浏览器语义里，"栏内左右移动 = 调换位置"是最常用的一条。
 *
 * ============ 验证方式：把真源码装进桩里跑 ============
 * 与 test-tab-drag-cleanup 同一套做法：从 js/app.js 取出
 * attachTabDragDelegation 的函数体、用桩补齐外部世界、真的派发 pointer 事件。
 * 断言的是**行为结果**（有没有开窗、state.tabs 的顺序、指示条画在哪），
 * 不是源码文本。
 *
 * 【几何约定】桩里的标签栏是 (0,0)-(600,36)：
 *   · 栏内       → y ∈ [0,36]
 *   · 向下出界   → y > 36
 *   · 向上出界   → y < 0
 *   · 向左出界   → x < 0
 *   · 向右出界   → x > 600
 */
const { t, done, assert, readSrc } = require('./lib/harness');
const srcScan = require('../lib/src-scan');

const appSrc = readSrc('js/app.js');
const BAR = { left: 0, top: 0, right: 600, bottom: 36, width: 600, height: 36 };

/* 三个标签，各占 100px，从 x=16 开始 —— 与真实标签栏的内边距量级一致。 */
const TAB_RECTS = {
  a: { left: 16, right: 116 },
  b: { left: 118, right: 218 },
  c: { left: 220, right: 320 },
};

/* 从源码读出真实的常量值，而不是在测试里另抄一份。
 *
 * 【这一步是必须的，不是洁癖】最初的写法是在沙箱里写死
 * `TAB_REORDER_THRESHOLD: 6` —— 于是"把源码里的阈值改成 0"这个变异
 * 根本传不进沙箱，测试照样全绿（实测确认过：R6 对阈值变异完全不敏感）。
 * 换句话说，那条断言测的是测试文件自己的数字，不是实现的。
 * 现在直接从 js/app.js 解析，实现改了沙箱跟着改，变异才能被发现。 */
function readConst(name, fallback) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*(-?[0-9.]+)').exec(appSrc);
  return m ? Number(m[1]) : fallback;
}
const TAB_DRAG_THRESHOLD = readConst('TAB_DRAG_THRESHOLD', 40);
const TAB_REORDER_THRESHOLD = readConst('TAB_REORDER_THRESHOLD', 6);

function makeSandbox() {
  const docListeners = new Map();
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

  const opened = [];        // 开窗请求
  const markers = { shown: 0, hidden: 0, lastX: null };

  const sb = {
    document,
    div: () => ({
      appendChild() {}, innerHTML: '', isConnected: true,
      classList: { add() {}, remove() {}, toggle() {} }, style: {},
    }),
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
    ensureDropMarker: () => ({ style: {}, isConnected: true }),
    hideDropMarker: () => { markers.hidden++; },
    showDropMarker: (bar, x) => { markers.shown++; markers.lastX = x; },
    /* 【这里是真实现，不是桩】
     * computeDropTarget 的逻辑正是"落点算得对不对"的核心，
     * 桩掉它就等于没测。它只依赖 getBoundingClientRect，沙箱能给。 */
    computeDropTarget: null,
    captureContentThumb: () => Promise.resolve(null),
    TAB_DRAG_THRESHOLD, TAB_REORDER_THRESHOLD,
    dragGhostEl: null,
    dropMarkerEl: null,
    opened,
    docListeners,
    markers,
    BAR,
  };

  /* 标签栏元素：三个标签，几何由 TAB_RECTS 决定 */
  sb.makeBar = () => {
    const listeners = new Map();
    const tabEls = ['a', 'b', 'c'].map((id) => ({
      dataset: { toolId: id },
      _id: id,
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
      setPointerCapture() {},
      getBoundingClientRect() {
        return Object.assign({ top: 0, bottom: 36, width: 100, height: 36 }, TAB_RECTS[this._id]);
      },
    }));
    return {
      __heheTabDrag: false,
      _listeners: listeners,
      _tabEls: tabEls,
      getBoundingClientRect: () => Object.assign({}, BAR),
      querySelectorAll: () => tabEls,
      classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, toggle() {} },
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

  sb.state = { tabs: ['a', 'b', 'c'] };
  sb.renderTabsCalls = 0;
  sb.renderTabs = () => { sb.renderTabsCalls++; };
  sb.reorderTabs = (movingId, targetIndex) => {
    const from = sb.state.tabs.indexOf(movingId);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(targetIndex, sb.state.tabs.length - 1));
    if (from === to) return false;
    sb.state.tabs.splice(from, 1);
    sb.state.tabs.splice(to, 0, movingId);
    return true;
  };
  return sb;
}

/* 把真源码装进受控作用域。computeDropTarget 也用 app.js 里的真实现。 */
function compileAll() {
  const computeSrc = srcScan.extractFn(appSrc, 'function computeDropTarget(', 'computeDropTarget');
  const attachSrc = srcScan.extractFn(appSrc, 'function attachTabDragDelegation(', 'attachTabDragDelegation');
  return new Function(
    'document', 'div', 'h', 'icon', 'toast', 'requestAnimationFrame',
    'invoke', 'Channels', 'R', 'TN', 'hideDragGhost', 'ensureDragGhost',
    'captureContentThumb', 'TAB_DRAG_THRESHOLD', 'TAB_REORDER_THRESHOLD',
    'ensureDropMarker', 'hideDropMarker', 'showDropMarker',
    'reorderTabs', 'state', 'renderTabs',
    'let dragGhostEl = null;\nlet dropMarkerEl = null;\n'
    + computeSrc + '\n' + attachSrc + '\n'
    + 'return { attachTabDragDelegation, computeDropTarget };');
}

/* 建一次可用的拖拽上下文：返回 { attach, bar, fire, down, up, sb } */
function setup(sb) {
  const bar = sb.makeBar();
  const fns = compileAll()(
    sb.document, sb.div, sb.h, sb.icon, sb.toast, sb.requestAnimationFrame,
    sb.invoke, sb.Channels, sb.R, sb.TN, sb.hideDragGhost, sb.ensureDragGhost,
    sb.captureContentThumb, sb.TAB_DRAG_THRESHOLD, sb.TAB_REORDER_THRESHOLD,
    sb.ensureDropMarker, sb.hideDropMarker, sb.showDropMarker,
    sb.reorderTabs, sb.state, sb.renderTabs);
  const attach = fns.attachTabDragDelegation(bar);
  assert.strictEqual(typeof attach, 'function', 'attach 没有返回退订函数');

  const down = (tabId, x, y) => {
    const downs = [...(bar._listeners.get('pointerdown') || [])];
    const tabEl = bar._tabEls.find((el) => el._id === tabId);
    const tabRect = TAB_RECTS[tabId];
    downs[0]({
      button: 0, pointerId: 1, clientX: x == null ? (tabRect.left + tabRect.right) / 2 : x,
      clientY: y == null ? 18 : y,
      target: { closest: (sel) => (sel === '.tab' ? tabEl : null) },
    });
  };
  /* pointermove / pointerup 都派发到 document（实现里绑在 document 上） */
  const fire = (type, x, y) => {
    for (const fn of (sb.docListeners.get(type) || [])) {
      fn({ pointerId: 1, clientX: x, clientY: y });
    }
  };
  return { attach, bar, down, fire, sb };
}

/* ---------- ① 四个方向都能拖出 ---------- */

t('D1 向下拖出标签栏 → 松手开独立窗口（原有行为不能丢）', () => {
  /* 锁的是：v0.6.4 只支持这一条 —— 它必须继续有效。 */
  const sb = makeSandbox();
  const { down, fire } = setup(sb);
  down('a');
  fire('pointermove', 66, 18 + 60);       // y=78，已出下边界 36，且 60>40
  fire('pointerup', 66, 78);
  assert.deepStrictEqual(sb.opened, ['a'], '向下拖出没有开窗');
});

t('D2 向上拖出标签栏 → 松手开独立窗口（这是原来完全做不到的）', () => {
  /* 锁的是：`dy > 40` 里 dy 是负数，向上拖恒假 —— 旧实现在这个方向彻底失灵。 */
  const sb = makeSandbox();
  const { down, fire } = setup(sb);
  down('a');
  fire('pointermove', 66, 18 - 60);       // y=-42，已出上边界
  fire('pointerup', 66, -42);
  assert.deepStrictEqual(sb.opened, ['a'], '向上拖出没有开窗');
});

t('D3 向左拖出标签栏 → 松手开独立窗口', () => {
  /* 锁的是：旧实现横向完全不参与判据，向左拖会命中"重排"分支（或什么都不做），
   * 而浏览器的语义是"拖出标签栏就是拖出窗口"。 */
  const sb = makeSandbox();
  const { down, fire } = setup(sb);
  down('b', 168, 18);
  fire('pointermove', -60, 18);           // x=-60 < 0，出左边界
  fire('pointerup', -60, 18);
  assert.deepStrictEqual(sb.opened, ['b'], '向左拖出没有开窗');
});

t('D4 向右拖出标签栏 → 松手开独立窗口', () => {
  const sb = makeSandbox();
  const { down, fire } = setup(sb);
  down('b', 168, 18);
  fire('pointermove', 700, 18);           // x=700 > 600，出右边界
  fire('pointerup', 700, 18);
  assert.deepStrictEqual(sb.opened, ['b'], '向右拖出没有开窗');
});

t('D5 出界后给的是「拖出」视觉（虚线框），不是重排视觉', () => {
  /* 锁的是：两种结果必须有可分辨的反馈 —— 用户第一次拖动时不知道
   * 松手会发生什么，视觉区分比文字提示有效。 */
  const sb = makeSandbox();
  const { down, fire, bar } = setup(sb);
  down('a');
  fire('pointermove', 66, 78);
  const tabEl = bar._tabEls[0];
  assert.ok(tabEl.classList.contains('tab-drag-out'), '出界后没有 tab-drag-out');
  assert.ok(!tabEl.classList.contains('tab-reorder'), '出界后仍带着重排视觉（两套视觉会打架）');
});

/* ---------- ② 栏内左右移动 = 重排 ---------- */

t('R1 栏内向右拖过一个标签的中线 → 松手后位置交换', () => {
  /* 锁的是：旧实现完全没有重排 —— 用户把标签往右挪，什么都不发生。 */
  const sb = makeSandbox();
  const { down, fire } = setup(sb);
  down('a', 66, 18);
  /* b 的中点 = (118+218)/2 = 168；拖到 200 已越过它 → 落点 index=1 */
  fire('pointermove', 200, 18);
  fire('pointerup', 200, 18);
  assert.deepStrictEqual(sb.state.tabs, ['b', 'a', 'c'],
    '重排结果不对：' + JSON.stringify(sb.state.tabs));
  assert.deepStrictEqual(sb.opened, [], '重排不该开窗');
});

t('R2 栏内向左拖 → 松手后位置交换（方向对称）', () => {
  const sb = makeSandbox();
  const { down, fire } = setup(sb);
  down('c', 270, 18);
  /* a 的中点 = 66；拖到 20 已在它左边 → 落点 index=0 */
  fire('pointermove', 20, 18);
  fire('pointerup', 20, 18);
  assert.deepStrictEqual(sb.state.tabs, ['c', 'a', 'b'],
    '向左重排结果不对：' + JSON.stringify(sb.state.tabs));
  assert.deepStrictEqual(sb.opened, [], '重排不该开窗');
});

t('R3 重排时会画出落点指示条', () => {
  /* 锁的是：没有任何视觉反馈的话，用户不知道为什么松手后标签换了位置。 */
  const sb = makeSandbox();
  const { down, fire } = setup(sb);
  down('a', 66, 18);
  fire('pointermove', 200, 18);
  assert.strictEqual(sb.markers.shown, 1, '重排时没有画落点指示条');
  assert.strictEqual(typeof sb.markers.lastX, 'number', '指示条位置不是数字');
});

t('R4 重排时标签带 .tab-reorder、且不带 .tab-drag-out', () => {
  const sb = makeSandbox();
  const { down, fire, bar } = setup(sb);
  down('a', 66, 18);
  fire('pointermove', 200, 18);
  const el = bar._tabEls[0];
  assert.ok(el.classList.contains('tab-reorder'), '重排时没有 tab-reorder 视觉');
  assert.ok(!el.classList.contains('tab-drag-out'), '重排时不该有虚线框（那是拖出的语义）');
});

t('R5 重排只重画标签栏，不重建内容区（不能打断正在跑的任务）', () => {
  /* 锁的是：为了重排去调 render()，会触发 runPageCleanup → 工具页整页重建，
   * 正在跑的 ffmpeg 之类会被中断。这是"顺手把实现写错"最容易踩的一脚。 */
  const sb = makeSandbox();
  const { down, fire } = setup(sb);
  down('a', 66, 18);
  fire('pointermove', 200, 18);
  fire('pointerup', 200, 18);
  assert.strictEqual(sb.renderTabsCalls, 1,
    '重排后应只调用一次 renderTabs，实际 ' + sb.renderTabsCalls);
});

t('R6 横向移动不足阈值 → 不算重排（按一下标签不该把它挪走）', () => {
  /* 锁的是：把阈值写成 0 会让"点一下标签"被记成一次移动。
   * 指针按下时总有 1~2px 抖动。
   *
   * 【判据必须看"有没有进入重排状态"，不能只看"顺序变没变"】
   * 只看顺序的话这条会漏：阈值=0 时确实进入了重排分支、也画了指示条，
   * 但只要指针没越过任何标签的中线，computeDropTarget 仍然返回 0，
   * 顺序就不会变 —— 于是"阈值改成 0"这个变异照样 PASS（实测确认过）。
   * 所以同时断言：没进入重排（无 .tab-reorder）、没画指示条。 */
  const sb = makeSandbox();
  const { down, fire, bar } = setup(sb);
  down('a', 66, 18);
  fire('pointermove', 69, 18);            // 只移动 3px < 6
  const el = bar._tabEls[0];
  assert.ok(!el.classList.contains('tab-reorder'),
    '3px 的抖动就进入了重排状态（阈值没起作用）');
  assert.strictEqual(sb.markers.shown, 0, '不足阈值却画了指示条');
  fire('pointerup', 69, 18);
  assert.deepStrictEqual(sb.state.tabs, ['a', 'b', 'c'], '3px 的抖动把标签挪走了');
});

t('R7 重排后原地不动时不重画（避免无谓重建）', () => {
  /* 锁的是：targetIndex 与当前位置相同还去 renderTabs —— 标签栏闪一下，
   * 观感像"拖动失败了"。 */
  const sb = makeSandbox();
  const { down, fire } = setup(sb);
  down('a', 66, 18);
  fire('pointermove', 120, 18);           // 还没越过 b 的中点 → 仍落在 index 0
  fire('pointerup', 120, 18);
  assert.deepStrictEqual(sb.state.tabs, ['a', 'b', 'c']);
  assert.strictEqual(sb.renderTabsCalls, 0, '没有位置变化却重画了标签栏');
});

/* ---------- ③ 两个分支不能互相污染 ---------- */

t('X1 先重排、再拖出 → 最终按拖出处理（松手开窗，顺序不变）', () => {
  /* 锁的是：两个分支在同一轮拖拽里叠在一起 —— 用户拖着拖着改主意了。
   * 松手时必须以**最终状态**为准，而且重排的视觉残留必须被清掉。 */
  const sb = makeSandbox();
  const { down, fire } = setup(sb);
  down('a', 66, 18);
  fire('pointermove', 200, 18);           // 先进入重排
  fire('pointermove', 66, 100);           // 再往下出界（y=100 > 36）
  fire('pointerup', 66, 100);
  assert.deepStrictEqual(sb.opened, ['a'], '从重排转为拖出后没有开窗');
  assert.deepStrictEqual(sb.state.tabs, ['a', 'b', 'c'],
    '转为拖出后顺序不该变：' + JSON.stringify(sb.state.tabs));
});

t('X2 拖出后重排视觉被清掉、指示条被隐藏', () => {
  const sb = makeSandbox();
  const { down, fire } = setup(sb);
  down('a', 66, 18);
  fire('pointermove', 200, 18);           // 重排
  fire('pointermove', 66, 100);           // 转拖出
  assert.ok(sb.markers.hidden >= 1, '转为拖出后没有隐藏落点指示条');
});

t('X3 松手在栏内、且没越过任何阈值 → 既不开窗也不重排（交给 click 切换标签）', () => {
  /* 锁的是：普通点击标签必须仍然能切页。拖拽逻辑不能把点击吃掉。 */
  const sb = makeSandbox();
  const { down, fire } = setup(sb);
  down('b', 168, 18);
  fire('pointerup', 168, 18);
  assert.deepStrictEqual(sb.opened, [], '只是点了一下却开窗了');
  assert.deepStrictEqual(sb.state.tabs, ['a', 'b', 'c'], '只是点了一下却重排了');
  assert.strictEqual(sb.renderTabsCalls, 0);
});

done();
