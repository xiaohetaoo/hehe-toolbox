'use strict';
/* IPC 通道名的**唯一来源**。
 *
 * ============ 为什么需要它 ============
 * 164 个通道名此前是三处独立的字符串字面量：
 *   · main.js 里 `handle('fs:read-text', ...)`
 *   · 渲染层里 `invoke('fs:read-text', ...)`
 *   · test-ipc-channels.js 用**正则扫两边源码**再做差集
 * 前两处靠人眼对齐，第三处靠文本匹配 —— 三者没有任何编译期约束。
 * 打错一个字母（`fs:read-text` vs `fs:readtext`）的表现是运行时
 * 「调用失败：No handler registered」，而这条链路没有任何测试能提前发现
 * （因为测试本身也是扫文本，两边都错成一样的就查不出来）。
 *
 * ============ 迁移策略：分域推进，不做一次大改 ============
 * 这一轮**只迁移两个域**（目录搬家 dir:、权限与链接 acl:/link:/file:who-locks），
 * 其余通道保持原样、列入下面的 TODO。理由：
 *   · 164 个通道一次性换成常量，改动面覆盖 main.js 与 20 个渲染层文件，
 *     一旦哪里漏了就是"运行时才炸"，而现有测试（扫文本）恰好抓不到 ——
 *     风险与收益不成比例。
 *   · 先拿两个域验证机制（含 lib↔渲染层的同步校验），再逐域推广。
 *
 * ============ 渲染层怎么用 ============
 * 渲染层在 contextIsolation 下**不能 require** lib/，所以另有一份
 * js/channels.js。两份必须一致，由 scripts/test-channels-sync.js 校验
 * （做法参照 test-job-prefix-sync.js：解析两边的键集合做比对）。
 * 注意：这里比 job 前缀那套更严 —— 不只比**键**，还比**值**，
 * 因为通道名拼错的表现和"键不同"一样是静默失败。
 */

/* 每个域一个分组对象。键是语义名，值是真实通道名。 */
const CHANNELS = {
  /* ---- 目录搬家（dir-* 通道）----
   * 名字与 lib/dir-move.js 的状态机对齐：precheck 只校验、move 真正执行。
   * 拆成两个通道而不是一个，是因为预检必须能在**不产生任何副作用**的前提下
   * 反复调用（用户改一下目标路径就会重查），而执行是一次性的。 */
  DIR_MOVE: {
    PRECHECK: 'dir:move-precheck',
    MOVE: 'dir:move',
  },

  /* ---- 权限与链接（acl / link / file 域）----
   * 这几组语义互相咬合：链接体检（link:scan）会调权限诊断（acl:diagnose）
   * 的同一套判据，所以放在同一组里常量化，改一处两边同步。 */
  ACL_LINKS: {
    ACL_DIAGNOSE: 'acl:diagnose',
    ACL_REPAIR: 'acl:repair',
    LINK_SCAN: 'link:scan',
    LINK_REMOVE: 'link:remove',
    /* 文件被哪个进程占用：单文件版与目录版。
     * 两个通道而不是一个，是因为 Restart Manager 的批量语义与单文件查询
     * 返回结构不同（见 lib/rm-lockers.js 顶部说明）。 */
    WHO_LOCKS: 'file:who-locks',
    WHO_LOCKS_DIR: 'file:who-locks-dir',
  },

  /* ============================================================
   * TODO（下一轮逐域迁移，按这里列出的顺序推进）
   * 每迁移一个域：在 CHANNELS 里加一组、主进程的 handle 换成常量、
   * 渲染层的 invoke 换成常量、同步 js/channels.js、跑 test-channels-sync。
   *
   * 【当前进度：已迁移 8/164，未迁移 156】
   * 这两个数字不是手写的，由 scripts/test-channels-sync.js 每次跑测试时
   * 从「主进程实际注册的通道」与「本表」算出来并**比对下面这张清单**。
   * 也就是说：迁移了一个域却忘了改这里，测试会红。
   * 这是本轮加的防倒退断言之一 —— 在此之前，TODO 清单是一个
   * 「写了就没人再看的注释」，而迁移进度只能靠人肉数。
   *
   * 【剩下 156 条的分布】（按域，括号内是该域通道数）
   *   fs:     26 条（最大的一个域，建议最后做，因为它被渲染层引用最多）
   *   win:     9 条
   *   ffmpeg:  9 条
   *   app:     7 条
   *   net:     7 条
   *   search:  7 条
   *   clip:    6 条
   *   sys:     5 条  hosts: 5 条  rec: 5 条
   *   autostart/ctxmenu/winmgr/seven/update: 各 4 条
   *   dangerous/store/proc/server/target/tts/snip/sched: 各 3 条
   *   其余 2 条与 1 条的域：dialog/text/zip/exec/screen/lunar/office/wifi/svc/power/
   *   shell/job/lan/qr/content/notes
   * ============================================================ */
};

/* 把分组对象拍平成「语义键 → 通道名」的 Map，便于校验与查找。
 * 键形如 'DIR_MOVE.MOVE'。 */
function flatten(groups) {
  const out = {};
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') out[prefix ? prefix + '.' + k : k] = v;
      else walk(v, prefix ? prefix + '.' + k : k);
    }
  };
  walk(groups || CHANNELS, '');
  return out;
}

/* ============================================================
 * 迁移进度声明（机读，供 scripts/test-channels-sync.js 比对）
 *
 * 【为什么要有这个常量】
 * 上面那段 TODO 注释是给人看的，但它和所有注释一样会过期：
 * 迁移完一个域之后，没人会想起来回来把 164 改成 156。
 * 一旦注释里的数字与事实不符，它就变成了**误导**——
 * 后来者会以为还有 26 个 fs 通道没迁，而实际上可能已经迁完了。
 *
 * 所以把「总共有多少条」「已迁移多少条」做成导出常量，
 * 让测试能拿它和「主进程实际注册的通道」算出的数字对账。
 * 迁移一个域时**必须**同时改这里 —— 测试会强制你改。
 * ============================================================ */
const MIGRATION = {
  /* 通道总数（本轮不改迁移策略，所以它是固定的） */
  TOTAL: 164,
  /* 已经换成常量引用的通道数 = flatten(CHANNELS) 的条目数。
   * 这里写死而不是用 Object.keys(flatten()).length 动态算，
   * 是为了让「加了常量但没在主进程用上」这种情况也能被发现：
   * 动态算的话，往表里加一条就自动算"已迁移"，而主进程可能还在用字面量。 */
  MIGRATED: 8,
};

module.exports = { CHANNELS, flatten, MIGRATION };
