'use strict';
/* 源码断言的扫描内核（被元测试与基线生成器共用）。
 *
 * 【为什么单独一份】
 * 「什么算源码断言」这个判断本身会演化：早先只认 readFileSync，
 * 后来又要把 readSrc/readTree/readMain 与脚本自带的 read() 助手算进去；
 * 再后来发现 `JSON.parse(readFileSync(...))` 得到的是运行期数据、不是源码文本，
 * 得排除掉。这套判断如果抄两份（元测试一份、基线生成器一份），
 * 迟早会分叉——元测试按新标准判红，基线却按旧标准计数，于是永远对不上，
 * 而人对"永远红"的检查只会做一件事：关掉它。
 *
 * 所以这里集中一份，谁用谁 require。两个调用方：
 *   scripts/test-source-assertions.js          —— 判红
 *   scripts/gen-source-assertions-baseline.js  —— 拍快照
 *
 * 【依赖约定】必须用 lib/src-scan 的 stripComments，不能自己写一份。
 * 自己写的那版不认正则字面量，会把 net-tools.js 里的 /["|?*]/ 当成字符串
 * 开头，一路吞到两千多字符之外，此后所有判断错位——这个坑历史上踩过。
 * 另外 stripComments 现在保证「行号与原文一一对应」，下面靠这个前提
 * 用同一套下标去取原始行文本做报错展示。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { stripComments } = require(path.join(ROOT, 'lib', 'src-scan'));

const SCRIPTS_DIR = path.join(ROOT, 'scripts');

function listScripts() {
  return fs.readdirSync(SCRIPTS_DIR)
    .filter((n) => n.endsWith('.js'))
    .sort()
    .map((n) => 'scripts/' + n);
}

/* 从 '(' 位置按括号配对取出实参文本。
 * 用正则 `readFileSync\(([^;]*)` 在跨行 + 嵌套括号时会取歪。 */
function callArgs(code, openParenIdx) {
  let depth = 0;
  let i = openParenIdx;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) break; }
  }
  return code.slice(openParenIdx + 1, i);
}

function lineAt(code, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (code.charCodeAt(i) === 10) n++;
  return n;
}

/* 找出某个脚本里「产生了项目源码文本」的局部标识符。
 *
 * 三种来源：
 *   1) harness 的 readSrc / readTree / readMain
 *   2) 直接 fs.readFileSync
 *   3) 脚本自带的读源码小助手（const read = (p) => fs.readFileSync(...)）
 * 然后做几轮别名传播（const a = read(x); const b = a.slice(...)）。
 *
 * 【刻意不传播的一种】`const r = JSON.parse(fs.readFileSync(f, 'utf8'))`。
 * 那是解析测试自己落盘的结果 JSON，得到的是**运行期数据**，
 * 后续 `r.repair.msg` 之类的断言是行为断言，不是源码断言。
 * 早期没排除它，e2e 脚本多出三十多条假阳性。 */
function sourceTextVars(codeLines) {
  const wrappers = new Set();
  for (const ln of codeLines) {
    let m;
    const arrow = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*[^\n]*readFileSync\s*\(/g;
    while ((m = arrow.exec(ln))) wrappers.add(m[1]);
    const fnDecl = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{[^\n]*readFileSync\s*\(/g;
    while ((m = fnDecl.exec(ln))) wrappers.add(m[1]);
  }
  const esc = (s) => s.replace(/\$/g, '\\$');
  const wrapperRe = wrappers.size
    ? new RegExp('\\b(?:' + [...wrappers].map(esc).join('|') + ')\\s*\\(')
    : null;

  const vars = new Set();
  const assigns = [];
  codeLines.forEach((ln, i) => {
    const m = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/.exec(ln);
    if (m) assigns.push({ name: m[1], rhs: m[2], line: i + 1 });
  });
  const isSourceRhs = (rhs) => {
    if (/JSON\.parse\s*\(/.test(rhs)) return false;
    return /\b(?:readSrc|readTree|readMain)\s*\(/.test(rhs)
      || /readFileSync\s*\(/.test(rhs)
      || (wrapperRe && wrapperRe.test(rhs));
  };
  for (const a of assigns) if (isSourceRhs(a.rhs)) vars.add(a.name);
  for (let pass = 0; pass < 3; pass++) {
    for (const a of assigns) {
      if (vars.has(a.name)) continue;
      if (/JSON\.parse\s*\(/.test(a.rhs)) continue;
      for (const v of vars) {
        if (new RegExp('(?<![\\w$.])' + esc(v) + '(?![\\w$])').test(a.rhs)) { vars.add(a.name); break; }
      }
    }
  }
  return { vars, wrappers, wrapperRe };
}

/**
 * 扫一个脚本。
 * @returns {{ file:string, reads:Array, asserts:Array }}
 *   reads   —— 裸 readFileSync 的每一处（line / args / text）
 *   asserts —— 对源码文本做匹配的每一处（line / ok / text）
 *              ok=true 表示上方三行内写了「锁的是」
 */
function scanFile(relPath) {
  const abs = path.join(ROOT, relPath);
  const raw = fs.readFileSync(abs, 'utf8');
  /* 【必须剥注释再扫】本项目注释里大量出现 `readFileSync(` 与
   * `assert.ok(/xxx/.test(src))` 这类示例与说明，不剥会把注释当成违规。
   * 这也是 readSrc 默认剥注释的同一个道理。 */
  const code = stripComments(raw);
  const codeLines = code.split('\n');
  const rawLines = raw.split('\n');
  const { vars, wrapperRe } = sourceTextVars(codeLines);
  const esc = (s) => s.replace(/\$/g, '\\$');
  const varRe = vars.size
    ? new RegExp('(?<![\\w$.])(?:' + [...vars].map(esc).join('|') + ')(?![\\w$])')
    : null;

  const reads = [];
  const asserts = [];

  /* ---- A：裸 readFileSync ---- */
  const rfsRe = /readFileSync\s*\(/g;
  let m;
  const seenLines = new Set();
  while ((m = rfsRe.exec(code))) {
    const line = lineAt(code, m.index);
    const lineText = codeLines[line - 1] || '';
    /* 跳过「把函数本身取出来用」的形态：解构 require、挂到模块上。 */
    if (/readFileSync\s*[,}=:]/.test(lineText)) continue;
    if (/readFileSync\s*=\s*require/.test(lineText)) continue;
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    reads.push({
      line,
      args: callArgs(code, m.index + m[0].length - 1).replace(/\s+/g, ' ').slice(0, 100),
      text: (rawLines[line - 1] || '').trim(),
    });
  }

  /* ---- B：源码匹配断言 ---- */
  const matchRe = /\.(?:test|includes|match)\s*\(/;
  codeLines.forEach((ln, i) => {
    if (!matchRe.test(ln)) return;
    const isSource = /\b(?:readSrc|readTree|readMain)\s*\(/.test(ln)
      || /readFileSync\s*\(/.test(ln)
      || (wrapperRe && wrapperRe.test(ln))
      || (varRe && varRe.test(ln));
    if (!isSource) return;
    /* 断言可能跨行（`chk(\n  /re/.test(x),`）。往上找到语句起点，
     * 从起点再往上数 3 行——注释写在语句上方，不是写在 `.test(` 上方。 */
    let start = i;
    while (start > 0 && i - start < 6 && /[,(\[{]\s*$/.test(codeLines[start - 1])) start--;
    const above = [rawLines[start], rawLines[start - 1] || '', rawLines[start - 2] || '', rawLines[start - 3] || ''].join('\n');
    asserts.push({ line: i + 1, ok: above.includes('锁的是'), text: (rawLines[i] || '').trim() });
  });

  return { file: relPath, reads, asserts };
}

/** 扫全部脚本。 */
function scanAll() {
  return listScripts().map(scanFile);
}

/**
 * 每个文件的存量计数快照（给基线生成器用）。
 * 只列出**有违规**的文件——干净的文件不进基线，于是它们一旦出问题
 * 就会落在「不在基线里」那一支，立刻判红。
 */
function snapshot() {
  const out = [];
  for (const r of scanAll()) {
    const A = r.reads.length;
    const B = r.asserts.filter((x) => !x.ok).length;
    if (A || B) out.push({ file: r.file, A, B });
  }
  return out;
}

module.exports = { ROOT, SCRIPTS_DIR, listScripts, scanFile, scanAll, snapshot, sourceTextVars };
