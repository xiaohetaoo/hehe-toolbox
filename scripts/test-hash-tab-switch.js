'use strict';
/* 「哈希校验」的「文本校验」按钮必须真的切到文本模式。
 *
 * ============ 锁的是哪个回归 ============
 * 2026-11-06 真机点击验证发现：点「文本校验」，按钮自己变成高亮，
 * 但内容区仍然停在「文件校验」——卡片标题、拖拽区都没换。
 *
 * 根因是一行手误：
 *     const tabText = btn(T('文本校验'), '…',
 *       () => switchTab('file' === tab ? 'text' : 'file'));
 * 这个三元表达式的两个分支结果**完全相同**（都是 'file'），等价于
 * switchTab('file')。于是点击只改了按钮 class，页面内容不动。
 *
 * ============ 为什么现有测试全绿 ============
 * test-click-sweep 里 hash-tool 的 btn 是 null —— 它只验证「渲染不抛异常」，
 * 从不点这两个切换按钮。「渲染正常、点了没反应」这类缺陷它天然测不到。
 * 这也是为什么必须有一条断言真的去点按钮、真的看内容区。
 *
 * ============ 验证方式 ============
 * 在 vm 里跑 js/tools/hash.js（真实源码，不抽函数、不复刻逻辑），
 * 用最小的 DOM 桩 + ui/api 桩把界面搭出来，然后**真的点击**两个按钮，
 * 断言两张卡片各自的 display 跟着变。行为断言，不匹配源码文本。
 */
const vm = require('vm');
const { t, done, assert, readSrc } = require('./lib/harness');

/* ---- 最小 DOM 桩：只实现 hash.js 用到的那几个方法和属性 ---- */
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    style: {},
    children: [],
    _listeners: {},
    textContent: '',
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { for (const c of cs) this.children.push(c); },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    removeEventListener() {},
    click() {
      /* 真实点击语义：按注册顺序触发 click 监听 */
      for (const fn of (this._listeners.click || [])) fn({ target: this });
      /* 有些按钮是 btn(label, cls, onClick) 直接挂的回调（见下面 ui 桩） */
      if (typeof this._onActivate === 'function') this._onActivate();
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; },
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    get firstChild() { return this.children[0] || null; }
  };
  return el;
}

function makeUi() {
  const ui = {
    div(cls, ...kids) { const d = makeEl('div'); d.className = cls || ''; d.append(...kids.flat().filter(Boolean)); return d; },
    span(cls, ...kids) { const d = makeEl('span'); d.className = cls || ''; d.append(...kids.flat().filter(Boolean)); return d; },
    h(tag, attrs, ...kids) { const d = makeEl(tag); d.append(...kids.flat().filter(Boolean)); return d; },
    /* btn(label, cls, onClick) —— hash.js 的用法：第三个参数是点击回调 */
    btn(label, cls, onClick) {
      const b = makeEl('button');
      b.className = cls || '';
      b.textContent = typeof label === 'string' ? label : '';
      b._onActivate = typeof onClick === 'function' ? onClick : null;
      return b;
    },
    toast() {},
    copyText() {},
    /* hash.js 里用 ui.debounce 包输入回填；桩只需要"立刻调用"语义 */
    debounce(fn) { return fn; },
    fmtBytes(n) { return String(n) + ' B'; },
    renderTable() { return makeEl('div'); },
    /* filePicker 会在 render 期间被调用；返回最小可用结构 */
    filePicker() {
      const el = makeEl('div');
      el.el = el;
      el.list = { rowAt() { return makeEl('div'); }, refresh() {} };
      el.files = [];
      el.onChange = null;
      el.dropzone = makeEl('div');
      return el;
    },
    placeholder() { return makeEl('div'); }
  };
  return ui;
}

/* js/tools/hash.js 是 IIFE：从 window.Registry 取 register、从 window.Channels 取通道名，
 * 用户文案走**裸标识符** TT(...)（不是 window.TT），所以 TT 必须挂在沙箱全局上。 */
const src = readSrc('js/tools/hash.js');

let captured = null;
const sandbox = {
  window: {
    Registry: { register(def) { captured = def; } },
    Channels: {},
    ui: makeUi(),
    api: {
      on() { return () => {}; },
      invoke() { return Promise.resolve({}); },
      send() {}
    },
    i18n: { t: (s) => s }
  },
  /* 裸标识符 TT —— hash.js 里直接 TT('hash', zh, vars)，从 window 上取会 ReferenceError */
  TT: (ns, zh) => zh,
  /* 裸标识符 h —— js/tools/hash.js 里有 7 处直接调用 h(tag, attrs, ...)，
   * 它来自 js/ui.js 的全局辅助函数，不在 window.ui 上。 */
  h(tag, attrs, ...kids) {
    const d = makeEl(tag);
    if (attrs && typeof attrs === 'object') {
      if (attrs.class) d.className = attrs.class;
      if (attrs.style) Object.assign(d.style, attrs.style);
    }
    d.append(...kids.flat().filter(Boolean));
    return d;
  },
  document: {
    createElement: (tag) => makeEl(tag),
    createTextNode: (s) => ({ nodeType: 3, textContent: s }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}
  },
  console,
  setTimeout,
  clearTimeout,
  Promise
};
sandbox.window.document = sandbox.document;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(src, sandbox, { filename: 'js/tools/hash.js' });
} catch (e) {
  /* 顶层代码若依赖更多环境，把原因留在下面第一条断言里，不要静默 */
  sandbox.__loadError = e;
}

t('HS1 注册块能被求值拿到（测试自身前提）', () => {
  assert.ok(captured, 'js/tools/hash.js 没有调用 window.register —— 测试前提不成立');
  assert.strictEqual(captured.id, 'hash-tool', '注册到的不是哈希校验工具');
  assert.strictEqual(typeof captured.render, 'function', '没有 render');
});

t('HS2 点「文本校验」后内容区真的切到文本模式（真机缺陷：只变色不换页）', () => {
  assert.ok(captured, '拿不到注册块');
  const page = makeEl('div');
  captured.render(page);

  /* 从渲染结果里找出两个模式按钮。hash.js 用 btn(标签, class, cb) 生成，
   * 所以按 textContent 找最可靠（标签会被 i18n 包一层，这里桩返回原文）。 */
  const all = [];
  const walk = (n) => { all.push(n); for (const c of n.children || []) walk(c); };
  walk(page);
  const fileBtn = all.find(n => n.textContent === '文件校验' && typeof n._onActivate === 'function');
  const textBtn = all.find(n => n.textContent === '文本校验' && typeof n._onActivate === 'function');
  /* 锁的是：按钮没被渲染出来则后续断言无意义，先钉住前提。 */
  assert.ok(fileBtn, '找不到「文件校验」按钮');
  assert.ok(textBtn, '找不到「文本校验」按钮');

  /* 两张卡片：按 card-title 文本定位，拿它们的 display 判断显隐。
   * 注意 div(cls, ...kids) 的 kids 里**可能直接是字符串**（div('card-title', '文件校验')），
   * 所以取标题文本必须把字符串子节点也算进去，不能只看 .textContent。 */
  const textOf = (n) => {
    if (n === null || n === undefined) return '';
    if (typeof n === 'string') return n;
    let s = String(n.textContent || '');
    for (const c of n.children || []) s += textOf(c);
    return s;
  };
  const titleOf = (card) => textOf((card.children || [])[0]);
  const cards = all.filter(n => n.className === 'card');
  const fileCard = cards.find(c => titleOf(c) === '文件校验');
  const textCard = cards.find(c => titleOf(c) === '文本校验');
  /* 锁的是：卡片结构变了这里会失去意义，必须显式失败而不是默默跳过。 */
  assert.ok(fileCard, '找不到标题为「文件校验」的卡片');
  assert.ok(textCard, '找不到标题为「文本校验」的卡片');

  /* 初始：文件卡片可见，文本卡片隐藏 */
  /* 锁的是：初始状态本来就对，缺陷只在点击之后 —— 先确认基线。 */
  assert.notStrictEqual(fileCard.style.display, 'none', '初始状态文件卡片就被隐藏了');
  assert.strictEqual(textCard.style.display, 'none', '初始状态文本卡片竟然可见');

  /* 真实点击 */
  textBtn.click();

  /* 锁的是：点「文本校验」后页面必须换 —— 这就是真机上失败的那一步。 */
  assert.strictEqual(fileCard.style.display, 'none',
    '点了「文本校验」，文件卡片却还显示着（真机缺陷复现：只改按钮高亮、不换内容）');
  assert.strictEqual(textCard.style.display, '',
    '点了「文本校验」，文本卡片没有显示出来');

  /* 再点回文件模式，确认是双向的而不是一次性的 */
  fileBtn.click();
  /* 锁的是：只修了单向切换 —— 回不去同样算坏。 */
  assert.strictEqual(fileCard.style.display, '',
    '从文本模式点回「文件校验」，文件卡片没有恢复显示');
  assert.strictEqual(textCard.style.display, 'none',
    '从文本模式点回「文件校验」，文本卡片没有隐藏');
});

done();
