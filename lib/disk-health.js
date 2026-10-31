'use strict';
/* 磁盘健康：把「能拿到什么」「拿不到什么」如实分开（纯逻辑）。
 *
 * 【为什么这个模块大部分代码在处理「拿不到」】
 * 磁盘健康数据在 Windows 上非常不可靠：
 *   - SATA 盘要经 storage 驱动，普通权限经常拿不到 SMART；
 *   - 某些厂商驱动（RAID 卡、NVMe 专用驱动）会拦截 IOCTL；
 *   - 笔记本的 USB 外置盘基本拿不到；
 *   - Windows 沙盒/无管理员权限时 Get-StorageReliabilityCounter 直接返回空。
 *
 * 实测（本机 NVMe SSD）：
 *   Get-PhysicalDisk              → 有（型号/介质/总线/健康状态）
 *   Get-StorageReliabilityCounter → **拿不到**（返回空）
 *   MSStorageDriver_FailurePredictStatus → 拿不到
 *   Win32_DiskDrive.Status        → 有（只有 "OK"/"Error" 这种粗粒度状态）
 *
 * 所以本模块的核心原则是：
 *   1. 拿不到的字段一律标为 null，**绝不填 0**；
 *   2. 绝不合成一个「健康度 95%」这样的数字 —— 那比不显示更糟，
 *      用户会拿它当决策依据；
 *   3. 界面上要和用户说清「本机取不到」，以及可能的原因。
 *
 * 只有一种情况可以给出「预测」：拿到 power-on hours + 官方的 wear 百分比，
 * 并且明确标注这是厂商上报值，不是我们算的。
 */

/* 每个字段的来源标记，界面据此决定显示数值还是「本机取不到」 */
const FIELD = {
  model: { label: '型号', reliable: true },
  mediaType: { label: '介质类型', reliable: true },
  busType: { label: '接口', reliable: true },
  size: { label: '容量', reliable: true },
  healthStatus: { label: '系统健康状态', reliable: true, note: 'Windows 给的粗粒度状态，不是 SMART' },
  temperature: { label: '温度', reliable: false },
  powerOnHours: { label: '通电时长', reliable: false },
  wear: { label: '已用寿命', reliable: false, note: '厂商上报的磨损百分比' },
  readErrors: { label: '读错误计数', reliable: false },
  writeErrors: { label: '写错误计数', reliable: false },
  startStop: { label: '启停次数', reliable: false },
};

/**
 * 把「原始采集结果」整理成给界面用的结构。纯函数，便于测试各种
 * 「部分字段缺失」的组合。
 *
 * @param {object} raw
 * @param {Array} raw.disks 每个盘的原始字段（可能缺很多）
 * @param {boolean} raw.isAdmin
 * @returns {{disks:Array, totals:object, limitations:string[]}}
 */
function shape(raw) {
  const x = raw || {};
  const disks = (x.disks || []).map((d, i) => {
    const missing = [];
    const out = {
      index: i,
      model: d.model || null,
      mediaType: d.mediaType || null,
      busType: d.busType || null,
      size: d.size != null ? Number(d.size) : null,
      healthStatus: d.healthStatus || null,
      operationalStatus: d.operationalStatus || null,
      /* 以下都可能为 null —— 界面上显示「本机取不到」而不是 0 */
      temperature: d.temperature != null ? Number(d.temperature) : null,
      powerOnHours: d.powerOnHours != null ? Number(d.powerOnHours) : null,
      wear: d.wear != null ? Number(d.wear) : null,
      readErrors: d.readErrors != null ? Number(d.readErrors) : null,
      writeErrors: d.writeErrors != null ? Number(d.writeErrors) : null,
      startStop: d.startStop != null ? Number(d.startStop) : null,
      /** 厂商是否上报了健康原始数据 */
      hasSmart: false,
    };
    for (const k of ['temperature', 'powerOnHours', 'wear', 'readErrors', 'writeErrors', 'startStop']) {
      if (out[k] == null) missing.push(FIELD[k].label);
    }
    out.hasSmart = missing.length < 6;   // 至少拿到一部分才算有 SMART 数据
    out.missingFields = missing;
    out.verdict = verdictOf(out);
    return out;
  });

  /* 限制说明：告诉用户为什么有些字段是空的，而不是让他自己猜 */
  const limitations = [];
  if (!x.isAdmin) {
    limitations.push('当前不是管理员运行 —— 部分磁盘的健康数据需要提权才能读取。');
  }
  const noSmart = disks.filter((d) => !d.hasSmart);
  if (noSmart.length) {
    limitations.push(
      '有 ' + noSmart.length + ' 块盘读不到 SMART 明细（温度/通电时长/寿命）。' +
      '常见原因：SATA 盘需要特定驱动接口、厂商驱动拦截了读取、外置 USB 盘不支持，' +
      '或系统策略限制了普通权限访问。这不是程序出错，是本机确实取不到。');
  }
  if (!disks.length) {
    limitations.push('没有枚举到任何物理磁盘。若你能在「磁盘管理」里看到盘，可能是存储驱动异常。');
  }
  return { disks, limitations, isAdmin: !!x.isAdmin };
}

/**
 * 给单块盘一个诚实结论。**只在有依据时才说「可能有问题」**。
 * @param {object} d shape 后的单盘对象
 * @returns {{level:string, text:string}}
 */
function verdictOf(d) {
  /* 【Unknown 不等于有问题】
   * Get-PhysicalDisk 对不少 USB 盒、RAID 卡后面的盘返回的 HealthStatus
   * 就是 Unknown（读不到，而不是读到了坏消息）。早期这里是
   * `if (hs && hs !== 'healthy') → bad`，一律给「建议尽快备份」——
   * 把「读不到」渲染成了「有问题」，正好违背本文件头写的原则
   * （拿不到就说拿不到，不猜）。同理 OperationalStatus 也有 Unknown。
   *
   * 现在只在系统**明确**报了 Warning / Unhealthy 时才判 bad；
   * Unknown / 空值 归入 unknown，文案讲清「这不等于有问题，只是没有数据」。 */
  const hs = String(d.healthStatus || '').trim().toLowerCase();
  const op = String(d.operationalStatus || '').trim().toLowerCase();

  if (hs === 'warning' || hs === 'unhealthy') {
    return { level: 'bad', text: '系统报告该盘状态为「' + d.healthStatus + '」，建议尽快备份' };
  }
  if (op && op !== 'ok' && op !== 'healthy' && op !== 'unknown') {
    return { level: 'bad', text: '系统报告运行状态为「' + d.operationalStatus + '」，建议尽快备份' };
  }

  // 2) 有 SMART：按读数判断
  const hasAny = d.temperature != null || d.powerOnHours != null || d.wear != null
    || d.readErrors != null || d.writeErrors != null;
  if (!hasAny) {
    /* 只有系统状态。明确说明「检测能力有限」，不要假装是健康评估 */
    return {
      level: 'unknown',
      text: '系统状态正常。但本机读不到 SMART 明细，无法据此判断寿命 —— ' +
            '这不等于「没有问题」，只是「没有可用的数据」。',
    };
  }

  const issues = [];
  if (d.wear != null && d.wear >= 80) issues.push('已用寿命 ' + d.wear + '%（接近上限）');
  else if (d.wear != null && d.wear >= 60) issues.push('已用寿命 ' + d.wear + '%（开始进入后半程）');
  if (d.temperature != null && d.temperature >= 70) issues.push('温度 ' + d.temperature + '°C（偏高）');
  const errs = (d.readErrors || 0) + (d.writeErrors || 0);
  if (errs > 0) issues.push('累计读写错误 ' + errs + ' 次');

  if (issues.length) {
    return { level: 'warn', text: '系统状态正常，但注意到：' + issues.join('；') };
  }
  return {
    level: 'ok',
    text: '系统状态正常，SMART 读数未见异常' +
      (d.wear != null ? '（已用寿命 ' + d.wear + '%）' : ''),
  };
}

/**
 * 「还能用多久」—— 只有拿到厂商的 wear 百分比时才能给，且必须标注不确定性。
 * 拿不到就返回 null，**绝不估算**。
 *
 * @param {number|null} wear 已用寿命百分比（0-100）
 * @returns {{text:string, confidence:string}|null}
 */
function estimateRemaining(wear) {
  if (wear == null || !Number.isFinite(Number(wear))) return null;
  const w = Number(wear);
  if (w <= 0) return { text: '厂商未给出磨损数据', confidence: 'none' };
  /* 磨损速度是非线性的（前期快、后期也可能突变），所以只能说「大致」。
   * 用「剩余寿命比例」而不是「剩余天数」—— 我们不知道用户每天写多少。
   * 关键：**明确这是厂商口径的百分比，不是剩余时间**。 */
  const left = Math.max(0, 100 - w);
  let rough;
  if (left <= 0) rough = '已达厂商标定的寿命上限，随时可能失效';
  else if (left <= 10) rough = '剩余寿命已不足 10%，请尽快备份重要数据';
  else if (left <= 30) rough = '剩余寿命约 ' + left + '%，建议开始规划更换或迁移';
  else rough = '剩余寿命约 ' + left + '%';
  return {
    text: rough,
    confidence: 'low',
    caveat: '这是厂商上报的磨损百分比换算，不代表剩余时间 —— 实际失效时间还取决于写入量、温度与运气。',
  };
}

module.exports = { FIELD, shape, verdictOf, estimateRemaining };
