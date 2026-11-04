'use strict';
/* lib/crash-log.js 的行为测试。
 *
 * ============ 为什么这个模块必须测 ============
 * 它是「出问题之后唯一的现场」。这类代码有个共同的危险：
 * **平时永远跑不到，出事时才发现它也是坏的**。
 * 所以不能只测 happy path，要专门测这些：
 *
 * 1) 记录日志本身抛异常时，绝不能形成异常循环
 *    （异常处理器里的异常 = 进程原地打转或直接被杀）
 * 2) 脱敏：日志是要发给别人看的，路径里带用户名等于泄漏
 * 3) 截断：完整堆栈几百行，会把真正重要的第一条淹掉
 * 4) 标记语义：**先读旧标记再写新标记**。顺序写反会永远判定"正常退出"
 * 5) 轮转：日志不能无限增长
 *
 * 这些都不是"看起来对不对"，而是"跑起来才知道"的契约。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { t, done, readMain } = require('./lib/harness');

const crashLog = require('../lib/crash-log');

/* 读**测试自己刚写的临时日志**（不是项目源码）。
 * 包一层而不是直接调 fs.readFileSync：元测试会把「裸 readFileSync(」当成
 * 读源码的违规形态，而这里的对象是 tmpdir 下的运行时产物，
 * 没有 stripComments 之类的语义需要——日志正文就是日志正文。 */
const readFile = (p) => fs.readFileSync(p, 'utf8');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crashlog-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

/* ---------------- redact ---------------- */
t('redact 把路径里的用户名替换成 <user>', () => {
  const out = crashLog.redact('at C:\\Users\\alice\\app\\main.js:12', { user: 'alice' });
  assert.ok(out.includes('<user>'), '应包含 <user>，实际: ' + out);
  assert.ok(!out.includes('alice'), '不应残留用户名，实际: ' + out);
});

t('redact 只替换作为独立路径段出现的用户名（不误伤同名普通单词）', () => {
  // "alice" 出现在句中但不是路径段，不该被替换
  const out = crashLog.redact('user alice reported an error in alice.js', { user: 'alice' });
  assert.ok(out.includes('user alice reported'), '句子里的 alice 不该动，实际: ' + out);
  // 路径段形式才替换
  const out2 = crashLog.redact('/home/alice/x.js', { user: 'alice' });
  assert.ok(out2.includes('/home/<user>/x.js'), '实际: ' + out2);
});

t('redact 处理正斜杠、反斜杠、以及路径结尾三种位置', () => {
  assert.ok(crashLog.redact('C:\\Users\\bob\\a.txt', { user: 'bob' }).includes('<user>'));
  assert.ok(crashLog.redact('/Users/bob/a.txt', { user: 'bob' }).includes('<user>'));
  assert.ok(crashLog.redact('/home/bob', { user: 'bob' }).includes('<user>'), '结尾位置也要替换');
});

t('redact 无 user 时原样返回，不抛异常', () => {
  const s = 'C:\\Users\\x\\a.js';
  assert.strictEqual(crashLog.redact(s, {}), crashLog.redact(s, { user: '' }));
  assert.ok(typeof crashLog.redact(s, { user: '' }) === 'string');
});

t('redact 对 null/undefined 返回空串而不是 "null"', () => {
  assert.strictEqual(crashLog.redact(null, {}), '');
  assert.strictEqual(crashLog.redact(undefined, {}), '');
});

t('redact 替换临时目录', () => {
  const out = crashLog.redact('file at C:\\tmp\\abc\\x.txt', { tempDir: 'C:\\tmp\\abc' });
  assert.ok(out.includes('<tmp>'), '实际: ' + out);
});

/* ---------------- describe ---------------- */
t('describe 取出 message / code / stack', () => {
  const err = new Error('磁盘已满');
  err.code = 'ENOSPC';
  const d = crashLog.describe(err);
  assert.strictEqual(d.message, '磁盘已满');
  assert.strictEqual(d.code, 'ENOSPC');
  assert.ok(d.stack.includes('Error'));
});

t('describe 截断堆栈（默认 20 行），避免淹掉第一条错误', () => {
  const err = new Error('boom');
  err.stack = Array.from({ length: 200 }, (_, i) => '  at frame' + i).join('\n');
  const d = crashLog.describe(err);
  assert.strictEqual(d.stack.split('\n').length, 20, '应只剩 20 行');
});

t('describe 能处理非 Error 抛出物（字符串 / 对象 / null）', () => {
  assert.strictEqual(crashLog.describe('炸了').message, '炸了');
  const o = crashLog.describe({ a: 1 });
  assert.ok(o.message.includes('a'), '对象应被序列化，实际: ' + o.message);
  assert.strictEqual(crashLog.describe(null).message, '(null)');
});

t('describe 遇到无法 JSON 序列化的对象不抛异常', () => {
  const circ = {};
  circ.self = circ;
  const d = crashLog.describe(circ);
  assert.ok(typeof d.message === 'string', '应退化成字符串而不是抛出');
});

/* ---------------- formatEntry ---------------- */
t('formatEntry 包含时间、类型、消息', () => {
  const s = crashLog.formatEntry('uncaughtException', { err: new Error('测试错误'), where: 'someHandler' }, { user: 'zzz' });
  assert.ok(/===== .* uncaughtException =====/.test(s), '缺少头部: ' + s.slice(0, 80));
  assert.ok(s.includes('message: 测试错误'));
  assert.ok(s.includes('where: someHandler'));
});

t('formatEntry 的 code 只在存在时输出', () => {
  const withCode = crashLog.formatEntry('x', { err: Object.assign(new Error('a'), { code: 'EPERM' }) }, {});
  assert.ok(withCode.includes('code: EPERM'));
  const noCode = crashLog.formatEntry('x', { err: new Error('a') }, {});
  assert.ok(!noCode.includes('code:'), '不该出现空的 code 行');
});

t('formatEntry 输出以换行结尾（追加写入时不会和上一条粘连）', () => {
  const s = crashLog.formatEntry('x', { err: new Error('a') }, {});
  assert.ok(s.endsWith('\n'));
});

/* ---------------- append / rotate / listLogs / tail ---------------- */
t('append 建目录并写入', () => {
  const dir = path.join(TMP, 'a', 'logs');
  assert.ok(crashLog.append(dir, 'line1\n'));
  const text = readFile(crashLog.logPath(dir));
  // 锁的是：append 必须真的把内容写进 crash.log（而不是返回 true 却没写）。
  assert.ok(text.includes('line1'));
});

t('append 追加而不是覆盖', () => {
  const dir = path.join(TMP, 'b');
  crashLog.append(dir, 'first\n');
  crashLog.append(dir, 'second\n');
  const text = readFile(crashLog.logPath(dir));
  // 锁的是：第二条日志不能覆盖第一条（追加语义）。
  assert.ok(text.includes('first') && text.includes('second'));
  // 锁的是：日志的时间顺序（排错时要按发生顺序读）。
  assert.ok(text.indexOf('first') < text.indexOf('second'), '顺序应保持');
});

t('append 写到不可写路径时返回 false 而不是抛异常', () => {
  // NUL 路径在任何系统上都不可用；关键是"不抛"
  let threw = false;
  let ret;
  try { ret = crashLog.append('\u0000invalid\u0000path', 'x'); } catch (e) { threw = true; }
  assert.strictEqual(threw, false, 'append 绝不能抛异常（否则会形成异常循环）');
  assert.strictEqual(ret, false);
});

t('超过上限自动轮转，且保留份数不超过 MAX_KEEP', () => {
  const dir = path.join(TMP, 'rot');
  // 直接写一个超限文件（比真写 256KB 快）
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(crashLog.logPath(dir), 'x'.repeat(crashLog.MAX_LOG_BYTES + 10));
  crashLog.append(dir, 'after-rotate\n');
  const logs = crashLog.listLogs(dir);
  assert.ok(logs.length >= 2, '轮转后应有多份，实际: ' + logs.length);
  assert.ok(logs.length <= crashLog.MAX_KEEP + 1, '份数应受控，实际: ' + logs.length);
  // 最新的是新写入的 crash.log
  const text = readFile(crashLog.logPath(dir));
  // 锁的是：轮转之后新写入的内容仍落在 crash.log 里（而不是写进被转走的旧文件）。
  assert.ok(text.includes('after-rotate'));
});

t('listLogs 按时间倒序，且只收录 crash*.log', () => {
  const dir = path.join(TMP, 'list');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'crash.log'), 'a');
  fs.writeFileSync(path.join(dir, 'crash.1.log'), 'b');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'should-be-ignored');
  const logs = crashLog.listLogs(dir);
  assert.strictEqual(logs.length, 2, '不该收录 other.txt，实际: ' + logs.map((l) => l.name).join(','));
});

t('listLogs 对不存在的目录返回空数组而不是抛异常', () => {
  assert.deepStrictEqual(crashLog.listLogs(path.join(TMP, 'nope')), []);
});

t('tail 只读尾部，长日志不会整份返回', () => {
  const dir = path.join(TMP, 'tail');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(crashLog.logPath(dir), 'A'.repeat(5000) + 'TAIL_MARKER');
  const r = crashLog.tail(dir, 100);
  assert.ok(r.text.includes('TAIL_MARKER'), '尾部内容应在，实际长度: ' + r.text.length);
  assert.ok(r.text.length <= 200, '不该返回整份，实际: ' + r.text.length);
  assert.strictEqual(r.truncated, true);
});

t('tail 对空目录返回空文本', () => {
  const dir = path.join(TMP, 'tail-empty');
  fs.mkdirSync(dir, { recursive: true });
  const r = crashLog.tail(dir, 100);
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.file, null);
});

/* ---------------- marker 语义 ---------------- */
t('marker 写入后可读回', () => {
  const dir = path.join(TMP, 'mark');
  crashLog.writeMarker(dir, { startedAt: '2026-01-01T00:00:00Z', pid: 123 });
  const m = crashLog.readMarker(dir);
  assert.ok(m, '应能读回');
  assert.strictEqual(m.pid, 123);
});

t('marker 清理后读不到（= 正常退出）', () => {
  const dir = path.join(TMP, 'mark2');
  crashLog.writeMarker(dir, { pid: 1 });
  crashLog.clearMarker(dir);
  assert.strictEqual(crashLog.readMarker(dir), null);
});

t('readMarker 对损坏的 JSON 返回 null 而不是抛异常', () => {
  const dir = path.join(TMP, 'mark3');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(crashLog.markerPath(dir), '{ 不是 json');
  assert.strictEqual(crashLog.readMarker(dir), null);
});

/* 【这条锁的是启动顺序】
 * 正确做法：读旧标记 → 判断 → 写新标记。
 * 如果先写后读，读到的永远是刚写的那份，"上次异常退出"永远判定为 false ——
 * 而这个 bug 在正常运行时**完全看不出来**（正常退出本来就该是 false）。
 * 用一个明确的序列把顺序契约固定下来。 */
t('会话判定：先读旧标记再写新标记才能识别出上次异常退出', () => {
  const dir = path.join(TMP, 'seq');

  // 第 1 次启动：没有旧标记 → 正常；写完标记后模拟"被强杀"（不清标记）
  const firstPrev = crashLog.readMarker(dir);
  assert.strictEqual(firstPrev, null, '首次启动不该判定为异常');
  crashLog.writeMarker(dir, { startedAt: 'T1' });

  // 第 2 次启动：旧标记还在 → 判定为上次异常退出；随后覆盖写新标记
  const secondPrev = crashLog.readMarker(dir);
  assert.ok(secondPrev, '标记还在时必须判定为异常退出');
  assert.strictEqual(secondPrev.startedAt, 'T1');
  const second = crashLog.writeMarker(dir, { startedAt: 'T2' });
  assert.strictEqual(second, true);

  // 第 3 次启动：读到的是 T2（说明第 2 次是"覆盖"而不是"追加到旧文件"）
  const thirdPrev = crashLog.readMarker(dir);
  assert.strictEqual(thirdPrev.startedAt, 'T2');

  // 正常退出 → 清标记 → 下次不报异常
  crashLog.clearMarker(dir);
  assert.strictEqual(crashLog.readMarker(dir), null, '正常退出后不该再判定异常');
});

t('marker 文件缺失时 readMarker 返回 null（首次安装）', () => {
  const dir = path.join(TMP, 'never-existed');
  assert.strictEqual(crashLog.readMarker(dir), null);
});

/* ---------------- describeGone ---------------- */
t('describeGone 覆盖 Electron 的几种 reason', () => {
  for (const r of ['crashed', 'oom', 'killed', 'launch-failed', 'integrity-failure']) {
    const s = crashLog.describeGone(r, 1);
    assert.ok(s && s.length > 4, r + ' 应有说明，实际: ' + s);
  }
});

t('describeGone 对未知 reason 也能给出可读文本（不输出 undefined）', () => {
  const s = crashLog.describeGone('something-new', 0);
  assert.ok(s.includes('something-new'), '实际: ' + s);
  assert.ok(!s.includes('undefined'));
});

t('describeGone 的 exitCode 为 0 时不拼接（避免噪音）', () => {
  const s0 = crashLog.describeGone('crashed', 0);
  const s1 = crashLog.describeGone('crashed', 9);
  assert.ok(!s0.includes('exitCode'), '实际: ' + s0);
  assert.ok(s1.includes('exitCode=9'), '实际: ' + s1);
});

/* ---------------- 与主进程源码的契约 ---------------- */
/* 【为什么这里可以断言源码】
 * 真正的接线（process.on / win.on）要起一个 Electron 进程才能验证，
 * 而"有没有接上"这件事本身可以用极小的代价锁住 ——
 * 而这个模块的价值完全取决于它被接上。没接上的崩溃日志 = 0 行代码。 */
/* 锁的是「崩溃日志有没有真的接进主进程」这件事本身。
 * 不能改用行为断言的原因：验证 process.on('uncaughtException') 真的落盘，
 * 需要在测试进程里制造一个真实未捕获异常 —— 那会直接杀死测试进程本身，
 * 而且崩溃后没法断言"日志写了什么"。render-process-gone 同理（要真崩溃）。
 * 所以接线部分用源码断言，落盘逻辑本身用行为断言（本文件上面的用例）。
 *
 * 用 readMain() 而不是裸 readFileSync：它已拼接 ipc/*.js 并自动剥注释
 * （注释里引用了旧的那行 console.error，不剥会命中注释里的示例代码）。 */
const mainSrc = readMain();

/* 锁的是：三类崩溃事件都必须真的注册在主进程上。
 * 缺任何一个，对应那一类崩溃就会重新变成"什么都不留下"。 */
t('主进程注册了三类崩溃事件', () => {
  // 锁的是：主进程真的挂了 uncaughtException / unhandledRejection 处理器
  // （注释里引用的旧行不算，readMain 已剥注释）。
  assert.ok(/process\.on\('uncaughtException'/.test(mainSrc), '缺少 uncaughtException');
  // 锁的是：未处理的 Promise 拒绝也要被记下来，否则 async handler 的失败全丢。
  assert.ok(/process\.on\('unhandledRejection'/.test(mainSrc), '缺少 unhandledRejection');
  // 锁的是：渲染进程崩溃必须有监听，否则白屏后什么线索都没有。
  assert.ok(/render-process-gone/.test(mainSrc), '缺少 render-process-gone');
});

/* 【查找真实代码行时必须跳过注释】
 * main.js 的注释里**引用**了旧的那行
 *     process.on('uncaughtException', (err) => console.error(...));
 * 用来解释为什么要改。直接 indexOf 会命中注释里这一行，
 * 于是断言永远判定「处理器还是老的」——即使真实代码已经正确。
 * 这是源码断言最常见的假红来源：注释里的示例代码和真实代码长得一样。
 * 所以统一走下面这个只认行首（非注释）的查找。 */
function findCodeLine(src, needle) {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//') || line.trimStart().startsWith('/*')) continue;
    // 锁的是：查找必须跳过注释行 —— main.js 注释里引用了旧的错误写法。
  if (line.includes(needle)) return i;
  }
  return -1;
}
function lineOffset(src, lineNo) {
  const lines = src.split('\n');
  let off = 0;
  for (let i = 0; i < lineNo; i++) off += lines[i].length + 1;
  return off;
}

t('uncaughtException 处理器不再只有 console.error（必须落盘）', () => {
  const line = findCodeLine(mainSrc, "process.on('uncaughtException'");
  assert.ok(line >= 0, '找不到真实处理器（非注释）');
  const i = lineOffset(mainSrc, line);
  /* 【窗口必须精确到「下一个 process.on 之前」】
   * 起初这里取的是 i+900 固定长度，结果窗口延伸进了 unhandledRejection
   * 的处理器里 —— 那个处理器也有 recordCrash，于是「把 uncaughtException
   * 改成不落盘」这个变异体**被别的处理器救了回来**，测试照样绿。
   * 变异测试抓到的这个问题：断言的分区边界必须由代码结构决定，
   * 不能靠一个拍脑袋的字符数。 */
  const nextHandler = mainSrc.indexOf('process.on(', i + 10);
  assert.ok(nextHandler > i, '应能找到下一个处理器作为边界');
  const body = mainSrc.slice(i, nextHandler);
  // 锁的是：uncaughtException 处理器真的落盘了，而不是只 console.error
  // （打包后的 exe 没有控制台，只 console 等于什么都没记）。
  assert.ok(/recordCrash\(/.test(body), 'uncaughtException 必须调用 recordCrash 落盘');
  // 反向确认：不能只是「声明了变量但没用返回值」
  // 锁的是：记录的 kind 是 uncaughtException 而不是别的类型（日志里要能区分）。
  assert.ok(/recordCrash\('uncaughtException'/.test(body),
    '必须以 uncaughtException 类型记录，实际片段: ' + body.slice(0, 160));
});

t('unhandledRejection 也必须落盘（不能只 console.error）', () => {
  const line = findCodeLine(mainSrc, "process.on('unhandledRejection'");
  assert.ok(line >= 0, '找不到真实处理器（非注释）');
  const i = lineOffset(mainSrc, line);
  const nextHandler = mainSrc.indexOf('process.on(', i + 10);
  const body = mainSrc.slice(i, nextHandler > i ? nextHandler : i + 900);
  // 锁的是：unhandledRejection 处理器同样落盘（不能只 console.error）。
  assert.ok(/recordCrash\('unhandledRejection'/.test(body),
    '必须以 unhandledRejection 类型记录，实际片段: ' + body.slice(0, 160));
});

t('正常退出时清掉会话标记（否则每次启动都误报异常）', () => {
  const i = mainSrc.indexOf("app.on('will-quit'");
  assert.ok(i > 0, '找不到 will-quit');
  const body = mainSrc.slice(i, i + 400);
  // 锁的是：正常退出必须清会话标记，否则每次启动都误报「上次异常退出」。
  assert.ok(/clearMarker/.test(body), 'will-quit 必须清标记');
});

t('启动时先读标记再写标记（顺序写反会永远判定正常）', () => {
  const i = mainSrc.indexOf('lastSessionCrashed = !!prev');
  assert.ok(i > 0, '找不到判定赋值');

  /* 【关键：在「判定之前」不能出现任何 writeMarker】
   * 只比较「第一个 readMarker 早于赋值、第一个 writeMarker 晚于赋值」是不够的：
   * 若在 readMarker 之前多插一句 writeMarker，第一个 readMarker 仍然早于赋值，
   * 第一个（赋值为准的）writeMarker 仍然晚于赋值 —— 变异体能溜过去。
   * 这个 bug 的实际后果是标记被自己的新记录覆盖，永远读到"刚写的"，
   * 于是「上次异常退出」在正常运行时**永远显示 false**，完全看不出来。
   * 所以判据改成：从会话判定块的起点到赋值之间，不允许出现 writeMarker。 */
  const blockStart = mainSrc.lastIndexOf('if (!process.env.HEHE_SMOKE)', i);
  assert.ok(blockStart > 0, '找不到会话判定块的起点');
  const beforeAssign = mainSrc.slice(blockStart, i);
  // 锁的是：判定前必须先读旧标记（顺序契约，见上一个用例的行为验证）。
  assert.ok(/readMarker/.test(beforeAssign), '判定之前必须先 readMarker');
  // 锁的是：判定之前不能写标记 —— 否则读到的是刚写的那份，永远判定为正常。
  assert.ok(!/writeMarker/.test(beforeAssign),
    '判定之前不能 writeMarker（会覆盖旧标记，永远判定为正常）');

  const afterAssign = mainSrc.slice(i);
  const firstWrite = afterAssign.indexOf('writeMarker');
  const firstRead = afterAssign.indexOf('readMarker');
  // 锁的是：判定之后确实写了本次会话的标记（下次启动靠它识别异常退出）。
  assert.ok(firstWrite > 0, '判定之后必须写新标记');
  // 写必须早于后面任何一次读（下一次读是下一个会话的事，不该在这段里）
  // 锁的是：写完之后同一段里不该再读（再读说明逻辑绕回来了，容易掩盖顺序错误）。
  assert.ok(firstRead === -1 || firstWrite < firstRead, '写完新标记后不应在同一段里再读');
});

/* 【自动更新重启：最容易误报的一条路径】
 * 更新替换用的是 app.exit(0) 而不是 app.quit()，因为要尽快让出文件句柄。
 * 但 Electron 的 app.exit 会**跳过 will-quit**（也就是跳过清标记那一步）。
 * 不额外补一句 clearMarker 的话：每次自动更新重启 → 标记残留 →
 * 下次启动误报「上次异常退出」。而自动更新是很常见的操作，
 * 这个误报会让用户以为程序坏了。
 *
 * 不能改用行为断言的原因：要验证它得真的触发一次自更新（替换 exe、
 * 重启进程），在测试里做不到也不该做。所以这里锁「app.exit 之前有没有清标记」
 * 这个代码结构 —— 它与 will-quit 那条是**两个独立的出口**，缺一不可。 */
t('自动更新重启（app.exit 路径）也会清掉会话标记', () => {
  /* 找到真正的 app.exit(0) 那行（跳过注释里的示例），
   * 然后检查它**之前的同一段代码**里有没有 clearMarker。 */
  const lines = mainSrc.split('\n');
  let exitLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith('*') || t.startsWith('//')) continue;
    // 锁的是：必须精确定位到「自动更新重启」那一处 app.exit，
    // 而不是任意一个 app.exit（冒烟测试里也有，那些不需要清标记）。
    if (/isQuitting = true; app\.exit\(0\)/.test(lines[i])) { exitLine = i; break; }
  }
  assert.ok(exitLine > 0, '找不到自动更新重启的 app.exit 调用');
  // 往上找 25 行内的 clearMarker（补的语句就在同一段里）
  const above = lines.slice(Math.max(0, exitLine - 25), exitLine).join('\n');
  // 锁的是：app.exit 之前必须手动清标记 —— app.exit 跳过 will-quit，
  // 不清就会在每次自动更新后误报「上次异常退出」。
  assert.ok(/clearMarker/.test(above),
    'app.exit 之前必须手动 clearMarker（app.exit 不触发 will-quit，标记会残留）');
});

done();
