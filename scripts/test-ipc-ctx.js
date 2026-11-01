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
    assert.ok(new RegExp('get ' + k + '\\(\\)').test(code),
      'ctx.' + k + ' 不再是 getter —— 做成快照会让搬出去的代码永远读到构造时的值');
  }
  assert.ok(!/^\s*(win|jobs|isWin|isMac):/m.test(code),
    'ctx 里出现了普通属性形式（win/jobs/isWin/isMac 必须是 getter）');
});

t('main.js 的 send 走 ipcCtx，且 ipcCtx 在 send 之前声明', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const code = require(path.join(ROOT, 'lib', 'src-scan')).stripComments(src);
  const sendDecl = code.indexOf('function send(ev, data) { ipcCtx.send(ev, data); }');
  assert.ok(sendDecl > 0, 'send 没有走 ipcCtx.send —— ctx.send 就成了没人验证过的死代码');
  const ctxDecl = code.indexOf('const ipcCtx = require');
  assert.ok(ctxDecl > 0, '找不到 ipcCtx 的构造');
  /* const 有暂时性死区：声明在 send 之后就 ReferenceError，而 node --check 看不出来 */
  assert.ok(ctxDecl < sendDecl, 'ipcCtx 声明在 send 之后 —— 首次调用 send 必然 ReferenceError');
});

done();
