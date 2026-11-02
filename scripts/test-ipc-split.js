'use strict';
const { t, done, ROOT } = require('./lib/harness');
/* 任务 5 拆分的完整性守卫。
 *
 * 这一轮把 1561 行从 main.js 搬到 ipc/dir-acl-links.js。下面每一条都对应一个
 * 真实会让拆分静默失效的断裂点 —— 它们在搬迁过程中全部实际踩过一遍，
 * 而且**没有一个**会被 node --check 或单纯跑测试抓到。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MAIN = path.join(ROOT, 'main.js');
const ACL = path.join(ROOT, 'ipc', 'dir-acl-links.js');
const CTX = path.join(ROOT, 'ipc', 'ctx.js');

const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => require(path.join(ROOT, 'lib', 'src-scan')).stripComments(s);

/* ---- 1. 行数下降（任务的硬指标） ---- */
t('main.js 行数确实下降了（拆分前 7722 行）', () => {
  const n = read(MAIN).split('\n').length;
  assert.ok(n < 7000, 'main.js 仍是 ' + n + ' 行 —— 拆分没生效，或搬出去的东西又被搬回来了');
  /* 【下限不能用硬编码的绝对行数】
   * 原实现是 `assert.ok(n > 5000, '…疑似误删…')`。这个下限离当时的 6213 行
   * 只有 1200 行余量，而这个文件自身的目的就是「main.js 瘦身」：
   * 再搬走两个域（就像任务 5 那样，一次 1500 行）就会掉到 4999，
   * CI 立刻报「疑似误删」，而实际上什么都没丢。
   *
   * 改成**是否还有实现留在 main.js** 的结构性判断：
   * 只要 main.js 里仍注册着大量 handler、仍有顶层函数定义，就不可能是误删。
   * 这比行数直接：真误删会把 handler 一起删掉，那种情况下面这条会红。
   * 上限（< 7000）保留 —— 它防的是「搬出去的东西又搬回来了」，那个方向是对的。
   *
   * 【阈值随搬迁调整的历史】
   *   任务 5 搬走 dir:/acl:/link: 两域（1561 行）后：handlers ≥100、topFns ≥80。
   *   任务 6 又搬走 ffmpeg:/target:/rec: 三个域（947 行，71 个 handler、
   *   11 个顶层函数）后：实测 handlers 85、topFns 79。
   * 所以阈值下调到 handlers ≥70、topFns ≥60。
   * 【这个下调不是"为了让测试变绿"】判据的含义没变 —— 仍然是「还有一大堆
   * handler 与顶层函数留在 main.js」。只是分母从 156 变成 85，
   * 按比例留出同样的余量（各约 15~20%），误删时照样会红。
   * 真正的保护区是下面第 2 条（搬走的函数不许留在 main.js 里）与
   * test-ipc-channels 的通道总数（164）—— 那两条与行数无关。 */
  const src = read(MAIN);
  /* 锁的是：「main.js 行数确实下降了（拆分前 7722 行）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  const handlers = (src.match(/^handle\(/gm) || []).length;
  /* 锁的是：「main.js 行数确实下降了（拆分前 7722 行）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  const topFns = (src.match(/^(?:async\s+)?function\s+\w+/gm) || []).length;
  assert.ok(handlers >= 70,
    'main.js 里只剩 ' + handlers + ' 个 handle() 注册 —— 疑似误删（正常还有 85+ 个 IPC 处理器）');
  assert.ok(topFns >= 60,
    'main.js 里只剩 ' + topFns + ' 个顶层函数 —— 疑似误删（正常还有 79+ 个）');
});

/* ---- 2. 搬走的代码不再留在 main.js（否则是两份实现，必然分叉） ---- */
t('搬走的 21 个函数在 main.js 里已经没有定义', () => {
  const code = strip(read(MAIN));
  const MOVED = [
    'rmQueryLockers', 'collectLinks', 'relKey', 'buildLinkKeySet',
    'copyTreeExcludingLinks', 'restoreLinksIntoTarget', 'linkTargetAbs',
    'normalizeForComparePath', 'isInsideTree', 'collectLockProbe', 'linkNature',
    'linkNatures', 'dirMoveRun', 'isRunningAsAdmin', 'readAclFacts', 'restoreBak',
    'verifyCopy', 'verifyInnerLinksReadable', 'verifyLinkReadable', 'readHeadBytes',
    'hashFile',
  ];
  const dup = [];
  for (const n of MOVED) {
  /* 锁的是：「搬走的 21 个函数在 main.js 里已经没有定义」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    if (new RegExp('(?:async\\s+)?function\\s+' + n + '\\s*\\(').test(code)) dup.push(n);
  }
  assert.deepStrictEqual(dup, [],
    '这些函数在 main.js 与 ipc/dir-acl-links.js 里各有一份（两份实现必然分叉）：\n  ' + dup.join('\n  '));
});

/* ---- 3. 两个域的 8 个通道全部搬到了模块里 ---- */
t('8 个通道的 handle 注册都在 ipc/dir-acl-links.js 里', () => {
  const acl = strip(read(ACL));
  const KEYS = [
    'DIR_MOVE.PRECHECK', 'DIR_MOVE.MOVE',
    'ACL_LINKS.ACL_DIAGNOSE', 'ACL_LINKS.ACL_REPAIR',
    'ACL_LINKS.LINK_SCAN', 'ACL_LINKS.LINK_REMOVE',
    'ACL_LINKS.WHO_LOCKS', 'ACL_LINKS.WHO_LOCKS_DIR',
  ];
  /* 锁的是：「8 个通道的 handle 注册都在 ipc/dir-acl-links.js 里」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  const missing = KEYS.filter((k) => !new RegExp('handle\\(dirMoveCh\\.' + k.replace('.', '\\.') + '\\s*,').test(acl));
  assert.deepStrictEqual(missing, [], '这些通道没搬过去（界面点了会「No handler registered」）：\n  ' + missing.join('\n  '));
  /* 而且 main.js 里不该再有它们 */
  const mainCode = strip(read(MAIN));
  /* 锁的是：「8 个通道的 handle 注册都在 ipc/dir-acl-links.js 里」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  const leftover = KEYS.filter((k) => mainCode.includes('handle(dirMoveCh.' + k));
  assert.deepStrictEqual(leftover, [], 'main.js 里还留着注册（重复注册会让应用启动即卡死）：' + leftover.join(', '));
});

/* ---- 4. main.js 里没有裸的 dirMoveCh 引用 ---- */
t('main.js 不再 require dirMoveCh（否则那个 require 是死代码）', () => {
  const code = strip(read(MAIN));
  /* 锁的是：「main.js 不再 require dirMoveCh（否则那个 require 是死代码）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/const dirMoveCh = require/.test(code),
    'main.js 顶部还 require 了 dirMoveCh，但它的使用点全搬走了 —— ESLint 的 no-unused-vars 会报');
});

/* ---- 5. 模块导出的东西不多不少 ---- */
t('模块只导出 isRunningAsAdmin（main.js 唯一还需要的那一个）', () => {
  const acl = strip(read(ACL));
  /* 【锚定文件末尾那一个 return】文件内还有很多局部 return
   * （`return { paths: list, missing, lockers: uniq }` 之类），
   * 用贪婪匹配会把最后一个局部 return 当成导出 —— 我第一版就是这么写错的。
   * 导出语句的特征是：位于 register 函数体的**最外层**，紧跟 `};` 收尾。 */
  const tail = acl.trimEnd().slice(-400);
  /* 锁的是：「模块只导出 isRunningAsAdmin（main.js 唯一还需要的那一个）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  const m = tail.match(/return\s*\{([^}]*)\}\s*;\s*\}\s*;/);
  assert.ok(m, '找不到模块末尾的导出 return（形态应为 return { … };  })');
  const names = m[1].split(',').map((x) => x.trim()).filter(Boolean);
  assert.deepStrictEqual(names, ['isRunningAsAdmin'],
    '导出集合变了。导出越多，越容易被别处顺手引用、又把耦合接回去。实际：' + names.join(', '));
});

/* ---- 6. 闭包状态没有留成 main.js 的隐式依赖 ---- */
t('搬走的代码不直接引用 win / send / jobSeq（必须走 ctx）', () => {
  const acl = strip(read(ACL));
  /* 排除注释与字符串已由 strip 处理。这里查的是「有没有裸的全局名」。 */
  const bad = [];
  /* 锁的是：「搬走的代码不直接引用 win / send / jobSeq（必须走 ctx）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  if (/(^|[^.\w])win\s*&&\s*!?win\.isDestroyed/.test(acl)) bad.push('直接用了 win.isDestroyed');
  /* 锁的是：「搬走的代码不直接引用 win / send / jobSeq（必须走 ctx）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  if (/(^|[^.\w])webContents\.send/.test(acl)) bad.push('直接用了 webContents.send');
  /* 锁的是：「搬走的代码不直接引用 win / send / jobSeq（必须走 ctx）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  if (/(\+\+jobSeq|jobSeq\+\+)/.test(acl)) bad.push('直接自增了 jobSeq（应走 ctx.nextJobSeq）');
  assert.deepStrictEqual(bad, [], '这些必须经 ctx 访问，否则模块与 main.js 状态分裂：\n  ' + bad.join('\n  '));
});

/* ---- 7. ctx 真的被当参数传进去了 ---- */
t('main.js 用 register(ctx, deps) 调用模块，且 deps 里带 handle', () => {
  const code = strip(read(MAIN));
  /* 锁的是：「main.js 用 register(ctx, deps) 调用模块，且 deps 里带 handle」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/require\('\.\/ipc\/dir-acl-links'\)(\(|$)/.test(code) || /require\('\.\/ipc\/dir-acl-links'\)\(ipcCtx/.test(code),
    'main.js 没有调用 ipc/dir-acl-links 的 register');
  const call = code.slice(code.indexOf("require('./ipc/dir-acl-links')"));
  const seg = call.slice(0, 700);
  /* 锁的是：「main.js 用 register(ctx, deps) 调用模块，且 deps 里带 handle」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/ipcCtx/.test(seg), '没有把 ipcCtx 传进去');
  for (const k of ['handle', 'ps', 'runCmd', 'pathExists', 'shortErr', 'PS_PATH_BATCH']) {
  /* 锁的是：「main.js 用 register(ctx, deps) 调用模块，且 deps 里带 handle」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    assert.ok(new RegExp('\\b' + k + '\\b').test(seg), 'deps 里缺 ' + k + '（模块会 ReferenceError）');
  }
});

/* ---- 8. E2E 脚本必须把 ipc/ 一起拷到临时目录 ---- */
t('所有「拷应用再启动」的 E2E 脚本都把 ipc/ 拷进去了', () => {
  const offenders = [];
  for (const n of fs.readdirSync(path.join(ROOT, 'scripts')).filter((x) => x.endsWith('.js'))) {
    const p = path.join(ROOT, 'scripts', n);
    const s = fs.readFileSync(p, 'utf8');
    /* 只关心「确实会拷一份应用到临时目录」的脚本 */
  /* 锁的是：「所有「拷应用再启动」的 E2E 脚本都把 ipc/ 拷进去了」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    if (!/cpSync\(/.test(s)) continue;
  /* 锁的是：「所有「拷应用再启动」的 E2E 脚本都把 ipc/ 拷进去了」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    if (!/['"]js['"],\s*['"]css['"]/.test(s) && !/\['js',/.test(s)) continue;
  /* 锁的是：「所有「拷应用再启动」的 E2E 脚本都把 ipc/ 拷进去了」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    if (!/['"]ipc['"]/.test(s)) offenders.push(n);
  }
  assert.deepStrictEqual(offenders, [],
    '这些脚本没拷 ipc/：临时目录里的应用启动即 MODULE_NOT_FOUND，\n' +
    '  而它们只会打一行「环境受限」的 SKIP，不会让 CI 变红：\n  ' + offenders.join('\n  '));
});

/* ---- 9. ipc/ 在 lint 与打包范围内 ---- */
t('ipc/ 被 ESLint 与 electron-builder 覆盖', () => {
  const eslint = fs.readFileSync(path.join(ROOT, 'eslint.config.js'), 'utf8');
  /* 锁的是：「ipc/ 被 ESLint 与 electron-builder 覆盖」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(eslint.includes('ipc/**/*.js'), 'eslint 没覆盖 ipc/ —— 搬出去的文件没人查');
  const pkg = require(path.join(ROOT, 'package.json'));
  const files = (pkg.build && pkg.build.files) || [];
  /* 打包清单里没显式列 ipc 的话，就要求有覆盖式的全量通配 */
  assert.ok(files.some((f) => f === 'ipc/**/*' || f === '**/*'),
    'package.json 的 build.files 没有包含 ipc/ —— 打出来的包会启动即崩溃。实际清单：' + JSON.stringify(files));
});

/* ---- 10. ctx 仍是 getter 语义 ---- */
t('ipc/ctx.js 的访问器仍是 getter', () => {
  const code = strip(read(CTX));
  for (const k of ['win', 'jobs', 'isWin', 'isMac']) {
  /* 锁的是：「ipc/ctx.js 的访问器仍是 getter」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    assert.ok(new RegExp('get ' + k + '\\(\\)').test(code), 'ctx.' + k + ' 不是 getter（快照会让搬出去的代码读到构造时的值）');
  }
});

done();
