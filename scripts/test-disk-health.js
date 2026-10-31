'use strict';
/* 磁盘健康库测试。重点验证「诚实处理缺失数据」这一点。
 */
const assert = require('assert');
const H = require('../lib/disk-health');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

/* ---------- 缺失数据：绝不填 0 ---------- */
t('拿不到的字段保持 null，不会被填成 0', () => {
  const r = H.shape({ disks: [{ model: 'X', size: 1000, healthStatus: 'Healthy' }], isAdmin: false });
  const d = r.disks[0];
  assert.strictEqual(d.temperature, null, '温度应为 null 而不是 0');
  assert.strictEqual(d.powerOnHours, null, '通电时长应为 null');
  assert.strictEqual(d.wear, null, '寿命应为 null');
  assert.strictEqual(d.readErrors, null, '读错误应为 null');
  assert.strictEqual(d.hasSmart, false, '不该声称有 SMART 数据');
});

t('完全没有 SMART 时，结论明确说「无法判断寿命」', () => {
  const r = H.shape({ disks: [{ model: 'X', healthStatus: 'Healthy', operationalStatus: 'OK' }] });
  const v = r.disks[0].verdict;
  assert.strictEqual(v.level, 'unknown', '应判 unknown 而不是 ok');
  assert.ok(/无法据此判断寿命/.test(v.text), '应明说无法判断：' + v.text);
  assert.ok(/没有可用的数据/.test(v.text), '应明说没有数据：' + v.text);
  // 关键：绝不能说「健康」
  assert.ok(!/健康度/.test(v.text), '不该出现「健康度」这种合成指标');
});

t('限制说明会解释为什么取不到（而不是让用户猜）', () => {
  const r = H.shape({ disks: [{ model: 'X' }], isAdmin: false });
  const txt = r.limitations.join(' ');
  assert.ok(/不是管理员/.test(txt), '应提示提权可能有用');
  assert.ok(/本机确实取不到/.test(txt), '应明说本机取不到，不是程序出错');
  assert.ok(/SATA|厂商驱动|USB/i.test(txt), '应列举常见原因');
});

t('是管理员时不再提示「需要提权」', () => {
  const r = H.shape({ disks: [{ model: 'X' }], isAdmin: true });
  assert.ok(!/不是管理员/.test(r.limitations.join(' ')), '已是管理员就不该再提示提权');
});

/* ---------- 有数据时的判断 ---------- */
t('系统报不健康 → 判 bad 且建议备份', () => {
  const r = H.shape({ disks: [{ model: 'X', healthStatus: 'Warning' }] });
  const v = r.disks[0].verdict;
  assert.strictEqual(v.level, 'bad');
  assert.ok(/备份/.test(v.text), '应建议备份');
});

t('运行状态非 OK → 判 bad', () => {
  const r = H.shape({ disks: [{ model: 'X', healthStatus: 'Healthy', operationalStatus: 'Degraded' }] });
  assert.strictEqual(r.disks[0].verdict.level, 'bad');
});

t('有 SMART 且都正常 → 判 ok', () => {
  const r = H.shape({ disks: [{ model: 'X', healthStatus: 'Healthy', operationalStatus: 'OK',
    temperature: 40, powerOnHours: 1000, wear: 5, readErrors: 0, writeErrors: 0 }] });
  const v = r.disks[0].verdict;
  assert.strictEqual(v.level, 'ok');
  assert.ok(/未见异常/.test(v.text), '实际：' + v.text);
});

t('寿命接近上限 → 判 warn', () => {
  const r = H.shape({ disks: [{ model: 'X', healthStatus: 'Healthy', wear: 85 }] });
  const v = r.disks[0].verdict;
  assert.strictEqual(v.level, 'warn');
  assert.ok(/85%/.test(v.text), '应带上具体数值：' + v.text);
});

t('温度偏高 → 判 warn', () => {
  const r = H.shape({ disks: [{ model: 'X', healthStatus: 'Healthy', temperature: 75 }] });
  assert.strictEqual(r.disks[0].verdict.level, 'warn');
});

t('有读写错误 → 判 warn 并带上次数', () => {
  const r = H.shape({ disks: [{ model: 'X', healthStatus: 'Healthy', readErrors: 3, writeErrors: 2 }] });
  const v = r.disks[0].verdict;
  assert.strictEqual(v.level, 'warn');
  assert.ok(/5 次/.test(v.text), '应合计错误次数：' + v.text);
});

t('部分字段缺失时，结论只依据实际拿到的那些', () => {
  const r = H.shape({ disks: [{ model: 'X', healthStatus: 'Healthy', wear: 10 }] });
  const v = r.disks[0].verdict;
  assert.strictEqual(v.level, 'ok');
  assert.ok(/10%/.test(v.text), '应展示已有读数：' + v.text);
  // 不该因为缺温度就说异常
  assert.ok(!/温度/.test(v.text), '缺温度时不该提温度：' + v.text);
});

/* ---------- 寿命预测：拿不到就不给 ---------- */
t('没有 wear 数据时不给出寿命预测', () => {
  assert.strictEqual(H.estimateRemaining(null), null, '应返回 null');
  assert.strictEqual(H.estimateRemaining(undefined), null, '应返回 null');
  assert.strictEqual(H.estimateRemaining('abc'), null, '非数字应返回 null');
});

t('有 wear 时给出百分比换算，并明确这是厂商口径', () => {
  const r = H.estimateRemaining(20);
  assert.ok(r, '应给出结果');
  assert.ok(/剩余寿命约 80%/.test(r.text), '实际：' + r.text);
  assert.ok(/caveat/.test(Object.keys(r).join(',')), '应带 caveat 字段');
  assert.ok(/不代表剩余时间/.test(r.caveat), '必须说明不是剩余时间：' + r.caveat);
});

t('寿命用尽时给出明确警告', () => {
  const r = H.estimateRemaining(100);
  assert.ok(/随时可能失效/.test(r.text), '实际：' + r.text);
});

t('剩余不足 10% 时提示尽快备份', () => {
  const r = H.estimateRemaining(95);
  assert.ok(/尽快备份/.test(r.text), '实际：' + r.text);
});

/* ---------- 空数据 ---------- */
t('没有枚举到磁盘时给诚实说明', () => {
  const r = H.shape({ disks: [] });
  assert.ok(r.limitations.join(' ').indexOf('没有枚举到任何物理磁盘') !== -1);
});

t('shape 能处理完全空的入参', () => {
  const r = H.shape({});
  assert.deepStrictEqual(r.disks, []);
  assert.ok(r.limitations.length > 0);
});

/* ---------- HealthStatus = Unknown 不是「要坏了」 ----------
 * Get-PhysicalDisk 对不少 USB 盒、RAID 卡后面的盘返回的 HealthStatus
 * 就是 Unknown（读不到，而不是读到了坏消息）。早期 `hs !== 'healthy'` 一律
 * 判 bad，把「读不到」渲染成「有问题」，正好违背本模块头写的原则。 */
t('HealthStatus 为 Unknown 时判 unknown，不说「要坏了」', () => {
  const r = H.shape({ disks: [{ model: 'USB', healthStatus: 'Unknown', operationalStatus: 'OK' }] });
  const v = r.disks[0].verdict;
  assert.strictEqual(v.level, 'unknown', 'Unknown 不该判 bad，实际 ' + v.level);
  assert.ok(!/尽快备份/.test(v.text), '不该让用户以为盘要坏了：' + v.text);
});

t('OperationalStatus 为 Unknown 时也判 unknown', () => {
  const r = H.shape({ disks: [{ model: 'X', healthStatus: 'Healthy', operationalStatus: 'Unknown' }] });
  const v = r.disks[0].verdict;
  assert.strictEqual(v.level, 'unknown', 'OperationalStatus Unknown 不该判 bad，实际 ' + v.level);
  assert.ok(!/尽快备份/.test(v.text), '不该让用户以为盘要坏了：' + v.text);
});

t('HealthStatus 为 Unhealthy 时确实判 bad（明确的坏消息不能放过）', () => {
  const r = H.shape({ disks: [{ model: 'X', healthStatus: 'Unhealthy' }] });
  const v = r.disks[0].verdict;
  assert.strictEqual(v.level, 'bad', 'Unhealthy 必须判 bad，实际 ' + v.level);
  assert.ok(/尽快备份/.test(v.text), '应提示备份：' + v.text);
});

t('HealthStatus 为 Warning 时判 bad', () => {
  const r = H.shape({ disks: [{ model: 'X', healthStatus: 'Warning' }] });
  assert.strictEqual(r.disks[0].verdict.level, 'bad', 'Warning 必须判 bad');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
