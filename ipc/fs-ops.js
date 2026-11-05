'use strict';
/* 文件系统读写 / 哈希 / 加密 / 分割 / 去重 / 压缩 —— 从 main.js 搬来。
 *
 * ============ 为什么单独成文件 ============
 * main.js 在两次搬迁（dir-acl-links、media-ffmpeg）之后仍有五千多行、
 * 139 个 handle。fs:* 与 zip:* 是其中最大且最内聚的一块：28 个通道、约一千行，
 * 全部围绕「读写用户的文件」这一件事，与窗口/托盘/更新/电源那些域没有交集。
 * 搬出来之后 main.js 少掉约五分之一，读它的人不必在一千行文件操作里翻窗口逻辑。
 *
 * ============ 搬运方式：整段照抄，一行未改 ============
 * 这一段里既有 handler，也夹着它们专用的辅助函数（writeFileAtomic、dirSizeFast、
 * hashFileMulti、cryptStream …）。逐段摘取需要精确的花括号配平，而正文里满是
 * 中文串与正则 —— 自动切分出错时是**静默改变语义**而不是报错。
 * 所以这里整段搬过来，一个字符都没动；只有下面那句 deps 解构是本文件新增的。
 * 少数被域外也用到的函数（见 module.exports）反过来从这里导出，调用方改成
 * 从模块取 —— 这也是「搬」而不是「改」。
 *
 * ============ 护栏不在这里 ============
 * CAP_GATED_CHANNELS 的高危能力门禁在 main.js 的 handle 包装层里。本模块用的是
 * **注入进来的 handle**，所以门禁照常生效 —— 不要在这里再实现一遍，
 * 两处判定迟早会分叉。
 *
 * ============ 依赖全部注入，不 require main.js ============
 * 本文件不 require('../main')：那会形成循环依赖，而且在测试里无法单独加载。
 * 需要的一切（handle / send / jobs / fs / path / pathGuard / tempNames …）都由
 * main.js 在 register 调用时传进来，见下面的解构。
 */

const CH = require('../lib/channels').CHANNELS;

module.exports = function register(ctx, deps) {
  const {
    handle, send, jobs, fmtErr, setLatestCancelable,
    fs, fsp, path, os, crypto, shell,
    AdmZip, pathGuard, tempNames, fsOps, archiveGuard,
    uniqueTarget, isOwnTempName,
  } = deps;

  /* ======================= 以下为逐字搬来的实现 ======================= */

/* ================= IPC: fs ================= */
const TEXT_LIMIT = 8 * 1024 * 1024, BIN_LIMIT = 64 * 1024 * 1024;
handle(CH.FS.READ_TEXT, async (e, p) => {
  const st = await fsp.stat(p);
  if (st.size > TEXT_LIMIT) throw new Error('文件超过 8MB，请使用文本分批读取或文件处理工具');
  const buf = await fsp.readFile(p);
  let content = buf.toString('utf8');
  if (content.includes('\uFFFD')) {
    try { content = new TextDecoder('gbk').decode(buf); } catch (err) {}
  }
  return { content, size: st.size };
});
// 写文件（覆盖式）。三个风险要挡住：
//   1) 目标是系统关键目录里的文件 -> 拒绝
//   2) 写入中途失败会留下半截文件，破坏用户原有内容
//   3) 替换过程中目标路径出现「空窗期」，此时任何中断都会让原文件彻底消失
// 做法：写同目录临时文件 -> 原子改名；Windows 上 rename 不能覆盖已存在目标，
// 就用「把原文件改名备份 -> 临时文件改名到位 -> 删备份」三段式，
// 任何一步失败都能把原文件恢复回去。
async function writeFileAtomic(dest, data, encoding) {
  const bad = pathGuard.checkOverwritable(dest);
  if (bad) throw pathGuard.err(bad.code, bad.reason);
  // 目标文件名本身也要过一遍：挡住 NTFS ADS（file.txt:stream）等写进去
  // 却看不见的形态。目前所有调用点传的都是我们自己的文件名，属于纵深防御。
  const nameBad = pathGuard.checkFileName(path.basename(String(dest || '')));
  if (nameBad) throw pathGuard.err(nameBad.code, nameBad.reason);
  const dir = path.dirname(dest);
  await fsp.mkdir(dir, { recursive: true });
  const tag = process.pid + '-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const tmp = tempNames.writeTmp(dest, tag);
  try {
    if (encoding) await fsp.writeFile(tmp, data, encoding);
    else await fsp.writeFile(tmp, data);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  try {
    await fsp.rename(tmp, dest);   // POSIX 语义：直接覆盖
    return dest;
  } catch (err) {
    // Windows：目标已存在时 rename 失败。绝不能「先 rm(dest) 再 rename」——
    // 那样中途失败会留下空目录项，原文件永久丢失。
    // 改为把原文件挪到备份名，新文件就位后再删备份。
    const bak = tempNames.writeBak(dest, tag);
    let moved = false;
    try {
      await fsp.rename(dest, bak);
      moved = true;
    } catch (e2) { /* 目标不存在或无法改名，直接尝试下一步 */ }
    try {
      await fsp.rename(tmp, dest);
      if (moved) await fsp.rm(bak, { force: true }).catch(() => {});
      return dest;
    } catch (err2) {
      // 新文件没能就位：把原文件搬回去。若搬回**也失败**，绝不能静默吞掉 ——
      // 原文件还躺在 .hehe-bak-* 隐藏文件里，按原路径找不到，等同于丢失。
      // 必须把备份路径明确告诉用户。
      if (moved) {
        try {
          await fsp.rename(bak, dest);
        } catch (e3) {
          await fsp.rm(tmp, { force: true }).catch(() => {});
          /* code 是本项目 IPC 错误载荷的约定（见 lib/errors.js 的 toPayload），
           * 所以它挂在 Error 上；类型上要显式声明，否则 checkJs 会把
           * 「给原生 Error 加自定义字段」当成缺陷。 */
          const e = /** @type {Error & {code?:string}} */ (
            new Error('写入失败且原文件回滚失败。原文件已保全在：' + bak + '（请手动改回原名）'));
          e.code = 'ROLLBACK_FAILED';
          throw e;
        }
      }
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err2;
    }
  }
}
handle(CH.FS.WRITE_TEXT, async (e, p, content) => { await writeFileAtomic(p, content, 'utf8'); return true; });
/* 读文件 → base64。
 *
 * 【第三个参数 maxBytes：只要文件开头 N 字节】
 * 调用方「按拍摄时间批量重命名」只需要 EXIF，而 EXIF 的 APP1 段紧跟在 SOI
 * 之后（EXIF 规范就是这么规定的），几 KB 就够 —— 一张 5MB 的照片 × 500 张，
 * 整份读进来是 2.5GB IO。
 *
 * 【为什么以前这个参数"传了但没用"】
 * 渲染层早就在传 65536，但 handler 签名只有 (e, p)，第三参被 IPC 丢掉且
 * 不报错。于是那行"只读文件头 64KB"的注释描述的是一个不存在的优化，
 * 而下面这个真缺陷（渲染层把 {b64,size} 当字符串）也因此没人发现：
 * 反正读多读少都走 catch 退路，看不出差别。参数被静默丢弃这种事，
 * 类型系统看不见、跑起来也不报错，只能靠「注释说的和代码做的是不是一回事」的对账去抓。
 *
 * @param {number} [maxBytes] 可选：只读前 N 字节（超出文件大小时按文件大小）
 */
handle(CH.FS.READ_FILE_B64, async (e, p, maxBytes) => {
  const st = await fsp.stat(p);
  if (st.size > BIN_LIMIT) throw new Error('文件超过 64MB 限制');
  /* 传入非法值（NaN / 负数 / 字符串）一律当"没传"，退回整读 ——
   * 静默读成 0 字节比多读 5MB 危险得多：前者会让 EXIF 永远解析不出来。 */
  const want = Number(maxBytes);
  const head = Number.isFinite(want) && want > 0 ? Math.min(Math.floor(want), st.size) : 0;
  if (!head || head >= st.size) {
    return { b64: (await fsp.readFile(p)).toString('base64'), size: st.size };
  }
  /* 只读前 head 字节。用 open + read 而不是 readFile + subarray：
   * 后者仍然把整个文件读进内存，省不了 IO 也省不了内存。 */
  const fh = await fsp.open(p, 'r');
  try {
    const buf = Buffer.alloc(head);
    const { bytesRead } = await fh.read(buf, 0, head, 0);
    return { b64: buf.subarray(0, bytesRead).toString('base64'), size: st.size };
  } finally {
    await fh.close();
  }
});
handle(CH.FS.WRITE_FILE_B64, async (e, p, b64) => { await writeFileAtomic(p, Buffer.from(b64, 'base64')); return true; });
handle(CH.FS.STAT, async (e, p) => { const st = await fsp.stat(p); return { size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() }; });
/* 批量取体积/类型：文件列表一次拖入 500 个文件时，逐个 fs:stat 就是 500 次
 * IPC 往返，主进程排队处理，列表体积长时间停在「…」。
 * 这里一次传一批（渲染层按 50 个一批分片），并发受限地 stat，
 * 单个路径失败只让那一项返回 null，不打断整批。
 * 【为什么限并发】500 个路径全开 Promise 会瞬间打满文件句柄；
 * 8 路足够快，也不会挤掉主进程里别的 IO。 */
handle(CH.FS.STAT_MULTI, async (e, paths) => {
  const list = Array.isArray(paths) ? paths : [];
  /* 一次最多 2000 个。
   *
   * 上限存在的理由：这个通道是渲染层传什么主进程就 stat 什么，没有天花板。
   * 正常用法（最近文件、工具页几十个）离 2000 很远；一旦哪里写错把整盘
   * 的结果全投进来（或用户选了上万项的目录），主进程会被这 8 路 worker
   * 长时间占住 —— 那是唯一跑 IPC 的进程，它忙起来整个界面都在排队。
   * 直接报错比默默卡住好查：报错能指出「谁传多了」，卡住只能靠猜。
   * 阈值取 2000：比任何现实调用高一个量级，又不至于让主进程排太久。 */
  const MAX_STAT_BATCH = 2000;
  if (list.length > MAX_STAT_BATCH) {
    throw new Error('批量查询文件信息一次最多 ' + MAX_STAT_BATCH + ' 个，收到 ' + list.length + ' 个');
  }
  const CONCURRENCY = 8;
  const out = new Array(list.length).fill(null);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= list.length) return;
      try {
        const st = await fsp.stat(list[i]);
        out[i] = { size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() };
      } catch (err) {
        out[i] = null; // 不存在/无权限：只影响这一项
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length || 1) }, worker));
  return out;
});
handle(CH.FS.EXISTS, async (e, p) => { try { await fsp.access(p); return true; } catch (err) { return false; } });
handle(CH.FS.LIST, async (e, p) => {
  const names = await fsp.readdir(p, { withFileTypes: true });
  const out = [];
  for (const d of names) {
    const full = path.join(p, d.name);
    try {
      const st = await fsp.stat(full);
      out.push({ name: d.name, path: full, isDir: d.isDirectory(), size: st.size, mtime: st.mtimeMs });
    } catch (err) { out.push({ name: d.name, path: full, isDir: d.isDirectory(), size: 0, mtime: 0 }); }
  }
  out.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
  return out;
});
handle(CH.FS.MKDIR, async (e, p) => { await fsp.mkdir(p, { recursive: true }); return true; });
// Unix 的 rename() 目标存在就覆盖，Windows 上 Node 也照这个语义走：
// 批量改名/改后缀撞上已存在的同名文件时，会把别人的文件悄无声息地抹掉。
// 这里默认拒绝覆盖（overwrite 需显式传 true），把“静默毁文件”变成可见的错误。
handle(CH.FS.RENAME, async (e, from, to, overwrite) => {
  if (!from || !to) throw new Error('缺少重命名路径');
  const rf = path.resolve(from), rt = path.resolve(to);
  if (rf === rt) return true;
  /* 【纯大小写改名必须放行】Windows 文件系统大小写不敏感：
   * 磁盘上只有 FILE.TXT 时 fs.existsSync('file.txt') 同样返回 true，
   * 于是「批量转小写/转大写」「.JPG → .jpg」这类改名会被下面那句
   * 「目标文件已存在」全部拒绝 —— 报错指向一个并不存在的冲突。
   * 判据：两个路径解析后除了大小写完全相同，即视为同一文件的重命名，
   * 底层 rename 在 NTFS 上能正确改写大小写。
   * 只放宽「忽略大小写后完全相同」的情形；FILE.TXT → OTHER.TXT 仍然拒绝。
   *
   * 【这道闸门必须放在大小写分支之前】
   * 纯大小写改名虽然不会新建路径，但它同样是"往 rt 这个位置写"，
   * 而 rt 与 rf 只差大小写 —— 也就是说如果不拦，就能把一个文件
   * 改成系统目录里某个文件的镜像名（例如把 C:\evil.exe 改成 C:\Windows\x.exe
   * 只有在大小写不同时才走得通，这恰恰是要防的那类事情）。
   * 放在前面既能拦住越权目标，又不会挡住正常的同目录改名
   * （同一目录里的正常改名，rf 与 rt 都在同一个"可写"位置）。 */
  const guard = pathGuard.checkOverwritable(rt);
  if (guard) {
    throw pathGuard.err(guard.code, guard.reason, '请换一个目标路径（不要指向系统目录或盘符根）');
  }
  if (rf.toLowerCase() === rt.toLowerCase()) {
    await fsp.rename(from, to);
    return true;
  }
  if (!overwrite && fs.existsSync(to)) {
    throw new Error('目标文件已存在，为避免覆盖已拒绝：' + to);
  }
  await fsp.rename(from, to);
  return true;
});
// 删除文件/目录。路径来自渲染层，必须设闸门：
//   - 递归删除整个磁盘根目录、系统关键目录、用户主目录 -> 直接拒绝
//   - 非递归删除单个文件时，仍然要挡住关键目录里的文件
// 原实现是 fsp.rm(p, {recursive, force:true}) 裸调用，
// 配合高危开关「文件删除」一旦开启，构造路径就能删掉 C:\Users 或整个 C 盘。
handle(CH.FS.DELETE, async (e, p, recursive) => {
  const bad = pathGuard.checkDeletable(p, recursive);
  if (bad) throw pathGuard.err(bad.code, bad.reason, '如确需删除该路径，请手动在资源管理器中操作');
  await fsp.rm(p, { recursive: !!recursive, force: true });
  return true;
});
handle(CH.FS.OPEN_PATH, async (e, p) => { const err = await shell.openPath(p); if (err) throw new Error(err); return true; });
handle(CH.FS.SHOW_ITEM, (e, p) => { shell.showItemInFolder(p); return true; });
// 只允许 http/https：shell.openExternal 会把任意协议交给系统处理，
// file:// 能直接打开本地文件，smb:// / ms-msdt: 等还能被系统协议处理器放大成提权或 RCE 链。
handle(CH.SHELL.OPEN_URL, async (e, url) => {
  const s = String(url || '').trim();
  let u;
  try { u = new URL(s); } catch (err) { throw new Error('网址格式不正确'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只允许打开 http/https 网址');
  await shell.openExternal(u.toString());
  return true;
});
/* 唯一名生成：实现已抽到 lib/fs-ops.js（与 test-round2-fixes 共享同一份，
 * 避免测试复刻逻辑导致「改了主实现、测试照旧全绿」的假绿）。 */
handle(CH.FS.UNIQUE_PATH, async (e, p) => fsOps.uniquePath(p));

/* recursive walk with cancel + progress */
async function walkDir(root, opts, onItem) {
  const cancel = opts && opts._cancelRef;
  let dirs = 0, files = 0, total = 0;
  async function rec(dir, depth) {
    if (cancel && cancel.canceled) return;
    if (depth > (opts.maxDepth || 64)) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { return; }
    for (const d of entries) {
      if (cancel && cancel.canceled) return;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        dirs++;
        if (onItem) await onItem({ type: 'dir', path: full, depth });
        await rec(full, depth + 1);
      } else if (d.isFile()) {
        let size = 0;
        try { size = (await fsp.stat(full)).size; } catch (err) {}
        files++; total += size;
        if (onItem) await onItem({ type: 'file', path: full, size, depth });
      }
    }
  }
  await rec(root, 0);
  return { dirs, files, total };
}

/* disk/tree analysis job */
handle(CH.FS.SCAN_TREE, async (e, root, opts = {}) => {
  const id = 'scan' + ctx.nextJobSeq();
  const cancelRef = { canceled: false };
  jobs.set(id, { cancel: () => { cancelRef.canceled = true; } });
  setLatestCancelable(() => { cancelRef.canceled = true; });
  /* 【根路径必须先归一，尤其是去掉尾随分隔符】
   * 原实现拿 root **原样**用，而聚合祖先时是这样判包含的：
   *     while (cur.length >= root.length) { ... }
   * 用**字符串长度**做包含判断。当 root = 'D:\foo\'（用户从地址栏复制
   * 过来就带尾斜杠，而占位提示写的正是「如 D:\」）时：
   *   root.length = 8，而 path.dirname('D:\foo\a.txt') = 'D:\foo'（长度 7），
   *   7 >= 8 为假 → 循环一次都不进 → 根目录累计恒为 0。
   * 同理 dirSize 的键是带尾斜杠的原字符串，而 cur 不带，dirSize.has(cur)
   * 永远不命中 —— 不是"算错一点"，而是这一整支统计全是 0。
   * 现在：先 path.resolve 归成绝对路径，再去掉尾随分隔符（盘符根本身除外）；
   * 包含判断改成 cur === root || cur.startsWith(root + sep)。
   * 返回的 root 也用归一后的值，界面显示才与实际统计口径一致。 */
  const scanRoot = normalizeRootForScan(root);
  const dirSize = new Map();
  let files = 0, totalSize = 0, dirCount = 0, lastEmit = 0;
  const topFiles = [];
  try {
    await walkDir(root, { maxDepth: opts.maxDepth || 64, _cancelRef: cancelRef }, async (item) => {
      if (item.type === 'dir') {
        dirCount++;
        dirSize.set(item.path, 0);
      } else {
        files++; totalSize += item.size;
        topFiles.push({ path: item.path, size: item.size });
        if (topFiles.length > 400) { topFiles.sort((a, b) => b.size - a.size); topFiles.length = 200; }
        // aggregate to ancestors
        let cur = path.dirname(item.path);
        while (cur === scanRoot || cur.startsWith(scanRoot + path.sep)
               || cur === path.parse(cur).root) {
          if (dirSize.has(cur)) dirSize.set(cur, dirSize.get(cur) + item.size);
          if (cur === path.parse(cur).root || cur === scanRoot) break;
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
      }
      if (onProgressTick(item)) emitProgress();
    });
    function onProgressTick(item) { return item.type === 'file'; }
    function emitProgress() {
      const now = Date.now();
      if (now - lastEmit > 250) { lastEmit = now; send('job:progress', { id, kind: 'scan', files, size: totalSize }); }
    }
  } finally { jobs.delete(id); }
  topFiles.sort((a, b) => b.size - a.size);
  const topDirs = [...dirSize.entries()].filter(([p]) => p !== scanRoot).map(([p, size]) => ({ path: p, size }))
    .sort((a, b) => b.size - a.size).slice(0, 30);
  if (cancelRef.canceled) throw new Error('已取消');
  return { id, root: scanRoot, totalSize, files, dirCount, topFiles: topFiles.slice(0, 30), topDirs };
});

/* 扫描用的根路径归一：绝对化 + 去尾随分隔符（盘符根本身保留 'X:\' 形态）。 */
function normalizeRootForScan(root) {
  let s = path.resolve(String(root == null ? '' : root));
  const volRoot = path.parse(s).root;
  /* path.resolve 对 'D:\foo\' 已经会去掉尾斜杠；这里额外处理
   * 用户可能传的正斜杠与重复分隔符（'D:/foo//' 之类）。 */
  if (s.length > volRoot.length && /[\\/]$/.test(s)) s = s.slice(0, -1);
  return s;
}

/* empty dirs */
handle(CH.FS.SCAN_EMPTY_DIRS, async (e, root) => {
  const id = 'empty' + ctx.nextJobSeq();
  const cancelRef = { canceled: false };
  jobs.set(id, { cancel: () => { cancelRef.canceled = true; } });
  setLatestCancelable(() => { cancelRef.canceled = true; });
  const empty = [];
  async function rec(dir, depth) {
    if (cancelRef.canceled) return false;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { return false; }
    if (entries.length === 0) { empty.push({ path: dir, depth }); return true; }
    let hasFile = false;
    for (const d of entries) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { const childEmpty = await rec(full, depth + 1); if (!childEmpty) hasFile = true; }
      else hasFile = true;
    }
    if (!hasFile && !cancelRef.canceled) { empty.push({ path: dir, depth }); return true; }
    return false;
  }
  try { await rec(root, 0); } finally { jobs.delete(id); }
  if (cancelRef.canceled) throw new Error('已取消');
  empty.sort((a, b) => b.depth - a.depth);
  return { dirs: empty };
});
handle(CH.FS.DELETE_EMPTY, async (e, dirs) => {
  let deleted = 0; const errors = [];
  /* 【入参必须是字符串数组 —— 这里曾出现过「一个都删不掉还报成功」】
   * 渲染层早期把扫描结果 { path, depth } 对象数组原样发过来，
   * 于是 checkDeletable(obj) 里 String(obj) 变成 "[object Object]" 一路放行，
   * fsp.rmdir(obj) 抛 ERR_INVALID_ARG_TYPE 被 catch 收进 errors，deleted 恒 0。
   * 调用点已改对，这里再加一道显式校验：把「调用方传错类型」当场报出来，
   * 而不是靠 String() 悄悄降级成一个看起来正常、实际毫无意义的路径。 */
  if (!Array.isArray(dirs)) return { deleted: 0, errors: ['参数必须是路径数组'] };
  for (const p of dirs) { // deepest first (caller sorts)
    if (typeof p !== 'string' || !p.trim()) {
      errors.push(`非法参数：${typeof p === 'object' ? JSON.stringify(p) : String(p)}（路径必须是字符串）`);
      continue;
    }
    // 闸门：不允许删系统关键目录 / 盘符根 / 用户主目录本身
    const bad = pathGuard.checkDeletable(p, false);
    if (bad) { errors.push(`${p}: ${bad.reason}`); continue; }
    /* 删空目录。这里【不能】用 recursive:true 的 fsp.rm ——
     * 它会把目录里的内容一起删掉，语义完全不同（会毁数据）。
     * 实测（Node 24.19）：`await fsp.rm(dir, { recursive: false })` 对**目录**
     * 直接抛 ERR_FS_EISDIR（"Path is a directory"），并不会删掉目录；
     * 能删目录的只有 fsp.rmdir 或 recursive:true。
     * 所以要保住「只删空目录」的语义，rmdir 仍是唯一正确选择
     * （它在 Node 24 上只是被标记为将来可能弃用，并未移除）。
     * 降级分支原先又调了一次 rmdir —— 那等于是说「rmdir 没了就用 rmdir」，
     * 根本走不通；改成「先读目录确认确实为空，再尝试删除」的真实路径。 */
    try {
      if (typeof fsp.rmdir === 'function') {
        await fsp.rmdir(p);
      } else {
        // 降级：先读目录，确认确实是空的再删（绝不用 recursive:true）
        const ents = await fsp.readdir(p);
        if (ents.length !== 0) throw new Error('目录非空，跳过');
        await fsp.rm(p); // recursive 默认为 false，只删这个空目录
      }
      deleted++;
    } catch (err) { if (err.code !== 'ENOENT') errors.push(`${p}: ${fmtErr(err)}`); }
  }
  return { deleted, errors };
});

/* junk scan */
async function dirSizeFast(p, maxFiles = 50000) {
  let size = 0, files = 0;
  // 目标本身是文件时直接返回其大小（如缩略图缓存 .db 文件）
  try { const st = await fsp.stat(p); if (st.isFile()) return { size: st.size, files: 1, truncated: false }; } catch (err) { return { size: 0, files: 0, truncated: false }; }
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch (err) { continue; }
    for (const d of entries) {
      const full = path.join(cur, d.name);
      if (d.isDirectory()) stack.push(full);
      else { try { size += (await fsp.stat(full)).size; files++; } catch (err) {} }
      if (files > maxFiles) return { size, files, truncated: true };
    }
  }
  return { size, files, truncated: false };
}
/* 【扫描结果要留下来，clean-junk 只认这一份】
 * 清扫通道的语义是「清临时文件 / 浏览器缓存 / 缩略图缓存」，能力范围很窄。
 * 但早期 renderer 直接把 targets 传回来，主进程只做了三道检查
 * （%TEMP% 白名单、checkDeletable、存在性）—— 没有任何「必须来自本次扫描」的校验。
 * 于是传 D:\\照片 或 C:\\Users\\me\\Documents\\工作 都能过：
 * keepRoot=false 时甚至 fsp.rm(abs, { recursive: true, force: true }) 连根删。
 * 对比 fs:delete 走的是 file-delete 门禁，这个通道的能力范围严重不匹配。
 * 现在缓存上一轮扫描的候选集合，clean-junk 只接受集合内的路径。 */
let junkScanCache = { at: 0, paths: new Set() };
/* 清理通道的路径比较键：绝对路径 + 统一分隔符 + 小写
 * （Windows 路径不区分大小写，纯字符串比较会被大小写变体绕过）。 */
function normForJunk(p) {
  try { return path.resolve(p).replace(/\//g, '\\').toLowerCase(); }
  catch (e) { return String(p == null ? '' : p).toLowerCase(); }
}
handle(CH.FS.SCAN_JUNK, async () => {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const cands = [
    // 临时文件：**只扫本应用自己的产物**（hehe- 前缀白名单）。
    // 原实现把整个 os.tmpdir() 当成一个清理目标，keepRoot 模式下会把 %TEMP%
    // 下所有条目删光——实测本机 984 个条目里 908 个属于别的程序
    // （浏览器、Office、安装程序正在用的临时文件），全被误删。
    // v0.0.10 修过"清空整个 %TEMP%"，但这条路径绕过了那个白名单。
    { id: 'temp', label: '本应用临时文件', path: os.tmpdir(), ownOnly: true },
    { id: 'chrome', label: 'Chrome 浏览器缓存', path: path.join(local, 'Google', 'Chrome', 'User Data'), pattern: /Cache|Code Cache|GPUCache/ },
    { id: 'edge', label: 'Edge 浏览器缓存', path: path.join(local, 'Microsoft', 'Edge', 'User Data'), pattern: /Cache|Code Cache|GPUCache/ },
    { id: 'thumb', label: '缩略图缓存', path: path.join(local, 'Microsoft', 'Windows', 'Explorer'), pattern: /thumbcache|thumbcache_.*\.db/i }
  ];
  const out = [];
  for (const c of cands) {
    if (c.ownOnly) {
      // 只列本应用自己的临时产物
      let size = 0, files = 0;
      const targets = [];
      const entries = await fsp.readdir(c.path).catch(() => []);
      for (const n of entries) {
        if (!isOwnTempName(n)) continue;   // 白名单：绝不动别人的东西
        const full = path.join(c.path, n);
        const r = await dirSizeFast(full);
        size += r.size; files += r.files;
        targets.push(full);
      }
      if (files > 0) out.push({ id: c.id, label: c.label, path: c.path, size, files, targets });
      continue;
    }
    if (c.pattern) {
      // aggregate matching subdirs
      let size = 0, files = 0;
      const stack = [c.path];
      const targets = [];
      while (stack.length) {
        const cur = stack.pop();
        let entries; try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch (err) { continue; }
        for (const d of entries) {
          const full = path.join(cur, d.name);
          if (d.isDirectory()) { if (c.pattern.test(d.name)) targets.push(full); else stack.push(full); }
          else if (c.pattern.test(d.name)) targets.push(full);
        }
      }
      for (const t of targets) { const r = await dirSizeFast(t); size += r.size; files += r.files; }
      if (files > 0) out.push({ id: c.id, label: c.label, path: c.path, size, files, targets });
    } else {
      const r = await dirSizeFast(c.path);
      if (r.files > 0) out.push({ id: c.id, label: c.label, path: c.path, size: r.size, files: r.files, targets: [c.path] });
    }
  }
  /* 记下本轮扫描命中的全部候选路径，供 fs:clean-junk 校验来源。
   * 用绝对路径归一后的形态比较（大小写不敏感，符合 Windows 路径语义）。 */
  const cachePaths = new Set();
  for (const g of out) for (const t of (g.targets || [])) cachePaths.add(normForJunk(t));
  junkScanCache = { at: Date.now(), paths: cachePaths };
  return out;
});
handle(CH.FS.CLEAN_JUNK, async (e, targets, keepRoot) => {
  let cleaned = 0, bytes = 0; const errors = [];
  const tmpRoot = path.resolve(os.tmpdir());
  if (!Array.isArray(targets)) return { cleaned: 0, bytes: 0, errors: ['参数必须是路径数组'] };
  for (const t of targets) {
    try {
      if (typeof t !== 'string' || !t.trim()) { errors.push(`非法参数：${String(t)}（路径必须是字符串）`); continue; }
      const abs = path.resolve(t);
      /* 【只接受本次扫描命中的候选，其他一律拒绝】
       * 这是能力范围的边界，不是可选的"额外保险"：
       * 这个通道叫「清理垃圾」，它该动的只有临时文件、浏览器缓存、缩略图缓存。
       * 没有这道校验时，传入任意用户目录都会被递归删除（见上面的注释）。
       * 缓存为空（没扫过 / 进程刚起来）时一律拒绝 —— 没有扫描结果就没有清理依据。 */
      if (!junkScanCache.paths.size) {
        errors.push(`${t}: 没有扫描结果作为依据，请先执行扫描`);
        continue;
      }
      if (!junkScanCache.paths.has(normForJunk(abs))) {
        errors.push(`${t}: 不在本次扫描结果内，拒绝清理（该功能只能清扫描出来的垃圾）`);
        continue;
      }
      // 最后一道防线：绝不允许把 %TEMP% 整体（或其子目录）当作清理目标。
      // %TEMP% 是全机器共享的，里面有别的程序正在用的文件。
      // 允许的只有「本应用自己的产物」这一项。
      if (abs === tmpRoot || abs.startsWith(tmpRoot + path.sep)) {
        const base = path.basename(abs);
        if (!isOwnTempName(base)) {
          errors.push(`${t}: 拒绝清理非本应用产物（%TEMP% 是全机器共享的）`);
          continue;
        }
      }
      // 系统关键目录也不许动
      const crit = pathGuard.checkDeletable(abs, true);
      if (crit) { errors.push(`${t}: ${crit.reason}`); continue; }
      const before = (await dirSizeFast(abs)).size;
      const st = await fsp.stat(abs).catch(() => null);
      if (st && st.isFile()) {
        await fsp.rm(abs, { force: true }); // 文件目标（缩略图缓存）直接删除
      } else if (keepRoot) {
        const entries = await fsp.readdir(abs).catch(() => []);
        for (const n of entries) await fsp.rm(path.join(abs, n), { recursive: true, force: true });
      } else {
        /* 【keepRoot=false 的「连根删」分支已移除】
         * 唯一调用方（js/tools/junk-clean.js）恒传 true，这个分支从来没被用过，
         * 而它是这个通道里最危险的一段（递归删除传入的整个目录）。
         * 删掉它，把这个能力范围外的入口直接消灭，而不是靠"没人传 false"。
         * 如将来真需要删整个根，请走 fs:delete（那条有完整的删除门禁）。 */
        errors.push(`${t}: 不支持删除根目录本身（只清理其中的内容）`);
        continue;
      }
      cleaned++; bytes += before;
    } catch (err) { errors.push(`${t}: ${fmtErr(err)}`); }
  }
  return { cleaned, bytes, errors };
});

/* hash / encrypt / split / dedupe */
const HASH_ALGOS = ['md5', 'sha1', 'sha256', 'sha512'];
/* 单算法通道 fs:hash-file 已移除：渲染层早就改用 -multi 版本一次读盘算多个
 * 摘要（校验 1GB 文件要读 4GB 的老问题），全项目没有调用方了。 */
/* 多算法：**一次读盘**同时算 md5/sha1/sha256/sha512。
 *
 * 【为什么需要】原渲染层的文件校验页对同一个文件连续调用 4 次
 * `fs:hash-file`，每次都完整读一遍盘 —— 校验一个 1GB 文件要读 4GB。
 * 这里改成一次流式读取、多个 hasher 并行 update，磁盘 IO 降到 1/4。
 *
 * 【顺带修】原来用 `fs.statSync(p)` 在主进程同步阻塞：大文件操作期间
 * 整个 UI（含 1.5 秒一次的 sys:stats 推送）都会卡住。改成 await fsp.stat。 */
async function hashFileMulti(p, algos) {
  const list = (Array.isArray(algos) && algos.length ? algos : ['sha256']);
  for (const a of list) if (!HASH_ALGOS.includes(a)) throw new Error('不支持的算法: ' + a);
  const uniq = [...new Set(list)];
  const hashers = Object.fromEntries(uniq.map((a) => [a, crypto.createHash(a)]));
  const st = await fsp.stat(p);          // 异步，不阻塞事件循环
  return await new Promise((resolve, reject) => {
    let done = 0, last = 0;
    const rs = fs.createReadStream(p, { highWaterMark: 1 << 20 });
    rs.on('data', (chunk) => {
      for (const a of uniq) hashers[a].update(chunk);
      done += chunk.length;
      if (Date.now() - last > 200) {
        last = Date.now();
        send('job:progress', { id: p, kind: 'hash', done, total: st.size });
      }
    });
    rs.on('end', () => {
      const hex = {};
      for (const a of uniq) hex[a] = hashers[a].digest('hex');
      resolve({ hex, size: st.size });
    });
    rs.on('error', reject);
  });
}
handle(CH.FS.HASH_FILE_MULTI, async (e, p, algos) => hashFileMulti(p, algos));

/* 单算法通道 fs:hash-text 已移除，理由同上：文本页走 -multi 版本。 */
// 一次算多个算法：文本页每次输入都要出 3 个摘要，逐个 invoke 会有 3 次 IPC 往返
handle(CH.FS.HASH_TEXT_MULTI, (e, text, algos = ['md5', 'sha1', 'sha256']) => {
  const out = {};
  for (const algo of algos) {
    if (!HASH_ALGOS.includes(algo)) continue;
    out[algo] = crypto.createHash(algo).update(String(text ?? ''), 'utf8').digest('hex');
  }
  return out;
});

const ENC_MAGIC = Buffer.from('HEHEENC1');
function deriveKey(password, salt) { return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }); }
async function cryptStream(p, outPath, password, decrypt) {
  const st = await fsp.stat(p);
  if (path.resolve(p) === path.resolve(outPath)) throw new Error('输出路径不能与源文件相同');
  // Windows 大小写不敏感 + 结尾点/空格差异：realpath 归一后按小写比较，防止同名变体绕过
  let sameFile = false;
  try {
    const rp = fs.realpathSync(p), ro = fs.realpathSync(path.dirname(outPath)) + path.sep + path.basename(outPath);
    sameFile = rp.toLowerCase() === ro.toLowerCase();
  } catch (e) { /* 输出目录尚不存在等情况按字符串比较兜底 */ }
  if (sameFile) throw new Error('输出路径不能与源文件相同');
  let srcStart = 0, cipher, header = null;
  if (!decrypt) {
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(16);
    header = Buffer.concat([ENC_MAGIC, salt, iv]);
    cipher = crypto.createCipheriv('aes-256-cbc', deriveKey(password, salt), iv);
  } else {
    // 先读取 40 字节文件头，再从第 40 字节起进入解密管道
    /* 【最小合法长度是 40 + 16 = 56，不是 64】
     * 文件头固定 40 字节（8 魔数 + 16 salt + 16 iv），其后是一个 AES-CBC 密文。
     * PKCS#7 一定会补齐，所以哪怕原文是空文件（0 字节）也会产出整整一个 16 字节块。
     * 早期这里写死 64，于是「加密 0~15 字节的文件」得到的 56 字节密文被判成
     * 「文件不完整，可能下载时被截断」—— 加密是成功的，解密却永远拒绝，
     * 用户会以为文件坏了、转而去找别的工具重下。实测 15 字节以内全部复现。 */
    const MIN_ENC_SIZE = 40 + 16;
    if (st.size < MIN_ENC_SIZE) throw new Error('文件不完整：加密文件至少应有 ' + MIN_ENC_SIZE + ' 字节（当前 ' + st.size + ' 字节），可能下载或复制时被截断');
    const fh = await fsp.open(p, 'r');
    const head = Buffer.alloc(40);
    try {
      const { bytesRead } = await fh.read(head, 0, 40, 0);
      if (bytesRead < 40) throw new Error('文件不完整：无法读取完整的加密文件头（只读到 ' + bytesRead + ' 字节）');
    } finally { await fh.close().catch(() => {}); }
    if (!head.subarray(0, 8).equals(ENC_MAGIC)) throw new Error('不是有效的核核加密文件（缺少文件头）');
    cipher = crypto.createDecipheriv('aes-256-cbc', deriveKey(password, head.subarray(8, 24)), head.subarray(24, 40));
    srcStart = 40;
  }
  const rs = fs.createReadStream(p, { highWaterMark: 1 << 20, start: srcStart });
  // 先写同目录临时文件，成功后才改名到 outPath。
  // 原来直接写 outPath：失败时 catch 里 rmSync(outPath) 会把**用户原本就存在**的
  // 同名文件一起删掉（探测脚本 t7 复现过：解密失败后用户的重要文件消失）。
  const cryptTmp = tempNames.cryptTmp(outPath);
  const ws = fs.createWriteStream(cryptTmp);
  if (header) ws.write(header);
  let done = 0;
  const total = Math.max(1, st.size - srcStart);
  rs.on('data', (chunk) => { done += chunk.length; send('job:progress', { id: p, kind: 'crypt', done, total }); });
  try {
    await new Promise((resolve, reject) => {
      require('stream').pipeline(rs, cipher, ws, (err) => (err ? reject(err) : resolve()));
    });
    await fsp.rename(cryptTmp, outPath);
  } catch (err) {
    // 只清理我们自己的临时文件；目标位置的原有文件保持不动
    try { fs.rmSync(cryptTmp, { force: true }); } catch (e) {}
    if (decrypt && /bad decrypt|BAD_DECRYPT|wrong final block/.test(String(err.message))) throw new Error('解密失败：密码错误或文件已损坏');
    throw err;
  }
  return { outPath, size: (await fsp.stat(outPath)).size };
}
handle(CH.FS.ENCRYPT_FILE, async (e, p, outPath, password) => {
  if (!password) throw new Error('请输入密码');
  return await cryptStream(p, outPath, password, false);
});
handle(CH.FS.DECRYPT_FILE, async (e, p, outPath, password) => {
  return await cryptStream(p, outPath, password, true);
});

handle(CH.FS.SPLIT_FILE, async (e, p, chunkMB, outDir) => {
  // 异步 stat：大文件分片期间不能阻塞主进程事件循环（UI 与 sys:stats 都要响应）
  const st = await fsp.stat(p);
  const chunkSize = Math.max(1, chunkMB) * 1024 * 1024;
  const base = path.basename(p);
  // 空文件没有可分割的内容：parts 记为 1 并与实际产生的 part1 保持一致，
  // 否则清单 parts=0 而磁盘上留着 0 字节 part1，合并时会按 0 片处理，分片成为孤儿文件。
  const parts = Math.max(1, Math.ceil(st.size / chunkSize));
  const pad = String(parts).length;
  await fsp.mkdir(outDir, { recursive: true });
  let realParts = 0;      // 实际产出的分片数
  let writtenBytes = 0;   // 实际写入的总字节数
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(p, { highWaterMark: 1 << 20 });
    let idx = 1, ws = null, done = 0, pausedFor = null;
    /* 【本次产出的分片路径】失败时要逐个清掉，否则输出目录里留下半截分片，
     * 用户下次分割会撞上 flags:'wx' 的 EEXIST 而永远失败。 */
    const madePaths = [];
    /* 【统一失败收口：读流必须销毁，否则 fd 挂到进程退出】
     * 原实现里 ws 的 error 直接 reject —— 既没 rs.destroy() 也没清半截分片。
     * 触发点很常见：默认输出目录是「源文件 + '.parts'」，同一个文件分两次
     * 必然命中 flags:'wx' 的 EEXIST。
     * 更隐蔽的是：如果 reject 发生在**背压暂停之后**，那个 drain 监听挂在
     * 一个已经出错的 ws 上，永远不会触发，rs 就再也不 resume ——
     * 读流停在暂停态、fd 不释放，直到进程退出。 */
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try { rs.destroy(); } catch (x) {}
      try { if (ws) ws.destroy(); } catch (x) {}
      for (const fp of madePaths) { try { fs.unlinkSync(fp); } catch (x) {} }
      reject(e);
    };
    // 分片必须排他创建（flags: 'wx'）：默认的 'w' 会截断已存在的同名分片，
    // 用户重复分割同一个文件时，旧分片被静默覆盖，合并结果就是新旧混合。
    const openPart = () => {
      const partPath = path.join(outDir, `${base}.part${String(idx).padStart(pad, '0')}`);
      ws = fs.createWriteStream(partPath, { flags: 'wx' });
      /* 【只登记"确实由我们创建成功"的分片】
       * createWriteStream 是异步打开的，'error' 可能要过一会儿才到。
       * 早期这里在 createWriteStream 之后立刻 push，于是 EEXIST 的情况下
       * 那个**别人已有的同名分片**也被当成"本次产出"，fail() 会把它删掉 ——
       * 用户明明只想"中止、别覆盖"，结果旧分片被清理掉了，这正是 wx 要防的事。
       * 现在等 'open' 事件（文件确实建成了）才登记。 */
      ws.on('open', () => { if (!settled) madePaths.push(partPath); });
      ws.on('error', (e) => {
        if (e && e.code === 'EEXIST') {
          fail(new Error('目标目录已存在同名分片：' + path.basename(partPath) + '（为避免覆盖已中止，请换个输出目录或先清理旧分片）'));
          return;
        }
        fail(e); // 磁盘满/权限错误也让 Promise 落定，并清掉半截分片
      });
      realParts = idx;
    };
    openPart();
    rs.on('data', (chunk) => {
      if (settled) return;
      let off = 0;
      while (off < chunk.length) {
        if (ws.bytesWritten >= chunkSize) { ws.end(); idx++; openPart(); if (pausedFor && pausedFor !== ws) { pausedFor = null; rs.resume(); } }
        const n = Math.min(chunk.length - off, chunkSize - ws.bytesWritten);
        const piece = chunk.subarray(off, off + n); off += n;
        writtenBytes += n;
        if (!ws.write(piece)) {
          // 背压：慢盘上防止内存无界堆积。
          // 注意 rs.pause() 只阻止后续 'data' 事件，当前这块 chunk 的 while 仍在继续写，
          // 所以每次 write 返回 false 都会走到这里 —— 必须判断是否已经为这个 ws 注册过
          // drain 监听，否则同一个 ws 上的监听器会无限累积（MaxListenersExceededWarning，
          // 且触发 drain 时会重复注册/重复 resume）。
          if (pausedFor !== ws) {
            pausedFor = ws;
            rs.pause();
            ws.once('drain', () => { if (pausedFor === ws) { pausedFor = null; rs.resume(); } });
          }
        }
      }
      done += chunk.length; send('job:progress', { id: p, kind: 'split', done, total: st.size });
    });
    rs.on('end', () => { ws.end(); ws.on('finish', () => { if (!settled) { settled = true; resolve(); } }); });
    rs.on('error', (e) => fail(e));
  });
  /* 源文件在分割期间被追加/截断会让「清单声明」与「磁盘实际」脱节：
     清单说 3 片、磁盘却有 5 片，合并时只读前 3 片 —— 合并结果少 20MB，
     而 UI 还显示「合并完成」。这里直接核对实际字节数与起始大小。 */
  if (writtenBytes !== st.size) {
    throw new Error(`源文件在分割期间发生变化（开始时 ${st.size} 字节，实际写出 ${writtenBytes} 字节），已中止。请重新分割。`);
  }
  // 分片数以磁盘实际为准，避免清单声明值与磁盘不符
  const finalParts = realParts || parts;
  const manifest = { tool: 'hehe-split', name: base, size: st.size, chunkSize, parts: finalParts };
  const manifestPath = path.join(outDir, `${base}.manifest.hehe.json`);
  // 清单必须原子写：它是合并分片的唯一索引。直接 writeFile 中途失败会把
  // 原本有效的清单改成非法 JSON，分片还在但再也合不回来了。
  await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { parts: finalParts, manifestPath, outDir, chunkSize };
});
handle(CH.FS.MERGE_PARTS, async (e, pickedPath, outPath) => {
  let manifestPath;
  if (pickedPath.endsWith('.manifest.hehe.json')) manifestPath = pickedPath;
  else {
    const m = pickedPath.match(/^(.*)\.part\d+$/);
    if (!m) throw new Error('请选择分片文件（.partNNN）或清单文件');
    manifestPath = m[1] + '.manifest.hehe.json';
  }
  const man = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  if (man.tool !== 'hehe-split') throw new Error('清单文件无效');
  const dir = path.dirname(manifestPath);
  // man.name 来自清单文件（内容可被构造），必须限制在清单所在目录内，
  // 否则 .. 分片名能把读取路径指向目录外。
  const safeName = pathGuard.resolveInside(dir, String(man.name || '').replace(/[\\/]/g, path.sep));
  /* 清单里的 parts / size 也必须校验：
     - parts 少了会把磁盘上真实存在的分片静默丢掉（合并结果缺数据，UI 还说"完成"）
     - size 是非数值时 UI 会显示离谱的体积
     - parts 无上限时能触发上亿次 open 调用 */
  const parts = Number(man.parts);
  if (!Number.isInteger(parts) || parts < 1 || parts > 100000) {
    throw new Error('清单文件损坏：分片数量非法（' + String(man.parts) + '）');
  }
  const declSize = Number(man.size);
  if (!Number.isFinite(declSize) || declSize < 0) {
    throw new Error('清单文件损坏：原始大小非法（' + String(man.size) + '）');
  }
  // 磁盘上实际有几个分片？少于清单声明说明中间丢片，必须明确拒绝而不是少合几片。
  const partBase = path.basename(safeName);
  let onDisk = 0;
  try {
    const names = await fsp.readdir(dir);
    const re = new RegExp('^' + partBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.part(\\d+)$');
    for (const n of names) if (re.test(n)) onDisk++;
  } catch (e) {}
  if (onDisk !== 0 && onDisk < parts) {
    throw new Error(`分片不完整：清单声明 ${parts} 片，目录里只有 ${onDisk} 片`);
  }
  // 默认输出「原名.merged.扩展名」，且被占用时自动加序号，避免覆盖原始文件
  let finalOut = outPath;
  if (!finalOut) {
    const ext = path.extname(safeName);
    const stem = path.basename(safeName, ext);
    finalOut = path.join(dir, `${stem}.merged${ext}`);
    for (let i = 1; i < 1000 && fs.existsSync(finalOut); i++) finalOut = path.join(dir, `${stem}.merged(${i})${ext}`);
  } else {
    // 用户显式指定了输出路径：仍要挡住系统关键目录
    const bad = pathGuard.checkOverwritable(finalOut);
    if (bad) throw pathGuard.err(bad.code, bad.reason);
    // 已存在的文件不静默覆盖，改名加序号（与默认路径的行为一致）
    if (fs.existsSync(finalOut)) {
      const ext = path.extname(finalOut), stem = path.basename(finalOut, ext);
      for (let i = 1; i < 1000; i++) {
        const cand = path.join(path.dirname(finalOut), `${stem}.merged(${i})${ext}`);
        if (!fs.existsSync(cand)) { finalOut = cand; break; }
      }
    }
  }
  await fsp.mkdir(path.dirname(finalOut), { recursive: true });
  // 先写到临时名，全部合并成功后再改名到 finalOut。
  // 否则中途遇到缺失/损坏的分片，最终文件名下会留下一个「看起来正常」的半截文件，
  // 用户拿去用才发现内容不全（探测脚本 t8 复现过：4000 字节的残留文件）。
  const partTmp = fsOps.tempPathFor(finalOut, 'merging');
  try {
    let mergedBytes = 0;
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(partTmp);
      ws.on('error', reject);
      let i = 1, done = 0, failed = false;
      const fail = (e) => { if (!failed) { failed = true; try { ws.destroy(); } catch (err) {} reject(e); } };
      const next = () => {
        if (failed) return;
        if (i > parts) { ws.end(); ws.on('finish', resolve); return; }
        const part = path.join(dir, `${path.basename(safeName)}.part${String(i).padStart(String(parts).length, '0')}`);
        const rs = fs.createReadStream(part);
        rs.on('data', (c) => { done += c.length; mergedBytes += c.length; send('job:progress', { id: finalOut, kind: 'merge', done, total: declSize }); });
        rs.on('end', () => { i++; next(); });
        rs.on('error', (e) => fail(new Error(`分片缺失或无法读取：${path.basename(part)}`)));
        rs.pipe(ws, { end: false });
      };
      next();
    });
    // 合并后的字节数必须与清单声明一致：不一致说明分片被改过或清单过期，
    // 宁可报错也不要交出一个"看起来正常"的残缺文件。
    if (declSize > 0 && mergedBytes !== declSize) {
      throw new Error(`合并结果大小不符：实际 ${mergedBytes} 字节，清单声明 ${declSize} 字节（分片可能已被修改）`);
    }
    await fsp.rename(partTmp, finalOut);
  } catch (err) {
    await fsp.rm(partTmp, { force: true }).catch(() => {});
    throw err;
  }
  // 返回真实体积，而不是清单里的声明值
  let realSize = 0;
  try { realSize = (await fsp.stat(finalOut)).size; } catch (e) {}
  return { outPath: finalOut, size: realSize, parts };
});

handle(CH.FS.DEDUPE, async (e, root, opts = {}) => {
  const mode = opts.mode || 'content';
  const cancelRef = { canceled: false };
  const id = 'dedupe' + ctx.nextJobSeq();
  jobs.set(id, { cancel: () => { cancelRef.canceled = true; } });
  setLatestCancelable(() => { cancelRef.canceled = true; });
  try {
    const byKey = new Map();
    let scanned = 0, lastEmit = Date.now();
    await walkDir(root, { _cancelRef: cancelRef }, async (item) => {
      if (item.type !== 'file') return;
      scanned++;
      const now = Date.now();
      if (now - lastEmit > 300) { lastEmit = now; send('job:progress', { id, kind: 'dedupe', files: scanned }); }
      let key;
      if (mode === 'name') key = path.basename(item.path).toLowerCase();
      else if (mode === 'size') key = 's' + item.size;
      else key = 's' + item.size;
      if (mode !== 'name' && item.size === 0 && mode === 'content') return;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(item.path);
    });
    if (cancelRef.canceled) throw new Error('已取消');
    let candidates = [...byKey.values()].filter(a => a.length > 1);
    if (mode === 'content') {
      // quick filter: head+tail hash
      const quick = new Map();
      for (const group of candidates) {
        for (const f of group) {
          if (cancelRef.canceled) throw new Error('已取消');
          let k = 'err' + f;
          try {
            // 用异步文件句柄读头尾 8KB，避免大目录查重时阻塞主进程
            const fh = await fsp.open(f, 'r');
            try {
              const sz = (await fh.stat()).size;
              const len = Math.min(8192, sz);
              const buf = Buffer.alloc(len * 2);
              await fh.read(buf, 0, len, 0);
              await fh.read(buf, len, len, Math.max(0, sz - len));
              k = crypto.createHash('md5').update(buf).digest('hex');
            } finally { await fh.close(); }
          } catch (err) { /* 文件被删/锁定：跳过快筛 */ }
          if (!quick.has(k)) quick.set(k, []);
          quick.get(k).push(f);
        }
      }
      candidates = [...quick.values()].filter(a => a.length > 1);
      // full hash
      const full = new Map();
      for (const group of candidates) {
        for (const f of group) {
          if (cancelRef.canceled) throw new Error('已取消');
          const h = crypto.createHash('md5');
          await new Promise((res, rej) => {
            fs.createReadStream(f).on('data', c => h.update(c)).on('end', res).on('error', rej);
          });
          const k = h.digest('hex');
          if (!full.has(k)) full.set(k, []);
          full.get(k).push(f);
        }
      }
      candidates = [...full.values()].filter(a => a.length > 1);
    }
    const groups = [];
    for (const files of candidates) {
      // 按名称分组时组内各文件大小可以不同，必须逐个统计，否则「可省空间」会失真。
      // 保守估计：删掉除「最大一份」外的其余文件，因此可省 = 组内总和 - 最大文件大小。
      const sizes = [];
      for (const f of files) {
        const st = await fsp.stat(f).catch(() => null);
        sizes.push(st ? st.size : 0);
      }
      const groupSize = sizes.reduce((a, b) => a + b, 0);
      /* 【不能用 Math.max(...sizes)】sizes 收的是整棵树的文件大小，
       * 查重一个大目录很容易过十万项。实测
       *   Math.max(...new Array(130000).fill(1))
       * 直接抛 RangeError: Maximum call stack size exceeded（13 万之前正常）。
       * 过线即整轮查重失败，而报错跟"文件太多"毫无关系，用户根本猜不到原因。
       * reduce 版没有参数个数上限。 */
      const maxSize = sizes.reduce((a, b) => (a > b ? a : b), 0);
      groups.push({
        size: maxSize, totalSize: groupSize, waste: Math.max(0, groupSize - maxSize),
        hash: mode === 'content' ? 'md5' : mode, files, sizes
      });
    }
    groups.sort((a, b) => b.waste - a.waste);
    return { groups, mode, totalWasted: groups.reduce((s, g) => s + g.waste, 0) };
  } finally { jobs.delete(id); }
});

/* zip */
handle(CH.ZIP.COMPRESS, async (e, paths, outZip) => {
  // 输出文件不得静默覆盖（outZip 来自渲染层，IPC 本身也要设闸门）
  const bad = pathGuard.checkOverwritable(outZip);
  if (bad) throw pathGuard.err(bad.code, bad.reason);
  if (fs.existsSync(outZip)) throw new Error('输出文件已存在，为避免覆盖已拒绝：' + outZip);
  const zip = new AdmZip();
  /* 【目录也要做重名编号，不能只给文件编号】
   * 早期目录直接用 `zip.addLocalFolder(p, path.basename(p))`：把
   *   D:\项目A\docs  和  E:\项目B\docs
   * 一起拖进来时，两者的条目前缀都是 `docs/`，adm-zip 会按条目名合并，
   * 于是其中一份 docs\x.txt 被另一份同名文件覆盖 —— 实测压完只剩一份，
   * 返回结果还报「压缩完成」，属于静默丢数据。文件那条支路早就加了 used
   * 去重，目录这条漏了。这里对顶层目录名用同一套 used 集合编号。 */
  const used = new Set();
  const uniqEntryDir = (base) => {
    if (!used.has(base.toLowerCase())) { used.add(base.toLowerCase()); return base; }
    for (let i = 1; i < 10000; i++) {
      const cand = `${base}(${i})`;
      if (!used.has(cand.toLowerCase())) { used.add(cand.toLowerCase()); return cand; }
    }
    return base + '(' + Date.now() + ')';
  };
  for (const p of paths) {
    const st = await fsp.stat(p);
    if (st.isDirectory()) {
      zip.addLocalFolder(p, uniqEntryDir(path.basename(p)));
    } else {
      // addLocalFile 不传 zipPath 时条目名 = basename。两个不同目录下的同名文件
      // 会命中同一个条目名，adm-zip 直接覆盖前一个 —— 压缩完只剩一份，静默丢数据。
      // 这里重名时自动加序号，保证每个源文件都有条目。
      const base = path.basename(p);
      let entryName = base;
      const stem = path.basename(base, path.extname(base));
      const ext = path.extname(base);
      for (let i = 1; used.has(entryName.toLowerCase()); i++) entryName = `${stem}(${i})${ext}`;
      used.add(entryName.toLowerCase());
      zip.addLocalFile(p, '', entryName);
    }
  }
  if (!zip.getEntries().length) throw new Error('没有可压缩的文件');
  zip.writeZip(outZip);
  return { outZip, size: (await fsp.stat(outZip)).size };
});
handle(CH.ZIP.EXTRACT, async (e, zipPath, outDir) => {
  const zip = new AdmZip(zipPath);
  /* 安全预检：先枚举全部条目并做静态判定，通过后才真正写盘。
     原实现直接 extractAllTo(outDir, true)：overwrite=true（静默覆盖同名文件）
     且没有任何预检，构造过的压缩包可以穿越写出目标目录、用 ADS 藏内容、
     用设备名/UNC 写到任意位置。详见 lib/archive-guard.js。 */
  const raw = zip.getEntries().map((en) => ({
    name: en.entryName,
    isDir: en.isDirectory,
    size: en.header && typeof en.header.size === 'number' ? en.header.size : 0,
    // 压缩大小用于压缩比判定：zip bomb 的特征就是一个极小的压缩体
    // 声称解压出极大内容（adm-zip 会按声明 size 一次性 Buffer.alloc）
    compressedSize: en.header && typeof en.header.compressedSize === 'number' ? en.header.compressedSize : 0,
    isSymlink: false,   // AdmZip 未暴露 Unix 模式，ZIP 符号链接由下方前缀判定兜底
    isHardLink: false
  }));
  const verdict = archiveGuard.inspectEntries(raw);
  /* archive-guard.inspectEntries() 的契约是「要么 return {ok:true}，要么直接 throw」，
   * 不存在 ok:false 的返回。所以下面这行是**死代码**（永不成立），
   * 保留只为防御将来 guard 改成返回 {ok:false} —— 那时这一行会自动生效。
   * 不要因为「看起来没用到」而删掉，也不要误以为这里有失败返回值分支。 */
  if (!verdict.ok) throw new Error('压缩包预检未通过');

  await fsp.mkdir(outDir, { recursive: true });
  /* 两个必须同时成立的性质：
     1) 同名不覆盖（用户原有文件不能被归档内容冲掉）
     2) 目录条目与文件条目路由到同一父目录
        若目录 sub/ 因冲突改名成 sub(1)/，而文件 sub/b.txt 仍写进原来的 sub/，
        归档内容就混进了用户已有目录。
    所以：目录条目一律复用（不编号），只有文件在冲突时加序号。
     3) 中途失败要回滚，不能留半成品（与 seven:extract 行为一致） */
  const dirSet = new Set();
  const dirFor = async (rel) => {
    const abs = pathGuard.resolveInside(outDir, rel);
    if (!dirSet.has(abs)) { await fsp.mkdir(abs, { recursive: true }); dirSet.add(abs); }
    return abs;
  };
  const writtenPaths = [];
  try {
    let written = 0;
    for (const en of zip.getEntries()) {
      const name = archiveGuard.normalizeName(en.entryName);
      if (!name || name === '.' || name === './') continue;
      if (en.isDirectory) { await dirFor(name); continue; }
      const parentRel = path.dirname(name);
      const parentAbs = parentRel && parentRel !== '.' ? await dirFor(parentRel) : path.resolve(outDir);
      const target = await uniqueTarget(parentAbs, path.basename(name));
      const data = en.getData();   // 可能抛 CRC 错，此刻尚未落盘
      await fsp.writeFile(target, data);
      writtenPaths.push(target);
      written++;
    }
    return { outDir, entries: written };
  } catch (err) {
    for (const p of writtenPaths) { try { await fsp.rm(p, { force: true }); } catch (e) {} }
    throw err;
  }
});
  /* ======================= 供 main.js 复用的实现 =======================
   * 这些函数在被搬走的这段代码里定义，但域外（main.js 的其他域）也在用。
   * 与其把它们复制一份回去（两份实现迟早分叉），不如反向导出、调用方改从这里取。
   * 这正是「搬」而不是「改」：函数体一个字节都没动。 */
  return {
    writeFileAtomic, dirSizeFast, walkDir, uniqueTarget, isOwnTempName,
  };
};
