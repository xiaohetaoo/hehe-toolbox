'use strict';
/* 开发环境（便携运行时）IPC 域：下载 → 校验 → 解压 → 落盘 → 可选加入用户环境。
 *
 * 设计要点（与交接文档 5.23 对应）：
 *   · 只安装**入库固定 URL + SHA256** 的官方便携构建；不做"检查更新即装"。
 *   · 落盘位置 `<userData>/envs/<id>/<version>`，删目录即净；不写系统目录。
 *   · 「加入用户环境」只改 **HKCU**（用户 PATH + JAVA_HOME），系统 PATH 永不碰，
 *     不用 setx（1024 字符截断）；每次写入前备份，支持一键撤销。
 *   · 不加新高危能力：用户明确要求"默认加入用户环境"，而这一步可撤销、
 *     且只影响当前账户；界面侧必须二次确认并如实说明影响。
 *   · 运行时目录与 SHA 都来自 lib/env-catalog.js（有单测），这里不做"猜版本"。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const envCatalog = require('../lib/env-catalog');
const envPath = require('../lib/env-path');
const envDetect = require('../lib/env-detect');
const psScript = require('../lib/ps-script');
const CH = require('../lib/channels').CHANNELS;   // IPC 通道名唯一来源

module.exports = function register(ctx, deps) {
  const {
    handle, jobs, nextJobSeq, setLatestCancelable,
    downloadToFile, userDataDir, runCmd, storeGet, storeSet, psSingleQuote, moveFile,
    /* 测试缝：可选注入用户环境读写。默认走注册表 + PowerShell；
     * 注入后可以在纯 Node 里跑 apply/unapply 的状态机（不碰真实 PATH）。 */
    userEnvIO,
  } = deps;

  const ENV_ROOT = () => path.join(userDataDir(), 'envs');
  const manifestGet = () => {
    const m = storeGet('envInstalled', {});
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  };
  const manifestSet = (m) => storeSet('envInstalled', m);
  const appliedGet = () => {
    const a = storeGet('envApplied', null);
    return a && typeof a === 'object' ? a : null;
  };
  const appliedSet = (a) => storeSet('envApplied', a || null);

  async function sha256File(file) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      fs.createReadStream(file).on('data', (d) => hash.update(d))
        .on('error', reject).on('end', () => resolve(hash.digest('hex')));
    });
  }
  function extOf(rt) {
    if (rt.archive === 'tar.gz') return '.tar.gz';
    return '.' + rt.archive;
  }
  async function exists(p) { try { await fsp.access(p); return true; } catch (e) { return false; } }

  /* ---------- 安全解压 ---------- */
  function assertSafeZipEntries(zip) {
    const entries = zip.getEntries();
    if (entries.length > 200000) throw new Error('压缩包条目过多，已拒绝解压');
    for (const e of entries) {
      const n = String(e.entryName || '').replace(/\\/g, '/');
      if (!n || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) {
        throw new Error('压缩包包含不安全路径：' + n);
      }
    }
  }

  async function extractArchive(archive, staging, rt) {
    if (rt.archive === 'zip') {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(archive);
      assertSafeZipEntries(zip);
      zip.extractAllTo(staging, true);
      return;
    }
    const sevenZa = require('7zip-bin').path7za;
    if (rt.archive === '7z') {
      const r = await runCmd(sevenZa, ['x', archive, '-o' + staging, '-y', '-bd'], { timeout: 300000 });
      if (r.code !== 0) throw new Error('解压失败：' + String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-2).join(' '));
      return;
    }
    if (rt.archive === 'tar.gz') {
      /* 7za 不能直接把 tar.gz 解到目标并丢顶层；分两步：gz → tar → 目录。
       * 中途产物放 staging 的同级临时目录，最后一起清掉。 */
      const gzOut = path.join(staging, '.gz');
      await fsp.mkdir(gzOut, { recursive: true });
      let r = await runCmd(sevenZa, ['x', archive, '-o' + gzOut, '-y', '-bd'], { timeout: 300000 });
      if (r.code !== 0) throw new Error('解压 gz 失败');
      const tarFile = (await fsp.readdir(gzOut)).find((n) => /\.tar$/i.test(n));
      if (!tarFile) throw new Error('tar.gz 里没有 tar 包');
      r = await runCmd(sevenZa, ['x', path.join(gzOut, tarFile), '-o' + staging, '-y', '-bd'], { timeout: 300000 });
      if (r.code !== 0) throw new Error('解压 tar 失败');
      await fsp.rm(gzOut, { recursive: true, force: true }).catch(() => {});
      return;
    }
    throw new Error('不支持的压缩格式：' + rt.archive);
  }

  /** 丢掉压缩包的单一顶层目录（node-v…/、jdk-…/、mingw64/、python/） */
  async function payloadRoot(staging, stripTop) {
    if (!stripTop) return staging;
    const entries = await fsp.readdir(staging, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory()) return path.join(staging, entries[0].name);
    return staging;
  }

  /* ---------- 用户环境读写（HKCU only） ---------- */
  const BACKUP_KEY = 'envVarsBackup'; // { JAVA_HOME: string|null }

  async function readUserEnv() {
    if (userEnvIO && typeof userEnvIO.read === 'function') return userEnvIO.read();
    const script = '[pscustomobject]@{ Path=[Environment]::GetEnvironmentVariable("Path","User"); JAVA_HOME=[Environment]::GetEnvironmentVariable("JAVA_HOME","User") } | ConvertTo-Json -Compress';
    const r = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 20000 });
    if (r.code !== 0) throw new Error('读取用户环境变量失败（' + String(r.stderr || '').split(/\r?\n/).slice(-1) + '）');
    try {
      const j = JSON.parse(String(r.stdout || '{}'));
      return { path: String(j.Path || ''), vars: { JAVA_HOME: j.JAVA_HOME == null ? '' : String(j.JAVA_HOME) } };
    } catch (e) {
      throw new Error('解析用户环境变量失败');
    }
  }

  async function writeUserEnv({ pathValue = null, vars = {}, removeVars = [] } = {}) {
    if (userEnvIO && typeof userEnvIO.write === 'function') {
      return userEnvIO.write({ pathValue, vars, removeVars });
    }
    const lines = ['$ErrorActionPreference = "Stop"'];
    if (pathValue != null) {
      lines.push('[Environment]::SetEnvironmentVariable("Path", ' + psSingleQuote(pathValue) + ', "User")');
    }
    for (const [k, v] of Object.entries(vars || {})) {
      lines.push('[Environment]::SetEnvironmentVariable(' + psSingleQuote(k) + ', ' + psSingleQuote(v) + ', "User")');
    }
    for (const k of removeVars || []) {
      lines.push('[Environment]::SetEnvironmentVariable(' + psSingleQuote(k) + ', $null, "User")');
    }
    /* 广播 WM_SETTINGCHANGE，让新开的资源管理器/终端拿到新环境。
     * 不广播的话：改完注册表，用户从任务栏新开 cmd 仍然读到旧 PATH。 */
    lines.push(
      'Add-Type -TypeDefinition @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class HeheEnvBroadcast {',
      '  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]',
      '  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);',
      '}',
      '"@',
      '$r=[UIntPtr]::Zero',
      '[HeheEnvBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 3000, [ref]$r) | Out-Null'
    );
    const dir = ENV_ROOT();
    await fsp.mkdir(dir, { recursive: true });
    const script = path.join(dir, '.env-write-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.ps1');
    await fsp.writeFile(script, psScript.withBom(lines.join('\r\n')), 'utf8');
    try {
      const r = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { timeout: 30000 });
      if (r.code !== 0) {
        throw new Error('写入用户环境失败：' + String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-2).join(' '));
      }
    } finally {
      await fsp.rm(script, { force: true }).catch(() => {});
    }
  }

  function entriesFor(id) {
    const m = manifestGet()[id];
    if (!m) return { dirs: [], vars: {} };
    const rt = envCatalog.findRuntime(id);
    return {
      dirs: envCatalog.binPaths(m.dir, rt),
      vars: envCatalog.envPairs(m.dir, rt),
    };
  }

  /** 把若干运行时加入当前用户环境（幂等） */
  async function applyIds(ids) {
    const warnings = [];
    const list = [...new Set((ids || []).filter((x) => manifestGet()[x]))];
    if (!list.length) return { appliedIds: [], warnings: ['没有可加入的环境（先安装）'] };
    const cur = await readUserEnv();
    /* 备份原始 JAVA_HOME 一次（撤销时还原）；PATH 不整段备份，
     * 撤销时按"我们加的目录"精确摘除，避免覆盖用户后来的手工修改。 */
    const backup = storeGet(BACKUP_KEY, null);
    if (!backup || typeof backup !== 'object') {
      storeSet(BACKUP_KEY, { JAVA_HOME: cur.vars.JAVA_HOME, at: Date.now() });
    }
    const all = list.flatMap((id) => entriesFor(id).dirs);
    const prep = envPath.prependEntries(cur.path, all);
    if (envPath.pathTooLong(prep.value)) warnings.push('用户 PATH 已超过 2000 字符，部分程序可能截断');
    const vars = {};
    for (const id of list) {
      for (const [k, v] of Object.entries(entriesFor(id).vars)) vars[k] = v;
    }
    await writeUserEnv({ pathValue: prep.value, vars });
    const prev = appliedGet() || { ids: [] };
    appliedSet({
      ids: [...new Set([...(prev.ids || []), ...list])],
      entries: [...new Set([...(prev.entries || []), ...prep.added])],
      vars,
      pathLength: prep.value.length,
      at: Date.now(),
    });
    return { appliedIds: list, pathLength: prep.value.length, warnings };
  }

  /** 撤销：摘掉我们加的目录；JAVA_HOME 只在仍是我们的值时才还原 */
  async function unapplyIds(only) {
    const st = appliedGet();
    if (!st) return { removed: 0, restoredVars: [], warnings: [] };
    const allIds = st.ids || [];
    const removeIds = only ? allIds.filter((id) => only.includes(id)) : allIds;
    const keepIds = allIds.filter((id) => !removeIds.includes(id));
    const removeDirs = removeIds.flatMap((id) => entriesFor(id).dirs);
    const keepDirs = keepIds.flatMap((id) => entriesFor(id).dirs);
    const cur = await readUserEnv();
    const rem = envPath.removeEntries(cur.path, removeDirs);
    /* 只撤销部分 id 时，把仍启用的目录重新前置，避免顺序被搅乱 */
    const nextPath = keepIds.length ? envPath.prependEntries(rem.value, keepDirs).value : rem.value;
    const backup = storeGet(BACKUP_KEY, null) || {};
    const varsToWrite = {};
    const varsToRemove = [];
    const restored = [];
    const ourVars = removeIds.reduce((acc, id) => Object.assign(acc, entriesFor(id).vars), {});
    for (const [k, ours] of Object.entries(ourVars)) {
      if (cur.vars[k] !== ours) continue;   // 用户自己改过 → 不动，也不回滚
      if (backup[k]) { varsToWrite[k] = backup[k]; restored.push(k); }
      else varsToRemove.push(k);
    }
    await writeUserEnv({ pathValue: nextPath, vars: varsToWrite, removeVars: varsToRemove });
    if (keepIds.length) {
      const keepVars = keepIds.reduce((acc, id) => Object.assign(acc, entriesFor(id).vars), {});
      appliedSet({ ids: keepIds, entries: keepDirs, vars: keepVars, at: Date.now() });
    } else {
      appliedSet(null);
      storeSet(BACKUP_KEY, null);
    }
    return { removed: rem.removed.length, restoredVars: restored, warnings: [] };
  }

  /* ---------- 命令探测 ---------- */
  async function safeCmd(cmd, args, timeout) {
    try {
      const r = await runCmd(cmd, args, { timeout: timeout || 8000 });
      return { code: r.code, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
    } catch (e) {
      return { code: -1, stdout: '', stderr: String((e && e.message) || e) };
    }
  }
  async function whereAll(exe) {
    const r = await safeCmd('where', [exe], 6000);
    return envDetect.parseWherePaths(r.stdout);
  }

  async function detectAll() {
    const detected = [];
    const pyPaths = await whereAll('python');
    const pyLauncher = envDetect.parsePyLauncher((await safeCmd('py', ['-0p'], 6000)).stdout);
    let pyVersion = '';
    if (pyPaths.length) pyVersion = ((await safeCmd(pyPaths[0], ['--version'], 5000)).stdout || '').trim();
    detected.push(Object.assign(envDetect.summarize('python', { paths: pyPaths, version: pyVersion, source: pyLauncher.length ? 'py 启动器' : '' }), { launcher: pyLauncher }));

    const nodePaths = await whereAll('node');
    const nodeVersion = nodePaths.length ? envDetect.parseNodeVersion((await safeCmd(nodePaths[0], ['-v'], 5000)).stdout) : '';
    detected.push(envDetect.summarize('node', { paths: nodePaths, version: nodeVersion }));

    const javaPaths = await whereAll('java');
    let javaVersion = '';
    if (javaPaths.length) {
      const r = await safeCmd(javaPaths[0], ['-version'], 5000);
      javaVersion = envDetect.parseJavaVersion(r.stderr + r.stdout);
    }
    detected.push(envDetect.summarize('jdk', { paths: javaPaths, version: javaVersion }));

    const gccPaths = await whereAll('gcc');
    const gxxPaths = gccPaths.length ? [] : await whereAll('g++');
    let gccVersion = '';
    if (gccPaths.length) gccVersion = envDetect.parseGccVersion((await safeCmd(gccPaths[0], ['--version'], 5000)).stdout);
    else if (gxxPaths.length) gccVersion = envDetect.parseGccVersion((await safeCmd(gxxPaths[0], ['--version'], 5000)).stdout);
    detected.push(envDetect.summarize('mingw', { paths: gccPaths.concat(gxxPaths), version: gccVersion }));

    return { detected };
  }

  /* ---------- 通道 ---------- */
  handle(CH.ENV.CATALOG, () => {
    const m = manifestGet();
    const a = appliedGet();
    return {
      envRoot: ENV_ROOT(),
      runtimes: envCatalog.getRuntimes().map((r) => Object.assign({}, r, {
        installed: m[r.id] ? { version: m[r.id].version, dir: m[r.id].dir, at: m[r.id].at } : null,
        applied: !!(a && (a.ids || []).includes(r.id)),
      })),
      applied: a ? { ids: a.ids || [], pathLength: a.pathLength || 0, at: a.at } : null,
    };
  });

  handle(CH.ENV.DETECT, () => detectAll());

  handle(CH.ENV.INSTALL, async (e, id, opts = {}) => {
    const rt = envCatalog.findRuntime(id);
    if (!rt) throw new Error('未知的运行时：' + id);
    const layout = envCatalog.installLayout(userDataDir(), rt);
    const cur = manifestGet()[id];
    const jobId = 'env' + nextJobSeq();
    const ctrl = new AbortController();
    jobs.set(jobId, { cancel: () => ctrl.abort() });
    setLatestCancelable(() => ctrl.abort());
    try {
      if (cur && cur.version === rt.version && fs.existsSync(cur.dir)) {
        let applied = false;
        const warnings = [];
        if (opts.applyPath !== false) {
          const a = await applyIds([id]);
          applied = a.appliedIds.includes(id);
          warnings.push(...(a.warnings || []));
        }
        return { id, version: rt.version, dir: cur.dir, already: true, applied, warnings };
      }
      const downloads = path.join(ENV_ROOT(), 'downloads');
      await fsp.mkdir(downloads, { recursive: true });
      const archive = path.join(downloads, rt.id + '-' + envCatalog.safeVersion(rt.version) + extOf(rt));
      if (!(await exists(archive)) || (await fsp.stat(archive)).size === 0) {
        await downloadToFile(rt.url, archive, jobId, ctrl, rt.name + ' ' + rt.version);
      }
      if (ctrl.signal.aborted) throw new Error('已取消');
      const digest = await sha256File(archive);
      if (digest !== rt.sha256) {
        await fsp.rm(archive, { force: true }).catch(() => {});
        throw new Error('下载包校验失败（SHA-256 不符），已删除，请重试');
      }
      const staging = path.join(ENV_ROOT(), '.staging-' + jobId);
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      await fsp.mkdir(staging, { recursive: true });
      await extractArchive(archive, staging, rt);
      const root = await payloadRoot(staging, rt.stripTop);
      await fsp.mkdir(path.dirname(layout.dir), { recursive: true });
      const trash = layout.dir + '.old-' + Date.now();
      if (fs.existsSync(layout.dir)) await moveFile(layout.dir, trash);
      try {
        await moveFile(root, layout.dir);
      } catch (err) {
        if (fs.existsSync(trash)) await moveFile(trash, layout.dir).catch(() => {});
        throw err;
      }
      if (fs.existsSync(trash)) await fsp.rm(trash, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      const m = manifestGet();
      m[id] = { version: rt.version, dir: layout.dir, sha256: rt.sha256, at: Date.now() };
      manifestSet(m);
      let applied = false;
      const warnings = [];
      if (opts.applyPath !== false) {
        const a = await applyIds([id]);
        applied = a.appliedIds.includes(id);
        warnings.push(...(a.warnings || []));
      }
      return { id, version: rt.version, dir: layout.dir, already: false, applied, warnings };
    } finally {
      jobs.delete(jobId);
    }
  });

  handle(CH.ENV.REMOVE, async (e, id) => {
    const rt = envCatalog.findRuntime(id);
    if (!rt) throw new Error('未知的运行时：' + id);
    const m = manifestGet()[id];
    if (!m) return { removed: false };
    const a = appliedGet();
    if (a && (a.ids || []).includes(id)) await unapplyIds([id]);
    await fsp.rm(m.dir, { recursive: true, force: true }).catch(() => {});
    const next = manifestGet();
    delete next[id];
    manifestSet(next);
    return { removed: true };
  });

  handle(CH.ENV.APPLY, (e, ids) => applyIds(Array.isArray(ids) ? ids : []));
  handle(CH.ENV.UNAPPLY, (e, ids) => unapplyIds(Array.isArray(ids) && ids.length ? ids : null));

  handle(CH.ENV.OPEN_TERMINAL, async (e, id) => {
    const m = manifestGet();
    const ids = id ? [id] : Object.keys(m);
    const installed = ids.filter((x) => m[x]);
    if (!installed.length) throw new Error('还没有安装任何环境');
    const dirs = installed.flatMap((x) => entriesFor(x).dirs);
    const vars = Object.assign({}, ...installed.map((x) => entriesFor(x).vars));
    const curPath = process.env.Path || process.env.PATH || '';
    const env = Object.assign({}, process.env, vars, { Path: envPath.prependEntries(curPath, dirs).value });
    const label = installed.map((x) => x + ' ' + m[x].version).join(', ');
    const child = spawn('cmd.exe', ['/k', 'echo 已加载开发环境：' + label.replace(/["\r\n]/g, '') + ' & echo 当前终端已带好 PATH / JAVA_HOME，关闭窗口即退出。'],
      { env, detached: true, stdio: 'ignore', windowsHide: false, cwd: os.homedir() });
    child.on('error', () => {});
    child.unref();
    return { opened: true, env: label };
  });

  return { detectAll }; // 供测试/其它域复用（与 fs-ops 的导出风格一致）
};