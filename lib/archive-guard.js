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

/* 默认限额。数值参考对方的工业生产阈值，可按需在调用处覆盖。 */
const DEFAULT_LIMITS = {
  maxEntries: 100000,          // 条目数上限
  maxDepth: 64,                // 目录层数上限
  maxTotalBytes: 100 * 1024 * 1024 * 1024  // 累计写入 100 GiB
};

function err(code, message, advice) {
  const e = new Error(message);
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

    // 文件/目录冲突：既有 a 作为文件，又有 a/b 需要 a 是目录
    if (!raw.isDir) {
      fileDirs.set(lower, name);
    }
    const segs = name.split('/');
    for (let i = 1; i < segs.length; i++) {
      const prefix = segs.slice(0, i).join('/').toLowerCase();
      if (fileDirs.has(prefix)) {
        throw err('FILE_DIR_CONFLICT', `条目 ${fileDirs.get(prefix)} 已作为文件，但 ${name} 需要它为目录`);
      }
    }

    const size = Number(raw.size) || 0;
    if (!raw.isDir) {
      if (size < 0) throw err('NEGATIVE_SIZE', '条目声明了负的大小：' + name);
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
  if (target !== absRoot && !target.startsWith(absRoot + path.sep)) {
    throw err('ESCAPE', '条目将写到目标目录之外：' + relName, '可能是构造过的压缩包');
  }
  return target;
}

module.exports = { inspectEntries, checkEntryName, resolveTarget, normalizeName, DEFAULT_LIMITS, err };
