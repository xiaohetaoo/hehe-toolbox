'use strict';
/* 文件名里用的本地时间戳。
 *
 * ============ 锁的是哪个回归 ============
 * 项目里多处用 `new Date().toISOString()` 直接拼文件名：
 *   screen-rec  '录屏-' + ...slice(0,19).replace(/[T:]/g,'-') + '.mp4'
 *   office      new Date().toISOString().replace(/[-:T]/g,'').slice(0,14)
 *   main.js     备份 hosts 时的 `hosts-<iso>-<hex>.bak`
 *
 * toISOString() **恒为 UTC**。UTC+8 用户晚上 22:00 录屏，文件名是
 * `录屏-2026-11-08-14-00-00.mp4` —— 差 8 小时。办公文档导出的时间戳、
 * hosts 备份名同理。用户在「恢复 hosts」列表里按时间挑备份时会挑错。
 *
 * 【为什么不干脆全改成 UTC】
 * 这些名字是给**用户看和认**的（"我几点录的那个"），不是给机器排序的
 * 内部字段。内部字段（startedAt / checkedAt 这类 ISO 串）保持 UTC 不变 ——
 * 那是正确且必要的，本模块不碰它们。
 *
 * 【为什么不各自写一份 padStart】
 * 三处都要"补零 + 拼日期"，写三份必然有一份漏补零（这个项目在 EXIF
 * 解析里已经踩过一次）。收成一份，谁用谁 require 或挂全局。
 *
 * 加载方式：主进程 require；渲染层由 index.html 引入挂到 window.TimeStamp。
 */

/**
 * 把 Date 格式化成 `YYYY-MM-DD_HHmmss`（本地时间）。
 * @param {Date} [d] 缺省用当前时间
 * @returns {string}
 */
function localStamp(d) {
  const t = (d instanceof Date && !isNaN(d.getTime())) ? d : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate())
    + '_' + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds());
}

/**
 * 带毫秒的版本：`YYYY-MM-DD_HHmmss_SSS`（本地时间）。
 *
 * 【为什么 hosts 备份需要毫秒】
 * 备份名要保证唯一：同一秒内连续两次写 hosts（用户连点两下「应用」、
 * 或程序在两个窗口里同时触发）会撞名，后写的把先写的覆盖掉 ——
 * 而 hosts 备份是"出事之后唯一能还原的东西"。毫秒 + 随机后缀两道保险。
 * 注意这里仍然用**本地时间**：用户在「恢复 hosts」列表里是按自己看到的
 * 时间挑备份的，用 UTC 会挑错（这正是本轮修的那个缺陷）。
 * @param {Date} [d]
 * @returns {string}
 */
function localStampMs(d) {
  const t = (d instanceof Date && !isNaN(d.getTime())) ? d : new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate())
    + '_' + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds())
    + '_' + p(t.getMilliseconds(), 3);
}

/**
 * 文件名友好版：`YYYY-MM-DD-HHmmss`（短横线连到底，Windows 安全）。
 * @param {Date} [d]
 * @returns {string}
 */
function localStampDash(d) {
  return localStamp(d).replace('_', '-');
}

/**
 * 带毫秒的短横线版：`YYYY-MM-DD-HHmmss-SSS`。
 * hosts 备份用它（见 localStampMs 的说明）。
 * @param {Date} [d]
 * @returns {string}
 */
function localStampDashMs(d) {
  return localStampMs(d).replace('_', '-').replace('_', '-');
}

/**
 * 紧凑版：`YYYYMMDDHHmmss`（14 位，本地时间）。
 * office 导出用它做文件名前缀。
 * @param {Date} [d]
 * @returns {string}
 */
function localStampCompact(d) {
  return localStamp(d).replace(/[-_]/g, '');
}

(function (root, api) {
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    /** @type {Record<string, unknown>} */ (root).TimeStamp = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, {
  localStamp, localStampDash, localStampCompact, localStampMs, localStampDashMs
});
