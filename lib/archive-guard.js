'use strict';
/* 归档安全预检：在写入任何字节之前，先拒绝危险条目。
 *
 * 借鉴自 YourCatFileAssistant 的归档设计：解压前必须完整预检路径与条目类型，
 * 而不是"边解边写、出问题再清理"。原实现用 AdmZip 的 extractAllTo(dir, true)
 * （overwrite=true、无任何预检），恶意压缩包可以：
 *   - ..\..\ 穿越写出目标目录（覆盖系统文件）
 *   - 用 C:\ 绝对路径、\\server\share UNC 写到任意位置
 *   - 用 name.txt:stream 的 NTFS 附加数据流藏内容（正常浏览看不到）
 *   - 用 CON/PRN/AUX/NUL/COM1 等设备名让写入行为异常
 *   - 用符号链接/硬链接指向目录外
 *   - 同名不同大小写互相覆盖（Windows 不区分大小写）
 *   - 用海量条目 / 超深目录 / 超大声明尺寸耗尽磁盘与内存（zip bomb）
 *
 * 本模块只做纯判定，不碰文件系统（便于单测）。真正的写入在调用方进行。
 */

const path = require('path');

/* Windows 保留设备名：无论扩展名如何，写到这些名字都会命中设备而非文件。 */
const DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/* 默认限额。数值参考对方的工业生产阈值，可按需在调用处覆盖。
 *
 * maxTotalBytes 从 100 GiB 收紧到 8 GiB：
 * adm-zip 的 en.getData() 会按「中央目录里声明的 size」先 Buffer.alloc(size)，
 * 所以这个声明值直接等于内存分配量。原来的 100 GiB 意味着一份几十个条目的
 * 小压缩包就能骗出上百 GB 分配，进程直接被打死。
 * 8 GiB 对正常归档仍足够，同时把内存放大的上限压到可接受范围。 */
const DEFAULT_LIMITS = {
  maxEntries: 100000,          // 条目数上限
  maxDepth: 64,                // 目录层数上限
  maxTotalBytes: 8 * 1024 * 1024 * 1024,   // 累计解压 8 GiB
  maxRatio: 1000,              // 单条目的最大压缩比（解压后/压缩前）
  maxEntryBytes: 2 * 1024 * 1024 * 1024    // 单个条目的最大声明尺寸 2 GiB
};

/**
 * 带结构化字段的 Error。
 * @typedef {Error & {code?:string, advice?:string}} CodedError
 */

/**
 * 造一个带 code/advice 的 Error。
 * 这两个字段是本项目 IPC 错误载荷的约定（见 lib/errors.js 的 toPayload），
 * 调用方普遍按 e.code 分支处理，所以它们必须挂在 Error 上。
 * @param {string} code
 * @param {string} message
 * @param {string} [advice]
 * @returns {CodedError}
 */
function err(code, message, advice) {
  const e = /** @type {CodedError} */ (new Error(message));
  e.code = code;
  if (advice) e.advice = advice;
  return e;
}

/* 规范化条目名：统一成 /，去掉开头的 ./ 与 /，但保留 .. 以便后续检测 */
function normalizeName(name) {
  let s = String(name == null ? '' : name).replace(/\\/g, '/');
  s = s.replace(/^\.\//, '');
  return s;
}

/* 判定单个条目名是否安全。返回 null 表示通过，否则返回 {code, reason}。 */
function checkEntryName(rawName) {
  const name = normalizeName(rawName);

  if (!name || name === '.' || name === './') return null; // 根条目，跳过

  // 1) UNC 路径 \\server\share（规范化后是 //server/share）。
  //    必须排在绝对路径判断之前：UNC 以 // 开头，会被「前导斜杠」规则先命中，
  //    错误码就变成 ABS_PATH，提示不够准确。
  if (name.startsWith('//')) {
    return { code: 'UNC_PATH', reason: '压缩包含 UNC 网络路径条目：' + name };
  }
  // 2) 绝对路径：盘符或前导斜杠
  if (/^[a-zA-Z]:/.test(name) || name.startsWith('/')) {
    return { code: 'ABS_PATH', reason: '压缩包含绝对路径条目：' + name };
  }
  // 3) 路径穿越：任何一段是 ..
  const segs = name.split('/');
  if (segs.some(s => s === '..')) {
    return { code: 'PATH_TRAVERSAL', reason: '压缩包含向上穿越的路径：' + name };
  }
  // 4) NTFS 附加数据流：冒号出现在盘符之后（上面已排除盘符情况）
  if (name.includes(':')) {
    return { code: 'ADS', reason: '压缩包含 NTFS 附加数据流（ADS）：' + name };
  }
  // 5) 设备名与 Windows 非法字符
  for (const seg of segs) {
    if (!seg) continue;
    // 尾点/尾空格：Windows 会静默去掉，可能造成同名覆盖
    if (/[. ]$/.test(seg)) {
      return { code: 'TRAILING_DOT', reason: '条目名以点或空格结尾（Windows 会截断）：' + name };
    }
    const base = seg.split('.')[0].toLowerCase();
    if (DEVICE_NAMES.has(base)) {
      return { code: 'DEVICE_NAME', reason: '条目名是 Windows 保留设备名：' + name };
    }
    if (/[<>"|?*]/.test(seg)) {
      return { code: 'ILLEGAL_CHAR', reason: '条目名含 Windows 非法字符：' + name };
    }
  }
  return null;
}

/* 汇总校验整个条目清单。
 * entries: [{ name, isDir, size, isSymlink, isHardLink }]
 * 返回 { ok, entries: [{name, target}], totalBytes } 或抛错（带上 error.code）。
 */
function inspectEntries(entries, limits = {}) {
  const L = Object.assign({}, DEFAULT_LIMITS, limits);
  const list = Array.isArray(entries) ? entries : [];

  if (list.length > L.maxEntries) {
    throw err('TOO_MANY_ENTRIES', `压缩包条目过多（${list.length} 条，上限 ${L.maxEntries}）`, '请确认来源可信，或在设置中调整限额');
  }

  const out = [];
  let totalBytes = 0;
  const seenLower = new Map(); // 小写路径 -> 原路径，用于大小写冲突检测
  const fileDirs = new Map();  // 已被当作文件的路径
  const dirLike = new Map();   // 已被当作「目录」的路径（来自任何条目的前缀，或目录条目）

  for (const raw of list) {
    const name = normalizeName(raw.name);

    // 链接/特殊条目一律拒绝：链接可以指向目录外，等价于绕过穿越检查
    if (raw.isSymlink) throw err('SYMLINK', '压缩包含符号链接条目：' + name, '本工具只解压普通文件与目录');
    if (raw.isHardLink) throw err('HARDLINK', '压缩包含硬链接条目：' + name, '本工具只解压普通文件与目录');
    if (raw.isSpecial) throw err('SPECIAL_ENTRY', '压缩包含设备/FIFO 等特殊条目：' + name, '本工具只解压普通文件与目录');

    const bad = checkEntryName(name);
    if (bad) throw err(bad.code, bad.reason, '该压缩包可能被构造过，建议不要解压');

    if (!name || name === '.' || name === './') continue;

    // 深度
    const depth = name.split('/').filter(Boolean).length;
    if (depth > L.maxDepth) {
      throw err('TOO_DEEP', `目录层级过深（${depth} 层，上限 ${L.maxDepth}）：` + name);
    }

    // 大小写冲突：Windows 不区分大小写，a.txt 与 A.TXT 会互相覆盖
    const lower = name.toLowerCase().replace(/\/+$/, '');
    if (seenLower.has(lower) && seenLower.get(lower) !== name) {
      throw err('CASE_CONFLICT', `压缩包含大小写冲突的条目：${seenLower.get(lower)} 与 ${name}`, 'Windows 上两者会互相覆盖，已拒绝');
    }
    seenLower.set(lower, name);

    const segs = name.split('/');
    for (let i = 1; i < segs.length; i++) {
      const prefix = segs.slice(0, i).join('/').toLowerCase();
      if (fileDirs.has(prefix)) {
        throw err('FILE_DIR_CONFLICT', `条目 ${fileDirs.get(prefix)} 已作为文件，但 ${name} 需要它为目录`);
      }
    }

    /* 【反向顺序也必须查：先子项、后同名文件】
     * 上面的循环只能发现「之前已把一个路径登记成文件，现在又有条目需要它是目录」。
     * 但条目顺序由压缩包作者控制，反着来就绕过去了。实测：
     *   [{name:'a/b.txt'}, {name:'a'}]        → 通过校验（错！）
     *   [{name:'a'},       {name:'a/b.txt'}]  → 才抛 FILE_DIR_CONFLICT
     * 那种包解压时会先建目录 a、随后又要写文件 a → 写盘失败，中途抛错触发回滚，
     * 用户看到的是「解压失败」而不是「包被构造过」。
     * 判据：这个路径是不是**已经**作为某个条目的目录前缀出现过（或本身就是目录条目）。
     * 只对「是文件」的条目查 —— 目录条目与同名子项并存（a 是目录 + a/b.txt）是合法的。 */
    if (!raw.isDir && dirLike.has(lower)) {
      throw err('FILE_DIR_CONFLICT', `条目 ${name} 是文件，但已有条目需要它为目录`, 'Windows 上无法同时是文件与目录，已拒绝');
    }

    /* 登记：文件条目占「这是文件」，目录条目和前缀占「这是目录」 */
    if (!raw.isDir) fileDirs.set(lower, name);
    else dirLike.set(lower, name);
    for (let i = 1; i < segs.length; i++) dirLike.set(segs.slice(0, i).join('/').toLowerCase(), name);

    const size = Number(raw.size) || 0;
    if (!raw.isDir) {
      if (size < 0) throw err('NEGATIVE_SIZE', '条目声明了负的大小：' + name);
      // 单条目尺寸上限：adm-zip 会按声明值一次性 Buffer.alloc，超大声明就是内存炸弹
      if (size > L.maxEntryBytes) {
        throw err('TOO_LARGE', `单条声明解压大小过大（${(size / 1073741824).toFixed(1)} GB，上限 ${(L.maxEntryBytes / 1073741824).toFixed(0)} GB）：` + name,
          '疑似压缩炸弹，已拒绝');
      }
      // 压缩比检查：zip bomb 的核心特征是一个极小的压缩体声称解压出极大内容。
      // 调用方可传 compressedSize 供比对；没传时退回只看绝对尺寸。
      const csize = Number(raw.compressedSize);
      if (Number.isFinite(csize) && csize > 0 && size > 0) {
        const ratio = size / csize;
        if (ratio > L.maxRatio) {
          throw err('BOMB_RATIO', `条目压缩比异常（${Math.round(ratio)}:1，上限 ${L.maxRatio}:1）：` + name,
            '高度疑似压缩炸弹，已拒绝解压');
        }
      }
      totalBytes += size;
      if (totalBytes > L.maxTotalBytes) {
        throw err('TOO_LARGE', `累计解压大小超过上限（${(L.maxTotalBytes / 1073741824).toFixed(0)} GB）`,
          '疑似压缩炸弹，已拒绝');
      }
    }
    out.push({ name: name.replace(/\/+$/, ''), isDir: !!raw.isDir, size });
  }
  return { ok: true, entries: out, totalBytes };
}

/* 把条目相对名拼成绝对目标路径，并再次断言结果确实落在 root 之内。
 * 这是最后一道防线：即使前面漏判，这里也能拦住逃逸。
 */
function resolveTarget(root, relName) {
  const absRoot = path.resolve(root);
  const target = path.resolve(path.join(absRoot, relName));
  /* root 以分隔符结尾（盘符根 D:\ 或 UNC 根）时不能再拼一个 path.sep，
   * 否则会拼出 'D:\\\\' 这样的双分隔符前缀，'D:\\a.txt' 因不以它开头而被判越界。
   * 用户把解压目标选成「D:\」是常见操作，那个报错完全看不懂。 */
  const prefix = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (target !== absRoot && !target.startsWith(prefix)) {
    throw err('ESCAPE', '条目将写到目标目录之外：' + relName, '可能是构造过的压缩包');
  }
  return target;
}

/** Parse the English key/value records emitted by `7z l -slt -ba`.
 * Missing or invalid sizes fail closed before the decompressor is started.
 */
function inspectSevenListing(text, archiveBytes, limits = {}) {
  const entries = [];
  for (const block of String(text).trim().split(/\r?\n\s*\r?\n/)) {
    if (!block.trim()) continue;
    const fields = Object.create(null);
    for (const line of block.split(/\r?\n/)) {
      const split = line.indexOf(' = ');
      if (split < 1) throw err('BAD_LISTING', '无法安全解析压缩包目录');
      const key = line.slice(0, split);
      if (Object.prototype.hasOwnProperty.call(fields, key)) throw err('BAD_LISTING', '压缩包目录含重复字段');
      fields[key] = line.slice(split + 3);
    }
    const attrs = fields.Attributes || '';
    const isDir = fields.Folder === '+' || /^D/.test(attrs);
    const size = Number(fields.Size);
    if (!fields.Path || (!isDir && (!/^\d+$/.test(fields.Size || '') || !Number.isSafeInteger(size)))) {
      throw err('BAD_LISTING', '压缩包条目缺少有效路径或大小');
    }
    entries.push({ name: fields.Path, isDir, size: isDir ? 0 : size,
      compressedSize: /^\d+$/.test(fields['Packed Size'] || '') ? Number(fields['Packed Size']) : undefined,
      isSymlink: !!fields['Symbolic Link'] || /(^|\s)l[rwx-]{9}/.test(attrs),
      isHardLink: !!fields['Hard Link'], isSpecial: fields.Anti === '+',
    });
  }
  const verdict = inspectEntries(entries, limits);
  const cap = { ...DEFAULT_LIMITS, ...limits };
  if (archiveBytes > 0 && verdict.totalBytes / archiveBytes > cap.maxRatio) {
    throw err('BOMB_RATIO', '压缩包累计压缩比异常，已拒绝解压');
  }
  return verdict;
}

module.exports = { inspectEntries, inspectSevenListing, checkEntryName, resolveTarget, normalizeName, DEFAULT_LIMITS, err };
