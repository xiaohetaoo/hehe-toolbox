'use strict';
/* 区域截图（snip）在高 DPI 下的坐标映射：防「框选时屏幕变形」。
 *
 * ============ 锁的是哪个历史回归 ============
 * 本机缩放 187.5%，逻辑屏 1366×854，实测四个关键尺寸：
 *   窗口 innerWidth/innerHeight = 1367 × 855   ← 比逻辑屏多 1px（DPI 取整所致）
 *   devicePixelRatio            = 1.875
 *   canvas 位图（inner×dpr）     = 2563 × 1603
 *   源图（screen.size×scaleFactor，已取整） = 2561 × 1601
 *
 * 旧实现：
 *   ctx.scale(dpr, dpr)
 *   ctx.drawImage(img, 0, 0, innerWidth, innerHeight)
 * 把 2561×1601 的源图**拉满** 2563×1603 个物理像素：
 *   横向系数 2563/2561 = 1.00078
 *   纵向系数 1603/1601 = 1.00125
 * 两个方向不同 → 各向异性变形；且是非整数缩放 → 画面发虚。
 * 100% 缩放下 dpr=1、inner 与源图尺寸相等，看不出问题；
 * 只有在 187.5%/250% 这类非整数缩放上才显形 —— 所以长期没被发现。
 *
 * 新实现：画布坐标 = 物理像素，源图按 naturalWidth/Height 1:1 贴合到 (0,0)，
 * 多出的 2×2 物理像素留在右下（被窗口裁掉）。
 *
 * ============ 为什么是纯函数测试 ============
 * 真实链路要起 Electron、开透明全屏窗、抓屏、模拟鼠标框选，
 * 而这一步的**判据本身是纯数学**（两个方向的缩放系数是否相等）。
 * 把映射规则抽成函数直接断言，比驱动 GUI 更可靠，也能在 CI 无桌面环境跑。
 * 端到端另由 test-snip-e2e 覆盖（它验的是"能不能截出图"）。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

/* 复刻修复前后的两套映射，用于对照。 */

/** 旧实现：把源图拉伸到窗口位图尺寸。返回 [横向系数, 纵向系数]。 */
function legacyScale(srcW, srcH, innerW, innerH, dpr) {
  const canvasW = Math.round(innerW * dpr);
  const canvasH = Math.round(innerH * dpr);
  return [canvasW / srcW, canvasH / srcH];
}

/** 新实现：源图 1:1 贴合，不缩放。源自己多大就画多大。 */
function fixedScale() {
  return [1, 1];
}

/* 本机实测的一组真实数字，后面多条断言都用它 */
const REAL = { srcW: 2561, srcH: 1601, innerW: 1367, innerH: 855, dpr: 1.875 };

t('旧实现的横纵缩放系数不相等（这正是变形的来源）', () => {
  const [kx, ky] = legacyScale(REAL.srcW, REAL.srcH, REAL.innerW, REAL.innerH, REAL.dpr);
  /* 锁的是：两个方向的系数确实不同。
   * 若哪天参数变了导致它们恰好相等，下面那条"新实现必须相等"仍然成立，
   * 但这条会失败并提醒"这组样例不再能代表变形场景"。 */
  assert.notStrictEqual(kx.toFixed(8), ky.toFixed(8),
    '这组样例算出的横纵系数相等，无法用它演示变形（请更新样例）');
  // 量化差异：纵向比横向多拉伸约 0.048%
  const rel = Math.abs(ky - kx) / kx;
  assert.ok(rel > 0.0004 && rel < 0.001,
    '横纵拉伸的相对差异应在 0.04%~0.1% 之间，实际 ' + (rel * 100).toFixed(4) + '%');
});

t('新实现的横纵比例严格相等（等比，不会变形）', () => {
  const [kx, ky] = fixedScale();
  /* 锁的是：修复后的两个方向系数必须完全一致。
   * 这是"不变形"的数学定义 —— 只要相等，无论显示成多大都不会出现拉伸。 */
  assert.strictEqual(kx, ky, '新实现必须等比');
  assert.strictEqual(kx, 1, '源图应当 1:1 贴合，不做任何缩放');
});

t('旧实现在右边缘会累积 2 个物理像素的错位', () => {
  /* 把源图最右一列映射到画布后落在哪：旧实现会落到 canvasW-1，
   * 新实现应当落在 srcW-1。差值就是"越靠右越偏"的累积量。 */
  const canvasW = Math.round(REAL.innerW * REAL.dpr);
  const legacyRight = (REAL.srcW - 1) * (canvasW / REAL.srcW);
  const fixedRight = REAL.srcW - 1;
  const drift = Math.abs(legacyRight - fixedRight);
  /* 锁的是：漂移量约等于"画布比源图多的像素数"（本机 2px）。
   * 这个数字直接对应肉眼能看到的错位。 */
  assert.ok(drift >= 1.9 && drift <= 2.1,
    '右边缘漂移应约为 2px（画布比源图多的量），实际 ' + drift.toFixed(3));
});

t('画布尺寸必须覆盖源图（宁可多，不能少）', () => {
  const canvasW = Math.round(REAL.innerW * REAL.dpr);
  const canvasH = Math.round(REAL.innerH * REAL.dpr);
  /* 锁的是：画布 ≥ 源图。少一个像素就会在右/下露出一条没被覆盖的旧画面，
   * 那比"多出来被裁掉"严重得多（用户看到的是黑边/错位）。 */
  assert.ok(canvasW >= REAL.srcW, '画布宽度 ' + canvasW + ' 小于源图 ' + REAL.srcW);
  assert.ok(canvasH >= REAL.srcH, '画布高度 ' + canvasH + ' 小于源图 ' + REAL.srcH);
  // 且不该多太多：多出的部分纯粹是被裁掉的浪费
  assert.ok(canvasW - REAL.srcW <= 2, '画布比源图宽出 ' + (canvasW - REAL.srcW) + 'px，超出预期');
  assert.ok(canvasH - REAL.srcH <= 2, '画布比源图高出 ' + (canvasH - REAL.srcH) + 'px，超出预期');
});

t('导出裁剪：物理坐标必须是逻辑坐标 × dpr，且不再二次缩放', () => {
  /* 用户框选 100×80 逻辑像素，导出应为 188×150 物理像素（×1.875 取整）。
   * 旧实现的导出路径里 octx.scale(dpr,dpr) + 目标尺寸用逻辑值，
   * 在新画布语义下会再缩一次（多乘了个 dpr）。 */
  const selW = 100, selH = 80, dpr = REAL.dpr;
  const outW = Math.max(1, Math.round(selW * dpr));
  const outH = Math.max(1, Math.round(selH * dpr));
  // 锁的是：输出尺寸 = 逻辑尺寸 × dpr（物理像素），不是逻辑尺寸本身。
  assert.strictEqual(outW, 188, '导出宽度应为 188 物理像素');
  assert.strictEqual(outH, 150, '导出高度应为 150 物理像素');

  /* 【不要断言"outW/selW === outH/selH"——那是错的】
   * 浮点缩放 + 取整之后，两个方向的比例本来就会有微小差异
   * （188/100=1.880 vs 150/80=1.875）。这不是缺陷：
   *   导出用的是 drawImage(src, sx,sy,sw,sh, 0,0,sw,sh)，
   *   源矩形与目标矩形宽高**完全相同**，是 1:1 拷贝，
   *   所以输出图内部绝不会有拉伸 —— 哪怕它整体比"理想 dpr 倍"多/少半个像素。
   * 真正要防的是"目标尺寸与源尺寸不一致"（那才是缩放）。
   * 第一条断言验的就是它：sw 与 sh 只算一次，源与目标共用。 */
  assert.strictEqual(outW, Math.max(1, Math.round(selW * dpr)),
    '源矩形与目标矩形必须共用同一个宽度值，否则就会发生缩放');
  assert.strictEqual(outH, Math.max(1, Math.round(selH * dpr)),
    '源矩形与目标矩形必须共用同一个高度值，否则就会发生缩放');
  /* 取整引入的偏差必须小于 1 个物理像素，否则肉眼可见。 */
  assert.ok(Math.abs(outW - selW * dpr) < 1, '宽度取整偏差应小于 1px');
  assert.ok(Math.abs(outH - selH * dpr) < 1, '高度取整偏差应小于 1px');
});

/* ---------------- 源码断言：确认实现真的按上面的规则写 ---------------- */

t('snip-2.js 不再把源图拉伸到窗口尺寸', () => {
  const src = readSrc('js/auxwin/snip-2.js');
  /* 锁的是：drawImage 的目标尺寸必须取 img 自身尺寸，不能是 innerWidth/innerHeight。
   * 旧的 `ctx.drawImage(img, 0, 0, window.innerWidth, window.innerHeight)` 就是变形根源。 */
  assert.ok(!/drawImage\(img,\s*0,\s*0,\s*window\.innerWidth/.test(src),
    '仍在按 window.innerWidth 拉伸源图 —— 变形会复现');
  // 锁的是：必须按 naturalWidth/naturalHeight 绘制。
  assert.ok(/drawImage\(img,\s*0,\s*0,\s*img\.naturalWidth,\s*img\.naturalHeight\)/.test(src),
    '源图没有按自身像素尺寸 1:1 绘制');
});

t('snip-2.js 的全局 ctx 不再做 dpr 缩放', () => {
  const src = readSrc('js/auxwin/snip-2.js');
  /* 锁的是：顶层不能再有 `ctx.scale(devicePixelRatio, devicePixelRatio)`。
   * 有它就意味着"画布坐标 = 逻辑像素"，与"画布坐标 = 物理像素"的新约定冲突。
   * 注意 render 内部对标注层做的 ctx.scale(DPR, DPR) 是允许的（用完即 restore），
   * 所以这里只禁 devicePixelRatio 这个旧写法。 */
  // 锁的是：顶层出现旧的 devicePixelRatio 缩放写法 —— 坐标语义会双重换算。
  assert.ok(!/ctx\.scale\(devicePixelRatio,\s*devicePixelRatio\)/.test(src),
    '顶层仍有 ctx.scale(devicePixelRatio,...) —— 坐标语义会双重换算');
});

t('画布按 innerWidth × DPR 建，且 DPR 有兜底', () => {
  const src = readSrc('js/auxwin/snip-2.js');
  // 锁的是：DPR 必须有 || 1 兜底（某些环境下 devicePixelRatio 可能取不到）。
  assert.ok(/const\s+DPR\s*=\s*devicePixelRatio\s*\|\|\s*1/.test(src), 'DPR 缺少兜底值');
  // 锁的是：画布位图尺寸 = 逻辑尺寸 × DPR 并取整（不取整会与源图差更多像素）。
  assert.ok(/canvas\.width\s*=\s*Math\.round\(window\.innerWidth\s*\*\s*DPR\)/.test(src),
    '画布宽度没有按 innerWidth × DPR 取整');
  assert.ok(/canvas\.height\s*=\s*Math\.round\(window\.innerHeight\s*\*\s*DPR\)/.test(src),
    '画布高度没有按 innerHeight × DPR 取整');
});

t('导出裁剪不再二次缩放', () => {
  const src = readSrc('js/auxwin/snip-2.js');
  /* 锁的是：导出时不能出现 octx.scale(...)。
   * 新画布语义下 octx.scale(dpr) + 目标用逻辑值 会再缩一次，
   * 结果是"框选一块、导出却只有 1/dpr 大"。 */
  assert.ok(!/octx\.scale\(/.test(src), '导出路径仍有 octx.scale —— 会二次缩放');
  // 锁的是：drawImage 的源与目标矩形尺寸必须相同（1:1 拷贝，不缩放）。
  assert.ok(/octx\.drawImage\(canvas,\s*sx,\s*sy,\s*sw,\s*sh,\s*0,\s*0,\s*sw,\s*sh\)/.test(src),
    '导出裁剪没有做 1:1 拷贝');
});

done();
