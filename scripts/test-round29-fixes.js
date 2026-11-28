'use strict';
/* 第 29 轮回归：网速测试页保活复用后的状态锁死与旧结果回写。
 *
 * 页面被 keepAlive 复用：切走时 onCleanup 把 disposed 置 true，
 * 切回来若没有 onEnter 复位，按钮会永远静默失效；而一旦复位，
 * 上一轮还在飞的 invoke 又可能把旧结果写进新页面。
 * 这里锁住“disposed + 每轮序号”的组合，避免只修一半。
 */
const assert = require('assert');
const { t, readSrc } = require('./lib/harness');

t('R29-01 测速页切回后恢复 disposed 与按钮可点', () => {
  const src = readSrc('js/tools/net-tools.js');
  const start = src.indexOf("id: 'speedtest'");
  const end = src.indexOf("id: 'download'", start);
  const seg = src.slice(start, end === -1 ? src.length : end);
  /* 锁的是：R29 发现 cleanup 只把 disposed 置 true，没有 onEnter 复位；
   * 保活页切回来按钮仍是 disabled，点 run 直接 return，用户以为测速坏了。 */
  assert.ok(/App\.onEnter\(\(\) => \{[\s\S]{0,220}disposed = false;[\s\S]{0,160}downBtn\.disabled = upBtn\.disabled = false;/
    .test(seg), '测速页没有在 onEnter 复位 disposed 和按钮');
});

t('R29-02 测速离开时递增轮次，旧 invoke 不能写回新页面', () => {
  const src = readSrc('js/tools/net-tools.js');
  const start = src.indexOf("id: 'speedtest'");
  const end = src.indexOf("id: 'download'", start);
  const seg = src.slice(start, end === -1 ? src.length : end);
  /* 锁的是：cleanup 里 disposed=true 会被 onEnter 复位；若不递增序号，
   * 切走前发出的 SPEEDTEST 返回时会把旧速度写进刚切回来的页面。 */
  assert.ok(/App\.onCleanup\(\(\) => \{[\s\S]{0,220}speedRunSeq\+\+/.test(seg), 'cleanup 没有作废在飞测速');
  assert.ok(/const myRun = \+\+speedRunSeq;/.test(seg), 'run 没有领本轮序号');
  /* 锁的是：旧 await 返回后不判序号，会把上一轮测速结果写进新页面。 */
  assert.ok(/if \(disposed \|\| myRun !== speedRunSeq\) return;/.test(seg), '旧测速返回后没有判废');
});

t('R29-03 旧测速的流事件与 finally 不碰当前轮', () => {
  const src = readSrc('js/tools/net-tools.js');
  const start = src.indexOf("id: 'speedtest'");
  const end = src.indexOf("id: 'download'", start);
  const seg = src.slice(start, end === -1 ? src.length : end);
  /* 锁的是：旧轮的 job:stream 仍可能在新一轮开始后到达；若不过滤，
   * 会把旧 samples 画到新曲线上，甚至把新 jobId 当成自己的。 */
  assert.ok(/if \(myRun !== speedRunSeq \|\| disposed\) \{/.test(seg), '流事件没有按轮次过滤');
  /* 锁的是：旧轮 finally 若无条件 unsub，会把用户刚发起的新测速订阅退掉。 */
  assert.ok(/if \(myRun === speedRunSeq\) \{[\s\S]{0,220}unsub = null;/.test(seg),
    '旧轮 finally 会误退当前轮订阅');
});

t('R29-04 旧轮 finally 不重新点亮当前轮的按钮', () => {
  const src = readSrc('js/tools/net-tools.js');
  const start = src.indexOf("id: 'speedtest'");
  const end = src.indexOf("id: 'download'", start);
  const seg = src.slice(start, end === -1 ? src.length : end);
  /* 锁的是：切页/重新发起后旧轮才 finally，若无条件复位 disabled=false，
   * 会在新测速进行中把按钮点亮，用户可再次并发。 */
  assert.ok(/if \(myRun === speedRunSeq && !disposed\) \{ downBtn\.disabled = upBtn\.disabled = false; \}/.test(seg),
    '旧轮 finally 会无条件恢复按钮');
});

t('R29-05 工具链离开页面后不再启动下一步', () => {
  const src = readSrc('js/tools/chain.js');
  /* 锁的是：工具链 cleanup 只递增序号，原 runChain 会把整条链继续跑完，
   * 用户切走后仍在批量改文件；现在每个步骤开始前检查 shouldStop。 */
  assert.ok(/async function runChain\(chain, files, onProgress, shouldStop\)/.test(src),
    'runChain 没有接收停止判据');
  /* 锁的是：判据命中时要立刻返回部分报告并标 canceled，不能继续下一步。 */
  assert.ok(/if \(shouldStop && shouldStop\(\)\) \{[\s\S]{0,120}canceled: true/.test(src),
    'runChain 没有在步骤边界停止');
});

t('R29-06 工具链把页面序号作为停止判据传进去', () => {
  const src = readSrc('js/tools/chain.js');
  /* 锁的是：只给 runChain 加参数、UI 不传，等于没接。
   * 页面 cleanup 已递增 chainRunSeq，这里必须把它变成 shouldStop。 */
  assert.ok(/\(\) => runToken !== chainRunSeq/.test(src), 'UI 没有把离开页面传给 runChain');
});

t('R29-07 旧轮进度回调不再写回复用页面', () => {
  const src = readSrc('js/tools/chain.js');
  /* 锁的是：cleanup 清掉进度行后，仍在飞的当前步骤会继续 onProgress；
   * 回调不判序号的话，切回来的页面会停在一句过期的“第 X 步”上。 */
  assert.ok(/if \(runToken !== chainRunSeq\) return;[\s\S]{0,120}progressLine\.textContent/.test(src),
    '旧进度回调仍会写进度行');
});

require('./lib/harness').done();
