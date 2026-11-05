'use strict';
const { t, done, ROOT } = require('./lib/harness');
/* 任务 5 第 1 步的守卫：ipc/ctx.js 的语义。
 *
 * 【为什么这一步也值得一条测试】
 * ctx 的全部价值在于「搬出去的代码读到的是**实时**值」。如果哪天有人
 * 把 getter 改成快照对象（看起来更简单），行为会变成
 * 「第一次能用、换窗口/第二次就不对」—— 那是最难查的一类回归。
 * 这条测试就是为了让那种改动立刻变红。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createIpcCtx } = require('../ipc/ctx');

function makeHosts() {
  const state = { win: null, jobSeq: 0 };
  const jobs = new Map();
  const hosts = {
    getWin: () => state.win,
    getJobs: () => jobs,
    nextJobSeq: () => ++state.jobSeq,
    getIsWin: () => true,
    getIsMac: () => false,
  };
  return { state, jobs, hosts };
}

t('ctx.win / ctx.jobs 读的是实时值，不是构造时的快照', () => {
  const { state, jobs, hosts } = makeHosts();
  const ctx = createIpcCtx(hosts);
  assert.strictEqual(ctx.win, null, '初始应为 null');
  // 模拟「窗口重建」：ctx 必须立刻看到新窗口，而不是继续返回 null
  state.win = { id: 7 };
  assert.deepStrictEqual(ctx.win, { id: 7 }, 'ctx.win 没有跟随宿主变量（做成快照了？）');
  // jobs 表是同一个对象：外面增删，ctx 里能看到
  jobs.set('x', { cancel() {} });
  assert.ok(ctx.jobs.has('x'), 'ctx.jobs 与宿主的 jobs 不是同一个 Map');
});

t('ctx.nextJobSeq 与宿主共享同一份计数（不会分裂成两套编号）', () => {
  const { state, hosts } = makeHosts();
  const ctx = createIpcCtx(hosts);
  assert.strictEqual(ctx.nextJobSeq(), 1);
  assert.strictEqual(ctx.nextJobSeq(), 2);
  /* 宿主自己直接自增（模拟 main.js 里别处的 ++jobSeq），
   * ctx 必须接着往后数 —— 编号分裂会让 job:stream 的 id 撞车，
   * 渲染层按前缀认领（JobPrefix）就会认错任务。 */
  state.jobSeq = 10;
  assert.strictEqual(ctx.nextJobSeq(), 11, '计数没有共享（两套编号会撞车）');
});

t('ctx.send：窗口不存在或已销毁时静默丢弃，不抛', () => {
  const { state, hosts } = makeHosts();
  const ctx = createIpcCtx(hosts);
  // 没有窗口
  assert.doesNotThrow(() => ctx.send('ev', { a: 1 }));
  // 窗口已销毁
  state.win = { isDestroyed: () => true, webContents: { send() { throw new Error('不该发到已销毁的窗口'); } } };
  assert.doesNotThrow(() => ctx.send('ev', { a: 1 }), '向已销毁窗口发送应当静默丢弃');
  // 正常窗口
  const sent = [];
  state.win = { isDestroyed: () => false, webContents: { send: (ev, d) => sent.push([ev, d]) } };
  ctx.send('job:stream', { id: 'z' });
  assert.deepStrictEqual(sent, [['job:stream', { id: 'z' }]]);
});

t('ctx 的访问器全部是 getter（源码层约束）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'ipc', 'ctx.js'), 'utf8');
  const code = require(path.join(ROOT, 'lib', 'src-scan')).stripComments(src);
  for (const k of ['win', 'jobs', 'isWin', 'isMac']) {
  /* 锁的是：「ctx 的访问器全部是 getter（源码层约束）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    assert.ok(new RegExp('get ' + k + '\\(\\)').test(code),
      'ctx.' + k + ' 不再是 getter —— 做成快照会让搬出去的代码永远读到构造时的值');
  }
  /* 锁的是：「ctx 的访问器全部是 getter（源码层约束）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/^\s*(win|jobs|isWin|isMac):/m.test(code),
    'ctx 里出现了普通属性形式（win/jobs/isWin/isMac 必须是 getter）');
});

/* 【这条断言在 v0.6.0 改了形态，语义没变】
 * 原来它要求 send 的函数体**逐字等于**一行：
 *     function send(ev, data) { ipcCtx.send(ev, data); }
 * 多窗口改造之后 send 多了一层：先看 ALS 上下文里有没有发起者，
 * 有就定向发给它，没有才落到 ipcCtx.send。逐字匹配自然失败。
 *
 * 要守的东西其实有两条，都不依赖版面：
 *   ① send 仍然**最终**走 ipcCtx.send —— 否则 ctx.send 就成了没人验证的
 *      死代码（这正是当初写这条断言的原因）；
 *   ② ipcCtx 必须在 send **之前**声明 —— const 有暂时性死区，
 *      反过来写会在首次调用 send 时 ReferenceError，而 node --check 看不出来。
 * 把 ① 从"逐字一行"放宽成"函数体里出现 ipcCtx.send"，② 原样保留。 */
t('main.js 的 send 仍然走 ipcCtx，且 ipcCtx 在 send 之前声明', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const code = require(path.join(ROOT, 'lib', 'src-scan')).stripComments(src);

  const sendAt = code.indexOf('function send(ev, data)');
  assert.ok(sendAt > 0, '找不到 send 的定义');
  /* 取 send 的函数体（到它自己的闭合花括号） */
  const open = code.indexOf('{', sendAt);
  let depth = 0, end = -1;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > open, 'send 的函数体括号不配平');
  const body = code.slice(open, end);
  // 锁的是：send 必须仍有 ipcCtx.send 这条兜底 —— 少了它，ctx.send 就成了
  // 没人验证过的死代码，而无调用者的分支不会在任何测试里失败。
  assert.ok(/ipcCtx\.send/.test(body), 'send 没有走 ipcCtx.send —— ctx.send 就成了没人验证过的死代码');

  const ctxDecl = code.indexOf('const ipcCtx = require');
  assert.ok(ctxDecl > 0, '找不到 ipcCtx 的构造');
  // 锁的是：ipcCtx 必须在 send 之前声明（const 暂时性死区）。
  assert.ok(ctxDecl < sendAt, 'ipcCtx 声明在 send 之后 —— 首次调用 send 必然 ReferenceError');
});

done();
