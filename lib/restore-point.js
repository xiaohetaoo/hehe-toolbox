'use strict';
/* 系统还原点：WMI 时间与 vssadmin 输出的纯解析（主进程与测试共用）。
 *
 * 【为什么放在 lib】
 * 这两块全是「按文本形状取数」的活：
 *   · CreationTime 是 DMTF 格式 `20261114120000.000000-000`，直接 new Date() 得到 Invalid Date；
 *   · vssadmin 的输出是**本地化**的（zh-CN 与 en-US 标签完全不同，单位写法也不同）。
 * 放在 main.js 里就只能靠读源码断言；抽出来之后测试可以直接喂两种语言的样本。
 *
 * 副作用为 0：不碰 IO、不碰 Electron。
 */

/** PowerShell 单条结果会返回对象而不是数组，先统一 */
function asArray(v) {
  if (Array.isArray(v)) return v;
  return v == null || v === '' ? [] : [v];
}

/**
 * 解析 DMTF 时间。Windows 的 WMI 时间形如：
 *   20261114120000.000000-000
 * 末尾的 -000 是「UTC 偏移未知，按本地时间理解」，所以这里按本地时间构造。
 * @param {any} input
 * @returns {number|null} 毫秒时间戳；解析不了返回 null（不猜）
 */
function parseDmtfTime(input) {
  const s = String(input == null ? '' : input).trim();
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?(?:[+-]\d{3})?$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), se = Number(m[6]);
  const frac = m[7] ? Number((m[7] + '000').slice(0, 3)) : 0;
  /* 月份/日期越界时 JS 会静默滚动到下一个月（与 EXIF 的坑同一个），
   * 这里先做一次范围检查，非法值直接返回 null。 */
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const dt = new Date(y, mo - 1, d, h, mi, se, frac);
  if (dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 还原点归一化：字段映射 + 按时间倒序 + 丢掉完全无信息的行。
 * @param {any} rows
 * @returns {{seq:number,description:string,time:number|null,eventType:number}[]}
 */
function normalizePoints(rows) {
  return asArray(rows)
    .map((r) => ({
      seq: Number(r && (r.SequenceNumber != null ? r.SequenceNumber : r.seq)) || 0,
      description: String((r && (r.Description != null ? r.Description : r.description)) || ''),
      time: parseDmtfTime(r && (r.CreationTime != null ? r.CreationTime : r.time)),
      eventType: Number((r && (r.EventType != null ? r.EventType : r.eventType))) || 0,
    }))
    .filter((p) => p.seq > 0 || p.time != null)
    .sort((a, b) => (b.time || 0) - (a.time || 0));
}

/* vssadmin 的单位。zh-CN 会输出「字节 / 千字节 / 兆字节 / 吉字节」，
 * en-US 输出 B / KB / MB / GB；两种都要认。 */
const UNITS = {
  'b': 1, 'byte': 1, 'bytes': 1, '字节': 1,
  'kb': 1024, '千字节': 1024,
  'mb': 1024 ** 2, '兆字节': 1024 ** 2,
  'gb': 1024 ** 3, '吉字节': 1024 ** 3,
  'tb': 1024 ** 4,
};

/** 从「1.23 GB」这种片段取字节数 */
function parseSizeToken(numText, unitText) {
  const n = Number(String(numText || '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = String(unitText || '').toLowerCase();
  const mul = UNITS[unit];
  return mul ? Math.round(n * mul) : null;
}

/**
 * 解析 `vssadmin list shadowstorage` 的输出（zh-CN / en-US 均可）。
 *
 * 【为什么不用 WMI 取】Win32_ShadowStorage 在部分系统上拿不到关联对象，
 * 而 vssadmin 是同一份数据的稳定来源；代价是输出随语言变，所以这里的
 * 判据按「标签关键词」而不是整行匹配，并同时认中英文。
 *
 * @param {string} text
 * @returns {{used:number|null,max:number|null,pct:number|null}|null} 解析不出返回 null（不编 0）
 */
function parseVssStorage(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return null;
  /* 「已用卷影副本存储空间: 1.2 GB (5%)」/「Used Shadow Copy Storage space: 1.2 GB (5%)」
   * 标签里可能带冒号（中英文冒号都见得到），单位后可能带括号百分比。 */
  const usedRe = /(?:已用|已使用的|Used)\s*(?:卷影副本|Shadow Copy)?\s*(?:存储空间|Storage space)\s*[:：]\s*([\d.,]+)\s*([A-Za-z\u4e00-\u9fa5]+)(?:\s*\((\d+)%\))?/i;
  const maxRe = /(?:最大|Maximum)\s*(?:卷影副本|Shadow Copy)?\s*(?:存储空间|Storage space)\s*[:：]\s*([\d.,]+)\s*([A-Za-z\u4e00-\u9fa5]+)(?:\s*\((\d+)%\))?/i;
  const mu = usedRe.exec(s);
  const mm = maxRe.exec(s);
  const used = mu ? parseSizeToken(mu[1], mu[2]) : null;
  const max = mm ? parseSizeToken(mm[1], mm[2]) : null;
  let pct = mu && mu[3] != null ? Number(mu[3]) : null;
  if (pct == null && used != null && max) pct = Math.round(used / max * 100);
  if (used == null && max == null) return null;
  return { used, max, pct };
}

module.exports = { asArray, parseDmtfTime, normalizePoints, parseVssStorage, parseSizeToken };