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
 *
 * ============ 第五轮审查修掉的四个隐患（改这里前先读） ============
 *   1. readUserEnv 必须给 PowerShell 加强制 UTF-8 输出：默认 OEM 代码页会把
 *      含中文的 PATH 读成乱码，写回即损坏用户 PATH（实测复现）。
 *   2. PATH 可能是 REG_EXPAND_SZ（含 %USERPROFILE% 一类引用）。读要用
 *      DoNotExpandEnvironmentNames，写要按原类型写回，不能用 .NET
 *      SetEnvironmentVariable（它恒写 REG_SZ，会把引用变字面量）。
 *   3. apply/unapply/manifest 是"读-改-写"三段，必须串行；否则两个操作
 *      基于同一份旧 PATH 各写一次，后写覆盖先写（丢失更新）。
 *   4. 下载缓存不能"非空即信"：完整但哈希不符的包要能区分并给出可读错误，
 *      而不是无限重下同一个错包。
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
  /* manifest 有可能被页面通过 store:set 直接改写（STORE.SET 只挡了
   * __proto__/constructor/updateCache，没有挡 envInstalled）。ENV.REMOVE
   * 会按 m.dir 做递归删除 —— 若这里不验证，写入
   * {envInstalled:{x:{dir:'C:\\Windows'}}} 就能让「删除环境」变成删系统目录。
   * 这里让 manifestGet 只返回 dir 确实位于 ENV_ROOT 子目录下的条目；
   * 其余条目视为损坏/伪造，忽略（安装流程会重建）。
   * 注意：rel 不能为空（ENV_ROOT 本身不能当某个运行时的目录被删）。 */
  function isSafeEnvDir(dir, id) {
    if (typeof dir !== 'string' || !dir.trim()) return false;
    if (typeof id !== 'string' || !id) return false;
    const root = path.resolve(ENV_ROOT());
    const abs = path.resolve(dir);
    const rel = path.relative(root, abs);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
    /* 只允许 <ENV_ROOT>/<运行时 id>/...。否则伪造的 envInstalled 条目
     * 可以指向 ENV_ROOT/downloads 或 .staging-xxx，ENV.REMOVE 会把它
     * 整个递归删掉（虽然仍在 userData 下，但那是缓存/安装中的数据）。 */
    return rel.split(path.sep)[0] === id;
  }
  const manifestGet = () => {
    const m = storeGet('envInstalled', {});
    if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
    const out = {};
    for (const [id, entry] of Object.entries(m)) {
      if (!entry || typeof entry !== 'object') continue;
      if (!isSafeEnvDir(entry.dir, id)) continue;
      out[id] = entry;
    }
    return out;
  };
  const manifestSet = (m) => storeSet('envInstalled', m);
  const appliedGet = () => {
    const a = storeGet('envApplied', null);
    if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
    /* store 可以被本地编辑/旧版本写坏：ids 不是数组时后续 `ids.includes`
     * 会直接 TypeError，撤销按钮就完全失效。这里统一成字符串数组。 */
    return Object.assign({}, a, {
      ids: Array.isArray(a.ids) ? a.ids.filter((x) => typeof x === 'string') : [],
      entries: Array.isArray(a.entries) ? a.entries.filter((x) => typeof x === 'string') : [],
    });
  };
  const appliedSet = (a) => storeSet('envApplied', a || null);

  /* ---------- 串行锁：用户环境写与 manifest 更新必须排队 ---------- */
  let envLockChain = Promise.resolve();
  /**
   * @template T
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withEnvLock(fn) {
    const run = envLockChain.then(fn, fn);
    envLockChain = run.then(() => {}, () => {});
    return run;
  }
  /* 同一运行时的安装不能并行（两次解压/落盘会互相覆盖） */
  const installing = new Set();
  /* 【活动中的环境包文件名集合】
   * CLEAN 会遍历 downloads 目录删文件，而安装用的 archive 与下载分片
   * （<dest>.part-*）都在同一目录。必须由**主进程**记住哪些文件正在用，
   * 否则「另一个窗口点清理」会删掉正在解压的包或正在写的分片。
   * 键是文件名（不含路径）：downloads 目录是固定的，同名即同文件。
   * 安装开始 add、结束（成功/失败/取消）在 finally 里 delete。 */
  const activeEnvFiles = new Set();
  /** 这个文件名是否正被某个下载/安装使用。用文件名而不是全路径，
   *  因为 CLEAN 拿到的就是 readdir 的结果，且 downloads 目录唯一。 */
  function isActiveEnvFile(name) {
    if (activeEnvFiles.has(name)) return true;
    /* 分片形如 <archive>.part-<ts>-<hex>：前缀命中也算活动。
     * 判据取「某个 f 是 name 的前缀」而不是反过来 —— name 比分片名短。 */
    for (const f of activeEnvFiles) {
      if (String(name).startsWith(f + '.part-')) return true;
    }
    return false;
  }
  let detectCache = null;

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
      const r = await runCmd(sevenZa, ['x', archive, '-o' + staging, '-y', '-bd'], { timeout: 300000, allowNonZero: true });
      if (r.code !== 0) throw new Error('解压失败：' + String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-2).join(' '));
      return;
    }
    if (rt.archive === 'tar.gz') {
      /* 7za 不能直接把 tar.gz 解到目标并丢顶层；分两步：gz → tar → 目录。 */
      const gzOut = path.join(staging, '.gz');
      await fsp.mkdir(gzOut, { recursive: true });
      let r = await runCmd(sevenZa, ['x', archive, '-o' + gzOut, '-y', '-bd'], { timeout: 300000, allowNonZero: true });
      if (r.code !== 0) throw new Error('解压 gz 失败');
      const tarFile = (await fsp.readdir(gzOut)).find((n) => /\.tar$/i.test(n));
      if (!tarFile) throw new Error('tar.gz 里没有 tar 包');
      r = await runCmd(sevenZa, ['x', path.join(gzOut, tarFile), '-o' + staging, '-y', '-bd'], { timeout: 300000, allowNonZero: true });
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
  /* 备份存「变量名 → { value, kind }」。kind 用于撤销时按原类型还原。 */
  const BACKUP_KEY = 'envVarsBackup';

  async function readUserEnv() {
    if (userEnvIO && typeof userEnvIO.read === 'function') return userEnvIO.read();
    /* 【必须强制 UTF-8 输出】PowerShell 5.1 默认按 OEM 代码页（中文系统 GBK）写
     * stdout，而 runCmd 按 utf8 解码 —— 含中文的 PATH 会读成乱码，随后写回就把
     * 用户 PATH 损坏（第五轮审查实测复现）。与 main.js 的 ps() 同一处理。
     *
     * 【必须取未展开原值】PATH 可能是 REG_EXPAND_SZ（含 %USERPROFILE% 一类引用）；
     * 展开后再写回会把引用变字面量。DoNotExpandEnvironmentNames 拿原始字符串，
     * 同时把值类型读出来，写回时原样保留。 */
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
      '$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment");',
      '$opt = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames;',
      'function GetRaw($n) {',
      '  if ($null -eq $k -or -not ($k.GetValueNames() -contains $n)) { return [pscustomobject]@{ v=$null; kind="String" } }',
      '  return [pscustomobject]@{ v=$k.GetValue($n, $null, $opt); kind=$k.GetValueKind($n).ToString() }',
      '}',
      '$p = GetRaw "Path"; $j = GetRaw "JAVA_HOME";',
      '[pscustomobject]@{ path=$p.v; pathKind=$p.kind; javaHome=$j.v; javaHomeKind=$j.kind } | ConvertTo-Json -Compress',
    ].join(' ');
    const r = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 20000, allowNonZero: true });
    if (r.code !== 0) throw new Error('读取用户环境变量失败（' + String(r.stderr || '').split(/\r?\n/).slice(-1) + '）');
    try {
      const j = JSON.parse(String(r.stdout || '{}'));
      return {
        path: j.path == null ? '' : String(j.path),
        pathKind: j.pathKind === 'ExpandString' ? 'ExpandString' : 'String',
        vars: { JAVA_HOME: j.javaHome == null ? '' : String(j.javaHome) },
        varKinds: { JAVA_HOME: j.javaHomeKind === 'ExpandString' ? 'ExpandString' : 'String' },
      };
    } catch (e) {
      throw new Error('解析用户环境变量失败');
    }
  }

  /**
   * @param {{pathValue?:string|null, pathKind?:'String'|'ExpandString',
   *          vars?:{name:string,value:string,kind:string}[],
   *          removeVars?:string[]}} spec
   */
  async function writeUserEnv({ pathValue = null, pathKind = 'String', vars = [], removeVars = [] } = {}) {
    if (userEnvIO && typeof userEnvIO.write === 'function') {
      return userEnvIO.write({ pathValue, pathKind, vars, removeVars });
    }
    const dir = ENV_ROOT();
    await fsp.mkdir(dir, { recursive: true });
    const base = '.env-write-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
    const jsonPath = path.join(dir, base + '.json');
    const scriptPath = path.join(dir, base + '.ps1');
    await fsp.writeFile(jsonPath, JSON.stringify({ pathValue, pathKind, vars, removeVars }), 'utf8');
    /* 【按原类型写回】.NET 的 SetEnvironmentVariable 恒写 REG_SZ；
     * 用户 PATH 若是 REG_EXPAND_SZ，写回会静默把 %VAR% 变成字面量。
     * 这里用注册表提供程序按类型写，值本身保持读到的未展开原文。 */
    const lines = [
      '$ErrorActionPreference = "Stop"',
      '$spec = Get-Content -Raw -Encoding UTF8 ' + psSingleQuote(jsonPath) + ' | ConvertFrom-Json',
      'function SetUserVar($name, $value, $kind) {',
      '  if ($null -eq $value -or [string]$value -eq "") { Remove-ItemProperty -Path "HKCU:\\Environment" -Name $name -ErrorAction SilentlyContinue; return }',
      '  if ($kind -eq "ExpandString") { Set-ItemProperty -Path "HKCU:\\Environment" -Name $name -Value ([string]$value) -Type ExpandString }',
      '  else { Set-ItemProperty -Path "HKCU:\\Environment" -Name $name -Value ([string]$value) -Type String }',
      '}',
      'if ($null -ne $spec.pathValue) { SetUserVar "Path" $spec.pathValue $spec.pathKind }',
      'foreach ($v in @($spec.vars)) { SetUserVar $v.name $v.value $v.kind }',
      'foreach ($n in @($spec.removeVars)) { if ($n) { Remove-ItemProperty -Path "HKCU:\\Environment" -Name $n -ErrorAction SilentlyContinue } }',
      /* 广播 WM_SETTINGCHANGE：不广播的话，用户从任务栏新开 cmd 仍然读到旧 PATH */
      'Add-Type -TypeDefinition @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class HeheEnvBroadcast {',
      '  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]',
      '  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);',
      '}',
      '"@',
      '$r=[UIntPtr]::Zero',
      '[HeheEnvBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 3000, [ref]$r) | Out-Null',
    ];
    await fsp.writeFile(scriptPath, psScript.withBom(lines.join('\r\n')), 'utf8');
    try {
      const r = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { timeout: 30000, allowNonZero: true });
      if (r.code !== 0) {
        throw new Error('写入用户环境失败：' + String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-2).join(' '));
      }
    } finally {
      await fsp.rm(scriptPath, { force: true }).catch(() => {});
      await fsp.rm(jsonPath, { force: true }).catch(() => {});
    }
  }

  function normalizeBackupEntry(v) {
    /* 兼容旧版备份形状（纯字符串） */
    if (v == null) return { value: '', kind: 'String' };
    if (typeof v === 'string') return { value: v, kind: 'String' };
    return {
      value: String(v.value == null ? '' : v.value),
      kind: v.kind === 'ExpandString' ? 'ExpandString' : 'String',
    };
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
  async function applyIdsRaw(ids) {
    const warnings = [];
    const list = [...new Set((ids || []).filter((x) => manifestGet()[x]))];
    if (!list.length) return { appliedIds: [], warnings: ['没有可加入的环境（先安装）'] };
    const cur = await readUserEnv();
    /* 备份原始值（含类型）：**每个变量在第一次被我们覆盖前**记下来。
     * 注意不能只在第一次 apply 建一次空表就完事 —— 先加 node（无变量）再加
     * jdk 时，JAVA_HOME 会没有原始值，撤销就还原不回去（第五轮测试抓到）。 */
    const backupRoot = storeGet(BACKUP_KEY, null);
    let backupVars = {};
    if (backupRoot && typeof backupRoot === 'object') {
      if (backupRoot.vars && typeof backupRoot.vars === 'object') backupVars = Object.assign({}, backupRoot.vars);
      else {
        for (const [k, v] of Object.entries(backupRoot)) {
          if (k === 'at') continue;
          backupVars[k] = normalizeBackupEntry(v);
        }
      }
    }
    let backupChanged = !(backupRoot && typeof backupRoot === 'object');
    for (const id of list) {
      for (const k of Object.keys(entriesFor(id).vars)) {
        if (k in backupVars) continue;
        backupVars[k] = { value: (cur.vars || {})[k] || '', kind: (cur.varKinds || {})[k] || 'String' };
        backupChanged = true;
      }
    }
    if (backupChanged) storeSet(BACKUP_KEY, { vars: backupVars, at: Date.now() });
    const all = list.flatMap((id) => entriesFor(id).dirs);
    const prep = envPath.prependEntries(cur.path, all);
    if (envPath.pathTooLong(prep.value)) warnings.push('用户 PATH 已超过 2000 字符，部分程序可能截断');
    const vars = [];
    for (const id of list) {
      for (const [k, v] of Object.entries(entriesFor(id).vars)) {
        vars.push({ name: k, value: v, kind: (cur.varKinds || {})[k] || 'String' });
      }
    }
    await writeUserEnv({ pathValue: prep.value, pathKind: cur.pathKind || 'String', vars });
    const prev = appliedGet() || { ids: [] };
    appliedSet({
      ids: [...new Set([...(prev.ids || []), ...list])],
      entries: [...new Set([...(prev.entries || []), ...prep.added])],
      vars: Object.fromEntries(vars.map((v) => [v.name, v.value])),
      pathLength: prep.value.length,
      at: Date.now(),
    });
    return { appliedIds: list, pathLength: prep.value.length, warnings };
  }

  /** 撤销：摘掉我们加的目录；变量只在仍是我们的值时才还原 */
  async function unapplyIdsRaw(only) {
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
    const backupRoot = storeGet(BACKUP_KEY, null) || {};
    const backupVars = (backupRoot.vars && typeof backupRoot.vars === 'object') ? backupRoot.vars : backupRoot;
    const varsToWrite = [];
    const varsToRemove = [];
    const restored = [];
    const ourVars = removeIds.reduce((acc, id) => Object.assign(acc, entriesFor(id).vars), {});
    for (const [k, ours] of Object.entries(ourVars)) {
      if ((cur.vars || {})[k] !== ours) continue;   // 用户自己改过 → 不动，也不回滚
      const b = normalizeBackupEntry(backupVars[k]);
      if (b.value) { varsToWrite.push({ name: k, value: b.value, kind: b.kind }); restored.push(k); }
      else varsToRemove.push(k);
    }
    await writeUserEnv({ pathValue: nextPath, pathKind: cur.pathKind || 'String', vars: varsToWrite, removeVars: varsToRemove });
    if (keepIds.length) {
      const keepVars = keepIds.reduce((acc, id) => Object.assign(acc, entriesFor(id).vars), {});
      appliedSet({ ids: keepIds, entries: keepDirs, vars: keepVars, at: Date.now() });
    } else {
      appliedSet(null);
      storeSet(BACKUP_KEY, null);
    }
    return { removed: rem.removed.length, restoredVars: restored, warnings: [] };
  }

  /* 对外一律排队执行，避免「读-改-写」交错丢更新 */
  const applyIds = (ids) => withEnvLock(() => applyIdsRaw(ids));
  const unapplyIds = (only) => withEnvLock(() => unapplyIdsRaw(only));

  /* ---------- 残留清理（启动时跑一次） ---------- */
  async function sweepEnvRoot() {
    const root = ENV_ROOT();
    const now = Date.now();
    const STALE = 10 * 60 * 1000;   // 正在安装的 staging/old 不会超过 10 分钟
    let entries;
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      /* 不跟随链接：若 .staging-* 恰好是用户/恶意程序建的 junction，
       * 下面的 rm recursive 会删到链接目标而不是链接本身。 */
      if (ent.isSymbolicLink()) continue;
      const full = path.join(root, ent.name);
      const stale = now - ((await fsp.stat(full).catch(() => null)) || { mtimeMs: now }).mtimeMs > STALE;
      if (!stale) continue;
      if (ent.isDirectory() && (/^\.staging-/.test(ent.name) || /\.old-\d+$/.test(ent.name))) {
        await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
      } else if (ent.isFile() && (/^\.env-write-/.test(ent.name) || /^\.term-/.test(ent.name))) {
        await fsp.rm(full, { force: true }).catch(() => {});
      }
    }
  }
  sweepEnvRoot().catch(() => {});

  /* ---------- 命令探测 ---------- */
  async function safeCmd(cmd, args, timeout) {
    try {
      const r = await runCmd(cmd, args, { timeout: timeout || 8000, allowNonZero: true });
      return { code: r.code, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
    } catch (e) {
      return { code: -1, stdout: '', stderr: String((e && e.message) || e) };
    }
  }
  async function whereAll(exe) {
    const r = await safeCmd('where', [exe], 6000);
    /* WindowsApps 里的 python.exe 是「应用执行别名」，运行它会拉起商店。
     * 探测时跳过它，避免用户只是打开页面就被弹商店。 */
    return envDetect.parseWherePaths(r.stdout).filter((p) => !/\\WindowsApps\\/i.test(p));
  }

  async function detectPython() {
    const pyPaths = await whereAll('python');
    const pyLauncher = envDetect.parsePyLauncher((await safeCmd('py', ['-0p'], 6000)).stdout);
    let version = '';
    /* 优先用 py 启动器登记的真实解释器，避免跑 WindowsApps 别名 */
    const target = (pyLauncher.find((x) => x.isDefault) || pyLauncher[0] || {}).path || pyPaths[0];
    if (target) version = ((await safeCmd(target, ['--version'], 5000)).stdout || '').trim();
    return Object.assign(envDetect.summarize('python', { paths: pyPaths, version, source: pyLauncher.length ? 'py 启动器' : '' }), { launcher: pyLauncher });
  }
  async function detectNode() {
    const paths = await whereAll('node');
    const version = paths.length ? envDetect.parseNodeVersion((await safeCmd(paths[0], ['-v'], 5000)).stdout) : '';
    return envDetect.summarize('node', { paths, version });
  }
  async function detectJava() {
    const paths = await whereAll('java');
    let version = '';
    if (paths.length) {
      const r = await safeCmd(paths[0], ['-version'], 5000);
      version = envDetect.parseJavaVersion(r.stderr + r.stdout);
    }
    return envDetect.summarize('jdk', { paths, version });
  }
  async function detectGcc() {
    const gccPaths = await whereAll('gcc');
    const gxxPaths = gccPaths.length ? [] : await whereAll('g++');
    const target = gccPaths[0] || gxxPaths[0] || '';
    const version = target ? envDetect.parseGccVersion((await safeCmd(target, ['--version'], 5000)).stdout) : '';
    return envDetect.summarize('mingw', { paths: gccPaths.concat(gxxPaths), version });
  }

  async function detectAll() {
    /* 四组并行：串行时最坏要等 4×6s 超时，页面一直「检测中」。 */
    const detected = await Promise.all([detectPython(), detectNode(), detectJava(), detectGcc()]);
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

  handle(CH.ENV.DETECT, async (e, force) => {
    /* 60 秒缓存：安装/加环境后界面会 force 重探，避免读到旧结果。 */
    if (!force && detectCache && Date.now() - detectCache.at < 60000) return detectCache.data;
    const data = await detectAll();
    detectCache = { at: Date.now(), data };
    return data;
  });

  handle(CH.ENV.INSTALL, async (e, id, opts = {}) => {
    const rt = envCatalog.findRuntime(id);
    if (!rt) throw new Error('未知的运行时：' + id);
    if (installing.has(id)) throw new Error('该环境正在安装，请稍候');
    installing.add(id);
    const layout = envCatalog.installLayout(userDataDir(), rt);
    const cur = manifestGet()[id];
    const jobId = 'env' + nextJobSeq();
    const ctrl = new AbortController();
    jobs.set(jobId, { cancel: () => ctrl.abort() });
    setLatestCancelable(() => ctrl.abort());
    /* 提到 try 外面：finally 里要按它注销「使用中」。
     * 提前 return 的路径（already 分支）不会走到登记，delete 一个不存在的
     * 键是安全的幂等操作。 */
    let archiveRef = '';
    try {
      if (cur && cur.version === rt.version && fs.existsSync(cur.dir)) {
        const a = opts.applyPath !== false ? await applyIds([id]) : { appliedIds: [], warnings: [] };
        return { id, version: rt.version, dir: cur.dir, already: true, applied: a.appliedIds.includes(id), warnings: a.warnings || [] };
      }
      const downloads = path.join(ENV_ROOT(), 'downloads');
      await fsp.mkdir(downloads, { recursive: true });
      const archive = path.join(downloads, rt.id + '-' + envCatalog.safeVersion(rt.version) + extOf(rt));
      archiveRef = archive;
      /* 【登记为「使用中」】从此处到安装结束，CLEAN 不许删这个包，
       * 也不许删它正在写的分片（<archive>.part-*）。见 isActiveEnvFile。 */
      activeEnvFiles.add(path.basename(archive));
      /* 【缓存不能"非空即信"】先校验缓存；哈希不符就删掉重下（镜像/中断都可能
       * 留下完整但内容错误的包）。重下后仍不符则明确报错，不做无限重试。 */
      let useCache = (await exists(archive)) && (await fsp.stat(archive)).size > 0;
      if (useCache && (await sha256File(archive)) !== rt.sha256) {
        await fsp.rm(archive, { force: true }).catch(() => {});
        useCache = false;
      }
      if (!useCache) await downloadToFile(rt.url, archive, jobId, ctrl, rt.name + ' ' + rt.version);
      if (ctrl.signal.aborted) throw new Error('已取消');
      const digest = await sha256File(archive);
      if (digest !== rt.sha256) {
        await fsp.rm(archive, { force: true }).catch(() => {});
        throw new Error('下载包校验失败（SHA-256 不符：期望 ' + rt.sha256.slice(0, 8) + '…，实际 ' + digest.slice(0, 8) + '…）。'
          + '可能是镜像文件被替换，请稍后重试或反馈。');
      }
      const staging = path.join(ENV_ROOT(), '.staging-' + jobId);
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      await fsp.mkdir(staging, { recursive: true });
      try {
        await extractArchive(archive, staging, rt);
        if (ctrl.signal.aborted) throw new Error('已取消');
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
      } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
      /* manifest 与「加入环境」放在同一把锁里，避免与撤销/删除交错 */
      const a = await withEnvLock(async () => {
        const m = manifestGet();
        m[id] = { version: rt.version, dir: layout.dir, sha256: rt.sha256, at: Date.now() };
        manifestSet(m);
        if (opts.applyPath === false) return { appliedIds: [], warnings: [] };
        return applyIdsRaw([id]);
      });
      return { id, version: rt.version, dir: layout.dir, already: false, applied: a.appliedIds.includes(id), warnings: a.warnings || [] };
    } finally {
      installing.delete(id);
      /* 注销「使用中」：安装成功/失败/取消都要走到，否则这个包
       * 永远不许被清理（缓存会越积越多）。在 try 外层的 finally 里
       * 统一清，比在每个出口各写一遍更可靠。 */
      activeEnvFiles.delete(path.basename(archiveRef));
      jobs.delete(jobId);
    }
  });

  handle(CH.ENV.REMOVE, (e, id) => withEnvLock(async () => {
    const rt = envCatalog.findRuntime(id);
    if (!rt) throw new Error('未知的运行时：' + id);
    const m = manifestGet()[id];
    if (!m) return { removed: false };
    const a = appliedGet();
    if (a && (a.ids || []).includes(id)) await unapplyIdsRaw([id]);
    try {
      await fsp.rm(m.dir, { recursive: true, force: true });
    } catch (err) {
      /* 目录删不掉（常是里面的 exe 正在被终端占用）：保留 manifest 让用户重试，
       * 而不是删了记录、留下一个再也删不掉的目录。 */
      throw new Error('删除失败（文件可能正在使用）：' + String((err && err.message) || err));
    }
    const next = manifestGet();
    delete next[id];
    manifestSet(next);
    return { removed: true };
  }));

  handle(CH.ENV.CLEAN, async () => {
    const dir = path.join(ENV_ROOT(), 'downloads');
    let removed = 0, freed = 0;
    const errors = [];
    /* 【readdir 失败不能当成「没有文件」】
     * 原来 `.catch(() => [])`：目录不可读（权限/IO/盘符掉线）时直接当作
     * 空目录，界面显示「没有可清理的安装包」—— 用户以为清理过了，
     * 实际问题一直在。要如实写进 errors，让界面报错。 */
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        /* 目录还没建过：这是真的「没有缓存」，不是错误 */
        entries = [];
      } else {
        errors.push('读取缓存目录失败：' + String((err && err.message) || err));
      }
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const full = path.join(dir, ent.name);
      /* 【不能删活动中的包】
       * 清理是「扫 downloads 目录里所有文件」，而下载分片 <dest>.part-* 与
       * 安装用的 archive 都在同一个目录里。用户在主窗点「清理缓存」时，
       * 另一个窗口（或本窗口）可能正在下载/安装 —— 删掉分片会让下载失败，
       * 删掉 archive 会让正在解压的安装崩掉。
       * 判据用主进程自己的状态（installing 集合 + 活动 job 登记），
       * **不依赖渲染层的 busy**：那是每个页面各一份的，跨窗口不共享。 */
      if (isActiveEnvFile(ent.name)) continue;
      /* 【stat 失败要区分两种原因】
       *   · ENOENT：文件在这两条语句之间被别的进程删了 → 不算错误，
       *     跳过即可（已经不存在，本来也不需要清理）；
       *   · 其余（EPERM/EACCES/EIO…）：真的读不到，必须进 errors，
       *     否则会被当成"没有这个文件"而静默漏掉。 */
      let st = null;
      try {
        st = await fsp.stat(full);
      } catch (err) {
        if (!(err && err.code === 'ENOENT')) {
          errors.push(ent.name + '：读取失败（' + String((err && err.code) || err && err.message || err) + '）');
        }
        continue;
      }
      /* 【只有真删掉才算 removed/freed】
       * 原来 `fsp.rm(...).catch(() => {})` 后无条件 removed++/freed += size：
       * 文件被占用（EPERM）或权限不足时，界面会报告「已清理 N 个、释放 X」，
       * 而磁盘上文件还在 —— 用户以为清了，实际没清。 */
      try {
        await fsp.rm(full, { force: true });
        removed++;
        freed += st.size;
      } catch (err) {
        errors.push(ent.name + '：' + String((err && err.message) || err));
      }
    }
    return { removed, freed, errors };
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
    /* 【不再把内容拼进 cmd 命令行】改用临时 .cmd 脚本：避免 & | ^ 之类的
     * 命令拼接面与中文 echo 的代码页问题；脚本只做提示与切码页。 */
    const dir = ENV_ROOT();
    await fsp.mkdir(dir, { recursive: true });
    const scriptPath = path.join(dir, '.term-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.cmd');
    const safeLabel = label.replace(/[^\w.\-+,() ]/g, '');
    await fsp.writeFile(scriptPath, [
      '@echo off',
      'chcp 65001 >nul',
      'echo Toolchain environment loaded: ' + safeLabel,
      'echo PATH / JAVA_HOME are ready in this window. Close it to exit.',
      'cd /d "%USERPROFILE%"',
    ].join('\r\n'), 'utf8');
    const child = spawn('cmd.exe', ['/k', scriptPath],
      { env, detached: true, stdio: 'ignore', windowsHide: false, cwd: os.homedir() });
    child.on('error', () => {});
    child.unref();
    /* cmd 启动后会一次性读完脚本，15 秒后删掉即可（启动清扫也会兜底） */
    setTimeout(() => { fsp.rm(scriptPath, { force: true }).catch(() => {}); }, 15000).unref();
    return { opened: true, env: label };
  });

  return { detectAll, readUserEnv }; // 供测试/其它域复用（与 fs-ops 的导出风格一致）
};