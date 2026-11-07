'use strict';
/* 文件占用解锁：能力 + 安全判据 + 复核。
 *
 * ============ 这个功能为什么需要这么多测试 ============
 * 它是本项目**唯一一个会主动结束别人进程**的功能。判据放松一点就是
 * 「用户点一下，杀软/数据库/编辑器被强杀」，收紧一点就是「点了没反应」。
 * 而这类错误在真机上极难回归（要恰好有程序锁着文件）。
 *
 * ============ 锁的是哪几个回归 ============
 * ① 两份白名单漂移。main.js 的 PROC.KILL 有一份 PROTECTED_PROC_NAMES，
 *    解锁如果自己再写一份，迟早一边加了一边忘 —— 历史上已经发生过。
 * ② 「进程杀了就报解锁成功」。实测会有这些情况：系统延迟回收句柄、
 *    同一文件被多个进程占用而 RM 只报了一个、占用方是杀软的实时扫描
 *    （RM 根本看不到）。不复核就会对用户说"已解锁"，然后删除仍然失败。
 * ③ 渲染层能结束任意进程。如果 UNLOCK 通道只收 pid 不做校验，
 *    一个 typo 就能杀掉无关进程。判据必须是「这个 pid 确实在该路径的占用列表里」。
 * ④ 「解锁」被实现成静默强删。实测独占锁下 unlink/rename/truncate 全部 EBUSY，
 *    所以只能结束进程 —— 把手段如实告诉用户，而不是假装"有魔法"。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

const safety = require('../lib/unlock-safety');

/* ============ ① 安全判据 ============ */
t('UL1 系统关键进程一律拒绝（与 PROC.KILL 同一份名单）', () => {
  /* 锁的是：解锁自己写一份名单，加了一个新关键进程却只改了一边 ——
   * 那样解锁能杀掉 PROC.KILL 明令禁止的进程。 */
  const mainSrc = readSrc('main.js');
  const i = mainSrc.indexOf('const PROTECTED_PROC_NAMES = new Set([');
  assert.ok(i > 0, '找不到 PROC.KILL 用的名单');
  /* 【窗口必须停在 Set 的右括号】第一版取了 700 字符，把后面函数体里的
   * 错误文案也一起抓进来（'进程 ID 无效'、'不能结束本程序自身的进程' …），
   * 于是"名单漏了这些"报了一堆根本不是名单项的字符串。 */
  const close = mainSrc.indexOf(']', i);
  assert.ok(close > i, '找不到名单的结尾');
  const seg = mainSrc.slice(i, close + 1);
  const names = [...seg.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 10 && names.length < 40, '名单解析异常，拿到 ' + names.length + ' 项');
  const missing = names.filter((n) => !safety.PROTECTED_PROC_NAMES.has(n));
  /* 锁的是：lib 里的名单少了 main.js 有的项 —— 解锁能杀掉那边禁止的进程。 */
  assert.deepStrictEqual(missing, [], '解锁的安全名单漏了这些：' + missing.join('、'));
  /* 反向也要查：lib 多的项不会造成安全问题（更严），但会造成"两边不一致"
   * 的维护困惑，所以也报出来 */
  const extra = [...safety.PROTECTED_PROC_NAMES].filter((n) => !names.includes(n));
  /* 锁的是：两份名单长期漂移，谁也不知道哪份才是权威。 */
  assert.deepStrictEqual(extra, [], '解锁的安全名单多出了这些（main.js 里没有）：' + extra.join('、'));
  /* 低 PID 阈值同样要对齐 */
  /* 锁的是：阈值不一致 —— 一个拦 ≤1000、另一个拦 ≤500。 */
  assert.strictEqual(safety.PROTECTED_PROC_PID_MAX, 1000);
  /* 锁的是：main.js 改了阈值而 lib 没跟上。 */
  assert.ok(/PROTECTED_PROC_PID_MAX\s*=\s*1000/.test(mainSrc), 'main.js 的低 PID 阈值不是 1000');
});

t('UL2 逐类进程的判定结果符合预期', () => {
  const ow = { selfPid: 9999, parentChain: [1234] };
  /* 锁的是：lsass 这类进程被允许结束 —— 直接蓝屏。 */
  assert.strictEqual(safety.canKillForUnlock({ pid: 2000, procName: 'lsass' }, ow).ok, false);
  /* 锁的是：低 PID 段的系统进程被放行。 */
  assert.strictEqual(safety.canKillForUnlock({ pid: 500, procName: 'anything' }, ow).ok, false);
  /* 锁的是：把自己杀了 —— 正在写盘的任务被打断，数据落不下来。 */
  assert.strictEqual(safety.canKillForUnlock({ pid: 9999, procName: 'electron' }, ow).ok, false);
  /* 锁的是：杀了启动自己的终端 —— 连带把自己关掉。 */
  assert.strictEqual(safety.canKillForUnlock({ pid: 1234, procName: 'cmd' }, ow).ok, false);
  /* 锁的是：系统服务被直接结束（会被 SCM 立刻拉起，且影响面大）。 */
  assert.strictEqual(safety.canKillForUnlock({ pid: 3000, procName: 'MSSQLSERVER', type: 'service' }, ow).ok, false);
  /* 普通程序：应该允许 */
  /* 锁的是：判据收得太紧 —— 连普通编辑器都不让结束，功能等于没有。 */
  assert.strictEqual(safety.canKillForUnlock({ pid: 3000, procName: 'notepad' }, ow).ok, true);
  /* 大小写与空名 */
  assert.strictEqual(safety.canKillForUnlock({ pid: 3000, procName: 'LSASS' }, ow).ok, false);
  assert.strictEqual(safety.canKillForUnlock({ pid: 3000, name: 'Chrome' }, ow).ok, true);
  /* 无效 pid */
  assert.strictEqual(safety.canKillForUnlock({ pid: 0 }, ow).ok, false);
  assert.strictEqual(safety.canKillForUnlock({ pid: -5 }, ow).ok, false);
  assert.strictEqual(safety.canKillForUnlock(null, ow).ok, false);
});

t('UL3 分流结果保留被拒原因（界面要能解释"为什么不让我结束"）', () => {
  const { killable, blocked } = safety.partitionLockers([
    { pid: 3001, procName: 'notepad' },
    { pid: 3002, procName: 'lsass' },
    { pid: 3003, procName: 'mydb', type: 'service' },
  ], { selfPid: 9999 });
  /* 锁的是：把禁止结束的进程也塞进 killable —— 下一行就会被真杀掉。 */
  assert.strictEqual(killable.length, 1, '应只有 1 个可结束，实际 ' + killable.length);
  assert.strictEqual(killable[0].pid, 3001);
  /* 锁的是：只给个空 reason，用户看不懂为什么被拒。 */
  assert.strictEqual(blocked.length, 2);
  blocked.forEach((b) => {
    assert.ok(typeof b.reason === 'string' && b.reason.length > 8,
      '拒绝原因太短或为空：' + JSON.stringify(b.reason));
  });
});

/* ============ ② 结果文案 ============ */
t('UL4 结果文案要区分「已结束」「失败」「不允许」三种，且能说明"还没解开"', () => {
  const s1 = safety.unlockSummary({
    killed: [{ pid: 1, name: 'notepad' }], failed: [], blocked: [], stillLocked: false,
  });
  /* 锁的是：只说"解锁成功"不说是结束了谁 —— 用户没法判断是不是自己那个程序。 */
  assert.ok(/notepad/.test(s1), '文案里没有进程名：' + s1);

  const s2 = safety.unlockSummary({
    killed: [], failed: [{ pid: 2, name: 'a', error: '拒绝访问' }], blocked: [], stillLocked: false,
  });
  /* 锁的是：失败时静默 —— 用户以为杀了其实没杀。 */
  assert.ok(/失败/.test(s2) && /拒绝访问/.test(s2), '失败原因没带上：' + s2);

  const s3 = safety.unlockSummary({ killed: [{ pid: 3, name: 'b' }], blocked: [], stillLocked: true });
  /* 锁的是：杀了进程就当解锁成功，而文件其实还被别人占着（常见的杀软场景）。 */
  assert.ok(/仍然/.test(s3), '没解开时没有说明：' + s3);

  const s4 = safety.unlockSummary({ killed: [], failed: [], blocked: [], stillLocked: false });
  /* 锁的是：什么都没有时输出空串 / undefined。 */
  assert.ok(s4.length > 0 && !/undefined/.test(s4), '空结果文案不对：' + s4);
});

/* ============ ③ 主进程通道 ============ */
t('UL5 UNLOCK 通道会重新查占用，不采信渲染层的结论', () => {
  const src = readSrc('ipc/dir-acl-links.js');
  const i = src.indexOf('handle(dirMoveCh.ACL_LINKS.UNLOCK');
  assert.ok(i > 0, '找不到 UNLOCK handler');
  /* 【窗口必须止于下一个 handler】
   * 第一版取了固定 3200 字符，结果窗口一直延伸进后面的 LINK_SCAN ——
   * 那个 handler 里也有 rmQueryLockers / stillLocked，于是把 UNLOCK 里的
   * 三处实现全删掉、测试照样绿（变异实测确认）。
   * 现在按「下一个 handle(」截断，判据只看 UNLOCK 自己的函数体。 */
  const nextHandle = src.indexOf('handle(dirMoveCh.', i + 10);
  const seg = src.slice(i, nextHandle > i ? nextHandle : i + 3200);
  /* 锁的是：直接按传进来的 pid 去杀 —— 渲染层一个 typo 就能结束任意进程。 */
  assert.ok(/const cur = await rmQueryLockers\(paths\)/.test(seg),
    'UNLOCK 没有重新查一遍占用（必须是 `const cur = await rmQueryLockers(paths)`）');
  /* 锁的是：不比对"这个 pid 是不是真的在占用列表里"。
   * 【判据要点名赋值形态，不能只查字符串存在】
   * 变异实测：把 `const cur = await rmQueryLockers(...)` 换成构造的空对象，
   * 文件里仍然有 `rmQueryLockers` 这个标识符（别处调用），旧的 includes 判据通过。
   * 这里要求「cur 来自 rmQueryLockers」与「targets 来自 present」两处**赋值**都对。 */
  /* 锁的是：没有建立 present 映射 —— 后面就无法判断 pid 是否属于占用者。 */
  assert.ok(/const present = new Map\(\)/.test(seg), 'UNLOCK 没有建立 present 映射');
  /* 锁的是：查到了占用却忘了放进 present —— targets 过滤会全部落空。 */
  assert.ok(/present\.set\(Number\(l\.pid\), l\)/.test(seg), 'UNLOCK 没有把查到的占用放进 present');
  /* 锁的是：targets 直接从 wantPids 取，不过一次 present 过滤。 */
  assert.ok(/const targets = wantPids\.filter\(\(pid\) => present\.has\(pid\)\)/.test(seg),
    'UNLOCK 的 targets 没有经过 present 过滤（会把不在占用列表里的 pid 也杀掉）');
  /* 锁的是：结束之后不复核，直接返回成功。 */
  assert.ok(/stillLocked\s*=\s*remaining\.length\s*>\s*0/.test(seg),
    'UNLOCK 没有用复核结果决定 stillLocked');
});

t('UL6 UNLOCK 走统一的 killProc（安全判据只有一份）', () => {
  const src = readSrc('ipc/dir-acl-links.js');
  /* 锁的是：模块自己 taskkill —— 白名单与低 PID 拦截变成两份。 */
  assert.ok(!/taskkill/.test(src), 'ipc 模块里出现了自己的 taskkill');
  /* 锁的是：没有注入 killProc 就用别的方式结束进程。 */
  assert.ok(/killProc/.test(src), '没有用注入的 killProc');
  /* main.js 必须真的把它注进去 */
  const mainSrc = readSrc('main.js');
  /* 锁的是：忘了注入 —— 运行到解锁时抛"能力未注入"。 */
  assert.ok(/killProc:\s*killProcessChecked/.test(mainSrc), 'main.js 没有注入 killProc');
  /* 锁的是：PROC.KILL 与解锁各写一份实现。 */
  assert.ok(/handle\(CH\.PROC\.KILL, async \(e, pid\) => killProcessChecked\(pid\)\)/.test(mainSrc),
    'PROC.KILL 没有复用 killProcessChecked');
});

/* ============ ④ 渲染层 ============ */
t('UL7 界面提供解锁入口，且按钮文案点明「并解锁」', () => {
  const src = readSrc('js/tools/file-unlock.js');
  /* 锁的是：只有查询没有解锁 —— 这正是用户提的问题："只检测，不解锁就不实用"。 */
  assert.ok(/ACL_LINKS\.UNLOCK/.test(src), '界面没有调用 UNLOCK 通道');
  /* 锁的是：按钮还叫「结束」 —— 用户不知道结束之后文件就能删了。 */
  assert.ok(/并解锁/.test(src), '按钮文案没有点明解锁');
  /* 锁的是：多进程占用时只能逐个点，漏一个仍删不掉。 */
  assert.ok(/全部结束/.test(src), '没有「全部解锁」入口');
});

t('UL8 解锁前必须确认，且确认框讲明代价', () => {
  const src = readSrc('js/tools/file-unlock.js');
  const i = src.indexOf('async function unlockOne(');
  assert.ok(i > 0, '找不到 unlockOne');
  /* 【按函数体截断，不按固定字符数】取了 2200 字符会漏到下一个函数
   * （那里也有 confirmBox / 拒绝 之类的字样），于是把 unlockOne 里的
   * 确认逻辑删掉、测试照样绿。 */
  const end = src.indexOf('\n      async function ', i + 10);
  const seg = src.slice(i, end > i ? end : i + 2200);
  /* 锁的是：点了就杀 —— 没有确认，用户误点就丢数据。
   * 判据要**排除 `true ||` 这类短路写法**：那种写法看起来调了 confirmBox，
   * 实际永远直接进下一步（变异实测确认原来的 includes 判据被它骗过）。 */
  assert.ok(/const ok = await confirmBox\(/.test(seg), '解锁没有二次确认（或确认被短路）');
  /* 锁的是：确认框只说"确定吗" —— 不告诉用户会丢未保存数据。 */
  assert.ok(/未保存|丢失/.test(seg), '确认框没有提示数据丢失风险');
  /* 锁的是：不提示"系统关键进程会被拒绝" —— 用户点了没反应以为坏了。 */
  assert.ok(/拒绝/.test(seg), '确认框没有说明哪些会被拒绝');
  /* 锁的是：解锁后不重查，用户不知道到底解没解开。 */
  assert.ok(/scan\(\)/.test(seg), '解锁后没有重新查询');
});

t('UL9 工具描述与说明不再声称"只做查询"（那是解锁前的文案）', () => {
  const src = readSrc('js/tools/file-unlock.js');
  /* 锁的是：功能加了解锁，说明还写着"只做查询与诊断" —— 自相矛盾。 */
  assert.ok(!/只做查询与诊断/.test(src), '说明里还写着「只做查询与诊断」');
  /* 锁的是：说明里不提"结束进程是唯一手段"，用户以为有魔法强删。 */
  assert.ok(/唯一可靠|只有结束/.test(src), '说明里没有解释为什么必须结束进程');
});

t('UL10 四种「没做成」都要在界面上说清（真机验证时踩到的空洞）', () => {
  const src = readSrc('js/tools/file-unlock.js');
  const i = src.indexOf('async function unlockOne(');
  assert.ok(i > 0, '找不到 unlockOne');
  const end = src.indexOf('\n      async function ', i + 10);
  const seg = src.slice(i, end > i ? end : i + 3000);

  /* 【锁的是：用户点了「结束并解锁」却一个字都没看到】
   * 真机验证时踩到：持有者在查询之后自行退出，通道返回
   *   { ok:false, missing:[39720], reason:'已经不在占用列表里' }
   * 而当时的界面只在 blocked 非空时才写 notes —— missing 分支什么都不显示。
   * 用户点完既没成功也没失败提示，只能反复点。
   * 现在四类结果各自有提示，缺一条就是一次"点了没反应"。
   *
   * 【判据必须看「有没有真的 push 一句提示」，不是「有没有提到这个字段」】
   * 变异实测：把 `if (r && r.missing && r.missing.length) {` 改成 `if (false) {`，
   * 原来的 `/r\.missing/` 判据仍然通过 —— 因为那一行还在，只是永不执行。
   * 改成要求「条件 + 紧随其后的 notes.push」成对出现。 */
  /* 锁的是：进程自行退出（missing）时不提示 —— 用户以为按钮失灵。 */
  assert.ok(/if \(r && r\.missing && r\.missing\.length\) \{[\s\S]{0,240}?notes\.push\(/.test(seg),
    'missing 分支没有真的给出提示（条件存在但没 push）');
  /* 锁的是：被安全判据拒绝时不解释原因。 */
  assert.ok(/for \(const b of \(r && r\.blocked\) \|\| \[\]\) \{[\s\S]{0,200}?notes\.push\(/.test(seg),
    'blocked 分支没有真的给出提示');
  /* 锁的是：结束失败时静默。 */
  assert.ok(/for \(const f of \(r && r\.failed\) \|\| \[\]\) \{[\s\S]{0,200}?notes\.push\(/.test(seg),
    'failed 分支没有真的给出提示');
  /* 锁的是：杀了进程但文件仍被占用时不说 —— 用户以为解锁成功，删除却失败。 */
  assert.ok(/if \(r && r\.stillLocked\) \{[\s\S]{0,240}?notes\.push\(/.test(seg),
    'stillLocked 分支没有真的给出提示（杀了但还没解开）');
  /* 锁的是：全都用一句话盖过去 —— 用户分不清是"它自己退了"还是"我杀成了"。 */
  assert.ok(/state\.notes = notes/.test(seg), '四类结果没有落到 notes 上展示');
});

done();
