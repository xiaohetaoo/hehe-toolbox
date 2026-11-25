'use strict';
/* 把 ipc/fs-ops.js 的 handler 装进一个 Map，供行为测试直接调用。
 *
 * 【为什么需要】fs-ops 的实现全部靠 register(ctx, deps) 注入依赖，
 * 测试里没有 Electron、也不该起主进程；以前这类测试只能「从拼接源码里
 * 抽函数体 + new Function」，而一旦函数体引用模块作用域的助手
 * （writeFileAtomic / pathGuard / tempNames），抽出来就变成 undefined。
 * 这里用真实 register + 最小 deps，测到的是**真实实现**，不是复刻。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

function loadFsOps() {
  const CH = require(path.join(ROOT, 'lib', 'channels')).CHANNELS;
  const register = require(path.join(ROOT, 'ipc', 'fs-ops'));
  const pathGuard = require(path.join(ROOT, 'lib', 'path-guard'));
  const tempNames = require(path.join(ROOT, 'lib', 'temp-names'));
  const fsOps = require(path.join(ROOT, 'lib', 'fs-ops'));
  const archiveGuard = require(path.join(ROOT, 'lib', 'archive-guard'));

  const handlers = new Map();
  const jobs = new Map();
  const progress = [];
  let seq = 0;
  const ctx = { nextJobSeq: () => ++seq };
  register(ctx, {
    handle: (ch, fn) => handlers.set(ch, fn),
    send: (ch, payload) => progress.push({ ch, payload }),
    jobs,
    fmtErr: (e) => String((e && e.message) || e),
    setLatestCancelable: () => {},
    fs, fsp: fs.promises, path, os, crypto,
    shell: { openPath: async () => '', showItemInFolder: () => {} },
    AdmZip: require('adm-zip'),
    pathGuard, tempNames, fsOps, archiveGuard,
    /* 测试里不模拟「同名自动编号」，调用方本来就会自己给不冲突的名字。 */
    uniqueTarget: async (dir, name) => path.join(dir, name),
    isOwnTempName: () => false,
  });
  return { CH, handlers, jobs, progress };
}

module.exports = { loadFsOps };
