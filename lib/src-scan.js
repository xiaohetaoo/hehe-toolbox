'use strict';
/* 源码文本分析小工具（只给测试与静态检查用，不进打包产物的运行路径）。
 *
 * 【为什么单独成模块】
 * 有三个测试脚本需要「剥掉注释后再断言」：
 *   scripts/test-i18n-coverage.js   —— 找硬编码中文
 *   scripts/test-destructive.js     —— 防 alertBox 对象实参回归
 *   scripts/test-round14-fixes.js   —— 多处结构断言
 * 早期每个脚本各自实现/各自抽取一份，结果是：一个地方修了正则识别，
 * 另一个地方的旧实现还在用朴素扫描，彼此行为不一致 —— 而且抽函数时
 * 连"抽取器本身要不要识别正则"都成了问题（regexAllowed 内部就有正则字面量，
 * 朴素配平会当场失步）。集中到一处后只有一份行为，谁 import 谁一致。
 *
 * 【必须识别正则字面量 —— 这是真实的坑】
 * js/tools/net-tools.js 里有一句：
 *   raw.replace(/[\x00-\x1f<>:"|?*]/g, '_')
 * 这个正则内部有个双引号。不识别正则时，它会被当成字符串开头，
 * 一路吞到后面第 2907 个字符的另一个双引号上，此后所有注释/字符串判断
 * 全部错位：块注释不再被剥掉、字符串边界全乱、依赖它的断言变成假绿。
 *
 * 【正则与除号怎么分】通用启发式：看 `/` 之前最近的**有效 token**。
 * 值是标识符/数字/字符串/右括号/右方括号 → 除号；其余（( , = : [ ! & | ? { } ;
 * 以及 return/typeof/case 等关键字）→ 正则。JS 词法分析的标准做法，不引依赖。
 *
 * 详见 docs/decisions/strip-comments-must-recognize-regex.md
 */

/** 判断 position 处的 `/` 是否应当按正则字面量处理（prefix 是它之前的文本） */
function regexAllowed(prefix) {
  let k = prefix.length - 1;
  while (k >= 0 && /\s/.test(prefix[k])) k--;
  if (k < 0) return true;                       // 文本开头
  const ch = prefix[k];
  if (/[a-zA-Z0-9_$\]\)}]/.test(ch)) {
    const tail = prefix.slice(Math.max(0, k - 10), k + 1);
    // 这些关键字之后，"/" 是新正则的开头而不是除号
    if (/(return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await)$/.test(tail)) return true;
    return false;
  }
  return true;
}

/**
 * 剥掉注释，保留字符串、模板字符串与正则字面量的内容。
 * 注释被替换为空格/换行，避免前后两段代码粘连（a/*x*\/b 不能变成 ab）。
 * @param {string} text
 * @returns {string} 与 text **行数相同**、行号一一对应的去注释文本
 *
 * 【换行必须原样保留 —— 这条是硬约束】
 * 早先块注释被整段替换成**一个空格**，块注释内部的换行全部丢失：
 * 一个 40 行的文件头注释会让后面每一行上移 39 行。stripComments 的
 * **唯一用途**就是「在同一份文本上做断言」，行号一错位，所有按行号定位的
 * 能力（lint 基线的行级压制、白名单按行号索引、CI annotation 指到出错行、
 * 报错信息里的 file:line）都会静默指错位置，而且不报任何错 ——
 * 这种「看起来都对」的失效最难发现。
 * 实测（2026-11）：main.js 剥完比原文少 400+ 行；scripts 里 28 个脚本的
 * 行号全对不上。修复方式是把块注释里的 '\n' 逐个补回去。
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  /* 数一段文本里的换行，用等量换行补位（不是补一个空格）。 */
  const newlinesOf = (s) => {
    let n = 0;
    for (let k = 0; k < s.length; k++) if (s.charCodeAt(k) === 10) n++;
    return n;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;         // 保留换行，避免两行粘连
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) {
        /* 未闭合的块注释：同样按原换行数补位，别把后面的行全吃掉。 */
        out += ' ' + '\n'.repeat(newlinesOf(text.slice(i)));
        i = text.length;
        continue;
      }
      /* 【补回块注释内部的换行，同时留一个分隔空格】
       * 两个要求同时成立，缺一不可：
       *   · 保行号 → 补回等量换行（否则行号漂移，见上方说明）
       *   · 不粘连 → 至少留一个空格，否则 `a/*c*​/b` 变成 `ab`
       *     （两个标识符被拼成一个，剥注释不能改动代码语义）。
       * 顺序是「空格在前、换行在后」：多出来的那个空格是行尾空白，
       * 不会把上下两行粘成一行。实测 `return a/*c*​/b;` → `return a b;`，
       * 7 行的多行注释样例仍保持 7 行。 */
      out += ' ' + '\n'.repeat(newlinesOf(text.slice(i, end + 2)));
      i = end + 2;
      continue;
    }
    if (c === '/' && regexAllowed(out)) {
      out += c; i++;
      let inClass = false;
      while (i < text.length) {
        const d = text[i];
        if (d === '\\') { out += d; i++; if (i < text.length) { out += text[i]; i++; } continue; }
        if (d === '\n') break;                  // 正则不能跨行，视为误判
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { out += d; i++; break; }
        out += d; i++;
      }
      while (i < text.length && /[gimsuyd]/.test(text[i])) { out += text[i]; i++; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c; i++;
      while (i < text.length) {
        if (text[i] === '\\') { out += text[i]; i++; if (i < text.length) { out += text[i]; i++; } continue; }
        if (text[i] === q) { out += text[i]; i++; break; }
        out += text[i]; i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * 从 open（指向 '{'）开始按括号配平，返回其后一位下标。
 * 跳过注释、字符串与正则字面量，所以不会被 {{ … }} 这类内容带偏。
 * @param {string} text
 * @param {number} open
 * @returns {number} 配平结束后的下标；-1 表示不配平
 */
function scanBrace(text, open) {
  let depth = 0, i = open, inS = null;
  while (i < text.length) {
    const c = text[i];
    if (inS) {
      if (c === '\\') i++;
      else if (c === inS) inS = null;
      i++; continue;
    }
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl === -1 ? text.length : nl; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? text.length : e + 2; continue; }
    if (c === '/' && regexAllowed(text.slice(Math.max(0, i - 40), i))) {
      i++;
      let inClass = false;
      while (i < text.length) {
        const d = text[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { i++; break; }
        i++;
      }
      while (i < text.length && /[gimsuyd]/.test(text[i])) i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inS = c; i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return -1;
}

/**
 * 抽出某个函数的完整源码段：`function name(` 或 `async function name(`。
 * @param {string} src
 * @param {string} needle 例如 'async function verifyCopy('
 * @param {string} [label] 报错时用的名字
 * @returns {string}
 */
function extractFn(src, needle, label) {
  const name = label || needle;
  const i = src.indexOf(needle);
  if (i < 0) throw new Error('找不到 ' + name);
  const open = src.indexOf('{', i);
  if (open < 0) throw new Error(name + ' 没有函数体');
  const end = scanBrace(src, open);
  if (end < 0) throw new Error(name + ' 括号不配平');
  return src.slice(i, end);
}

module.exports = { regexAllowed, stripComments, scanBrace, extractFn };
