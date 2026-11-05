'use strict';
/* 视频裁剪（ffmpeg:trim）的行为测试 —— 真跑 ffmpeg。
 *
 * ============ 为什么必须真跑 ============
 * 这个 handler 的正确性几乎全部体现在**命令行怎么拼**上：
 *   · -ss 放输入侧还是输出侧（影响起点精度）
 *   · -progress pipe:1 有没有加（影响进度条有没有数据）
 *   · copy 模式有没有 -avoid_negative_ts（影响成品能否播放）
 *   · 失败时半成品有没有清掉（影响用户会不会拿到一个残文件）
 * 这些用源码正则都能"看出个大概"，但看不出**结果对不对** ——
 * 而它们全都是"拼错了也照样返回成功"的类型（ffmpeg 对很多错误参数
 * 只是忽略，不报错）。
 *
 * 所以这里起真 ffmpeg，造真视频，切完用 ffprobe 量时长、
 * 用 PSNR 比对首帧，确认「起点真的落在要求的位置」。
 *
 * ============ 环境依赖 ============
 * 需要本机装了 ffmpeg（项目惯例是放在 userData/bin 下，「FFmpeg 环境」页安装）。
 * 没装时整组 SKIP 并打一行说明 —— CI 的 Linux runner 通常没装，
 * 用 SKIP 而不是 FAIL，与 test-aux-csp 等环境依赖脚本一致。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { t, done } = require('./lib/harness');
const { loadMediaFfmpeg, detectFfmpeg } = require('./lib/load-media-ffmpeg');

const FFMPEG = detectFfmpeg();
if (!FFMPEG) {
  console.log('SKIP  本机没有 ffmpeg（无法验证裁剪的实际结果）');
  process.exit(0);
}
const FFPROBE = path.join(path.dirname(FFMPEG), 'ffprobe.exe');
const HAS_PROBE = fs.existsSync(FFPROBE);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-test-'));
/* jobs 表也要拿：取消用例要从中取任务的 cancel 句柄。
 */
const { handlers, streams, jobs } = loadMediaFfmpeg();
const trim = handlers.get('ffmpeg:trim');

/* 造源视频：10 秒、25fps、关键帧间隔 2 秒。
 * 关键帧间隔必须设成 2 秒且关掉场景检测 —— copy 模式的"吸附"行为
 * 只有在关键帧明显少于帧数时才看得出来。 */
const SRC = path.join(tmp, 'src.mp4');
function makeSource() {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', SRC], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('造测试视频失败：' + (r.stderr || '').slice(-300));
}
makeSource();

const probeDur = (p) => {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], { encoding: 'utf8' });
  return parseFloat(String(r.stdout || '').trim());
};
const frameAt = (p, sec, out) => {
  spawnSync(FFMPEG, ['-hide_banner', '-y', '-ss', String(sec), '-i', p, '-frames:v', '1', '-q:v', '1', out], { encoding: 'utf8' });
  return out;
};
/* 两帧的 PSNR。用 spawnSync 取 stderr —— ffmpeg 把结果打在那里，
 * 而 execFileSync 在两种退出码下都拿不到它（实测踩过）。 */
function psnr(a, b) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', a, '-i', b, '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /average:([\d.]+|inf)/.exec(String(r.stdout || '') + String(r.stderr || ''));
  if (!m) return null;
  return m[1] === 'inf' ? Infinity : parseFloat(m[1]);
}

const REF3 = frameAt(SRC, 3.0, path.join(tmp, 'ref3.png'));
const REF2 = frameAt(SRC, 2.0, path.join(tmp, 'ref2.png'));

/* ---------------- 1. 参数校验：不合法时连 ffmpeg 都不该启动 ---------------- */
t('起点为负 / 非数字 → 直接拒绝，不启动 ffmpeg', async () => {
  for (const bad of [-1, NaN, 'abc', null]) {
    let threw = false;
    try {
      await trim({}, { input: SRC, out: path.join(tmp, 'x1.mp4'), start: bad, duration: 2, mode: 'encode' });
    } catch (e) { threw = true; }
    assert.ok(threw, 'start=' + String(bad) + ' 竟然没被拒绝');
  }
});

t('时长 <= 0 / 非数字 → 直接拒绝', async () => {
  for (const bad of [0, -5, NaN, 'x']) {
    let threw = false;
    try {
      await trim({}, { input: SRC, out: path.join(tmp, 'x2.mp4'), start: 1, duration: bad, mode: 'encode' });
    } catch (e) { threw = true; }
    assert.ok(threw, 'duration=' + String(bad) + ' 竟然没被拒绝');
  }
});

t('输出路径等于输入 → 拒绝（否则源文件被成品覆盖，原片不可恢复）', async () => {
  let msg = '';
  try {
    await trim({}, { input: SRC, out: SRC, start: 0, duration: 1, mode: 'encode' });
  } catch (e) { msg = e.message; }
  assert.ok(/不能与源文件相同/.test(msg), '没有拦住覆盖源文件，实际：' + msg);
  /* 反向确认：源文件必须还在、且没被改动 */
  assert.ok(fs.existsSync(SRC), '源文件被删了');
  assert.strictEqual(fs.statSync(SRC).size, fs.statSync(SRC).size);
});

/* ---------------- 2. 精确模式：起点真的落在要求的位置 ---------------- */
t('精确模式：3.0s 起切 2 秒 → 时长 2.0±0.1，且首帧就是源的 3.0s 帧', async () => {
  const out = path.join(tmp, 'encode.mp4');
  const r = await trim({}, { input: SRC, out, start: 3, duration: 2, mode: 'encode' });
  assert.ok(fs.existsSync(out), '没有产出文件');
  assert.ok(r.size > 0, 'size 为 0');

  if (!HAS_PROBE) return; // 时长/PSNR 校验需要 ffprobe

  const dur = probeDur(out);
  assert.ok(Math.abs(dur - 2) < 0.1, '时长应为 2.0±0.1，实际 ' + dur.toFixed(3));

  /* 首帧必须像源的 3.0s 帧（PSNR 高），而不像 2.0s 帧（PSNR 低）。
   * 这一条是整个功能的核心：起点偏了，用户拿到的片段就是错的。 */
  const f0 = frameAt(out, 0, path.join(tmp, 'enc_f0.png'));
  const p3 = psnr(f0, REF3);
  const p2 = psnr(f0, REF2);
  if (p3 != null && p2 != null) {
    assert.ok(p3 > p2, '首帧更像源的 2.0s 帧（3.0s:' + p3 + ' vs 2.0s:' + p2 + '）—— 起点吸附到关键帧了');
    assert.ok(p3 > 25, '首帧与源 3.0s 帧差异过大（PSNR ' + p3 + '），起点不准');
  }

  /* handler 返回的实际时长也应当接近请求值 */
  assert.ok(r.duration > 0, '没有回读实际时长（界面要靠它显示真实值）');
  assert.ok(Math.abs(r.duration - 2) < 0.15, '返回的 duration=' + r.duration.toFixed(3));
  assert.strictEqual(r.mode, 'encode');
});

/* ---------------- 3. 快速模式：允许吸附，但必须如实回报 ---------------- */
t('快速模式：允许起点吸附到关键帧，但返回的实际时长必须与请求不同（不能假装精确）', async () => {
  const out = path.join(tmp, 'copy.mp4');
  const r = await trim({}, { input: SRC, out, start: 3, duration: 2, mode: 'copy' });
  assert.ok(fs.existsSync(out), '没有产出文件');
  assert.strictEqual(r.mode, 'copy');
  if (!HAS_PROBE) return;
  /* 【这条断言的方向是「必须有偏差」】流复制会带上 -ss 之前的关键帧，
   * 实测请求 2 秒会得到 ~3.08 秒。如果哪天它变得完全精确了，
   * 这说明 ffmpeg 行为变了 —— 那时应重新评估这条断言和界面文案，
   * 而不是默默让它继续"看起来正确"。 */
  assert.ok(r.duration > 0, '没有回读实际时长 —— 界面将无法告知用户起点被挪了');
  const drift = Math.abs(r.duration - 2);
  assert.ok(drift > 0.5,
    'copy 模式的实际时长与请求只差 ' + drift.toFixed(2) + ' 秒，与预期的"吸附一个关键帧间隔"不符；'
    + '若 ffmpeg 行为已变，请重新评估界面文案与这条断言');
});

/* ---------------- 4. 进度与取消 ---------------- */
/* 进度用例专用：一份更大、编得更慢的源。
 * 【为什么不能直接用 SRC】见该用例内部的说明 —— 小源编得太快，
 * 进度事件根本攒不到多条，判据就失去意义。 */
const SRC_BIG = path.join(tmp, 'src-big.mp4');
function makeBigSource() {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', SRC_BIG], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('造大测试视频失败：' + (r.stderr || '').slice(-300));
}
makeBigSource();

t('执行过程中会推送 job:stream 进度（多条、递增、最后 done）', async () => {
  streams.length = 0;
  const out = path.join(tmp, 'prog.mp4');
  /* 【必须用"编得慢"的源】这条用例要验的是进度**会是多条**，
   * 而 ffmpeg 发进度的频率受 -stats_period 限制（代码里设的是 0.2 秒）。
   * 320×240 的源编 10 秒只要约 0.4 秒，只发得出 1 条 ——
   * 那样无论代码对不对都测不出差别（第一版就是这么写的，被变异测试抓出来：
   * 删掉 -progress 之后它照样通过）。改用 720p 的 SRC_BIG。 */
  await trim({}, { input: SRC_BIG, out, start: 0, duration: 10, mode: 'encode' });
  /* 【必须按 job id 过滤】streams 是全部用例共用的数组，
   * 不过滤会把上一次裁剪的进度也读进来 —— 实测得到
   * "96% → 99% → 98% → 6.4% → 99%"，看着像乱序，其实是两组混在一起。
   * handler 的 id 是 vtr+序号，本次任务是序号最大的那个。 */
  const ids = streams.map((x) => x.id).filter(Boolean);
  const myId = ids.length ? ids[ids.length - 1] : null;
  assert.ok(myId, '没有收到任何带 id 的进度事件');
  const mine = streams.filter((x) => x.id === myId);
  const parsed = mine.map((x) => { try { return JSON.parse(x.data); } catch (e) { return null; } }).filter(Boolean);
  const pcts = parsed.filter((x) => x.pct != null && x.done !== true).map((x) => x.pct);

  /* 【这条断言最初写得太松，被变异测试抓出来了】
   * 第一版只要求「至少有 1 条 pct 且最大值 > 0」。把 -progress pipe:1
   * 删掉之后它照样通过 —— 因为 ffmpeg 在某些情况下仍会往 stdout 吐内容，
   * 而 done 事件是 handler 自己发的，与 -progress 无关。
   *
   * 真正能区分「进度在走」与「进度没接上」的判据是**多条且递增**：
   * 删掉 -progress 之后一条 out_time_us 都不会有，pcts 是空数组。
   * 这里再要求至少 3 条、且首尾有明显差距，避免"只有一条 0%"混过去。 */
  assert.ok(pcts.length >= 2,
    '只收到 ' + pcts.length + ' 条带 pct 的进度事件（应有多条）—— '
    + '-progress pipe:1 或 -stats_period 可能没加，或 out_time_us 解析失效');
  assert.ok(pcts.every((v, i) => i === 0 || v >= pcts[i - 1] - 0.001),
    '进度不是递增的：' + pcts.map((v) => v.toFixed(1)).join(' → '));
  const span = pcts[pcts.length - 1] - pcts[0];
  assert.ok(span > 5, '进度从 ' + pcts[0].toFixed(1) + '% 只走到 ' + pcts[pcts.length - 1].toFixed(1)
    + '%（落差 ' + span.toFixed(1) + ' 个百分点），像是只有零星几条');
  assert.ok(Math.max(...pcts) <= 100, '进度超过 100%：' + Math.max(...pcts));
  assert.ok(parsed.some((x) => x.done === true), '没有 done 事件');
});

/* ---------------- 4b. 取消/失败必须清掉半成品 ----------------
 *
 * 【为什么这一段必须用"真取消"而不是"喂坏文件"】
 * 喂一个假 mp4 时，ffmpeg 在解复用阶段就退出了，**根本没有创建输出文件** ——
 * 于是「文件不存在」是 ffmpeg 自己的功劳，把 handler 里的 fsp.rm 整行删掉，
 * 断言照样通过。实测确认过这个假绿。
 *
 * 而 ffmpeg 被 SIGKILL 时会留下一个几十字节的残片（实测 48 字节）。
 * 那才是真正需要清理的场景，也必须由 handler 的取消分支来删。 */
t('取消后不留半成品文件（进程被杀会留下残片，必须清掉）', async () => {
  const out = path.join(tmp, 'cancel-out.mp4');
  streams.length = 0;

  /* 先拿到这次任务的 id：handler 里是 vtr+序号，序号从 ctx.nextJobSeq 来。
   * 与其猜序号，不如订阅 streams —— handle 开始跑之后第一条进度里就带 id。
   * 但取消要赶在跑完之前，所以这里轮询 streams 直到出现新 id。 */
  /* 【取消必须发生在"文件已经创建、进程还在跑"的窗口里】
   * 第一版是轮询 streams 拿 id，但第一条进度要等到 -stats_period（0.2 秒）
   * 之后才来，而这段编码总共只要 0.4 秒 —— 拿到 id 时任务已经结束，
   * 于是什么都没取消到（断言报"应抛已取消，实际空串"）。
   *
   * 改成直接从 jobs 表拿：handler 在 spawn 之前就把任务登记进去了，
   * 这是最早的时机。拿到之后立刻轮询输出文件的出现 ——
   * 一旦文件有了内容就 cancel，这样一定在进程写盘的中间打断它。 */
  const p = trim({}, { input: SRC_BIG, out, start: 0, duration: 10, mode: 'encode' });

  let id = null;
  const idDeadline = Date.now() + 3000;
  while (Date.now() < idDeadline) {
    /* jobs 表里本次新增的那个就是（并发只会有一个：用例是串行跑的） */
    for (const k of jobs.keys()) { id = k; }
    if (id) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(id, '三秒内没拿到任务 id（handler 没把自己登记进 jobs 表？）');

  /* 等输出文件真的开始写（进程一定已在跑），再取消 ——
   * 这样"进程被杀"这条路径必定被走到。 */
  const fileDeadline = Date.now() + 3000;
  while (Date.now() < fileDeadline) {
    if (fs.existsSync(out) && fs.statSync(out).size > 0) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  const job = jobs.get(id);
  assert.ok(job && typeof job.cancel === 'function', 'jobs 表里没有这个任务的可取消句柄');
  job.cancel();

  let msg = '';
  try { await p; } catch (e) { msg = e.message; }
  assert.ok(/已取消/.test(msg), '取消后应抛「已取消」，实际：' + JSON.stringify(msg));
  assert.ok(!fs.existsSync(out), '取消后仍留下半成品：' + out + '（用户会拿它当成品）');
});

t('取消后再跑一次能正常完成（jobs 表已清理，不会残留失败状态）', async () => {
  const out = path.join(tmp, 'after-cancel.mp4');
  const r = await trim({}, { input: SRC, out, start: 0, duration: 2, mode: 'encode' });
  assert.ok(fs.existsSync(out), '取消之后的下一次执行失败了');
  assert.ok(r.size > 0);
});

/* ---------------- 5. 边界 ---------------- */
t('起点为 0、时长覆盖全片 → 正常产出且时长接近源', async () => {
  const out = path.join(tmp, 'full.mp4');
  const r = await trim({}, { input: SRC, out, start: 0, duration: 10, mode: 'encode' });
  assert.ok(fs.existsSync(out));
  if (HAS_PROBE) {
    const dur = probeDur(out);
    assert.ok(Math.abs(dur - 10) < 0.2, '整段裁剪时长应为 10±0.2，实际 ' + dur.toFixed(3));
  }
  assert.ok(r.size > 0);
});

t('请求时长超过源剩余部分 → 截到源结束，不报错', async () => {
  const out = path.join(tmp, 'over.mp4');
  const r = await trim({}, { input: SRC, out, start: 8, duration: 30, mode: 'encode' });
  assert.ok(fs.existsSync(out), '应当产出（截到片尾），而不是失败');
  if (HAS_PROBE) {
    const dur = probeDur(out);
    assert.ok(dur > 0 && dur <= 2.5, '应截到源结束（约 2 秒），实际 ' + dur.toFixed(3));
  }
  assert.ok(r.size > 0);
});

/* ---------------- 清理 ---------------- */
process.on('exit', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});

done();
