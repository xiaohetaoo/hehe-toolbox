'use strict';
/* 渲染层脚本的「共享全局环境」契约。
 *
 * ============ 锁的是哪一次事故 ============
 * index.html 用经典 <script>（不是 type=module）加载 lib/*.js 与 js/*.js，
 * 顶层 `const` / `let` / `class` 进的是**同一个全局词法环境**。
 * lib/img-pick.js 与 lib/run-token.js 曾各自写 `const API` / `const root`：
 * img-pick 先加载没事，run-token 后加载直接
 *   Uncaught SyntaxError: Identifier 'API' has already been declared
 * 整份脚本不执行 → window.RunToken 永远不存在。控制台每次启动都报错，
 * 任何以后用到 RunToken 的页面都会 TypeError。
 *
 * 这类问题单测 require 各模块是发现不了的（node 下每个文件是独立 module
 * 作用域，同名 const 互不影响）。所以这里做两层：
 *   L1/L2 用 vm 造一个**共享上下文**，按 index.html 的真实顺序执行 lib 脚本，
 *          等价于浏览器里的加载行为；
 *   L3    静态扫描 index.html 里全部脚本的顶层词法声明，查跨文件重名。
 *
 * 【读取一律 fs.promises.readFile】test-source-assertions 的 SA-3 禁止测试
 * 里裸 readFileSync 读源码：那种写法会把注释也读进来，基于注释的误判
 * 无法被基线工具识别。这里读的是运行时脚本而不是剥注释的源码，仍然遵守
 * 同一条规矩（异步用例由 harness 的 deferred 队列等待）。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { t, done } = require('./lib/harness');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.promises.readFile(path.join(ROOT, rel), 'utf8');

/** index.html 里全部 <script src> 的本地路径，保持加载顺序。 */
async function scriptsInIndexOrder() {
  const html = await read('index.html');
  return Array.from(html.matchAll(/<script src="([^"]+\.js)"><\/script>/g), (m) => m[1]);
}

/* index.html 里只取 lib 脚本做「真实执行」：它们是纯逻辑模块，不依赖 DOM。
 * js/*.js 会用 document / App，属于页面脚本，由各自的 UI 测试覆盖。 */
function libScripts(scripts) {
  return scripts.filter((rel) => rel.startsWith('lib/'));
}

/**
 * 抽出一个脚本在**顶层**（花括号深度 0）声明的 const / let / class 名字。
 *
 * 先剥掉注释与字符串（替换成空格、保留换行与长度），这样注释里的
 * "const API"、字符串里的 `{` 都不会干扰深度与匹配；再按字符累计
 * 花括号深度，只收深度为 0 的声明。IIFE 里的大量 const 因此被正确忽略。
 */
function topLexicalNames(code) {
  let cleaned = '';
  let i = 0;
  let mode = null;
  let quote = '';
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (mode === 'line') {
      if (c === '\n') { mode = null; cleaned += c; } else { cleaned += ' '; }
      i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = null; cleaned += '  '; i += 2; continue; }
      cleaned += (c === '\n' ? '\n' : ' ');
      i++; continue;
    }
    if (mode === 'str') {
      if (c === '\\') { cleaned += '  '; i += 2; continue; }
      if (c === quote) { mode = null; cleaned += ' '; } else { cleaned += (c === '\n' ? '\n' : ' '); }
      i++; continue;
    }
    if (mode === 'tpl') {
      if (c === '\\') { cleaned += '  '; i += 2; continue; }
      if (c === '`') { mode = null; cleaned += ' '; } else { cleaned += (c === '\n' ? '\n' : ' '); }
      i++; continue;
    }
    if (c === '/' && n === '/') { mode = 'line'; cleaned += '  '; i += 2; continue; }
    if (c === '/' && n === '*') { mode = 'block'; cleaned += '  '; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      quote = c; mode = (c === '`' ? 'tpl' : 'str'); cleaned += ' '; i++; continue;
    }
    cleaned += c; i++;
  }

  const marks = Array.from(cleaned.matchAll(/(?:const|let|class)\s+([A-Za-z_$][\w$]*)/g),
    (m) => ({ name: m[1], idx: m.index }));
  const names = [];
  let depth = 0;
  let mi = 0;
  for (let p = 0; p < cleaned.length; p++) {
    while (mi < marks.length && p === marks[mi].idx) {
      if (depth === 0) names.push(marks[mi].name);
      mi++;
    }
    if (cleaned[p] === '{') depth++;
    else if (cleaned[p] === '}') depth = Math.max(0, depth - 1);
  }
  return names;
}

t('L1 index.html 引用的 lib 脚本能在同一个全局环境里全部加载', async () => {
  const list = libScripts(await scriptsInIndexOrder());
  assert.ok(list.length >= 6, '锁的是：index.html 里至少应加载 6 个 lib 脚本（实际 ' + list.length + '）');
  const ctx = vm.createContext({ console });
  ctx.window = ctx;
  for (const rel of list) {
    const file = path.join(ROOT, rel);
    const code = await read(rel);
    assert.doesNotThrow(
      () => vm.runInContext(code, ctx, { filename: file }),
      rel + ' 在共享全局环境里抛异常（大概率是顶层 const/let 撞名）'
    );
  }
});

t('L2 关键 UMD 模块确实挂到了 window 上', async () => {
  const ctx = vm.createContext({ console });
  ctx.window = ctx;
  for (const rel of libScripts(await scriptsInIndexOrder())) {
    vm.runInContext(await read(rel), ctx, { filename: rel });
  }
  for (const name of ['SafeName', 'ImgPick', 'RunToken', 'OcrGuard']) {
    assert.strictEqual(typeof ctx[name], 'object', '锁的是：window.' + name + ' 必须存在（曾被同名 const 撞掉）');
  }
  assert.strictEqual(typeof ctx.RunToken.isCurrentRun, 'function');
  assert.strictEqual(typeof ctx.ImgPick.decideOutcome, 'function');
});

t('L3 index.html 全部脚本的顶层 const/let/class 不得跨文件重名', async () => {
  const owner = new Map();
  for (const rel of await scriptsInIndexOrder()) {
    let code;
    try { code = await read(rel); } catch (e) { continue; } /* 不存在的脚本交给 L1 报 */
    const names = topLexicalNames(code);
    for (const name of names) {
      assert.ok(!owner.has(name),
        '锁的是：顶层词法名 "' + name + '" 在 ' + owner.get(name) + ' 与 ' + rel
        + ' 重复 —— 后加载的整份脚本会 SyntaxError（改为模块专属前缀或包进 IIFE）');
      owner.set(name, rel);
    }
  }
});

done();
