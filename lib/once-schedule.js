'use strict';
/* 一次性定时任务的「时间戳解析 / 该不该执行」纯逻辑（主进程与测试共用）。
 *
 * 【为什么单独抽出来】
 * main.js 的 armOnceAll 原来直接写：
 *     if (!item || !item.id || !item.fireAt) continue;
 *     if (Number(item.fireAt) <= now) { ... }
 * 而 `fireAt` 来自本地 store，是用户可见、可手改的文件。只要它变成
 * `"abc"` / `NaN` / 对象，`Number(...)` 就是 NaN：既不 `<= now`，也不
 * 被跳过，于是 armOnce 里 `setTimeout(..., NaN)` 会被 Node 当成 1ms ——
 * **应用一启动就立刻执行「睡眠」或「锁屏」**。这不是"定时不准"，是
 * 一条坏记录把电脑直接挂起。坏数据必须在进入计时器之前被明确丢掉。
 *
 * 解析规则与用户输入校验口径一致：只接受正有限数（时间戳毫秒）。
 * 空串、空白串、负数、Infinity、NaN 一律返回 null（= 丢弃）。
 */

/** 从任务项里取合法的 fireAt；不合法返回 null。 */
function fireAtOf(item) {
  const raw = item && item.fireAt;
  if (raw == null) return null;
  if (typeof raw === 'string' && !raw.trim()) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * 决定一条一次性任务该怎么处理。
 * @param {any} item
 * @param {number} now
 * @param {number} catchupMs 过期多久以内仍补执行
 * @returns {{kind:'run'|'keep'|'drop', fireAt?:number}}
 *   run  = 已到点且仍在补执行窗口内，应立即执行
 *   keep = 未来任务，应挂计时器
 *   drop = 无 id / 时间戳损坏 / 过期太久，直接丢弃
 */
function decideOnce(item, now, catchupMs) {
  if (!item || !item.id) return { kind: 'drop' };
  const fireAt = fireAtOf(item);
  if (fireAt == null) return { kind: 'drop' };
  const n = Number(now);
  const base = Number.isFinite(n) ? n : Date.now();
  if (fireAt <= base) {
    const catchup = Number(catchupMs);
    const limit = Number.isFinite(catchup) && catchup > 0 ? catchup : 0;
    return (base - fireAt <= limit) ? { kind: 'run', fireAt } : { kind: 'drop', fireAt };
  }
  return { kind: 'keep', fireAt };
}

module.exports = { fireAtOf, decideOnce };
