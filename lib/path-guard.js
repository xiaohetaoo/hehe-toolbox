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
const CRITICAL_DIRS = [
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

function isCriticalPath(p) {
  let abs;
  try { abs = path.resolve(String(p || '')); } catch (e) { return false; }
  const lower = normalizeForCompare(abs);
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
 * 而 C:\Users 只保护「本身 + 一层」（用户目录本身不能被当成文件覆盖，
 * 但用户目录下的 Documents/Desktop 正常可写）。 */
function isCriticalForOverwrite(p) {
  let abs;
  try { abs = path.resolve(String(p || '')); } catch (e) { return false; }
  const lower = normalizeForCompare(abs);
  const deep = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata'];
  for (const d of deep) {
    if (lower === d || lower.startsWith(d + '\\')) return true;
  }
  // C:\Users 及其直接子目录（用户目录本身）
  const users = 'c:\\users';
  if (lower === users) return true;
  if (lower.startsWith(users + '\\') && lower.slice(users.length + 1).indexOf('\\') === -1) return true;
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
  checkFileName,
  isSafeOutputName,
  resolveInside,
  isCriticalPath,
  isCriticalForOverwrite,
  checkDeletable,
  checkOverwritable,
  normalizeForCompare,
  err
};
