'use strict';
/* 目录搬家（dir:move*）+ 权限与链接（acl:* / link:* / file:who-locks*）两个 IPC 域。
 *
 * 【任务 5 从 main.js 搬出，逻辑逐字搬移，未改语义】
 * 函数体与 handler 体原样来自 main.js，只把两类引用改成显式参数：
 *   1) 闭包状态（win / jobs / send / jobSeq）→ ctx（见 ipc/ctx.js）；
 *   2) main.js 的通用助手（handle / ps / runCmd / pathExists / shortErr）→ deps。
 * 其余一律仍是本文件顶部的 require，与 main.js 用的是同一批模块。
 *
 * 【为什么这两个域在同一个文件里】
 * 实测依赖图：它们共享 19 个辅助函数。dirMoveRun 直接调用 collectLinks 与
 * linkNatures；ACL 诊断用 readAclFacts；verifyCopy 用 hashFile。
 * 硬拆成 ipc/dir-move.js + ipc/acl-links.js 会让其中一半变成「必须跨模块
 * 导出才能用」，反而制造新的耦合 —— 与「降低维护成本」的目标相反。
 * 所以按真实依赖组织成一个模块。
 *
 * 【dirMoveBusy / _isAdminCache 从 main.js 的模块级变量搬到这里】
 * 这两个状态本来就只服务于这片域：
 *   · dirMoveBusy = 进程内单飞（不允许两对目录同时搬家）；
 *   · _isAdminCache = 管理员判定的三态缓存（null 未知 / true / false）。
 * 语义完全不变 —— 它们搬走之后，main.js 里已经没有任何代码读它们。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fsp = fs.promises;

const links = require('../lib/links');
const dirMove = require('../lib/dir-move');
const aclRepair = require('../lib/acl-repair');
const pathGuard = require('../lib/path-guard');
const rmLockers = require('../lib/rm-lockers');
const tempNames = require('../lib/temp-names');
const dirMoveCh = require('../lib/channels').CHANNELS;

/* PS_PATH_BATCH 留在 main.js（那边还有多处用它）。这里由 deps 传入，
 * 保证全项目只有一份定义 —— 两份的话改一处忘另一处，分块大小会不一致。 */

/**
 * 注册这两个域的 IPC handler。
 * @param {object} ctx 闭包状态，见 ipc/ctx.js
 * @param {object} deps main.js 提供的通用助手与常量
 * @param {(ch:string, fn:Function)=>void} deps.handle 统一 IPC 包装（含高危门禁与结构化错误）
 * @param {Function} deps.ps PowerShell 执行
 * @param {Function} deps.runCmd 通用命令执行
 * @param {Function} deps.pathExists 异步存在性判断
 * @param {Function} deps.shortErr 错误信息缩短
 * @param {number} deps.PS_PATH_BATCH 路径批量分块大小
 */
module.exports = function register(ctx, deps) {
  const { handle, ps, runCmd, pathExists, shortErr, PS_PATH_BATCH } = deps;
  const send = ctx.send;
  /* 任务 id 与 main.js 共用同一份计数（ctx.nextJobSeq 委托回 ++jobSeq）。 */
  function nextJobId(prefix) { return prefix + ctx.nextJobSeq(); }


/* 进程内单飞：同一时刻只允许一次搬家。原实现在 main.js 的模块作用域，
 * 搬到这里后仍是**模块作用域**（不是 register 内部）—— 否则每次 register
 * 调用都会拿到一个新变量，互斥就失效了。 */
let dirMoveBusy = false;

/* 管理员判定的三态缓存：null = 未知（查询失败），true/false = 确定结论。
 * 只有真的拿到明确的 0/1 才写缓存；查询失败保持 null 并在下次重试，
 * 因为一次瞬时失败不能让这个进程余生都自认不是管理员。 */
let _isAdminCache = null;
async function rmQueryLockers(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string' && p.trim());
  if (!list.length) throw new Error('没有要查询的路径');

  /* 先确认文件存在：Restart Manager 对不存在的路径会返回成功但空列表，
   * 那会让用户误以为「没有进程占用」，其实是路径本身错了。 */
  const missing = [];
  for (const p of list) {
    if (!(await pathExists(p))) missing.push(p);
  }
  if (missing.length === list.length) throw new Error('路径不存在：' + missing.join('、'));

  // 单引号转义（PowerShell 里 '' 表示一个字面单引号）
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  /* 无条件带上 Add-Type：每次 ps() 都是新进程，类型不会跨进程留存 */
  const addType = `Add-Type -TypeDefinition @'\n${rmLockers.FILES_CS}\n'@\n`;

  /* 【必须分块，否则深路径必然 spawn ENAMETOOLONG】
   * 早期这里把 list 全部拼成一个数组字面量。file:who-locks-dir 允许注册
   * 200 个文件（见上面 `files.length >= 200` 的上限），而 Windows 命令行
   * 上限约 32767 字符：200 个 200 字符的路径拼出来接近 4 万字符，
   * execFile 直接抛 ENAMETOOLONG，PowerShell 根本没启动 ——
   * 用户看到的是一个 spawn 错误，而不是占用列表。
   * 同一文件的 link:scan / linkNatures 早就为此做了 PS_PATH_BATCH 分块，
   * 这里保持一致；每块单独起一次 ps，结果合并。
   *
   * 【分块不能改变结论】RM 是「整批注册再取进程列表」，分块后每块各自
   * 给出该块内文件被谁占用；把各块的 lockers 按 pid+type 去重合并即可，
   * 与整批查询的语义等价（我们本来也无法把进程一一对应到具体文件）。 */
  const rows = [];
  const blockErrors = [];
  for (let i = 0; i < list.length; i += PS_PATH_BATCH) {
    const chunk = list.slice(i, i + PS_PATH_BATCH);
    const arr = chunk.map(q).join(',');
    let r;
    try {
      r = await ps(`${addType}[HeheFiles.Util]::Lockers(@(${arr}))`, 45000);
    } catch (err) {
      blockErrors.push(shortErr(err));
      continue;
    }
    const out = String(r.stdout || '');
    if (/^ERR\t/m.test(out)) {
      const parts = out.trim().split('\t');
      const code = parts[2];
      /* 某一块的 RM 失败（例如混进了目录/链接导致整批 ERR 5）不应该
       * 让整次查询作废 —— 其余块的结果仍然有效，如实记下这一块失败即可。 */
      blockErrors.push('错误码 ' + code);
      continue;
    }
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const p = line.split('\t');
      const pid = parseInt(p[0], 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      rows.push({ pid, name: p[1] || '', type: p[2] || 'app' });
    }
  }
  /* 一块都没成功、且确实有分块 → 说明查询整体不可用（不是「没有占用」）。
   * 必须抛出去，否则会被当成「查了，没占用」。 */
  if (blockErrors.length && blockErrors.length === Math.ceil(list.length / PS_PATH_BATCH) && !rows.length) {
    throw new Error('Restart Manager 查询失败（' + blockErrors.slice(0, 2).join('；') + '）');
  }

  /* 补上进程的可执行路径与启动时间，方便用户判断「这是不是我自己开的」。
   * RM 只给 PID 和名字，路径要从进程表取。取不到（已退出/无权限）就留空。
   *
   * 【一次 PowerShell 取回整批，不要每个 pid 起一次】
   * 早期这里是循环里逐个 ps()，5 个占用进程就是 5 次 powershell.exe 启动，
   * 拖到四五秒才出结果。而 RM 一次就能给出全部 pid，没有理由逐条查。
   * 现在把整批 pid 拼成一次调用的 `-Id 1,2,3`，每行回一个
   * `pid \t ProcessName \t Path \t WorkingSet`，再按 pid 合并回去。
   * 取不到的字段照旧留空，不因为某个进程没权限/已退出就中断整批。 */
  const needPath = rows.filter((r) => r.type !== 'service');
  if (needPath.length) {
    const ids = needPath.map((r) => r.pid).join(',');
    try {
      const r2 = await ps(
        `foreach($id in @(${ids})){` +
        `$p=Get-Process -Id $id -ErrorAction SilentlyContinue;` +
        `if($p){ $path=''; try{$path=$p.Path}catch{}; ` +
        `@($p.Id, $p.ProcessName, $path, [int]$p.WorkingSet64) -join "\`t" } }`,
        Math.max(8000, needPath.length * 400));
      for (const line of String(r2.stdout || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const seg = line.split('\t');
        const pid = parseInt(seg[0], 10);
        if (!Number.isFinite(pid)) continue;
        const row = rows.find((r) => r.pid === pid);
        if (!row) continue;
        if (seg[1]) row.procName = seg[1];
        if (seg[2]) row.path = seg[2];
        if (seg[3]) row.mem = parseInt(seg[3], 10) || 0;
      }
    } catch (err) { /* 整批取不到不影响主结果：pid 与名字已经有 */ }
  }

  // 按 pid 去重（同一进程可能被 RM 列多次）
  const seen = new Set();
  const uniq = [];
  for (const row of rows) {
    const k = row.pid + '|' + row.type;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(row);
  }
  return { paths: list, missing, lockers: uniq };
}

async function collectLinks(root, opts) {
  const o = opts || {};
  const maxEntries = o.maxEntries || 200000;
  const wantSize = !!o.wantSize;
  const found = [];
  let scanned = 0, truncated = false;
  /* 【wantSize：一次遍历同时给出体积与链接】
   * 搬家预检本来既要「要复制多少字节」（links.dirSize）又要「有几个链接」
   * （collectLinks），于是就同一棵树走两遍 —— 目录项读两遍、文件还各 stat 一遍。
   * 大目录上预检要等很久，而两个数的遍历规则（不跟随链接）本来就一样。
   * 需要体积时在这里顺带累加，两份数据出自同一次遍历。 */
  let bytes = 0, files = 0, dirs = 0;
  const stack = [path.resolve(root)];

  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = await fsp.readdir(cur, { withFileTypes: true }); }
    catch (err) { continue; }   // 无权限/已消失的目录跳过即可
    dirs++;

    for (const d of ents) {
      scanned++;
      if (scanned > maxEntries) { truncated = true; break; }
      const full = path.join(cur, d.name);

      /* isSymbolicLink() 对 junction 也返回 true —— 这正是我们要找的 */
      if (d.isSymbolicLink()) {
        found.push(full);
        continue;    // 关键：不进入链接，否则会把目标树当成本目录树
      }
      if (d.isDirectory()) { stack.push(full); continue; }
      if (wantSize && d.isFile()) {
        /* 与 lib/links.js 的 dirSize 同规则：链接不占本卷空间，跳过；
         * 普通文件按真实大小累加（读不到就跳过，不编数字）。 */
        try { const st = await fsp.stat(full); bytes += st.size; files++; } catch (err) {}
      }
    }
    if (truncated) break;
  }
  return { links: found, scanned, truncated, bytes, files, dirs };
}

function relKey(root, full) {
  const r = path.resolve(root);
  const f = path.resolve(full);
  return path.relative(r, f).split(path.sep).join('/');
}

function buildLinkKeySet(root, linkList) {
  const set = new Set();
  for (const l of linkList) set.add(relKey(root, l).toLowerCase());
  return set;
}

async function copyTreeExcludingLinks(srcAbs, dstAbs, linkList) {
  const skip = buildLinkKeySet(srcAbs, linkList);
  /* 【复制期间源条目消失不是"搬家失败"】
   * 源目录往往是活的：用户一边搬一边在往里写日志、删临时文件，
   * 或者别的程序在清理缓存。readdir 拿到了目录项，等到 copyFile 时
   * 那个文件可能已经不在了 —— 抛 ENOENT。
   * 早期这里没有兜底，一个 ENOENT 就让整次搬家中止并回滚：
   * 大目录搬了半小时，因为一个被删掉的临时文件全白费，
   * 而报错是裸的「ENOENT: no such file or directory, copyfile ...」。
   * 现在的口径：
   *   · ENOENT（源条目已消失）→ 跳过并计数，最后如实告诉用户跳了几个；
   *   · EBUSY/EPERM/EACCES（真被占用/没权限）→ 仍然抛出，因为这必须
   *     让用户去处理（关闭程序/提权），静默跳过会得到一份悄悄变少的副本。
   */
  /* 【消失的条目要按类型分开计数】
   * 早期把文件与目录都算进一个 skippedDisappeared，界面文案却统一写成
   * 「N 个文件在复制期间从源目录消失」—— 一个目录被删掉时这句话是错的，
   * 而且用户会去数文件，数不出来。所以文件与目录各记一份，界面按两者组合说话。 */
  const stats = {
    files: 0, dirs: 0,
    skippedFiles: 0, skippedDirs: 0,
    disappeared: [],
  };
  const noteGone = (rel, kind) => {
    if (kind === 'dir') stats.skippedDirs++;
    else stats.skippedFiles++;
    if (stats.disappeared.length < 20) stats.disappeared.push(rel);
  };
  /** 兼容汇总：两个计数之和（调用方与界面按这个判断「要不要提示」）。 */
  const totalGone = () => stats.skippedFiles + stats.skippedDirs;

  async function walk(relPosix) {
    const srcDir = relPosix ? path.join(srcAbs, ...relPosix.split('/')) : srcAbs;
    const dstDir = relPosix ? path.join(dstAbs, ...relPosix.split('/')) : dstAbs;
    await fsp.mkdir(dstDir, { recursive: true });

    let ents;
    try { ents = await fsp.readdir(srcDir, { withFileTypes: true }); }
    catch (err) { throw new Error('读取目录失败（' + srcDir + '）：' + err.message); }

    for (const ent of ents) {
      const childRel = relPosix ? relPosix + '/' + ent.name : ent.name;
      const srcChild = path.join(srcDir, ent.name);
      const dstChild = path.join(dstDir, ent.name);

      if (skip.has(childRel.toLowerCase())) continue;  // 链接：跳过，稍后重建
      if (ent.isSymbolicLink()) continue;               // 兜底：任何漏网的链接

      if (ent.isDirectory()) {
        try {
          await walk(childRel);
          stats.dirs++;
        } catch (err) {
          /* 子目录整个消失（被删了）也算「复制期间消失」，不当致命错。
           * walk 内部把 readdir 失败包装成了可读文案（不再带 err.code），
           * 所以这里靠原文里是否含 ENOENT 来判定；其它读取失败照旧上抛。
           *
           * 【必须把刚才建出来的空目录删掉】
           * walk(childRel) 第一件事就是 fsp.mkdir(dstDir, { recursive: true })，
           * 之后才 readdir —— 也就是说目录不存在这件事是**readdir 时**才发现的，
           * 那时目标侧的空目录已经建好了。不删的话目标树里就多一个源里没有的
           * 空目录，而 verifyCopy 只从**源侧**往目标侧对，永远发现不了它。
           * 安全性：只删「刚由 walk 创建、且确认为空」的目录 —— 先 readdir 确认
           * 为空，再用 rm 且不开 recursive，绝不递归删掉可能存在的别的东西。 */
          const msg = (err && err.message) || '';
          if (err && (err.code === 'ENOENT' || /ENOENT/.test(msg))) {
            noteGone(childRel, 'dir');
            const dstDirGone = path.join(dstDir, ent.name);
            try {
              const left = await fsp.readdir(dstDirGone);
              if (left.length === 0) await fsp.rm(dstDirGone, { force: true });
            } catch (e2) { /* 已经不在/没权限：不影响搬运，忽略即可 */ }
          } else throw err;
        }
      } else if (ent.isFile()) {
        try {
          await fsp.copyFile(srcChild, dstChild);
          stats.files++;
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            /* 源文件在 readdir 之后、copyFile 之前被删掉了 —— 跳过它继续搬，
             * 最后把「跳了几个」如实告诉用户（静默跳过等于悄悄少拷文件）。*/
            noteGone(childRel, 'file');
            /* 目标侧可能有这次 copy 留下的半成品，清掉以免校验阶段对不上 */
            try { await fsp.unlink(dstChild); } catch (e) {}
          } else if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
            /* 真被占用/没权限：必须让用户处理，不能静默跳过 ——
             * 否则用户拿到一份"成功"但少了文件的副本。换成能看懂的文案。 */
            const why = err.code === 'EBUSY' ? '文件正被其它程序占用'
              : (err.code === 'EACCES' ? '没有读取权限' : '没有权限或被安全软件拦截');
            const e2 = new Error('复制失败（' + childRel + '）：' + why +
              '。请关闭占用它的程序（或检查权限）后重试；本次搬家已回滚，源目录未受影响。');
            e2.cause = err;
            throw e2;
          } else throw err;
        }
      }
      /* 其它类型（设备/管道等）在普通目录里不常见，跳过即可 */
    }
  }

  await walk('');
  /* 对外的返回结构保持一个总数（调用方与 emit 都用它），
   * 但也把分类计数带回去，界面可以用更准确的说法。 */
  return Object.assign({}, stats, { skippedDisappeared: totalGone() });
}

async function restoreLinksIntoTarget(srcAbs, dstAbs, linkList, natures) {
  const nat = natures || new Map();
  const created = { count: 0, failed: [], fileLinks: 0, innerRewritten: 0, srcReadableLinks: [] };
  for (const l of linkList) {
    const rel = relKey(srcAbs, l);
    try {
      /* 【目标落在源目录树内部时必须改写】
       * 搬家第 3 步把源目录改名成 .hehe-bak、第 6 步删掉它。所以任何
       * 「目标在源树内部」的链接（指向源自身、源内子目录、源内兄弟目录）
       * 如果照抄旧的绝对目标，重建出来的链接指向的是一个**马上就会消失**
       * 的路径 —— 搬家全程不报错、界面说「搬家完成」，目标侧那个链接却是死的。
       * 这类链接的正确目标是「新位置里的对应路径」：src\sub → dst\sub。
       * 目标在源树之外的（别的盘、别的目录）才保持原样。 */
      let absTarget = linkTargetAbs(l);
      if (isInsideTree(absTarget, srcAbs)) {
        /* 【相对路径必须用**归一后**的两端算】
         * 只把 isInsideTree 改成归一比较还不够：这里若拿原始字面量算
         * path.relative，8.3 短名的目标（...\VERYLO~1\sub）会算成
         * '..\VERYLO~1\sub'，path.join 出来的是一条指回旧位置的怪路径 ——
         * 链接建得成功、源一改名就成死链（实测：readlink 仍是短名旧路径）。
         * 两端都过 normalizeForComparePath，relative 才知道它们同源。 */
        const srcNorm = normalizeForComparePath(srcAbs);
        const tgtNorm = normalizeForComparePath(absTarget);
        absTarget = path.join(dstAbs, path.relative(srcNorm, tgtNorm));
        created.innerRewritten++;
      }
      const dstChild = path.join(dstAbs, ...rel.split('/'));
      await fsp.mkdir(path.dirname(dstChild), { recursive: true });
      /* 【目标侧同名项要按类型清，清不掉必须记账】
       * 原写法是 `try { fs.unlinkSync(dstChild); } catch (e) { 空 catch }`：
       *   · unlinkSync 只能删文件/链接，同名项是**目录**时必然 EPERM/EISDIR，
       *     然后被空 catch 吃掉 —— 接着 symlink 撞上已存在的目录而失败，
       *     报出来的错是「重建链接失败」+ 一句跟真正原因无关的 EEXIST；
       *   · 真要删时用同步调用阻塞主进程（这里已经在 async 函数里）。
       * 现在先 lstat 判类型再删，仍失败就把可读原因 push 进 failed，
       * 让上层能如实说出「目标侧已有同名项且清不掉」，而不是吞掉。
       * 理论上这个分支不该走到（目标目录树是我们刚建的），但
       * 「刚建好的树」和「此刻磁盘上的树」可能被第三方改过，不能假设。 */
      if (await pathExists(dstChild)) {
        try {
          const st = fs.lstatSync(dstChild);
          if (st.isDirectory() && !st.isSymbolicLink()) {
            /* junction / 目录链接在 Windows 上 lstat 也报 directory，
             * 但带 reparse 标记；用 rmSync 递归删对两者都安全
             * （它删的是这个条目本身，不会跟着链接进去删目标）。 */
            fs.rmSync(dstChild, { recursive: true, force: true });
          } else {
            fs.unlinkSync(dstChild);
          }
        } catch (e) {
          /* 不吞：这里失败就等于后面的 symlink 注定失败，
           * 早一点把真正的原因（清不掉同名项）说出来。 */
          throw new Error('目标侧已有同名项且无法清除（' + dstChild + '）：' + ((e && e.message) || e));
        }
      }
      /* 源侧这个链接本来是活的吗？两个用途：
       *   1) 建完自检（见下）只对活的做要求；
       *   2) 把「源侧可读」的链接收集起来回传给调用方 —— 源目录改名之后，
       *      这些链接在目标侧也必须可读（那时才看得出「照抄旧路径」的坏链）。
       *
       * 【判据必须是 stat，不能用 access/readdir 组合】
       * 实测（本机）：一个目标已被删的悬空 junction，
       *   lstat → ok   access → ok   readdir → ENOENT   stat → ENOENT
       * access 判的是「这个**条目**能不能访问」，悬空链接的条目当然在，
       * 于是它一路返回成功 —— 拿它当「活得成」的判据会把悬空链接当成活的。
       * stat 会跟随链接、目标不在就抛 ENOENT，这才是「能不能读到东西」。
       * readdir 也能判，但它对**文件**链接无效（不是目录），
       * 所以统一用 stat。 */
      const isLive = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };
      const srcReadable = isLive(l);
      if (srcReadable) created.srcReadableLinks.push(l);
      const kind = nat.get(l.toLowerCase()) || linkNature(l);
      if (kind === 'dir') {
        await fsp.symlink(absTarget, dstChild, 'junction');
      } else if (kind === 'file') {
        /* 文件符号链接：不加类型参数（Node 默认按 file 语义创建）。
         * 需要 SeCreateSymbolicLinkPrivilege，失败会被下面的 catch 记入 failed。 */
        await fsp.symlink(absTarget, dstChild);
        created.fileLinks++;
      } else {
        /* 连「目录还是文件」都判不出来：宁可不建，也不造一个坏链接。
         * junction 与符号链接在目标类型上不通用，猜错的代价是
         * 「搬家成功但链接打不开」这种最难排查的形态。 */
        throw new Error('无法判断这个链接指向目录还是文件，拒绝重建（避免造出打不开的链接）');
      }
      /* 【建完当场验一次：源侧可读的，目标侧也必须可读】
       * 这一层抓的是「链接建出来了，但它指向的东西此刻就不存在」——
       * 典型是目标盘的对应目录没被复制过去，或者目标路径拼错。
       * 这类失败很隐蔽：symlink 调用本身会成功（Windows 允许悬空 junction），
       * 不做自检的话 created 会 +1，一路「成功」到界面上。
       *
       * 【它抓不到「内部链接照抄旧路径」那个 bug，说清楚免得误以为有保险】
       * 那种情况下，链接目标此刻（源目录还没改名）完全有效，readdir 会成功；
       * 链接是等到第 3 步源目录改名 .hehe-bak 之后才变死的。
       * 那个 bug 由**目标改写**（上面的 isInsideTree 分支）解决，
       * 不是靠这里兜住的 —— 真正的兜底是最后 verifyLinkReadable 之后
       * 对目标侧整树链接的抽查（那时源已经改名，坏链会露出来）。
       *
       * 只对源侧本来可读的链接做要求：源侧本来就悬空的，重建出来悬空是
       * 「保持现状」，不该判失败。 */
      if (srcReadable && !isLive(dstChild)) {
        throw new Error('重建后的链接打不开（源侧是可读的）：' + dstChild);
      }
      created.count++;
    } catch (err) {
      created.failed.push({ link: l, error: err.message });
    }
  }
  return {
    created: created.count, failed: created.failed, fileLinks: created.fileLinks,
    innerRewritten: created.innerRewritten, srcReadableLinks: created.srcReadableLinks,
  };
}

function linkTargetAbs(linkPath) {
  const raw = String(fs.readlinkSync(linkPath));
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(path.dirname(linkPath), raw);
}

function normalizeForComparePath(p) {
  let abs;
  try { abs = path.resolve(String(p || '')); } catch (e) { return String(p || ''); }
  try {
    return fs.realpathSync.native(abs);
  } catch (e) {
    /* 目标本身不存在时，至少把**父目录**解析掉：
     * C:\...\VERYLO~1\sub（sub 还不存在）也能归一到长名形态。
     * 这是重建链接时最常见的状态 —— 目标此刻可能还没被复制过去。 */
    try {
      const dir = path.dirname(abs);
      const base = path.basename(abs);
      return path.join(fs.realpathSync.native(dir), base);
    } catch (e2) { return abs; }
  }
}

function isInsideTree(absPath, rootAbs) {
  const rel = path.relative(normalizeForComparePath(rootAbs), normalizeForComparePath(absPath));
  if (!rel) return true;                                  // 就是源目录自身
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function collectLockProbe(dir) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (err) { return { files: [], error: '读取目录失败：' + err.message }; }
  const files = [];
  for (const ent of ents) {
    if (files.length >= 64) break;   // 只看前 64 个普通文件，够覆盖常见情形
    if (!ent.isFile()) continue;     // 目录/链接一律不注册（会让整批失败）
    files.push(path.join(dir, ent.name));
  }
  return { files, error: null };
}

function linkNature(p) {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() ? 'dir' : 'file';
  } catch (err) { return 'unknown'; }
}

async function linkNatures(list) {
  const out = new Map();
  const unknown = [];
  for (const l of list) {
    const n = linkNature(l);
    if (n === 'unknown') unknown.push(l);
    else out.set(l.toLowerCase(), n);
  }
  if (!unknown.length) return { natures: out, error: null };

  /* 【分批查 + 如实上报失败】
   * 早期这里把全部路径拼成一条命令、并用一个空 catch 吞掉所有异常：
   *   - 路径一多就 spawn ENAMETOOLONG（命令行超限），整趟查询根本没跑；
   *   - 失败与「个别链接查不到」被抹成同一个状态，调用方无从区分，
   *     而「查不到性质」会让重建直接拒绝 —— 于是源目录里链接一多，
   *     这个目录就永远搬不动，界面只说「无法判断这个链接指向目录还是文件」。
   * 现在按 PS_PATH_BATCH 分批，失败的批次记进 error 由调用方展示。 */
  const errors = [];
  for (let i = 0; i < unknown.length; i += PS_PATH_BATCH) {
    const chunk = unknown.slice(i, i + PS_PATH_BATCH);
    try {
      const q = (x) => "'" + String(x).replace(/'/g, "''") + "'";
      const arr = chunk.map(q).join(',');
      const r = await ps(
        /* 结尾的 exit 0：悬空链接会让 PowerShell 返回非零，而那是正常状态
         * （搬到别处的目录里本来就可能留着指向已消失目标的链接）。 */
        `Get-Item -LiteralPath @(${arr}) -Force -ErrorAction SilentlyContinue | ` +
        `ForEach-Object { @($_.FullName, ('' + $_.Attributes)) -join [char]9 }; exit 0`,
        Math.max(15000, chunk.length * 300));
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const seg = line.split('\t');
        if (seg.length < 2) continue;
        const attrs = seg.slice(1).join('\t').trim();
        /* 【Attributes 读不到时不能猜成 'file'】
         * 原实现是 `(/Directory/i.test(attrs) ? 'dir' : 'file')` —— 空串走 else，
         * 于是「读不到」被当成「它是文件」。
         * 实测差异（本机 vs GitHub windows-latest runner）：
         *   本机：悬空 junction 的 Attributes 含 Directory，判出 'dir'（正确）
         *   CI：  同一操作 Attributes 返回空串，被判成 'file'
         * 后果不是「显示不对」，而是**重建走错分支**：文件链接要用
         * fsp.symlink(absTarget, dstChild)（需要 SeCreateSymbolicLinkPrivilege），
         * 非管理员下必然 EPERM，整个搬家中止并回滚 —— 一台机器能不能搬成功，
         * 竟然取决于 PowerShell 能否读到那个 Attributes。
         * 判不出来就不该登记：让调用方显式看到「性质未知」，由
         * restoreLinksIntoTarget 的 unknown 分支拒绝重建并如实报错，
         * 而不是偷偷按文件处理。 */
        if (!attrs) continue;
        out.set(seg[0].trim().toLowerCase(), /Directory/i.test(attrs) ? 'dir' : 'file');
      }
    } catch (err) {
      errors.push(shortErr(err));
    }
  }
  return {
    natures: out,
    /* 部分批次失败时也带上：调用方要能说清「这不代表没有文件链接」 */
    error: errors.length ? (errors.length + ' 批链接性质查询失败：' + errors.slice(0, 2).join('；')) : null,
  };
}

async function dirMoveRun({ src, dst, jobId: clientJob } = {}) {
  const id = clientJob || nextJobId('dirmv');
  const srcAbs = path.resolve(String(src || ''));
  const dstAbs = path.resolve(String(dst || ''));

  const emit = (stage, extra) => {
    try { send('job:stream', { id, data: JSON.stringify(Object.assign({ stage }, extra || {})) }); } catch (err) {}
  };

  /* 源侧可读的链接清单（复制阶段填，第 5 步用来抽查目标侧）。
   * 提到函数作用域是因为它跨越「复制」和「验证链接」两个阶段。 */
  let innerLinkCheckList = [];

  /* 【目标目录的所有权标记】
   * 只有当我们确认「目标原本不存在，是我们复制出来的」之后，才允许在失败时
   * 回滚删除它。没有这个标记，任何在「目标已存在」处抛出的错误都会被
   * catch 里的回滚当成「删掉半成品」，把用户原有目录递归删光。
   * 两个阶段（复制 / 校验 / 改名）的失败回滚都必须过这一层。 */
  let dstOwned = false;
  const rollbackDst = async () => {
    if (!dstOwned) return;      // 不是我们建的，绝不删
    dstOwned = false;
    try { await fsp.rm(dstAbs, { recursive: true, force: true }); } catch (e2) {}
  };

  // 前置校验必须在主进程重做一遍：渲染层的历史结论不能当授权依据。
  // 直接复用 dirMove.validateMove（不通过 IPC 回调另一个 handler，
  // 那样会依赖 ipcMain 的内部结构，也没必要）。
  {
    const sst = await fsp.stat(srcAbs).catch(() => null);
    const lst = links.linkStat(srcAbs);
    const dstExists = await pathExists(dstAbs);
    let freeBytes = null;
    try {
      if (typeof fs.statfsSync === 'function') {
        const sf = fs.statfsSync(path.parse(dstAbs).root || dstAbs);
        freeBytes = sf.bavail * sf.bsize;
      }
    } catch (err) {}
    let needBytes = 0;
    if (sst && sst.isDirectory() && !lst.isLink) {
      try { needBytes = (await links.dirSize(srcAbs)).bytes; } catch (err) {}
    }
    /* 【执行阶段也要真的查一次占用，不能恒传空数组】
     * 早期这里写死 lockedPaths: []，等于预检的占用结论和执行现实完全脱节：
     * 预检说「可以搬」，执行时 fsp.cp 撞到被占用文件才失败，白拷一遍再删掉。
     * 但**不能**改成「必须无占用才允许执行」—— 占用可能在这几秒内消失，
     * 那样会把本来能成功的搬家拒掉。所以这里只做「再核一次」：
     * 有占用就带着 lockedPaths 进 validateMove，由它按原有规则给出 LOCKED 结论
     * （提示先关闭占用它的程序），行为和预检一致，用户不会看到两套说法。 */
    let lockedPaths = [];
    if (sst && sst.isDirectory() && !lst.isLink) {
      const probe = await collectLockProbe(srcAbs);
      if (!probe.error && probe.files.length) {
        try {
          const lr = await rmQueryLockers(probe.files);
          if (lr && lr.lockers && lr.lockers.length) {
            lockedPaths = lr.lockers.map((x) => (x.pid || 0) + ':' + (x.name || x.procName || ''));
          }
        } catch (err) {
          /* 执行阶段查询失败不阻断搬家：占用本来就可能在几秒内消失，
           * 这里再查只是「再核一次」。失败就当作没查到，但仍要如实记下来，
           * 由下面 emit 出去，别让用户以为「已确认无占用」。 */
          emit('check', { ok: true, lockCheckError: err.message });
        }
      }
    }
    const v = dirMove.validateMove({
      src: srcAbs, dst: dstAbs,
      srcExists: !!sst, srcIsDir: !!sst && sst.isDirectory(),
      srcIsLink: lst.isLink, srcIsRoot: links.isVolumeRootOnly(srcAbs),
      /* 与预检用同一判据（isProtectedForModify），保证两阶段说法一致。
       * 原因也要带上：SRC_CRITICAL 的笼统文案对用户没有指导意义。 */
      srcIsCritical: pathGuard.isProtectedForModify(srcAbs).protected,
      srcProtectedReason: pathGuard.isProtectedForModify(srcAbs).reason || '',
      srcProtectedKind: pathGuard.isProtectedForModify(srcAbs).kind || '',
      dstExists, needBytes, freeBytes, lockedPaths,
      allowSameVolume: false,
      bakExists: await pathExists(tempNames.dirmoveBak(srcAbs)),
      bakPath: tempNames.dirmoveBak(srcAbs),
      /* 目标闸门在执行阶段**必须重算**：渲染层的历史结论不能当授权依据 */
      dstProtected: pathGuard.isProtectedForModify(dstAbs).protected,
      dstProtectedReason: pathGuard.isProtectedForModify(dstAbs).reason || '',
    });
    if (!v.ok) {
      emit('check', { ok: false, error: v.reason });
      throw new Error(v.reason);
    }
  }

  const bakPath = tempNames.dirmoveBak(srcAbs);
  /* 【这个局部变量叫 moveCtx，不叫 ctx】
   * 它只是把这次搬家的四个路径打包起来，**没有任何代码读它**
   * （原来的压制注释写的是 no-unused-vars，但搬到这里之后它同时触发了
   * no-shadow —— 因为外层 register(ctx, deps) 的形参也叫 ctx）。
   * 与其同时挂两条压制，不如改个名：no-shadow 立刻消失，读代码的人也不必
   * 再去分辨「哪个 ctx」。
   *
   * 【为什么不直接删掉】它赋值的四个值都由上面的代码算好、并且在别处使用，
   * 这个对象本身是历史遗留的"准备好了但没用上"的打包。按本轮「只搬代码、
   * 不改语义」的口径，不删 —— 删它属于清理，应该单独一轮做，
   * 而且 no-unused-vars 的压制登记也说明它被有意保留。 */
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
  const moveCtx = { srcPath: srcAbs, dstPath: dstAbs, bakPath, linkPath: srcAbs };
  emit('check', { ok: true });

  /* 【cpStats 必须在两个 try 之外声明】
  * 它在「1) 复制」的 try 里被赋值，却要在「2) 校验」的 try 里读取
  * （合并两阶段的"消失"计数）。写在第一个 try 内的话，第二个 try
  * 根本访问不到它 —— 正是 js/app.js 里 finally 读 try 内 let 那类
  * 块级作用域错误（那里每次必抛 ReferenceError）。这里提前声明。 */
  let cpStats = null;

  /* ---------- 1) 复制到目标 ---------- */
  try {
    emit('copy', { ok: null, started: true });
    /* 【不要先 mkdir，也不要用 errorOnExist】
     * 实测（本机 Node 24 / Windows）：fsp.cp 的目标**已存在**且
     * errorOnExist:true 时，不是抛异常，而是让 Node 进程直接崩溃
     * （退出码 127，无任何 JS 栈）。先 mkdir 再 cp 正好制造这个组合。
     *
     * 所以：目标存在性由我们自己先判（上面的 validateMove 已经查过 dstExists，
     * 这里再兜一次，防并发），cp 只负责「往不存在的路径写」。
     * 去掉 errorOnExist 后，目标若意外存在会被 cp 合并写入 ——
     * 但那已经被前置的 EEXIST 检查挡住了，不会走到这里。 */
    /* 【这道防覆盖检查必须在「标记已创建」之前，且不能进回滚范围】
     * 原来它就写在这个 try 的第一行：预检通过后、执行前若目标路径上冒出了
     * 东西（用户在预检后自己建了 D:\backup\photos，或两个请求抢同一个 dst），
     * 这里抛异常 → 立刻被同一 try 的 catch 接住 → catch 第一件事是
     *   fsp.rm(dstAbs, { recursive: true, force: true })
     * 于是「为避免覆盖已拒绝」变成了「把那个已存在的目录整个删掉」，
     * 用户目标侧的数据当场消失，报错还写着「源目录未受影响」。
     * 现在用 dstOwned 记录「这个目标是我们自己建的」，只有它为 true 才回滚删除。 */
    if (await pathExists(dstAbs)) {
      throw new Error('目标位置已存在，为避免覆盖已拒绝：' + dstAbs);
    }
    dstOwned = true;   // 从这里往下，dstAbs 才可能是我们创建的

    /* 【必须先找出源目录树里的链接，复制时把它们排除掉】
     * fs.cp 对 reparse point 默认按符号链接处理，要调用 symlink() 重建，
     * 而 Windows 创建**符号链接**需要 SeCreateSymbolicLinkPrivilege。
     * 实测（非管理员）：源目录含一个 junction 时 fsp.cp 直接抛
     *   EPERM: operation not permitted, symlink ...
     * 加 verbatimSymlinks: true 同样 EPERM；只有 dereference: true 能过，
     * 但那会把链接目标的内容整个复制进来 —— 语义错误（多出副本，
     * 目标在别的盘时还会失败）。
     *
     * 所以分两步：先把「除链接之外」的内容复制过去（链接一概不参与），
     * 再按相对路径在目标侧用 fs.symlinkSync(target, dest, 'junction') 重建
     * —— junction 类型不需要那个特权。
     */
    const treeLinks = await collectLinks(srcAbs);
    cpStats = await copyTreeExcludingLinks(srcAbs, dstAbs, treeLinks.links);
    /* 链接不在 cp 的范围里了，所以 cp 不会再碰 symlink()，EPERM 消失。
     * 重建前先判定每个链接指向目录还是文件 —— 目录用 junction（免特权），
     * 文件用符号链接（用 junction 会造出打不开的坏链接且不报错）。 */
    const ln = await linkNatures(treeLinks.links);
    /* 性质查询失败不阻断搬家（受限的都是「重建时会不会被判成性质不明」），
     * 但必须报出来：否则用户只会看到「无法判断这个链接指向目录还是文件」。 */
    if (ln.error) emit('check', { ok: true, linkNaturesError: ln.error });
    const linkRestore = await restoreLinksIntoTarget(srcAbs, dstAbs, treeLinks.links, ln.natures);
    /* 留给第 5 步：源改名之后要按这份清单抽查目标侧的链接 */
    innerLinkCheckList = linkRestore.srcReadableLinks || [];
    /* 【重建失败必须报出来，不能静默】
     * 若某个链接没建起来，目标侧就少一个条目，而源侧还有 ——
     * 这会让「校验」步骤觉得文件对不上，也可能让用户以为搬家成功但
     * 实际少了东西。所以这里直接失败并回退，而不是记一笔继续走。 */
    if (linkRestore.failed && linkRestore.failed.length) {
      const first = linkRestore.failed[0];
      throw new Error('目标侧重建链接失败（' + linkRestore.failed.length + ' 个）：' +
        path.basename(first.link) + ' —— ' + first.error);
    }
    emit('copy', { ok: true, links: treeLinks.links.length, fileLinks: linkRestore.fileLinks,
      innerRewritten: linkRestore.innerRewritten,
      files: cpStats.files, dirs: cpStats.dirs,
      /* 【跳过的条目数必须如实报出去】
       * 静默跳过等于让用户拿到一份悄悄变少了的副本，而且事后对不上数
       * （源侧还在、目标侧少了）会让人以为是搬家本身坏了。
       * 只说个数和一个样例，不把几十条路径全塞进提示。
       * 文件与目录分开给：一个目录被删掉时，说成「N 个文件消失」是错的。 */
      skippedDisappeared: cpStats.skippedDisappeared,
      skippedFiles: cpStats.skippedFiles, skippedDirs: cpStats.skippedDirs,
      skippedExamples: cpStats.disappeared });
  } catch (err) {
    // 源完好，只需要删掉拷了一半的目标（且只在目标确实是本进程创建时才删）
    await rollbackDst();
    emit('copy', { ok: false, error: err.message });
    throw new Error('复制失败（源目录未受影响）：' + err.message);
  }

  /* ---------- 2) 逐文件校验：大小 + 抽样哈希 ----------
   * 【为什么不能只比字节数】复制工具/文件系统可能截断或粘贴出等长的坏块，
   * 大小相同但内容不同是真实存在的（尤其跨盘 + 压缩/加密卷）。
   * 全量哈希对大目录太慢，所以：**每个文件都比大小**，
   * 再对其中若干文件（按大小排序取头尾 + 随机）做 SHA-256 抽样。 */
  try {
    emit('verify', { ok: null, started: true });
    const vr = await verifyCopy(srcAbs, dstAbs);
    if (!vr.ok) throw new Error(vr.reason);
    /* 【复制阶段与校验阶段「消失」的数字必须合并显示，不能出现两套】
     * 两个阶段都可能遇到源条目被删：复制时 catcher 记一份、校验时又记一份。
     * 如果各报各的，用户会看到「跳过 2 个」然后「跳过 3 个」，不知道哪个算数。
     * 这里把校验阶段的增量加上去，一次性报总数（UI 只认这一处）。
     * 注意 cpStats 与 vr 统计的都是**不同**条目（校验阶段多出来的是
     * "复制完之后才被删"的那批），相加不会重复计数。 */
    const goneFiles = ((cpStats && cpStats.skippedFiles) || 0) + (vr.skippedFiles || 0);
    const goneDirs = ((cpStats && cpStats.skippedDirs) || 0) + (vr.skippedDirs || 0);
    emit('verify', {
      ok: true, files: vr.files, hashed: vr.hashed, bytes: vr.bytes,
      skippedFiles: goneFiles, skippedDirs: goneDirs,
      skippedDisappeared: goneFiles + goneDirs,
      skippedExamples: ((cpStats && cpStats.disappeared) || []).concat(vr.skippedList || []).slice(0, 20),
    });
  } catch (err) {
    await rollbackDst();
    emit('verify', { ok: false, error: err.message });
    throw new Error('校验失败（已删除目标副本，源目录未受影响）：' + err.message);
  }

  /* ---------- 3) 源改名为 .bak ---------- */
  try {
    emit('rename', { ok: null, started: true });
    await fsp.rename(srcAbs, bakPath);
    emit('rename', { ok: true });
  } catch (err) {
    await rollbackDst();
    emit('rename', { ok: false, error: err.message });
    throw new Error('源目录改名失败（已删除目标副本，源目录未变）：' + err.message);
  }

  /* ---------- 4) 在原位置建目录联接 ----------
   * 从这一刻起进入「危险中间态」：原路径是空的。任何失败都必须
   * 先把 .bak 改回原名。 */
  try {
    emit('link', { ok: null, started: true });
    /* 【不用 cmd /c mklink】那条命令要把路径拼进 PowerShell 字符串，
     * 双引号内的 $ 会被当变量/子表达式展开、反引号会被当转义符 ——
     * 而 Windows 允许目录名含这两个字符。一个叫 $(...) 的目录会被执行，
     * 既是功能失效也是注入风险。
     * 这里直接用 Node 原生 API，路径作为**参数**传递，不经过任何 shell 解析。
     * 注意参数顺序是 (target, path)：symlink 先给目标，再给链接自身位置。
     * junction 类型不需要管理员权限。 */
    await fsp.symlink(dstAbs, srcAbs, 'junction');
    // 建完再确认一次：API 返回成功但链接没出现的情况也要当失败处理
    if (!(await pathExists(srcAbs))) throw new Error('创建目录联接后路径仍不存在：' + srcAbs);
    emit('link', { ok: true });
  } catch (err) {
    // 关键回退：先保证原路径能打开东西
    const back = await restoreBak(bakPath, srcAbs);
    emit('link', { ok: false, error: err.message, restored: back.ok });
    throw new Error(
      '建链接失败' + (back.ok
        ? '（已把源目录改回原名，原路径可正常打开，数据未丢）'
        : '（且回退失败：原始数据完整保存在 ' + bakPath + '，请手动把它改名为 ' + srcAbs + '）') +
      '：' + err.message);
  }

  /* ---------- 5) 验证链接真的可读 ----------
   * 建了链接不代表链接是好的：要真的读一遍其中的文件。
   *
   * 【这里才是「树内部的链接」真正的兜底】
   * 到这一步源目录已经改名成 .hehe-bak，所以任何「照抄旧绝对路径」
   * 重建出来的链接此刻都是死的 —— 而 verifyLinkReadable 只看顶层那个链接，
   * 树内部的坏链它一个都看不到（那正是问题 1 能一路「搬家完成」的原因）。
   * 所以再抽验一遍**目标树里的链接**：源侧可读的，搬到目标侧后也必须可读。
   * 这一步排在源改名之后，才具有判据意义。 */
  try {
    emit('linkcheck', { ok: null, started: true });
    const r = await verifyLinkReadable(srcAbs, dstAbs);
    if (!r.ok) throw new Error(r.reason);
    const inner = await verifyInnerLinksReadable(dstAbs, srcAbs, innerLinkCheckList);
    if (!inner.ok) throw new Error(inner.reason);
    emit('linkcheck', { ok: true, sampled: r.sampled, innerSampled: inner.sampled });
  } catch (err) {
    /* 回退：先拆链接（必须用「只删链接」的安全入口），再把 .bak 改回原名 */
    let linkRemoved = false;
    try { await links.removeLinkOnly(srcAbs); linkRemoved = true; } catch (e2) {}
    const back = await restoreBak(bakPath, srcAbs);
    emit('linkcheck', { ok: false, error: err.message, linkRemoved, restored: back.ok });
    throw new Error(
      '链接验证未通过' + (back.ok
        ? '（已拆除链接并把源目录改回原名，原路径可正常打开）'
        : '（且回退失败：数据完整保存在 ' + bakPath + '，请手动改名为 ' + srcAbs + '）') +
      '：' + err.message);
  }

  /* ---------- 6) 最后才删 .bak ---------- */
  let dropped = false;
  try {
    emit('dropbak', { ok: null, started: true });
    await fsp.rm(bakPath, { recursive: true, force: true });
    dropped = true;
    emit('dropbak', { ok: true });
  } catch (err) {
    // 删不掉备份不影响可用性，只是多占空间，如实提示即可
    emit('dropbak', { ok: false, error: err.message });
  }

  emit('done', { ok: true });
  return {
    ok: true, src: srcAbs, dst: dstAbs, bakRemoved: dropped,
    advice: '搬家完成：原路径现在是指向新位置的目录联接，打开它看到的就是新位置的内容。' +
      (dropped ? '备份已清理。' : '（备份 .bak 未能删除，可在确认无误后手动删除）'),
  };
}

async function isRunningAsAdmin() {
  if (_isAdminCache != null) return _isAdminCache;
  try {
    const r = await ps(`$id=[Security.Principal.WindowsIdentity]::GetCurrent();` +
      `$p=New-Object Security.Principal.WindowsPrincipal($id);` +
      `if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){'1'}else{'0'}`, 15000);
    const v = String(r.stdout || '').trim();
    if (v === '1' || v === '0') { _isAdminCache = (v === '1'); return _isAdminCache; }
    return null;   // 输出不是预期的 0/1：当作未知，不缓存
  } catch (err) { return null; }
}

async function readAclFacts(target) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const out = { owner: null, ownerIsMe: null, acl: null, aclRaw: null, me: null };

  /* 第一步：当前用户名。取不到就留 null —— parseIcacls 在 userName 缺失时
   * 不猜测归属（entry.mine 全部为 false，hasFull 保持 false），
   * 而 diagnose 会把「找不到我那条 ACE」当作「无法确定」处理，不会误判为正常。 */
  try {
    const r = await ps(`[Security.Principal.WindowsIdentity]::GetCurrent().Name`, 10000);
    const me = String(r.stdout || '').trim();
    if (me) out.me = me;
  } catch (err) { out.me = null; }

  try {
    const r = await ps(`(Get-Acl -LiteralPath ${q(target)}).Owner`, 15000);
    const owner = String(r.stdout || '').trim();
    if (owner) out.owner = owner;
  } catch (err) { /* 取不到就留 null */ }

  try {
    const r = await ps(`icacls ${q(target)}`, 15000);
    out.aclRaw = String(r.stdout || '');
    /* 把 me 传进去：这是 hasFull / deniedForMe 能正确工作的前提。
     * path 也一并传：icacls 的第一行是「路径 + 空格 + 主体」，
     * 而我们**本来就知道**查的是哪个路径 —— 拿它剥前缀，路径里的空格
     * 就不再是解析难点（靠空白猜边界在路径含空格时必错）。 */
    out.acl = aclRepair.parseIcacls(out.aclRaw, out.me || undefined, { path: target });
  } catch (err) { out.acl = null; }

  /* 所有者是不是当前用户。
   * 【用 principalEq，不要自己写后缀匹配】
   * 早期这里是
   *   a === b || a.endsWith('\\' + b.split('\\').pop())
   * 仍是「后缀包含」的老写法：DOMAIN\\admin 会命中
   * BUILTIN\\Administrators 的尾巴，判成「所有者是你」。
   * 而 parseIcacls 里判 mine 用的是另一套写法 —— 两处各写一套，
   * 一旦其中一处改错，诊断结论会自相矛盾。
   * 现在统一收到 lib/acl-repair.js 的 principalEq（同一份判据）。 */
  if (out.me && out.owner) {
    out.ownerIsMe = aclRepair.principalEq(out.owner, out.me);
  }
  return out;
}

async function restoreBak(bakPath, srcPath) {
  try {
    if (!(await pathExists(bakPath))) return { ok: false, reason: '备份目录不存在' };
    if (await pathExists(srcPath)) return { ok: false, reason: '原路径已被占用，无法改名回去' };
    await fsp.rename(bakPath, srcPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function verifyCopy(srcDir, dstDir) {
  const stack = [[path.resolve(srcDir), path.resolve(dstDir)]];
  let files = 0, bytes = 0, hashed = 0;
  const toHash = [];
  const SIZE_LIMIT = 512 * 1024 * 1024;   // 单个文件超过 512MB 不做全量哈希（太慢）
  const HASH_BUDGET = 12;                 // 最多抽样 12 个不同大小的文件

  /* 【源侧条目在复制与校验之间消失，必须与我刚加的容忍策略一致】
   * copyTreeExcludingLinks 已经允许「readdir 之后文件被删」并记进
   * skippedFiles/skippedDirs，注释写着「源目录往往是活的」。但这一步
   * verifyCopy 会重新遍历**源树**：同一个场景立刻抛「读取源文件失败」，
   * dirMoveRun 的 catch 接着回滚并报「校验失败 … 读取源文件失败：…」。
   * 于是用户先看到「跳过 N 个」，再看到「读取源文件失败」—— 两句自相矛盾，
   * 而且整个搬家白做。这里必须按同一口径处理：
   *   · 源侧 stat 失败、但**目标侧存在** → 视为「源侧已消失」，计数跳过；
   *   · 源侧在、目标侧缺 → 才是真正的校验失败（副本不完整）。
   * 目录同理：源子目录整个没了，跳过它那棵子树，不当失败。 */
  const skipped = { files: 0, dirs: 0, list: [] };
  const noteGone = (rel, kind) => {
    if (kind === 'dir') skipped.dirs++; else skipped.files++;
    if (skipped.list.length < 20) skipped.list.push(rel);
  };

  while (stack.length) {
    const [s, d] = stack.pop();
    let ents;
    try { ents = await fsp.readdir(s, { withFileTypes: true }); }
    catch (err) {
      /* 源子目录在遍历过程中被删掉了：按「已消失」处理，继续校验其它部分。
       * ENOENT 才算消失；权限/IO 错误仍然要抛（那是环境问题，不是数据消失）。 */
      if (err && err.code === 'ENOENT') {
        noteGone(path.relative(path.resolve(srcDir), s), 'dir');
        continue;
      }
      throw new Error('读取源目录失败：' + s + '（' + err.message + '）');
    }
    for (const ent of ents) {
      const sp = path.join(s, ent.name);
      const dp = path.join(d, ent.name);
      if (ent.isSymbolicLink()) continue;   // 不跟随链接（目标内容不在这次复制里）
      if (ent.isDirectory()) { stack.push([sp, dp]); continue; }
      if (!ent.isFile()) continue;

      const stDst = await fsp.stat(dp).catch(() => null);
      const sst = await fsp.stat(sp).catch(() => null);
      if (!sst) {
        /* 源文件没了。判定口径：
         *   目标侧有 → 复制阶段确实拷过它、之后源被删 → 记「已消失」，通过；
         *   目标侧也没有 → 它从来没被成功复制，让后面的检查照常报失败。 */
        if (stDst) { noteGone(path.relative(path.resolve(srcDir), sp), 'file'); continue; }
        throw new Error('读取源文件失败：' + sp);
      }
      if (!stDst) throw new Error('目标缺少文件：' + dp);
      if (sst.size !== stDst.size) {
        throw new Error('大小不一致：' + path.basename(sp) + '（源 ' + sst.size + ' / 目标 ' + stDst.size + '）');
      }
      files++; bytes += sst.size;
      /* 抽样哈希前再 stat 一次会更准，但这里有竞态：源可能正好在此时被删。
       * hashFile 失败会被下面的 catch 归到「已消失」，不误判成内容不一致。 */
      if (sst.size > 0 && sst.size <= SIZE_LIMIT) toHash.push({ sp, dp, size: sst.size });
    }
  }

  /* 抽样策略：按大小排序后取「最大几个 + 中间均匀取样」，
   * 这样既能覆盖大文件（最容易复制出问题），也覆盖中小文件。 */
  toHash.sort((a, b) => b.size - a.size);
  const pick = [];
  const seenSize = new Set();
  for (const it of toHash) {
    if (pick.length >= HASH_BUDGET) break;
    // 尽量从不同大小里取，避免 12 个都是同尺寸的日志文件
    const bucket = Math.floor(Math.log2(it.size + 1));
    if (seenSize.has(bucket) && pick.length >= 4) continue;
    seenSize.add(bucket);
    pick.push(it);
  }
  for (const it of pick) {
    let a, b;
    try { a = await hashFile(it.sp); }
    catch (e) {
      if (e && e.code === 'ENOENT') { noteGone(path.relative(path.resolve(srcDir), it.sp), 'file'); continue; }
      throw e;
    }
    b = await hashFile(it.dp);
    if (a !== b) throw new Error('内容校验失败（哈希不一致）：' + path.basename(it.sp));
    hashed++;
  }
  return {
    ok: true, files, hashed, bytes,
    skippedFiles: skipped.files, skippedDirs: skipped.dirs,
    skippedDisappeared: skipped.files + skipped.dirs, skippedList: skipped.list,
  };
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(p);
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => resolve(h.digest('hex')));
    rs.on('error', reject);
  });
}

async function verifyInnerLinksReadable(dstRoot, srcAbs, srcReadableLinks) {
  const list = Array.isArray(srcReadableLinks) ? srcReadableLinks : [];
  if (!list.length) return { ok: true, reason: '', sampled: 0, checked: 0 };

  /* 【判据用 stat，不用 access / readdir】见 restoreLinksIntoTarget 里的实测：
   * 悬空链接的 access 是成功的（条目本身可访问），readdir 对文件链接无效。
   * stat 跟随链接、目标不在就 ENOENT —— 这才是「能不能读到东西」。 */
  const canRead = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };
  for (const l of list) {
    const dstChild = path.join(dstRoot, ...relKey(srcAbs, l).split('/'));
    if (!canRead(dstChild)) {
      let tgt = '未知目标';
      try { tgt = fs.readlinkSync(dstChild); } catch (e) { /* 读不到就保持「未知目标」 */ }
      return {
        ok: false,
        reason: '目标树里的链接打不开：' + dstChild + '（它指向 ' + tgt + '）',
        sampled: 0, checked: list.length,
      };
    }
  }
  return { ok: true, reason: '', sampled: list.length, checked: list.length };
}

async function verifyLinkReadable(linkPath, expectTarget) {
  const st = await fsp.lstat(linkPath).catch(() => null);
  if (!st || !st.isSymbolicLink()) return { ok: false, reason: '原路径不是链接' };
  let real;
  try { real = fs.realpathSync.native(linkPath); } catch (err) { return { ok: false, reason: '链接无法解析：' + err.message }; }
  /* 【两侧都要 realpath 归一，不能只对一侧做字符串比较】
   * realpathSync 返回的是**规范长名**，而 expectTarget 可能是调用方
   * 从别处拿到的 8.3 短名（Agent 机 / CI 的 runneradmin 上尤其常见：
   * Temp 下会生成 SHORT~1 这种短目录名）。直接比字符串就会把
   * 「指向完全正确」的链接判成「指向非预期位置」——
   * 而这条判据位于「源已改名、链接已建」之后，误判会触发回滚，
   * 让一次本已成功的搬家白折腾一遍。
   * 两侧各自 realpath 后再比；某一侧解析不了（比如目标已被删）时，
   * 退回到字面比较，保持「真僵尸链接仍能被判失败」这个能力。 */
  const canon = (s) => {
    const abs = path.resolve(String(s || ''));
    try { return fs.realpathSync.native(abs).toLowerCase(); }
    catch (e) { return abs.toLowerCase(); }
  };
  if (canon(real) !== canon(expectTarget)) {
    return { ok: false, reason: '链接指向了非预期位置：' + real };
  }
  // 真的读几个文件
  let sampled = 0;
  try {
    const ents = await fsp.readdir(linkPath, { withFileTypes: true });
    for (const ent of ents) {
      if (sampled >= 3) break;
      if (!ent.isFile()) continue;
      const full = path.join(linkPath, ent.name);
      /* 【只读前 4KB，不要整份读进内存】
       * 判据是「通过链接能不能真的读到字节」，不需要读完整个文件。
       * 早期这里用 fsp.readFile(full)，等于把每个抽样文件整个塞进内存：
       * 目录里有 VM 镜像 / ISO / 大视频时就是几个 GB。
       * 而这一步正好发生在「源已改名、链接已建」之后 —— 主进程 OOM 直接崩，
       * 连回退逻辑都跑不到，流程就停在最危险的中间态。
       * 用 open + 定长 read 后 close：占用内存与文件大小无关（固定 4KB 缓冲区）。
       * 抽样数量和抽样策略保持不变（仍是前 3 个文件）。 */
      /* 注意读出来的**字节数**可能是 0（空文件），那不代表失败 ——
       * 空文件通过链接能打开、能读，恰恰说明链接是通的。
       * 所以判据是「有没有抛出」，而不是「读到的字节数是不是真值」：
       * 失败时 readHeadBytes 会 reject，上面的 .catch 把它变成 null。 */
      const got = await readHeadBytes(full, 4096).catch(() => null);
      if (got === null) return { ok: false, reason: '通过链接读取文件失败：' + ent.name };
      sampled++;
    }
  } catch (err) {
    return { ok: false, reason: '通过链接列目录失败：' + err.message };
  }
  return { ok: true, sampled };
}

async function readHeadBytes(file, n) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(n);
    const r = await fh.read(buf, 0, n, 0);
    return r.bytesRead;
  } finally {
    await fh.close().catch(() => {});
  }
}

handle(dirMoveCh.ACL_LINKS.WHO_LOCKS, async (e, paths) => {
  const r = await rmQueryLockers(paths);
  // 有占用进程时给一条可操作的建议，而不是只回一堆 pid
  if (!r.lockers.length) {
    return Object.assign(r, { advice: '没有进程占用这些文件。若仍然删不掉，可能是权限不足或路径被其它程序（如杀软）临时拦截。' });
  }
  const names = [...new Set(r.lockers.map((x) => x.name || x.procName || ('PID ' + x.pid)))];
  return Object.assign(r, {
    advice: '被以下进程占用：' + names.join('、') + '。确认是你自己的程序后可以结束它；系统服务请勿随意结束。',
  });
})

handle(dirMoveCh.ACL_LINKS.WHO_LOCKS_DIR, async (e, dir) => {
  if (!(await pathExists(dir))) throw new Error('目录不存在：' + dir);
  const st = await fsp.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('不是目录：' + dir);
  /* 只取前 200 个：Restart Manager 单次注册太多文件会明显变慢，
   * 而用户真常见的是「目录里有一两个文件被占用」。
   *
   * 【只注册普通文件，不注册子目录和链接 —— 实测这是必须的】
   * 逐个二分验证过，RmGetList 返回错误码 5（Access denied）的条件是：
   *   注册一个普通文件            → 正常返回占用进程
   *   注册一个目录（哪怕只是父目录）→ ERR list 5
   *   注册一个 junction/符号链接    → ERR list 5
   *   注册 文件+目录 / 文件+链接    → 同样整批 ERR 5
   * 这类条目会让**整个查询**失败，而不是「这一项没查到」。
   * 而这恰恰是最常见的情形：用「目录搬家」搬过的目录里就有一个 junction，
   * 于是用户点「查占用」只看到「Restart Manager 查询失败」。
   *
   * 跳过它们不影响结论：用户要的是「删目录删不掉时，里面哪个文件被占」，
   * 文件被占用才是 RM 能定位的情形；目录被占用（有程序把它当工作目录）
   * RM 本来就查不到。跳过的项在 advice 里如实说明，不假装扫过全部。 */
  let files = [];
  let skipped = 0;
  let total = 0;
  try {
    const raw = await fsp.readdir(dir, { withFileTypes: true });
    total = raw.length;
    for (const ent of raw) {
      if (files.length >= 200) break;
      /* 用 Dirent 判断：不额外 stat，也不会跟随链接 */
      if (!ent.isFile()) { skipped++; continue; }
      files.push(path.join(dir, ent.name));
    }
  } catch (err) { throw new Error('读取目录失败：' + err.message); }

  if (!files.length) {
    return {
      paths: [], missing: [], lockers: [], scanned: 0, total, skipped,
      advice: total
        ? '目录内没有可查询的普通文件（共 ' + total + ' 项，其中 ' + skipped +
          ' 项是子目录或链接）。'
        : '目录是空的，没有被占用的文件。',
    };
  }
  const r = await rmQueryLockers(files);
  return Object.assign(r, {
    scanned: files.length, total, skipped,
    advice: r.lockers.length
      ? '目录内有 ' + r.lockers.length + ' 个进程占用的文件。' +
        (skipped ? '（另有 ' + skipped + ' 项子目录/链接未纳入查询）' : '')
      : '目录内没有检测到文件被占用（已检查 ' + files.length + ' 个普通文件' +
        (skipped ? '，跳过 ' + skipped + ' 项子目录/链接' : '') + '）。',
  });
})

handle(dirMoveCh.ACL_LINKS.LINK_SCAN, async (e, root, opts = {}) => {
  if (!(await pathExists(root))) throw new Error('目录不存在：' + root);
  const r0 = await fsp.stat(root).catch(() => null);
  if (!r0 || !r0.isDirectory()) throw new Error('不是目录：' + root);

  const { links: found, scanned, truncated } = await collectLinks(root, opts);

  /* 【为什么不再对每个链接起一次 PowerShell】
   * 原来在循环里调 links.linkInfo(p, ps)，每一项都是一次新的
   * powershell.exe 启动（约 0.3~1 秒）。200 个链接就是几分钟，
   * 耗时随链接数线性膨胀。
   *
   * 现在改成：
   *   1) 目标用 fs.readlinkSync —— 它直接读 reparse point 的 target，
   *      junction 同样支持（已实测：readlinkSync 返回 junction 的目标）；
   *   2) 类型与属性用**一次** Get-ChildItem 批量取回整个 root 的所有
   *      reparse point，不再放进循环。
   * 某个链接读不到目标就标 null，绝不因此中断整批。
   *
   * 分类逻辑（links.classifyLink）保持原样，只换数据来源。 */
  const targetByName = new Map();   // 小写路径 → 目标
  const typeByName = new Map();

  for (const p of found) {
    try {
      /* readlinkSync 返回的是目标路径；读不到（权限/损坏）就留 null */
      targetByName.set(p.toLowerCase(), fs.readlinkSync(p));
    } catch (err) {
      targetByName.set(p.toLowerCase(), null);
    }
  }

  /* 【不再用 Get-ChildItem -Recurse 重扫一遍全树】
   * 早期这里为了拿到 LinkType，又用 PowerShell 把整个 root 递归遍历一次 ——
   * 而 collectLinks 已经用 Node 完整遍历过了，等于双倍 IO，
   * 大目录上这一趟就是几十秒的纯浪费。
   * 现在只对**已经收集到的链接**做一次批量 Get-Item（数量通常是个位数到几十），
   * 并把 Node 侧就能判断的特征先填上：
   *   - readlink 得到的 target 若是目录且能在盘符内解析 → 极可能是 junction；
   *   - 但真正的 LinkType 交给 PowerShell 批量取，取不到就留空（只是展示信息）。
   * 注意：targetByName 已经有了 readlink 的结果，这里只用它兜底。 */
  let typeQueryError = null;
  try {
    const q = (x) => "'" + String(x).replace(/'/g, "''") + "'";
    /* 【必须分块】几百个路径拼成一条会撞命令行上限（spawn ENAMETOOLONG），
     * 那时整趟查询作废、所有链接的 LinkType 都空着（只是展示信息，
     * 但用户会以为「这些链接没类型」，而真相是查询根本没跑起来）。 */
    for (let i = 0; i < found.length; i += PS_PATH_BATCH) {
      const chunk = found.slice(i, i + PS_PATH_BATCH);
      try {
        const arr = chunk.map(q).join(',');
        const r = await ps(
          /* 结尾的 exit 0：悬空链接（Get-Item 拿不到）本来就会让 PowerShell
           * 返回非零，而那是**正常状态**，不该被算成「查询失败」。 */
          `Get-Item -LiteralPath @(${arr}) -Force -ErrorAction SilentlyContinue | ` +
          `ForEach-Object { @($_.FullName, [string]$_.LinkType, [string]$_.Target) -join [char]9 }; exit 0`,
          Math.max(15000, chunk.length * 300));
        for (const line of String(r.stdout || '').split(/\r?\n/)) {
          if (!line.trim()) continue;
          const seg = line.split('\t');
          if (seg.length < 2) continue;
          const key = seg[0].toLowerCase();
          typeByName.set(key, seg[1] || '');
          /* PowerShell 的 Target 只在 readlink 失败时作为兜底 */
          if (!targetByName.get(key) && seg[2]) targetByName.set(key, seg.slice(2).join('\t'));
        }
      } catch (err) {
        /* 单块失败不影响其它块，但要记下来如实告知（不能再全静默）。
         * 截断：err.message 里通常带着整条命令行（几千字符），
         * 原样塞进界面没人读得下去；错误码才是关键信息。 */
        typeQueryError = (typeQueryError ? typeQueryError + '；' : '') + shortErr(err);
      }
    }
  } catch (err) { typeQueryError = err.message; }

  const items = [];
  for (const p of found) {
    const key = p.toLowerCase();
    const info = {
      type: typeByName.get(key) || '',
      target: targetByName.get(key) || '',
    };
    const cls = links.classifyLink(p, info);
    items.push({
      path: p,
      kind: cls.kind,
      reason: cls.reason,
      target: cls.target || info.target || null,
      linkType: info.type || null,
      notLink: !!cls.notLink,
      crossVolume: !!cls.crossVolume,
    });
  }

  /* 分五类汇总（前端按这个顺序分组）。
   * 【新增 opaque 必须在这里登记】漏登记的类别会被下面的
   * `groups[it.kind] ? it.kind : 'ok'` 兜底塞进「正常」——
   * 一个「读不到、无法判断」的链接被显示成「正常」，比不显示更糟。 */
  const groups = { ok: [], dead: [], loop: [], system: [], crossvol: [], opaque: [] };
  for (const it of items) {
    const k = groups[it.kind] ? it.kind : 'ok';
    groups[k].push(it);
  }
  const counts = {};
  for (const k of Object.keys(groups)) counts[k] = groups[k].length;

  return {
    root, scanned, truncated,
    total: items.length,
    counts,
    groups,
    kinds: links.LINK_KINDS,
    /* 链接类型（junction / symlink）是**展示**字段，查询失败不影响判定结果，
     * 但必须让用户知道「类型那列是空的」是因为查询失败，而不是真的没有类型。 */
    typeQueryError,
    advice: items.length
      ? '共 ' + items.length + ' 个链接：' +
        Object.entries(counts).filter(([, n]) => n).map(([k, n]) => links.LINK_KINDS[k].label + ' ' + n).join('、')
      : '这个目录里没有找到任何链接（目录联接或符号链接）。',
  };
})

handle(dirMoveCh.ACL_LINKS.LINK_REMOVE, async (e, paths, opts = {}) => {
  /* 只允许清理僵尸链接。这一条必须在主进程强制 —— 前端过滤只是体验，
   * 渲染层完全可能构造任意路径调过来。 */
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string' && p);
  if (!list.length) throw new Error('没有要清理的链接');

  const removed = [];
  const skipped = [];

  /* 【不再对每个链接起一次 PowerShell，但复核一步都不能省】
   * 早期这里是循环里 `await links.linkInfo(p, ps)`：每项启动一个新的
   * powershell.exe（约 0.3~1 秒），50 个僵尸链接就要一两分钟，
   * 和刚修好的 link:scan 形成反差 —— 用户点下去长时间没反馈，会重复点。
   *
   * 现在目标用 fs.readlinkSync 直接读 reparse point 的 target（junction 也支持），
   * 这是纯文件系统操作，不起进程；类型只是展示信息，清理路径根本不用它。
   * classifyLink 仍**逐项**重新跑一遍：扫描结论是渲染层带过来的历史数据，
   * 不能当授权依据 —— 二次校验这道闸必须留着，只是换掉了慢的那一层。 */
  for (const p of list) {
    let target = '';
    try { target = fs.readlinkSync(p); } catch (err) { target = ''; }
    const info = { target };
    const cls = links.classifyLink(p, info);
    if (cls.kind !== 'dead') {
      /* 非僵尸链接一律不动：ok 是不必删，loop/system/crossvol 是需要人工判断。
       * 用户明确只想清僵尸，这里替他把关。 */
      skipped.push({ path: p, kind: cls.kind, reason: cls.reason });
      continue;
    }
    if (opts.dryRun) { removed.push({ path: p, dryRun: true, target: cls.target }); continue; }
    const r = await links.removeLinkOnly(p);
    removed.push({ path: p, target: r.target, method: r.method });
  }
  return {
    removed, skipped,
    advice: removed.length
      ? '已清理 ' + removed.length + ' 个僵尸链接（只删链接本身，未触碰任何目标数据）' +
        (skipped.length ? '；跳过 ' + skipped.length + ' 个非僵尸链接' : '')
      : '没有可清理的僵尸链接' + (skipped.length ? '（' + skipped.length + ' 个链接不属于僵尸类）' : ''),
  };
})

handle(dirMoveCh.DIR_MOVE.PRECHECK, async (e, { src, dst } = {}) => {
  if (!dirMove) throw new Error('内部错误：搬家模块未加载');
  const srcAbs = path.resolve(String(src || ''));
  const dstAbs = path.resolve(String(dst || ''));

  const sst = await fsp.stat(srcAbs).catch(() => null);
  const lst = links.linkStat(srcAbs);
  const srcExists = !!sst;
  const srcIsDir = !!sst && sst.isDirectory();
  const srcIsRoot = links.isVolumeRootOnly(srcAbs);
  /* 【这里用 isProtectedForModify 而不是 isCriticalPath】
   * isCriticalPath 把「关键目录的直接子目录」也算危险，而 criticalDirs()
   * 含用户家目录 —— 于是「把 Documents 搬到 D 盘」这种完全正常的操作
   * 会被 SRC_CRITICAL 拒掉。搬家的破坏面是「搬错地方」，不是「毁掉系统」，
   * 边界应当比删除更窄：系统目录/盘符根/别人的家目录/自己家目录本身才拦。
   * path-guard 内部做 realpath 归一，能挡住 junction 绕行。 */
  const protectedMod = pathGuard.isProtectedForModify(srcAbs);
  const srcIsCritical = protectedMod.protected;
  /* 【目标侧同样过闸门】源有保护判据，目标一直没有 ——
   * 在「新位置」里填 C:\Windows\moved 就能往系统目录里写整棵树。
   * 用同一份判据（isProtectedForModify），预检与执行两处都传。 */
  const dstProtectedMod = pathGuard.isProtectedForModify(dstAbs);
  const dstExists = await pathExists(dstAbs);

  /* 目标盘的剩余空间（同卷时没有意义，但校验里同卷会先被拒） */
  let freeBytes = null;
  try {
    if (typeof fs.statfsSync === 'function') {
      const sf = fs.statfsSync(path.parse(dstAbs).root || dstAbs);
      freeBytes = sf.bavail * sf.bsize;
    }
  } catch (err) { freeBytes = null; }

  /* 【一次遍历同时拿到「要复制多少字节」与「树里有几个链接」】
   * 早期这里是 links.dirSize(srcAbs) + collectLinks(srcAbs)：同一棵树走两遍
   * （目录项读两遍、文件各 stat 一遍）。大目录上光是预检就要等很久，
   * 而这两个数的遍历规则（不跟随链接）本来就完全一致。 */
  let needBytes = null;
  let treeLinks = [];
  if (srcExists && srcIsDir && !lst.isLink) {
    try {
      const walk = await collectLinks(srcAbs, { wantSize: true });
      needBytes = walk.bytes;
      treeLinks = walk.links;
    } catch (err) { needBytes = null; }
  }
  /* 其中有多少是「文件符号链接」：这类在目标侧必须重建为符号链接，
   * 而 Windows 创建符号链接需要特权 —— 提前告诉用户，
   * 免得搬家在这一步失败（失败会回退，但白等一次完整拷贝）。
   * 【性质查询失败要如实说】否则 fileLinkCount 恒 0，
   * 把一个「可能失败」的操作显示成「没有文件链接、应该没问题」。 */
  let fileLinkCount = 0;
  let linkNaturesError = null;
  try {
    const ln = await linkNatures(treeLinks);
    linkNaturesError = ln.error;
    for (const [, n] of ln.natures) if (n === 'file') fileLinkCount++;
  } catch (err) { linkNaturesError = err.message; }

  /* 有多少链接的目标落在源目录树内部 —— 这些会被**改写**成新位置的对应路径
   * （照抄旧路径的话，旧路径随 .bak 一起被删，重建出来的就是死链）。
   * 提前告诉用户，界面文案才和实际行为对得上。 */
  let innerLinkCount = 0;
  for (const l of treeLinks) {
    try { if (isInsideTree(linkTargetAbs(l), srcAbs)) innerLinkCount++; } catch (err) { /* 读不到的链接不计数 */ }
  }

  /* 占用检查：只看顶层**普通文件**，查得快且覆盖绝大多数情况。
   *
   * 【两个必须守住的点】
   * 1) 只注册普通文件。实测：Restart Manager 的注册列表里只要混进一个
   *    目录或 junction，RmGetList 就整批返回错误码 5（Access denied），
   *    整批失败 —— 不是「这一项没查到」，而是整个查询作废。
   *    而「目录搬家」搬过的目录里恰好就有一个 junction。
   *    同文件的 file:who-locks-dir 早已改成 ent.isFile() 过滤，这里对齐。
   * 2) 探测失败不许静默吞。早期写成 .catch(() => null) 再判空，
   *    查询失败和「没有占用」长得一模一样，于是 lockedPaths 恒为空、
   *    lib/dir-move.js 的 LOCKED 判定永远不触发 —— 预检成了摆设。
   *    现在把错误带进 lockCheckError，由调用方告知用户「查询失败」，
   *    并明确说「这不代表没有占用」。 */
  let lockedPaths = [];
  let lockCheckError = null;
  if (srcExists && srcIsDir && !lst.isLink) {
    const probe = await collectLockProbe(srcAbs);
    if (probe.error) {
      lockCheckError = probe.error;
    } else if (probe.files.length) {
      try {
        const lr = await rmQueryLockers(probe.files);
        if (lr && lr.lockers && lr.lockers.length) {
          /* 【lockedPaths 存的是「进程」而不是文件路径】
           * rmQueryLockers 返回的元素是 { pid, name, type }，
           * 根本没有 files 字段（早期这里写 x.files 永远走不到，
           * 于是 map 出来其实一直是 pid）。RM 是整批注册再取列表，
           * 进程与路径的对应关系拿不到，所以这里就按「进程」表达，
           * 文案也改成「N 个进程占用」，不再假装知道是哪些文件。 */
          lockedPaths = lr.lockers.map((x) => (x.pid || 0) + ':' + (x.name || x.procName || ''));
        }
      } catch (err) {
        lockCheckError = err.message;
      }
    }
  }

  const verdict = dirMove.validateMove({
    src: srcAbs, dst: dstAbs,
    srcExists, srcIsDir, srcIsLink: lst.isLink, srcIsRoot, srcIsCritical,
    /* 把「为什么受保护」的原因交给 validateMove 拼进 reason（与目标侧对齐） */
    srcProtectedReason: protectedMod.protected ? protectedMod.reason : '',
    srcProtectedKind: protectedMod.protected ? protectedMod.kind : '',
    dstExists, needBytes: needBytes || 0, freeBytes, lockedPaths,
    allowSameVolume: false,
    bakExists: await pathExists(tempNames.dirmoveBak(srcAbs)),
    bakPath: tempNames.dirmoveBak(srcAbs),
    dstProtected: dstProtectedMod.protected,
    dstProtectedReason: dstProtectedMod.protected ? dstProtectedMod.reason : '',
  });

  return Object.assign(verdict, {
    src: srcAbs, dst: dstAbs,
    srcExists, srcIsDir, srcIsLink: lst.isLink, srcIsRoot, srcIsCritical,
    /* 保护原因带上，界面能说清「为什么这块不能搬」（区分系统目录/家目录） */
    srcProtectedKind: protectedMod.protected ? protectedMod.kind : null,
    srcProtectedReason: protectedMod.protected ? protectedMod.reason : null,
    /* 目标侧的保护原因同理 */
    dstProtected: dstProtectedMod.protected,
    dstProtectedKind: dstProtectedMod.protected ? dstProtectedMod.kind : null,
    dstProtectedReason: dstProtectedMod.protected ? dstProtectedMod.reason : null,
    /* 占用查询本身失败时要让界面能看到（不能与「没有占用」混同） */
    lockCheckError,
    /* 源目录树里有多少链接 —— 搬家时这些会被原样重建，
     * 提前告诉用户，免得事后看到「多了一个链接」以为是 bug。
     * 用的是上面那次遍历的结果，不再走第二遍。 */
    linkCount: treeLinks.length,
    fileLinkCount,
    innerLinkCount,
    linkNaturesError,
    dstExists, needBytes, freeBytes, lockedPaths,
    plan: dirMove.movePlan(srcAbs, dstAbs),
  });
})

handle(dirMoveCh.DIR_MOVE.MOVE, async (e, { src, dst, jobId: clientJob } = {}) => {
  if (dirMoveBusy) throw new Error('已有搬家任务在进行，请等待它完成后再试（或重启应用）。');
  dirMoveBusy = true;
  try {
    return await dirMoveRun({ src, dst, jobId: clientJob });
  } finally {
    /* 必须无条件复位：失败、成功、抛异常都要能再次搬家 */
    dirMoveBusy = false;
  }
})

handle(dirMoveCh.ACL_LINKS.ACL_DIAGNOSE, async (e, target) => {
  const p = String(target || '');
  if (!p) throw new Error('没有指定路径');
  const exists = await pathExists(p);
  let isDir = false, childCount = -1;
  if (exists) {
    const st = await fsp.stat(p).catch(() => null);
    isDir = !!st && st.isDirectory();
    if (isDir) {
      try { childCount = (await fsp.readdir(p)).length; } catch (err) { childCount = -1; }
    }
  }

  const facts = exists ? await readAclFacts(p) : { owner: null, ownerIsMe: null, acl: null };
  const isAdmin = await isRunningAsAdmin();

  /* 占用检查：和权限问题长得一样，但修复方式完全不同，必须区分。
   * 【查询失败不能静默吞】早期是 .catch(() => null) 再判空 ——
   * 查询失败与「确实没有占用」在这里长得一模一样，于是诊断会漏掉
   * 「其实是占用问题」这一整类原因，还让用户以为已经排查过了。
   * 现在把错误单独带出去（lockCheckError），界面上如实说明。 */
  let lockedPaths = [];
  let lockCheckError = null;
  if (exists && !isDir) {
    try {
      const lr = await rmQueryLockers([p]);
      if (lr && lr.lockers && lr.lockers.length) {
        lockedPaths = lr.lockers.map((x) => x.pid + ':' + (x.name || ''));
      }
    } catch (err) {
      lockCheckError = err.message;
    }
  }

  const diag = aclRepair.diagnose({
    exists, isDir, childCount,
    ownerIsMe: facts.ownerIsMe, ownerName: facts.owner,
    acl: facts.acl, isAdmin, lockedPaths,
  });

  return Object.assign({
    path: p, isAdmin,
    /* 占用查询失败要能被界面看到（不能与「没有占用」混同） */
    lockCheckError,
    owner: facts.owner, me: facts.me || null, ownerIsMe: facts.ownerIsMe,
    aclEntries: (facts.acl && facts.acl.entries || []).slice(0, 20),
    hasFull: !!(facts.acl && facts.acl.hasFull),
    hasDeny: !!(facts.acl && facts.acl.hasDeny),
  }, diag);
})

handle(dirMoveCh.ACL_LINKS.ACL_REPAIR, async (e, opts = {}) => {
  const target = String(opts.target || '');
  if (!target) throw new Error('没有指定路径');
  if (!(await pathExists(target))) throw new Error('路径不存在：' + target);

  /* 第一道闸：不该改权限的地方一律拒绝。
   * 【为什么不用 isCriticalPath】它把「关键目录的直接子目录」也算危险，
   * 而 criticalDirs() 含用户家目录 —— 于是 C:\Users\<你>\Documents 被拒，
   * 提示语还是「改错会导致系统更新失败或被安全软件拦截」，对这个目标
   * 完全是误导（用户就是想修自己 Documents 里某个文件）。
   * isProtectedForModify 只拦系统目录、盘符根、别人的家目录、以及
   * 自己家目录本身，并给出**分情形**的说明。 */
  const protectedMod = pathGuard.isProtectedForModify(target);
  if (protectedMod.protected) {
    let msg;
    if (protectedMod.kind === 'SYSTEM') {
      msg = '拒绝：' + protectedMod.reason + '。' +
        '即便有管理员权限也不该让工具去改系统目录的 ACL —— ' +
        '改错会导致系统更新失败或被安全软件拦截，而且没有恢复路径。';
    } else if (protectedMod.kind === 'OWN_HOME') {
      msg = '拒绝：' + protectedMod.reason + '。' +
        '如果你想修某个删不掉的文件，请直接选中那个文件或它所在的子文件夹。';
    } else if (protectedMod.kind === 'OTHER_HOME') {
      msg = '拒绝：' + protectedMod.reason + '。' +
        '需要访问别的用户的数据时，请用那个账号登录后操作。';
    } else {
      msg = '拒绝：' + protectedMod.reason + '。';
    }
    throw new Error(msg);
  }

  /* 第二道闸：递归必须由调用方**显式**要求，且是目录 */
  const st = await fsp.stat(target).catch(() => null);
  const isDir = !!st && st.isDirectory();
  const recursive = !!opts.recursive && isDir;

  const admin = await isRunningAsAdmin();
  /* admin 是三态：true / false / null（查询失败，见 isRunningAsAdmin 注释）。
   * 只有确定**不是**管理员时才说「请以管理员身份运行」——那是可执行的建议；
   * 查询失败时说这句等于让用户去重装/重开一遍也没用，得如实说「没查出来」。 */
  if (admin === false) {
    throw new Error('修复权限需要管理员权限。请右键「以管理员身份运行」核核工具箱后重试。' +
      '（改所有者 takeown 这一步普通权限做不了）');
  }
  if (admin === null) {
    throw new Error('无法确认当前是否以管理员身份运行（权限查询失败），已拒绝执行以免白跑一趟。' +
      '请确认核核工具箱是「以管理员身份运行」后重试；若反复失败，可能是 PowerShell 被安全策略限制。');
  }

  const me = (await ps(`[Security.Principal.WindowsIdentity]::GetCurrent().Name`, 10000)
    .then((r) => String(r.stdout || '').trim())
    .catch(() => '')) || '';
  if (!me) throw new Error('无法取得当前用户名，已放弃修复');

  const plan = aclRepair.buildRepairCommands({ path: target, isDir, recursive, user: me });
  const log = [];
  for (const step of plan.steps) {
    try {
      const r = await runCmd(step.tool, step.args, { timeout: 60000 });
      const text = (String(r.stdout || '') + String(r.stderr || '')).trim();
      if (r.code !== 0) {
        log.push({ tool: step.tool, ok: false, text: text.slice(-500) });
        throw new Error(step.tool + ' 执行失败：' + (text.split(/\r?\n/).filter(Boolean).slice(-1)[0] || ('退出码 ' + r.code)));
      }
      log.push({ tool: step.tool, ok: true, text: text.slice(-300) });
    } catch (err) {
      return { ok: false, steps: log, user: me,
        advice: '修复中止。' + (err.code === 'ENOENT' ? '系统里找不到 ' + step.tool + ' 命令。' : err.message) };
    }
  }

  /* 复核：修完再读一遍 ACL，确认真的拿到了完全控制 */
  const after = await readAclFacts(target).catch(() => null);
  const gained = !!after && !!after.ownerIsMe && !!(after.acl && after.acl.hasFull);
  return {
    ok: true, steps: log, user: me, recursive,
    gained,
    owner: after && after.owner, ownerIsMe: after && after.ownerIsMe,
    advice: gained
      ? '已取得所有权并授予完全控制。现在可以重新尝试删除或修改这个路径。'
      : '命令已执行完毕，但复核时没有读到完全控制权限 —— 可能被组策略或安全软件拦截了。' +
        '请用当前权限再试操作，或查看下方命令输出。',
  };
})

  /* 【只导出 main.js 仍在用的那一个】isRunningAsAdmin 的调用方里，
   * sys:disk-health（留在 main.js，因为它和 disk-health 缓存、硬件面板
   * 耦合更紧）需要它来判断「要不要提示需要管理员」。
   * 其余函数搬走后 main.js 里已经没有任何调用 —— 实测扫描确认只剩这一处，
   * 所以不把 20 个函数全部导出（导出越多，越容易被别处顺手引用，
   * 又把耦合接回去）。
   *
   * 【为什么不是让它变成全局】main.js 拿到的是 register() 的返回值，
   * 顺带也就有了明确的依赖方向：模块不向上伸手，main.js 显式索取。 */
  return { isRunningAsAdmin };
};
