'use strict';
/* CSV 表格 → 对象数组（「CSV / JSON 互转」工具的 CSV→JSON 半边）。
 *
 * ============ 为什么单独抽成文件 ============
 * 这段逻辑原来内联在 js/tools/text-tools.js 的 fire() 里：
 *   const o = {};
 *   header.forEach((hd, i) => o[hd.trim() || `列${i+1}`] = r[i] ?? '');
 * 它有一个静默丢数据的缺陷（见下），而修它需要**验证真实行为** ——
 * 内联在渲染层里，测试只能匹配源码形态，匹配到的还是缺陷本身
 * （这个坑项目里已经踩过一次：fail-text 的断言锁住的恰好是 bug）。
 * 抽出来之后主代码与测试共用一份，断言落在返回值上。
 *
 * ============ 锁的是哪个回归 ============
 * 表头里出现 `__proto__` 时，上面的 `o[key] = value` 不是"加一个属性"，
 * 而是走 Object.prototype 上 `__proto__` 的 **setter** —— 改的是原型，
 * 这一列整个消失（实测 `__proto__ , name` + `Alice,1` → {"name":"1"}）。
 * 而且它**静默**发生 —— 用户只会觉得"工具吃了一列数据"。
 *
 * 【只有 __proto__ 这一个键会丢数据，别把话说大】
 * 实测对照：`o.constructor = 'a'` / `o.toString = 'b'` / `o.hasOwnProperty = 'c'`
 * 都会**正常建出自有的可枚举属性**（只是遮住继承来的那个），数据不丢。
 * 所以修的是「原型 setter 这一条路」，不是"所有原型键都危险"。
 * 用 defineProperty 统一处理，是为了不必维护一张"哪些键特殊"的名单 ——
 * 那种名单永远会漏（今天想到 __proto__，明天漏掉某个新 setter）。
 *
 * ============ 为什么用 defineProperty，不用 Object.create(null) ============
 * 两种都能保住列，但后者把输出对象的原型换成 null：
 *   · 下游任何 `o.hasOwnProperty(...)` / `o instanceof Object` 都会变
 *     （JSON.stringify 看不出差别，所以测试很难发现）；
 *   · 它改的是"对象是什么"，超出「别丢列」这个修复范围。
 * defineProperty 只改赋值方式：原型仍是 Object.prototype，
 * 普通表头的输出与原来逐字相同（含键顺序）。
 *
 * 加载方式：index.html 里 <script src="lib/csv-table.js">（须在 js/tools/ 之前），
 * 挂到 window.CsvTable；node 侧 require 拿到同一个对象。
 */
(function (root, factory) {
  const api = factory();
  /* 【两条独立 if，不用 else】与 lib/exif.js / lib/pinyin.js / lib/fail-text.js 一致：
   * 同时有 module 与 root 时两边都挂，消除"某个库在 node 下拿不到全局"的分叉。 */
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    /** @type {Record<string, unknown>} */ (root).CsvTable = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
   * 把表头行归一成「互不重复」的键名列表。
   *
   * ============ 锁的是哪个回归 ============
   * 表头重名（`name,name`）时，两个键都是 `name`，`defineProperty` 第二次
   * 直接重定义了同名属性 —— 第一列的值被覆盖，那一列**静默消失**：
   *   rowsToObjects([['name','name'],['Alice','Bob']])
   *   → [{"name":"Bob"}]        ← "Alice" 没了，且不报错
   * 原实现 `o[k] = v` 有同样行为，所以这不是新引入的，是一直在丢数据。
   *
   * ============ 为什么用「name(2)」而不是「name2」 ============
   * 与本项目其它撞名处理保持一致（`docs(1)`、`.merged(2)`、
   * `uniqEntryDir` 的 `base(i)`）：用户已经有「括号编号」这个心智模型。
   * 用 `name2` 还会与用户自己写的 `name2` 表头撞上，需要再判一次。
   *
   * 【只在真的重名时才改名】原样表头（含空表头补「列N」）的输出必须
   * 与改动前逐字相同 —— 那是用户可见的既有行为，不能借这次修复顺手改掉。
   *
   * @param {Array<string>} header
   * @returns {{keys: string[], renamed: Array<{from:string, to:string}>}}
   */
  function headerKeys(header) {
    const list = Array.isArray(header) ? header : [];
    const used = new Set();
    const keys = [];
    const renamed = [];
    for (let i = 0; i < list.length; i++) {
      const hd = list[i];
      const raw = hd == null ? '' : String(hd).trim();
      /* 键名规则保持原样：留空补「列N」，与原实现一致。 */
      const base = raw || ('列' + (i + 1));
      let k = base;
      if (used.has(k)) {
        /* 逐个试 (2)(3)… 直到不撞车。上限只为防死循环，实际不会接近。 */
        for (let n = 2; n < 10000; n++) {
          const cand = base + '(' + n + ')';
          if (!used.has(cand)) { k = cand; break; }
        }
        renamed.push({ from: base, to: k });
      }
      used.add(k);
      keys.push(k);
    }
    return { keys, renamed };
  }

  /**
   * 把「首行表头 + 若干数据行」的二维数组转成对象数组。
   * @param {Array<Array<string>>} rows 第 0 行是表头
   * @returns {Array<Object<string,string>>}
   */
  function rowsToObjects(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length < 2) return [];          // 只有表头（或空）→ 没有数据行
    const keys = headerKeys(list[0]).keys;

    return list.slice(1).map((r) => {
      const row = Array.isArray(r) ? r : [];
      /* 【类型标注是给 tsc 看的】`const o = {}` 会被推断成 `{}`，
       * 与声明的返回类型 `Object<string,string>` 不兼容（TS2322）。
       * 运行时毫无区别 —— defineProperty 建出来的确实是普通对象。 */
      /** @type {Record<string, string>} */
      const o = {};
      keys.forEach((k, i) => {
        const v = row[i] == null ? '' : row[i];
        /* 【必须 defineProperty】`o[k] = v` 在 k 是 __proto__ 时改的是原型
         * （静默丢列），在 k 是 constructor/toString 时会遮住继承成员。
         * defineProperty 建的是可枚举的自有属性，语义上正是「加一列」。 */
        Object.defineProperty(o, k, {
          value: v,
          enumerable: true,     // JSON.stringify 要看得见
          writable: true,       // 下游可能要改
          configurable: true,   // 下游可能要删
        });
      });
      return o;
    });
  }

  /**
   * 转换并同时报告「有哪些表头被改名了」。
   *
   * 【为什么需要单独一个入口】工具页要在界面上提示「检测到 N 个重复表头，
   * 已自动改名」。只是静默改名的坏处和静默丢列一样：用户拿到的表头
   * 和他粘贴的不一样，却不知道为什么。调用方拿 renamed 去提示。
   *
   * @param {Array<Array<string>>} rows
   * @returns {{rows: Array<Object<string,string>>, renamed: Array<{from:string, to:string}>}}
   */
  function rowsToObjectsDetailed(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length < 2) return { rows: [], renamed: [] };
    const { keys, renamed } = headerKeys(list[0]);
    const out = list.slice(1).map((r) => {
      const row = Array.isArray(r) ? r : [];
      /** @type {Record<string, string>} */
      const o = {};
      keys.forEach((k, i) => {
        const v = row[i] == null ? '' : row[i];
        Object.defineProperty(o, k, {
          value: v,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      });
      return o;
    });
    return { rows: out, renamed };
  }

  return { rowsToObjects, rowsToObjectsDetailed };
});
