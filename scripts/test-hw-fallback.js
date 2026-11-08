'use strict';
/* 硬件编码失败自动回退 CPU 的测试。
 *
 * ============ 锁的是哪个回归 ============
 * 硬件编码的**探测通过**只说明"这一刻能跑"。实际使用中还有几种一定会遇到的
 * 失败场景（驱动在会话中途更新、显存被别的程序吃满、睡眠唤醒后 CUDA 上下文失效、
 * 某些奇特分辨率硬件不接），它们发生时如果直接失败，用户看到的是
 * 「转换失败」——整批任务卡在一个文件上，而他并不知道换个编码器就能过。
 *
 * 更糟的一种退化：**回退时把整条参数重建，漏掉了音频/缩放/元数据等选项**。
 * 那会让"回退成功"的文件变得比原计划残缺（没声音、没缩放），而界面显示成功。
 * 所以这里既锁"必须回退"，也锁"回退只换视频编码那一段"。
 *
 * 【为什么这些用源码断言而不是行为断言】
 * 这五条讲的都是「某个调用形态必须存在」。要行为验证它们，需要构造
 * "编码进行到一半显卡掉线"这类时序，本机无法稳定复现（而且真复现出来
 * 也是驱动行为，不是代码行为）。源码断言的代价是它只锁形态不锁运行，
 * 但下面每一条都同时锁"形态 + 与之配对的另一端"（例如 isCancelled 在
 * 定义处必须被传进去），单改一处仍会红。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

const SRC = readSrc('ipc/media-ffmpeg.js');

/* 锁的是回归「硬件失败直接放弃」。回退逻辑必须真实存在且被 PRESS 用上。 */
t('R1 PRESS 必须通过 runEncodeWithFallback 跑，而不是裸 spawn', () => {
  /* 锁的是：v0.6.8 引入硬件加速后又退回"裸 spawn"的改动。
   * 判据是"PRESS 的 handler 体里出现 runEncodeWithFallback 调用"，
   * 因为裸 spawn 没有任何回退能力，一旦硬件编码失败就是整批失败。 */
  const start = SRC.indexOf('handle(CH.FFMPEG.PRESS');
  assert.ok(start >= 0, '找不到 PRESS handler');
  const end = SRC.indexOf('handle(CH.FFMPEG.FRAMES', start);
  const body = SRC.slice(start, end > 0 ? end : start + 12000);
  /* 锁的是：回退入口被整个删掉（那样硬件失败 = 整批失败）。 */
  assert.ok(/runEncodeWithFallback\s*\(/.test(body),
    'PRESS 没有走 runEncodeWithFallback —— 硬件编码失败时会整批失败，用户只看到「转换失败」');
  /* 锁的是：新旧两条路径并存（回退接上了但旧的裸 spawn 没删）。
   * 并存时哪个生效取决于代码顺序，是最难查的一类。 */
  assert.ok(!/spawn\(ffmpeg,\s*args/.test(body),
    'PRESS 里还有裸 spawn(ffmpeg, args)，说明回退路径没接上或没删干净');
});

/* 锁的是回归「回退时整条重建，漏参数」。
 * 判据：buildArgs 是个函数且被调用两次（一次硬件、一次 CPU），
 * 而不是把参数数组直接内联平铺。 */
t('R2 回退时必须复用同一个参数构造器（否则会丢音频/缩放/元数据）', () => {
  /* 锁的是：把 buildArgs 拆开写成两份参数拼接 —— 两份必然漂移，
   * 实测踩过同类（音频 96k 分支只在一个地方加了）。 */
  const start = SRC.indexOf('handle(CH.FFMPEG.PRESS');
  const end = SRC.indexOf('handle(CH.FFMPEG.FRAMES', start);
  const body = SRC.slice(start, end > 0 ? end : start + 12000);
  /* 锁的是：参数构造器被内联化（回退路径就必然漏项）。 */
  assert.ok(/const buildArgs\s*=\s*\(/.test(body), '缺少 buildArgs 构造器');
  /* 锁的是：rebuildCpu 自己拼一串而不是复用构造器（漏音频/缩放）。 */
  assert.ok(/rebuildCpu:\s*\(\)\s*=>[\s\S]{0,400}?return buildArgs\(/.test(body),
    'rebuildCpu 没有复用 buildArgs —— 回退后的文件可能缺音频/缩放/元数据');
  /* 锁的是：CPU 回退参数把硬件编码器名原样再传一遍（必失败）。 */
  assert.ok(/const cpuName = opts\.vcodec === 'libx265' \? 'libx265' : 'libx264'/.test(body),
    'CPU 回退没有显式指定 CPU 编码器名');
});

/* 锁的是回归「用户取消后又用 CPU 跑一遍」。
 * 这是最让人困惑的一种：点了取消，风扇反而转起来。 */
t('R3 已取消时不得回退（否则点了取消反而开始 CPU 编码）', () => {
  /* 锁的是：取消判断被删掉或写错方向。源码断言是因为触发它需要
   * "编码中途点取消且恰好硬件失败"这个时序，行为测试无法稳定构造。 */
  assert.ok(/if\s*\(o\.isCancelled && o\.isCancelled\(\)\)\s*return/.test(SRC),
    'runEncodeWithFallback 里缺少"已取消则不回退"的短路');
  /* 锁的是：短路写对了但调用方没传 isCancelled —— 短路永远不触发，
   * 等于白写。这一条和上一条必须成对存在才有意义。 */
  assert.ok(/isCancelled:\s*\(\)\s*=>\s*state\.cancel/.test(SRC),
    'PRESS 没有把 isCancelled 接上 state.cancel —— 取消后仍会回退跑一遍');
});

/* 锁的是性能/正确性边界：只回退一次。
 * 二次回退意味着"CPU 也失败了"，那时重试只是让用户多等一遍。 */
t('R4 只回退一次（CPU 也失败时不再重试）', () => {
  /* 锁的是：有人"顺手"加个循环重试导致 CPU 失败时反复重跑。
   * 判据：once() 的调用次数恒定是 2（硬件 + CPU）。重试必然体现为第三次。
   * 【为什么不用"有没有 for/while"当判据】函数体里本来就有
   * `for (const line of lines)` 在遍历进度输出 —— 那是解析不是重试。
   * 本轮就因此误报过一次，改成数 once() 的调用次数才准。 */
  const start = SRC.indexOf('async function runEncodeWithFallback');
  assert.ok(start >= 0, '找不到 runEncodeWithFallback');
  const end = SRC.indexOf('async function videoEncodeArgs', start);
  const body = SRC.slice(start, end > 0 ? end : start + 4000);
  /* 锁的是：加了"重试一次"之类的循环后，CPU 也失败时会反复重跑，
   * 用户白等好几遍。count 恒定 2 才是"只回退一次"。 */
  const onceCalls = (body.match(/await once\(/g) || []).length;
  assert.strictEqual(onceCalls, 2,
    'runEncodeWithFallback 里应有且仅有 2 次 once() 调用（硬件 + CPU 回退），实际 ' + onceCalls);
  /* 锁的是：改成自我递归（那是无限回退，比不重试更糟）。 */
  assert.ok(!/runEncodeWithFallback\s*\(/.test(body.replace(/async function runEncodeWithFallback/, '')),
    'runEncodeWithFallback 内部又调用了自己 —— 会无限回退');
});

/* 锁的是可观测性：回退必须通知界面。
 * 否则用户开硬件加速 → 硬件挂了 → 悄悄用 CPU 慢慢跑 →
 * 用户以为"硬件加速这么慢"，而真相是它没生效。 */
t('R5 回退时必须给界面发通知（不能静默降级）', () => {
  /* 锁的是：notice 被删掉后用户无法区分"硬件在跑"和"已降级到 CPU"。 */
  assert.ok(/notify:\s*\(\)\s*=>\s*send\('job:stream'/.test(SRC),
    '回退时没有 notify，界面无从得知已降级到 CPU');
  /* 锁的是：通知发了但前端认不出（标记名对不上等于没发）。 */
  assert.ok(/notice:\s*'hw-fallback'/.test(SRC),
    '缺少 hw-fallback 通知标记，前端无法据此提示"已改用 CPU"');
  /* 锁的是：结果里把 CPU 跑的算成硬件跑（用户以为加速生效了）。 */
  assert.ok(/encoder:\s*r\.fellBack\s*\?/.test(SRC),
    '结果里没有如实记录回退后的编码器（会把 CPU 跑的算成硬件）');
});

/* 锁的是回归「job 句柄登记被推到 await 之后」。
 * 本轮真踩：给 TRIM 接入 hardware 加速时，新的 await 插在了 jobs.set 之前，
 * 调用方拿到 id 时句柄还不存在 → 点取消没反应 → test-video-trim 红。 */
t('R6 TRIM 的 jobs.set 必须在第一个 await 之前（否则取消按钮失效）', () => {
  /* 锁的是：又一次在 id 登记前插入 await。这类回归没有行为断言的替代：
   * test-video-trim 的取消用例虽然能抓到，但它依赖"取消恰好落在编码期间"
   * 的时序，在快机器上会偶发通过。源码顺序断言是稳定的那道门。 */
  const start = SRC.indexOf('handle(CH.FFMPEG.TRIM');
  assert.ok(start >= 0, '找不到 TRIM handler');
  const end = SRC.indexOf('handle(CH.', start + 10);
  const body = SRC.slice(start, end > 0 ? end : start + 9000);
  /* 去掉注释再比位置：注释里会出现 await 字样，直接 indexOf 会误判 */
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const idPos = stripped.indexOf("const id = 'vtr'");
  const awaitPos = stripped.search(/await\s+/);
  assert.ok(idPos >= 0, 'TRIM 里找不到 job id 的声明');
  assert.ok(awaitPos < 0 || idPos < awaitPos,
    'TRIM 的 job id 声明出现在第一个 await 之后 —— 调用方拿到 id 时句柄还没登记，点取消会没反应');
  /* 句柄必须真的登记，不只是有个 id */
  const setPos = stripped.indexOf('jobs.set(id');
  assert.ok(setPos >= 0 && setPos < awaitPos,
    'jobs.set 在第一个 await 之后，同样会让取消失效');
});

done();
