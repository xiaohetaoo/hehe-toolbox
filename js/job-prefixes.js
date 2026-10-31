/* 后台任务 id 前缀表（渲染层版本）。
 *
 * 【为什么需要这个文件】
 * 主进程那边有 lib/job-id.js 里登记了所有前缀，并提供了 belongsTo / acceptsEvent。
 * 但渲染层受 contextIsolation 限制**无法 require** lib/，于是各工具只能各写各的：
 *   /^avc\d+$/, /^prs\d+$/, /^qs\d+$/, /^cs\d+$/, /^dl\d+$/, /^tgt/, /^tts/
 * 一旦主进程改了前缀（比如 avc → avc2），这些正则全部失配，
 * 而这条链路没有任何编译期检查 —— 只能靠运行时发现。
 *
 * 本文件把同一份前缀表放到渲染层，并提供一个统一判定函数。
 * scripts/test-job-prefix-sync.js 会校验它与 lib/job-id.js 是否一致，
 * 两边不同步时测试会直接失败（而不是等到用户那边进度条不动才暴露）。
 */
(function () {
  'use strict';

  /* 与 lib/job-id.js 的 JOB_PREFIXES 保持一一对应 */
  const JOB_PREFIXES = {
    scan: '磁盘空间分析',
    empty: '空目录清理',
    dedupe: '重复文件查找',
    job: '哈希计算',
    scanp: '端口扫描',
    speed: '网速测试',
    dl: '文件下载（FFmpeg 安装包）',
    dl2: '文件下载（通用下载器）',
    avc: '音视频格式转换',
    prs: '视频压制',
    tgt: '目标体积压缩',
    qs: '全局文件快扫',
    cs: '文件内容搜索',
    tts: '文本朗读导出',
    usn: 'NTFS 索引扫描',
    lanscan: '局域网设备扫描',
    /* 与 lib/job-id.js 同步。目录搬家的 id 由主进程生成（dirmv+序号），
     * 渲染层只把本次的 jobId 传给主进程并等它回传的同一个 id，
     * 不再自己拼带连字符的 id。 */
    dirmv: '目录搬家'
  };

  /**
   * 判断某个事件 id 是否属于指定前缀（形如 前缀+数字）。
   * @param {string} id
   * @param {string} prefix
   * @returns {boolean}
   */
  function belongsTo(id, prefix) {
    if (typeof id !== 'string' || !id) return false;
    if (typeof prefix !== 'string' || !prefix) return false;
    return new RegExp('^' + prefix + '\\d+$').test(id);
  }

  /**
   * 订阅过滤器的便捷写法：已认领时只认那一个 id，未认领时按前缀认领。
   * 用法（在 job:stream / job:progress 回调开头）：
   *     if (!jobFilter.accepts(d.id, runJobIdRef)) return;
   * 具体见各工具页面里的用法。
   */
  function accepts(current, incoming, prefix) {
    if (current) return incoming === current;
    return belongsTo(incoming, prefix);
  }

  window.JobPrefix = { JOB_PREFIXES, belongsTo, accepts };
})();
