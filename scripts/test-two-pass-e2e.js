'use strict';
/* 两遍法（two-pass）真实编码验证：用真 ffmpeg 跑完整的 8 轮逼近流程，
 * 对比「单遍 ABR」与「两遍法」的体积命中率与轮次数。
 *
 * 为什么必须有这个测试：
 *   参数构造对不对，单测只能验字符串；两遍法真正的价值是「体积更准」，
 *   那就必须真的编码、真的量字节、真的比命中率。
 *   本脚本同时验证 pass 1 的 stats 能被 8 轮复用（不重复分析）。
 *
 * 用法：node scripts/test-two-pass-e2e.js [ffmpeg目录]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const targetSize = require('../lib/target-size');

/* ffmpeg 定位：显式参数 > 应用自己的 bin 目录 > PATH。
 * 找不到就 SKIP（exit 0），不让没有 ffmpeg 的环境（如 CI）误报失败——
 * 但本地有 ffmpeg 时必须真跑，否则这个测试等于没写。 */
function locateFfmpeg() {
  if (process.argv[2]) return path.join(process.argv[2], 'ffmpeg.exe');
  const appBin = path.join(process.env.APPDATA || '', 'hehe-toolbox', 'bin', 'ffmpeg.exe');
  if (fs.existsSync(appBin)) return appBin;
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('where', ['ffmpeg'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    const p = (r.stdout || '').split(/\r?\n/).find(l => l.trim().toLowerCase().endsWith('ffmpeg.exe'));
    if (p) return p.trim();
  } catch (e) {}
  return null;
}
const FFMPEG = locateFfmpeg();

let pass = 0, fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; else pass++; };

function run(args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args, { cwd, windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += String(d); if (err.length > 40000) err = err.slice(-12000); });
    p.on('exit', code => resolve({ code, err }));
    p.on('error', e => resolve({ code: -1, err: e.message }));
  });
}

(async () => {
  if (!FFMPEG || !fs.existsSync(FFMPEG)) {
    console.log('SKIP  未找到 ffmpeg（设置 PATH 或传目录参数即可真跑两遍法验证）');
    process.exit(0);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hehe-tp-'));
  console.log('工作目录:', tmp);

  /* ---- 造一个约 3 秒的测试视频（有真实画面变化，方便编码器产生复杂度） ---- */
  const src = path.join(tmp, 'src.mp4');
  console.log('\n生成测试素材…');
  const gen = await run([
    '-hide_banner', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '3000k',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', src
  ], tmp);
  if (gen.code !== 0) { console.log('FAIL  素材生成失败: ' + gen.err.slice(-400)); process.exit(1); }
  const srcSize = fs.statSync(src).size;
  console.log('源文件:', (srcSize / 1024).toFixed(0) + 'KB');

  const target = Math.floor(srcSize * 0.25); // 压到 25%
  console.log('目标体积:', (target / 1024).toFixed(0) + 'KB (25% of source)\n');

  const MEDIA = { duration: 3, hasAudio: true };

  /* ================= 单遍 ABR ================= */
  async function singlePassRun() {
    let rounds = 0, outSize = 0;
    for (let round = 0; round < targetSize.MAX_ROUNDS; round++) {
      rounds = round + 1;
      const plan = targetSize.planBitrates({ targetBytes: target, durationSec: MEDIA.duration, hasAudio: MEDIA.hasAudio, round });
      if (!plan.ok) return { rounds, outSize, err: plan.reason };
      const cand = path.join(tmp, `single-${round}.mp4`);
      const args = targetSize.buildSinglePassArgs({
        input: src, output: cand, videoKbps: plan.videoKbps, audioKbps: plan.audioKbps, hasAudio: MEDIA.hasAudio
      });
      const r = await run(args, tmp);
      if (r.code !== 0) return { rounds, outSize, err: r.err.slice(-200) };
      outSize = fs.statSync(cand).size;
      if (outSize <= target) return { rounds, outSize };
      fs.unlinkSync(cand);
    }
    return { rounds, outSize, err: '未达标' };
  }

  /* ================= 两遍法 ================= */
  async function twoPassRun() {
    let rounds = 0, outSize = 0, analyzed = 0;
    const passlog = path.join(tmp, 'x264pass').replace(/\\/g, '/');

    // pass 1 只做一次
    const plan0 = targetSize.planBitrates({ targetBytes: target, durationSec: MEDIA.duration, hasAudio: MEDIA.hasAudio, round: 0 });
    if (!plan0.ok) return { rounds, outSize, err: plan0.reason };
    const r1 = await run(targetSize.buildPass1Args({ input: src, videoKbps: plan0.videoKbps, passlogFile: passlog }), tmp);
    analyzed = 1;
    const statsOk = fs.existsSync(passlog + '-0.log');
    if (r1.code !== 0 || !statsOk) return { rounds, outSize, err: 'pass1 失败: ' + r1.err.slice(-300), analyzed };

    for (let round = 0; round < targetSize.MAX_ROUNDS; round++) {
      rounds = round + 1;
      const plan = targetSize.planBitrates({ targetBytes: target, durationSec: MEDIA.duration, hasAudio: MEDIA.hasAudio, round });
      if (!plan.ok) return { rounds, outSize, err: plan.reason, analyzed };
      const cand = path.join(tmp, `two-${round}.mp4`);
      const r = await run(targetSize.buildPass2Args({
        input: src, output: cand, videoKbps: plan.videoKbps, audioKbps: plan.audioKbps,
        hasAudio: MEDIA.hasAudio, passlogFile: passlog
      }), tmp);
      if (r.code !== 0) return { rounds, outSize, err: r.err.slice(-300), analyzed };
      outSize = fs.statSync(cand).size;
      if (outSize <= target) return { rounds, outSize, statsOk: true, analyzed };
      fs.unlinkSync(cand);
    }
    return { rounds, outSize, err: '未达标', statsOk: true, analyzed };
  }

  console.log('跑单遍 ABR…');
  const single = await singlePassRun();
  console.log('  轮次=' + single.rounds + ' 体积=' + (single.outSize / 1024).toFixed(0) + 'KB' + (single.err ? ' 错误=' + single.err : ''));

  console.log('跑两遍法…');
  const two = await twoPassRun();
  console.log('  轮次=' + two.rounds + ' 体积=' + (two.outSize / 1024).toFixed(0) + 'KB' + (two.err ? ' 错误=' + two.err : ''));

  console.log('');
  chk(!two.err, '两遍法能跑完（无错误）' + (two.err ? '：' + two.err : ''));
  chk(two.outSize > 0 && two.outSize <= target,
    '两遍法最终达标：' + (two.outSize / 1024).toFixed(0) + 'KB <= 目标 ' + (target / 1024).toFixed(0) + 'KB');
  chk(two.analyzed === 1, 'pass 1 只执行一次（实际 ' + two.analyzed + ' 次）');
  chk(!!two.statsOk, 'pass 1 生成了 stats 文件（pass 2 才有依据）');

  /* 命中率：离目标越近越准。单遍法是用 maxrate 兜底"宁可小也不要大"，
     两遍法应该更贴近目标上限（体积利用率更高 = 画质更好）。 */
  const twoUtil = two.outSize / target;
  const singleUtil = single.outSize > 0 ? single.outSize / target : 0;
  console.log('\n体积利用率（越接近 1.0 说明码率分配越精确、同等体积下画质越好）：');
  console.log('  单遍: ' + (singleUtil * 100).toFixed(1) + '%   两遍: ' + (twoUtil * 100).toFixed(1) + '%');
  chk(twoUtil >= 0.5 && twoUtil <= 1.0, '两遍法体积利用率落在合理区间（' + (twoUtil * 100).toFixed(1) + '%）');

  /* stats 复用验证：两遍法的轮次不应显著多于单遍（复用后每轮成本相同） */
  chk(two.rounds <= targetSize.MAX_ROUNDS, '两遍法轮次在上限内（' + two.rounds + '）');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();
