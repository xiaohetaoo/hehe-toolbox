'use strict';
/* 目录联接（junction）/ 符号链接的识别、体检与「只删链接不删目标」的删除。
 *
 * ============================ 安全硬约束 ============================
 * 本模块**只允许**对「链接自身路径」执行删除，并且这条规则由代码强制，
 * 不是注释里的君子协定：
 *
 *   - removeLinkOnly() 内部会先 lstat 确认那是链接（不是普通目录/文件），
 *     再用 fs.unlink / rmdir 删「这个 reparse point 本身」；
 *   - 它在入口处**拒绝**任何看起来像「解析后目标」的路径：
 *     调用方若把 resolveReal(link) 的结果传进来，会被 assertNotResolved() 挡下。
 *
 * 【为什么必须这么严】实测（本机 Windows / Node 24）：
 *   fs.rmSync(realpath(link), { recursive: true })  →  真实数据被删光，
 *   连 junction 本身也一起消失。也就是说，一旦误用 realpath 做删除，
 *   用户看到的是「文件全没了」。这不是假设，是跑出来的结果。
 *
 * 反面对照（安全的手法，也都实测过）：
 *   fs.rmSync(link)                    → 只删链接 ✅
 *   fs.rmSync(link, {recursive:true})  → 只删链接 ✅（Node 会识别 junction）
 *   fsp.unlink(link)                   → 只删链接 ✅
 *   cmd /c rmdir "link"                → 只删链接 ✅
 *   PowerShell Remove-Item             → ❌ 本项目的 ps() 恒带 -NonInteractive，
 *                                        删 junction 会要求确认而失败，不可用
 * ===================================================================
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const pathGuard = require('./path-guard');

/* Windows 的 reparse point tag：junction 是 0xA0000003。
 * Node 的 lstat 只给 isSymbolicLink()（junction 也算 true），
 * 但「符号链接」与「junction」在删除与跨机器行为上不同，
 * 需要区分时用 PowerShell 读 LinkType / Target。
 *
 * 【实测补充】Windows 允许对**不存在的目标**建 junction（悬空链接），
 * `mklink /J` 不会报错。所以：
 *   - 「僵尸链接」是正常存在的状态，不是异常产物；
 *   - 判断链接好坏**必须**用 realpath / 访问目标，
 *     不能只看「链接条目在不在」。 */

/**
 * 判断某个路径是不是链接（junction / symlink），且**不跟随**。
 * @returns {{isLink:boolean, isDir:boolean, kind:string, exists:boolean}}
 */
function linkStat(p) {
  let st;
  try { st = fs.lstatSync(p); }
  catch (e) {
    // 悬空链接：lstat 可能因目标不存在而失败（Windows 上通常仍能 lstat 到链接本身）
    return { isLink: false, isDir: false, kind: 'missing', exists: false, error: e.code || e.message };
  }
  const isLink = st.isSymbolicLink();
  return {
    isLink,
    isDir: st.isDirectory(),
    kind: isLink ? 'link' : (st.isDirectory() ? 'dir' : 'file'),
    exists: true,
  };
}

/**
 * 用 PowerShell 读链接的 LinkType 与 Target（区分 junction / symboliclink / hardlink）。
 * 读不到（老系统、权限、非链接）时返回 null，不抛。
 *
 * 注意：本项目所有 PowerShell 调用都带 -NonInteractive，
 * 而 Remove-Item 删 junction 在该模式下会要求确认并失败 ——
 * 所以**这里只做读取，绝不用 Remove-Item 删除**（删除走 removeLinkOnly）。
 *
 * @param {string} p
 * @param {Function} psRunner 注入的 PowerShell 执行器（保持本模块可单测）
 * @returns {Promise<{type:string, target:string}|null>}
 */
async function linkInfo(p, psRunner) {
  if (typeof psRunner !== 'function') return null;
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const script =
    `$i = Get-Item -LiteralPath ${q(p)} -Force -ErrorAction SilentlyContinue; ` +
    `if ($i -and $i.LinkType) { $t = $i.Target; if ($t -is [array]) { $t = $t -join '|' }; ` +
    `@($i.LinkType, [string]$t) -join "\`t" }`;
  try {
    const r = await psRunner(script, 15000);
    return parseLinkInfo(r && r.stdout != null ? r.stdout : r);
  } catch (e) {
    return null;
  }
}

/**
 * 把 PowerShell 的输出解析成 {type, target}。
 */
function parseLinkInfo(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  const parts = s.split('\t');
  if (parts.length < 2) return null;
  return { type: (parts[0] || '').toLowerCase(), target: parts.slice(1).join('\t') || '' };
}

/* ---------- 安全删除 ---------- */

class LinkSafetyError extends Error {
  constructor(msg) { super(msg); this.name = 'LinkSafetyError'; this.code = 'LINK_UNSAFE'; }
}

/**
 * 断言「这个路径不是解析后的目标」——把误用 realpath 的情况挡在门外。
 *
 * 判据：如果路径本身 lstat 出来**不是链接**，但它又出现在调用方声称的
 * 「这是个链接」语境里，说明调用方可能已经解析过了。
 * 这里做得更直接：要求调用方显式声明「我传的是链接本身」，
 * 并且我们复核它确实是链接。
 */
function assertIsLinkItself(p, opts) {
  const o = opts || {};
  const abs = path.resolve(String(p || ''));
  const st = linkStat(abs);
  if (!st.exists) throw new LinkSafetyError('路径不存在：' + abs);
  if (!st.isLink && !o.allowKind) {
    throw new LinkSafetyError(
      '拒绝删除：' + abs + ' 不是链接，而是普通' + (st.isDir ? '目录' : '文件') +
      '。这通常意味着你传进来的是解析后的目标路径 —— 那会删掉真实数据。');
  }
  /* 额外防线：如果这个路径的 realpath 与自身不同，说明它是链接（正常）；
   * 若 realpath 相同但调用方以为是链接，已被上面的 isLink 拦掉。 */
  return { abs, st };
}

/**
 * **只删除链接本身**，绝不进入目标。
 *
 * @param {string} linkPath 链接自身的路径（**不能**是 resolveReal 的结果）
 * @param {{dryRun?:boolean}} opts
 * @returns {{removed:boolean, target:string|null, method:string}}
 */
async function removeLinkOnly(linkPath, opts) {
  const o = opts || {};
  const { abs, st } = assertIsLinkItself(linkPath);

  /* 记录目标（供调用方汇报「我删的是指向 X 的链接」），但**绝不**用它删除 */
  let target = null;
  try { target = fs.realpathSync.native(abs); } catch (e) { target = null; }

  if (o.dryRun) return { removed: false, target, method: 'dry-run' };

  /* 删除策略（按实测可靠性排序）：
   * 1) fsp.unlink —— 对 junction/symlink 都有效，语义最明确（删条目而非目录树）
   * 2) 若 unlink 报 EPERM/EISDIR（个别环境），退到 fs.rmSync 不带 recursive
   * 3) 再退到 fsp.rmdir
   *
   * 【为什么第三级不用 cmd rmdir】
   * spawnSync('cmd.exe', ['/c','rmdir', abs]) 只在参数含空格时才会被 Node
   * 加引号；路径**无空格但含 & 或 ^** 时，cmd 会把它们当命令分隔符/转义符，
   * 于是删错东西或直接失败。而 Windows 允许目录名含这两个字符。
   * fsp.rmdir 直接调 Win32 API，路径作为参数传递，不经过 shell ——
   * 对 junction/symlink 它同样只删链接条目本身，不进入目标。
   *
   * 绝不使用 recursive 删除 —— 即便对 junction 当前是安全的，
   * 语义上也太容易被后人改成「顺手删目标」。 */
  let method = 'unlink';
  try {
    await fsp.unlink(abs);
  } catch (e) {
    method = 'rmSync';
    try { fs.rmSync(abs, { force: true }); }
    catch (e2) {
      method = 'rmdir';
      try { await fsp.rmdir(abs); }
      catch (e3) {
        throw new Error('删除链接失败：' + (e3.message || e2.message));
      }
    }
  }

  /* 删完必须复核两件事：
   *   a) 链接确实没了；
   *   b) 目标**仍然存在**（这是本操作最重要的后置条件，
   *      一旦目标没了说明删错了，必须立刻报错让上层停下来）。 */
  const linkGone = !fs.existsSync(abs);
  const targetAlive = target ? fs.existsSync(target) : true;
  if (!linkGone) throw new Error('删除后链接仍然存在：' + abs);
  if (!targetAlive) throw new LinkSafetyError('严重：目标数据消失（' + target + '）—— 请立即停止操作并检查');

  return { removed: true, target, method };
}

/* ---------- 目录搬家（建链接替身）用到的校验 ---------- */

/** 卷路径（盘符）：取盘符根，大小写不敏感。 */
function volumeRoot(p) {
  const abs = path.resolve(String(p || ''));
  const d = path.parse(abs).root;
  return d ? d.toLowerCase() : '';
}

/** 是否同一个卷：同卷搬家没有意义（改路径即可，不需要复制）。 */
function sameVolume(a, b) {
  const ra = volumeRoot(a), rb = volumeRoot(b);
  return !!ra && ra === rb;
}

/** 是否是盘符根（C:\ 这类），搬家绝不能以它为源。 */
function isVolumeRootOnly(p) {
  const abs = path.resolve(String(p || ''));
  const d = path.parse(abs).root;
  return !d || abs === d || abs === d.replace(/\\$/, '');
}

/**
 * 递归统计一个目录的字节数与文件数（用于「空间够不够」预估）。
 * 只读，不跟随链接（遇到 reparse point 就跳过，避免把链接目标算进来。
 * 否则一个指向巨大目录的链接会让预估爆炸）。
 */
async function dirSize(p, limit) {
  const cap = limit && limit.maxEntries ? limit.maxEntries : 200000;
  let bytes = 0, files = 0, dirs = 0;
  const stack = [path.resolve(p)];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = await fsp.readdir(cur, { withFileTypes: true }); }
    catch (e) { continue; }
    dirs++;
    for (const d of ents) {
      const full = path.join(cur, d.name);
      /* 不跟随链接：reparse point 一律跳过（它不占本卷空间） */
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) { stack.push(full); continue; }
      if (d.isFile()) {
        try { const st = await fsp.stat(full); bytes += st.size; files++; } catch (e) {}
      }
      if (files + dirs > cap) return { bytes, files, dirs, truncated: true };
    }
  }
  return { bytes, files, dirs, truncated: false };
}

/* ---------- 链接体检 ---------- */

/* 体检结论分类。顺序即严重程度，前端按这个顺序分组展示。 */
const LINK_KINDS = {
  'ok': { label: '正常', sev: 'ok', desc: '目标存在且可访问' },
  'dead': { label: '僵尸链接', sev: 'bad', desc: '目标已不存在（链接指向空）' },
  'loop': { label: '循环/自指', sev: 'bad', desc: '链接指向自身或形成环' },
  'system': { label: '指向系统目录', sev: 'warn', desc: '目标在系统关键目录内，不建议改动' },
  'crossvol': { label: '目标盘暂不可用', sev: 'warn', desc: '目标在别的盘，该盘当前未接入/被卸载，暂时无法判断链接是否有效 —— 不可清理' },
};

/**
 * 体检单个链接（纯判定，不做删除）。
 * @param {string} linkPath
 * @param {{type?:string, target?:string}} info 由 PowerShell 读到的 LinkType/Target
 */
function classifyLink(linkPath, info) {
  const abs = path.resolve(String(linkPath || ''));
  const st = linkStat(abs);

  if (!st.exists) {
    return { kind: 'dead', reason: '链接条目本身不存在或不可读', target: (info && info.target) || null };
  }
  if (!st.isLink) {
    return { kind: 'ok', reason: '不是链接（普通条目）', target: null, notLink: true };
  }

  const declared = (info && info.target) || '';

  /* 【先判「目标所在卷还在不在」，再判目标在不在】
   * 早期实现直接 realpathSync，失败即判 dead。这会把「移动硬盘/U 盘/网络盘
   * 没插」的链接判成「目标已不存在，可以清理」—— 用户点一下批量清理，
   * 仍然有效的链接就没了（数据没丢，但原路径打不开，而用户以为自己在清垃圾）。
   * 卷不可达是**暂时**状态，必须归 crossvol（不可清理）；
   * 只有「卷在、目标确实没了」才是 dead。
   *
   * 判卷用链接自己声明的目标路径（readlink 的结果，不需要卷在线），
   * 因为卷不在时 realpath 必然失败，拿不到 realTarget。 */
  const declaredVol = declared ? volumeRoot(path.resolve(declared)) : null;
  const selfVol = volumeRoot(abs);
  if (declaredVol && selfVol && declaredVol !== selfVol) {
    let volOk = true;
    try { fs.accessSync(declaredVol + '\\'); } catch (e) { volOk = false; }
    if (!volOk) {
      /* 卷不在：目标是否真没了无法判断，不能说它是僵尸 */
      return {
        kind: 'crossvol',
        reason: '目标所在卷（' + declaredVol + '）当前不可用（盘未接入或被卸载），暂不可判断',
        target: declared,
      };
    }
  }

  /* 目标是否为「系统关键目录」：用 path-guard 的判定，
   * 它在内部会做 realpath + 尾点归一，能挡住 junction 绕行。 */
  let realTarget = null;
  let realErr = null;
  try { realTarget = fs.realpathSync.native(abs); } catch (e) { realTarget = null; realErr = e; }

  /* 自指：解析结果就是链接自身路径 */
  if (realTarget && path.resolve(realTarget).toLowerCase() === abs.toLowerCase()) {
    return { kind: 'loop', reason: '链接指向自身', target: declared || realTarget };
  }
  /* 解析失败：区分「环」与「目标不存在」。
   * Windows 上环通常报 ELOOP / EINVAL / UNKNOWN，目标不存在报 ENOENT。 */
  if (!realTarget) {
    const code = String((realErr && realErr.code) || '');
    if (/ELOOP|EINVAL|UNKNOWN/i.test(code)) {
      return { kind: 'loop', reason: '解析路径时出现环（' + code + '）', target: declared };
    }
    /* 卷已确认在线，但目标解析不出来 —— 这才是真的僵尸。
     * 链接声明了一个跨卷目标、而那个卷现在可用：说明卷切回来了、目标确实没了。 */
    if (declaredVol && selfVol && declaredVol !== selfVol) {
      return { kind: 'dead', reason: '目标不存在（所在卷可用，但目标路径已消失）' + (code ? '（' + code + '）' : ''), target: declared };
    }
    return { kind: 'dead', reason: '目标不存在或无法访问' + (code ? '（' + code + '）' : ''), target: declared };
  }

  /* 指向系统目录 */
  if (pathGuard.isCriticalPath(realTarget)) {
    return { kind: 'system', reason: '目标位于系统关键目录内', target: realTarget };
  }

  /* 跨卷：目标盘当前是否可用。这里再兜一次 —— realTarget 能解析出来，
   * 说明卷在（Windows 上盘符不在时 realpath 会失败），所以到这一步
   * 只可能是「跨卷但可用」，按正常处理。 */
  const tv = volumeRoot(realTarget);
  const lv = volumeRoot(abs);
  if (tv && tv !== lv) {
    return { kind: 'ok', reason: '跨卷但目标可用', target: realTarget, crossVolume: true };
  }

  return { kind: 'ok', reason: '目标存在且可访问', target: realTarget };
}

module.exports = {
  LINK_KINDS,
  LinkSafetyError,
  linkStat,
  linkInfo,
  parseLinkInfo,
  assertIsLinkItself,
  removeLinkOnly,
  volumeRoot,
  sameVolume,
  isVolumeRootOnly,
  dirSize,
  classifyLink,
};
