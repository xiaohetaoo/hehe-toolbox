'use strict';
/* 权限修复与取得所有权（takeown + icacls）的**纯逻辑**部分。
 *
 * 【它解决的是「删不掉」的另一半原因】
 * 文件删不掉有两个并列的原因：
 *   ① 被进程占用       → 用 Restart Manager 查（file-unlock 工具）
 *   ② 你没有权限       → 就是这个模块
 * 两者表现一样（「拒绝访问」/「需要权限」），用户分不清，所以两个工具要互相指路。
 *
 * 【分寸：只处理用户显式选中的目标】
 * 权限修复是极危险的操作：给一个目录授权，会连带它下面**所有子项**。
 * 所以本模块：
 *   - 永远只接受「用户点选的那一个路径」；
 *   - 绝不枚举、绝不全盘扫描、绝不批量套用；
 *   - 执行前必须把「会影响多少项」明确算出来给用户看。
 *
 * 【为什么不自己改 ACL，而是调 takeown / icacls】
 *   - 它们随 Windows 自带，不需要额外依赖；
 *   - 行为可预期、可审计（命令本身就是日志）；
 *   - 出问题用户能看懂并复现。
 * 自己用 .NET ACL API 写，出错时更难排查。
 */

/* 权限问题的分类。判据来自 icacls 的输出与访问被拒的错误。 */
const PROBLEM = {
  OWNER: '当前所有者不是你，因此你无法修改它的权限',
  DENY: '存在显式的「拒绝」权限项，覆盖了你的访问',
  NO_READ: '你缺少读取权限',
  NO_WRITE: '你缺少写入/删除权限',
  NO_DELETE: '你缺少删除权限（常见于父目录缺少「删除子项」）',
  ADMIN: '修复需要管理员权限（这一项必须提升权限才能改）',
  LOCKED: '文件正被进程占用（这是占用问题，不是权限问题）',
  UNKNOWN: '无法确定具体缺哪条权限',
};

/**
 * 主体名的「同一个账号」判定（被 mine / ownerIsMe 共用）。
 *
 * 【为什么不能用子串包含】早期这里是
 *   principal.toLowerCase().indexOf(short) !== -1
 * 这是包含匹配，不是主体相等。实测三种假阳性：
 *   DOMAIN\admin 命中 BUILTIN\Administrators
 *   DOMAIN\sys   命中 NT AUTHORITY\SYSTEM
 *   DOMAIN\user  命中 BUILTIN\Users
 * 因为 hasFull 只认 entry.mine，这些误命中会让「其实只有普通权限」的用户
 * 被诊断为「权限没问题」，掩盖真正原因；deniedForMe 用同一判据，
 * 还会凭空报「存在拒绝权限」。
 *
 * 规则（只做精确比较，绝不做包含）：
 *   1. 完整相等（忽略大小写）；
 *   2. 去掉域前缀后完全相等（DOMAIN\user 与 user 视为同一账号）；
 *   3. BUILTIN\ 与 NT AUTHORITY\ 等内建/系统主体不算「我」。
 *      它们不是任何登录用户；即便真有人叫这个名字，规则 1 的全等比较
 *      仍会正确命中，所以这里挡的是「靠后缀蹭上」的假阳性。
 *
 * @param {string} principal ACL 里的主体
 * @param {string} userName  当前用户名（形如 DOMAIN\user）
 * @returns {boolean}
 */
function principalEq(principal, userName) {
  const a = String(principal || '').trim();
  const b = String(userName || '').trim();
  if (!a || !b) return false;

  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  /* 1) 完整相等 */
  if (la === lb) return true;

  /* 2) 内建/系统主体不算「我」—— 必须排在「去域比较」**之前**。
   * 【顺序错了这条就是死代码】早期它写在规则 3，而被规则 2 抢先命中，
   * 于是下面这些返回 true，与本节开头声明的不变量正好相反：
   *   BUILTIN\Users         ≡ MyCo\users
   *   NT AUTHORITY\SYSTEM   ≡ MyCo\system
   * 规则 1（全等比较）不受影响：真有个账号与 ACL 主体逐字相同，
   * 仍会在规则 1 被正确认定为「我」。 */
  if (NON_USER_PREFIXES.test(a)) return false;

  /* 3) 去域前缀后完全相等（DOMAIN\user 与 user 视为同一账号） */
  const stripDomain = (v) => {
    const i = v.lastIndexOf('\\');
    return i === -1 ? v : v.slice(i + 1);
  };
  const shortA = stripDomain(la);
  const shortB = stripDomain(lb);
  if (shortA === shortB && shortA) return true;

  return false;
}

/* 内建/系统主体前缀：这些主体永远不是「当前登录用户」。
 * 挡的是「靠去域后缀蹭上」的假阳性。
 * Mandatory Label\（完整性级别标签，如「中等强制级别」）也在其中：
 * 它是每个新文件默认就带的一条 ACE，绝不属于任何登录用户。 */
const NON_USER_PREFIXES = /^(BUILTIN|NT AUTHORITY|NT SERVICE|CREATOR OWNER|CREATOR GROUP|APPLICATION PACKAGE AUTHORITY|ALL APPLICATION PACKAGES|ALL RESTRICTED APPLICATION PACKAGES|MANDATORY LABEL)\\/i;

/* Windows 内建的含空格账号：这些名字里有一个空格，不能按空白切 */
/* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
const MULTIWORD_PRINCIPALS = [
  'NT AUTHORITY', 'NT SERVICE', 'NT T AUTHORITY',
  'CREATOR OWNER', 'CREATOR GROUP', 'APPLICATION PACKAGE AUTHORITY',
  'ALL APPLICATION PACKAGES', 'ALL RESTRICTED APPLICATION PACKAGES',
  'BUILTIN',
];

/**
 * 内建权威名（可以带空格，且可以是主体第一段）。
 * 之所以单列：NT AUTHORITY\\SYSTEM 的第一段 "NT AUTHORITY" 含空格，
 * 但它是权威名而不是"路径尾巴"，不能因此被拒。
 */
const AUTHORITY_HEADS = [
  'NT AUTHORITY', 'NT SERVICE', 'APPLICATION PACKAGE AUTHORITY',
  'CREATOR OWNER', 'CREATOR GROUP',
  'ALL APPLICATION PACKAGES', 'ALL RESTRICTED APPLICATION PACKAGES',
  'BUILTIN',
  /* 完整性级别标签。每个新文件默认就带一条
   * 「Mandatory Label\Medium Mandatory Level:(I)(NW)」，
   * 两段都含空格 —— 不认它就会被切成 Label\Medium Mandatory Level。 */
  'MANDATORY LABEL',
];

/**
 * 尾巴里有没有「路径残留」的迹象 —— 有就说明这个候选把路径吃进主体了。
 *   - 带扩展名的文件名：a.txt、report.docx
 *   - SID 串：S-1-4-500487088-111393684（普通用户新建文件的默认 ACE 里就有）
 *   - 任何带目录分隔符/冒号的词
 * 真正的含空格主体（Power Users / Domain Admins / Medium Mandatory Level）
 * 不会长这样。
 * 代价：域账号名自己带点（DOMAIN\john.doe Smith）也会被拒 ——
 * 但「路径里有空格」是常态，含空格的组名里带点的字极少，取舍取前者。
 *
 * @param {string} tail 主体第二个反斜杠之后的部分
 * @returns {boolean}
 */
function tailLooksLikePath(tail) {
  for (const w of String(tail || '').split(/\s+/)) {
    if (!w) continue;
    if (/^S-1(-\d+){2,}$/i.test(w)) return true;                          // SID
    if (/[\\/:]/.test(w)) return true;                                   // 路径残留
    if (w.indexOf('.') > 0 && /\.[A-Za-z0-9]{1,6}$/.test(w)) return true; // 文件名
  }
  return false;
}

/**
 * 候选是否能构成一个合法的 Windows 主体名。
 *
 * 判据的关键在于「别把路径尾巴吃进主体」，也不要把主体截短：
 *   - 有反斜杠时，必须正好两段（域/权威 + 名字）。三段以上就是
 *     C:\\x\\a.txt BUILTIN\\Users 这种「路径+主体」拼在一起，拒掉；
 *   - 第一段不能含空格，除非它本身就是内建权威名（NT AUTHORITY）；
 *   - 第一段不能是盘符（C:）—— 那是路径起点，不是域。
 *
 * @param {string} cand
 * @returns {boolean}
 */
function isPlausiblePrincipal(cand) {
  const c = String(cand || '').trim();
  if (!c) return false;

  const toPosix = c.replace(/\\/g, '/');
  if (toPosix.indexOf('/') !== -1) {
    const parts = toPosix.split('/');
    if (parts.length !== 2) return false;
    const head = parts[0], tail = parts[1];
    if (!head || !tail) return false;
    if (/^[A-Za-z]:$/.test(head)) return false;          // 盘符：这是路径
    if (/[:/]/.test(head)) return false;                  // 路径残留
    if (tail.indexOf(':') !== -1 || tail.indexOf('/') !== -1) return false;
    /* 【尾巴带空格时必须排除「路径尾巴 + 主体」】round-9 重写漏了这一类：
     * 候选只校验了「正好两段、第一段不含空格」，于是
     *   C:\my docs\a.txt Everyone:(I)(F)
     * 里的 docs\a.txt Everyone 被当成合法主体（第一段 docs 没有空格），
     * 路径尾巴就这样被吃进主体名，mine/deniedForMe 跟着全错。
     * 旧实现按「最后一个空格」切反而对 —— 这是重写引入的回归。 */
    if (/\s/.test(tail) && tailLooksLikePath(tail)) return false;
    if (/\s/.test(head)) {
      /* 第一段含空格：只有当它是内建权威名时才认
       * （Mandatory Label\Medium Mandatory Level 就是这一形态） */
      const hl = head.toUpperCase();
      return AUTHORITY_HEADS.some((k) => hl === k);
    }
    return true;
  }

  /* 纯空格单词组（CREATOR OWNER 之类，无域前缀），首字母起头。
   * 排除盘符形态与带路径分隔符的片段。 */
  if (/^[A-Za-z][A-Za-z0-9 _-]*$/.test(c) && !/^[A-Za-z]:/.test(c)) return true;
  return false;
}

/**
 * 从「可能是路径+主体」的原始片段里挑出真正的那个主体名。
 *
 * icacls 第一行是 `C:\\path\\a.txt BUILTIN\\Users:(I)(F)` —— 路径和主体
 * 拼在一起，需要剥掉路径。难点：路径里可能有空格，主体里也可能有空格。
 *
 * 【为什么不按「最后一个空格」切】那会把带空格的主体截断成最后一个词。
 * 实测：
 *   DOMAIN\\Power Users          -> Users
 *   DOMAIN\\Remote Desktop Users -> Users
 *   MyCompany\\Domain Admins     -> Admins
 *   NT AUTHORITY\\SYSTEM         -> AUTHORITY\\SYSTEM
 * 主体认不出是谁，mine 判定也就跟着全错。
 *
 * 【做法】按位置从左往右枚举候选（第 0 个是整段，之后每个都从某个空白之后起），
 * 越靠左的起点 → 候选越长。第一个「形态合法」的就是最长合法主体。
 * 必须先试整段：`DOMAIN\\Power Users` 整段本身就是合法主体，
 * 只有像 `C:\\x\\a.txt BUILTIN\\Users` 这种多段拼装才会被拒，
 * 再往右退到 `BUILTIN\\Users`。
 *
 * @param {string} raw 已去掉尾部冒号的原始片段
 * @returns {string} 主体名；无法判断时返回原串
 */
function pickPrincipal(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';

  /* 没有空格：整段就是主体（DOMAIN\\user 或 BUILTIN\\Users） */
  if (!/\s/.test(v)) return v;

  const positions = [0];
  for (let i = 0; i < v.length; i++) if (/\s/.test(v[i])) positions.push(i + 1);

  /* 从左往右：先整段（最长），再逐段后退。第一个合法形态即最长合法主体。 */
  for (const at of positions) {
    const cand = v.slice(at).trim();
    if (isPlausiblePrincipal(cand)) return cand;
  }

  /* 兜底：最后一个空白之后（与旧行为一致，不会比上面更糟） */
  const idx = v.search(/\s(\S+)$/);
  return idx !== -1 ? v.slice(idx).trim() : v;
}

/**
 * 用「调用方要查的那个路径」把第一行的路径前缀剥掉。
 *
 * 调用方（main.js 的 readAclFacts）本来就知道自己查的是哪个路径，
 * 拿它去剥前缀比按空白猜边界可靠得多（路径里的空格不再是问题）。
 * 只在「第一行确实以该路径开头、且后面紧跟分隔符或空白」时生效，
 * 免得把主体名恰好以路径开头这种巧合当成路径。
 *
 * @param {string} raw  第一行「路径 + 主体」里去掉尾冒号的部分
 * @param {string} hint 调用方传入的路径（可为空）
 * @returns {string} 主体名；剥不出时返回空串
 */
function stripPathHint(raw, hint) {
  if (!hint) return '';
  const toBs = (v) => String(v).replace(/\//g, '\\').replace(/\\+$/, '');
  const a = toBs(raw);
  const h = toBs(hint);
  if (!h || a.length <= h.length) return '';
  if (a.slice(0, h.length).toLowerCase() !== h.toLowerCase()) return '';
  const rest = a.slice(h.length);
  if (!/^[\\\/\s]/.test(rest)) return '';
  return rest.replace(/^[\\\/\s]+/, '').trim();
}

/**
 * 从 icacls 的输出里解析当前用户对该路径的有效权限概况。
 *
 * icacls 输出形如：
 *   C:\path\file.txt  DOMAIN\user:(F)
 *                     BUILTIN\Administrators:(F)
 *                     ...
 * 括号里的字母是权限位：F=完全, M=修改, RX=读取执行, R=读取, W=写入, D=删除
 * 「(DENY)」或「(N)」等表示拒绝项。这里只做**粗粒度**判定：
 * 能给用户讲清「你有没有完全控制」就够了，不需要精确到每个 ACE。
 *
 * @param {string} stdout icacls 的输出
 * @param {string} [userName] 当前用户名（用于找到自己那条）
 * @param {{path?:string}} [opts] 额外上下文；目前只用于把路径从主体名里排除
 * @returns {{entries:Array, hasFull:boolean, hasWrite:boolean, anyFull:boolean,
 *            hasDeny:boolean, deniedForMe:boolean, raw:string}}
 */
function parseIcacls(stdout, userName, opts) {
  const text = String(stdout || '');
  const hint = (opts && opts.path) ? String(opts.path) : '';
  const entries = [];
  let hasFull = false;        // 当前用户自己有完全控制 (F)
  let hasWrite = false;       // 当前用户自己能写（F / M / W 都算）
  let anyFull = false;        // 存在某个主体有完全控制（仅用于展示）
  let hasDeny = false;
  let deniedForMe = false;

  const lines = text.split(/\r?\n/);
  const ACE_RE = /^(.*?)\s*\(([^)]*)\)((?:\([^)]*\))*)$/;

  /* 【先用「续行的缩进」求出主体所在列】
   * icacls 把续行缩进到主体列对齐（本机实测：路径长 62 → 缩进 63；
   * 路径长 56 → 缩进 57；路径长 68 → 缩进 69，即「路径长度 + 1」）。
   * 有了这一列，第一行「路径 + 空格 + 主体」就能被**精确切开**，
   * 不必再靠空白去猜主体从哪开始 —— 而那个猜测在「路径里有空格」时
   * 必然出错（C:\my docs\folder Everyone 猜成 docs\folder Everyone）。
   * 只认「真的被缩进、且去掉缩进后仍能解析成 ACE」的行，
   * 免得把「已成功处理 1 个文件」这类无缩进摘要行算进来。 */
  let principalCol = 0;
  for (const raw of lines) {
    const ind = (raw.match(/^\s*/) || [''])[0].length;
    if (ind <= 0) continue;
    if (!ACE_RE.test(raw.trim())) continue;
    principalCol = principalCol ? Math.min(principalCol, ind) : ind;
  }

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    /* 【真实格式】实际跑 icacls 拿到的样子（本机 Windows 实测）：
     *
     *   D:/x/a.txt BUILTIN\Administrators:(I)(F)
     *              NT AUTHORITY\SYSTEM:(I)(F)
     *              BUILTIN\Users:(I)(RX)
     *
     * 要点：
     *   - 第一行是「路径 + 空格 + 主体」，后续行只有主体（且缩进对齐主体列）；
     *   - 主体以冒号结尾，后面是一串**括号组**；
     *   - (I) 表示「继承而来」，不是权限位；权限位是 (F)/(M)/(RX)/(R)/(W)/(D)；
     *   - 拒绝项显示成 (DENY)，通常出现在权限位之前。
     *
     * 之前用「取第一个括号当权限」的正则，会把 (I) 误当权限、
     * 把第一行的路径误当主体（这两个错误都实测到了），所以按真实结构解析。 */
    const m = ACE_RE.exec(t);
    if (!m) continue;

    /* 主体提取分三级，从最可靠到最有猜测成分：
     *   1) 第一行 + 缩进列已知 → 直接按主体列切开（精确，与路径里的空格无关）
     *   2) 第一行 + 传入了 path（调用方知道自己查的是哪个路径）→ 剥掉该前缀
     *   3) 其余情况 → pickPrincipal 按形态挑
     * 第 3 级是唯一的启发式，它在「路径含空格 + 主体是裸名字」这类
     * 且**没有续行可参考**的组合下仍可能猜错（此时宁可选更短的那个）。 */
    const lead = (line.match(/^\s*/) || [''])[0].length;
    let principal = (m[1] || '').trim();
    // 去掉主体末尾的冒号
    principal = principal.replace(/:$/, '').trim();

    let byCol = '';
    if (lead === 0 && principalCol > 0 && principalCol < line.length && /\s/.test(line[principalCol - 1])) {
      const cut = line.slice(principalCol);
      const m2 = ACE_RE.exec(cut.trim());
      if (m2) byCol = String(m2[1] || '').trim().replace(/:$/, '').trim();
    }
    const byHint = lead === 0 ? stripPathHint(principal, hint) : '';

    if (byCol && (!/\s/.test(byCol) || isPlausiblePrincipal(byCol))) {
      principal = byCol;
    } else if (byHint && (!/\s/.test(byHint) || isPlausiblePrincipal(byHint))) {
      principal = byHint;
    } else {
      principal = pickPrincipal(principal);
    }
    if (!principal) continue;

    /* 收集所有括号组，识别 DENY 与真正的权限位 */
    const groups = [String(m[2])].concat((m[3] || '').match(/\(([^)]*)\)/g) || [])
      .map((g) => String(g).replace(/[()]/g, '').trim().toUpperCase());

    const deny = groups.indexOf('DENY') !== -1;
    /* 权限位是「除 I/O/IO/CI/OI/DENY 之外」的那个缩写
     * （(I)=继承, (OI)=对象继承, (CI)=容器继承, (IO)=仅继承） */
    const FLAGS = ['I', 'OI', 'CI', 'IO', 'DENY', 'NP'];
    let perms = '';
    for (const g of groups) {
      if (FLAGS.indexOf(g) !== -1) continue;
      if (/^[A-Z]{1,4}$/.test(g)) { perms = g; break; }
    }

    const entry = { principal, perms, deny };
    entries.push(entry);
    if (deny) hasDeny = true;

    /* 【精确比较，不做子串包含】早期是
     *   principal.toLowerCase().indexOf(short) !== -1
     * 于是 DOMAIN\admin 会命中 BUILTIN\Administrators、
     * DOMAIN\sys 命中 NT AUTHORITY\SYSTEM —— 假阳性。
     * 判据统一收到 principalEq（与 ownerIsMe 共用一份实现，
     * 避免两处各自写一套后缀匹配、各自错）。 */
    if (userName && principalEq(principal, userName)) {
      entry.mine = true;
      if (deny) deniedForMe = true;
    }

    /* 【hasFull 只认「当前用户自己那条」】
     * 早期这里是「ACL 里任意主体有 (F) 就算有完全控制」。那会得出错误结论：
     * 文件属主是 Administrators 且带 (F)、但当前进程没提权时，
     * hasFull 为 true → 诊断认为「权限没问题」→ 用户实际照样删不掉。
     * 现在按 ACU 主体归属判断；anyFull 另存一份，只用于展示
     * 「谁有完全控制」，不参与诊断。
     *
     * 【写权限不等于「完全控制」】
     * 原实现只认 (F)，于是 (M)（修改）与 (W)（写）全被当成「没有写权限」：
     *   HOME\user:(M)  →  diagnose 报 NO_WRITE「你缺少写入/删除权限」
     * 而 (M) 本来就能读能写能删，(W) 也能写 —— 用户明明能改这个文件，
     * 却被指去跑一遍提权修复流程。实测 Windows 默认 ACL 里
     * `NT AUTHORITY\Authenticated Users:(I)(M)` 就是这个形态，
     * 所以这个误判在普通文件上非常普遍。
     * 现在单独记 hasWrite（F/M/W 都算），诊断改看它；
     * hasFull 保留原语义（真正意义上的完全控制），供别处使用。 */
    if (!deny && (perms === 'F' || perms === 'M' || perms === 'W')) {
      if (perms === 'F') {
        anyFull = true;
        if (userName && entry.mine) hasFull = true;
      }
      if (userName && entry.mine) hasWrite = true;
    }
  }

  return { entries, hasFull, hasWrite, anyFull, hasDeny, deniedForMe, raw: text };
}

/**
 * 判断「这个路径需要哪种修复」。
 *
 * @param {object} s
 * @param {boolean} s.exists 路径是否存在
 * @param {boolean} s.isDir 是否目录
 * @param {boolean} s.ownerIsMe 当前所有者是否就是用户
 * @param {string} s.ownerName 所有者名字（用于展示）
 * @param {object} s.acl parseIcacls 的结果
 * @param {string} s.accessError 尝试访问时的错误（可空）
 * @param {boolean} s.isAdmin 是否以管理员运行
 * @param {number} s.childCount 子项数量（-1 表示未知）
 * @param {string[]} [s.lockedPaths] 被占用的文件路径（Restart Manager 查到的）
 * @param {string} [s.lockCheckError] 占用查询本身失败时的原因
 * @param {boolean} [s.hasWrite] 当前用户是否可写（ACL 判定的中间结果）
 * @returns {{ok:boolean, codes:string[], messages:string[], needAdmin:boolean, risk:string,
 *            repairPossible:boolean}}
 */
function diagnose(s) {
  /* 【为什么用参数默认值而不是 `const x = s || {}`】
   * 后者会让类型推断退化成 `{}` —— 于是 x.exists / x.lockedPaths / x.ownerIsMe
   * 这些**本来就在 JSDoc 里写清楚**的字段全部变成「不存在」，
   * checkJs 一次报出十几条假错，把它真正的价值（发现拼错的字段名）淹掉。
   * 参数默认值语义完全相同（s 为 null/undefined 时得到 {}），但类型不丢。 */
  const x = s || /** @type {typeof s} */ ({});
  const codes = [];
  const messages = [];

  if (!x.exists) {
    /* 【这里的 repairPossible 不能省】
     * diagnose 有两条返回路径，另一条（正常诊断）带 repairPossible。
     * 少这一个字段时，调用方读 r.repairPossible 会在「路径不存在」这条分支上
     * 拿到 undefined —— 而 undefined 是假值，界面会显示「无法修复」，
     * 用户看到的是一句与实际情况无关的结论。
     * 路径都不存在，当然也无法修复，所以这里明确给 false。
     * （`checkJs` 的 TS2741 就是这么发现的：它比对了两条返回路径的字段集合。） */
    return {
      ok: false, codes: ['NOT_EXIST'],
      messages: ['路径不存在或无法访问'],
      needAdmin: false, risk: '无',
      repairPossible: false,
    };
  }

  /* 占用问题优先提示：它和权限问题长得一样，但修复方式完全不同 */
  if (x.lockedPaths && x.lockedPaths.length) {
    codes.push('LOCKED');
    messages.push(PROBLEM.LOCKED + '（有 ' + x.lockedPaths.length + ' 个文件被占用）');
  }

  /* 【ownerIsMe 有三态：true / false / null(读不到)】
   * 早期这里写的是 `if (!x.ownerIsMe)`，把 null（Get-Acl 读取失败、
   * 或取当前用户名失败）也当成了「所有者不是你」——
   * 于是明明权限完全正常、我只是没读到所有者信息，诊断却报
   * 「当前所有者不是你，因此你无法修改它的权限」。
   * 这正是本模块要避免的那类错误：把「读不到」渲染成「有问题」。
   * CI 的 runneradmin 上就实测到了（owner=null、hasFull=true、却报 OWNER）。
   * 只在确定 false 时才报警；null 归入「未知」，并如实说明读不到。 */
  if (x.ownerIsMe === false) {
    codes.push('OWNER');
    messages.push(PROBLEM.OWNER + (x.ownerName ? '（当前所有者：' + x.ownerName + '）' : ''));
  } else if (x.ownerIsMe === null || x.ownerIsMe === undefined) {
    /* 读不到所有者：不猜。这条不进 codes（不构成「问题」），只提示信息不全。 */
    messages.push('无法读取所有者信息（Get-Acl 没有返回结果），' +
      '因此不能判断「所有者是不是你」—— 这不等于有问题。');
  }

  const acl = x.acl || {};
  if (acl.deniedForMe) {
    codes.push('DENY');
    messages.push(PROBLEM.DENY);
  }

  /* 【有 ACL 但没有「我」那条时，结论必须是「未知」而不是「没问题」】
   * 常见情形：文件属主是 Administrators、ACL 里只有 Administrators 与 SYSTEM，
   * 当前进程又没提权 —— 这时 icacls 输出里根本找不到当前用户的 ACE。
   * 早期实现只检查「任意主体有没有 (F)」，于是判为没有权限问题，
   * 而用户实际照样删不掉。这里明确按「无法确定」处理并提示提权。 */
  if (acl.entries && acl.entries.length && !acl.deniedForMe) {
    /* 用 hasWrite 而不是 hasFull：(M)/(W) 同样能写能删，
     * 只看 (F) 会把普通用户在自己文件上的正常权限判成「缺少写入权限」。 */
    if (!acl.hasWrite && !acl.hasFull) {
      codes.push('NO_WRITE');
      messages.push(PROBLEM.NO_WRITE);
    } else if (x.ownerIsMe === false) {
      /* 自己有 (F) 但所有者不是你：仍可能因为父目录的删除权限而失败，
       * 这种情况提示需要提权，不留「看起来没问题」的死角。
       * 注意仍只认明确的 false —— ownerIsMe 为 null 表示读不到，
       * 那时不该编出「所有者不是你」这个结论（它可能根本就是你）。 */
      if (!x.isAdmin && codes.indexOf('OWNER') === -1) {
        codes.push('OWNER');
        messages.push(PROBLEM.OWNER + (x.ownerName ? '（当前所有者：' + x.ownerName + '）' : ''));
      }
    }
  }

  if (x.accessError) {
    const e = String(x.accessError);
    if (/EPERM|EACCES|拒绝访问|Access is denied/i.test(e)) {
      if (!codes.length) codes.push('UNKNOWN');
      messages.push('访问被拒绝：' + e);
    }
  }

  /* 需要管理员的情形：改所有者（takeown）对系统目录/别的用户目录基本都要提权 */
  const needAdmin = !x.isAdmin && (codes.indexOf('OWNER') !== -1 || codes.indexOf('DENY') !== -1);

  if (codes.indexOf('OWNER') !== -1) {
    /* 「改所有者」这一步只有管理员能做；普通权限下 takeown 会失败 */
    if (!x.isAdmin) messages.push(PROBLEM.ADMIN);
  }

  /* 风险提示必须把「会波及多少项」说清楚，这是分寸所在 */
  let risk;
  if (x.isDir) {
    const n = x.childCount;
    risk = n >= 0
      ? '这是一个目录，修复会作用于它本身及其下全部 ' + n + ' 个条目'
      : '这是一个目录，修复会作用于它本身及其下所有子项（数量未知）';
  } else {
    risk = '这是一个文件，修复只作用于它本身';
  }

  return {
    ok: codes.length === 0,
    codes,
    messages,
    needAdmin,
    risk,
    repairPossible: !!(x.isAdmin || codes.indexOf('OWNER') === -1),
  };
}

/**
 * 构造修复命令（**不执行**，纯字符串生成，便于审计与测试）。
 *
 * 步骤（顺序不能乱）：
 *   1. takeown /F <path> [/R] [/D Y]  —— 把所有者改成当前用户
 *   2. icacls <path> /grant <user>:(OI)(CI)F [/T] —— 授予完全控制
 *
 * 【为什么必须先 takeown 再 icacls】
 * 如果所有者不是你，你连「改权限」的权利都没有（WRITE_DAC 不在你手里），
 * icacls 会直接报「拒绝访问」。所以顺序是硬的。
 *
 * 【/D Y 是什么】takeown 递归时会为每个拒绝的路径提问，/D Y 表示默认答「是」，
 * 避免非交互环境下卡住。
 *
 * @param {object} p
 * @param {string} p.path 目标（用户显式选中的那一个）
 * @param {boolean} p.isDir
 * @param {boolean} p.recursive 是否递归到子项
 * @param {string} p.user 要授权的用户（默认当前用户）
 * @returns {{steps:Array<{tool:string,args:string[],desc:string}>, note:string}}
 */
function buildRepairCommands(p) {
  /* 同上：`p || {}` 会让 x 退化成 {} 并丢掉 p 的全部字段类型，改用类型断言保住它。 */
  const x = p || /** @type {typeof p} */ ({});
  const target = String(x.path || '');
  if (!target) throw new Error('没有指定目标路径');

  const user = String(x.user || '');
  if (!user) throw new Error('没有指定要授权的用户');

  const steps = [];
  const recursive = !!x.recursive && !!x.isDir;

  /* takeown：取得所有权 */
  const takeArgs = ['/F', target];
  if (recursive) takeArgs.push('/R', '/D', 'Y');
  steps.push({
    tool: 'takeown', args: takeArgs,
    desc: '把' + (recursive ? '该目录及其所有子项' : '该路径') + '的所有者改为当前用户',
  });

  /* icacls：授予完全控制
   * (OI) = 对象继承（文件继承），(CI) = 容器继承（目录继承）
   * 这两个标记让子项自动继承权限，否则新放进去的文件又会没权限。 */
  const grantSpec = user + ':(OI)(CI)F';
  const icaclsArgs = [target, '/grant', grantSpec];
  if (recursive) icaclsArgs.push('/T');
  /* /Q 减少输出噪音；/C 遇到错误继续（单个子项失败不至于整体中断） */
  icaclsArgs.push('/Q', '/C');
  steps.push({
    tool: 'icacls', args: icaclsArgs,
    desc: '给' + user + '授予完全控制权限' + (recursive ? '（含全部子项）' : ''),
  });

  return {
    steps,
    note: recursive
      ? '注意：递归模式会改动该目录下每一个条目 —— 只在你确实需要整棵树时使用'
      : '只作用于你选中的这一个路径',
  };
}

/**
 * 是否需要「提权重试」的建议。
 * 被 path-guard 拒绝时，除了报「拒绝操作」，还应该告诉用户下一步能做什么。
 * @param {{code:string}} rejection pathGuard 返回的拒绝对象
 * @returns {{retryable:boolean, advice:string}}
 */
function adviceForRejection(rejection) {
  const code = String((rejection && rejection.code) || '');
  /* 系统关键目录是**不该**修的目标：即便提权也不该让用户去改 System32 的权限。
   * 这类只给解释，不给「提权修复」的引导。 */
  if (code === 'CRITICAL' || code === 'SYSTEM_DIR' || code === 'WINDIR') {
    return {
      retryable: false,
      advice: '这是系统关键目录。即便提权也不建议修改它的权限 —— ' +
              '改错会导致系统更新失败或被安全软件拦截。请换个目标，或直接联系软件作者。',
    };
  }
  return {
    retryable: true,
    advice: '如果确认这是你自己的文件，可以用「权限修复」取得所有权后再试。' +
            '注意：给目录授权会连带其下所有子项。',
  };
}

module.exports = {
  PROBLEM, parseIcacls, diagnose, buildRepairCommands, adviceForRejection,
  pickPrincipal, isPlausiblePrincipal, tailLooksLikePath, stripPathHint,
  /* 主体相等判定：parseIcacls 的 mine 与 main.js 的 ownerIsMe 共用这一份，
   * 避免两处各写一套后缀匹配、各自出错。 */
  principalEq,
};
