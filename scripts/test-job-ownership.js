'use strict';
/* 任务归属与长任务切页清理。
 *
 * 11) dir-move / ffmpeg-setup 切页后仍跑、完成提示串到别的页面
 * 15) job:kill 没有归属校验；十余处火后不理的 spawn 没有 error 监听
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t, done, readSrc, readMain } = require('./lib/harness');

/* ============ 15a) OwnerJobMap.cancelIfOwnedBy ============ */
const { OwnerJobMap } = require(path.join(__dirname, '..', 'lib', 'job-owner'));

t('JO1 归属不同的窗口不能取消别人的任务', () => {
  /* 锁的是：job:kill 原来直接 jobs.get(id).cancel() ——
   * v0.6.0 多窗口之后，A 窗口拿到 B 的 job id 就能杀掉它的任务。 */
  const ownerA = 101, ownerB = 202;
  const jobs = new OwnerJobMap(() => ownerA);   // 任务由 A 发起
  let killed = false;
  jobs.set('job7', { cancel() { killed = true; } });

  const r = jobs.cancelIfOwnedBy('job7', ownerB);
  /* 锁的是：不比对归属 —— B 把 A 的任务杀了。 */
  assert.strictEqual(killed, false, 'B 窗口竟然取消了 A 的任务');
  assert.strictEqual(r.ok, false, '跨归属取消不该返回成功');
  assert.strictEqual(r.reason, 'not-owner', '没有给出 not-owner 原因');
});

t('JO2 归属相同的窗口可以取消自己的任务', () => {
  /* 锁的是：为了安全把归属判得过头 —— 自己的任务也取消不掉。 */
  const jobs = new OwnerJobMap(() => 101);
  let killed = false;
  jobs.set('job8', { cancel() { killed = true; } });
  const r = jobs.cancelIfOwnedBy('job8', 101);
  assert.strictEqual(killed, true, '自己的任务取消不掉');
  assert.strictEqual(r.cancelled, true);
});

t('JO3 不存在的 id 与"存在但没取消"要能区分', () => {
  /* 锁的是：对任何 id 都返回 true —— 调用方分不清"我取消了"和"我什么都没做"。 */
  const jobs = new OwnerJobMap(() => 101);
  const r = jobs.cancelIfOwnedBy('nope', 101);
  /* 锁的是：不存在的 id 报成"已取消"。 */
  assert.strictEqual(r.cancelled, false, '不存在的 id 被报成已取消');
  assert.strictEqual(r.ok, true, '不存在的 id 不该报成越权');
});

t('JO4 无调用者（null）时托盘/定时任务仍可取消', () => {
  /* 锁的是：把 null 一律拒绝 —— 托盘发起的任务永远取消不掉。 */
  const jobs = new OwnerJobMap(() => null);   // 托盘发起
  let killed = false;
  jobs.set('job9', { cancel() { killed = true; } });
  const r = jobs.cancelIfOwnedBy('job9', null);
  assert.strictEqual(r.cancelled, true, '托盘任务取消不掉');
  assert.strictEqual(killed, true);
});

t('JO5 main.js 的 job:kill 走 cancelIfOwnedBy', () => {
  const src = readMain({ raw: true });
  const i = src.indexOf('handle(CH.JOB.KILL');
  assert.ok(i > 0, '找不到 job:kill');
  const seg = src.slice(i, i + 1200);
  /* 锁的是：handler 里又退回裸 jobs.get(id).cancel()。 */
  assert.ok(/cancelIfOwnedBy/.test(seg), 'job:kill 没有走归属校验');
  /* 锁的是：取调用者时把 sender 拿错（例如用了 e.sender 而不是 ALS 上下文）——
   * exec:stream 这类 spawn 回调里的 e 可能已经失效。 */
  assert.ok(/als\.getStore\(\)/.test(seg), '没有从 ALS 取调用者');
});

t('JO6 相邻注释不再声称"带归属校验"却又没有校验', () => {
  const src = readMain({ raw: true });
  const i = src.indexOf('job:cancel-latest 已移除');
  assert.ok(i > 0, '找不到那段注释');
  const seg = src.slice(i, i + 500);
  /* 锁的是：注释说"带归属校验"而实现没有 —— 读代码的人会被误导。 */
  assert.ok(/cancelIfOwnedBy|归属校验/.test(seg), '注释与实现脱节');
});

/* ============ 15b) spawn 必须挂 error 监听 ============ */
t('JO7 火后不理的 taskkill/shutdown 都走 spawnDetached（挂了 error 监听）', () => {
  /* 锁的是：裸 spawn('taskkill'/'shutdown') 在没有 error 监听时，
   * spawn 失败会升级成 uncaughtException —— 写进 crash-log、
   * 还把下次启动标成「上次异常退出」。 */
  /* 【判据要剥掉注释】
   * 助手自己的说明里就写着 `spawn('taskkill', …)` 这个示例，
   * 那是文档不是调用。用 readSrc/readMain 的剥注释版本做判断 ——
   * 直接扫原文会把注释里的示例当成漏改点。 */
  /* 【不能复用模块顶部的 readMain() 结果】
   * readMain 在 harness 里是带缓存的（同一进程内多次调用返回同一份），
   * 而这个文件顶部已经调用过它 —— 拿到的是"本轮修改之前"的快照。
   * 这里必须重新从磁盘读。 */
  const stripComments = require('../lib/src-scan').stripComments;
  const clean = stripComments(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'));
  const bare = [];
  const re = /spawn\('(taskkill|shutdown)'/g;
  let m;
  while ((m = re.exec(clean))) {
    /* 【报告匹配到的原文，不报行号】
     * readMain() 默认会剥注释，行号与磁盘上的文件对不上（实测差几百行），
     * 报出来的行号反而误导。直接贴出上下文，一眼能看出是哪一处。 */
    bare.push(clean.slice(Math.max(0, m.index - 40), m.index + 80).replace(/\s+/g, ' '));
  }
  /* 锁的是：漏改一处 —— 那一处仍然会把失败变成崩溃。 */
  assert.deepStrictEqual(bare, [], '这些地方还在裸 spawn：\n' + bare.join('\n'));
  /* 助手本身要真的挂了监听并 unref */
  /* 【助手已搬到 lib/spawn-detached.js】
   * 搬家的原因：ipc/media-ffmpeg.js 里另有 6 处 taskkill 是同样的形态，
   * 而它拿不到 main.js 里的局部函数 —— 只在这里修就成了「修了一半」。
   * 所以断言改成去 lib/ 找实现，而不是在 main.js 里找那段源码。
   * 详细的整树审计交给 scripts/test-spawn-detached.js。 */
  /* 锁的是：助手只包了 try/catch，没挂 error 监听 —— 异步的错误仍然会崩。 */
  const helperSrc = readSrc('lib/spawn-detached.js');
  assert.ok(helperSrc.length > 0, '找不到 lib/spawn-detached.js');
  /* 锁的是：助手只包了 try/catch，没挂 error 监听 —— 异步 emit 的错误仍然会崩。 */
  assert.ok(/\.on\('error'/.test(helperSrc), 'spawnDetached 没有挂 error 监听');
  /* 锁的是：没 unref —— 子进程拖住主进程退出。 */
  assert.ok(/\.unref\(\)/.test(helperSrc), 'spawnDetached 没有 unref');
  /* 锁的是：main.js 里又自己写了一份 spawnDetached（两份实现会分叉）。 */
  assert.ok(!/function spawnDetached\(/.test(clean), 'main.js 里又内联了一份 spawnDetached');
});

/* ============ 11) 切页清理 ============ */
t('CL1 dir-move 在 render 同步阶段注册 App.onCleanup', () => {
  const src = readSrc('js/tools/dir-move.js');
  const i = src.indexOf('render(page) {');
  assert.ok(i > 0, '找不到 dir-move 的 render');
  const head = src.slice(i, i + 1600);
  /* 锁的是：整个文件没有任何 cleanup —— 阻塞式 DIR_MOVE.MOVE 切页后还在跑，
   * 完成 toast 弹在新页面上。 */
  assert.ok(/App\.onCleanup\(/.test(head), 'dir-move 没有注册切页清理');
  /* 并且必须在 render 的同步阶段（不是点击后的 await 之后） */
  const iClean = head.indexOf('App.onCleanup(');
  const iAwait = head.indexOf('await ');
  /* 锁的是：注册写在 await 之后 —— 那时已经是新页面的生命周期，等于没挂。 */
  assert.ok(iAwait < 0 || iClean < iAwait, '清理注册排在第一个 await 之后');
});

t('CL2 dir-move 的 cleanup 会退订并请求停止任务', () => {
  const src = readSrc('js/tools/dir-move.js');
  const i = src.indexOf('App.onCleanup(');
  const seg = src.slice(i, i + 700);
  /* 锁的是：只退订、不请求停止 —— 主进程那棵树继续复制。 */
  assert.ok(/JOB\.KILL/.test(seg), 'cleanup 没有发 JOB.KILL');
  /* 锁的是：只 kill 不退订 —— 已销毁的页面继续收事件。 */
  assert.ok(/runUnsub\(\)/.test(seg), 'cleanup 没有退订订阅');
});

t('CL3 ffmpeg-setup 的下载订阅在切页时可回收', () => {
  const src = readSrc('js/tools/media/ffmpeg-setup.js');
  /* 锁的是：unsub 只在 try/finally 里退订，用户中途切页时 finally 还没执行，
   * 订阅留在原地，之后每个后台任务的 pct 都去改一个不在页面上的进度条。 */
  assert.ok(/App\.onCleanup\(/.test(src), 'ffmpeg-setup 没有切页清理');
  const i = src.indexOf('App.onCleanup(');
  const seg = src.slice(i, i + 400);
  /* 锁的是：清理函数是空的（只写了个壳）。 */
  assert.ok(/dlUnsub/.test(seg), 'cleanup 没有回收下载订阅');
});

t('CL4 清理用的句柄是外层闭包变量（点击流程只更新它）', () => {
  const src = readSrc('js/tools/dir-move.js');
  /* 锁的是：句柄声明在点击函数内部 —— cleanup 在同步阶段就注册好了，
   * 那时根本看不到点击函数里的局部变量，只能捕捉到一个永远为 null 的副本。 */
  const i = src.indexOf('App.onCleanup(');
  const before = src.slice(Math.max(0, i - 300), i);
  /* 锁的是：句柄声明在点击函数里 —— cleanup 注册时看不到它，只能捕捉到 null 副本。 */
  assert.ok(/let\s+runUnsub\s*=\s*null/.test(before), 'runUnsub 不在 cleanup 外层');
  /* 锁的是：只把 unsub 提出来、把 claimedId 留在里面 —— 切页时发不出 JOB.KILL。 */
  assert.ok(/let\s+runClaimedId\s*=\s*null/.test(before), 'runClaimedId 不在 cleanup 外层');
});

done();
