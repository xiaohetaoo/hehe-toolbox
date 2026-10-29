'use strict';
/* 安全的数学表达式求值器（不依赖 eval / Function）。
 *
 * 【为什么要自己写】原来的科学计算器用
 *   Function('"use strict"; return (' + e + ')')()
 * 求值，为此整站 CSP 必须开 `script-src 'unsafe-eval'` ——
 * 这削弱了所有渲染路径（Markdown 预览、笔记、翻译结果）的 XSS 防线。
 * 原实现靠「字符白名单 + 单词黑名单」防护，属于难以长期维持的方案：
 * 白名单是字符集级别（只要由 M a t h e p o w i n ... 这些字母组成就放行），
 * 而 `Math.constructor` 这类链条全都在这些字母里。
 *
 * 本实现是递归下降解析器：**只认数字、运算符、括号、函数名、常量名**，
 * 遇到任何其它标识符直接报错。不存在代码执行的可能。
 *
 * 支持：
 *   数字（含小数、科学计数法 1e-3）、+ - * / %（取余）、^ 或 ** 幂、
 *   一元正负、括号、函数（sin cos tan asin acos atan log10 ln sqrt abs
 *   ceil floor round exp）、常量 pi e、百分号后缀（50% → 0.5）
 */

/* 用 null 原型对象，避免 `'constructor' in FUNCS` 恒为 true 这类原型链陷阱。
 * （普通对象上 'constructor' / 'toString' / '__proto__' 都能查到，
 *   会把它们误当成合法函数名，这是本次自测抓到的真实问题。） */
const FUNCS = Object.assign(Object.create(null), {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  log10: Math.log10, log: Math.log10, ln: Math.log,
  sqrt: Math.sqrt, abs: Math.abs,
  ceil: Math.ceil, floor: Math.floor, round: Math.round,
  exp: Math.exp
});

const CONSTS = Object.assign(Object.create(null), { pi: Math.PI, e: Math.E });

/* 安全查表：只认自有属性 */
const has = (tbl, k) => Object.prototype.hasOwnProperty.call(tbl, k);

/* 词法分析：把输入切成 token */
function tokenize(src) {
  const s = String(src || '')
    .replace(/×/g, '*').replace(/÷/g, '/').replace(/，/g, ',');
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/[\s_]/.test(c)) { i++; continue; }              // _ 允许用户写 1_000 这类分隔（忽略）
    if (/[0-9.]/.test(c)) {
      // 数字：支持 1.5、.5、1e-3
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      if (j < s.length && (s[j] === 'e' || s[j] === 'E')) {
        let k = j + 1;
        if (k < s.length && (s[k] === '+' || s[k] === '-')) k++;
        let d = k;
        while (d < s.length && /[0-9]/.test(s[d])) d++;
        if (d > k) j = d;
      }
      const numStr = s.slice(i, j);
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(numStr)) {
        throw new Error('数字格式无效: ' + numStr);
      }
      tokens.push({ t: 'num', v: parseFloat(numStr) });
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      /* 需按「最长匹配」取标识符：log10 含数字，不能只扫字母，
       * 否则 'log10(' 会被拆成 'log' + '10' + '('，报「log 后需要括号」。 */
      let j = i;
      while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
      const raw = s.slice(i, j);
      const word = raw.toLowerCase();
      if (has(FUNCS, word)) { tokens.push({ t: 'func', v: word }); i = j; continue; }
      if (has(CONSTS, word)) { tokens.push({ t: 'const', v: word }); i = j; continue; }
      throw new Error('不支持的函数或常量: ' + s.slice(i, j));
    }
    if ('+-*/%^()'.includes(c)) { tokens.push({ t: 'op', v: c }); i++; continue; }
    throw new Error('不支持的字符: ' + c);
  }
  return tokens;
}

/* 递归下降解析 + 即时求值
 * 优先级：括号/函数 > 一元正负 > ^(右结合) > * / % > + -
 */
function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function primary() {
    const tk = peek();
    if (!tk) throw new Error('表达式不完整');
    if (tk.t === 'num') { next(); return tk.v; }
    if (tk.t === 'const') { next(); return CONSTS[tk.v]; }
    if (tk.t === 'func') {
      const name = next().v;
      if (!peek() || peek().v !== '(') throw new Error('函数 ' + name + ' 后需要括号');
      next(); // 吃掉 (
      const arg = addSub();
      if (!peek() || peek().v !== ')') throw new Error('括号不匹配');
      next(); // 吃掉 )
      return FUNCS[name](arg);
    }
    if (tk.t === 'op' && tk.v === '(') {
      next();
      const v = addSub();
      if (!peek() || peek().v !== ')') throw new Error('括号不匹配');
      next();
      return v;
    }
    throw new Error('表达式无效');
  }

  function unary() {
    const tk = peek();
    if (tk && tk.t === 'op' && (tk.v === '-' || tk.v === '+')) {
      next();
      const v = unary();
      return tk.v === '-' ? -v : v;
    }
    return power();
  }

  function power() {
    const base = primary();
    const tk = peek();
    // ^ 或 **（** 被词法拆成两个 *，这里兼容处理）
    if (tk && tk.t === 'op' && tk.v === '^') {
      next();
      const exp = unary(); // 右结合
      return Math.pow(base, exp);
    }
    if (tk && tk.t === 'op' && tk.v === '*') {
      // 检查是否 ** （后面紧接 *）
      const save = pos;
      next();
      if (peek() && peek().t === 'op' && peek().v === '*') {
        next();
        const exp = unary();
        return Math.pow(base, exp);
      }
      pos = save; // 不是 **，回退
    }
    return base;
  }

  function mulDiv() {
    let v = unary();
    while (true) {
      const tk = peek();
      if (!tk || tk.t !== 'op') break;
      if (tk.v === '*') { next(); v = v * unary(); }
      else if (tk.v === '/') { next(); v = v / unary(); }
      else if (tk.v === '%') { next(); v = v % unary(); }
      else break;
    }
    return v;
  }

  function addSub() {
    let v = mulDiv();
    while (true) {
      const tk = peek();
      if (!tk || tk.t !== 'op') break;
      if (tk.v === '+') { next(); v = v + mulDiv(); }
      else if (tk.v === '-') { next(); v = v - mulDiv(); }
      else break;
    }
    return v;
  }

  const val = addSub();
  if (pos < tokens.length) throw new Error('表达式尾部有多余内容');
  return val;
}

/**
 * 求值。失败一律抛 Error（调用方决定怎么展示）。
 * @param {string} expr
 * @returns {number}
 */
function evaluate(expr) {
  const src = String(expr == null ? '' : expr).trim();
  if (!src) throw new Error('表达式为空');

  /* 百分号后缀：50% → 0.5。
   * 关键：不能误伤取余 `a % b`。判定规则：
   *   - `数字%` 后面**紧跟**另一个操作数（数字、字母、左括号）→ 是取余，保持原样
   *   - 其它情况（后面是运算符/右括号/结尾）→ 百分比，(数字/100)
   * 用负向断言实现：% 之后**不**是「空白后跟数字或字母或(」才算百分比。 */
  let prepared = src.replace(
    /(\d+(?:\.\d+)?)\s*%\s*(?!\s*[\dA-Za-z(])/g,
    '($1/100)'
  );

  const tokens = tokenize(prepared);
  const v = parse(tokens);
  if (typeof v !== 'number' || Number.isNaN(v)) throw new Error('无法计算');
  return v;
}

module.exports = { evaluate, tokenize, FUNCS, CONSTS };
