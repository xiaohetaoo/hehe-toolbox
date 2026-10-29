'use strict';
/* 破坏性操作的文件路径安全网。
 *
 * 背景：项目里有一批「写文件 / 删文件」的 IPC（fs:delete、fs:write-text、
 * fs:merge-parts、图片压缩输出…），它们的路径参数直接来自渲染层。
 * 一旦路径可以被构造（用户手输、清单文件里的字段、工具自己拼出来的名字），
 * 就可能：
 *   - 覆盖用户已有文件（静默毁数据）
 *   - 删除系统目录 / 用户文档目录
 *   - 通过 .. 写出目标目录
 *
 * 本模块提供三件事（纯函数，便于单测）：
 *   1) isSafeOutputName(name)   —— 文件名是否安全（无路径分隔符/设备名/ADS/穿越）
 *   2) resolveInside(root, rel) —— 把相对路径解析到 root 内，越界则抛错
 *   3) assertNotCritical(p)     —— 拒绝删除/覆盖系统关键目录
 *
 * 与 lib/archive-guard.js 的关系：archive-guard 负责「压缩包条目」，
 * 本模块负责「运行时用户路径」。两者都做 Windows 特有的名字检查。
 */

const path = require('path');
const fs = require('fs');

/* Windows 保留设备名：写到这些名字会命中设备而不是文件 */
const DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/* 系统关键目录：即使用户有删除权限，也不允许在这里做递归删除/覆盖。
 * 这些目录一旦被清空，系统可能无法启动或用户资料永久丢失。
 *
 * 只保护**目录本身**，不保护其所有子目录：
 *   - C:\Users 被清空 = 所有用户资料消失（必须挡）
 *   - C:\Users\某用户\Documents 被删 = 灾难（也该挡）
 * 但如果把 C:\Users 下的每个子目录都算成关键目录，
 * 用户在桌面上的正常删除都会被拦，那就成了误伤。
 * 折中：关键目录本身 + 其**直接子目录**（一层）视为危险，
 * 更深的层级交给「不能删盘符根」和「不能删主目录」这两条兜底。 */
const CRITICAL_DIRS_LEGACY = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\Users',
  'C:\\Boot',
  'C:\\System Volume Information',
  'C:\\Recovery',
  'C:\\$Recycle.Bin'
];

/* 【盘符不能硬编码】上面那份把九个关键目录全写死在 C 盘。
 * Windows 装在 D:\ 时，整张安全网对系统目录**完全失效** ——
 * 用「重复文件查找」勾选 D:\Windows\System32 里的文件就能直接删掉。
 *
 * 改为从环境变量动态取（SystemRoot / ProgramFiles / ProgramW6432 / ProgramData
 * 都是系统给的权威值，装哪个盘就是哪个盘），再按「系统卷根」拼出固定项。 */
function computeCriticalDirs() {
  const dirs = new Set();

  /* 1) 环境变量里的权威系统目录 */
  const envDirs = [
    process.env.SystemRoot,
    process.env.windir,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432,
    process.env.ProgramData,
    process.env.ALLUSERSPROFILE
  ];
  for (const d of envDirs) {
    if (d && typeof d === 'string' && path.isAbsolute(d)) dirs.add(path.resolve(d));
  }

  /* 2) 用户目录（随账号走） */
  try {
    const os = require('os');
    const home = os && os.homedir ? os.homedir() : '';
    if (home && path.isAbsolute(home)) {
      const h = path.resolve(home);
      dirs.add(h);
      const up = path.dirname(h); // C:\Users
      if (up && path.dirname(up) === path.parse(up).root) dirs.add(up);
    }
  } catch (e) {}

  /* 3) 系统卷根下的固定高危项（按实际卷根拼，不写死 C:\） */
  const sysRoot = path.resolve(process.env.SystemRoot || process.env.windir || 'C:\\Windows');
  const volRoot = path.parse(sysRoot).root; // C:\ 或 D:\
  for (const n of ['Boot', 'Recovery', 'System Volume Information', '$Recycle.Bin']) {
    dirs.add(path.join(volRoot, n));
  }

  /* 4) 极端兜底：环境变量全空时至少保住默认位置 */
  if (dirs.size === 0) { dirs.add('C:\\Windows'); dirs.add('C:\\Program Files'); }

  return [...dirs];
}

let _criticalDirsCache = null;
function criticalDirs() {
  if (!_criticalDirsCache) _criticalDirsCache = computeCriticalDirs();
  return _criticalDirsCache;
}
/* 测试用：环境变量变更后强制重算 */
function resetCriticalDirs() { _criticalDirsCache = null; }

/* 保持旧名字可用（外部可能有引用），但求值走动态计算 */
const CRITICAL_DIRS = new Proxy([], {
  get(t, k) { if (k === 'length') return criticalDirs().length; if (k in criticalDirs()) return criticalDirs()[k]; return undefined; },
  has(t, k) { return k in criticalDirs() || k === 'length'; },
  ownKeys() { return Object.keys(criticalDirs()); },
  getOwnPropertyDescriptor(t, k) {
    if (k === 'length') return { value: criticalDirs().length, enumerable: false, configurable: true, writable: false };
    const v = criticalDirs()[k];
    return v === undefined ? undefined : { value: v, enumerable: true, configurable: true, writable: false };
  }
});
const _legacyCriticalDirs = CRITICAL_DIRS_LEGACY;

function err(code, message, advice) {
  const e = new Error(message);
  e.code = code;
  if (advice) e.advice = advice;
  return e;
}

/* 文件名安全检查。返回 null 表示通过，否则返回 {code, reason}。
 * 只检查「单个文件名」，不含目录部分。 */
function checkFileName(rawName) {
  const name = String(rawName == null ? '' : rawName);
  if (!name) return { code: 'EMPTY_NAME', reason: '文件名为空' };
  if (name.length > 255) return { code: 'NAME_TOO_LONG', reason: '文件名过长（>255 字符）' };
  // 路径分隔符：单个文件名里不允许出现，否则可以写到子目录去
  if (/[\\/]/.test(name)) return { code: 'SEPARATOR', reason: '文件名不能包含路径分隔符：' + name };
  if (name === '.' || name === '..') return { code: 'TRAVERSAL', reason: '文件名非法：' + name };
  // NTFS 附加数据流
  if (name.includes(':')) return { code: 'ADS', reason: '文件名不能包含冒号（NTFS ADS）：' + name };
  // 尾随点/空格：Windows 会静默截断，可能与别的文件同名
  if (/[. ]$/.test(name)) return { code: 'TRAILING_DOT', reason: '文件名不能以点或空格结尾：' + name };
  // Windows 非法字符
  if (/[<>:"|?*]/.test(name)) return { code: 'ILLEGAL_CHAR', reason: '文件名含 Windows 非法字符：' + name };
  // 控制字符
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return { code: 'ILLEGAL_CHAR', reason: '文件名含控制字符' };
  // 设备名（去掉扩展名后比较，CON.txt 也命中）
  const base = name.split('.')[0].toLowerCase();
  if (DEVICE_NAMES.has(base)) return { code: 'DEVICE_NAME', reason: '文件名是 Windows 保留设备名：' + name };
  return null;
}

function isSafeOutputName(name) { return checkFileName(name) === null; }

/* 把相对路径解析到 root 之内。越界（.. 或绝对路径）则抛错。
 * 用于「清单文件里的名字」「解压条目名」这类可控字段。
 *
 * 注意：这里**不**逐段禁止 '..'——path.resolve 之后判断最终位置是否还在 root 内
 * 就够了，既安全又不会误伤 'a/b/../c.txt' 这种合法写法。
 * 但对 Windows 特有的危险段（设备名、ADS、非法字符）仍然逐段拒绝。 */
function resolveInside(root, rel) {
  const rootAbs = path.resolve(root);
  const relStr = String(rel == null ? '' : rel).replace(/\\/g, '/');
  if (!relStr) throw err('EMPTY_PATH', '路径为空');
  if (relStr.startsWith('//')) throw err('UNC_PATH', '不接受 UNC 网络路径');
  if (/^[a-zA-Z]:/.test(relStr) || relStr.startsWith('/')) {
    throw err('ABS_PATH', '不接受绝对路径：' + relStr);
  }
  const segs = relStr.split('/').filter(s => s !== '' && s !== '.');
  // Windows 特有的危险段逐个拒绝（设备名/ADS/非法字符/尾随点）
  for (const s of segs) {
    if (s === '..') continue; // 交给 resolve 后的越界检查
    const bad = checkFileName(s);
    if (bad) throw err(bad.code, bad.reason);
  }
  const abs = path.resolve(rootAbs, ...segs);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw err('ESCAPE', '路径超出允许的目录范围');
  }
  return abs;
}

/* 判断路径是否落在系统关键目录里（含其直接子目录）。
 * 用于阻止「递归删除 C:\Users」这类灾难性操作。
 *
 * 关键：Windows 会静默去掉路径段尾部的点和空格，
 *   C:\Windows.   实际等于 C:\Windows
 *   C:\Windows    末尾空格同样被吃掉
 * 如果不做归一化，用户/攻击者只要给关键目录加个尾点就能绕过闸门。
 * 所以比较前必须把每个路径段都做一次「去尾点尾空格」归一化。 */
function normalizeForCompare(abs) {
  const parts = String(abs).split(/[\\/]+/);
  const cleaned = parts.map((s) => s.replace(/[. ]+$/, ''));
  return cleaned.join('\\').toLowerCase().replace(/\\+$/, '');
}

/* 把「已存在」的路径解析成真实物理路径，用于安全判定。
 *
 * 【为什么必须解析】纯字符串判定会被 junction / symlink 绕过：
 * 在普通目录下建一个指向 C:\\Windows\\System32 的目录 junction，
 * 它的字符串路径是 `D:\xxx\link` 这种「看起来无害」的形式，
 * isCriticalPath 判不出来，但递归删除会顺着链接删进系统目录。
 *
 * 规则：
 *   - 路径存在 → fs.realpathSync.native() 拿真实路径；
 *   - 路径不存在（还没创建的输出）→ 「父目录 realpath + 自身名字」，因为父目录也可能是链接；
 *   - realpath 失败（权限/被占用）→ 退回原绝对路径（调用方还有别的闸门兜底）。
 */
function resolveReal(p) {
  let abs;
  try { abs = path.resolve(String(p || '')); } catch (e) { return String(p || ''); }
  try {
    return fs.realpathSync.native(abs);
  } catch (e) {
    try {
      const dir = path.dirname(abs);
      const base = path.basename(abs);
      return path.join(fs.realpathSync.native(dir), base);
    } catch (e2) {
      return abs;
    }
  }
}

/* 判定前的统一归一：真实路径 + 尾点/尾空格归一，两者都要做。
 *   - realpath 解决 junction/symlink 绕行
 *   - normalizeForCompare 解决 Windows 把 `C:\\Windows. ` 当 `C:\\Windows` */
function canonical(p) {
  return normalizeForCompare(resolveReal(p));
}

function isCriticalPath(p) {
  let lower;
  try { lower = canonical(p); } catch (e) { return false; }
  if (!lower) return false;
  for (const d of CRITICAL_DIRS) {
    const dl = normalizeForCompare(d);
    if (lower === dl) return true;                    // 正好是关键目录
    // 直接子目录也算危险（如 C:\Users\某用户、C:\Windows\System32）
    if (lower.startsWith(dl + '\\') && lower.slice(dl.length + 1).indexOf('\\') === -1) return true;
  }
  return false;
}

/* 覆盖场景比删除更严：往系统目录里写一个坏文件可能让系统起不来
 * （比如覆盖 C:\Windows\System32\drivers\etc\hosts 会毁掉全机 DNS）。
 *
 * 但也不能拦太狠：C:\Users\<用户名>\Desktop\xxx 是用户最常见的写入位置，
 * 把它拦掉等于功能不可用。
 * 所以覆盖检查保护：
 *   - 关键目录**本身**（作为文件路径写入）
 *   - 盘符根
 *   - Windows / Program Files / ProgramData 的**所有层级**
 *     （这些目录里的东西用户不会正常写）
 * 而 Users 只保护「本身 + 一层」（用户目录本身不能被当成文件覆盖，
 * 但用户目录下的 Documents/Desktop 正常可写）。
 *
 * 【盘符同样不能硬编码】deep 数组原来写死 c:\windows 等四项 ——
 * 系统装在 D 盘时，往 D:\Windows\System32\drivers\etc\hosts 覆盖写不会被拦，
 * 会毁掉全机 DNS。现在改为从动态的 criticalDirs() 里挑出「深层保护」的那些。 */
function isCriticalForOverwrite(p) {
  let lower;
  try { lower = canonical(p); } catch (e) { return false; }
  if (!lower) return false;

  /* 深层保护：Windows / Program Files / ProgramData（任意盘符） */
  const deepNames = ['windows', 'program files', 'program files (x86)', 'programdata', 'programdata'];
  const dirs = criticalDirs();
  for (const d of dirs) {
    const dl = normalizeForCompare(d);
    const base = dl.slice(dl.lastIndexOf('\\') + 1);
    if (!deepNames.includes(base)) continue;
    if (lower === dl || lower.startsWith(dl + '\\')) return true;
  }

  /* Users 只保护「本身 + 一层」：用户目录本身不能被当成文件覆盖，
   * 但其下的 Documents/Desktop 正常可写。 */
  for (const d of dirs) {
    const dl = normalizeForCompare(d);
    const base = dl.slice(dl.lastIndexOf('\\') + 1);
    if (base !== 'users' && base !== path.basename(require('os').homedir()).toLowerCase()) {
      // 家目录本身也按「一层」语义保护
      if (base !== 'users') continue;
    }
    if (lower === dl) return true;
    if (lower.startsWith(dl + '\\') && lower.slice(dl.length + 1).indexOf('\\') === -1) return true;
  }
  return false;
}

/* 递归删除前的闸门。返回 null 表示放行，否则返回拒绝原因。 */
function checkDeletable(p, recursive) {
  const s = String(p || '');
  if (!s) return { code: 'EMPTY_PATH', reason: '路径为空' };
  let abs;
  try { abs = path.resolve(s); } catch (e) { return { code: 'BAD_PATH', reason: '路径无效' }; }
  const root = path.parse(abs).root;
  if (abs === root) return { code: 'ROOT', reason: '拒绝删除磁盘根目录：' + abs };
  if (isCriticalPath(abs)) return { code: 'CRITICAL', reason: '拒绝操作系统关键目录：' + abs };
  // 用户的家目录本身也不该被整体删掉（同样要归一化，防尾点绕过）
  try {
    const home = normalizeForCompare(path.resolve(require('os').homedir()));
    if (normalizeForCompare(abs) === home) return { code: 'HOME', reason: '拒绝删除用户主目录：' + abs };
  } catch (e) {}
  return null;
}

/* 覆盖已有文件前的闸门。 */
function checkOverwritable(p) {
  const s = String(p || '');
  if (!s) return { code: 'EMPTY_PATH', reason: '路径为空' };
  let abs;
  try { abs = path.resolve(s); } catch (e) { return { code: 'BAD_PATH', reason: '路径无效' }; }
  if (isCriticalForOverwrite(abs)) return { code: 'CRITICAL', reason: '拒绝覆盖系统关键目录内的文件：' + abs };
  return null;
}

module.exports = {
  DEVICE_NAMES,
  CRITICAL_DIRS,
  criticalDirs,
  resetCriticalDirs,
  checkFileName,
  isSafeOutputName,
  resolveInside,
  isCriticalPath,
  isCriticalForOverwrite,
  checkDeletable,
  checkOverwritable,
  normalizeForCompare,
  resolveReal,
  canonical,
  err
};
