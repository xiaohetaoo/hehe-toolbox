'use strict';
/* 目录搬家（建链接替身）的**纯逻辑**部分：校验与状态机定义。
 *
 * 真正的 IO 在主进程里做，这里只放「能单测的判据」，因为搬家一旦出错
 * 就是数据事故，必须能在没有真实磁盘的情况下把这些规则测透。
 *
 * 【为什么是「复制 → 校验 → 改名 → 建链接 → 验链接 → 删备份」这个顺序】
 * 每一步都为「失败时能原地回退」服务：
 *   1. 复制到目标（源不动）—— 失败：删掉拷了一半的目标副本，源完好
 *   2. 逐文件校验（大小 + 抽样哈希）—— 失败：同上，源完好
 *   3. 源改名为 .bak —— 此时源已不在原名，但数据都在 .bak 里
 *   4. 在原位置建目录联接 —— 失败：**立刻把 .bak 改回原名**（关键回退）
 *   5. 验证链接可读（真的能读到里面的文件）—— 失败：拆链接 + 回退改名
 *   6. 最后才删 .bak
 *
 * 第 3~5 步之间是唯一的「危险窗口」：源已改名、链接还没建成，
 * 此时原路径下什么都没有，用户双击会落空。所以 4、5 两步的任何失败
 * 都必须无条件先恢复源目录名，再报错。这条规则由 rollbackPlan() 表达，
 * 主进程必须按它执行。
 */

/* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
const path = require('path');
/* 【为什么这里敢直接依赖 path-guard】
 * 目标闸门必须是「默认就生效」的：调用方忘了传 dstProtected，
 * 搬家就会把整棵树写进系统目录。所以没传时由本模块自己算一遍，
 * 传了就用调用方的结论（main.js 两阶段都传）。path-guard 只依赖 path/fs，不会绕回来。 */
const pathGuard = require('./path-guard');

/** 搬家被拒绝的原因（每一条都要能在界面上讲清「为什么不行」）。 */
const REJECT = {
  SRC_MISSING: '源目录不存在',
  SRC_NOT_DIR: '源路径不是目录',
  SRC_IS_LINK: '源本身已经是链接，无法再搬一次',
  SRC_IS_ROOT: '源是盘符根目录，不能搬',
  SRC_CRITICAL: '源目录位于系统关键目录内，拒绝操作',
  DST_PROTECTED: '目标位置位于受保护的目录内，拒绝操作',
  /* 【网络位置必须提前拦，不能等到建链接时才发现】
   * 搬家的收尾动作是在**原位置**建目录联接（junction），而 Windows 的
   * junction 只能指向本地卷 —— 指向 UNC 路径根本建不出来。
   * 早期没有这条判据，于是「搬到 \\nas\share」会一路走完：
   * 完整复制一遍（可能几十分钟）、校验通过、源目录改名成 .hehe-bak、
   * **然后建链接失败** → 回退。用户白等一场，而且这一步的回退是
   * 数据风险最集中的窗口（源已改名、链接还没建）。
   * 早失败、零代价，并说清该怎么做。 */
  DST_UNC: '不能搬到网络位置（UNC 路径）：搬家会在原位置创建目录联接，' +
    '而 Windows 的联接只能指向本地磁盘',
  DST_SAME: '目标与源是同一个路径',
  DST_INSIDE_SRC: '目标在源目录内部（会无限递归）',
  SRC_INSIDE_DST: '源在目标目录内部，会破坏目录结构',
  SAME_VOLUME: '源与目标在同一个卷 —— 同卷不需要复制，直接移动或改路径即可',
  DST_EXISTS: '目标位置已存在同名项',
  NO_SPACE: '目标盘剩余空间不足',
  LOCKED: '源目录内有文件正被进程占用',
  BAK_LEFTOVER: '上次搬家残留了备份（.hehe-bak），必须先处理掉才能再搬',
};

/**
 * 校验搬家请求（纯逻辑，不做 IO）。
 * @param {object} p
 * @param {string} p.src 源目录
 * @param {string} p.dst 目标目录（搬运后的完整落点）
 * @param {boolean} p.srcExists 源路径是否存在（调用方已 stat 过；少了它会漏判 SRC_MISSING）
 * @param {boolean} p.srcIsDir 源是否为目录
 * @param {boolean} p.srcIsLink
 * @param {boolean} p.srcIsRoot
 * @param {boolean} p.srcIsCritical
 * @param {string} [p.srcProtectedReason] 源受保护的具体原因（会拼进 SRC_CRITICAL 的 reason）
 * @param {string} [p.srcProtectedKind] 源受保护的类型（OWN_HOME / OTHER_HOME / SYSTEM / VOLUME_ROOT，用于给不同建议）
 * @param {boolean} [p.dstProtected] 目标路径是否落在受保护目录内（系统目录/盘符根/别人的家目录）
 * @param {string} [p.dstProtectedReason] 目标受保护的具体原因（用于提示文案）
 * @param {boolean} p.dstExists
 * @param {number} p.needBytes 需要复制的字节数
 * @param {number} p.freeBytes 目标盘剩余字节
 * @param {string[]} p.lockedPaths 被占用的文件（可空）
 * @param {boolean} [p.allowSameVolume] 允许同卷（默认不允许）
 * @param {boolean} [p.bakExists] 备份路径（src + '.hehe-bak'）是否已存在
 * @param {string} [p.bakPath] 备份路径（仅用于把完整路径写进提示）
 * @returns {{ok:boolean, code:string|null, reason:string, advice:string, freeBytesUnknown?:boolean}}
 */
function validateMove(p) {
  const x = p || /** @type {typeof p} */ ({});
  const src = normWin(x.src);
  const dst = normWin(x.dst);

  if (!src) return fail('SRC_MISSING');
  if (!x.srcExists) return fail('SRC_MISSING');
  if (!x.srcIsDir) return fail('SRC_NOT_DIR');
  if (x.srcIsLink) return fail('SRC_IS_LINK');
  if (x.srcIsRoot) return fail('SRC_IS_ROOT');
  if (x.srcIsCritical) {
    /* 【把「为什么受保护」的原因拼进来，与目标侧对齐】
     * 早期只回笼统的「源目录位于系统关键目录内」—— 而目标侧会把
     * dstProtectedReason 拼上。于是同样是被拦：目标填 C:\Windows\moved
     * 能看到「这里属于系统目录（C:\Windows）」，源选自己的家目录却只看到
     * 「位于系统关键目录内」，用户既不知道这算哪门子关键目录，
     * 也不知道该改成什么（其实选中具体的子文件夹就行）。 */
    const kind = String(x.srcProtectedKind || '');
    const advice = kind === 'OWN_HOME'
      ? '这是你整个用户目录，别搬它本身；请选中它下面的具体子文件夹（例如 Documents 里的那个目录）。'
      : (kind === 'OTHER_HOME'
        ? '这是另一个用户的目录。请改选你自己目录下的文件夹。'
        : '请换一个你自己的目录作为源（不要用系统目录、盘符根或别人的用户目录）。');
    return {
      ok: false, code: 'SRC_CRITICAL',
      reason: REJECT.SRC_CRITICAL + (x.srcProtectedReason ? '：' + x.srcProtectedReason : ''),
      advice,
    };
  }

  /* 【必须先拦残留备份，且必须拦在「复制之前」】
   * 备份名是固定的 src + '.hehe-bak'。第 6 步删备份失败（权限/被占用）后
   * 它会残留下来，而下一次对同一目录搬家就又走一遍：
   * 先完整复制一份数据 → 到「源改名为 .bak」时才 EPERM（因为 .bak 已存在）
   * → 再把刚复制完的副本删掉。
   * 表现就是「这个目录再也搬不动了」，而且每次都要白等一次完整拷贝。
   * 所以放在最前面：早失败、零代价、把完整路径给出来让人能自己处理。
   * 启动时清扫不做 —— 自动删用户磁盘上的东西风险大于收益，
   * 预检拦住就够诚实了。 */
  if (x.bakExists) {
    return {
      ok: false, code: 'BAK_LEFTOVER',
      reason: REJECT.BAK_LEFTOVER + (x.bakPath ? '：' + x.bakPath : ''),
      advice: '请确认那份备份里是不是你还需要的数据：需要就改名保留，' +
        '确认无用再手动删除，然后重新校验。' +
        '（工具不会自动删它 —— 那是你的数据，删错无法恢复。）',
    };
  }

  if (!dst) return fail('DST_SAME');
  /* 【UNC 判据必须用**原始字符串**，不能用归一后的 dst】
   * normWin 会把连续反斜杠折叠成单个反斜杠，而 UNC 的识别标志正好是
   * 开头那两个 —— 归一之后「\\server\share」变成「\server\share」，
   * 看起来就像个普通的相对路径，判据永远不成立。
   * 所以这里对原始入参先 trim 再判，兼容正斜杠写法，并认 \\?\UNC\ 长路径形式。 */
  if (isUncPath(x.dst)) {
    return {
      ok: false, code: 'DST_UNC',
      reason: REJECT.DST_UNC,
      advice: '请先搬到本机另一块盘，再用系统的「网络共享」功能把那个目录发布出去。',
    };
  }
  if (src === dst) return fail('DST_SAME');
  // 目标在源内部：C:\A → C:\A\B（复制自己，无限递归）
  if (isInside(dst, src)) return fail('DST_INSIDE_SRC');
  // 源在目标内部：C:\A\B → C:\A（搬完把自己的父目录搞乱）
  if (isInside(src, dst)) return fail('SRC_INSIDE_DST');

  /* 【目标路径也必须过闸门】
   * 源有 srcIsCritical，目标却一直没有对应判据：用户在「新位置」文本框里
   * 填 C:\\Windows\\moved 就能在系统目录里 mkdir + 整树复制 + 建链接。
   * 全项目其它写盘通道都有 checkOverwritable / isCriticalForOverwrite，
   * 唯独这条「影响面最大」的整树写入没有目标闸。
   * 判据与源一致（path-guard.isProtectedForModify），两阶段都拦。
   *
   * 【没传 dstProtected 就自己算】默认安全：调用方漏传时闸门仍然生效。
   * 只有显式传布尔值时才用它的结论（main.js 两阶段都传）。 */
  const dstProtected = (typeof x.dstProtected === 'boolean')
    ? x.dstProtected
    : pathGuard.isProtectedForModify(dst).protected;
  const dstProtectedReason = x.dstProtectedReason
    || (dstProtected ? pathGuard.isProtectedForModify(dst).reason : '');
  if (dstProtected) {
    return {
      ok: false, code: 'DST_PROTECTED',
      reason: REJECT.DST_PROTECTED + (dstProtectedReason ? '：' + dstProtectedReason : ''),
      advice: '把「新位置」换到你自己盘里的一个目录（例如 D: 下新建的文件夹），' +
        '不要指向系统目录或盘符根。',
    };
  }
  if (x.dstExists) return fail('DST_EXISTS');
  /* 同卷搬家没有意义：文件本来就在同一个盘上，只需改路径（移动）而不是
   * 复制一份再建链接。允许它反而制造「多一份副本」的困惑。 */
  if (!x.allowSameVolume && sameVol(src, dst)) return fail('SAME_VOLUME');

  const need = Number(x.needBytes) || 0;
  /* 【freeBytes 为 null/undefined 表示「读不到」，不是「0 字节可用」】
   * 原写法 `Number(x.freeBytes)` 会把 null 变成 0（Number(null) === 0，
   * 且 Number.isFinite(0) 为 true），于是「拿不到目标盘剩余空间」被渲染成
   * 「剩余 0 GB」—— 搬家被永久拒绝，提示还是「换个盘符，或先清理目标盘空间」，
   * 而真实情况是 statfsSync 失败（网络盘、权限、老 Node）。
   * main.js 在读取失败时明确传的是 null（见 dir:move-precheck 的 catch），
   * 所以这里必须把「未知」与「0」区分开。undefined 原本恰好是 NaN 所以没这问题，
   * 但两种缺失值应当同样处理。 */
  const free = (x.freeBytes == null) ? NaN : Number(x.freeBytes);
  /* 【「读不到剩余空间」必须显式回传给界面，不能静默当成"足够"】
   * freeBytes 是 null 时上面这段不会做 NO_SPACE 判断（正确的，因为无从判断），
   * 但界面原来只显示「（未知）」—— 用户很容易读过就算，以为校验过了。
   * 这个标志让界面能把话说全：空间**没有**被校验。
   * 它放在 ok:true 的返回里（未知 ≠ 不够，不能因此拒掉一次本可以成功的搬家）。 */
  const freeBytesUnknown = !Number.isFinite(free);
  /* 预留 5% 或 64MB 的余量：复制过程本身、链接建立、以及文件系统元数据
   * 都会吃空间，卡着刚好够的容量去做几乎必然失败。 */
  const margin = Math.max(64 * 1024 * 1024, Math.round(need * 0.05));
  if (Number.isFinite(free) && need + margin > free) {
    return {
      ok: false, code: 'NO_SPACE',
      reason: REJECT.NO_SPACE + '：需要 ' + fmtGB(need + margin) + '，剩余 ' + fmtGB(free),
      advice: '换个盘符，或先清理目标盘空间。',
    };
  }

  const locked = Array.isArray(x.lockedPaths) ? x.lockedPaths.filter(Boolean) : [];
  if (locked.length) {
    /* 【文案说「进程」而不是「文件」】
     * Restart Manager 是整批注册路径再取进程列表，拿不到
     * 「哪个路径被哪个进程占用」的对应关系（lib/rm-lockers.js 的
     * Lockers() 就是这么实现的）。所以这里能确定的只有「有 N 个进程
     * 占着源目录里的某些文件」，早期写「N 个文件」是把进程数说成文件数，
     * 而且文件名从头到尾没出现过。
     * 具体是哪些文件，交给「文件占用解锁」工具去查 —— advice 里直说。
     *
     * 详见 docs/decisions/restart-manager-has-no-file-to-process-mapping.md */
    return {
      ok: false, code: 'LOCKED',
      reason: '源目录内有 ' + locked.length + ' 个进程正占用着其中的文件',
      advice: '先关闭占用它们的程序再重试。想知道具体是哪个文件、被谁占用，' +
        '用「文件占用解锁」工具选择这个目录查询（Restart Manager 只能批量给出进程，' +
        '精确到文件需要那一步）。',
    };
  }

  return { ok: true, code: null, reason: '', advice: '', freeBytesUnknown };
}

function fail(code) {
  return { ok: false, code, reason: REJECT[code] || code, advice: '' };
}

/**
 * 是否是 UNC 路径（\\server\share、\\?\UNC\server\share 及正斜杠写法）。
 *
 * 【必须用原始字符串判断】
 * normWin 会把连续反斜杠折叠掉，而 UNC 的识别标志正是开头那两个 ——
 * 归一之后就再也看不出来了。所以这个函数只接受调用方传进来的**原始**值，
 * 内部自己 trim（用户从资源管理器复制粘贴常带首尾空格）。
 *
 * @param {any} p
 * @returns {boolean}
 */
function isUncPath(p) {
  const s = String(p == null ? '' : p).trim().replace(/\//g, '\\');
  if (!s.startsWith('\\\\')) return false;
  /* 排除「本地路径里的一个转义反斜杠」这类误判：真正的 UNC 至少是
   * \\server（两段），\\?\ 是本机的长路径前缀（其下 \\?\UNC\... 才算远程）。
   * \\?\C:\... 是**本地**盘，不能拒。 */
  const low = s.toLowerCase();
  if (low.startsWith('\\\\?\\unc\\')) return true;   // \\?\UNC\server\share
  if (low.startsWith('\\\\?\\')) return false;       // \\?\C:\... 本地长路径
  if (low.startsWith('\\\\.\\')) return false;       // \\.\C: 设备本地路径
  // \\server\share：去掉开头两个反斜杠后还应剩 ≥2 段
  const rest = s.slice(2);
  return rest.length > 0 && rest.includes('\\') && /^[a-z0-9_$.\-\u4e00-\u9fa5]+\\/i.test(rest);
}

/** Windows 路径归一：反斜杠、去尾部分隔符、小写（仅用于比较）。 */
function normWin(p) {
  let s = String(p == null ? '' : p).trim();
  if (!s) return '';
  s = s.replace(/\//g, '\\');
  // 去掉末尾多余的分隔符（但保留盘符根本身 C:\）
  s = s.replace(/\\{2,}/g, '\\');
  if (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
  return s.toLowerCase();
}

/** b 是否在 a 之内（a 为父）。只做字符串前缀判断，避免引入真实路径解析。 */
function isInside(child, parent) {
  const c = normWin(child), p = normWin(parent);
  if (!c || !p) return false;
  // 保证父以分隔符结尾再比较，防止 C:\AB 被当成 C:\A 的子目录
  const withSep = p.endsWith('\\') ? p : p + '\\';
  return c.startsWith(withSep);
}

/** 盘符根（小写，如 "c:\\"）。 */
function volOf(p) {
  const s = normWin(p);
  const m = /^([a-z]):/.exec(s);
  return m ? m[1] + ':\\' : '';
}

function sameVol(a, b) {
  const va = volOf(a), vb = volOf(b);
  return !!va && va === vb;
}

function fmtGB(n) {
  return (Math.round(n / 1024 / 1024 / 102.4) / 10) + ' GB';
}

/**
 * 描述搬家的每一步（供界面「逐步显示」用，而不是一个转圈）。
 * 返回的是**计划**，不是结果；主进程按顺序执行并回报每步状态。
 */
function movePlan(src, dst) {
  return [
    { id: 'check', label: '校验源与目标', detail: '检查占用、同名、空间、同卷' },
    { id: 'copy', label: '复制到新位置', detail: '源目录保持原样，失败可直接放弃' },
    { id: 'verify', label: '逐文件校验', detail: '大小 + 抽样哈希，不只是比字节数' },
    { id: 'rename', label: '源目录改名为 .bak', detail: '此时原位置暂时为空' },
    { id: 'link', label: '在原位置建目录联接', detail: '失败会立刻把 .bak 改回原名' },
    { id: 'linkcheck', label: '验证链接可读', detail: '真的读一遍里面的文件' },
    { id: 'dropbak', label: '删除 .bak 备份', detail: '确认链接可用后才删' },
  ];
}

/**
 * 失败时的回退动作：**按当前进行到哪一步**决定怎么退。
 * 主进程必须严格按返回值执行，不许自己临时发挥。
 * @param {string} stepId 已经完成的最后一步
 * @param {object} ctx {bakPath, srcPath, linkPath, dstPath}
 * @returns {{actions:string[], note:string}}
 */
function rollbackPlan(stepId, ctx) {
  const c = ctx || /** @type {typeof ctx} */ ({});
  switch (stepId) {
    case 'check':
      return { actions: [], note: '还没动数据，无需回退' };

    case 'copy':
    case 'verify':
      /* 只拷了目标副本，源完好：删掉副本即可 */
      return { actions: ['remove-dst'], note: '删除复制了一半的目标副本，源目录完好' };

    case 'rename':
      /* 源已改名成 .bak，还没建链接：原位置是空的，必须把名字改回去 */
      return { actions: ['rename-bak-back'], note: '把 .bak 改回原名（原路径立即恢复）' };

    case 'link':
      /* 最危险的中间态：可能已建了坏链接。先拆链接，再把 .bak 改回原名 */
      return {
        actions: ['remove-link', 'rename-bak-back'],
        note: '删除未建成的链接，再把 .bak 改回原名；数据一直在 .bak 里，没有丢失',
      };

    case 'linkcheck':
      return {
        actions: ['remove-link', 'rename-bak-back'],
        note: '链接不可用：拆掉链接并把 .bak 改回原名',
      };

    case 'dropbak':
      /* 已经删了备份，此时唯一能做的就是让用户知道数据在哪 */
      return {
        actions: [],
        note: '备份已删；源数据已在新位置（' + (c.dstPath || '目标目录') + '），链接指向那里',
      };

    default:
      return { actions: [], note: '未知步骤，请人工检查' };
  }
}

module.exports = {
  /* isUncPath 导出给测试用：UNC 判据必须用**原始字符串**（normWin 会把开头的
   * 两个反斜杠折叠掉），这条约束很难从 validateMove 的黑盒行为上验透，
   * 测试需要直接跑真实现。 */
  REJECT, validateMove, normWin, isInside, volOf, sameVol, movePlan, rollbackPlan, isUncPath,
};
