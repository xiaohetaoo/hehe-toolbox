'use strict';
/* 「这份异步结果还算不算数」的判据 —— 抽成纯函数以便真正单测。
 *
 * ============ 为什么需要这个模块 ============
 * 项目里大量工具页是「点一次按钮 → invoke 一个阻塞式主进程 handler →
 * 返回后写界面」。用户可能在等待期间**再次点击**或**切走页面**。
 * 这两件事都必须让**旧的那次请求**作废，否则：
 *   · 旧请求的 catch 会退掉新请求的订阅、复位新请求的按钮、
 *     把新请求的 jobId 置 null —— 新请求静默死亡且无法停止；
 *   · 旧请求的成功分支会用过期数据覆盖新请求的界面；
 *   · 旧请求还在主进程里建出了任务，没人收尾（孤儿）。
 *
 * 历史上这里用过布尔 `pageDead`，但它有两处硬伤：
 *   ① 复位窗口：`onEnter` 把 pageDead 置 false 之后，**旧请求**回来时
 *      看到的是 false，于是被当成有效（漏杀）；
 *   ② 无法区分「旧」与「新」：布尔只有一个值，知道"页面还在"，
 *      但不知道"这份结果属于哪一趟"。
 *
 * 所以统一改成 **per-run 序号（token）**：每次开跑 +1，异步返回时比对；
 * 不一致就是过期，过期请求必须
 *   · 不碰任何界面状态；
 *   · 不弹任何提示；
 *   · 如果它在主进程里建出了任务 id，自己把它 kill 掉。
 *
 * 这个模块只负责**判定**（纯函数、可单测）；"过期后做什么"留在调用点，
 * 因为那里才知道有没有 job id 要 kill、要不要退订。
 */

/**
 * 这份异步结果是否仍有效。
 *
 * @param {number} capturedAt 请求发起时捕获的序号
 * @param {number} current 当前序号
 * @returns {boolean} true = 仍然有效（可以写界面）；false = 已过期
 */
function isCurrentRun(capturedAt, current) {
  const a = Number(capturedAt);
  const b = Number(current);
  /* 非数值一律当作过期：拿不到序号就无法证明它是当前这趟，
   * 宁可丢弃（丢弃的后果只是界面不更新一次），也不能让它去改别人的状态。 */
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a === b;
}

/**
 * 过期请求的收尾动作清单。
 *
 * 【为什么要返回一个列表而不是直接执行】调用方需要按自己的资源形态
 * 决定做什么（有 job id 才 kill、有订阅才退订）。这里给出**必须做的最小集**，
 * 让调用点不必每次重新推理，也便于测试覆盖"过期就什么都不该碰"。
 *
 * @param {object} p
 * @param {number} p.capturedAt 请求发起时的序号
 * @param {number} p.current 当前序号
 * @param {string|number|null} [p.jobId] 这次请求在主进程里建出的任务 id
 * @returns {{stale:boolean, killJobId:string|number|null, touchUi:boolean, toast:boolean}}
 */
function planStaleCleanup(p) {
  /** @type {{capturedAt?:number, current?:number, jobId?:string|number|null}} */
  const x = p || {};
  const stale = !isCurrentRun(x.capturedAt, x.current);
  if (!stale) {
    return { stale: false, killJobId: null, touchUi: true, toast: true };
  }
  return {
    stale: true,
    /* 过期请求若建出了任务，必须自己杀掉 —— 否则它在主进程里继续跑，
     * 而没有任何界面能取消它（新请求的 jobId 是另一个）。 */
    killJobId: x.jobId == null ? null : x.jobId,
    /* 过期的请求**不许**碰界面：按钮、状态行、列表都属于新一趟。 */
    touchUi: false,
    /* 也不许弹提示：用户已经在看新一趟，旧错误会让人以为新操作失败了。 */
    toast: false,
  };
}

/* 【顶层标识符必须带模块前缀】
 * index.html 用经典 <script>（不是 module）加载本文件，顶层 const 进的是
 * **同一个全局词法环境**。曾与 lib/img-pick.js 的 `const API` / `const root`
 * 撞名，导致后加载的这份整脚本抛 SyntaxError、window.RunToken 永远不出现。 */
const RunTokenApi = { isCurrentRun, planStaleCleanup };
/* UMD 形态照 lib/safe-name.js / lib/img-pick.js：node 走 module.exports，
 * 浏览器挂到 root。必须先赋给局部变量再挂属性，否则 tsc 报
 * `Property 'RunToken' does not exist on type 'Window'`。 */
if (typeof module === 'object' && module && module.exports) module.exports = RunTokenApi;
const tokenRoot = typeof window !== 'undefined' ? window
  : (typeof globalThis !== 'undefined' ? globalThis : null);
if (tokenRoot) tokenRoot.RunToken = RunTokenApi;
