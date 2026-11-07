'use strict';
/* 火后不理的子进程统一入口（taskkill / shutdown / explorer / 更新替换脚本…）。
 *
 * ============ 为什么要统一收口 ============
 * 项目里有一批「发出去就不管了」的辅助动作。但 Node 的 ChildProcess 在 spawn
 * 失败时（ENOENT / EACCES / 可执行文件损坏）会 emit 'error'；
 * **没有监听器时，这个 error 会升级成主进程的 uncaughtException** ——
 * 结果是：一条取消动作没生效，却写进 crash-log、还把下次启动标记成
 * 「上次异常退出」，让用户以为程序崩过。
 *
 * 实测过的两种失败形态（Windows）：
 *   · 可执行文件不存在     → 异步 emit 'error'（code=ENOENT），pid 为 undefined
 *   · 文件存在但不是可执行 → spawn() **同步抛**（Error: spawn UNKNOWN）
 * 所以「只包 try/catch」不够（接不到异步那一种），「只挂 error 监听」也不够
 * （接不到同步那一种），两者都必须有。
 *
 * ============ 为什么从 main.js 搬到 lib/ ============
 * ipc/media-ffmpeg.js 里另有 6 处 taskkill 是同样的形态，而它拿不到 main.js
 * 里的局部函数。early 版本只在 main.js 修了，媒体域照旧裸 spawn ——
 * 一次「修了一半」的加固比没修更危险：测试断言 main.js 已经没有裸 spawn，
 * 于是看起来这个问题已经解决。搬到 lib/ 之后两边 require 同一份实现，
 * 断言也可以按「整棵主进程树」来写，而不是只盯 main.js。
 *
 * 用法：
 *   const { spawnDetached } = require('./lib/spawn-detached');
 *   spawnDetached('taskkill', ['/pid', String(pid), '/t', '/f']);
 */

const { spawn } = require('child_process');

/**
 * 起一个不关心结果的子进程：失败当作「没做成」，不上升为崩溃。
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {import('child_process').SpawnOptions} [opts] 额外选项（如 { detached: true, stdio: 'ignore' }）
 * @returns {import('child_process').ChildProcess|null} 同步失败时返回 null
 */
function spawnDetached(cmd, args, opts) {
  try {
    const child = spawn(cmd, args || [], Object.assign({ windowsHide: true }, opts || {}));
    /* 空监听的目的就是"把 fatal 变成可忽略"，不是遗漏处理 */
    child.on('error', () => {});
    try { child.unref(); } catch (e) { /* 已退出/无句柄时 unref 会抛，忽略 */ }
    return child;
  } catch (e) {
    /* spawn 本身同步抛（参数非法 / 文件不是可执行）也不能让调用方炸掉 */
    return null;
  }
}

module.exports = { spawnDetached };
