'use strict';
/* 「文件占用解锁」的安全判据（纯函数，主进程与测试共用）。
 *
 * ============ 为什么解锁必须先过一道判据 ============
 * 解锁的**唯一可靠手段是结束占用文件的进程**（实测结论，见下），
 * 而结束进程是破坏性操作：用户可能正在编辑那个文档、那个进程可能是
 * 数据库/杀软/输入法。所以「允许结束哪些进程」这件事必须有明确、单一、
 * 可测试的判据，不能散在界面代码里靠 if 拼。
 *
 * ============ 实测：为什么不能"绕过锁"而只能结束进程 ============
 * 用一个独占方式打开文件（FileShare.None）的进程做对照，
 * 在锁持有期间逐个尝试（真机实测结果）：
 *     unlink        失败 EBUSY
 *     rename        失败 EBUSY
 *     truncate      失败 EBUSY
 *     open(r+)      失败 EBUSY
 *     copyFile      失败 EBUSY
 * 结束持有进程后：unlink 立刻成功。
 * 也就是说 Windows 上**没有**「不解锁也能删」的旁路 ——
 * 那些号称"强制删除"的工具做的是同一件事（杀进程或注入驱动清句柄）。
 * 本项目不装驱动、不做进程注入，所以诚实地把「结束进程」作为解锁手段，
 * 并在界面上说清楚代价。
 *
 * ============ 判据 ============
 * 允许结束的条件（全部满足）：
 *   ① 不是本程序自己（杀了自己会中断正在进行的写盘）
 *   ② PID 高于低号段（≤1000 几乎全是系统进程）
 *   ③ 进程名不在系统关键名单里（lsass / winlogon / csrss …）
 *   ④ 不是「本程序所在的进程树」（父进程链里有自己）
 * 其中 ①②③ 与 PROC.KILL 完全一致 —— 这里不重复实现，而是把名单与阈值
 * 从那边引过来（`PROTECTED_PROC_NAMES` / `PROTECTED_PROC_PID_MAX`），
 * 避免两份名单长期漂移（历史上已经出现过一次：白名单加了一边忘另一边）。
 */

/* 系统关键进程名（小写）。必须与 main.js 里 PROC.KILL 用的那份**逐项一致** ——
 * 由 scripts/test-file-unlock-release.js 的 UL1 双向比对。
 * 【别在这里"顺手多加几个"，哪怕更严】两份名单只要不完全相同，
 * 下一次改的人就不知道该以哪份为准；而"哪份更严"这件事本身会随上下文变。
 * 要加就先加 main.js，再同步过来。 */
const PROTECTED_PROC_NAMES = new Set([
  'system', 'registry', 'smss', 'csrss', 'wininit', 'services', 'winlogon', 'lsass',
  'lsaiso', 'fontdrvhost', 'dwm', 'memory compression', 'secure system', 'msmpeng',
  'svchost', 'explorer',
]);
const PROTECTED_PROC_PID_MAX = 1000;

/**
 * 能否结束这个进程以解锁文件。
 * @param {{pid:number, name?:string, procName?:string, type?:string}} proc
 * @param {{selfPid?:number, parentChain?:number[]}} [opts]
 * @returns {{ok:boolean, reason:string}} ok=false 时 reason 是给用户看的中文理由
 */
function canKillForUnlock(proc, opts) {
  const o = opts || {};
  const pid = Number(proc && proc.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: '进程 ID 无效，无法结束' };
  }
  /* ① 不能杀自己 */
  if (Number.isFinite(o.selfPid) && pid === Number(o.selfPid)) {
    return { ok: false, reason: '这是本程序自己（结束它会中断正在进行的任务），请改为关闭占用文件的那个程序' };
  }
  /* ④ 不能杀自己的父进程链（典型：用户从终端启动本程序时，
   * 那个终端会出现在占用列表里；杀掉它等于把自己也带走） */
  if (Array.isArray(o.parentChain) && o.parentChain.map(Number).includes(pid)) {
    return { ok: false, reason: '这是启动本程序的上级进程，结束它会连带关闭本程序' };
  }
  /* ② 低 PID 段 */
  if (pid <= PROTECTED_PROC_PID_MAX) {
    return {
      ok: false,
      reason: 'PID ' + pid + ' 落在低号段（≤' + PROTECTED_PROC_PID_MAX +
        '），通常是系统进程。结束它可能造成不可逆损坏 —— 请用任务管理器确认后再操作',
    };
  }
  /* ③ 关键进程名单 */
  const name = String((proc && (proc.procName || proc.name)) || '').trim().toLowerCase();
  if (name && PROTECTED_PROC_NAMES.has(name)) {
    return { ok: false, reason: '「' + name + '」是系统关键进程，结束它会导致蓝屏或强制重启' };
  }
  /* 服务类也拦：服务通常由 SCM 托管，杀掉会被立刻拉起，
   * 而且杀服务的影响面（数据库 / 更新 / 安全软件）远大于普通程序。
   * 想让用户去「服务管理」里停，那里有正规的停止语义。 */
  if (proc && proc.type === 'service') {
    return { ok: false, reason: '这是系统服务，请到「服务管理」里停止它（直接结束会被系统立刻拉起）' };
  }
  return { ok: true, reason: '' };
}

/**
 * 把一批占用进程分成「可结束」与「不可结束」。
 * @param {Array<object>} lockers
 * @param {{selfPid?:number, parentChain?:number[]}} [opts]
 * @returns {{killable:Array<object>, blocked:Array<{pid:number, name:string, reason:string}>}}
 */
function partitionLockers(lockers, opts) {
  const killable = [];
  const blocked = [];
  for (const it of (Array.isArray(lockers) ? lockers : [])) {
    const r = canKillForUnlock(it, opts);
    if (r.ok) killable.push(it);
    else {
      blocked.push({
        pid: it && it.pid,
        name: (it && (it.procName || it.name)) || ('PID ' + (it && it.pid)),
        reason: r.reason,
      });
    }
  }
  return { killable, blocked };
}

/**
 * 解锁结果的文案（界面与日志共用一份）。
 * @param {{killed:Array, failed:Array, blocked:Array, stillLocked:boolean}} r
 * @returns {string}
 */
function unlockSummary(r) {
  /** @type {{killed?:Array<any>, failed?:Array<any>, blocked?:Array<any>, stillLocked?:boolean}} */
  const o = r || {};
  const killed = Array.isArray(o.killed) ? o.killed : [];
  const failed = Array.isArray(o.failed) ? o.failed : [];
  const blocked = Array.isArray(o.blocked) ? o.blocked : [];
  const parts = [];
  if (killed.length) parts.push('已结束 ' + killed.length + ' 个进程（' + killed.map((x) => x.name || ('PID ' + x.pid)).join('、') + '）');
  if (failed.length) parts.push(failed.length + ' 个结束失败（' + failed.map((x) => (x.name || ('PID ' + x.pid)) + '：' + (x.error || '未知原因')).join('；') + '）');
  if (blocked.length) parts.push(blocked.length + ' 个不允许结束（' + blocked.map((x) => (x.name || ('PID ' + x.pid)) + '：' + x.reason).join('；') + '）');
  if (!parts.length) parts.push('没有需要结束的进程');
  if (o.stillLocked) parts.push('但文件仍然被占用 —— 可能还有其它进程或驱动在用它，建议重启后再试');
  return parts.join('；');
}

module.exports = {
  PROTECTED_PROC_NAMES,
  PROTECTED_PROC_PID_MAX,
  canKillForUnlock,
  partitionLockers,
  unlockSummary,
};
