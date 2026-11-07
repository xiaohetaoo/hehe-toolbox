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
    /* 【ghost 桩必须有状态】hideDragGhost 会清 innerHTML 并设 display:none；
     * 若桩是空函数，就验不出"拖回之后再拖出时预览还在不在"——
     * 而那正是问题 5 的全部内容。这里复刻 lib 里那两个真函数的行为
     * （真实现在 js/app.js 的 ensureDragGhost / hideDragGhost 里，
     *  但它们是模块级闭包，不便单独注入，这里按等价语义实现）。 */
    hideDragGhost: () => { sb.ghost.innerHTML = ''; sb.ghost.style.display = 'none'; sb.ghost.classList._set.delete('show'); },
    ensureDragGhost: () => sb.ghost,
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
  /* 有状态的浮层桩（见 hideDragGhost / ensureDragGhost 的说明） */
  sb.ghost = {
    style: { display: 'none' },
    innerHTML: '',
    isConnected: true,
    _children: [],
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    appendChild(n) { this._children.push(n); this.innerHTML = 'x'; },
  };
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

/* 建一次可用的拖拽上下文：返回 { attach, bar, fire, down, up, sb }
 * @param {object} sb 沙箱
 * @param {object} [barOverride] 指定标签栏（用它来造"禁用兜底扫描"的桩） */
function setup(sb, barOverride) {
  const bar = barOverride || sb.makeBar();
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

/* ---------- ④ 松手后视觉状态必须真的被清掉 ----------
 *
 * 【这一组锁的是什么】
 * clearVisual 原先读的是闭包里的 dragState，而 finish / onCancel 的顺序都是
 * 「先置空 dragState，再清理」—— 于是它读到的是 null，两个 class 一个也清不掉。
 * 三条路径各自留下不同的残留：
 *   · 拖出成窗口（不拖回）→ tab-drag-out 残留（半透明 + 虚线框一直挂着），
 *     且 finish 的拖出分支 return 前不调 renderTabs，没有任何重建会抹掉它；
 *   · 重排但落点没变 → tab-reorder 残留（永久 opacity 0.6、z-index 压住邻项）；
 *   · pointercancel → 同样残留。
 *
 * 【为什么桩里要关掉"兜底扫描"】clearVisual 里有一层「拿不到 st 就扫整个
 * 标签栏」的兜底（给 unsub 用）。桩如果把 querySelectorAll 做成正常的，
 * 那么即使 clearVisual 退回读全局 dragState（拿不到 st），兜底扫描照样能把
 * class 清掉 —— 断言全绿，而"传 st"这条正确性完全没被验证（实测确认过：
 * 改回读全局后 C1~C3 仍然全过）。
 * 所以这一组用一个**禁用兜底**的标签栏桩：querySelectorAll 返回空数组，
 * 于是只有「真的用 st 清」才能通过。这才是这条回归真正的判据。
 */

/** 造一个禁用兜底扫描的标签栏（querySelectorAll 返回空）。 */
function makeStrictBar(sb) {
  const bar = sb.makeBar();
  bar.querySelectorAll = () => [];     // ← 关掉兜底扫描
  return bar;
}

t('C1 拖出成窗口松手后，tab-drag-out 必须被清掉', () => {
  /* 锁的是：松手的一瞬间 dragState 已被置空，clearVisual 读不到它。 */
  const sb = makeSandbox();
  const bar = makeStrictBar(sb);
  const { down, fire } = setup(sb, bar);
  down('a', 66, 18);
  fire('pointermove', 66, 100);          // 向下出界 → out=true
  const el = bar._tabEls[0];
  assert.ok(el.classList.contains('tab-drag-out'), '前置条件：拖动中应有 tab-drag-out');
  fire('pointerup', 66, 100);            // 松手 → 开窗
  assert.strictEqual(el.classList.contains('tab-drag-out'), false,
    '松手后 tab-drag-out 仍残留 —— 标签会一直半透明 + 虚线框'
    + '（拖出分支 return 前不调 renderTabs，没有重建会抹掉它）');
});

t('C2 重排落点未变、提前 return 时，tab-reorder 必须被清掉', () => {
  /* 锁的是：changed=false 那条提前 return 的分支 —— 它不调 renderTabs，
   * 于是 tab-reorder 永久残留（opacity 0.6 + z-index 抬起）。 */
  const sb = makeSandbox();
  const bar = makeStrictBar(sb);
  const { down, fire } = setup(sb, bar);
  down('a', 66, 18);
  fire('pointermove', 120, 18);          // 越过重排阈值但没越过 b 的中线
  const el = bar._tabEls[0];
  assert.ok(el.classList.contains('tab-reorder'), '前置条件：拖动中应有 tab-reorder');
  fire('pointerup', 120, 18);
  assert.strictEqual(sb.renderTabsCalls, 0, '前置条件：落点未变不应重画');
  assert.strictEqual(el.classList.contains('tab-reorder'), false,
    '落点未变时 tab-reorder 残留 —— 标签会永久保持半透明并压在邻项之上');
});

t('C3 pointercancel 之后两个 class 都必须清掉', () => {
  /* 锁的是：onCancel 与 finish 犯了同一个错（先置空再清理）。
   * pointercancel 在真实场景很常见：拖拽中被系统弹窗抢走、或窗口失焦。 */
  const sb = makeSandbox();
  const bar = makeStrictBar(sb);
  const { down, fire } = setup(sb, bar);
  down('a', 66, 18);
  fire('pointermove', 66, 100);          // 进入拖出状态
  const el = bar._tabEls[0];
  fire('pointercancel', 66, 100);
  assert.strictEqual(el.classList.contains('tab-drag-out'), false,
    'pointercancel 后 tab-drag-out 残留');
  assert.strictEqual(el.classList.contains('tab-reorder'), false,
    'pointercancel 后 tab-reorder 残留');
});

t('C4 残留会级联：上一次拖出的 class 不该带到下一次重排里', () => {
  /* 锁的是：两个 class 同时挂在同一个标签上 ——
   * 那正是「两套视觉必须一眼分开」要避免的状态，用户会看不懂松手会怎样。 */
  const sb = makeSandbox();
  const bar = makeStrictBar(sb);
  const { down, fire } = setup(sb, bar);
  const el = bar._tabEls[0];
  /* 第一次：拖出（不拖回），松手 */
  down('a', 66, 18);
  fire('pointermove', 66, 100);
  fire('pointerup', 66, 100);
  /* 第二次：同一个标签，改成重排 */
  down('a', 66, 18);
  fire('pointermove', 200, 18);
  assert.ok(el.classList.contains('tab-reorder'), '前置条件：应进入重排');
  assert.strictEqual(el.classList.contains('tab-drag-out'), false,
    '上一次拖出的 tab-drag-out 被带到了这一次重排里 —— 两套视觉叠在一起');
  fire('pointerup', 200, 18);
});

t('C5 clearVisual 必须优先用传入的 st（兜底扫描只给 unsub 用）', () => {
  /* 锁的是：实现退回「读全局 dragState + 兜底扫描」也能让 C1~C3 变绿 ——
   * 因为桩的 querySelectorAll 会兜住。这条用一个"扫描也没有标签"的桩
   * 反向确认：清掉的来源只能是 st.tabEl 本身。 */
  const sb = makeSandbox();
  const bar = makeStrictBar(sb);
  const { down, fire } = setup(sb, bar);
  const el = bar._tabEls[0];
  down('a', 66, 18);
  fire('pointermove', 66, 100);
  fire('pointerup', 66, 100);
  /* 到这一步，只有 st 分支能清掉它（扫描返回空） */
  assert.strictEqual(el.classList.contains('tab-drag-out'), false,
    '必须靠传入的 st.tabEl 清掉，不能指望扫描');
});

/* ---------- ⑤ 拖出 → 拖回 → 再拖出：预览必须重新出现 ----------
 *
 * 【锁的是什么】
 * 第一次越过阈值时置 `st.ghostReady = true` 并截图。用户拖回标签栏时，
 * `nowOut` 变 false → hideDragGhost() 把浮层 innerHTML 清空、display 设 'none'，
 * 但**没有复位 ghostReady**。再次拖出时 `if (!st.ghostReady)` 为假，
 * 截图分支被整个跳过；而 applyGhostPos 里又有「display === 'none' 就 return」，
 * 于是浮层既不重新截图、也不重新显示。
 *
 * 用户看到的是：标签半透明 + 虚线框都在，唯独没有跟着指针的预览图。
 * 触发路径很自然 —— 拖出去时犹豫了一下、拖回来又想拖出去。
 */

/** 跑一轮「出界 → 等截图 → 回栏内 → 再出界」，返回第二次出界后的浮层状态。 */
async function roundTrip(sb, bar) {
  const { down, fire } = setup(sb, bar);
  down('a', 66, 18);
  fire('pointermove', 66, 100);          // ① 出界
  await new Promise((r) => setTimeout(r, 0));   // 让 captureContentThumb 的 promise 兑现
  const afterFirst = { display: sb.ghost.style.display, inner: sb.ghost.innerHTML };
  fire('pointermove', 66, 18);           // ② 拖回标签栏内
  const afterBack = { display: sb.ghost.style.display, inner: sb.ghost.innerHTML };
  fire('pointermove', 66, 100);          // ③ 再出界
  await new Promise((r) => setTimeout(r, 0));
  const afterSecond = { display: sb.ghost.style.display, inner: sb.ghost.innerHTML };
  return { afterFirst, afterBack, afterSecond };
}

t('G1 拖出→拖回→再拖出，预览浮层必须重新显示', async () => {
  /* 锁的是：ghostReady 置 true 后从不复位 —— 第二次出界时浮层永远不出现。 */
  const sb = makeSandbox();
  const bar = sb.makeBar();
  const r = await roundTrip(sb, bar);

  /* 前提：第一次出界确实把浮层显示出来了（否则这条测试没有意义） */
  assert.notStrictEqual(r.afterFirst.display, 'none',
    '前置条件失败：第一次出界时浮层就没显示（截图桩没接上？）');
  /* 拖回时必须隐藏 —— 这是现有正确行为 */
  assert.strictEqual(r.afterBack.display, 'none', '拖回标签栏内时浮层应隐藏');
  /* 再拖出：必须重新显示（这就是那个 bug） */
  assert.notStrictEqual(r.afterSecond.display, 'none',
    '再次拖出时浮层没有重新显示 —— ghostReady 没有复位，'
    + '截图分支被跳过、applyGhostPos 又因 display=none 提前 return');
});

t('G2 再拖出时浮层里要有内容（不能是空壳）', async () => {
  /* 锁的是：即使 display 被设回 ''，innerHTML 是空的看起来仍是一片空白。 */
  const sb = makeSandbox();
  const bar = sb.makeBar();
  const r = await roundTrip(sb, bar);
  assert.ok(r.afterSecond.inner && r.afterSecond.inner.length > 0,
    '再次拖出时浮层是空的 —— 截图分支没有重新执行');
});

t('G3 拖回时浮层内容被清掉、再拖出时重新填充（不是复用了旧内容）', async () => {
  /* 锁的是：只把 display 改回来、却仍用着上一轮已清空的内容。 */
  const sb = makeSandbox();
  const bar = sb.makeBar();
  const r = await roundTrip(sb, bar);
  assert.strictEqual(r.afterBack.inner, '',
    '拖回时浮层内容应被清空（hideDragGhost 的职责）');
  assert.ok(r.afterSecond.inner.length > 0,
    '再拖出时内容没有重新填充');
});

/* ---------- ⑥ 横向出界必须立即算拖出（不再要 40px 位移）----------
 *
 * 【锁的是什么】
 * 注释与提交说明都写「横向出界立即生效，因为指针已经压到侧栏或窗口边缘，
 * 意图明确」，实现却对横向也要求 `adx > TAB_DRAG_THRESHOLD`(40px)。
 * 于是横向出界后、位移在 6~40px 之间时 nowOut 为 false，代码落进重排分支：
 * 画出落点竖线、标签变半透明，松手后若落点恰好是原位就什么都不发生 ——
 * 用户想「往左拖出去」，得到的是标签闪了一下又恢复原状。
 */

t('H1 起手靠左、横向越界但只移了 20px → 必须开窗（不是重排）', () => {
  /* 锁的是：横向出界被 40px 阈值挡住，拖到侧栏上却不弹窗。 */
  const sb = makeSandbox();
  const { down, fire, bar } = setup(sb);
  /* 标签 a 在 x∈[16,116]，从中点 66 起手；标签栏左边界是 0。
   * 拖到 x=-4：已越过左边界（出界），adx = 70 —— 这里要造的是
   * adx 在 6~40 之间的情形，所以起手点取靠近左边界的 20。 */
  down('a', 20, 18);
  fire('pointermove', -4, 18);           // adx = 24，已出左边界
  const el = bar._tabEls[0];
  assert.ok(el.classList.contains('tab-drag-out'),
    '横向出界（adx 只有 24）却没有进入拖出状态 —— 落进了重排分支');
  assert.strictEqual(el.classList.contains('tab-reorder'), false,
    '横向出界时不该带重排视觉');
  fire('pointerup', -4, 18);
  assert.deepStrictEqual(sb.opened, ['a'],
    '横向出界松手后没有开窗（预期开一次，实际 ' + sb.opened.length + ' 次）');
});

t('H2 反向：栏内水平移动 20px（没出界）→ 必须走重排、不开窗', () => {
  /* 锁的是：把"横向"一律当成拖出 —— 那会让栏内重排彻底不可用。 */
  const sb = makeSandbox();
  const { down, fire, bar } = setup(sb);
  down('a', 66, 18);
  fire('pointermove', 86, 18);           // adx = 20，仍在栏内（x < 600）
  const el = bar._tabEls[0];
  assert.strictEqual(el.classList.contains('tab-drag-out'), false,
    '栏内水平移动被误判成拖出 —— 重排就再也用不了了');
  assert.ok(el.classList.contains('tab-reorder'), '栏内水平移动应进入重排');
  fire('pointerup', 86, 18);
  assert.deepStrictEqual(sb.opened, [], '栏内重排不该开窗');
});

t('H3 纵向出界仍然要 40px（防手抖一蹭就弹窗）', () => {
  /* 锁的是：把横向的宽松判据套到纵向 —— 标签栏只有 36px 高，
   * 往下蹭 20px 就出界了，不设阈值会极其灵敏。 */
  const sb = makeSandbox();
  const { down, fire, bar } = setup(sb);
  down('a', 66, 18);
  fire('pointermove', 66, 50);           // y=50 已出下边界(36)，但 ady=32 < 40
  const el = bar._tabEls[0];
  assert.strictEqual(el.classList.contains('tab-drag-out'), false,
    '纵向只移 32px 就进入拖出 —— 手抖一下就会弹窗');
  fire('pointerup', 66, 50);
  assert.deepStrictEqual(sb.opened, [], '纵向不足阈值却开窗了');
});

done();
