'use strict';
/* 测试公共骨架。
 *
 * ============ 这个文件存在的原因 ============
 * 84 个测试脚本里有 34 个各自定义了一份 `function t(name, fn)`，
 * 内容几乎相同（try/catch + pass/fail 计数），却复制了 34 遍。
 *
 * ============ 两条必须守住的契约 ============
 * 1) **输出格式逐字不变**
 *    CI 的 .github/workflows/ci.yml 靠 `grep -E '^(FAIL|SKIP) '` 抓失败行做
 *    annotation。所以 PASS/FAIL 前后的空格数不能统一：
 *    · 绝大多数脚本是 `'PASS  '` / `'FAIL  ' + name + '  -> ' + msg`（双空格）
 *    · 少数脚本（test-aux-windows-csp / test-round9-fixes / test-round15-fixes
 *      等）原本用 `' -> '`（单空格）
 *    迁移时**逐字保留**，由调用方通过 failSep 指定。
 *
 * 2) **输出顺序不变**
 *    原项目的 t() 有两种执行模型，顺序行为**本来就不同**，不能强行统一：
 *      · deferred   —— 同步用例当场打印；异步用例收集起来，done() 时才跑。
 *                     于是异步用例的 PASS 都堆在末尾（原 test-round9/10/11
 *                  /12、test-links、test-round13/14/15 都是这个形态）
 *      · sequential —— 所有用例按注册顺序串行（原 test-link-read-memory 形态）
 *    迁移前的输出顺序必须原样保持，否则逐字对比失效、也让人误以为少了用例。
 *
 * ============ 源码断言的规矩（给后来者）============
 * 这个项目里有很多「读源码 + 正则匹配」的断言。它们脆弱得很：
 * 改动实现、调整注释、重排版面都可能让断言的**字面**失配，
 * 而功能其实是对的 —— 历史上已经有 3 次 CI 中断就是这么来的
 * （ffba977、1c10a8d，以及 round12-③ 那次）。
 *
 * 所以：**能写成行为断言的，一律写成行为断言**（跑真实现、断言返回值）。
 * 只有在「确实无法用行为验证」时才退回源码断言，并且必须在该条断言旁
 * 写清三点：
 *   1) 锁的是哪个历史回归（不是"我觉得这样写更好"）；
 *   2) 为什么不能用行为断言替代（例如断言的是"某个 API 被调用了"、
 *      而该 API 在测试环境里无法真实执行）；
 *   3) 匹配串尽量锚定**语义**而不是版面（用 stripComments 先剥注释、
 *      用 lastIndexOf 配窗口，而不是 `\n\s+` 这类版面语法）。
 * 做不到这三点的源码断言，应改成行为断言或直接删除。
 *
 * ============ 用法 ============
 *   const { t, done } = require('./lib/harness');            // deferred + 双空格
 *   const { t, done } = createSuite({ failSep: ' -> ' });     // 单空格
 *   const { t, done } = createSuite({ order: 'sequential' }); // 按注册顺序
 *   t('名字', () => { ... });        // 同步
 *   t('名字', async () => { ... });  // 异步
 *   done();                          // 打印结果并 process.exit
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const srcScan = require(path.join(ROOT, 'lib', 'src-scan'));

/* 读项目内源码。默认剥注释 —— 源码断言几乎都要在"没有注释干扰"的文本上做，
 * 否则注释里出现的代码片段会被误判（round14 那次 stripComments 被正则带偏，
 * 就是同类问题的放大版）。需要原始文本时传 { raw: true }。 */
function readSrc(relPath, opts) {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(ROOT, relPath);
  const text = fs.readFileSync(abs, 'utf8');
  return (opts && opts.raw) ? text : srcScan.stripComments(text);
}

/**
 * 读「一个逻辑单元可能散落在多个文件里」的全部源码。
 *
 * 【为什么需要它】任务 9 把 js/tools/media.js（1803 行、16 个工具）拆成了
 * js/tools/media/*.js 的 17 个文件。原来有 11 个测试脚本按**固定路径**
 * 读 media.js 做源码断言，拆完就会全部报「文件不存在」——
 * 而它们要验的是「媒体工具里有没有某个实现」，这个语义与文件数无关。
 *
 * 所以这些断言改成 readTree('js/tools/media')：把整个目录拼起来再断言。
 * 拼起来的文本里，原来单文件内的断言（函数定义、某段逻辑）照样成立。
 *
 * 一个要注意的地方：**跨文件的顺序断言会失效**。例如原来断言
 * 「A 出现在 B 之前」，拆到两个文件后拼接顺序取决于目录遍历顺序 ——
 * 这类断言不能直接用 readTree，要么按明确文件顺序读，要么改成行为断言。
 *
 * @param {string} relDir 相对项目根的目录
 * @param {object} [opts] 同 readSrc（raw 保留原始文本）
 * @returns {string} 该目录下所有 .js 文件按文件名排序拼接后的文本
 */
function readTree(relDir, opts) {
  const abs = path.isAbsolute(relDir) ? relDir : path.join(ROOT, relDir);
  const names = fs.readdirSync(abs).filter((n) => n.endsWith('.js')).sort();
  const parts = names.map((n) => {
    const absFile = path.join(abs, n);
    const text = fs.readFileSync(absFile, 'utf8');
    return (opts && opts.raw) ? text : srcScan.stripComments(text);
  });
  /* 用换行 + 注释分隔，避免两个文件首尾相接粘连成一个假 token。 */
  return parts.join('\n/* ---- 文件分隔 ---- */\n');
}

/**
 * 读「主进程」全部源码：main.js + ipc/ 目录下所有文件，按固定顺序拼接。
 *
 * 【为什么需要它】任务 5 把「目录搬家 + 权限/链接」两个域从 main.js 搬到了
 * ipc/acl-links.js。原来的测试都用 `readSrc('main.js')` 或
 * `fs.readFileSync('main.js')` 去找 handler / 找函数实现，搬完之后统一报
 * 「找不到 handler: link:remove」「找不到 rmQueryLockers」—— 而它们要验的
 * 语义是「主进程里有没有这个实现」，与代码在哪个文件无关。
 *
 * 拼接顺序固定为：main.js 在前，ipc/ 下的文件按文件名排序在后。
 * 这一点对**跨文件的顺序断言**仍然是坏消息 —— 原来断言「A 在 B 之前」，
 * 现在 A、B 可能分属两个文件。遇到这种断言必须按明确文件读，或者改成
 * 行为断言。scripts/test-ipc-channels.js 与 test-round10/12 的
 * handlerPos 属于前一种，它们各自显式处理，不走这个入口。
 */
function readMain(opts) {
  const mainAbs = path.join(ROOT, 'main.js');
  const parts = [fs.readFileSync(mainAbs, 'utf8')];
  const ipcDir = path.join(ROOT, 'ipc');
  if (fs.existsSync(ipcDir)) {
    for (const n of fs.readdirSync(ipcDir).filter((x) => x.endsWith('.js')).sort()) {
      parts.push(fs.readFileSync(path.join(ipcDir, n), 'utf8'));
    }
  }
  const joined = parts.join('\n/* ---- 文件分隔 ---- */\n');
  return (opts && opts.raw) ? joined : srcScan.stripComments(joined);
}

/**
 * 造一个测试套件。
 * @param {object} [opts]
 * @param {string} [opts.failSep='  -> '] FAIL 与 message 之间的分隔符
 * @param {'deferred'|'sequential'} [opts.order='deferred']
 *   deferred   = 同步立即打印，异步收集到 done() 再跑（原多数脚本的形态）
 *   sequential = 全部按注册顺序串行（原 cases 收集式脚本的形态）
 */
function createSuite(opts) {
  const failSep = (opts && opts.failSep) || '  -> ';
  const order = (opts && opts.order === 'sequential') ? 'sequential' : 'deferred';
  let pass = 0, fail = 0;

  /* deferred 模式的异步队列；sequential 模式的串行链。 */
  const pending = [];
  let chain = Promise.resolve();

  const emitPass = (name) => { pass++; console.log('PASS  ' + name); };
  const emitFail = (name, e) => {
    fail++;
    const msg = (e && e.message) || String(e);
    /* 【保持一行】CI 用行首 grep 抓 FAIL，错误消息里的换行必须折掉，
     * 否则 annotation 只拿到第一行片段。 */
    console.log('FAIL  ' + name + failSep + msg.replace(/\r?\n/g, ' ⏎ '));
  };

  const t = (name, fn) => {
    if (order === 'sequential') {
      /* 所有用例（含同步的）都串到同一条链上，严格按注册顺序出结果。 */
      chain = chain.then(() => {
        let r;
        try { r = fn(); }
        catch (e) { emitFail(name, e); return; }
        if (r && typeof r.then === 'function') {
          return r.then(() => emitPass(name), (e) => emitFail(name, e));
        }
        emitPass(name);
      }).catch(() => {});
      pending.push(chain);
      return;
    }
    /* deferred：同步的当场打印；异步的收起来，done() 时统一跑。 */
    let r;
    try { r = fn(); }
    catch (e) { emitFail(name, e); return; }
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => emitPass(name), (e) => emitFail(name, e)));
    } else {
      emitPass(name);
    }
  };

  /* done() 必须等异步用例。
   * 【坑】原写法 `process.exit(...)` 会立刻终止 —— 若照搬同步 exit，
   * 异步用例根本跑不完，输出会静默少若干条而 FAIL 仍为 0。 */
  async function doneAsync() {
    if (pending.length) {
      await Promise.all(pending);
      pending.length = 0;
    }
    console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  }
  const done = () => {
    doneAsync().catch((e) => {
      console.log('FAIL  套件收尾异常' + failSep + ((e && e.message) || e));
      process.exit(1);
    });
  };

  return { t, done, counts: () => ({ pass, fail }) };
}

/* 读源码相关的常用封装（薄壳，避免每个脚本各写一遍）。 */
const assert = require('assert');
const helpers = {
  readSrc,
  readTree,
  readMain,
  ROOT,
  stripComments: srcScan.stripComments,
  extractFn: srcScan.extractFn,
};

module.exports = Object.assign({ createSuite, readSrc, readTree, readMain }, helpers, { assert });

/* 便捷默认实例：绝大多数脚本直接用 `const { t, done } = require('./lib/harness')`。 */
const defaultSuite = createSuite();
module.exports.t = defaultSuite.t;
module.exports.done = defaultSuite.done;
