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

/**
 * 校验 dist 确实是对应版本的 electron。
 *
 * 【为什么不能只看 electron.exe 存在】
 * install.js 的 isInstalled() 会读 dist/version 与 package.json 的 version
 * 比对。如果我们只判 exe 存在，就可能出现两种错配：
 *   · 缓存里是旧版本 → 解出旧 electron → 打包出与 package.json 不符的应用
 *     （安装包版本号是新的、运行时是旧的，极难排查）
 *   · dist/version 缺失 → install.js 会重下，我们的 hasExe() 却认为已就绪
 * 所以这里按 install.js 的同一套判据来：version 文件 + path.txt 都要对。
 */
function verifyVersion() {
  const lockVer = (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'));
      return String(pkg.version || '');
    } catch (e) { return ''; }
  })();
  const distVer = (() => {
    try { return fs.readFileSync(path.join(DIST, 'version'), 'utf8').replace(/^v/, '').trim(); }
    catch (e) { return ''; }
  })();
  if (!lockVer) return { ok: false, reason: '读不到 node_modules/electron/package.json 的 version' };
  if (!distVer) return { ok: false, reason: 'dist/version 不存在（下载不完整）' };
  if (distVer !== lockVer) {
    return { ok: false, reason: '版本不符：dist=' + distVer + ' 期望=' + lockVer };
  }
  return { ok: true, version: distVer };
}

function cleanPartial() {
  /* 【必须清掉再重试，而且清的位置要和 install.js 的判断一致】
   *
   * install.js 的 isInstalled() 读的是这三样（见 node_modules/electron/install.js）：
   *   · dist/version   —— 内容必须等于 package.json 里的 version
   *   · path.txt       —— 内容必须等于平台可执行名（win32 是 electron.exe）
   *   · dist/<exe>     —— 文件必须存在
   * 三者全对才认为"已下载"，否则重新走 downloadArtifact。
   *
   * 第一版只删了 dist/ 和 path.txt，**漏了 dist/version 本身在 dist 里
   * 所以其实也被删了** —— 但更重要的是：如果上一次失败留下了
   * dist/version 与 path.txt 但 exe 是 0 字节/截断的，
   * isInstalled() 会看到 exe "存在"（existsSync 不看大小）而直接 exit 0，
   * 于是我们的 hasExe()（有 1MB 下限）判定失败，重试 4 次其实一次都没下载。
   * 表现就是 CI 上 47 秒跑完 4 次重试然后失败 —— 完全符合实测。
   *
   * 现在把 install.js 依赖的三个路径**全部**清掉，保证它必然重新下载。
   * 另外 @electron/get 有自己的缓存目录（默认 ~/.cache/electron），
   * 那个不能删 —— 缓存命中时下载是零成本的，删了反而每次都要真下。 */
  const targets = [
    DIST,                                                        // dist/ 整个目录（含 version）
    path.join(ROOT, 'node_modules', 'electron', 'path.txt'),     // path.txt
  ];
  for (const t of targets) {
    try {
      if (fs.existsSync(t)) {
        fs.rmSync(t, { recursive: true, force: true });
        console.log('[electron] 已清理 ' + path.relative(ROOT, t));
      }
    } catch (e) {
      console.log('[electron] 清理 ' + t + ' 失败（继续尝试下载）：' + (e && e.message));
    }
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
  /* 【已就绪的判据：exe 够大 **且** 版本对得上】
   * 只看 exe 存在会漏掉两种错配（见 verifyVersion 的说明）。 */
  if (hasExe()) {
    const v = verifyVersion();
    if (v.ok) {
      const mb = (fs.statSync(EXE).size / 1048576).toFixed(1);
      console.log('[electron] 已就绪（v' + v.version + '，' + mb + ' MB），跳过下载');
      return;
    }
    /* 已存在但版本不对 —— 这几乎一定是缓存串了版本，
     * 清掉重下，并明确告警（不然打包出来的应用版本号会骗人）。 */
    console.log('[electron] 虽已存在但校验不通过（' + v.reason + '），清理后重新下载');
    cleanPartial();
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log('[electron] 第 ' + attempt + '/' + MAX_ATTEMPTS + ' 次下载…');
    if (attempt > 1) cleanPartial();

    const ok = run();
    if (ok && hasExe()) {
      const v = verifyVersion();
      if (!v.ok) {
        console.log('[electron] 下载后校验不通过（' + v.reason + '），继续重试');
        continue;
      }
      const mb = (fs.statSync(EXE).size / 1048576).toFixed(1);
      console.log('[electron] OK（v' + v.version + '，' + mb + ' MB）');
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
