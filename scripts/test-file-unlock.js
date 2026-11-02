'use strict';
/* file-unlock 工具的行为测试（原 test-round12-fixes.js 的 ②③ 迁移而来）。
 *
 * ============ 这一组锁的是三件事 ============
 * ② **一个条目失败就丢全部结果**
 *    scanOnce 原来写 `const results = await Promise.all(tasks)`。Promise.all
 *    是「任一 reject 即整体 reject」，于是 19 条查成功的条目会随着第 20 条
 *    的失败一起消失，界面报错、用户拿不到任何有用信息。而失败在这个工具里
 *    是**常态**（权限不足的目录、已退出的进程都查不到），不是异常。
 *
 * ③ **查询期间选择变了，目录就被送进文件通道**
 *    resolveTypes 要 await（标类型），而这段时间用户可能重新拖选了文件。
 *    原来按 `state.items[i]` 取下标，下标一错位，目录类型的条目就被送进了
 *    `file:who-locks`（单文件通道）。Restart Manager 对目录返回
 *    ERR 5 且**整批失败**，于是这一批里所有正常文件的占用信息也一起没了
 *    （见 docs/decisions/restart-manager-rejects-directories.md）。
 *    修法是：扫描开始就做快照，先比对「选择是否变了」，变了就提示重扫。
 */

const assert = require('assert');

const { t, done, readSrc } = require('./lib/harness');
const stripComments = require('../lib/src-scan').stripComments;

/* 用 readSrc 而不是自建 read 助手：它会剥注释，而源码断言必须在没有注释
 * 干扰的文本上做（否则注释里引用的代码片段会被当成命中）。 */
function read(rel) { return readSrc(rel, { raw: true }); }

/* ================= ② 逐条 settled ================= */

t('一个条目失败不丢其余结果（不再用 Promise.all 直接等结果）', () => {
  const src = read('js/tools/file-unlock.js');
  const code = stripComments(src);
  /* 锁的是：Promise.all 让一条失败吞掉其余全部结果（见本文件头 ②）。\n   * 行为断言在下面那条「19 成功 + 1 失败」里，这条只补"形态确实改成了逐条 settled"。 */
  assert.ok(!/const results = await Promise\.all\(tasks\)/.test(code),
    '仍在对 tasks 直接 Promise.all —— 任何一条 reject 会丢掉全部结果');
  assert.ok(/\.then\(\s*\(r\) => \(\{ ok: true, r \}\)/.test(code)
    || /Promise\.allSettled/.test(code),
    '应逐条 settled（.then(ok/err) 或 allSettled）');
  assert.ok(/个条目查询失败/.test(src), '应把失败条目单独汇总进 notes');
});

t('行为：19 条成功 + 1 条失败 → 19 条结果保留、失败单独记', async () => {
  /* 跑的是与源码同构的归并逻辑（源码里那段在闭包里，抽不出来跑）。 */
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

t('扫描开始就做快照，resolveTypes 只作用于快照', () => {
  const code = stripComments(read('js/tools/file-unlock.js'));
  /* 锁的是：resolveTypes 的 await 期间用户重选了文件，按下标取 state.items 会错位，\n   * 把目录送进 file:who-locks（单文件通道）→ Restart Manager 整批 ERR 5\n   * （见 docs/decisions/restart-manager-rejects-directories.md）。\n   * 行为断言在下面「stat 期间换选择」那条里；这几条锁的是必须用快照这件事。 */
  assert.ok(/const snapshot = state\.items\.slice\(\)/.test(code), '没有做条目快照');
  assert.ok(/await resolveTypes\(snapshot\)/.test(code), 'resolveTypes 应作用于快照');
  assert.ok(/taskItems\.push\(it\)/.test(code), '结果归并应基于与任务一一对应的数组');
  assert.ok(!/const src = state\.items\[i\]/.test(code), '仍按下标从 state.items 取（会错位）');
  /* 【不要用带换行/缩进的正则去匹配「代码长什么样」】
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

t('行为：stat 期间换选择 → 不会把目录送进文件通道', async () => {
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

done();
