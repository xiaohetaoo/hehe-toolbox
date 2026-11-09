#!/usr/bin/env node
'use strict';
/* 确保 node_modules/electron/dist/electron.exe 存在（CI 专用）。
 *
 * ============ 这个脚本为什么存在 ============
 * electron 43 的 package.json **没有 postinstall 钩子**（33 有），所以
 * `npm ci` 之后 node_modules/electron/dist/ 是空的、path.txt 也不存在。
 * 打包与冒烟都要用里面的 electron.exe，必须显式补跑一次下载。
 *
 * 原来这段逻辑在 ci.yml 与 release.yml 里各写了一遍 bash：
 *     if [ -f ... ]; then echo present; else node install.js; fi
 *     test -f ...
 * 两处一模一样，改一处忘另一处就会分叉；更重要的是它**没有重试** ——
 * 实测连续两次发版（v0.6.8 的 CI、v0.6.9 的 Release）都栽在下载上：
 *   · v0.6.8：下载挂住，整步跑满 120 秒超时
 *   · v0.6.9：11 秒快速失败（install.js 直接报错退出）
 * 两次都导致后续 9~12 个步骤全部 skipped —— **代码一行都没被执行到**，
 * 却让整条流水线红掉，看起来像代码有问题。
 *
 * GitHub 的 electron 二进制从 objects.githubusercontent.com 取，那个域名
 * 在 CI runner 上偶发不可用。一次性失败不代表真的下不下来，
 * 所以加了有限重试 + 每次重试前清掉半成品（否则 install.js 会看到
 * 残缺的 dist/ 认为"已下载"直接跳过）。
 *
 * ============ 为什么不用 shell 循环 ============
 * 需要在 Windows(runner 是 windows-latest，但 shell: bash 是 Git Bash)、
 * 清理半成品、判最终文件、给出可读日志 —— 用 node 写比 bash 稳，
 * 而且这个仓库的 CI 与本地都已有 node，没有额外依赖。
 *
 * 用法：node scripts/ensure-electron.js
 * 退出码：0 = electron.exe 就绪；非 0 = 重试后仍未就绪
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const EXE = path.join(DIST, 'electron.exe');
const INSTALL = path.join(ROOT, 'node_modules', 'electron', 'install.js');

/* 最多试 4 次。每次之间指数退避（5s / 10s / 20s），
 * 总计约 35 秒等待 + 4 次下载尝试 —— 对偶发不可用足够，
 * 又不会把一个真·不可用拖成 10 分钟。 */
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [5000, 10000, 20000];

function sleepSync(ms) {
  /* 同步睡：这个脚本本身就是"只做一件事然后退出"，
   * 不需要异步事件循环，同步写法在 CI 日志里更线性好读。 */
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function hasExe() {
  try { return fs.statSync(EXE).size > 1024 * 1024; } catch (e) { return false; }
}

function cleanPartial() {
  /* 【必须清掉再重试】
   * install.js 的判断是"dist 目录里有东西就当已下载"。上次失败留下的
   * 半截 electron.exe / 空 dist 会让它直接跳过，于是我们重试 4 次
   * 其实什么都没做，最后报的错还是"文件不存在"——看不出真实原因。 */
  try {
    if (fs.existsSync(DIST)) {
      fs.rmSync(DIST, { recursive: true, force: true });
      console.log('[electron] 已清理上次下载的半成品 dist/');
    }
    const ptxt = path.join(ROOT, 'node_modules', 'electron', 'path.txt');
    if (fs.existsSync(ptxt)) fs.rmSync(ptxt, { force: true });
  } catch (e) {
    console.log('[electron] 清理半成品失败（继续尝试下载）：' + (e && e.message));
  }
}

function run() {
  const r = spawnSync(process.execPath, [INSTALL], {
    cwd: ROOT,
    stdio: 'inherit',
    env: Object.assign({}, process.env),
  });
  return r.status === 0;
}

function main() {
  if (!fs.existsSync(INSTALL)) {
    console.error('::error::找不到 node_modules/electron/install.js（npm ci 是否成功？）');
    process.exit(1);
  }
  if (hasExe()) {
    const mb = (fs.statSync(EXE).size / 1048576).toFixed(1);
    console.log('[electron] 已存在（' + mb + ' MB），跳过下载');
    return;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log('[electron] 第 ' + attempt + '/' + MAX_ATTEMPTS + ' 次下载…');
    if (attempt > 1) cleanPartial();

    const ok = run();
    if (ok && hasExe()) {
      const mb = (fs.statSync(EXE).size / 1048576).toFixed(1);
      console.log('[electron] OK（' + mb + ' MB）');
      return;
    }
    /* 失败原因可能只是 install.js 的退出码，也可能是"退出码 0 但文件不对" */
    console.log('[electron] 第 ' + attempt + ' 次未成功'
      + '（install.js 退出码正常=' + ok + '，文件就绪=' + hasExe() + '）');
    if (attempt < MAX_ATTEMPTS) sleepSync(BACKOFF_MS[attempt - 1] || 20000);
  }

  /* 【失败信息要能直接定位】
   * 写清楚试了几次、每次都失败，以及最可能的原因 ——
   * 看 CI 日志的人第一眼就知道该重跑还是该查网络策略。 */
  console.error('::error::electron 二进制下载失败（已重试 ' + MAX_ATTEMPTS + ' 次）。'
    + '通常是 objects.githubusercontent.com 在 runner 上不可用；点 Re-run failed jobs 即可。');
  process.exit(1);
}

main();
