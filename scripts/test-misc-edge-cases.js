'use strict';
/* 一批零散但都是真实回归的小问题。
 *
 * 这里每条都对应一次实测现象，不是"风格改进"。分节说明见各断言。
 */
const path = require('path');
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

/* ============ 6) 经典菜单确认框：「取消」不该叫取消 ============ */
t('M6 经典菜单确认框的取消按钮写明了"仅切换，稍后生效"', () => {
  const src = readSrc('js/tools/sys-tools.js');
  /* 锁的是：取消按钮沿用默认文案「取消」，而它实际会写注册表、切掉菜单样式。
   * 用户点「取消」以为什么都没变，结果系统状态已改。
   * 这条不能用行为断言：要跑 confirmBox 得造完整 modal + DOM，
   * 而回归本身就是"文案"—— 文案只能读源码。 */
  const i = src.indexOf("title: '切换经典菜单'");
  assert.ok(i > 0, '找不到经典菜单的确认框');
  const seg = src.slice(i, i + 400);
  /* 锁的是：没写 cancelText —— 默认就是「取消」，误导用户。 */
  assert.ok(/cancelText:\s*'仅切换，稍后生效'/.test(seg),
    '取消按钮没有改成「仅切换，稍后生效」');
  /* 锁的是：为了让"取消真的取消"而改成 return —— 那会删掉"稍后生效"这个选项。 */
  assert.ok(/return apply\(true\)/.test(src), 'apply(true) 分支被删了，"稍后生效"选项会消失');
});

/* ============ 7) 倒计时结束必须复位 remain ============ */
t('M7 倒计时结束后 remain 被复位（再点开始不会立刻又结束）', () => {
  const src = readSrc('js/tools/life.js');
  /* 锁的是：countdown 分支 return 前没有 remain = total ——
   * 再点「开始计时」时 start() 按 (total - remain) 重锚，remain<=0
   * 会让第一个 tick 立刻判定到点、又弹一次「倒计时结束」。 */
  const i = src.indexOf("if (mode === 'countdown') {");
  assert.ok(i > 0, '找不到 countdown 分支');
  /* 只取到 countdown 分支自己的收尾（它的 return 之前那段）——
   * 取太宽会把下面番茄钟分支的 start() 也圈进来，导致「不该自动 start」
   * 这条误报（番茄钟那边本来就会有 start）。 */
  const retIdx = src.indexOf('return;', i);
  const seg = src.slice(i, retIdx > i ? retIdx + 20 : i + 600);
  /* 锁的是：复位语句被删。 */
  assert.ok(/remain = total;/.test(seg), 'countdown 分支没有复位 remain');
  /* 锁的是：为了"复位"顺手加自动重启 —— 那会改变"结束后不自动重启"的现有行为。 */
  assert.ok(!/remain = total;[\s\S]{0,40}?start\(\)/.test(seg),
    'countdown 分支不该自动 start（会改变现有行为）');
  /* 番茄钟分支本来就有这句，佐证判据一致 */
  /* 锁的是：只修 countdown、把番茄钟那条改坏。 */
  assert.ok((src.match(/remain = total;/g) || []).length >= 2,
    '番茄钟分支的 remain = total 不见了');
});

/* ============ 12) planBitrates 接受字符串时长 ============ */
t('M12 planBitrates 接受字符串时长（不再抛 toFixed is not a function）', () => {
  const ts = require(path.join(__dirname, '..', 'lib', 'target-size'));
  /* 锁的是：ffprobe 给的 '60' 一路带到 durationSec.toFixed(0) 抛 TypeError。
   * 本该返回结构化的「目标体积太小」reason（调用方据此提示用户）。 */
  const r = ts.planBitrates({ targetBytes: 1024, durationSec: '60', hasAudio: true });
  assert.strictEqual(typeof r, 'object', '没有返回对象');
  assert.strictEqual(r.ok, false, '这个目标体积不可能成功');
  assert.ok(r.reason && r.reason.length > 0, '没有给出 reason');
  assert.ok(/60 秒/.test(r.reason), 'reason 里的时长不是 60：' + r.reason);

  /* 锁的是：只处理了字符串、数字那条路反而退化 —— 与字符串结果必须一致。 */
  const rNum = ts.planBitrates({ targetBytes: 1024, durationSec: 60, hasAudio: true });
  assert.strictEqual(rNum.reason, r.reason, '字符串与数字时长给出的结论不一致');
});

t('M12b planBitrates 对 NaN / 0 / 负数 / Infinity 都给出结构化拒绝', () => {
  const ts = require(path.join(__dirname, '..', 'lib', 'target-size'));
  /* 锁的是：非有限值时抛异常或算出无意义码率 —— 调用方拿不到可读原因。 */
  for (const d of [NaN, 0, -5, Infinity, -Infinity, null, undefined, 'abc']) {
    const r = ts.planBitrates({ targetBytes: 50 * 1024 * 1024, durationSec: d });
    assert.strictEqual(r.ok, false, '时长 ' + String(d) + ' 不该被判为可计算');
    /* 锁的是：reason 缺失 —— 界面只能显示"失败"两个字。 */
    assert.ok(r.reason && r.reason.length > 0, '时长 ' + String(d) + ' 没有给 reason');
    assert.strictEqual(r.videoKbps, null, '时长 ' + String(d) + ' 不该给出视频码率');
  }
  /* 正常数值仍要能算 */
  const ok = ts.planBitrates({ targetBytes: 50 * 1024 * 1024, durationSec: 120 });
  /* 锁的是：收紧入参校验时把正常路径也拒了。 */
  assert.strictEqual(ok.ok, true, '正常入参被判失败');
  assert.ok(ok.videoKbps > 0, '正常入参没算出正码率');
});

/* ============ 13a) ocr-guard 的 Infinity 超时 ============ */
t('M13a withTimeout 不接受 Infinity（回退默认，不是 1ms 就超时）', async () => {
  const og = require(path.join(__dirname, '..', 'lib', 'ocr-guard'));
  /* 锁的是：Number(ms) > 0 放过 Infinity —— setTimeout 把它当 1ms，
   * 用户传"永不超时"却几乎立刻收到超时，且只有一条 OverflowWarning。 */
  let settled = null;
  const never = new Promise(() => {});
  const t0 = Date.now();
  og.withTimeout(never, Infinity, 'x').then(
    () => { settled = 'resolved'; },
    (e) => { settled = 'rejected:' + (e && e.code); }
  );
  await new Promise((r) => setTimeout(r, 120));
  const elapsed = Date.now() - t0;
  /* 锁的是：Infinity 被当成 1ms —— 120ms 内就该已经 reject 了。 */
  assert.strictEqual(settled, null,
    'Infinity 超时在 ' + elapsed + 'ms 内就触发了：' + settled);
  /* 同时确认默认值确实存在且是个合理的正数 */
  /* 锁的是：回退成 0 / undefined —— 那会立刻超时。 */
  assert.ok(og.DEFAULT_TIMEOUT_MS > 0, 'DEFAULT_TIMEOUT_MS 不是正数');
});

/* ============ 13b) disk-health 的 w===0 ============ */
t('M13b estimateRemaining(0) 返回「全新状态」，不被 100% 覆盖', () => {
  const dh = require(path.join(__dirname, '..', 'lib', 'disk-health'));
  assert.ok(typeof dh.estimateRemaining === 'function', '没有 estimateRemaining');
  const r = dh.estimateRemaining(0);
  /* 锁的是：w===0 的独立 if 被后面的 else-if 链覆盖 ——
   * 实测输出「剩余寿命约 100%」，而"全新状态"这个判断从未出现。 */
  assert.ok(/全新状态/.test(r.text), '没有返回「全新状态」：' + r.text);
  /* 锁的是：为了修这条把其它档位弄坏。 */
  const mid = dh.estimateRemaining(5);
  assert.ok(/95%/.test(mid.text), '磨损 5 的剩余百分比算错了：' + mid.text);
});

/* ============ 13c) exif RATIONAL 分母 0 ============ */
t('M13c exif 的 RATIONAL 分母为 0 时不给 "Infinity"', () => {
  const src = readSrc('lib/exif.js');
  /* 锁的是：只看分子非零，(1/0).toFixed(2) 输出字符串 'Infinity'，
   * 被当成有效读数收进结果（界面上出现"光圈 Infinity"）。 */
  assert.ok(!/getUint32\(vOff, little\)\s*\?\s*\(/.test(src),
    '仍然只判断分子非零，没有检查分母');
  /* 锁的是：改成了 num/den 但忘了 toFixed 保留两位 —— 小数位数不一致。 */
  assert.ok(/rNum\s*&&\s*rDen/.test(src), '没有同时对分子分母做非零判断');
});

/* ============ 13d) mojibake.scoreText 非字符串 ============ */
t('M13d scoreText 接受非字符串入参（不再抛 is not iterable）', () => {
  const mj = require(path.join(__dirname, '..', 'lib', 'mojibake'));
  assert.ok(typeof mj.scoreText === 'function', '没有 scoreText');
  /* 锁的是：scoreText(123) → TypeError: s is not iterable。
   * 这个函数挂在"候选解码结果"上，候选值可能是 JSON 里的数字/布尔。 */
  for (const v of [123, {}, true]) {
    let threw = null;
    try { mj.scoreText(v); } catch (e) { threw = e; }
    assert.strictEqual(threw, null, 'scoreText(' + JSON.stringify(v) + ') 抛了：' + (threw && threw.message));
  }
  /* null/undefined 仍按空串（最低分），不要变成 0 分混进候选 */
  /* 锁的是：把 null 当成 "null" 字符串去评分 —— 那是 4 个 ASCII 字符，分数不低。 */
  assert.strictEqual(mj.scoreText(null), mj.scoreText(''), 'null 与空串的评分应一致');
});

/* ============ 13e) fmtClock 的毫秒进位 ============ */
t('M13e fmtClock 不会输出 00:60.000（毫秒进位传回分钟）', () => {
  const src = readSrc('js/tools/media/video-trim.js');
  const i = src.indexOf('function fmtClock(sec) {');
  assert.ok(i > 0, '找不到 fmtClock');
  /* 从源码里取出函数体求值，跑的是真实现 */
  let depth = 0, end = -1;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  assert.ok(end > i, 'fmtClock 花括号不配平');
  const fn = new Function('sec', src.slice(src.indexOf('{', i) + 1, end - 1));

  /* 锁的是：先拆分钟再 toFixed —— 59.9996 得到 '00:60.000'。
   * 「秒 = 60」不是合法时钟读数。 */
  assert.strictEqual(fn(59.9996), '01:00.000', '59.9996 没有进位到 1 分钟');
  assert.strictEqual(fn(119.9996), '02:00.000', '119.9996 没有进位到 2 分钟');
  /* 锁的是：为了修进位把正常值弄坏。 */
  assert.strictEqual(fn(0), '00:00.000');
  assert.strictEqual(fn(42), '00:42.000');
  assert.strictEqual(fn(60), '01:00.000');
  assert.strictEqual(fn(9.9999), '00:10.000');
});

done();
