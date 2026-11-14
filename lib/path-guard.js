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
/* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
const _legacyCriticalDirs = CRITICAL_DIRS_LEGACY;

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
  /* 【root 本身以分隔符结尾时不能再拼一个】
   * 用户把输出/解压目录选成盘符根（「解压到 D:\」是很常见的操作）时，
   * path.resolve('D:\\') 仍是 'D:\\'，再拼 path.sep 得到 'D:\\\\'，
   * 而 'D:\\a.txt' 不以 'D:\\\\' 开头 → 误判越界，报
   * 「条目将写到目标目录之外：a.txt」，功能直接不可用且报错看不懂。
   * 目录路径（D:\out）不受影响，所以这个 bug 只在盘符根上出现。 */
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (abs !== rootAbs && !abs.startsWith(prefix)) {
    throw err('ESCAPE', '路径超出允许的目录范围');
  }
  return abs;
}

/** Create an archive directory without following existing links below its root.
 * The selected root may itself be an alias; all descendants use its real path.
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<string>}
 */
async function ensureDirectoryInside(root, rel) {
  const target = resolveInside(root, rel);
  await fs.promises.mkdir(root, { recursive: true });
  const realRoot = await fs.promises.realpath(root);
  const relative = path.relative(path.resolve(root), target);
  let current = realRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { await fs.promises.mkdir(current); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = await fs.promises.lstat(current);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw err('UNSAFE_DIRECTORY', '解压路径包含链接或非目录条目：' + current);
    }
    const real = await fs.promises.realpath(current);
    const remaining = path.relative(realRoot, real);
    if (path.isAbsolute(remaining) || remaining === '..' || remaining.startsWith('..' + path.sep)) {
      throw err('ESCAPE', '解压路径超出目标目录：' + current);
    }
  }
  return current;
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
  /* 【先剥掉 Windows 命名空间前缀 `\\?\` / `\\.\`】
   * 第四轮审查（实测）：`\\?\C:\Windows\System32\config\SAM` 这种扩展长度
   * 写法在 realpath 失败（普通用户读不了 config）时，resolveReal 退回原路径，
   * 归一后得到 `\\?\c:\windows\...`，与 `c:\windows\...` 永远对不上 ——
   * 于是 checkDeletable 返回 null（放行），而不带前缀的同一条路径是
   * CRITICAL_DEEP。`\\?\C:\Windows` 之所以能拦住，只是因为 realpath 恰好成功。
   * 判据不能依赖「realpath 是否会失败」；前缀本身不改变目标，先剥掉。 */
  const stripped = String(abs).replace(/^[\\/]{2}[?.][\\/]/, '');
  const parts = stripped.split(/[\\/]+/);
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

/* ================= 改权限 / 搬家专用的保护判定 =================
 *
 * 【为什么不能直接复用 isCriticalPath】
 * isCriticalPath 的规则是「关键目录本身 + 直接子目录」，而 criticalDirs()
 * 里含用户家目录（C:\Users\<用户名>）和 C:\Users。于是：
 *   isCriticalPath('C:\Users\<用户名>\Documents') === true
 * 结果 acl:repair 拒绝用户修自己 Documents 的权限，dir:move 拒绝
 * 「把 Documents 搬到 D 盘」这种完全正常的操作，
 * 提示语还是「改错会导致系统更新失败或被安全软件拦截」—— 对这个目标
 * 完全是误导。这两件事的破坏面和删除不一样，不该套同一套判据。
 *
 * 【这里的边界】
 * 拦：
 *   - C:\Windows、C:\Program Files、C:\Program Files (x86)、C:\ProgramData
 *     （任意盘符，按实际卷根拼）
 *   - 盘符根（C:\ 这类）
 *   - 其他用户的家目录（C:\Users\<别人>）—— 你改不了也不该改
 *   - C:\Users 本身（整个用户目录树）
 * 不拦：
 *   - 自己家目录下的 Documents / Desktop / Downloads / 任意子目录
 *   - 自己家目录本身？—— 拦。改自己家目录根的 ACL 会波及所有子项，
 *     而且删除/改权限都不是用户「修某个文件权限」的日常场景。
 *     这条要明确：拦，但提示语里说明是「家目录本身」，别用系统目录那套话。
 */
function isProtectedForModify(p) {
  /* `D:` 的 resolve 结果是 cwd（见 checkDeletable 的说明）。改权限/搬家
   * 都没有「盘符相对」的正当需求，按「受保护」处理，文案说明歧义。 */
  if (/^[A-Za-z]:$/.test(String(p == null ? '' : p).trim())) {
    return {
      protected: true,
      kind: 'DRIVE_RELATIVE',
      reason: '这是盘符相对写法（`D:` 指当前目录）。如果要操作整盘 D 盘，请写 D:\\ 并确认自己知道后果',
    };
  }
  let abs;
  try { abs = canonical(p); } catch (e) { return { protected: false }; }
  if (!abs) return { protected: false };

  /* 1) 盘符根：不能对整盘改权限或搬家 */
  try {
    const raw = resolveReal(p);
    const root = path.parse(raw).root;
    if (root && normalizeForCompare(raw) === normalizeForCompare(root)) {
      return { protected: true, kind: 'VOLUME_ROOT', reason: '这是盘符根目录（' + root + '），不能整盘操作' };
    }
  } catch (e) {}

  /* 2) 系统目录：以环境变量为准（装哪个盘就是哪个盘） */
  const sysDirs = [];
  const sysRoot = process.env.SystemRoot || process.env.windir;
  if (sysRoot) sysDirs.push(path.resolve(sysRoot));
  for (const envKey of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'ALLUSERSPROFILE']) {
    const v = process.env[envKey];
    if (v && path.isAbsolute(v)) sysDirs.push(path.resolve(v));
  }
  /* 环境变量缺失时的兜底（跟 criticalDirs 一致） */
  if (!sysDirs.length) {
    sysDirs.push('C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData');
  }
  /* 【其它盘上的同名系统目录也要挡】
   * 环境变量只描述**当前**这套 Windows 装在哪。一台机器装了第二套
   * Windows（D:\Windows）时，那同样是系统目录，却不在环境变量里。
   * 早期注释写的是「任意盘符按实际卷根拼」，实际只挡了当前那套 ——
   * 名不副实。这里对**存在的**盘符按固定名补一遍：
   * 先确认盘符在（一次 existsSync），再拼四个固定名，
   * 所以不存在的盘（含光驱空仓）不会产生任何条目，也不会误伤
   * 「恰好叫 Windows 的普通目录」在不存在盘上的情况。 */
  for (let i = 0; i < 26; i++) {
    const vol = String.fromCharCode(65 + i) + ':\\';
    try { if (!fs.existsSync(vol)) continue; } catch (e) { continue; }
    for (const n of ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData']) {
      sysDirs.push(path.resolve(vol + n));
    }
  }
  for (const d of sysDirs) {
    const dl = normalizeForCompare(d);
    if (!dl) continue;
    /* 命中目录本身或其下任意层级 —— 系统目录里不该有任何「修权限/搬家」的正当需求 */
    if (abs === dl || abs.indexOf(dl + '\\') === 0) {
      return { protected: true, kind: 'SYSTEM', reason: '这里属于系统目录（' + d + '），权限修复与目录搬家都不该指向它' };
    }
  }

  /* 3) 用户目录：只拦「别人的家目录」和「C:\Users 本身」，自己家目录下的子目录放行 */
  let usersRoot = '';
  let myHome = '';
  try {
    const os = require('os');
    const home = os && os.homedir ? os.homedir() : '';
    if (home && path.isAbsolute(home)) {
      myHome = normalizeForCompare(path.resolve(home));
      const up = path.dirname(path.resolve(home));
      if (up && path.dirname(up) === path.parse(up).root) usersRoot = normalizeForCompare(up);
    }
  } catch (e) {}

  if (usersRoot && (abs === usersRoot || abs.indexOf(usersRoot + '\\') === 0)) {
    /* 自己家目录本身：拦（改它等于改所有子项） */
    if (myHome && abs === myHome) {
      return { protected: true, kind: 'OWN_HOME', reason: '这是你自己的用户目录本身，修改它的权限会波及下面所有文件；请选中具体的文件或子文件夹' };
    }
    /* 自己的家目录下、但不在自己家目录里？正常情况下不会发生（usersRoot 下面
     * 只有各家目录）。这里剩下的是「别人的家目录」或家目录外的 Users 子项。 */
    if (myHome && abs.indexOf(myHome + '\\') === 0) {
      /* 自己家目录的子目录：Documents / Desktop / Downloads 等，放行 */
      return { protected: false };
    }
    return { protected: true, kind: 'OTHER_HOME', reason: '这属于另一个用户的目录，不应该修改它的权限' };
  }

  return { protected: false };
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

  /* 深层保护：Windows / Program Files / ProgramData（任意层级的任意盘符）
   * 【必须复用 isCriticalDeep】它内部既查 criticalDirs()（环境变量给的
   * 那套），也逐个在线盘符拼四个固定名补一遍 —— 后者正是为了
   * 「系统装在 C、另有一套 Windows 在 D」的情形。
   * 原实现只查 criticalDirs()，注释里却写着「任意盘符」：
   * 实测 checkOverwritable('D:\\Windows\\System32\\drivers\\etc\\hosts')
   * 返回 null（放行），而同一条路径 isProtectedForModify 返回 protected:true ——
   * 两个闸门结论相反，写 hosts 这种能毁掉全机 DNS 的操作就从这里漏过去。 */
  if (isCriticalDeep(lower)) return true;

  /* Users 只保护「本身 + 一层」：用户目录本身不能被当成文件覆盖，
   * 但其下的 Documents/Desktop 正常可写。 */
  const dirs = criticalDirs();
  for (const d of dirs) {
    const dl = normalizeForCompare(d);
    const base = dl.slice(dl.lastIndexOf('\\') + 1);
    if (!/^users$/i.test(base) && base !== path.basename(require('os').homedir()).toLowerCase()) continue;
    if (lower === dl) return true;
    if (lower.startsWith(dl + '\\') && lower.slice(dl.length + 1).indexOf('\\') === -1) return true;
  }
  return false;
}

/* 递归删除前的闸门。返回 null 表示放行，否则返回拒绝原因。 */
/* 系统目录「深层」判定：Windows / Program Files / ProgramData 的任意层级。
 *
 * 【与 isCriticalPath 的区别】
 * isCriticalPath 只保护「关键目录本身 + 一层」，这对**浏览性**的场景够用
 * （不能让用户在桌面上正常删除被拦），但对**递归删除**完全不够：
 *   C:\Windows\System32\drivers          第二层，isCriticalPath 判 false
 *   C:\Windows\System32\config\SAM       第三层
 * 递归删掉 drivers 目录，系统直接起不来；删掉 SAM，本机账号全部失效。
 * Users 例外：仍然只按「本身 + 一层」，因为用户会在自己家目录下正常删东西。
 *
 * @param {string} abs 绝对路径
 * @returns {boolean}
 */
function isCriticalDeep(abs) {
  let lower;
  try { lower = canonical(abs); } catch (e) { return false; }
  if (!lower) return false;
  const deepNames = ['windows', 'program files', 'program files (x86)', 'programdata'];
  for (const d of criticalDirs()) {
    const dl = normalizeForCompare(d);
    const base = dl.slice(dl.lastIndexOf('\\') + 1);
    if (!deepNames.includes(base)) continue;
    if (lower === dl || lower.startsWith(dl + '\\')) return true;
  }
  /* 其它盘上的同名系统目录（系统装在 C、另有一套 Windows 在 D） */
  for (let i = 0; i < 26; i++) {
    const vol = String.fromCharCode(65 + i) + ':\\';
    try { if (!fs.existsSync(vol)) continue; } catch (e) { continue; }
    for (const n of deepNames) {
      const dl = normalizeForCompare(path.join(vol, n));
      if (lower === dl || lower.startsWith(dl + '\\')) return true;
    }
  }
  return false;
}

/* 路径参数的统一类型闸门 —— checkDeletable 与 checkOverwritable 共用。
 *
 * 【为什么必须是助手而不是各写一遍】两个函数原本各有一套校验：
 * checkDeletable 因真实事故改成了严格拒绝，checkOverwritable 却还是
 * `String(p || '')`。同一模块里两个「闸门」对同一种垃圾输入的结论相反，
 * 早晚会有人在错误的那一侧写新调用方。抽出来一处维护。
 *
 * @param {any} p
 * @returns {{value?: string, error?: {code: string, reason: string}}}
 */
function stringPathOrError(p) {
  /* 【非字符串一律拒绝，不做 String() 降级】
   * 原写法 `String(p || '')` 有两个问题：
   *   1) 对象会被悄悄变成 "[object Object]" —— 它既不是盘符根、不是关键目录、
   *      也不是家目录，于是这个"闸门"对它返回 null（放行）。
   *      真实事故：渲染层把 { path, depth } 对象数组传给 fs:delete-empty，
   *      闸门形同虚设，最后 fsp.rmdir 抛 ERR_INVALID_ARG_TYPE 才失败。
   *   2) 数字、null、undefined 之类也会被静默转成看起来像样的字符串。
   * 闸门的职责是「看不懂就拒绝」，不是「尽量猜」。所以先把类型挡住。 */
  if (typeof p !== 'string') {
    /* typeof null 也是 'object'，直接显示会让人以为传了个对象 —— 单独点名。 */
    const kind = p === null ? 'null' : (typeof p);
    let shown;
    try { shown = (typeof p === 'object' && p !== null) ? JSON.stringify(p) : String(p); }
    catch (e) { shown = String(p); }
    return { error: { code: 'BAD_ARG', reason: '路径必须是字符串（收到 ' + kind + '：' + shown + '）' } };
  }
  const s = p.trim();
  if (!s) return { error: { code: 'EMPTY_PATH', reason: '路径为空' } };
  return { value: s };
}

function checkDeletable(p, recursive) {
  const t = stringPathOrError(p);
  if (t.error) return t.error;
  const s = t.value;
  /* 【盘符相对写法必须单独拒绝】`D:`（不带反斜杠）在 Windows 上指
   * 「D 盘的当前目录」，而 path.resolve('D:') 在本进程里 = 应用自己的工作目录。
   * 于是用户手输 `D:` 本意是「D 盘」，实际会被当成 cwd 递归删除。
   * 第四轮审查实测：checkDeletable('D:') 返回 null（放行）。
   * 这种写法有歧义，判据只认明确的 `D:\`。 */
  if (/^[A-Za-z]:$/.test(s)) {
    return { code: 'DRIVE_RELATIVE', reason: '盘符相对路径有歧义（D: 指当前目录），请写成 ' + s + '\\' };
  }
  let abs;
  try { abs = path.resolve(s); } catch (e) { return { code: 'BAD_PATH', reason: '路径无效' }; }
  const root = path.parse(abs).root;
  if (abs === root) return { code: 'ROOT', reason: '拒绝删除磁盘根目录：' + abs };
  if (isCriticalPath(abs)) return { code: 'CRITICAL', reason: '拒绝操作系统关键目录：' + abs };
  /* 【系统目录内的路径：递归与非递归一样不许删】
   * 这个判断原来被 `if (recursive && …)` 限定，只在递归删除时生效。
   * 后果（纯函数实测）：非递归删除时下面这些全部放行 ——
   *   C:\Windows\System32\config\SAM          （账户数据库）
   *   C:\Windows\System32\drivers\etc\hosts   （全机 DNS）
   *   C:\Windows\System32\drivers
   * 而 ipc/fs-ops.js 的注释明确承诺「非递归删除单个文件时，仍然要挡住
   * 关键目录里的文件」—— 实现与意图相悖。
   * 目录因 fsp.rm(recursive:false) 遇到非空会 ENOTEMPTY 天然受限，
   * 但 hosts / SAM 这类**文件**在管理员 + 已开「文件删除」时能被真删，
   * 删掉 hosts 就是全机 DNS 失效，删掉 SAM 更是系统级事故。
   *
   * 【为什么去掉 recursive 限定不会误伤用户数据】
   * isCriticalDeep 只覆盖 Windows / Program Files / ProgramData 这几个
   * 系统目录，**不含 Users** —— 用户家目录、桌面、下载里的删除不受影响。
   * 递归删系统目录本来就是事故，非递归删系统目录里的文件同样是事故，
   * 没有任何正当场景需要在应用里删 System32 下的东西。 */
  if (isCriticalDeep(abs)) {
    return {
      code: 'CRITICAL_DEEP',
      reason: (recursive ? '拒绝递归删除' : '拒绝删除') + '系统目录内的路径：' + abs,
    };
  }
  // 用户的家目录本身也不该被整体删掉（同样要归一化，防尾点绕过）
  try {
    const home = normalizeForCompare(path.resolve(require('os').homedir()));
    if (normalizeForCompare(abs) === home) return { code: 'HOME', reason: '拒绝删除用户主目录：' + abs };
  } catch (e) {}
  return null;
}

/* 覆盖已有文件前的闸门。 */
function checkOverwritable(p) {
  /* 【与 checkDeletable 同一套类型闸门】
   * 这个函数原来写的是 `String(p || '')`，于是 `{}`、`123` 之类会被
   * 静默转成 "[object Object]" / "123"，既不像关键目录，也非空串 →
   * 闸门返回 null（放行）。而兄弟函数 checkDeletable 早已因为
   * 「{path,depth} 对象被降级成 [object Object]」的真实事故改成严格拒绝。
   *
   * 影响面说明（为什么定级不高）：下游 fs.writeFile 对非字符串路径
   * 本身会抛错，所以不直接可利用。但闸门对垃圾输入返回「放行」这件事，
   * 与 checkDeletable 的加固方向正好相反 —— 一旦将来某个调用方先做
   * 字符串拼接再写盘，这层就形同虚设。纵深防御要一致。 */
  const t = stringPathOrError(p);
  if (t.error) return t.error;
  const s = t.value;
  /* 同 checkDeletable：`D:` 是盘符相对写法，resolve 之后会变成 cwd，
   * 与用户「D 盘根目录」的意图不符，直接判非法。 */
  if (/^[A-Za-z]:$/.test(s)) {
    return { code: 'DRIVE_RELATIVE', reason: '盘符相对路径有歧义（D: 指当前目录），请写成 ' + s + '\\' };
  }
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
  ensureDirectoryInside,
  isCriticalPath,
  isProtectedForModify,
  isCriticalForOverwrite,
  checkDeletable,
  checkOverwritable,
  normalizeForCompare,
  resolveReal,
  canonical,
  err
};
