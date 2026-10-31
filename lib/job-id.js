'use strict';
/* 后台任务 id 的归属判定（纯函数）。
 *
 * 【为什么单独抽出来】
 * 1. 渲染层有多个页面订阅同一个全局事件 `job:stream`，事件里只带 `{id, data}`。
 *    如果订阅者不校验 id 归属，就会读到**别的任务**的进度 —— 比如你正在压缩视频，
 *    另一个标签页恰好在算哈希，进度条就会跟着乱跳（v0.0.10 修过一次 kind 串扰）。
 * 2. 更严重的是「取消」：取消按钮要 kill 的是**自己那个**任务。
 *    以前 `if (!runJobId && d.id) runJobId = d.id` 会抓任意任务的 id，
 *    结果点取消杀掉的是别人。
 * 3. 抽成纯函数后，单元测试可以直接调真实现，而不是"复刻一份逻辑"——
 *    复刻的测试在源码改动后照样全绿，等于没测（这就是"假绿"）。
 *
 * 【id 命名约定】main.js 里所有后台任务都是 `<前缀><自增序号>`，
 * 前缀区分任务类型。新增任务时请在这里登记前缀，并在订阅端用 claimJobId。
 */

/* 各后台任务的 id 前缀 → 用途说明（与 main.js 的 `const id = '<前缀>' + (++jobSeq)` 对应） */
const JOB_PREFIXES = {
  scan: '磁盘空间分析',
  empty: '空目录清理',
  dedupe: '重复文件查找',
  job: '哈希计算',
  scanp: '端口扫描',
  speed: '网速测试',
  dl: '文件下载',
  dl2: '下载（第二类）',
  avc: '音视频格式转换',
  prs: '视频压制',
  tgt: '目标体积压缩',
  qs: '全局文件快扫',
  cs: '文件内容搜索',
  tts: '文本朗读导出',
  usn: 'NTFS 索引扫描',
  lanscan: '局域网设备扫描',
  /* 目录搬家。前缀必须是「前缀 + 纯数字」，早期渲染层自己拼
   * 'dirmv-' + Date.now()（带连字符、且不在这两张表里）——
   * 于是 belongsTo 永远不匹配、test-job-prefix-sync 也覆盖不到。 */
  dirmv: '目录搬家'
};

/**
 * 判断某个 job id 是否属于指定前缀（即是否为本页面发起的任务）。
 * @param {string} id     事件里的 job id
 * @param {string} prefix 期望的前缀（如 'avc'）
 * @returns {boolean}
 */
function belongsTo(id, prefix) {
  if (typeof id !== 'string' || !id) return false;
  if (typeof prefix !== 'string' || !prefix) return false;
  // 必须"前缀 + 纯数字"，避免 avc 匹配到 avc1x 这类
  return new RegExp('^' + prefix + '\\d+$').test(id);
}

/**
 * 从事件流里认领属于自己的 job id：第一次遇到匹配前缀的 id 就记住它，
 * 之后只认这一个（避免同一页面并发多任务时串号）。
 *
 * @param {object} p
 * @param {string|null} current 当前已认领的 id（null 表示还没认领）
 * @param {string} incoming       本事件的 id
 * @param {string} prefix         本页面任务的 id 前缀
 * @returns {{id: string|null, claimed: boolean}}
 *   id      = 认领后的 id（可能是原值、新认领、或 null 表示不认）
 *   claimed = 本次调用是否刚刚认领成功
 */
function claimJobId({ current, incoming, prefix }) {
  if (current) {
    // 已认领：只认这一个 id，别的一律忽略
    return { id: current, claimed: false, belongs: incoming === current };
  }
  if (!belongsTo(incoming, prefix)) {
    return { id: null, claimed: false, belongs: false };
  }
  return { id: incoming, claimed: true, belongs: true };
}

/* 便捷判断：事件是否应当被本页面处理（已认领时只认那一个，未认领时按前缀认领） */
function acceptsEvent({ current, incoming, prefix }) {
  if (current) return incoming === current;
  return belongsTo(incoming, prefix);
}

module.exports = { JOB_PREFIXES, belongsTo, claimJobId, acceptsEvent };
