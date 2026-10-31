'use strict';
/* ① 防重入标志回归测试：不许再有「置 true 之后提前 return 却不复位」的分支。
 *
 * 背景：这类 bug 一共出现过 7 次，后果都一样 —— 按钮永久失去响应，
 * 只有切页重建才恢复。走到的路径还都是最常见的操作
 * （没选文件、没填密码、在保存对话框点取消、没装 FFmpeg）。
 * 根因是「先 running = true，再在若干早退分支里手写复位」，
 * 漏一处就卡死，而且逐处手写必然漏。
 *
 * 本测试两道防线：
 *   1) 行为：用 ui.js 里**真实的** guard() 跑，验证任何 return/throw 都复位；
 *   2) 静态：扫出工具页里「= true 之后、finally 之前」的裸 return。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const pending = [];

/* 支持异步用例：把 promise 收集起来，最后统一等待 */
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { pass++; console.log('PASS  ' + name); },
        (e) => { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
      ));
    } else {
      pass++; console.log('PASS  ' + name);
    }
  } catch (e) {
    fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message));
  }
}

/* ---------- 从 ui.js 抽出**真实** guard 实现（不复刻逻辑） ---------- */
function loadGuard() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
  const start = src.indexOf('function guard(');
  if (start === -1) throw new Error('ui.js 里找不到 guard()');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const impl = src.slice(start, i + 1);
  /* guard 内部会用到 console.warn，注入一个即可 */
  return new Function('console', impl + '\nreturn guard;')(console);
}

const guard = loadGuard();

/* ---------- 1. 行为 ---------- */
t('guard 在提前 return 后仍可再次调用（原来卡死的就是这条路径）', async () => {
  let entered = 0;
  const g = guard(async () => {
    entered++;
    if (entered === 1) return;   // 「没选文件」这类早退
    return 'ok';
  });
  await g();
  const r = await g();
  assert.strictEqual(entered, 2, '第二次调用没能进入 —— 标志没复位（正是原 bug）');
  assert.strictEqual(r, 'ok');
});

t('guard 在抛异常后仍可再次调用', async () => {
  let entered = 0;
  const g = guard(async () => {
    entered++;
    if (entered === 1) throw new Error('模拟失败');
    return 'ok';
  });
  await assert.rejects(g, /模拟失败/);
  const r = await g();
  assert.strictEqual(entered, 2, '抛异常后没能再进来');
  assert.strictEqual(r, 'ok');
});

t('guard 在真正并发时挡住第二次（防重入本身有效）', async () => {
  let entered = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const g = guard(async () => { entered++; await gate; });
  const p1 = g();
  const p2 = g();          // busy=true，应直接返回
  release();
  await Promise.all([p1, p2]);
  assert.strictEqual(entered, 1, '并发时第二次也进来了 —— 防重入失效');
});

t('guard 的 before/after 在任何出口都会成对执行', async () => {
  const log = [];
  const g = guard(async () => { log.push('body'); throw new Error('x'); }, {
    before: () => log.push('before'),
    after: () => log.push('after'),
  });
  await assert.rejects(g);
  assert.deepStrictEqual(log, ['before', 'body', 'after']);
});

t('对照：手写标志的旧写法确实会卡死（证明这个测试有意义）', async () => {
  let running = false;
  async function oldWay(hasFile) {
    if (running) return;
    running = true;
    if (!hasFile) return;        // 忘记了 running = false
    running = false;
  }
  await oldWay(false);
  // 再调一次：running 仍是 true，直接 return —— 永远进不来
  let secondRan = false;
  const g2 = async () => { if (running) return; running = true; secondRan = true; };
  await g2();
  assert.strictEqual(secondRan, false, '旧写法居然没卡住，本测试失去意义');
  assert.strictEqual(running, true, '旧写法应当把标志卡在 true');
});

/* ---------- 2. 静态 ---------- */
t('工具页里没有「running = true 后、finally 之前」的裸 return', () => {
  const FILES = ['js/tools/file-tools.js', 'js/tools/media.js', 'js/tools/office.js'];
  const offenders = [];

  for (const rel of FILES) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/running\s*=\s*true/.test(lines[i])) continue;
      let tryAt = -1, finallyAt = -1;
      for (let j = i; j < Math.min(lines.length, i + 60); j++) {
        if (tryAt === -1 && /\btry\s*\{/.test(lines[j])) tryAt = j;
        if (/\bfinally\b/.test(lines[j])) { finallyAt = j; break; }
      }
      if (tryAt === -1 || finallyAt === -1) continue; // 非 try/finally 结构，交给 guard 管

      /* 只检查**业务主体的顶层 return**，不看事件回调/内层函数。
       * `if (!/^avc\d+$/.test(jid)) return;` 这类在 job:stream 回调里，
       * 它既不该也不能去置 running —— 标志由外层 run() 的 finally 复位。
       *
       * 判据：从 return 行向上找最近的函数边界。若最近的边界是
       * `function run(` / `async function run(`（即我们关心的那个主体），
       * 才算这一层该负责；若中间隔了 `=>` / `function (` 之类，
       * 说明它在嵌套回调里，跳过。 */
      for (let j = i + 1; j < finallyAt; j++) {
        const l = lines[j];
        if (/catch\s*\(/.test(l)) break;
        if (!/\breturn\b/.test(l)) continue;
        if (/running\s*=\s*false/.test(l)) continue;

        // 向上找最近的函数边界
        let boundary = null;
        for (let k = j; k >= Math.max(0, i - 5); k--) {
          const L = lines[k];
          if (/\bfunction\s+run\s*\(/.test(L)) { boundary = 'run'; break; }
          if (/\b(?:function\s*\(|\w+\s*=\s*(?:async\s*)?\(|\w+\s*=>|\bfunction\s+\w+)/.test(L)
              && !/\bfunction\s+run\s*\(/.test(L)) { boundary = 'inner'; break; }
        }
        if (boundary !== 'run') continue;   // 在嵌套回调里，不归这一层
        offenders.push(`${rel}:${j + 1}  ${l.trim().slice(0, 100)}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    '这些早退没复位 running（会让按钮永久卡死）：\n  ' + offenders.join('\n  '));
});

/* ---------- 3. 报告点名的位置都必须已修 ---------- */
t('两个未装 FFmpeg 的早退都会复位', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'tools', 'media.js'), 'utf8');
  const hits = (src.match(/if \(!st\.ffmpeg\) \{ running = false; toast\('未安装 FFmpeg'/g) || []).length;
  assert.ok(hits >= 2, '应有两处（视频截帧 + 音频剪辑），实际 ' + hits);
});

t('图片查重「没选文件夹」会复位', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'tools', 'media.js'), 'utf8');
  assert.ok(/if \(!dir\) \{ running = false; return toast\('请先选择文件夹'/.test(src),
    '图片查重的早退没复位');
});

t('办公转换「非 PDF 转 DOCX」会复位', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'tools', 'office.js'), 'utf8');
  assert.ok(/picker\.paths\.some\(f => !f\.toLowerCase\(\)\.endsWith\('\.pdf'\)\)\) \{ running = false; return toast\('转 DOCX/.test(src),
    '办公转换的早退没复位');
});

t('file-tools 加密/解密已收口到 guard', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'tools', 'file-tools.js'), 'utf8');
  assert.ok(/const runGuarded = guard\(run\)/.test(src), '没有用 guard 收口');
  assert.ok(!/let running = false/.test(src), '还留着裸 running 标志');
  assert.ok(/btn\('开始加密', 'btn-primary', \(\) => runGuarded\(\)\)/.test(src), '按钮没接到 guard 版本');
});

t('guard 已导出给所有工具用', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
  assert.ok(/window\.ui = \{[\s\S]*?\bguard\b[\s\S]*?\};/.test(ui), 'window.ui 没有导出 guard');
  assert.ok(/Object\.assign\(window, \{[\s\S]*?\bguard\b/.test(ui), '全局兜底没带上 guard');
});

/* 等所有异步用例结束 */
Promise.all(pending).then(() => {
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
});
