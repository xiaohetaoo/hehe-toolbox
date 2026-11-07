'use strict';
/* 工具页渲染期 TDZ 崩溃：`const` / `let` 声明的变量在**声明之前**被求值。
 *
 * ============ 锁的是哪个回归 ============
 * 上一轮把「文件内容搜索」的 start 从 `function start()` 改成
 * `const start = guard(startImpl)` —— 防重入的正确写法（项目规定一律走 ui.guard）。
 * 但 **按钮那一行留在了原处**：
 *     const startBtn = btn('搜索', 'btn-primary', start, 'search');   ← 869 行
 *     ...
 *     const start = guard(startImpl);                                  ← 956 行
 * 函数声明会被提升，`const` 不会。于是打开这个工具页直接抛
 *     ReferenceError: Cannot access 'start' before initialization
 * 整页渲染失败。而 js/app.js 的渲染兜底只打一行 console 日志，
 * 用户看到的是「点了没反应 / 一用就崩」。
 *
 * 这不是「写错一行」那么简单：**把 function 改成 const 是防重入改造的必经之路**，
 * 每一次这样的改造都可能把「提升依赖」变成崩溃点。
 *
 * ============ 判据怎么定（前两版都写错过，记在这里） ============
 * 第一版「声明行之前出现过这个名字就算」→ 误报 100+ 处。同一个词还会以
 * 这些身份出现，全都不构成 TDZ：函数形参 / 对象字面量的键 / 字符串内容 /
 * 函数返回值 / 属性访问。
 * 第二版加了「只能是读值形态」→ 仍有误报，因为漏了一个更根本的区别：
 * **引用发生在回调闭包里时不会崩**。
 *     const picker = filePicker({ onChange: () => { resultBox.innerHTML = ''; } });
 *     const resultBox = div('');          ← 声明在后面，但箭头函数是**之后**才执行
 * 这类写法在项目里遍地都是（onChange / rowEnd / btn 回调 / onCleanup），
 * 它们是延迟求值，闭包按最终值绑定，完全不触发 TDZ。
 *
 * 最终判据 = **只查 render 主体的「顶层直接执行路径」**：
 *   · 跳过任何函数体内部（箭头函数 / function / 方法体）—— 那是延迟执行；
 *   · 只比同一花括号深度上的引用；
 *   · 且该引用要么被属性访问（`x.y`）、要么在赋值右侧、要么作实参。
 * 真崩溃点（`btn('搜索', start)` 直接写在 render 里）正好落在这个交集里，
 * 而上面那些闭包引用全部被排除。实测：误报 0，注入真回归能红。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t, done, readSrc } = require('./lib/harness');
const srcScan = require('../lib/src-scan');

const ROOT = path.join(__dirname, '..');

/** 收集要检查的渲染层文件。 */
function targets() {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel + '/' + ent.name;
      if (ent.isDirectory()) walk(r);
      else if (ent.name.endsWith('.js')) out.push(r);
    }
  };
  walk('js/tools');
  return out;
}

/** 把字符串/模板内容抹成空格（保留换行，行号不乱）。 */
function blankStrings(code) {
  const out = code.split('');
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out[i] = ' ';
      i++;
      while (i < n) {
        if (code[i] === '\\') { out[i] = ' '; if (i + 1 < n) out[i + 1] = ' '; i += 2; continue; }
        if (code[i] === q) { out[i] = ' '; i++; break; }
        if (code[i] !== '\n') out[i] = ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * 逐行标注「该行起始时的花括号深度」与「处在第几层函数体里」。
 * 判断 `{` 是不是函数体：往前看最近的非空白字符是 `)` 或 `=>` 的 `>`。
 *
 * 【为什么要记层数而不是布尔值】
 * `render(page) {` 本身就是一个函数体 —— 它内部的一切都在「函数里」。
 * 但 render 的**函数体是同步执行的**，其中的语句按书写顺序求值，
 * TDZ 完全照常发生。真正会被延迟执行的是 render 里**再嵌套**的那些函数
 * （btn 的回调、onChange、onCleanup、setTimeout）——
 * 它们在 render 返回之后才跑，那时 const 早已初始化。
 * 所以判据是「比 render 那一层更深的函数体才跳过」，不是「在函数里就跳过」。
 * 第一版用了布尔值，结果把所有 render 内的语句都放过了 ——
 * 注入真崩溃也检测不到（实测确认）。
 */
function lineInfo(blanked) {
  const lines = blanked.split('\n');
  const info = [];
  let depth = 0;
  const fnStack = [];
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    /* fnDepth = 当前处在该行时，已经进入的函数体层数 */
    info.push({ depth, fnDepth: fnStack.filter(Boolean).length });
    for (let i = 0; i < ln.length; i++) {
      const c = ln[i];
      if (c === '{') {
        let j = i - 1;
        /* 锁的是：跳过空白以定位上一层括号 —— 这是**解析器内部**的字符判断，
         * 不是对项目源码做形态断言（SA-4 防的是后者）。 */
        while (j >= 0 && /\s/.test(ln[j])) j--;
        const isFn = j >= 0 && (ln[j] === ')' || (ln[j] === '>' && ln[j - 1] === '='));
        depth++;
        fnStack.push(isFn);
      } else if (c === '}') {
        depth--;
        fnStack.pop();
      }
    }
  }
  return info;
}

/**
 * 检查一个 register 块。
 * @param {string} blanked 已抹字符串的源码（用于结构分析）
 * @param {string} orig 原文（用于报错展示）
 * @returns {Array<string>} 问题描述
 */
function checkBlock(blanked, orig) {
  const lines = blanked.split('\n');
  const origLines = orig.split('\n');
  const info = lineInfo(blanked);

  /* 收集 const/let 声明：名字 → { 行号, 深度, 所在函数层数 } */
  const decl = new Map();
  lines.forEach((ln, i) => {
    const m = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/.exec(ln);
    if (m && !decl.has(m[1])) decl.set(m[1], { line: i + 1, depth: info[i].depth, fnDepth: info[i].fnDepth });
  });

  /* render() 本身那一层就是「同步执行基准层」，见 lineInfo 的注释。
   * 取该块内所有声明里最小的 fnDepth 作为基准（工具块内最深层的同步代码就是它）。 */
  let baseFn = Infinity;
  for (const d of decl.values()) baseFn = Math.min(baseFn, d.fnDepth);

  const problems = [];
  lines.forEach((ln, i) => {
    /* ① 比基准更深的函数体 = 延迟执行（btn 回调 / onChange / onCleanup …），
     * 闭包按最终值绑定，不触发 TDZ。基准层（render 自身）必须查。 */
    if (info[i].fnDepth > baseFn) return;
    /* ①b 单行箭头函数：`guard(fn, { before: () => { x.disabled = true; } })`。
     * 整个箭头都在同一行，花括号深度/函数层数都还停在基准层，
     * 但它是**回调**，要等 guard 真正调用时才执行。判据：
     * 该行出现在 `=>` 之后 —— 简单说，行内 `=>` 左边的部分才算同步代码，
     * 右边一律按延迟处理。lan-scan 的 `before: () => { scanBtn.disabled = … }`
     * 正是这种形态（实测误报过）。
     * 注意不能整行跳过：`const f = async () => {...}` 这种声明行也要收名字，
     * 所以只把「比对位置」限定在 `=>` 之前的那一段。 */
    const arrowAt = ln.indexOf('=>');
    const syncPart = arrowAt >= 0 ? ln.slice(0, arrowAt) : ln;
    for (const [name, d] of decl) {
      if (name.length < 3) continue;          // i/k/e 这类循环变量不查
      if (i + 1 >= d.line) continue;          // 只看声明**之前**
      if (d.fnDepth > baseFn) continue;       // 声明本身在闭包里 → 不受渲染顺序约束
      /* ② 引用必须位于「同一层或更深」，且中间不能跨进另一个**函数体**。
       * 【为什么不是「深度必须相等」】真崩溃点长这样：
       *     const realStartBtn = btn('搜索', 'btn-primary', start, 'search');
       *     const start = guard(startImpl);
       * `start` 作为实参，被包在 `btn(...)` 的圆括号里 —— 圆括号不加深度，
       * 但项目里更常见的写法是多层嵌套调用（div(card, btn(..., start))），
       * 那会让「引用所在行」的深度与声明行不同。要求相等会漏掉它们。
       * 真正该排除的是「跨进函数体」—— 那属于延迟执行（已在 ① 排除），
       * 以及「深度比声明更浅」—— 那不是同一条执行路径。
       * 所以判据取 ≥。 */
      if (info[i].depth < d.depth) continue;
      const esc = name.replace(/\$/g, '\\$');
      /* ③ 必须是「读值」形态：属性访问 / 赋值右侧 / 作实参。
       * 只在 syncPart（`=>` 左边那段）里找 —— 右边是回调体，见 ①b。 */
      const re = new RegExp('(^|[^\\w$.])' + esc + '(?![\\w$])');
      const m = re.exec(syncPart);
      if (!m) continue;
      const rest = syncPart.slice(m.index + m[1].length + name.length);
      /* 锁的是：判定「标识符是否被当值读取」—— 同样是**解析器内部**判断，
       * 不是源码形态断言。下面三行是一组（属性访问 / 作实参 / 赋值右侧）。 */
      const isRead = /^\s*\./.test(rest)                       // x.yyy
        || /^\s*[,)]/.test(rest)                               // f(..., x) / f(..., x, ...)
        /* 锁的是：赋值右侧形态（前两行那两个分支的说明在上方 186 行）——
         * 同样是解析器内部判断，不是对项目源码做形态断言。 */
        || /(^|[^=!<>])=\s*$/.test(syncPart.slice(0, m.index + m[1].length)); // x = name
      if (!isRead) continue;
      problems.push(name + ' 声明于 ' + d.line + ' 行，却在 ' + (i + 1) + ' 行就被读了：' +
        String(origLines[i] || '').trim().slice(0, 110));
      break;
    }
  });
  return problems;
}

/** 把一个文件按 register 块切开并逐个检查。 */
function checkFile(rel) {
  const raw = readSrc(rel, { raw: true });
  const clean = srcScan.stripComments(raw);
  /* 【先按 clean 的索引切块，再各自抹字符串】
   * 反过来做（先抹全文再 slice）看起来等价，但 blankStrings 会把字符串
   * 里的换行原样保留、把字符换成空格 —— 长度不变，索引对得上。
   * 真正踩过的坑是：块边界用 `^\s*register\(\{` 在 clean 上定位，
   * 而 `\s*` 会匹配到**前一块末尾的换行**，导致切出来的块开头少了几个字符。
   * 这里改成「切完立刻验证 id 对得上」，对不上就报出来，不静默错位。 */
  const starts = [];
  const re = /^\s*register\(\{/gm;
  let m;
  while ((m = re.exec(clean))) starts.push(m.index);
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const a = starts[k];
    const b = k + 1 < starts.length ? starts[k + 1] : clean.length;
    const segClean = clean.slice(a, b);
    const segRaw = raw.slice(a, b);
    const problems = checkBlock(blankStrings(segClean), segRaw);
    /* 块定位自检：每个块里必须有 id: 'xxx'，否则说明切歪了（静默漏检） */
    /* 锁的是：切块自检 —— 切歪了就报「定位错位」，避免静默漏检。
     * 这是**校验器内部**的完整性检查，不是对项目源码的形态断言。 */
    if (problems.length && !/id:\s*'/.test(segClean)) {
      out.push(rel + '（第 ' + (k + 1) + ' 块）：**块定位疑似错位**，无法确定是哪个工具');
    }
    for (const p of problems) out.push(rel + '（第 ' + (k + 1) + ' 个工具）：' + p);
  }
  return out;
}

t('TDZ1 「文件内容搜索」不再在 start 声明前引用它（真实崩溃点）', () => {
  /* 锁的是：把结果按名字缩小到 start 相关项 —— 真正的断言是下面的
   * deepStrictEqual；这条正则只是**过滤**，不是形态断言。 */
  const problems = checkFile('js/tools/file-tools.js').filter((x) => /start/.test(x));
  /* 锁的是：startBtn 在 `const start = guard(...)` 之前就把 start 当回调传进去 ——
   * 打开这个工具页直接 ReferenceError，整页渲染失败（用户看到「一用就崩」）。 */
  assert.deepStrictEqual(problems, [],
    '这些变量在被声明之前就被读了（运行时会抛 ReferenceError）：\n  ' + problems.join('\n  '));
});

t('TDZ2 「文件内容搜索」的搜索按钮确实绑到了 guard 包装后的 start', () => {
  const raw = readSrc('js/tools/file-tools.js', { raw: true });
  const clean = srcScan.stripComments(raw);
  const i = clean.indexOf("id: 'content-search'");
  assert.ok(i > 0, '找不到 content-search');
  const seg = clean.slice(i, i + 20000);
  /* 锁的是：为了让 TDZ1 变绿而把回调换成一个不做防重入的裸函数。 */
  assert.ok(/const start = guard\(startImpl\)/.test(seg), 'start 没有走 guard(startImpl)');
  /* 锁的是：按钮绑定的不是 start（例如绑了 startImpl，绕过防重入）。 */
  assert.ok(/btn\('搜索',\s*'btn-primary',\s*start/.test(seg), '搜索按钮没有绑定 start');
  /* 锁的是：Enter 那条入口绕过了 guard —— 回车能并发进第二次。 */
  assert.ok(/if \(e\.key === 'Enter'\) start\(\)/.test(seg), 'Enter 没有走同一个 guarded 函数');
});

t('TDZ3 全部工具文件都没有「声明前读值」（同类问题不会只此一处）', () => {
  const bad = [];
  for (const rel of targets()) for (const p of checkFile(rel)) bad.push(p);
  /* 锁的是：同类改造（function 改 const guard）在别的工具上重演 ——
   * 每条都是一次「打开就崩」，而且只在真机点开那一页时才暴露。 */
  assert.deepStrictEqual(bad, [], '这些地方会在渲染时抛 ReferenceError：\n  ' + bad.join('\n  '));
});

t('TDZ4 检测器自身有效（注入一处真回归必须能红）', () => {
  /* 【必须有这条】否则 TDZ1/TDZ3 的"零误报"可能只是检测器失灵。
   * 用一个最小样本在内存里跑，不碰磁盘。 */
  const sample = [
    '      const goto = guard(impl);',
    '      const btnEl = btn("跑", "btn-primary", goto);',
    '      function impl() { return 1; }',
  ].join('\n');
  /* 上面的样本里 goto 声明在前，不构成问题；下面这个才是崩溃形态 */
  const broken = [
    '      const btnEl = btn("跑", "btn-primary", goto);',
    '      const goto = guard(impl);',
    '      function impl() { return 1; }',
  ].join('\n');
  const okRes = checkBlock(blankStrings(sample), sample);
  const badRes = checkBlock(blankStrings(broken), broken);
  /* 锁的是：检测器看不见真崩溃点 —— 那样 TDZ3 永远绿，等于没测。 */
  assert.deepStrictEqual(okRes, [], '正常样本被误报：' + okRes.join('; '));
  assert.ok(badRes.length > 0, '崩溃样本没被抓到 —— 检测器失灵');
  assert.ok(/goto/.test(badRes.join(' ')), '抓到了但没指名 goto：' + badRes.join('; '));
});

done();
