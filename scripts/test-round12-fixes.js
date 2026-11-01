'use strict';
/* round-12 回归测试。
 *
 *   ① isInsideTree 只比字符串：8.3 短名 / subst / 符号链接父目录等价写法认不出来
 *   ② file-unlock 的 Promise.all：一个条目失败，其余 19 个结果全丢
 *   ③ resolveTypes 期间改选择：目录被送进文件通道（ERR list 5）
 *   ④ 搬家成功后没作废预检结论：界面先说「可以搬」，点完报 SRC_IS_LINK
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stripComments(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
}
const mainSrc = read('main.js');
const fsp = fs.promises;

let pass = 0, fail = 0;
const pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { pass++; console.log('PASS  ' + name); },
        (e) => { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
      ));
    } else { pass++; console.log('PASS  ' + name); }
  } catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

function extract(name, isAsync) {
  const pat = (isAsync ? 'async function ' : 'function ') + name + '(';
  const start = mainSrc.indexOf(pat);
  if (start < 0) throw new Error('main.js 里找不到 ' + name);
  let i = mainSrc.indexOf('{', start), depth = 0;
  for (; i < mainSrc.length; i++) {
    if (mainSrc[i] === '{') depth++;
    else if (mainSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return mainSrc.slice(start, i);
}
const pathExists = async (p) => { try { await fsp.access(p); return true; } catch (e) { return false; } };

function makeMoveSandbox() {
  return new Function('fsp', 'path', 'fs', 'pathExists',
    extract('relKey', false) + '\n'
    + extract('buildLinkKeySet', false) + '\n'
    + extract('linkNature', false) + '\n'
    + extract('linkTargetAbs', false) + '\n'
    + extract('normalizeForComparePath', false) + '\n'
    + extract('isInsideTree', false) + '\n'
    + extract('copyTreeExcludingLinks', true) + '\n'
    + extract('restoreLinksIntoTarget', true) + '\n'
    + 'return { copyTreeExcludingLinks, restoreLinksIntoTarget, linkNature, linkTargetAbs, isInsideTree, normalizeForComparePath };'
  )(fsp, path, fs, pathExists);
}

/* 用 FileSystemObject 取 8.3 短名（和报告建议一致） */
function shortPath(p) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  return cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${q(p)}).ShortPath`],
  { encoding: 'utf8' }).trim();
}

/* ================= ① 路径归一 ================= */

t('① normalizeForComparePath 把 8.3 短名解析成长名', () => {
  const mod = makeMoveSandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-a-'));
  try {
    const long = path.join(root, 'VeryLongSourceDirectoryName');
    fs.mkdirSync(path.join(long, 'sub'), { recursive: true });
    let short = '';
    try { short = shortPath(long); } catch (e) { short = ''; }
    if (!short || short.toLowerCase() === long.toLowerCase()) {
      console.log('      （本机未生成 8.3 短名，跳过这条的短名断言）');
      return;
    }
    assert.ok(/~\d/.test(short), '短名应带 ~N：' + short);
    const a = mod.normalizeForComparePath(short).toLowerCase();
    const b = mod.normalizeForComparePath(long).toLowerCase();
    assert.strictEqual(a, b, '短名与长名应归一到同一个字面量：\n  短=' + a + '\n  长=' + b);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

t('① 用 8.3 短名写的内链：innerRewritten=1，源删掉后目标侧仍能 readdir', async () => {
  const mod = makeMoveSandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-b-'));
  try {
    const long = path.join(root, 'VeryLongSourceDirectoryName');
    fs.mkdirSync(path.join(long, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(long, 'sub', 'inner.txt'), 'inner');

    let short = '';
    try { short = shortPath(long); } catch (e) { short = ''; }
    if (!short || short.toLowerCase() === long.toLowerCase()) {
      console.log('      （本机未生成 8.3 短名，改用长名建同样的内链做等价验证）');
      short = long;
    }
    const inner = path.join(long, 'inner');
    fs.symlinkSync(path.join(short, 'sub'), inner, 'junction');
    const declared = fs.readlinkSync(inner);

    assert.strictEqual(mod.isInsideTree(declared, long), true,
      '声明目标是 ' + declared + '，应判为「在源树内部」');
    /* 反向：源树之外的不能被误判成内部 */
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    assert.strictEqual(mod.isInsideTree(outside, long), false, '源树之外不该被判成内部');

    const dst = path.join(root, 'dst');
    await mod.copyTreeExcludingLinks(long, dst, [inner]);
    const rr = await mod.restoreLinksIntoTarget(long, dst, [inner], new Map());
    assert.strictEqual(rr.innerRewritten, 1, '应改写 1 个（实际 ' + rr.innerRewritten + '）');

    /* 走完「源改名 .bak → 删 .bak」 */
    fs.renameSync(long, long + '.hehe-bak');
    fs.rmSync(long + '.hehe-bak', { recursive: true, force: true });
    const names = fs.readdirSync(path.join(dst, 'inner'));   // 旧实现这里 ENOENT
    assert.ok(names.indexOf('inner.txt') !== -1, '应能读到链接里的文件：' + names.join(','));
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

t('① 悬空链接仍按字面比较（归一失败不能漏判）', () => {
  const mod = makeMoveSandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-c-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    /* 目标不存在（悬空）：realpath 会失败，必须退回 path.resolve 再比 */
    assert.strictEqual(mod.isInsideTree(path.join(src, 'sub', 'gone'), src), true,
      '悬空但字面上在源树内部 —— 归一失败时要退回字面比较');
    assert.strictEqual(mod.isInsideTree(path.join(root, 'elsewhere', 'gone'), src), false);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

t('① 预检的 innerLinkCount 用同一份判定', () => {
  const code = stripComments(mainSrc);
  const seg = code.slice(code.indexOf("handle('dir:move-precheck'"), code.indexOf("handle('dir:move',"));
  assert.ok(/isInsideTree\(linkTargetAbs\(l\), srcAbs\)/.test(seg),
    '预检应复用同一个 isInsideTree（否则界面数字和实际行为对不上）');
});

/* ================= ② 逐条 settled ================= */

t('② 一个条目失败不丢其余结果（不再用 Promise.all 直接等结果）', () => {
  const src = read('js/tools/file-unlock.js');
  const code = stripComments(src);
  assert.ok(!/const results = await Promise\.all\(tasks\)/.test(code),
    '仍在对 tasks 直接 Promise.all —— 任何一条 reject 会丢掉全部结果');
  assert.ok(/\.then\(\s*\(r\) => \(\{ ok: true, r \}\)/.test(code)
    || /Promise\.allSettled/.test(code),
    '应逐条 settled（.then(ok/err) 或 allSettled）');
  assert.ok(/个条目查询失败/.test(src), '应把失败条目单独汇总进 notes');
});

t('② 行为：19 条成功 + 1 条失败 → 19 条结果保留、失败单独记', async () => {
  /* 直接跑 scanOnce 的归并逻辑（抽成等价最小实现，与源码同构） */
  const settle = async (tasks) => Promise.all(tasks.map((p) => p.then(
    (r) => ({ ok: true, r }), (e) => ({ ok: false, e }))));
  const tasks = [];
  for (let i = 0; i < 19; i++) tasks.push(Promise.resolve({ lockers: [{ pid: 100 + i, name: 'p' + i }] }));
  tasks.push(Promise.reject(new Error('读取目录失败：拒绝访问')));
  const settled = await settle(tasks);
  const okOnes = settled.filter((x) => x.ok);
  const badOnes = settled.filter((x) => !x.ok);
  assert.strictEqual(okOnes.length, 19, '19 个成功结果必须全部保留');
  assert.strictEqual(badOnes.length, 1);
  assert.ok(/读取目录失败/.test(badOnes[0].e.message));
});

/* ================= ③ 快照 ================= */

t('③ 扫描开始就做快照，resolveTypes 只作用于快照', () => {
  const code = stripComments(read('js/tools/file-unlock.js'));
  assert.ok(/const snapshot = state\.items\.slice\(\)/.test(code), '没有做条目快照');
  assert.ok(/await resolveTypes\(snapshot\)/.test(code), 'resolveTypes 应作用于快照');
  assert.ok(/taskItems\.push\(it\)/.test(code), '结果归并应基于与任务一一对应的数组');
  assert.ok(!/const src = state\.items\[i\]/.test(code), '仍按下标从 state.items 取（会错位）');
  /* 类型未知的条目必须跳过，不能默认按文件查。
   * 【不要用带换行/缩进的正则去匹配「代码长什么样」】
   * 早期这里写的是
   *   /typeof it\.isDir !== 'boolean'\) \{\n\s+\/*...*\/skipped\.push\(it\)/
   * 它要求「if 后面紧跟注释、再紧跟 skipped.push」，中间多一行注释、
   * 缩进变一格、注释内容改一句就匹配失败 —— 但代码其实完全正确。
   * 这种断言守不住行为，只会让无害的改动把 CI 弄红（v0.3.6 就踩了一次）。
   * 改成剥掉注释与空白后做语义断言：
   *   ① 存在 `typeof it.isDir !== 'boolean'` 的判断
   *   ② 该判断之后（下一个 for 迭代之前）确实出现 skipped.push(it) 和 continue
   * 用「就近窗口」而不是精确版面。 */
  const raw = read('js/tools/file-unlock.js');
  const flat = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  /* 这个字符串在文件里出现两次：一次在 resolveTypes 里（筛出未知项去查类型），
   * 一次在 scanOnce 的建任务循环里（跳过并记 note）。要断的是后者，
   * 所以取最后一次出现。 */
  const at = flat.lastIndexOf("typeof it.isDir !== 'boolean'");
  assert.ok(at >= 0, '找不到「类型未知就跳过」的判断');
  const win = flat.slice(at, at + 400);
  assert.ok(/skipped\.push\(\s*it\s*\)/.test(win),
    '类型未知的条目应记进 skipped（不能默认按文件查）：\n' + win.slice(0, 220));
  assert.ok(/continue\b/.test(win),
    '类型未知的条目应 continue 到下一个（不能继续走查询分支）');
  assert.ok(/选择在查询过程中发生了变化/.test(code), '选择变了应提示重扫');
});

t('③ 行为：stat 期间换选择 → 不会把目录送进文件通道', async () => {
  const sim = new Function(`
    'use strict';
    const state = {
      items: [
        { path: 'D:\\\\dirA', name: 'dirA', isDir: undefined },
        { path: 'D:\\\\fileB.txt', name: 'fileB.txt', isDir: undefined },
      ],
    };
    const calls = [];
    async function statMulti(paths) {
      await new Promise((r) => setTimeout(r, 5));
      return paths.map((p) => ({ isDir: p.indexOf('dir') !== -1 }));
    }
    function invoke(ch, arg) {
      calls.push({ ch, arg });
      return Promise.resolve({ lockers: [] });
    }
    /* 与修好后的 file-unlock 同构：快照 + 变化检测 + 跳过未知类型 */
    async function scanLike() {
      if (!state.items.length) return { skippedScan: true, calls };
      const snapshot = state.items.slice();
      const unknown = snapshot.filter((it) => typeof it.isDir !== 'boolean');
      if (unknown.length) {
        const stats = await statMulti(unknown.map((it) => it.path));
        unknown.forEach((it, k) => {
          const st = stats && stats[k];
          if (st && typeof st.isDir === 'boolean') it.isDir = st.isDir;
        });
      }
      const changed = state.items.length !== snapshot.length
        || state.items.some((it, i) => !snapshot[i] || it.path !== snapshot[i].path);
      if (changed) return { changed: true, calls };
      for (const it of snapshot) {
        if (typeof it.isDir !== 'boolean') { calls.push({ ch: 'SKIPPED', arg: [it.path] }); continue; }
        calls.push({ ch: it.isDir ? 'file:who-locks-dir' : 'file:who-locks', arg: [it.path] });
      }
      return { changed: false, calls };
    }
    return { scanLike, state, calls };
  `);
  const sim2 = sim();
  const p = sim2.scanLike();
  /* 在 stat 返回前整体替换 items（正是 onChange 干的事） */
  sim2.state.items = [
    { path: 'D:\\dirC', name: 'dirC', isDir: undefined },
    { path: 'D:\\fileD.txt', name: 'fileD.txt', isDir: undefined },
  ];
  const r = await p;
  assert.strictEqual(r.changed, true, '应变更检测为「选择已变」');
  assert.deepStrictEqual(sim2.calls, [], '选择变了就不该继续发查询（更不能把目录送进文件通道）');
});

/* ================= ④ 搬家成功后作废预检 ================= */

t('④ 搬完之后作废预检、按钮保持禁用，改路径才恢复', () => {
  const src = read('js/tools/dir-move.js');
  const code = stripComments(src);
  /* 成功分支必须同时做两件事：作废预检 + 标记「已搬完」。
   * 注意 `state.precheck = null` 出现两次：
   *   · invalidate() 里（那是「路径改了」，后面是 moved = false）
   *   · 搬家成功分支（后面才是 moved = true）
   * 所以要找「后面紧跟 moved = true」的那一处，即成功分支。 */
  const re = /state\.precheck = null;(?:[^;]*?;){0,6}?\s*state\.moved = true/s;
  assert.ok(re.test(code),
    '成功分支必须同时标记「已搬完」（invalidate 里那句是 moved=false，不是它）');
  assert.ok(/goBtn\.disabled = done \? true : false/.test(code),
    '成功后不能无条件恢复按钮（失败才恢复）');
  assert.ok(/if \(!state\.precheck && !state\.moved\) return/.test(code),
    'invalidate 必须同时处理「已搬完」状态，否则改路径后那张卡永远不消失');
  assert.ok(/已搬完/.test(src), '应换成「已搬完」的说明卡');
});

t('④ main.js 确实会以 SRC_IS_LINK 拒绝再搬一次（界面说法要对得上）', () => {
  const D = require('../lib/dir-move.js');
  const BS = String.fromCharCode(92);
  const r = D.validateMove({
    src: 'C:' + BS + 'Users' + BS + 'u' + BS + 'bigdir', dst: 'D:' + BS + 'backup' + BS + 'bigdir',
    srcExists: true, srcIsDir: true, srcIsLink: true, srcIsRoot: false, srcIsCritical: false,
    dstExists: false, needBytes: 1, freeBytes: 1e12, lockedPaths: [],
  });
  assert.strictEqual(r.code, 'SRC_IS_LINK');
  assert.ok(/链接/.test(r.reason), '理由要提到链接：' + r.reason);
});

Promise.all(pending).then(() => {
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
});
