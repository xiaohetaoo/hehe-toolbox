'use strict';
/* lib/target-size.js 单元测试：多轮逼近的核心算术。
 * 用法：node scripts/test-target-size.js
 */
const assert = require('assert');
const t = require('../lib/target-size');

let pass = 0, fail = 0;
function c(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
}

/* ---------- planBitrates ---------- */
c('10 分钟视频压到 100MB -> 码率合理', () => {
  const r = t.planBitrates({ targetBytes: 100 * 1024 * 1024, durationSec: 600, hasAudio: true });
  assert.ok(r.ok, '应可规划: ' + r.reason);
  // 100MB/600s ≈ 1398 kbps 总预算，扣音频后视频应在此量级
  assert.ok(r.videoKbps > 500 && r.videoKbps < 1400, '视频码率异常: ' + r.videoKbps);
  assert.ok(r.audioKbps >= 32 && r.audioKbps <= 192, '音频码率异常: ' + r.audioKbps);
});

c('音频占用不超过总预算 25%', () => {
  const target = 50 * 1024 * 1024;
  const dur = 300;
  const r = t.planBitrates({ targetBytes: target, durationSec: dur, hasAudio: true });
  const totalKbps = target * 8 / dur / 1000;
  assert.ok(r.audioKbps <= totalKbps * 0.25 + 1, '音频占比过高: ' + r.audioKbps + ' vs ' + totalKbps);
});

c('轮次越多预算越保守', () => {
  const a = t.planBitrates({ targetBytes: 10e6, durationSec: 60, round: 0 });
  const b = t.planBitrates({ targetBytes: 10e6, durationSec: 60, round: 3 });
  assert.ok(b.videoKbps < a.videoKbps, '第 3 轮应更低: ' + b.videoKbps + ' vs ' + a.videoKbps);
});

c('目标过小明确失败并给原因', () => {
  const r = t.planBitrates({ targetBytes: 100 * 1024, durationSec: 600 }); // 100KB / 10 分钟
  assert.strictEqual(r.ok, false);
  assert.ok(/太小|下限/.test(r.reason), '原因文案: ' + r.reason);
});

c('无音轨时预算全给视频', () => {
  const withA = t.planBitrates({ targetBytes: 20e6, durationSec: 120, hasAudio: true });
  const noA = t.planBitrates({ targetBytes: 20e6, durationSec: 120, hasAudio: false });
  assert.ok(noA.videoKbps > withA.videoKbps, '无音轨视频码率应更高');
  assert.strictEqual(noA.audioKbps, 0);
});

c('时长未知则失败', () => {
  const r = t.planBitrates({ targetBytes: 10e6, durationSec: 0 });
  assert.strictEqual(r.ok, false);
});

c('目标体积非法则失败', () => {
  assert.strictEqual(t.planBitrates({ targetBytes: 0, durationSec: 60 }).ok, false);
  assert.strictEqual(t.planBitrates({ targetBytes: -5, durationSec: 60 }).ok, false);
});

/* ---------- planImageQuality ---------- */
c('图片质量逐轮下降且不低于 0.45', () => {
  const q0 = t.planImageQuality(0).quality;
  const q5 = t.planImageQuality(5).quality;
  const q20 = t.planImageQuality(20).quality;
  assert.ok(q0 > q5, '应递减');
  assert.strictEqual(q20, 0.45, '下限应为 0.45');
});

c('质量到底后开始降尺寸', () => {
  assert.strictEqual(t.planImageQuality(3).scale, 1, '前几轮不缩放');
  assert.ok(t.planImageQuality(6).scale < 1, '后期应缩放');
  assert.ok(t.planImageQuality(6).scale >= 0.6, '缩放不应过激');
});

/* ---------- evaluateRound ---------- */
c('达标即完成', () => {
  const r = t.evaluateRound({ outBytes: 900, targetBytes: 1000, round: 0 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.done, true);
});

c('超限且未到上限 -> 继续', () => {
  const r = t.evaluateRound({ outBytes: 2000, targetBytes: 1000, round: 0 });
  assert.strictEqual(r.needMore, true);
  assert.strictEqual(r.ok, false);
});

c('轮次耗尽仍未达标 -> 失败且说明', () => {
  const r = t.evaluateRound({ outBytes: 2000, targetBytes: 1000, round: t.MAX_ROUNDS - 1 });
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.ok, false);
  assert.ok(/轮/.test(r.reason), '应说明轮次: ' + r.reason);
});

c('空输出判失败', () => {
  const r = t.evaluateRound({ outBytes: 0, targetBytes: 1000, round: 0 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.done, true);
});

/* ---------- 档位 ---------- */
c('四档比例正确', () => {
  const ratios = t.QUICK_TIERS.map(x => x.ratio);
  assert.deepStrictEqual(ratios, [0.80, 0.50, 0.30, 0.15]);
});

c('档位目标字节计算', () => {
  assert.strictEqual(t.tierTargetBytes(1000, 0.5), 500);
  assert.strictEqual(t.tierTargetBytes(1000, 0.15), 150);
  assert.ok(t.tierTargetBytes(1, 0.15) >= 1, '不应为 0');
});

c('字节格式化', () => {
  assert.strictEqual(t.fmtBytes(512), '512 B');
  assert.ok(/KB/.test(t.fmtBytes(2048)));
  assert.ok(/MB/.test(t.fmtBytes(5 * 1024 * 1024)));
});

/* ---------- 两遍法参数构造 ---------- */
const has = (a, ...keys) => keys.every(k => a.includes(k));
const pairs = (a) => { const o = {}; for (let i = 0; i < a.length - 1; i++) if (String(a[i]).startsWith('-') && !String(a[i + 1]).startsWith('-')) o[a[i]] = a[i + 1]; return o; };

c('pass 1 只分析：输出到 null，且带 -pass 1', () => {
  const a = t.buildPass1Args({ input: 'C:/in.mp4', videoKbps: 800, passlogFile: 'C:/t/x264pass' });
  assert.ok(has(a, '-pass', '1'), '-pass 1 缺失: ' + a.join(' '));
  assert.ok(has(a, '-f', 'null'), 'pass 1 应丢弃画面');
  const p = pairs(a);
  assert.strictEqual(p['-passlogfile'], 'C:/t/x264pass', 'stats 路径不对');
  assert.strictEqual(a[a.length - 1], '-', '输出目标应为 -');
});

c('pass 1 用 -an 跳过音轨（音频不进 stats，省一遍解码）', () => {
  const a = t.buildPass1Args({ input: 'x.mp4', videoKbps: 800, passlogFile: 'p' });
  assert.ok(a.includes('-an'), 'pass 1 应 -an');
});

c('pass 2 带 -pass 2 且读同一 passlogfile', () => {
  const a = t.buildPass2Args({ input: 'C:/in.mp4', output: 'C:/out.mp4', videoKbps: 800, audioKbps: 128, hasAudio: true, passlogFile: 'C:/t/x264pass' });
  assert.ok(has(a, '-pass', '2'), '-pass 2 缺失');
  assert.strictEqual(pairs(a)['-passlogfile'], 'C:/t/x264pass', '必须与 pass 1 同一 stats');
  assert.ok(a.includes('C:/out.mp4'), '应输出到目标文件');
  assert.strictEqual(pairs(a)['-b:a'], '128k', '音频码率不对');
});

c('pass 2 不带 maxrate/bufsize（两遍法已是精确码率控制）', () => {
  const a = t.buildPass2Args({ input: 'i', output: 'o', videoKbps: 800, audioKbps: 128, hasAudio: true, passlogFile: 'p' });
  assert.ok(!a.includes('-maxrate'), '两遍法不应再叠 maxrate');
  assert.ok(!a.includes('-bufsize'), '两遍法不应再叠 bufsize');
});

c('无音轨时 pass 2 输出 -an', () => {
  const a = t.buildPass2Args({ input: 'i', output: 'o', videoKbps: 800, audioKbps: 0, hasAudio: false, passlogFile: 'p' });
  assert.ok(a.includes('-an'));
  assert.ok(!a.includes('-c:a'), '无音轨不该编码音频');
});

c('单遍兜底保留 maxrate/bufsize 且无 -pass', () => {
  const a = t.buildSinglePassArgs({ input: 'i', output: 'o', videoKbps: 1000, audioKbps: 128, hasAudio: true });
  assert.ok(!a.includes('-pass'), '兜底不该有 -pass');
  assert.strictEqual(pairs(a)['-maxrate'], '1500k');
  assert.strictEqual(pairs(a)['-bufsize'], '2000k');
});

c('码率按整数 k 传递（不允许小数进入命令行）', () => {
  const a = t.buildPass2Args({ input: 'i', output: 'o', videoKbps: 812.7, audioKbps: 96.4, hasAudio: true, passlogFile: 'p' });
  assert.strictEqual(pairs(a)['-b:v'], '813k');
  assert.strictEqual(pairs(a)['-b:a'], '96k');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
