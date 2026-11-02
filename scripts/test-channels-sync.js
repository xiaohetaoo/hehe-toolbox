'use strict';
/* 校验「渲染层通道表」与「主进程通道表」是否一致（任务 6）。
 *
 * 【为什么必须校验，而且比 job 前缀那套更严】
 * 通道名拼错的表现是运行时「调用失败：No handler registered」——
 * 而现有的 test-ipc-channels 是**扫源码文本**做差集的：
 * 如果主进程和渲染层错成同一个字符串，它就查不出来（两边"一致"地错）。
 *
 * 所以这里：
 *   1) 比**键集合**（少一个键说明某个通道没登记）；
 *   2) 比**每个键对应的值**（值不同 = 渲染层调用的不是主进程注册的那个名字）；
 *   3) 比表里的每个通道名**确实在主进程里注册了**（防"登记了但没人实现"）。
 *
 * 做法参照 test-job-prefix-sync.js：两边都是 IIFE/CommonJS，不便互相 require，
 * 所以直接读源码解析。lib 那份用 require（它是纯 CommonJS），
 * 渲染层那份用 Function 求值（它是 IIFE，挂在 window 上）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, readMain, readSrc } = require('./lib/harness');
const ROOT = path.resolve(__dirname, '..');

/* 主进程表：直接 require（lib/channels.js 是纯 CommonJS，无 DOM 依赖） */
function libChannels() {
  return require('../lib/channels');
}

/* 渲染层表：在最小 window 桩里求值 IIFE */
function rendererChannels() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'channels.js'), 'utf8');
  const fakeWindow = {};
  const fn = new Function('window', src + '\nreturn window.Channels;');
  return fn(fakeWindow);
}

t('6a 两份通道表的键集合完全一致', () => {
  const lib = libChannels().flatten();
  const rd = rendererChannels().flatten();
  assert.deepStrictEqual(Object.keys(rd).sort(), Object.keys(lib).sort(),
    '键集合不一致\n渲染层: ' + Object.keys(rd).sort().join(',') +
    '\n主进程: ' + Object.keys(lib).sort().join(','));
});

t('6b 每个键对应的通道名逐字相同（值不同 = 调的不是同一个通道）', () => {
  const lib = libChannels().flatten();
  const rd = rendererChannels().flatten();
  const diff = [];
  for (const k of Object.keys(lib)) {
    if (rd[k] !== lib[k]) diff.push(k + ': 主进程=' + lib[k] + ' 渲染层=' + rd[k]);
  }
  assert.deepStrictEqual(diff, [],
    '同一个语义键在两份表里指向不同通道名：\n  ' + diff.join('\n  '));
});

t('6c 表里的每个通道都真的在主进程里注册了', () => {
  /* 【这条比"两份表一致"更硬】
   * 两份表可能"一致地错"——都登记了一个并不存在的通道名，
   * 那时 6a/6b 都过，但运行时一定「No handler registered」。
   * 所以必须拿真实的注册清单做交叉验证。
   *
   * 【注意注册形态有四种】迁移到常量之后写的是
   *   handle(dirMoveCh.DIR_MOVE.MOVE, ...)
   * 而不是 handle('dir:move', ...) —— 所以不能只扫字面量。
   * 任务 5 又把这两个域搬到了 ipc/acl-links.js，那里的常量别名是 CH：
   *   handle(CH.ACL_LINKS.LINK_REMOVE, ...)
   * 而且**代码已经不在 main.js 里** —— 只读 main.js 的话这 8 个通道会
   * 全部报「没有对应注册」（本轮真的报过一次）。所以读「主进程全部源码」：
   * main.js 在前，ipc/ 下的文件按文件名排序在后。
   * 这里把三种形态都还原成通道名：
   *   · 字面量 'xxx'        → 直接取值
   *   · dirMoveCh.<组>.<键> → 用 lib/channels.js 的同一份表查出来
   *   · CH.<组>.<键>        → 同上（ipc/acl-links.js 的别名） */
  /* 【先剥注释再扫】注释里写着 `handle(CH.X.Y, ...)` 这种占位说明，
   * 不剥的话正则会把 `CH.X.Y` 当成真实注册，还原出一个不存在的键 `X.Y`，
   * 于是「用了表里不存在的常量键」这条会误报 —— 本轮真的踩了一次。
   * 这正是 harness 顶部说的「注释不是代码」。 */
  const mainSrc = require(path.join(ROOT, 'lib', 'src-scan')).stripComments(readMain({ raw: true }));
  const lib = libChannels().flatten();

  const registered = new Set();
  /* 1) 字面量注册 */
  const LITERAL = /handle\('([^']+)'/g;
  for (const m of mainSrc.matchAll(LITERAL)) registered.add(m[1]);
  /* 2) 常量注册：<别名>.<组>.<键>（后面跟逗号，不能把逗号写进正则的 ')'） */
  const CONST = /handle\((?:dirMoveCh|CH)\.([A-Z_]+)\.([A-Z_]+)\s*,/g;
  for (const m of mainSrc.matchAll(CONST)) {
    const key = m[1] + '.' + m[2];
    if (lib[key]) registered.add(lib[key]);
    else registered.add('(未登记常量: ' + key + ')');
  }

  const missing = Object.entries(lib).filter(([, ch]) => !registered.has(ch))
    .map(([k, ch]) => k + ' → ' + ch);
  assert.deepStrictEqual(missing, [],
    '这些通道登记在 channels.js 里，但主进程没有对应注册：\n  ' + missing.join('\n  '));

  /* 顺带：不许出现"常量名对不上表"的写法 */
  const bogus = [...registered].filter((x) => x.startsWith('(未登记常量'));
  assert.deepStrictEqual(bogus, [], '主进程用了表里不存在的常量键：' + bogus.join(', '));
});


t('6d 表里的通道名格式合法（域:动作，且不含空格/大写）', () => {
  const lib = libChannels().flatten();
  const bad = [];
  for (const [k, ch] of Object.entries(lib)) {
    if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*[a-z0-9]$/.test(ch)) bad.push(k + ' → ' + ch);
  }
  assert.deepStrictEqual(bad, [], '通道名格式异常（应为 域:动作，全小写）：\n  ' + bad.join('\n  '));
});

t('6e index.html 在 ui.js 之前引入了 channels.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('js/channels.js'), 'index.html 未引入 js/channels.js');
  const iCh = html.indexOf('js/channels.js');
  const iUi = html.indexOf('js/ui.js');
  assert.ok(iCh < iUi, 'channels.js 应在 ui.js 之前加载（工具文件定义时就要用）');
});

/* ============================================================
 * 防倒退：分域迁移不许停在原地
 *
 * 【为什么需要这两条】
 * lib/channels.js 头部写了分域推进策略（本轮只迁 dir: / acl: / link: /
 * file:who-locks 两个域，其余列 TODO 按域列了清单），机制本身是对的。
 * 风险在于：**新增通道继续用字面量，TODO 就永远推不完**。
 * 而 6a~6e 只校验「表里的条目」，完全不看「表外的通道」——
 * 也就是说，哪怕 TODO 从 164 涨到 200，测试也一条都不会红。
 *
 * 所以补两条：
 *   6f  未迁移数与 lib/channels.js 的 MIGRATION 声明比对（TODO 必须随迁移更新）
 *   6g  已在表内的通道，渲染层不许再写字面量调用
 * ============================================================ */

/* 把主进程（main.js + ipc/）实际注册的通道名全部还原出来。
 * 与 6c 用同一套识别规则，但这里要的是**完整清单**而不是差集，
 * 所以单独抽一个函数（6c 那边是内联的，改动它风险更大）。 */
function registeredChannels() {
  const st = require(path.join(ROOT, 'lib', 'src-scan'));
  const mainSrc = st.stripComments(readMain({ raw: true }));
  const lib = libChannels().flatten();
  const set = new Set();
  for (const m of mainSrc.matchAll(/handle\('([^']+)'/g)) set.add(m[1]);
  for (const m of mainSrc.matchAll(/handle\((?:dirMoveCh|CH)\.([A-Z_]+)\.([A-Z_]+)\s*,/g)) {
    const key = m[1] + '.' + m[2];
    if (lib[key]) set.add(lib[key]);
  }
  return set;
}

t('6f 未迁移通道数与 lib/channels.js 的 MIGRATION 声明一致（TODO 必须随迁移更新）', () => {
  const { MIGRATION } = libChannels();
  assert.ok(MIGRATION && typeof MIGRATION === 'object', 'lib/channels.js 应导出 MIGRATION');

  const flat = libChannels().flatten();
  const tableNames = Object.values(flat);
  const registered = registeredChannels();

  /* 表内条目数就是「已迁移」的通道数（每条都已换成常量引用）。
   * 用实际条目数而不是 MIGRATION.MIGRATED 去比注册总数，
   * 是为了让下面两条断言各自指向不同的失效原因。 */
  const tableCount = tableNames.length;
  const total = registered.size;
  const unmigrated = total - tableCount;

  /* 断言 1：表条目数 = 声明的已迁移数。
   * 失败含义：往表里加/删了常量，但没同步 MIGRATION.MIGRATED。 */
  assert.strictEqual(tableCount, MIGRATION.MIGRATED,
    '常量表里有 ' + tableCount + ' 条，但 lib/channels.js 的 MIGRATION.MIGRATED 写着 '
    + MIGRATION.MIGRATED + '。迁移了一个域就同步改这里。');

  /* 断言 2：总数 = 声明的总数。
   * 失败含义：新增/删除了通道，但没更新 MIGRATION.TOTAL。 */
  assert.strictEqual(total, MIGRATION.TOTAL,
    '主进程实际注册 ' + total + ' 个通道，但 lib/channels.js 的 MIGRATION.TOTAL 写着 '
    + MIGRATION.TOTAL + '。新增通道时同步改这里（这个总数的意义是「TODO 的分母」）。');

  /* 断言 3：未迁移数 = 总数 - 已迁移。
   * 这一条是恒等式，但它把数字打印出来，让每次跑测试都能看到进度。
   * 真正的防护是上面两条 —— 它们强制 TODO 与事实对齐。 */
  assert.strictEqual(unmigrated, MIGRATION.TOTAL - MIGRATION.MIGRATED,
    '未迁移数算出来是 ' + unmigrated + '，与声明不符');
  console.log('  已迁移 ' + tableCount + '/' + total + '，未迁移 ' + unmigrated + ' 条');
});

t('6g 表内通道不许在渲染层用字面量调用（迁移做了一半会静默失去保护）', () => {
  /* 【这条防的是什么】
   * 「表建好了，但一半代码还在用字符串」是最隐蔽的半成品状态：
   * 6c 只检查「表里的通道在主进程注册了」，6d 只检查格式，
   * 没有任何一条能发现「渲染层明明有常量却还在写 invoke('dir:move')」。
   * 那种状态下，常量表看起来在生效，实际上一改通道名，走字面量那半
   * 会静默失效（运行时「No handler registered」），而测试全绿。
   *
   * 只查**表内**的通道：表外的 156 条本来就还是字面量，那是下一轮的事。 */
  const flat = libChannels().flatten();
  const tableNames = new Set(Object.values(flat));

  /* 渲染层文件清单：js/ 下全部 .js（含 tools/ 与 auxwin/ 子目录）。 */
  const jsRoot = path.join(ROOT, 'js');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  }(jsRoot));

  const offenders = [];
  for (const f of files) {
    /* channels.js 本身是常量定义处，当然会出现这些字符串。 */
    if (path.basename(f) === 'channels.js') continue;
    const rel = String(path.relative(ROOT, f)).split(path.sep).join('/');
    const code = readSrc(rel);
    code.split('\n').forEach((line, i) => {
      /* 找 invoke('xxx' / send('xxx' / 任意 *Send('xxx' 里的字面量 */
      for (const m of line.matchAll(/\(\s*'([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)'\s*[,)]/g)) {
        if (tableNames.has(m[1])) offenders.push(rel + ':' + (i + 1) + '  ' + m[1]);
      }
    });
  }
  assert.deepStrictEqual(offenders, [],
    '这些位置用的通道已经在常量表里了，应改成 Channels.XXX.YYY 常量引用'
    + '（否则改通道名时这里不会跟着变，运行时才炸）：\n  ' + offenders.join('\n  '));
});

done();
