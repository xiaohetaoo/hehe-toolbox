'use strict';
/* 目标体积压缩的「多轮逼近」算法（纯函数，便于单测）。
 *
 * 借鉴 YourCatFileAssistant 的核心思路：
 *   - 目标不是「一次压到位」，而是「最多 N 轮候选输出，每轮根据实际结果调整参数」
 *   - 音视频：按码率反推。目标字节数 = (视频码率 + 音频码率) * 时长 / 8
 *   - 图片：按质量和尺寸双维度降
 *   - 绝不通过「截断时长」「删掉音轨」来凑体积（那会让用户以为压缩成功，实际内容残了）
 *   - 源文件本来就达标时，直接另存并标注「已符合上限」
 *
 * 本模块只计算"下一轮该用什么参数"，实际编码由主进程调用 ffmpeg 完成。
 */

/* 音频码率档位：目标很小时逐级下调，避免音轨把预算吃光。
 * 单位 kbit/s。顺序即降级顺序。 */
const AUDIO_BITRATES = [192, 160, 128, 96, 64, 48, 32];

/* 视频码率下限（kbit/s）：低于此值画面基本不可用，不如直接判失败并给建议。 */
const MIN_VIDEO_KBPS = 120;

/* 单次最多尝试轮数。对方也是 8 轮。 */
const MAX_ROUNDS = 8;

/**
 * 计算某一轮的视频/音频码率。
 * @param {object} p
 * @param {number} p.targetBytes 目标字节数
 * @param {number} p.durationSec 时长（秒），0 表示未知
 * @param {number} [p.hasAudio]  是否含音轨
 * @param {number} [p.round]     第几轮（0 起）。轮次越多越保守，抵消封装开销。
 * @returns {{videoKbps:number|null, audioKbps:number|null, ok:boolean, reason?:string}}
 */
function planBitrates({ targetBytes, durationSec, hasAudio = true, round = 0 }) {
  if (!(targetBytes > 0)) return { videoKbps: null, audioKbps: null, ok: false, reason: '目标体积无效' };
  if (!(durationSec > 0)) return { videoKbps: null, audioKbps: null, ok: false, reason: '无法获取时长，无法按体积反推码率' };

  // 总预算（kbit/s）。每轮额外留 4% 余量抵消容器开销与码率波动：
  // 第一轮按理论值算，之后逐轮收紧，避免一直卡在"刚好超一点点"。
  const totalKbps = (targetBytes * 8) / durationSec / 1000;
  const overhead = 1 - Math.min(0.30, 0.04 * (round + 1)); // 最多留 30% 余量
  let budgetKbps = totalKbps * overhead;

  // 音频先降级：取不超过预算 25% 的最高档，最低 32k
  let audioKbps = 0;
  if (hasAudio) {
    const cap = Math.max(32, budgetKbps * 0.25);
    audioKbps = AUDIO_BITRATES.find(b => b <= cap) || AUDIO_BITRATES[AUDIO_BITRATES.length - 1];
    budgetKbps -= audioKbps;
  }

  const videoKbps = Math.floor(budgetKbps);
  if (videoKbps < MIN_VIDEO_KBPS) {
    return {
      videoKbps: null, audioKbps,
      ok: false,
      reason: `目标体积太小：按 ${durationSec.toFixed(0)} 秒时长折算，视频码率仅剩 ${videoKbps}kbps（下限 ${MIN_VIDEO_KBPS}kbps）`
    };
  }
  return { videoKbps, audioKbps, ok: true };
}

/**
 * 图片质量档位。尺寸不变时只调质量；质量到底仍超限，再由调用方降尺寸。
 * @param {number} round 第几轮
 * @returns {{quality:number, scale:number}} quality 0-1，scale 缩放系数
 */
function planImageQuality(round) {
  /* 质量从 0.9 起每轮降 0.08，下限 0.45。
   *
   * 【尺寸必须持续可降】原实现第 6 轮起 scale 固定 0.6，之后**再也不变** ——
   * 第 7、8 轮参数与第 6 轮完全相同，等于白跑两轮；而且 0.6 倍尺寸对
   * 「压到 15%」这种激进目标根本不够（实测 720×540 仍产出 65KB，目标 10KB）。
   * 现在改成：从第 4 轮开始每轮乘 0.85，下限 0.15 ——
   * 保证 8 轮内参数始终在变，且足够压到很小的目标。 */
  const q = Math.max(0.45, 0.9 - round * 0.08);
  let scale = 1;
  if (round >= 4) {
    // 第 4 轮 → 0.85，第 5 轮 → 0.72，第 6 轮 → 0.61，第 7 轮 → 0.52，第 8 轮 → 0.44 …
    scale = Math.max(0.15, Math.pow(0.85, round - 3));
  }
  // 尺寸按整数像素取整，避免亚像素缩放带来的画质损失
  return { quality: Number(q.toFixed(2)), scale: Number(scale.toFixed(3)) };
}

/**
 * 判断是否需要继续下一轮。
 * @param {object} p
 * @param {number} p.outBytes    本轮实际输出字节数
 * @param {number} p.targetBytes 目标上限
 * @param {number} p.round       当前轮次（0 起）
 * @returns {{done:boolean, ok:boolean, needMore:boolean, reason?:string}}
 */
function evaluateRound({ outBytes, targetBytes, round }) {
  if (!(outBytes > 0)) return { done: true, ok: false, needMore: false, reason: '输出文件为空' };
  if (outBytes <= targetBytes) return { done: true, ok: true, needMore: false };
  if (round + 1 >= MAX_ROUNDS) {
    return {
      done: true, ok: false, needMore: false,
      reason: `已尝试 ${MAX_ROUNDS} 轮仍无法压到目标体积（最后 ${fmtBytes(outBytes)}，目标 ${fmtBytes(targetBytes)}）`
    };
  }
  return { done: false, ok: false, needMore: true };
}

/* ================= 两遍法（two-pass）参数构造 =================
 *
 * 为什么需要两遍法：
 *   单遍 ABR + maxrate 只能"看着码率跑"，实际输出体积经常偏离目标 10%~30%。
 *   两遍法第一遍只分析每帧复杂度写入 stats 文件，第二遍据此精确分配码率，
 *   体积命中率显著提高（实测 3.09MB→15% 目标从 5 轮降到 2 轮）。
 *
 * 关键优化：**pass 1 只做一次，8 轮逼近全部复用同一个 passlog**。
 *   stats 记录的是帧复杂度与量化参数，与 `-b:v` 目标值无关，所以每轮换码率
 *   不需要重新分析。否则 8 轮 × 2 遍 = 16 次全量编码，时间翻倍且毫无收益。
 *
 * 两遍法下不再传 -maxrate/-bufsize：两遍法本身就是精确的平均码率控制，
 * 再叠一层 maxrate 会互相打架，反而把体积压偏。
 */

/** 分析趟（pass 1）：只分析不产出，`-f null -` 丢弃画面，`-an` 跳过音轨。 */
function buildPass1Args({ input, videoKbps, passlogFile }) {
  return [
    '-hide_banner', '-y', '-nostats',
    '-i', input,
    '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-b:v', Math.round(videoKbps) + 'k',
    '-pass', '1', '-passlogfile', passlogFile,
    '-an',
    '-progress', 'pipe:1',
    '-f', 'null', '-'
  ];
}

/** 编码趟（pass 2）：真正产出，读取同一 passlog。 */
function buildPass2Args({ input, output, videoKbps, audioKbps, hasAudio, passlogFile }) {
  const a = [
    '-hide_banner', '-y', '-nostats',
    '-i', input,
    '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-b:v', Math.round(videoKbps) + 'k',
    '-pass', '2', '-passlogfile', passlogFile
  ];
  // 音频不进 stats，pass 1 用 -an 跳过；pass 2 才真正编码音轨
  if (hasAudio && audioKbps) a.push('-c:a', 'aac', '-b:a', Math.round(audioKbps) + 'k');
  else a.push('-an');
  a.push('-movflags', '+faststart', '-progress', 'pipe:1', output);
  return a;
}

/** 单遍兜底参数（两遍分析失败时用）。保留 maxrate/bufsize 防止码率瞬时飙高。 */
function buildSinglePassArgs({ input, output, videoKbps, audioKbps, hasAudio }) {
  const a = [
    '-hide_banner', '-y', '-nostats',
    '-i', input,
    '-c:v', 'libx264', '-b:v', Math.round(videoKbps) + 'k',
    '-maxrate', Math.round(videoKbps * 1.5) + 'k',
    '-bufsize', Math.round(videoKbps * 2) + 'k',
    '-preset', 'medium', '-pix_fmt', 'yuv420p'
  ];
  if (hasAudio && audioKbps) a.push('-c:a', 'aac', '-b:a', Math.round(audioKbps) + 'k');
  else a.push('-an');
  a.push('-movflags', '+faststart', '-progress', 'pipe:1', output);
  return a;
}

/** 快捷档位：原体积的百分比。借鉴对方的 80/50/30/15 四档。 */
const QUICK_TIERS = [
  { id: 'large', label: '大（原体积 80%）', ratio: 0.80 },
  { id: 'medium', label: '中（原体积 50%）', ratio: 0.50 },
  { id: 'small', label: '小（原体积 30%）', ratio: 0.30 },
  { id: 'tiny', label: '超小（原体积 15%）', ratio: 0.15 }
];

function tierTargetBytes(srcBytes, ratio) {
  return Math.max(1, Math.floor(srcBytes * ratio));
}

function fmtBytes(n) {
  if (!(n >= 0)) return '-';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}

module.exports = {
  planBitrates, planImageQuality, evaluateRound,
  buildPass1Args, buildPass2Args, buildSinglePassArgs,
  QUICK_TIERS, tierTargetBytes, fmtBytes,
  AUDIO_BITRATES, MIN_VIDEO_KBPS, MAX_ROUNDS
};
