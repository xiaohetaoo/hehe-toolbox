'use strict';
/* 窗口布局：布局计算的几何正确性（纯函数，可完整行为断言）。
 *
 * ============ 锁的是哪次事故 ============
 * 这是新工具，锁的是"算出来的矩形不对"这一类问题 —— 它们不会报错，
 * 只会让窗口摆出奇怪的形状或跑到屏幕外：
 *   · 格子之间没有缝（两窗口严丝合缝贴着，看着像一整个）；
 *   · 格子超出屏幕右边/下边（最后一个窗口有一半在屏幕外）；
 *   · 四宫格的行列顺序错（左下跑到右上）；
 *   · 层叠布局所有窗口完全重叠（只看到最后一个，等于没摆）。
 *
 * 【为什么能用行为断言】computeLayout 是纯函数（输入 area + count →
 * 输出矩形数组），不依赖 Electron 与 DOM。真正的 SetWindowPos 是
 * 另一层，由真机走查覆盖（那边只验证"调通了"，几何正确性在这里锁）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { t, done, ROOT } = require('./lib/harness');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* 在沙箱里跑 win-layout.js，取出 computeLayout。
 * 需要最小 window 壳（它顶层挂了 window.LayoutCalc 并注册工具）。 */
function loadLayout() {
  const src = read('js/tools/win-layout.js');
  const sandbox = {
    window: {
      LayoutCalc: null,
      Registry: { register() {} },
      ui: { div() {}, btn() {}, toast() {}, h() {}, icon() {} },
      Channels: { CHANNELS: {} },
      api: { invoke() {} },
    },
    console,
  };
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { timeout: 5000 });
  const inner = sandbox.window.LayoutCalc;
  /* 包一层复制成本地对象数组：vm 沙箱的数组/对象原型来自另一个 realm，
   * assert.deepStrictEqual 会因原型不同报"结构相同但不相等"。 */
  return {
    layouts: Object.keys(inner.LAYOUTS),
    compute: (kind, area, count, gap) => inner.computeLayout(kind, area, count, gap)
      .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
    cs: inner.LAYOUT_CS,
    /* 原样透出（返回字符串，不涉及跨 realm 比较） */
    previewSvg: (kind, w, h, n) => inner.layoutPreviewSvg(kind, w, h, n),
    rawCompute: inner.computeLayout,
  };
}

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };

t('WL1 左右分屏：两格各半、互不重叠、都在屏内', () => {
  const L = loadLayout();
  const rs = L.compute('v-split', AREA, 2, 8);
  assert.strictEqual(rs.length, 2);
  /* 锁的是：第一格从左边起、第二格接在它右边 */
  assert.strictEqual(rs[0].x, 0);
  assert.ok(rs[1].x > rs[0].x, '第二格应在右边');
  /* 锁的是：两格之间有缝（gap=8 → 左右各收 4） */
  assert.ok(rs[1].x >= AREA.width / 2 - 1, '第二格左缘应在中线附近');
  /* 锁的是：右缘不超出屏幕 */
  const right = rs[1].x + rs[1].width;
  assert.ok(right <= AREA.width, '右缘 ' + right + ' 不应超出 ' + AREA.width);
  /* 锁的是：两格不重叠 */
  assert.ok(rs[0].x + rs[0].width <= rs[1].x, '两格不应重叠');
});

t('WL2 上下分屏：上下各半、不超出底边', () => {
  const L = loadLayout();
  const rs = L.compute('h-split', AREA, 2, 8);
  assert.strictEqual(rs.length, 2);
  assert.strictEqual(rs[0].y, 0);
  assert.ok(rs[1].y > rs[0].y, '第二格应在下方');
  const bottom = rs[1].y + rs[1].height;
  assert.ok(bottom <= AREA.height, '底缘 ' + bottom + ' 不应超出 ' + AREA.height);
});

t('WL3 四宫格：四个格子位置正确且互不重叠', () => {
  const L = loadLayout();
  const rs = L.compute('grid-4', AREA, 4, 8);
  assert.strictEqual(rs.length, 4);
  /* 锁的是：顺序是「左上、右上、左下、右下」—— 用户勾选顺序即排列顺序，
   * 顺序错了会让人以为勾反了。 */
  const [tl, tr, bl, br] = rs;
  assert.ok(tl.x < tr.x && tl.y === tr.y, '第 1、2 格应在同一行、第 1 个在左');
  assert.ok(bl.x < br.x && bl.y === br.y, '第 3、4 格应在同一行、第 3 个在左');
  assert.ok(tl.y < bl.y, '第 3 行应在第 1 行下方');
  /* 锁的是：不超出屏幕 */
  for (const r of rs) {
    assert.ok(r.x + r.width <= AREA.width + 1, '右缘超出：' + JSON.stringify(r));
    assert.ok(r.y + r.height <= AREA.height + 1, '底缘超出：' + JSON.stringify(r));
  }
  /* 锁的是：两两不重叠 */
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(!(overlapX > 2 && overlapY > 2), '第 ' + i + ' 与 ' + j + ' 格重叠');
    }
  }
});

t('WL4 层叠：窗口依次错开且都露出来', () => {
  const L = loadLayout();
  const rs = L.compute('stack', AREA, 3, 8);
  assert.strictEqual(rs.length, 3);
  /* 锁的是：层叠不能完全重合（那样只看得到最后一个，等于没摆）。
   * 每一层的 x/y 都要比上一层大。 */
  assert.ok(rs[1].x > rs[0].x && rs[1].y > rs[0].y, '第二层应错开');
  assert.ok(rs[2].x > rs[1].x && rs[2].y > rs[1].y, '第三层应错开');
  /* 锁的是：错开之后仍在屏内 */
  const last = rs[2];
  assert.ok(last.x + last.width <= AREA.width, '最后一层右缘超出');
});

t('WL5 主窗左、其余右列：左半整高、右侧平分', () => {
  const L = loadLayout();
  const rs = L.compute('main-left', AREA, 3, 8);
  assert.strictEqual(rs.length, 3);
  /* 锁的是：第一个窗口占满左半的高度 */
  assert.strictEqual(rs[0].height, AREA.height, '主窗应占满高度');
  /* 锁的是：右侧两个窗口加起来大致等于整高（允许 gap 损耗） */
  const sum = rs[1].height + rs[2].height;
  assert.ok(Math.abs(sum + 8 - AREA.height) <= 4,
    '右侧两格高度之和应接近 ' + (AREA.height - 8) + '，实际 ' + sum);
  /* 锁的是：最后一个吃掉余数（否则底部会留 1-2px 缝隙） */
  const lastBottom = rs[2].y + rs[2].height;
  assert.ok(lastBottom <= AREA.height && lastBottom >= AREA.height - 4,
    '最后一格底缘应贴住屏幕底：' + lastBottom);
});

t('WL6 单窗口时铺满，且窗口数被夹到 1-8', () => {
  const L = loadLayout();
  const one = L.compute('v-split', AREA, 1, 8);
  assert.strictEqual(one.length, 1);
  /* 锁的是：窗口数超范围时的夹取。传 0 会算出空数组（界面卡住），
   * 传 99 会生成 99 个重叠矩形（浪费几十次 IPC）。 */
  assert.ok(L.compute('v-split', AREA, 0, 8).length >= 1, '0 个窗口应夹到 1');
  assert.ok(L.compute('v-split', AREA, 99, 8).length <= 8, '99 个窗口应夹到 8');
});

t('WL7 未知布局名回退到左右分屏而非崩溃', () => {
  const L = loadLayout();
  /* 锁的是：布局 id 拼错时的行为。直接抛错会让整个工具不可用；
   * 静默返回空数组会让"排列"什么都没做。回退到默认布局是第三条路。 */
  const rs = L.compute('不存在的布局', AREA, 2, 8);
  assert.strictEqual(rs.length, 2, '应回退到分屏并给出 2 个矩形');
});

t('WL8 六种布局都在清单里', () => {
  const L = loadLayout();
  /* 锁的是：布局清单被改少（用户可选的样子变少）。 */
  for (const k of ['v-split', 'h-split', 'grid-4', 'grid-3', 'main-left', 'stack']) {
    assert.ok(L.layouts.includes(k), '缺少布局 ' + k);
  }
});

t('WL9 Place 的 Win32 实现要点齐全', () => {
  const L = loadLayout();
  const cs = L.cs;
  /* 锁的是：SW_RESTORE(9)。最大化/最小化的窗口直接 SetWindowPos
   * 不会按预期移动 —— 这是 Win32 的既定行为，漏了它"排列已最大化的
   * 窗口"会静默无效。 */
  assert.ok(/ShowWindow\(p,\s*9\)/.test(cs), '应先 SW_RESTORE');
  /* 锁的是：SWP_NOACTIVATE(0x10)，否则一次摆四个窗口时焦点乱跳。 */
  assert.ok(/0x4\s*\|\s*0x10/.test(cs), '应用 NOZORDER | NOACTIVATE');
});

t('WL12 布局示意图由真实几何生成（图与行为不分叉）', () => {
  const L = loadLayout();
  const W = 100, H = 80;
  /* 锁的是：示意图另画一套静态图形。改成「图由 computeLayout 生成」后，
   * 算法一改图就跟着变；画死的话会出现"图上这么摆、实际那么摆"。
   * 这里逐个布局比 SVG 里每个 rect 的 (x,y) 与计算结果的 (x,y)。 */
  for (const kind of ['v-split', 'h-split', 'grid-4', 'grid-3', 'main-left', 'stack']) {
    const svg = L.previewSvg(kind, W, H);
    /* 【逐个 rect 单独取，不用跨 rect 的正则】写成
     * /<rect[^>]*x="(\d+)"[^>]*y="(\d+)"/g 时，[^>]* 在第一个 rect 里
     * 找不到 y 就会继续往后跨过 ">" 吃掉第二个 rect 的 y —— 结果只匹配到
     * 一个坑位、位置还是错的。先按 <rect 切开，再在每段内取 x/y。 */
    const svgRects = svg.split('<rect').slice(1).map((chunk) => {
      const x = chunk.match(/x="(-?\d+)"/);
      const y = chunk.match(/y="(-?\d+)"/);
      return [x ? Number(x[1]) : NaN, y ? Number(y[1]) : NaN];
    });
    /* 【count 必须与 layoutPreviewSvg 内部算法一致】
     * 它内部是 `n || (def.slots ? def.slots.length : 3)` ——
     * 有 slots 的用槽位数，没有的（层叠/主窗右列）用 3。
     * 这里若直接传 undefined，computeLayout 里的 `count | 0` 会变成 0、
     * 再被夹到 1，于是只算出 1 个格子、与 SVG 的 2 个对不上。 */
    const def = L.layoutsById ? null : null;
    const slotsLen = { 'v-split': 2, 'h-split': 2, 'grid-4': 4, 'grid-3': 3 }[kind];
    const count = slotsLen || 3;
    /* 【calc 必须转成本地数组】rawCompute 在 vm 沙箱里执行，
     * 返回的数组原型来自另一个 realm —— 即便内容相同，
     * deepStrictEqual 也会判不等（它比原型）。而 `.map()` 是在**沙箱数组**
     * 上调的，结果仍属于沙箱 realm，必须先 Array.from 落到本地再取字段。 */
    const raw = L.rawCompute(kind, { x: 0, y: 0, width: W, height: H }, count, 2);
    const calc = Array.from(raw, (r) => [r.x, r.y]);
    assert.deepStrictEqual(svgRects, calc,
      kind + ' 的示意图几何应与 computeLayout 一致');
    assert.ok(svgRects.length > 0, kind + ' 应至少画出一个格子');
  }
});

t('WL10 三张登记表都有 win-layout', () => {
  const reg = read('js/registry.js');
  const names = read('lib/tool-names.js');
  const feat = JSON.parse(read('scripts/features.json'));
  /* 锁的是：加工具时漏登记（ORDER 漏了不进网格、tool-names 漏了标题退化）。 */
  assert.ok(/'win-layout'/.test(reg), 'ORDER 表应有 win-layout');
  assert.ok(/'win-layout'/.test(names), 'tool-names 应有 win-layout');
  assert.ok(feat.sys.src.includes('js/tools/win-layout.js'), 'features.sys.src 应含它');
});

t('WL11 工具声明的图标名都在图标库里', () => {
  /* 锁的是：iconSvg 对未知名**静默回退成 info**（一个 i），
   * 不报任何错。本轮就踩了：用了不存在的 'layout'，
   * 结果工具头与卡片标题都显示成大写的 i，与"窗口布局"毫无关系。
   *
   * 这类错误只能靠看截图发现 —— 所以做成断言：
   * 把工具源里所有 icon('xxx') 与 icon: 'xxx' 的名字抽出来，
   * 逐一确认 icons.js 里有定义。 */
  const src = read('js/tools/win-layout.js');
  const iconsSrc = read('js/icons.js');

  /* 收集图标库里的名字 */
  const defined = new Set();
  for (const m of iconsSrc.matchAll(/^\s{4}'?([\w-]+)'?:\s*'</gm)) defined.add(m[1]);
  assert.ok(defined.size > 50, '图标库应能解析出名字，实际 ' + defined.size);

  /* 收集工具里用到的名字 */
  const used = new Set();
  for (const m of src.matchAll(/icon\(\s*'([\w-]+)'/g)) used.add(m[1]);
  for (const m of src.matchAll(/icon:\s*'([\w-]+)'/g)) used.add(m[1]);
  assert.ok(used.size > 0, '应能从工具源里抽到图标名');

  const missing = [...used].filter((x) => !defined.has(x));
  assert.deepStrictEqual(missing, [],
    '这些图标名不在图标库里（会静默回退成 i 图标）：' + missing.join(', '));
});

done();
