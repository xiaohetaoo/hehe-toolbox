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
    dirscan: '目录逐层统计',
    empty: '空目录清理',
    dedupe: '重复文件查找',
    job: '哈希计算',
    scanp: '端口扫描',
    speed: '网速测试',
    dl: '文件下载（FFmpeg 安装包）',
    /* 通用下载器用 dlg 而不是 dl2。
     * 【为什么不能叫 dl2】belongsTo 用 `^前缀\d+$` 判断归属，而 'dl' 是 'dl2'
     * 的真前缀：任务 id `dl2123`（dlg 之前的写法是 dl2 + 123 = dl2123）
     * 会**同时**匹配 `^dl\d+$` 和 `^dl2\d+$`，于是同一个 id 归属两个任务类型。
     * 实测后果：FFmpeg 下载页的进度条会被通用下载器的进度驱动
     * （media.js 那边用的正是 /^dl\d+$/）。改成不等长前缀重叠的名字彻底避开。 */
    dlg: '文件下载（通用下载器）',
    avc: '音视频格式转换',
    prs: '视频压制',
    /* 视频裁剪（v0.5.0）。用 vtr 而不是 vt/tr：
     * 前缀之间必须**互不为真前缀**，否则同一个 id 会归属两类任务。
     * vtr 与现有全部前缀都没有这个关系。 */
    vtr: '视频裁剪',
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

  /* ==================== subscribe：统一「认领一个 id」的订阅 ====================
   *
   * 【为什么要有它】
   * 渲染层有 20 多处订阅 job:stream，其中 6 处手写了同一个正则去判断归属：
   *   file-tools: /^qs\d+$/、/^cs\d+$/   media: /^dl\d+$/、/^avc\d+$/、/^prs\d+$/
   *   net-tools:   /^dlg\d+$/            target-size: /^tgt/、text-tools: /^tts/
   * 这些正则和 JOB_PREFIXES 是**两份独立的事实**：主进程改了前缀，正则不会跟着变，
   * 而这条链路没有编译期检查 —— 只能等用户那边进度条不动才发现。
   * 历史上已经踩过两次：
   *   · 测速页「先到先得」抢走别的任务的 id（只要 !speedId 就认领任意 id）；
   *   · 磁盘分析只按 kind 过滤，被别的标签页的进度刷成「已扫描 undefined 项」。
   *
   * subscribe(prefix, handler, opts) 把「怎么认领」收成一处：
   *   1) 注册 job:stream；
   *   2) 第一次遇到**匹配该前缀**的 id 才认领；
   *   3) 认领之后只接受这一个 id（其它任务的事件一律丢弃）；
   *   4) 返回 unsub；传 opts.onCleanup 时自动挂到页面销毁。
   *
   * 【两种匹配模式必须都支持 —— 这是真实差异，不是历史包袱】
   *   mode: 'strict'（默认）—— 前缀 + 纯数字（即 `^前缀\d+$`）
   *   mode: 'loose'          —— 只要以该前缀开头（即 `^前缀`）
   * target-size 与 text-tools 原本用的就是 loose：它们判完前缀后还会
   * 自己把 id 记进 seenId 严格比对，所以前缀那一步只要"像"就够。
   * 若统一改成 strict，一旦主进程的 id 形态不是「前缀+数字」（例如将来带横杠），
   * 这两处会静默失效。保留两种模式，行为与原实现逐字一致。
   *
   * @param {string} prefix 任务 id 前缀（见 JOB_PREFIXES）
   * @param {(data:any, claimedId:string)=>void} handler 只在已认领的事件上调用
   * @param {{mode?:'strict'|'loose', onCleanup?:boolean}} [opts]
   * @returns {function():void} 退订函数
   */
  function subscribe(prefix, handler, opts) {
    const loose = !!(opts && opts.mode === 'loose');
    let claimedId = null;

    const matches = (id) => {
      if (typeof id !== 'string' || !id) return false;
      if (typeof prefix !== 'string' || !prefix) return false;
      return loose ? id.startsWith(prefix) : belongsTo(id, prefix);
    };

    const unsub = window.api.on('job:stream', (d) => {
      if (!d || !d.id) return;
      if (claimedId) {
        if (d.id !== claimedId) return;
      } else {
        if (!matches(d.id)) return;
        claimedId = d.id;
      }
      try { handler(d, claimedId); } catch (e) { /* 单条事件解析失败不能拖垮订阅 */ }
    });

    if (opts && opts.onCleanup && window.App && typeof window.App.onCleanup === 'function') {
      window.App.onCleanup(() => { try { unsub(); } catch (e) {} });
    }
    return unsub;
  }

  window.JobPrefix = { JOB_PREFIXES, belongsTo, accepts, subscribe };
})();
