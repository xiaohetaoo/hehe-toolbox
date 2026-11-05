'use strict';
/* 后台任务的归属表：记下「这个任务是哪个窗口发起的」，窗口关闭时连带取消。
 *
 * ============ 为什么需要它 ============
 * jobs 是全项目共用的任务表（id → { cancel }），渲染层靠 job id 认领进度。
 * 但它从来没记过「谁发起的」。于是有这样一条路径（v0.6.0 多窗口之后才存在）：
 *   独立工具窗口里跑着 ffmpeg 转换 → 用户直接关掉那个窗口
 *   → 任务还在后台跑（没有任何人取消它）
 *   → 之后每条 job:stream 都按 send 的兜底逻辑发到主窗口
 *   → 主窗口若开着同一个工具页，JobPrefix.subscribe 的「首次匹配即认领」
 *     会把这个外来任务当成自己的：进度条乱跳、结束时弹「完成」
 * 用户手里那个 jobId 已经随窗口一起消失，连取消都做不到。
 *
 * ============ 为什么是 Map 子类，而不是给每个 jobs.set 补一个字段 ============
 * 全项目有 20 多处 jobs.set，分布在 main.js / ipc/fs-ops.js /
 * ipc/media-ffmpeg.js / ipc/net-lan.js。逐处补 ownerWC，漏一处就是一条
 * 静默的孤儿任务路径，而且以后新写的任务默认又会忘。
 * 收在 set() 里，新增任务自动带上归属，调用点一处都不用改。
 *
 * ============ 为什么发起者是由外部传进来的 ============
 * 主进程用 AsyncLocalStorage 把「本次 IPC 调用来自哪个 webContents」带在
 * 上下文里（见 main.js 的 als）。这个模块不去读它 —— 读了就依赖 Electron，
 * 于是这件本来很纯粹的事（记一个数字、关窗时按数字清账）就只能起 Electron 才测得了。
 * 传一个 getOwner 进来，它就是一个能被单测直接跑的普通类。
 */

/**
 * 带归属的任务表。
 * @extends {Map<string, any>}
 */
class OwnerJobMap extends Map {
  /**
   * @param {() => (number|null)} [getOwner] 返回「发起当前任务的 webContents id」，
   *   没有调用者时返回 null（托盘 / 定时任务 / 启动期发起的任务）。
   */
  constructor(getOwner) {
    super();
    this._getOwner = typeof getOwner === 'function' ? getOwner : () => null;
  }

  /**
   * 登记任务。除了原样存进去，还会补一个 ownerWC 字段。
   * 已经显式带 ownerWC 的条目不会被覆盖 —— 少数迁移期代码会自己指定归属。
   * @param {string} id
   * @param {any} job 形如 { cancel() }
   * @returns {this}
   */
  set(id, job) {
    if (job && typeof job === 'object' && !('ownerWC' in job)) {
      let owner = null;
      try { owner = this._getOwner(); } catch (e) { owner = null; }
      job.ownerWC = owner == null ? null : owner;
    }
    return super.set(id, job);
  }

  /**
   * 取消某个窗口发起的全部任务，并把它们从表里删掉。
   * @param {number|null} ownerWC webContents id
   * @returns {number} 实际取消的任务数
   */
  cancelOwnedBy(ownerWC) {
    /* ownerWC 为 null 时直接返回：那是「没有窗口拥有」的任务
     * （托盘/定时/启动期发起的），不该被任何一个窗口的关闭牵连。
     * 用 null 当查询条件去遍历，只会把这一批无辜的任务全杀掉。 */
    if (ownerWC == null) return 0;
    let n = 0;
    /* 先取快照再遍历：cancel() 可能同步触发 handler 的 finally → jobs.delete，
     * 边遍历边删会漏掉后面的条目。 */
    for (const [id, job] of Array.from(this.entries())) {
      if (!job || job.ownerWC !== ownerWC) continue;
      /* cancel 抛异常也要继续清账：漏一个任务在表里，比少杀一个更麻烦 ——
       * 它会在主窗口那边冒充成别人的任务。 */
      try { if (typeof job.cancel === 'function') job.cancel(); } catch (e) { /* 尽力而为 */ }
      this.delete(id);
      n++;
    }
    return n;
  }
}

module.exports = { OwnerJobMap };
