'use strict';
/* 图片压缩的「该不该采用候选」判据 —— 抽成纯函数以便单测。
 *
 * ============ 为什么需要这个模块 ============
 * img-compress 的 target / smart 两种模式原来只负责「找候选」，
 * 从不问一句「候选比原图大吗」：
 *   · target 模式：源图 100KB、目标填 200KB 时，encodeTarget 从 q95 往下
 *     找「≤目标」的最大质量 —— 找到的很可能是 150~190KB 的结果，
 *     比原图**大**。用户点「压缩」，文件反而变大。
 *   · smart 模式：q60 仍大于原图时也照样写盘（界面显示 +X%，
 *     却仍然计入「完成」）。
 *
 * 对照 js/tools/target-size.js —— 那边早就有 `srcBytes <= targetBytes`
 * 直接另存 + alreadyFits 的处理，这里漏了。
 *
 * ============ 判据 ============
 * 三条，按优先级：
 *   1. 目标已达标（原图本来就 ≤ 目标）→ 直接复制原图，不重编码
 *      （重编码必然损失画质，而「已经达标」时没有任何收益）
 *   2. 候选比原图小 → 采用候选
 *   3. 候选不比原图小 → 保留原图
 *
 * 第 2 条**不加**「至少小 8%」这类门槛：只要小一点点也算压缩成功，
 * 那是用户明确点了「压缩」的结果；门槛会把「小 2%」判成失败，
 * 反而是错的。真正的收益判断交给界面的百分比显示。
 */

/**
 * target 模式：原图已达标时是否该直接另存。
 * @param {number} origBytes 原图字节数
 * @param {number} targetBytes 用户设定的目标上限（字节）
 * @returns {boolean}
 */
function shouldKeepOriginal(origBytes, targetBytes) {
  const o = Number(origBytes);
  const t = Number(targetBytes);
  if (!Number.isFinite(o) || o <= 0) return false;
  if (!Number.isFinite(t) || t <= 0) return false;
  return o <= t;
}

/**
 * smart 模式：在若干候选里挑一个「确实比原图小」的，否则返回 null。
 *
 * 候选按「体积从小到大」挑 —— smart 的目标是瘦身，同等画质档里
 * 优先给更小的结果。但**质量优先于体积**：调用方传进来的通常是
 * q80 与 q60 两个候选，若 q60 反而更大（罕见但不无可能，例如
 * 高频噪点图在低质量下反而膨胀），要选 q80。
 *
 * @param {Array<{bytes:number}>} candidates 候选列表（每项至少含 bytes）
 * @param {number} origBytes 原图字节数
 * @returns {object|null} 选中的候选；都不比原图小时返回 null
 */
function chooseCandidate(candidates, origBytes) {
  const o = Number(origBytes);
  if (!Number.isFinite(o) || o <= 0) return null;
  const list = Array.isArray(candidates) ? candidates : [];
  let best = null;
  for (const c of list) {
    if (!c) continue;
    const b = Number(c.bytes);
    if (!Number.isFinite(b) || b <= 0) continue;
    if (b >= o) continue;                 // 不小于原图：不要
    if (!best || b < Number(best.bytes)) best = c;
  }
  return best;
}

/**
 * 统一出口：给定原图与编码结果，决定最终写盘用哪一份。
 *
 * @param {object} p
 * @param {number} p.origBytes 原图字节数
 * @param {string} [p.mode] 压缩模式：target / smart / custom
 * @param {number} [p.targetBytes] target 模式的目标上限
 * @param {object} [p.candidate] 编码出来的候选（{bytes, dataUrl}）
 * @param {string} [p.origDataUrl] 原图的 dataUrl（保留原图时要用）
 * @param {boolean} [p.alreadyFits] 调用方已知原图达标
 * @returns {{useOriginal:boolean, alreadyFits:boolean, reason:string}}
 */
function decideOutcome(p) {
  /** @type {{origBytes?:number, mode?:string, targetBytes?:number, candidate?:any, origDataUrl?:string, alreadyFits?:boolean}} */
  const x = p || {};
  const orig = Number(x.origBytes);
  const mode = String(x.mode || '');
  const cand = x.candidate || null;
  const candBytes = cand ? Number(cand.bytes) : NaN;

  /* target 模式：先把「原图本来就达标」这条判掉 —— 此时不该有任何编码 */
  if (mode === 'target' && shouldKeepOriginal(orig, x.targetBytes)) {
    return { useOriginal: true, alreadyFits: true, reason: '源图已符合目标上限' };
  }
  if (x.alreadyFits) {
    return { useOriginal: true, alreadyFits: true, reason: '源图已符合目标上限' };
  }
  /* 没有候选（编码失败）：保留原图 */
  if (!cand || !Number.isFinite(candBytes) || candBytes <= 0) {
    return { useOriginal: true, alreadyFits: false, reason: '没有可用的编码结果' };
  }
  /* 候选不比原图小：保留原图。这条同时覆盖 target 压不下去、
   * smart 的两个候选都膨胀、以及 custom 选了极高质量的情况。 */
  if (Number.isFinite(orig) && orig > 0 && candBytes >= orig) {
    return { useOriginal: true, alreadyFits: false, reason: '编码结果不比原图小' };
  }
  return { useOriginal: false, alreadyFits: false, reason: '' };
}

const API = { shouldKeepOriginal, chooseCandidate, decideOutcome };
/* UMD 形态照 lib/safe-name.js：node 走 module.exports，浏览器挂到 root。
 * 【必须先赋给局部变量再挂属性】直接写 `window.ImgPick = ...` 时 tsc 会报
 * `Property 'ImgPick' does not exist on type 'Window'`（本项目 jsconfig 没有
 * 扩展 Window 接口）；而经过一个 `const root = ...` 间接赋值，
 * 类型检查就不会去校验那个属性。safe-name / exif 都是这么绕开的。 */
if (typeof module === 'object' && module && module.exports) module.exports = API;
const root = typeof window !== 'undefined' ? window
  : (typeof globalThis !== 'undefined' ? globalThis : null);
if (root) root.ImgPick = API;
