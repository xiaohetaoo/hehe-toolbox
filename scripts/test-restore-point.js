'use strict';
/* 系统还原点：解析器行为 + 高危门禁接线（第四轮新增工具）。
 *
 * 解析器的判据为什么值得单独测：WMI 的时间是 DMTF 字符串（直接 new Date 得到
 * Invalid Date），vssadmin 的输出**随语言变**（zh-CN 与 en-US 标签完全不同），
 * 而且它要管理员。真机跑需要管理员权限与已启用的系统保护，CI 上不可能稳定。
 * 所以：文本形状用样本断言，接线用源码断言（哪条通道归哪个能力）。
 */
const { t, done, readSrc } = require('./lib/harness');
const assert = require('assert');
const rp = require('../lib/restore-point');

t('RP1 DMTF 时间解析：合法值按本地时间，非法值返回 null', () => {
  const ms = rp.parseDmtfTime('20261114120000.000000-000');
  const d = new Date(ms);
  /* 锁的是：直接用 new Date(字符串) —— 得到 Invalid Date，界面显示 NaN。 */
  assert.ok(Number.isFinite(ms), 'DMTF 时间必须解析成毫秒数');
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 10, '月份应从 1-based 转成 0-based');
  assert.strictEqual(d.getDate(), 14);
  assert.strictEqual(d.getHours(), 12);
  /* 锁的是：非法月份被静默滚动到次年 —— 时间显示错一年。 */
  assert.strictEqual(rp.parseDmtfTime('20261314120000.000000-000'), null);
  assert.strictEqual(rp.parseDmtfTime('20260230120000.000000-000'), null, '2 月 30 日必须拒绝');
  assert.strictEqual(rp.parseDmtfTime('not-a-time'), null);
  assert.strictEqual(rp.parseDmtfTime(null), null);
});

t('RP2 还原点归一化：字段映射、倒序、丢掉无信息行', () => {
  const out = rp.normalizePoints([
    { SequenceNumber: 1, Description: '旧', CreationTime: '20260101000000.000000-000', EventType: 100 },
    { SequenceNumber: 2, Description: '新', CreationTime: '20261101000000.000000-000', EventType: 100 },
    { Description: '没有序号也没有时间' },
    null,
  ]);
  /* 锁的是：按序号而不是时间排 —— 系统还原序号在清理后会重排，时间才是真序。 */
  assert.deepStrictEqual(out.map((p) => p.seq), [2, 1]);
  assert.strictEqual(out[0].description, '新');
  /* 锁的是：无信息行被渲染成空白行。 */
  assert.strictEqual(out.length, 2);
});

t('RP3 vssadmin 输出解析：中文/英文两种标签都认', () => {
  const en = [
    'Shadow Copy Storage association',
    '   Used Shadow Copy Storage space: 1.5 GB (7%)',
    '   Maximum Shadow Copy Storage space: 20.0 GB (10%)',
  ].join('\n');
  const zh = [
    '卷影副本存储关联',
    '   已用卷影副本存储空间: 1.5 GB (7%)',
    '   最大卷影副本存储空间: 20.0 GB (10%)',
  ].join('\n');
  for (const [label, text] of [['en', en], ['zh', zh]]) {
    const s = rp.parseVssStorage(text);
    /* 锁的是：只认英文标签 —— 中文系统上「存储占用」永远显示取不到。 */
    assert.ok(s, label + ' 输出应能解析');
    assert.strictEqual(s.used, Math.round(1.5 * 1024 ** 3), label + ' used 不对');
    assert.strictEqual(s.max, Math.round(20 * 1024 ** 3), label + ' max 不对');
    assert.strictEqual(s.pct, 7, label + ' 百分比应取括号里的值');
  }
  /* 锁的是：解析不出来时返回 0 —— 界面会显示「已用 0B」，用户以为没占空间。 */
  assert.strictEqual(rp.parseVssStorage('没有可解析的内容'), null);
  assert.strictEqual(rp.parseVssStorage(''), null);
});

t('RP4 百分比缺失时按 used/max 计算（不编造）', () => {
  const s = rp.parseVssStorage('Used Shadow Copy Storage space: 512 MB\nMaximum Shadow Copy Storage space: 2 GB');
  assert.strictEqual(s.used, 512 * 1024 ** 2);
  assert.strictEqual(s.pct, 25, '缺百分比时应由 used/max 算出 25%');
  const half = rp.parseVssStorage('Used Shadow Copy Storage space: 512 MB');
  /* 锁的是：只有 used 时硬算百分比 —— 分母未知，只能给 null。 */
  assert.strictEqual(half.pct, null, '没有上限时百分比必须是 null');
});

t('RP5 删除通道必须挂上新高危能力（门禁接线）', () => {
  const main = readSrc('main.js');
  /* 锁的是：能力登记了却没映射通道 —— 开关拨了不生效，未开启也能删还原点。
   * 这是 acl-repair 那条历史事故的同款（见 CAP_GATED_CHANNELS 里的注释）。 */
  assert.ok(/'restore-point-delete'/.test(main), 'DANGEROUS_CAP_IDS / CAP_TEXT 里没有新能力');
  assert.ok(/'sys:restore-delete':\s*'restore-point-delete'/.test(main),
    'CAP_GATED_CHANNELS 没有把删除通道挂到新能力上');
  /* 锁的是：工具没登记到 TOOL_DANGEROUS_CAPS —— 卡片不标红、开关拨了不生效。 */
  assert.ok(/'restore-points':\s*\[\s*'restore-point-delete'\s*\]/.test(main),
    'TOOL_DANGEROUS_CAPS 没有登记 restore-points（工具卡片不会标红）');
  /* 锁的是：把整个工具锁死 —— 列表/创建是无害的，锁页会让用户以为功能坏了。 */
  const app = readSrc('js/app.js');
  assert.ok(/DELETE_ONLY_TOOLS[^\n]*'restore-points'/.test(app),
    'restore-points 应进 DELETE_ONLY_TOOLS（部分锁定）');
});

t('RP6 界面：删除必须二次确认且说明会清掉其它卷影副本', () => {
  const ui = readSrc('js/tools/sys-tools.js');
  const at = ui.indexOf("id: 'restore-points'");
  assert.ok(at >= 0, '找不到 restore-points 工具');
  const seg = ui.slice(at, at + 4200);
  /* 锁的是：删除没有 danger 确认 —— 一次误点清空全部还原点。 */
  assert.strictEqual((seg.match(/danger: true/g) || []).length >= 2, true,
    '删除最旧 / 删除全部都要 danger 确认');
  assert.ok(/卷影副本/.test(seg), '文案必须说明删的是卷影副本（会连带其它备份）');
  /* 锁的是：创建走的通道写错 —— 点「创建还原点」却调了删除。 */
  assert.ok(/RESTORE_CREATE/.test(seg), '创建按钮应调用 RESTORE_CREATE');
  assert.ok(/RESTORE_DELETE, 'oldest'/.test(seg) && /RESTORE_DELETE, 'all'/.test(seg),
    '两个删除入口应分别传 oldest / all');
});

t('RP7 创建还原点的描述必须先净化（换行会变成 PS 语句分隔符）', () => {
  const main = readSrc('main.js');
  const at = main.indexOf("handle(CH.SYS.RESTORE_CREATE");
  assert.ok(at >= 0, '找不到 restore-create');
  const seg = main.slice(at, at + 900);
  /* 锁的是：描述原样拼进 PowerShell —— 换行在本项目里已证实是语句分隔符。 */
  assert.ok(/replace\(\/\[\\r\\n\]\+\/g, ' '\)/.test(seg), '描述里的换行必须被替换成空格');
  assert.ok(/psSingleQuote\(desc\)/.test(seg), '描述必须经过单引号转义');
  assert.ok(/slice\(0, 100\)/.test(seg), '描述长度要截断');
});

done();