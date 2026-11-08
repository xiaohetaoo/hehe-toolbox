'use strict';
/* 硬件编码模块（lib/hw-encode.js）的契约测试。
 *
 * ============ 锁的是哪几个回归 ============
 * 1. **crf 照抄给硬件编码器** —— 这是接入硬件加速时最容易犯的错，
 *    实测后果是文件体积翻倍（crf23 → cq23 时 18.8MB 变 38.6MB）。
 *    「换算」这个动作本身要被钉住，否则将来有人"顺手统一参数名"就悄悄退化。
 * 2. **编译支持当成可用** —— gyan 的 build 把 nvenc/qsv/amf 全编译进去了，
 *    但没有 A 卡时 h264_amf 直接报 `DLL amfrt64.dll failed to open`。
 *    只看 `-encoders` 列表就宣布"支持硬件加速"是假绿。
 * 3. **硬件编码族串用** —— 探测到 h264_nvenc 不等于 hevc_nvenc 也能用，
 *    两个是独立的能力位。把 h264 塞进 hevc 的流程会得到用户看不懂的参数错误。
 * 4. **探测失败连带转码不可用** —— 探测只是优化路径，它挂了必须退回 CPU，
 *    而不是让「转码」整个功能报错。
 */
const assert = require('assert');
const { t, done } = require('./lib/harness');

const hw = require('../lib/hw-encode');

/* ==================== crf → cq 换算 ==================== */

/* 锁的是回归 1：crf 被原样当 cq 用（体积翻倍）。
 * 这条用行为断言（比较数值）而不是源码匹配：换算是纯函数，能直接验结果。 */
t('H1 crf 必须被换算成更大的 cq（照抄数值会让体积翻倍）', () => {
  const cq23 = hw.cqFor(23);
  assert.ok(cq23 > 23,
    'crf23 换算后的 cq 是 ' + cq23 + '，没有大于 crf —— 说明偏移量被改成了 0 或负数。'
    + '实测 cq 与 crf 同数值时文件体积约为 2 倍（见 lib/hw-encode.js 顶部数据表）');
  /* 偏移量本身也要钉住：+7 是在四种内容上实测标定的（噪点/照片/渐变/录屏），
   * 不是拍脑袋的整数。改成别的值会让某一类内容的体积明显偏离。 */
  assert.strictEqual(cq23 - 23, hw.CQ_OFFSET, 'cq 与 crf 的差值应恰好等于 CQ_OFFSET');
});

/* 锁的是回归 1 的边界：clamp 必须生效，否则 crf14 会算出 21 以下的极端值，
 * 让"最高画质"档产出比源文件还大的东西。 */
t('H2 换算结果必须 clamp 到 18..40（边界不得越界）', () => {
  assert.strictEqual(hw.cqFor(0), hw.CQ_MIN, 'crf0 应被夹到下限');
  assert.strictEqual(hw.cqFor(-100), hw.CQ_MIN, '负数应被夹到下限');
  assert.strictEqual(hw.cqFor(51), hw.CQ_MAX, 'crf51 应被夹到上限');
  assert.strictEqual(hw.cqFor(999), hw.CQ_MAX, '超大值应被夹到上限');
  /* 非数字输入不能产出 NaN —— 那会让 ffmpeg 收到 `-cq NaN` 并直接失败 */
  for (const bad of [null, undefined, NaN, 'abc', {}]) {
    const v = hw.cqFor(bad);
    assert.ok(Number.isFinite(v) && v >= hw.CQ_MIN && v <= hw.CQ_MAX,
      '非法输入 ' + String(bad) + ' 应回退到合法范围内的数值，实际 ' + v);
  }
});

/* 锁的是回归 1 的另一半：不同硬件家族的质量参数**名字**不一样，
 * 统一成 -cq 会让 QSV/AMF 静默忽略画质设置（跑成默认质量）。 */
t('H3 三家硬件编码器的质量参数名必须各自正确', () => {
  const nv = hw.hwQualityArgs('nvenc', 23).join(' ');
  const qsv = hw.hwQualityArgs('qsv', 23).join(' ');
  const amf = hw.hwQualityArgs('amf', 23).join(' ');
  assert.ok(/-cq 30/.test(nv), 'NVENC 应使用 -cq 且值为 crf23+offset，实际：' + nv);
  assert.ok(/-global_quality 30/.test(qsv), 'QSV 应使用 -global_quality，实际：' + qsv);
  assert.ok(/-qp_i 30/.test(amf), 'AMF 应使用 -qp_i，实际：' + amf);
  /* 三个都不能用别的家族的参数名 */
  assert.ok(!/-global_quality/.test(nv) && !/-qp_i/.test(nv), 'NVENC 不该带 QSV/AMF 的参数');
  assert.ok(!/-cq 30/.test(qsv) && !/-cq 30/.test(amf), 'QSV/AMF 不该带 NVENC 的 -cq');
});

/* ==================== 候选筛选 ==================== */

/* 锁的是回归 2 的前半：只从 -encoders 输出里挑，且按优先级排序。
 * 这一步不判断可用性（那要真跑），只保证候选集正确。 */
t('H4 listCandidates 能从 -encoders 输出里挑出三家编码器', () => {
  const fake = [
    ' V....D libx264              libx264 H.264 (codec h264)',
    ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)',
    ' V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)',
    ' V..... h264_qsv             H.264 (Intel Quick Sync Video) (codec h264)',
    ' V....D h264_amf             AMD AMH H.264 Encoder (codec h264)',
  ].join('\n');
  const got = hw.listCandidates(fake);
  const names = got.map((x) => x.encoder);
  assert.ok(names.includes('h264_nvenc') && names.includes('hevc_nvenc'), '应挑出 NVENC');
  assert.ok(names.includes('h264_qsv'), '应挑出 QSV');
  assert.ok(names.includes('h264_amf'), '应挑出 AMF');
  assert.ok(!names.includes('libx264'), 'libx264 是 CPU 编码器，不该混进硬件候选');
  /* 优先级：NVENC 必须排在 QSV/AMF 前面（实测它最快且质量最好） */
  const idxNv = names.indexOf('h264_nvenc');
  const idxQsv = names.indexOf('h264_qsv');
  const idxAmf = names.indexOf('h264_amf');
  assert.ok(idxNv < idxQsv && idxQsv < idxAmf,
    '候选顺序必须是 nvenc < qsv < amf，实际 ' + JSON.stringify(names));
});

/* 锁的是回归 2 的后半：编译进了不等于可用。
 * 用一个假的 probeEncoder 模拟"只有 NVENC 能用"的机器。 */
t('H5 detectEncoder 必须真跑验证，且只采信能跑的那个家族', () => {
  const cands = [
    { id: 'nvenc', name: 'NVENC', encoder: 'h264_nvenc', codec: 'h264' },
    { id: 'qsv', name: 'QSV', encoder: 'h264_qsv', codec: 'h264' },
    { id: 'amf', name: 'AMF', encoder: 'h264_amf', codec: 'h264' },
  ];
  /* 模拟：只有 nvenc 可用（本机的真实情况就是 amf 不可用） */
  const det = hw.detectEncoder('ffmpeg.exe', cands, {
    probeEncoder: (f, e) => e === 'h264_nvenc',
  });
  assert.strictEqual(det.available, true, '有可用编码器时应 available=true');
  assert.strictEqual(det.family, 'nvenc', '应选中 nvenc 家族');
  assert.strictEqual(det.encoders.h264, 'h264_nvenc');
  /* 命中第一个可用家族后就不再往下探（省 600ms），但**必须如实交代**：
   * 跳过的编码器要出现在 skipped 里，不能说成"探测过且不可用"。 */
  assert.ok(det.probed.length >= 1, '至少要有一次真实的探测记录');
  assert.ok(Array.isArray(det.skipped), 'skipped 必须存在（哪怕是空数组）');
  assert.ok(det.skipped.includes('h264_qsv') && det.skipped.includes('h264_amf'),
    '因优先级被跳过的编码器必须列在 skipped 里，实际：' + JSON.stringify(det.skipped));
  /* 关键：跳过的**不能**出现在 probed 里被当成"测过但坏了" */
  assert.ok(!det.probed.some((p) => p.encoder === 'h264_qsv'),
    '跳过探测的编码器不该有 probed 记录（那是撒谎说测过）');
});

/* 锁的是「可用性判定不能漏掉不可用那个」：NVENC 不可用、QSV 可用时，
 * 必须一路探到 QSV 并选它，而不是因为第一个家族失败就放弃。 */
t('H5b 第一个家族不可用时要继续往下探，直到找到可用的', () => {
  const cands = [
    { id: 'nvenc', name: 'NVENC', encoder: 'h264_nvenc', codec: 'h264' },
    { id: 'qsv', name: 'QSV', encoder: 'h264_qsv', codec: 'h264' },
  ];
  const det = hw.detectEncoder('ffmpeg.exe', cands, {
    probeEncoder: (f, e) => e === 'h264_qsv',
  });
  assert.strictEqual(det.available, true, 'QSV 可用时不能因为 NVENC 失败就放弃');
  assert.strictEqual(det.family, 'qsv');
  assert.strictEqual(det.encoders.h264, 'h264_qsv');
  /* NVENC 是**真的探测过**且失败了，必须在 probed 里 */
  const nv = det.probed.find((p) => p.encoder === 'h264_nvenc');
  assert.ok(nv && nv.usable === false, 'NVENC 探测失败要有记录（可用于"为什么不选它"）');
});

/* 锁的是回归 2 的兜底：一个都不可用时必须明确报 available=false，
 * 而不是返回"有硬件"让上层走到一个必然失败的编码器。 */
t('H6 全都不用时 detectEncoder 必须返回 available=false', () => {
  const cands = [{ id: 'amf', name: 'AMF', encoder: 'h264_amf', codec: 'h264' }];
  const det = hw.detectEncoder('ffmpeg.exe', cands, { probeEncoder: () => false });
  assert.strictEqual(det.available, false);
  assert.strictEqual(det.family, null);
  assert.deepStrictEqual(det.encoders, {}, '不可用时不能留下编码器名');
});

/* ==================== 编码器选择 ==================== */

/* 锁的是回归 3：硬件编码族串用。探测到 h264 不代表 hevc 可用。 */
t('H7 探测到 h264 但用户要 hevc 时必须回退 CPU（不能串用）', () => {
  const probe = { available: true, family: 'nvenc', encoders: { h264: 'h264_nvenc' } };
  const h264 = hw.pickVideoEncoder({ enabled: true, probe, codec: 'h264' });
  assert.strictEqual(h264.name, 'h264_nvenc');
  assert.strictEqual(h264.hw, true);
  const hevc = hw.pickVideoEncoder({ enabled: true, probe, codec: 'hevc' });
  assert.strictEqual(hevc.name, 'libx265', 'hevc 没有硬件编码器时必须用 libx265');
  assert.strictEqual(hevc.hw, false, '回退后 hw 必须是 false（界面据此显示真实编码器）');
});

/* 锁的是"默认安全"：开关关闭时不论硬件多好都必须走 CPU。
 * 这条是本项目「不改用户可见行为」的直接体现。 */
t('H8 开关关闭 / 无硬件 / 强制 CPU 时一律回退 CPU', () => {
  const probe = { available: true, family: 'nvenc', encoders: { h264: 'h264_nvenc', hevc: 'hevc_nvenc' } };
  assert.strictEqual(hw.pickVideoEncoder({ enabled: false, probe, codec: 'h264' }).name, 'libx264',
    '开关关闭时必须用 CPU —— 硬件加速不能默认生效，那是行为变更');
  assert.strictEqual(hw.pickVideoEncoder({ enabled: true, probe: { available: false }, codec: 'h264' }).name,
    'libx264', '没有可用硬件时必须用 CPU');
  assert.strictEqual(hw.pickVideoEncoder({ enabled: true, probe, codec: 'h264', forceCpu: true }).name,
    'libx264', 'forceCpu 必须能覆盖开关（给"硬件编码失败后重试"留的口子）');
  /* 空参数不能抛异常 —— 上层调用可能没传 */
  assert.strictEqual(hw.pickVideoEncoder({}).name, 'libx264');
  assert.strictEqual(hw.pickVideoEncoder().name, 'libx264');
});

/* 锁的是回归 3 的映射侧：从编码器名反查家族（界面显示"NVENC"要用）。 */
t('H9 familyOfEncoder 能把编码器名映射回家族', () => {
  assert.strictEqual(hw.familyOfEncoder('h264_nvenc'), 'nvenc');
  assert.strictEqual(hw.familyOfEncoder('hevc_qsv'), 'qsv');
  assert.strictEqual(hw.familyOfEncoder('av1_amf'), 'amf');
  assert.strictEqual(hw.familyOfEncoder('libx264'), null, 'CPU 编码器不该映射到任何硬件家族');
  assert.strictEqual(hw.familyOfEncoder(''), null);
  assert.strictEqual(hw.familyOfEncoder(null), null);
});

/* ==================== 探测的真实行为 ==================== */

/* 锁的是回归 4：探测函数在 ffmpeg 不存在/起不来时必须返回 false，不能抛。
 * 这是「转码功能不能因为探测失败而不可用」的最底层保证。 */
t('H10 probeEncoder 对不存在的 ffmpeg 必须返回 false 而不是抛异常', () => {
  assert.strictEqual(hw.probeEncoder('', 'h264_nvenc'), false, '空路径应返回 false');
  assert.strictEqual(hw.probeEncoder('ffmpeg.exe', ''), false, '空编码器应返回 false');
  assert.strictEqual(hw.probeEncoder(null, null), false);
  /* 注入一个会抛的 spawnSync，确认被 catch 住 */
  const threw = hw.probeEncoder('x.exe', 'h264_nvenc', {
    spawnSync: () => { throw new Error('模拟 spawn 失败'); },
  });
  assert.strictEqual(threw, false, 'spawn 抛异常时必须吞掉并返回 false');
  /* 非零退出码也必须返回 false */
  assert.strictEqual(hw.probeEncoder('x.exe', 'h264_nvenc', {
    spawnSync: () => ({ status: 1, stderr: 'boom' }),
  }), false);
  /* 【退出码 0 但 stderr 里有编码器初始化错误 → 也算失败】
   * ffmpeg 在输出到 null 时可能提前结束并以 0 退出，这时 stderr 才是真相。 */
  assert.strictEqual(hw.probeEncoder('x.exe', 'h264_nvenc', {
    spawnSync: () => ({ status: 0, stderr: '[h264_amf] DLL amfrt64.dll failed to open' }),
  }), false, '退出码 0 但 stderr 报编码器打不开时，必须判为不可用');
  /* 真正成功的形态 */
  assert.strictEqual(hw.probeEncoder('x.exe', 'h264_nvenc', {
    spawnSync: () => ({ status: 0, stderr: '' }),
  }), true);
});

done();
