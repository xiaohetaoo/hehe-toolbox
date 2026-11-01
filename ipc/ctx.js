'use strict';
/* 主进程 IPC 域的显式上下文（任务 5 第 1 步）。
 *
 * ============ 这个文件为什么存在 ============
 * main.js 是 7700 行、215 个顶层定义的单文件。所有 handler 都靠**闭包**读
 * 外面的状态（win / jobs / send / jobSeq / 缓存…）。于是任何一次「把一段
 * handler 搬到别处」都要先弄清楚那段代码隐式依赖了什么 —— 这种隐式依赖
 * 正是它难以拆分的根本原因，也是搬迁时最容易漏掉的地方：漏了看似「语法
 * 合法」，`node --check` 完全看不见，只有真跑起来才 ReferenceError。
 *
 * 所以第 1 步不改任何逻辑，只把「要搬走的那些域所依赖的闭包状态」变成
 * 一个**显式的对象**，由 main.js 构造一次、当参数传给模块。
 * 这一步单独可回滚：它不移动任何业务代码，只重新组织依赖的表达方式。
 *
 * ============ 形状为什么是 getter ============
 * 这些值在进程生命周期里会变（win 会重建、jobSeq 会递增、jobs 表会增删）。
 * 若做成快照对象（`{ win, jobSeq }`），搬出去的代码拿到的就永远是构造那一刻
 * 的值 —— 表现是「第一次能用，换窗口/第二次就不对」，而且极难查。
 * 所以用 getter 委托回 main.js 的**同一个变量**：模块里读到的是实时值。
 *
 * ============ 谁负责维护它 ============
 * main.js 在启动阶段调用 createIpcCtx(...) 一次。以后新增一个域要搬出去时，
 * 如果它依赖新的闭包状态，就在这里加一项、并在 main.js 的实参里补上。
 * scripts/test-ipc-ctx.js 守着「ctx 的每一项都真的委托回 main.js」这条。
 */

/**
 * @param {object} hosts 由 main.js 提供的实时访问器
 * @param {() => any} hosts.getWin 取主窗口（可能 null/已销毁）
 * @param {() => Map} hosts.getJobs 任务表 id → { cancel() }
 * @param {() => number} hosts.nextJobSeq 取并自增任务序号（与 main.js 同一份计数）
 * @param {() => boolean} hosts.getIsWin 平台判断
 * @param {() => boolean} hosts.getIsMac
 * @returns {object} 传给各 ipc 模块的 ctx
 */
function createIpcCtx(hosts) {
  for (const k of ['getWin', 'getJobs', 'nextJobSeq', 'getIsWin', 'getIsMac']) {
    if (typeof hosts[k] !== 'function') throw new TypeError('createIpcCtx: 缺少访问器 ' + k);
  }
  return {
    get win() { return hosts.getWin(); },
    get jobs() { return hosts.getJobs(); },
    get isWin() { return hosts.getIsWin(); },
    get isMac() { return hosts.getIsMac(); },
    /**
     * 向渲染层推送事件。语义与 main.js 原来的 send() **完全一致**：
     * 窗口不存在或已销毁时静默丢弃（不抛、不排队）。
     */
    send(ev, data) {
      const w = hosts.getWin();
      if (w && !w.isDestroyed()) w.webContents.send(ev, data);
    },
    /** 取下一个任务序号（等价于搬迁前的 `++jobSeq`）。 */
    nextJobSeq() { return hosts.nextJobSeq(); },
  };
}

module.exports = { createIpcCtx };
