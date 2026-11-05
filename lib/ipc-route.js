'use strict';
/* 主进程推送事件「发给谁」的选择（纯逻辑，main.js 与测试共用同一份）。
 *
 * ============ 为什么抽出来 ============
 * send() 原来只有两档：有 ALS 上下文就发给调用者窗口，没有就退回主窗口。
 * 多窗口之后出现了第三种情况 —— **上下文还在，但那个窗口已经被关掉了**
 * （handler 是异步的，用户可以在任务跑到一半时关窗，之后的每一条进度
 * 事件都会命中这一档）。
 *
 * 那时退回主窗口看起来"有个兜底"，实际是制造串扰：主窗口若开着同一个
 * 工具页，它的 JobPrefix 会把这个外来任务认领成自己的 —— 进度条乱跳、
 * 结束弹「完成」、取消按钮杀的是别人的任务。而用户手里已经没有那个 id 了。
 *
 * 所以三档必须分开判，而且判据要能单独被测：
 *   没有调用者（托盘/定时/启动期）  → 退回主窗口（原本的兜底，保留）
 *   调用者存在且还活着              → 发给它
 *   调用者存在但已销毁              → **丢弃**，不回退
 *
 * 这件事只有几行，但它是一条"回退用错了场景就变成串扰"的规则，
 * 写死在 main.js 的 send() 里就只能靠读源码确认，所以抽成纯函数。
 */

/** 发给 ALS 上下文里的那个窗口 */
const SENDER = 'sender';
/** 退回主窗口（没有调用者的场景） */
const FALLBACK = 'fallback';
/** 丢弃（调用者已经被关掉了） */
const DROP = 'drop';

/**
 * 决定一条推送该发给谁。
 * @param {{isDestroyed: () => boolean}|null|undefined} sender
 *   本次 IPC 调用来自的 webContents；没有上下文时传 null。
 * @returns {'sender'|'fallback'|'drop'}
 */
function pickSendTarget(sender) {
  if (!sender) return FALLBACK;
  /* isDestroyed 本身也可能抛（极少见，webContents 已释放的情况下），
   * 抛了就按"已销毁"处理 —— 这时任何发送都会失败，退回主窗口只会串扰。 */
  let dead = false;
  try { dead = !!sender.isDestroyed(); } catch (e) { dead = true; }
  return dead ? DROP : SENDER;
}

module.exports = { pickSendTarget, SENDER, FALLBACK, DROP };
