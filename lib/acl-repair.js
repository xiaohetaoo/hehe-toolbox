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
 * @returns {{entries:Array, hasFull:boolean, hasDeny:boolean, deniedForMe:boolean, raw:string}}
 */
function parseIcacls(stdout, userName) {
  const text = String(stdout || '');
  const entries = [];
  let hasFull = false;        // 当前用户自己有完全控制
  let anyFull = false;        // 存在某个主体有完全控制（仅用于展示）
  let hasDeny = false;
  let deniedForMe = false;

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    /* 【真实格式】实际跑 icacls 拿到的样子（本机 Windows 实测）：
     *
     *   D:/x/a.txt BUILTIN\Administrators:(I)(F)
     *              NT AUTHORITY\SYSTEM:(I)(F)
     *              BUILTIN\Users:(I)(RX)
     *
     * 要点：
     *   - 第一行是「路径 + 空格 + 主体」，后续行只有主体；
     *   - 主体以冒号结尾，后面是一串**括号组**；
     *   - (I) 表示「继承而来」，不是权限位；权限位是 (F)/(M)/(RX)/(R)/(W)/(D)；
     *   - 拒绝项显示成 (DENY)，通常出现在权限位之前。
     *
     * 之前用「取第一个括号当权限」的正则，会把 (I) 误当权限、
     * 把第一行的路径误当主体（这两个错误都实测到了），所以按真实结构解析。 */
    const m = /^(.*?)\s*\(([^)]*)\)((?:\([^)]*\))*)$/.exec(t);
    if (!m) continue;

    /* 主体：第一行是「路径 + 空格 + 主体」，后续行只有主体。
     *
     * 【不能正着剥盘符前缀】早期写的是
     *   principal.replace(/^[A-Za-z]:[\/][^\s]*\s+/, '')
     * 但 [^\s]* 遇到路径里的空格就停，于是
     *   C:\my docs\a.txt BUILTIN\Users:(I)(F)
     * 会解析出主体 `docs\a.txt BUILTIN\Users` —— 路径尾巴和主体拼在一起。
     *
     * 【也不能简单按最后一个空白切】主体本身可能含空格。实测同一份真实输出里
     * 就有 `NT AUTHORITY\SYSTEM`：按最后一个空白切会得到 `AUTHORITY\SYSTEM`。
     *
     * 所以分两步：
     *   1) 先认「已知的含空格主体」（Windows 内建的几个系统账号），
     *      它们在路径之后的位置用 lastIndexOf 定位最可靠；
     *   2) 其余情况按最后一个空白切（路径含空格而主体不含空格时这条正确）。
     * 这套组合在现场样本上验证过：C:\...\my docs\a b.txt NT AUTHORITY\SYSTEM
     * 能正确得到 NT AUTHORITY\SYSTEM。 */
    let principal = (m[1] || '').trim();
    // 去掉主体末尾的冒号
    principal = principal.replace(/:$/, '').trim();
    /* Windows 内建的含空格账号：这些名字里有一个空格，不能按空白切 */
    const MULTIWORD_PRINCIPALS = [
      'NT AUTHORITY', 'NT SERVICE', 'NT T AUTHORITY',
      'CREATOR OWNER', 'CREATOR GROUP', 'APPLICATION PACKAGE AUTHORITY',
      'ALL APPLICATION PACKAGES', 'ALL RESTRICTED APPLICATION PACKAGES',
    ];
    if (/\s/.test(principal)) {
      let picked = null;
      for (const kw of MULTIWORD_PRINCIPALS) {
        /* 只认「出现在路径之后」的那一处：用前面有空白 + 不是开头来判定 */
        const at = principal.lastIndexOf(' ' + kw);
        if (at !== -1) { picked = principal.slice(at + 1).trim(); break; }
      }
      if (picked) {
        principal = picked;
      } else {
        /* 普通主体（无空格，形如 DOMAIN\user 或 BUILTIN\Users）：
         * 路径可能在最后一个空白之前，也可能整段都是路径 ——
         * 取最后一个空白之后即可；没有空白说明整段就是主体。 */
        const idx = principal.search(/\s(\S+)$/);
        if (idx !== -1) principal = principal.slice(idx).trim();
      }
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

    const short = String(userName || '').split('\\').pop().toLowerCase();
    if (short && principal.toLowerCase().indexOf(short) !== -1) {
      entry.mine = true;
      if (deny) deniedForMe = true;
    }

    /* 【hasFull 只认「当前用户自己那条」】
     * 早期这里是「ACL 里任意主体有 (F) 就算有完全控制」。那会得出错误结论：
     * 文件属主是 Administrators 且带 (F)、但当前进程没提权时，
     * hasFull 为 true → 诊断认为「权限没问题」→ 用户实际照样删不掉。
     * 现在按 ACU 主体归属判断；anyFull 另存一份，只用于展示
     * 「谁有完全控制」，不参与诊断。 */
    if (perms === 'F' && !deny) {
      anyFull = true;
      if (userName && entry.mine) hasFull = true;
    }
  }

  return { entries, hasFull, anyFull, hasDeny, deniedForMe, raw: text };
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
 * @returns {{ok:boolean, codes:string[], messages:string[], needAdmin:boolean, risk:string}}
 */
function diagnose(s) {
  const x = s || {};
  const codes = [];
  const messages = [];

  if (!x.exists) {
    return {
      ok: false, codes: ['NOT_EXIST'],
      messages: ['路径不存在或无法访问'],
      needAdmin: false, risk: '无',
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
    if (!acl.hasFull) {
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
      ? '这是一个目录，修复会作用于它本身及**其下全部 ' + n + ' 个条目**'
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
  const x = p || {};
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
};
