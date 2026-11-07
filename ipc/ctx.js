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
     * 向渲染层推送事件。**这只是「无调用者时的兜底」，业务推送不要用它。**
     *
     * 【v0.6.0 之后它的语义变了，别被函数名骗了】
     * 它做的是「直接发主窗口」——不看 ALS、不判调用者是谁。
     * 而 main.js 现在的 send() 是三档路由（lib/ipc-route.js）：
     *   · ALS 里有调用者且还活着 → 发给那个窗口
     *   · 没有调用者（托盘/定时/启动期）→ 回退主窗 ← **只有这一档等价于本函数**
     *   · 调用者已被销毁 → 丢弃，不回退（回退会制造串扰）
     *
     * 所以：**任何跟着某个窗口任务走的推送（job:stream / job:progress），
     * 都必须用 main.js 注入的 send，不能用 ctx.send** —— 后者会让独立工具
     * 窗口收不到自己的进度，反而让主窗把它认领成自己的任务。
     * 本函数保留，只是为了给「确实只想发主窗」的场景一个不误导的入口。
     *
     * 【不要再让 ctx.send 反向调用 main.js 的 send()】main.js 的 send
     * 本身以 ipcCtx.send 作为兜底，那样会成环。
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
