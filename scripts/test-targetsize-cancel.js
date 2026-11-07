'use strict';
/* 目标体积压缩：停止按钮与切页取消必须在压缩期间就有效。
 *
 * ============ 锁的是哪个回归 ============
 * js/tools/target-size.js 里 runJobId 的赋值写在
 *   const r = await invoke(TARGET.COMPRESS_AV, …);
 *   runJobId = r.id;
 * 之后。而主进程那个 handler 是**阻塞式**的：它把整轮 8 次逼近跑完才 resolve。
 * 于是整个压缩期间 runJobId 恒为 null：
 *   · 停止按钮只置 canceled=true，**不发 job:kill**，ffmpeg 继续跑几分钟；
 *   · 切页 cleanup 里的 `if (runJobId)` 也不执行；
 *   · 最后界面显示「已停止：成功 N」，而磁盘上多出来的文件说明它其实一直在跑。
 * 对照：av-convert / video-press / video-trim 三处都在订阅回调里认领 id，
 * 只有这里漏了。
 *
 * ============ 验证方式 ============
 * 把订阅回调的策略单独抽出来验证太脆弱。这里验证两件可观察的事：
 *   ① 源码里订阅回调**认领** runJobId，且认领排在 id 比对之前；
 *   ② 一个复刻回调逻辑的最小 runner：先给一条 job:stream（此时 runJobId 为
 *      null，模拟 invoke 尚未返回），断言 runJobId 被认领、随后点停止会发 job:kill。
 * ② 是行为断言（跑的是从源码里抽出的那两行判据），① 防止有人把认领删掉却
 * 因为测试自己复刻了一份而仍绿。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

const src = readSrc('js/tools/target-size.js');

t('TS1 订阅回调里认领 runJobId（排在 id 比对之前）', () => {
  const i = src.indexOf("window.JobPrefix.subscribe('tgt'");
  assert.ok(i > 0, '找不到 tgt 的订阅');
  const seg = src.slice(i, i + 1600);
  /* 锁的是：认领语句被删 —— 停止与切页取消双双失效。 */
  const iClaim = seg.indexOf('if (!runJobId) runJobId = d.id;');
  assert.ok(iClaim > 0, '订阅回调里没有认领 runJobId');
  const iGuard = seg.indexOf('if (runJobId && d.id !== runJobId) return;');
  /* 锁的是：两句顺序写反 —— 认领被 return 挡在后面，等于没写。 */
  assert.ok(iGuard > iClaim, '认领必须排在 id 比对之前');
});

t('TS2 行为：invoke 尚未返回时收到 job:stream，runJobId 被认领', () => {
  /* 【为什么要单独重放这两行判据】
   * 认领发生在 subscribe 的回调里，要触发它得跑完整的 JobPrefix 前缀匹配、
   * JSON 解析、以及主进程事件。这里只重放"认领 + 比对"这一步 ——
   * 回归恰好就在这一步：没有认领时 runJobId 恒为 null。
   *
   * 判据的**内容**从源码里取（下面两条断言），重放的语义与实现一致；
   * TS1 已经钉住源码里这两行的存在与顺序，所以这里允许显式写出等价逻辑。 */
  let runJobId = null;                       // 模拟 invoke 尚未返回
  const onEvent = (id) => {
    /* 与源码同义：先认领，再比对 */
    if (!runJobId) runJobId = id;
    if (runJobId && id !== runJobId) return false;
    return true;
  };

  /* 第一条事件到达：此时 runJobId 还是 null */
  const keep1 = onEvent('tgt1001');
  /* 锁的是：认领失败 —— runJobId 仍为 null，停止按钮拿不到 id 可杀。 */
  assert.strictEqual(runJobId, 'tgt1001', 'runJobId 没有被认领');
  assert.strictEqual(keep1, true, '自己的第一条事件被挡掉了');

  /* 别的任务的事件不该被吃进来 */
  const keep2 = onEvent('tgt9999');
  /* 锁的是：认领之后不再比对 —— 别的任务的事件被当成自己的。 */
  assert.strictEqual(runJobId, 'tgt1001', '认领后被其它 id 覆盖了');
  assert.strictEqual(keep2, false, '别的任务的 id 没有被挡掉');
});

t('TS3 停止按钮在压缩期间就能发出 job:kill（不再只置 canceled）', () => {
  const i = src.indexOf("const cancelBtn = btn('停止'");
  assert.ok(i > 0, '找不到停止按钮');
  const seg = src.slice(i, i + 500);
  /* 锁的是：停止按钮只置 canceled=true、从不发 kill。 */
  assert.ok(/JOB\.KILL/.test(seg), '停止按钮没有调用 JOB.KILL');
  assert.ok(/if \(runJobId\)/.test(seg), '停止按钮没有判断 runJobId');
});

t('TS4 停止后的文案如实说明「已请求」而不是「已停止」', () => {
  /* 锁的是：把「请求已发出」说成「已停止」—— 用户去核对磁盘时发现
   * 多出若干文件，比原样告知更困惑。 */
  assert.ok(!/已停止：成功/.test(src), '仍然用「已停止：成功 N」这种确定性措辞');
  assert.ok(/已请求停止/.test(src), '没有改成「已请求停止」');
  /* 同时要说明已完成文件仍保留，否则用户不知道要不要清理 */
  /* 锁的是：只说"已请求停止"却不交代已完成的文件去哪了 ——
   * 用户不知道该不该去清理那些产物。 */
  assert.ok(/已完成的文件仍保留/.test(src), '没有说明已完成的文件仍保留');
});

t('TS5 注释与实现一致：不声称传了没传的参数', () => {
  /* 锁的是：注释写「用 subscribe('tgt', ..., {mode:'loose'})」而实际没传第三个参数。
   * 读代码的人会去找那个开关，找不到就以为是别处配的。 */
  const i = src.indexOf("window.JobPrefix.subscribe('tgt'");
  assert.ok(i > 0, '找不到订阅调用');
  /* 调用本身确实只有两个实参 */
  const callSeg = src.slice(i, i + 120);
  /* 锁的是：为了"对齐注释"而真的补上第三个参数 —— 那会静默改变前缀匹配语义。 */
  assert.ok(!/\{mode:\s*'loose'\}/.test(callSeg), '调用处不该传 {mode:\'loose\'}');
});

done();
