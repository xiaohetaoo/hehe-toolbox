const fs = require('fs');
const p = 'scripts/test-file-unlock.js';
let s = fs.readFileSync(p, 'utf8');

/* 1) 用 readSrc 代替自建 read（readSrc 会剥注释） */
s = s.replace(
  "const { t, done } = require('./lib/harness');",
  "const { t, done, readSrc } = require('./lib/harness');");
s = s.replace(
  "const ROOT = path.join(__dirname, '..');\nfunction read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }",
  "/* 用 readSrc 而不是自建 read 助手：它会剥注释，而源码断言必须在没有注释\n"
  + " * 干扰的文本上做（否则注释里引用的代码片段会被当成命中）。 */\n"
  + "function read(rel) { return readSrc(rel, { raw: true }); }");

/* 2) 给每条源码匹配断言补「锁的是」说明（按用例分组，每条都写明确，
 *    不是套一句万金油的废话）。 */
const PATCHES = [
  {
    anchor: "  assert.ok(!/const results = await Promise\\.all\\(tasks\\)/.test(code),",
    note: [
      '  /* 锁的是：scanOnce 用 `Promise.all(tasks)` 时，第 20 条查询失败会让',
      '   * 前 19 条的成功结果一起消失。而"查不到"在这个工具里是常态（权限不足',
      '   * 的目录、已退出的进程都查不到），不是异常。',
      '   * 为什么不能用行为断言：这段归并逻辑在闭包里，依赖真实 RM 与真实窗口，',
      '   * 单测拿不到；只能断言形态。但下面那条「19 成功 + 1 失败」用等价实现',
      '   * 把**行为**也锁了一遍。 */',
    ].join('\n') + '\n',
  },
  {
    anchor: '  assert.ok(/个条目查询失败/.test(src), ' + "'应把失败条目单独汇总进 notes');" + '\n' + '});',
    note: '',
  },
];

/* ② 组的整段注释已写在文件头，这里给每条断言行上方插入简短引用 */
const GROUPS = [
  {
    // ② 三条
    lines: [
      "  assert.ok(!/const results = await Promise\\.all\\(tasks\\)/.test(code),",
      "  assert.ok(/\\.then\\(\\s*\\(r\\) => \\(\\{ ok: true, r \\}\\)/.test(code)",
      "  assert.ok(/个条目查询失败/.test(src), '应把失败条目单独汇总进 notes');",
    ],
    note: '  /* 锁的是：Promise.all 让一条失败吞掉其余全部结果（见本文件头 ②）。\\n'
      + '   * 行为断言在下面那条「19 成功 + 1 失败」里，这条只补"形态确实改成了逐条 settled"。 */',
  },
  {
    // ③ 六条
    lines: [
      "  assert.ok(/const snapshot = state\\.items\\.slice\\(\\)/.test(code), '没有做条目快照');",
      "  assert.ok(/await resolveTypes\\(snapshot\\)/.test(code), 'resolveTypes 应作用于快照');",
      "  assert.ok(/taskItems\\.push\\(it\\)/.test(code), '结果归并应基于与任务一一对应的数组');",
      "  assert.ok(!/const src = state\\.items\\[i\\]/.test(code), '仍按下标从 state.items 取（会错位）');",
      "  assert.ok(/skipped\\.push\\(\\s*it\\s*\\)/.test(win),",
      "  assert.ok(/选择在查询过程中发生了变化/.test(code), '选择变了应提示重扫');",
    ],
    note: '  /* 锁的是：resolveTypes 的 await 期间用户重选了文件，按下标取 state.items 会错位，\\n'
      + '   * 把目录送进 file:who-locks（单文件通道）→ Restart Manager 整批 ERR 5\\n'
      + '   * （见 docs/decisions/restart-manager-rejects-directories.md）。\\n'
      + '   * 行为断言在下面「stat 期间换选择」那条里；这几条锁的是必须用快照这件事。 */',
  },
];

for (const g of GROUPS) {
  const first = g.lines[0];
  const i = s.indexOf(first);
  if (i < 0) { console.log('SKIP 找不到锚点: ' + first.slice(0, 50)); continue; }
  /* 往上找到该行所在的行首，插入注释 */
  const lineStart = s.lastIndexOf('\n', i) + 1;
  s = s.slice(0, lineStart) + g.note + '\n' + s.slice(lineStart);
  console.log('OK 已插入注释: ' + first.slice(0, 50));
}

fs.writeFileSync(p, s, 'utf8');
console.log('完成');
