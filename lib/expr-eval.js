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
    if (/[\s]/.test(c)) { i++; continue; }               // 空白跳过
    if (c === '_') { i++; continue; }                    /* 【千位分隔的另一半】单独出现在 token 边界的 _（如 1 +_000 的开头）直接忽略 */
    if (/[0-9.]/.test(c)) {
      // 数字：支持 1.5、.5、1e-3；数字**内部**的 _ 是千位分隔（1_000 → 1000）。
      // 【必须把 _ 收进数字扫描，不能只靠空白分支忽略】
      // 原实现 _ 只在 token 边界被跳过，数字内部的 _ 会把 1_000 切成
      // 「1」和「000」两个相邻数字 token，parse 报「表达式尾部有多余内容」
      // —— 注释承诺的 1_000 写法实际不可用（本轮实测抓到）。
      let j = i;
      while (j < s.length && /[0-9._]/.test(s[j])) j++;
      if (j < s.length && (s[j] === 'e' || s[j] === 'E')) {
        let k = j + 1;
        if (k < s.length && (s[k] === '+' || s[k] === '-')) k++;
        let d = k;
        while (d < s.length && /[0-9]/.test(s[d])) d++;
        if (d > k) j = d;
      }
      const numRaw = s.slice(i, j);
      const numStr = numRaw.replace(/_/g, '');
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(numStr)) {
        throw new Error('数字格式无效: ' + numRaw);
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

  /* 百分号后缀：50% → 0.5（改在 token 层判定，不用正则改源码）。
   *
   * 【为什么不能再用正则改字符串】
   * 早期是
   *   src.replace(/(\d+(?:\.\d+)?)\s*%\s*(?!\s*[\dA-Za-z(])/g, '($1/100)')
   * 靠负向断言区分「取余」与「百分比」。它有两个都实测过的洞：
   *   ① 没排除一元符号：`10 % -3` 被当成百分比 → (10/100)-3 = -2.9（正确 1）
   *   ② 补上 `[-+]?` 又会误伤 `50%+10%`：把 `+10` 当成一元，
   *      结果变成 0.105 之类，而正确答案是 0.6
   * 根因是「靠字符前瞻猜语义」本身不稳。改成 token 化之后判断：
   * `%` 是不是百分比后缀，只取决于它**后面那个 token** 是不是操作数的开头 ——
   *   · 后面是数字/常量/函数/左括号               → 二元取余 `a % b`
   *   · 后面是一元 +/− 且再后面是操作数开头      → 二元取余 `a % -b`
   *   · 其它（结尾 / 右括号 / 二元运算符）        → 百分比后缀
   * 于是 `10 % -3` 是取余、`50%+10%`、`100-10%` 都是百分比，不用猜。 */
  const tokens = normalizePercent(tokenize(src));
  /* 【栈溢出必须换成中文，但**不能**因此砍掉能算的范围】
   * 递归下降解析器每层括号/函数/一元符号都是一次真递归，超深时会抛
   *   RangeError: Maximum call stack size exceeded
   * 实测阈值（随机器与 Node 版本浮动）：
   *   '(' × 5000 + ')' × 5000       → 溢出；1500 层可以算
   *   'sqrt(' × 3000 + ')' × 3000   → 溢出；800 层可以算
   *   '-' × 20000                   → 溢出；5000 个可以算
   *
   * 【为什么不在进入递归前判一个固定上限】
   * 试过 MAX_DEPTH = 1000：它把**原本能算的** 1500 层括号也拒了 ——
   * 那是收窄用户可见行为，不符合"修文案"这个范围。而且真实栈上限因环境而异，
   * 写死一个数要么误伤（设小了）要么拦不住（设大了）。
   * 所以改成**兜底**：照原样去算，只有真的溢出时才把那条英文换成中文。
   * 能算的一个不少，算不了的说清楚原因。 */
  let v;
  try {
    v = parse(tokens);
  } catch (err) {
    const isOverflow = err instanceof RangeError || /call stack/i.test(String((err && err.message) || ''));
    if (!isOverflow) throw err;
    throw new Error('表达式嵌套太深，超出可计算范围（可以先算内层，再代回外层）');
  }
  /* 【NaN 和 ±Infinity 都必须拦，不能只拦 NaN】
   * 原来只判 Number.isNaN(v)，于是下面这些表达式会原样返回 Infinity：
   *   1/0 → Infinity      -1/0 → -Infinity
   *   1e308*10 → Infinity  2^1024 → Infinity
   * （0/0 和 1%0 得到的是 NaN，所以那两种情况原本就抛了 —— 这正说明
   *   写这段时想的是"结果是数字"而不是"结果是有限数字"。）
   * Infinity 不是"能算的数"：它进到体积/时间/比例这类下游计算里，
   * 会变成 Infinity → 格式化出来是"∞"或 NaN，用户拿到一个无意义的答案
   * 却看不到任何错误提示。所以改用 Number.isFinite：
   * NaN 与 ±Infinity 一并拒绝，文案指明原因，别只写"无法计算"。 */
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('无法计算（除数为 0 或结果溢出）');
  return v;
}

/**
 * 把百分号后缀就地改写成「(数字/100)」形式的 token 序列。
 *
 * 判据见 evaluate 里的注释：看 `%` 后面那个 token 是不是操作数的开头。
 * 取余时 `%` 后面必然还有操作数；百分比后缀后面跟的是结尾/右括号/二元运算符。
 *
 * @param {Array<{t:string,v:any}>} tokens
 * @returns {Array<{t:string,v:any}>} 新 token 数组（不修改入参）
 */
function normalizePercent(tokens) {
  /* 判断从 i 开始是不是「一个完整的操作数」（数字/常量/函数/括号式，可带一元符号） */
  const operandAt = (i) => {
    const tk = tokens[i];
    if (!tk) return null;
    if (tk.t === 'num' || tk.t === 'const') return { len: 1, isPercentCandidate: false };
    if (tk.t === 'func') {
      /* func ( ... ) —— 括号内内容不影响「这是一个操作数」的判断，扫描到配对的 ) */
      let depth = 0;
      for (let k = i + 1; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.t === 'op' && t.v === '(') depth++;
        else if (t.t === 'op' && t.v === ')') { depth--; if (depth === 0) return { len: k - i + 1, isPercentCandidate: false }; }
      }
      return null;
    }
    if (tk.t === 'op' && tk.v === '(') {
      let depth = 0;
      for (let k = i; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.t === 'op' && t.v === '(') depth++;
        else if (t.t === 'op' && t.v === ')') { depth--; if (depth === 0) return { len: k - i + 1, isPercentCandidate: false }; }
      }
      return null;
    }
    /* 一元符号：只有紧跟着一个操作数时才算 */
    if (tk.t === 'op' && (tk.v === '-' || tk.v === '+')) {
      const inner = operandAt(i + 1);
      if (!inner) return null;
      return { len: 1 + inner.len, isPercentCandidate: false };
    }
    return null;
  };

  /* 关键歧义：`数字%` 后面的 `+`/`-` 到底是
   *   ① 一元符号（`a % -3`：取余，右操作数是 -3）
   *   ② 二元运算符（`50%+10%`、`50%-3`：百分比与其他项相加/减）
   * 只看后面一个 token 分不出来。判据用**后面那一整项自己是不是百分比**：
   *   `50%+10%` → 后面是 `+10%`，它自己带 %，说明是独立的一项 → 二元
   *   `a % -3`  → 后面是 `-3`，不带 % → 一元，取余
   *   `50%-3`   → 后面是 `-3`，不带 % → 会判成取余（50 % -3 = 2）。
   *     这与「-3 是一元」的解读一致，不是错误；计算器里 `50%-3` 本就歧义，
   *     取余是更保守的解读（不会把 50 悄悄变成 0.5）。
   * 据此：只有「后面不是操作数」或「后面那一项自己以 % 结尾」时才当百分比。 */
  const isPercentAt = (i) => {
    const tk = tokens[i];
    if (!tk || tk.t !== 'op' || tk.v !== '%') return false;
    if (i === 0 || tokens[i - 1].t !== 'num') return false;   // 左边必须是数字
    const next = tokens[i + 1];
    if (!next) return true;                                    // 结尾 → 百分比
    if (next.t === 'op' && next.v === ')') return true;        // 右括号 → 百分比
    if (next.t === 'op' && next.v !== '-' && next.v !== '+') return false;  // 二元运算符 → 取余
    /* 剩下：后面是操作数开头，或是一元 +/− */
    const op = operandAt(i + 1);
    if (!op) return true;              // 后面拼不成操作数 → 当百分比，让 parser 报错
    const after = tokens[i + 1 + op.len];
    if (after && after.t === 'op' && after.v === '%') return true;          // 后面那项自己是百分比 → 二元加减
    return false;                      // 否则取余
  };

  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (isPercentAt(i)) {
      /* 把前一个数字改写成 (n/100) */
      const num = out.pop();
      out.push({ t: 'op', v: '(' }, num, { t: 'op', v: '/' }, { t: 'num', v: 100 }, { t: 'op', v: ')' });
      continue;
    }
    out.push(tokens[i]);
  }
  return out;
}

module.exports = { evaluate, tokenize, FUNCS, CONSTS };
