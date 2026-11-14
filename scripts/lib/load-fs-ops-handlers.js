'use strict';
/* 在不启动 Electron 的前提下，把 ipc/fs-ops.js 注册的 handler 收成一张表。
 *
 * ============ 为什么需要它 ============
 * ipc/fs-ops.js 的形态是 `module.exports = function register(ctx, deps)`，
 * 里面逐个调用注入进来的 handle(ch, fn)。这是当初为了「搬出 main.js 又不动
 * 一行实现」而定的结构（见该文件头部说明）—— 好处是它可以脱离 Electron
 * 加载，坏处是**没有任何测试真的去加载它**：所有关于 fs:* 的断言都是
 * 「读源码 + 正则匹配」，测的是文本形态而不是行为。
 *
 * 而这正是 fs:read-file-b64 的 maxBytes 参数能"传了但没用"却长期没人发现
 * 的原因：源码里那行注释看起来天衣无缝，行为却没有一条断言看着。
 *
 * 有了这张表，测试可以直接 invoke handler、断言返回值 —— 走的是主进程
 * 将来真会执行的那段代码，不是副本。
 *
 * ============ 依赖怎么办 ============
 * fs-ops 需要的依赖大多只在**别的通道**里用到（AdmZip、archiveGuard、
 * uniqueTarget…）。这里给它们一律塞"调了就抛"的桩：
 *   · 万一被测通道意外依赖了某个桩，测试会立刻红并指出是哪一个，
 *     而不是静默通过 —— 沉默的桩比没有桩更危险。
 *   · 真要用到的 fs/fsp/path/os/crypto 用 Node 原生的，与主进程一致。
 */

const fs = require('fs');
const path = require('path');

/**
 * 加载 ipc/fs-ops.js，返回「通道名 → handler」的 Map。
 * @returns {Map<string, Function>}
 */
function loadFsOpsHandlers() {
  /* 每次重新 require 会命中模块缓存，但那没问题：register 是纯注册函数，
   * 重复调用只是往新的 Map 里再塞一遍。为了拿到干净的 Map，每次新建。 */
  const org = require('../../ipc/fs-ops');
  const handlers = new Map();
  const notNeeded = (name) => () => { throw new Error('测试桩不该被调用：' + name); };
  /* 【nextJobSeq 必须有】scan-tree / dir-children 都用它生成任务 id。
   * 不给的话会在「第一次真调扫描类 channel」时抛 TypeError —— 而这正是
   * 这几个通道此前只做源码断言、从没被行为测过的原因之一。 */
  let seq = 0;
  const deps = {
    handle: (ch, fn) => { handlers.set(ch, fn); },
    send: () => {},
    jobs: new Map(),
    fmtErr: (e) => String((e && e.message) || e),
    setLatestCancelable: () => {},
    fs,
    fsp: fs.promises,
    path,
    os: require('os'),
    crypto: require('crypto'),
    shell: {},
    AdmZip: notNeeded('AdmZip'),
    /* 【pathGuard 必须是真实现】它是纯逻辑模块（不 require electron），
     * 塞空对象会让任何走到 pathGuard.err/checkOverwritable 的用例拿到
     * TypeError 而不是真正的 CodedError —— 错误码断言就永远对不上，
     * 而且失败原因会指向测试桩，不是被测代码。 */
    pathGuard: require('../../lib/path-guard'),
    tempNames: {},
    fsOps: {},
    archiveGuard: {},
    uniqueTarget: notNeeded('uniqueTarget'),
    isOwnTempName: notNeeded('isOwnTempName'),
  };
  org({ nextJobSeq: () => ++seq, jobs: deps.jobs }, deps);
  return handlers;
}

module.exports = { loadFsOpsHandlers };
