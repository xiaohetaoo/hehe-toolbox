'use strict';
const { t, done, readMain } = require('./lib/harness');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const mainSrc = readMain({ raw: true });
/* 第四轮审查（main.js 破坏性操作专项）的回归测试。
 * 重点覆盖：门禁绕过、系统进程保护、密码脱敏、字段缺失守卫。
 */
const assert = require('assert');


/* 取某个通道的 handle 体。
 *
 * 【要认两种注册形态】任务 6 把两个域的通道名换成了常量：
 *   handle('link:remove', ...)                    ← 迁移前
 *   handle(dirMoveCh.ACL_LINKS.LINK_REMOVE, ...)  ← 迁移后
 * 只认字面量的话，这两个域的用例会全部误报「找不到 handler」。
 * 这里先用 lib/channels.js 的同一份表把通道名反查成常量表达式，再两种都试。
 */
function body(src, channel) {
  let start = src.indexOf("handle('" + channel + "'");
  if (start < 0) {
    let expr = null;
    try {
      const table = require('../lib/channels').flatten();
      for (const k of Object.keys(table)) if (table[k] === channel) { expr = 'dirMoveCh.' + k; break; }
    } catch (e) { /* 表不可用时保持字面量行为 */ }
    if (expr) start = src.indexOf('handle(' + expr + ',');
  }
  assert.ok(start > 0, '找不到 handler: ' + channel);
  return src.slice(start, src.indexOf('\n});', start));
}

/* 去掉注释再断言。否则「注释里写着旧实现」会让测试误判成仍有旧代码，
 * 而注释里描述旧行为恰恰是这类修复的正常做法（要说明为什么改）。 */
/* 【stripComments 统一用 lib/src-scan.js 的实现，不要在这里另写一份】
 * 原来这几行是朴素实现：先用两条正则分别去掉块注释与整行行注释。
 * 它有两个真实缺陷：
 *   ① 不识别正则字面量。net-tools.js 里的字符类含一个双引号，
 *      朴素实现会把它当成字符串开头，之后所有注释与字符串判断全部错位
 *      （lib/src-scan.js 的头部注释记录了这次事故）。
 *   ② 只剥「整行」注释（行首到行尾的那一类），行尾注释里的文字被留下，
 *      于是「某个词只出现在注释里」也会被当成代码命中，断言假绿。
 * 实测同一份 main.js：朴素实现剥后 164145 字符，src-scan 剥后 163767 字符 ——
 * 差的 378 字符正是没被去掉的行尾注释，它们会参与后续正则匹配。
 */

const stripComments = require('../lib/src-scan').stripComments;

/* 任务 5 把搬家/权限两个域搬到 ipc/dir-acl-links.js：这里读「主进程全部源码」
 * （main.js + ipc/），断言的语义是「主进程里有这个实现」，与文件无关。 */
const main = readMain();

/* ---------- P0-1：exec:run 绕过 system-power 门禁 ---------- */
t('P0 exec:run 对关机/重启命令要求 system-power 授权', () => {
  assert.ok(main.includes('function isPowerCommand'), '没有电源命令识别函数');
  assert.ok(main.includes('function assertPowerAllowed'), '没有电源授权断言');
  const fn = body(main, 'exec:run');
  assert.ok(fn.includes('assertPowerAllowed'), 'exec:run 没走电源门禁');
});
t('P0 exec:stream 同样受电源门禁约束', () => {
  const fn = body(main, 'exec:stream');
  assert.ok(fn.includes('assertPowerAllowed'), 'exec:stream 没走电源门禁');
});
t('P0 电源命令识别覆盖 shutdown/重启/休眠', () => {
  /* 实现已抽到 lib/power-gate.js（main.js require 它）。
   * 直接测**真实现**，而不是在 main.js 里搜正则字符串 ——
   * 搜字符串的写法在实现搬家后会直接崩（这条测试就是这么挂的），
   * 而且即使搜到也证明不了行为正确。 */
  const gate = require('../lib/power-gate');
  for (const c of ['shutdown /s', 'shutdown /r', 'Stop-Computer', 'Restart-Computer',
                   'rundll32.exe powrprof.dll,SetSuspendState 0,1,0']) {
    assert.ok(gate.isPowerCommand(c), '未识别: ' + c);
  }
  assert.ok(main.includes("require('./lib/power-gate')"), 'main.js 应引用共享实现');
});

/* ---------- P0-2：proc:kill 系统进程保护 ---------- */
t('P0 proc:kill 有系统进程黑名单', () => {
  assert.ok(main.includes('PROTECTED_PROC_NAMES'), '没有系统进程黑名单');
  const fn = main.match(/const PROTECTED_PROC_NAMES = new Set\(\[[\s\S]*?\]\);/)[0];
  for (const n of ['lsass', 'csrss', 'wininit', 'services', 'winlogon', 'system', 'registry', 'smss']) {
    assert.ok(fn.toLowerCase().includes("'" + n + "'"), '黑名单缺少 ' + n);
  }
});
t('P0 proc:kill 按进程名判断并拒绝关键进程', () => {
  const fn = body(main, 'proc:kill');
  assert.ok(fn.includes('PROTECTED_PROC_NAMES.has'), '没有按名字查黑名单');
  assert.ok(fn.includes('拒绝结束系统关键进程'), '没有拒绝提示');
});
t('P0 proc:kill 拒绝低 PID 区', () => {
  const fn = body(main, 'proc:kill');
  assert.ok(fn.includes('PROTECTED_PROC_PID_MAX'), '没有低 PID 拦截');
});

/* ---------- P0-3：ctxmenu:toggle 门禁 + 路径白名单 ---------- */
t('P0 ctxmenu:toggle 已纳入 registry-edit 门禁', () => {
  const gate = main.match(/const CAP_GATED_CHANNELS = \{[\s\S]*?\};/)[0];
  assert.ok(/'ctxmenu:toggle':\s*'registry-edit'/.test(gate), 'ctxmenu:toggle 不在门禁表');
});
t('P0 ctxmenu:toggle 校验注册表路径白名单', () => {
  const fn = body(main, 'ctxmenu:toggle');
  assert.ok(fn.includes('FULL_ROOTS'), '没有白名单根列表');
  assert.ok(fn.includes('非法的注册表路径'), '没有路径校验');
  assert.ok(fn.includes('层级过深'), '没有层级限制');
});

/* ---------- acl:repair 必须接门禁 ----------
 * 早期 DANGEROUS_CAPS 里声明了 'acl-repair'，但没有任何通道映射到它，
 * TOOL_DANGEROUS_CAPS 里也没有这个工具 —— 开关拨了不生效、卡片不标红，
 * 只要以管理员运行就能直接调 acl:repair。改所有者 + 递归放宽整棵子树的
 * 权限，是这批功能里影响面最大的一个，必须设闸。 */
t('acl:repair 已纳入 acl-repair 门禁', () => {
  const gate = main.match(/const CAP_GATED_CHANNELS = \{[\s\S]*?\};/)[0];
  assert.ok(/'acl:repair':\s*'acl-repair'/.test(gate),
    'acl:repair 不在 CAP_GATED_CHANNELS —— 管理员下可绕过开关直接改权限');
});
t('acl-repair 工具卡片会被标红（登记进 TOOL_DANGEROUS_CAPS）', () => {
  const tbl = main.match(/const TOOL_DANGEROUS_CAPS = \{[\s\S]*?\};/)[0];
  assert.ok(/'acl-repair':\s*\[/.test(tbl), 'acl-repair 不在 TOOL_DANGEROUS_CAPS');
});
t('acl:diagnose 是只读的，不进高危门禁', () => {
  const gate = main.match(/const CAP_GATED_CHANNELS = \{[\s\S]*?\};/)[0];
  assert.ok(!/'acl:diagnose':/.test(gate),
    '诊断只是读取，加门禁会让用户连「得了什么病」都查不了');
});

/* ---------- link:remove 不再逐条起 PowerShell ----------
 * 早期循环里 `await links.linkInfo(p, ps)`，每项启动一次 powershell.exe，
 * 50 个僵尸链接要一两分钟，用户点下去长时间没反馈会重复点。
 * 二次复核（kind !== 'dead' 就 skip）**不能省** —— 只换掉慢的那一层。 */
t('link:remove 循环里不再逐条调 linkInfo/powershell', () => {
  const fn = stripComments(body(main, 'link:remove'));
  assert.ok(!/await\s+links\.linkInfo/.test(fn),
    'link:remove 仍在循环里逐条调 linkInfo（每个链接一次 PowerShell）');
  assert.ok(fn.includes('readlinkSync'),
    '应改用 fs.readlinkSync 读目标（纯文件系统操作，不起进程）');
});
t('link:remove 二次复核没被省略（非僵尸一律 skip）', () => {
  const fn = stripComments(body(main, 'link:remove'));
  assert.ok(fn.includes('classifyLink'), '必须逐项重新分类，不能信渲染层的结论');
  assert.ok(/kind\s*!==\s*'dead'/.test(fn), '非僵尸链接必须跳过');
  assert.ok(fn.includes('removeLinkOnly'), '删除必须只经 removeLinkOnly');
});

/* ---------- 占用查询批量取进程信息 ----------
 * 早期每个占用进程单独 ps 一次取 exe 路径与内存，5 个占用就是 5 次
 * powershell.exe 启动，拖到四五秒。RM 一次就给了全部 pid，没理由逐条查。 */
t('占用查询用一次 PowerShell 取回整批 pid 的信息', () => {
  const fn = main.match(/async function rmQueryLockers[\s\S]*?\n\}/);
  assert.ok(fn, '找不到 rmQueryLockers');
  const code = stripComments(fn[0]);
  assert.ok(code.includes('foreach($id in @('),
    '应把整批 pid 拼进一次调用，而不是循环里逐个 ps()');
  assert.ok(!/for \(const row of rows\)[\s\S]{0,500}await ps\(/.test(code),
    '仍在 for 循环里对每个 row 单独 ps()');
});

/* ---------- P0-4：7z 密码脱敏 ---------- */
t('P0 runCmd 失败信息会脱敏', () => {
  assert.ok(main.includes('function sanitizeCmdError'), '没有脱敏函数');
  const fn = main.match(/function runCmd\(cmd, args, opts = \{\}\) \{[\s\S]*?\n\}/)[0];
  assert.ok(fn.includes('sanitizeCmdError'), 'runCmd 没调脱敏');
});
t('P0 脱敏覆盖 -p 密码与常见 key=value', () => {
  const fn = main.match(/function sanitizeCmdError[\s\S]*?\n\}/)[0];
  assert.ok(/\\\\s-p\\\\S\+|\\s-p\\S\+/.test(fn) || fn.includes("-p"), '没有抹 -p 密码');
  assert.ok(fn.toLowerCase().includes('password'), '没有抹 password=');
  assert.ok(fn.toLowerCase().includes('token'), '没有抹 token=');
});
t('P0 runSeven 额外做一次密码脱敏', () => {
  const fn = main.match(/async function runSeven[\s\S]*?\n\}/)[0];
  assert.ok(fn.includes("split(String(password)).join('***')"), 'runSeven 没抹密码');
});

/* ---------- P1-1：clipHistory 缺失时不删光图片 ---------- */
/* clip:gc-images 通道已删除（全项目无调用方）。真正会执行的是启动时的
 * sweepClipImages()，下面这条针对它，两道保护都在。 */
t('P1 sweepClipImages 同样校验 clipHistory', () => {
  const fn = main.match(/async function sweepClipImages\(\)[\s\S]*?\n\}/)[0];
  assert.ok(fn.includes('Array.isArray(hist)'), '没有类型校验');
  assert.ok(fn.includes('storeLoadFailed'), '没有保留加载失败守卫');
});

/* ---------- P1-2：原子写回滚失败要上报 ---------- */
t('P1 writeFileAtomic 回滚失败会明确报错并给备份路径', () => {
  const fn = main.match(/async function writeFileAtomic[\s\S]*?\n\}/)[0];
  assert.ok(fn.includes('ROLLBACK_FAILED'), '没有回滚失败错误码');
  assert.ok(fn.includes('原文件已保全在'), '没有告诉用户备份在哪');
  assert.ok(!/if \(moved\) await fsp\.rename\(bak, dest\)\.catch\(\(\) => \{\}\);/.test(fn),
    '仍在静默吞掉回滚失败');
});

/* ---------- P1-3：分片排他创建 ---------- */
t('P1 fs:split-file 分片用排他创建防覆盖', () => {
  const fn = body(main, 'fs:split-file');
  assert.ok(fn.includes("flags: 'wx'"), '没有用排他创建');
  assert.ok(fn.includes('EEXIST'), '没有处理已存在');
});

/* ---------- P1-4：autostart:enable 保留 REG_ 前缀 ---------- */
t('P1 autostart:enable 使用带 REG_ 前缀的类型', () => {
  const fn = body(main, 'autostart:enable');
  assert.ok(fn.includes("'REG_'"), '没有补 REG_ 前缀');
  assert.ok(fn.includes('startsWith'), '没有判断前缀');
  // 必须不能退化成裸 'SZ'
  assert.ok(!/\/t',\s*item\.type \|\| 'SZ'/.test(fn), '传了不带前缀的类型');
});

/* ---------- P1-5：svc:action 关键服务黑名单 ---------- */
t('P1 svc:action 有关键服务黑名单', () => {
  assert.ok(main.includes('PROTECTED_SVCS'), '没有服务黑名单');
  const fn = main.match(/const PROTECTED_SVCS = new Set\(\[[\s\S]*?\]\);/)[0];
  for (const s of ['rpcss', 'eventlog', 'bits', 'windefend', 'cryptsvc', 'wuauserv']) {
    assert.ok(fn.includes("'" + s + "'"), '黑名单缺少 ' + s);
  }
});
t('P1 svc:action 停止关键服务时拒绝', () => {
  const fn = body(main, 'svc:action');
  assert.ok(fn.includes('PROTECTED_SVCS.has'), '没有查黑名单');
  assert.ok(fn.includes('拒绝停止系统关键服务'), '没有拒绝提示');
});

/* ---------- P2-1：hosts 备份名精度 ---------- */
t('P2 hosts 备份名精确到毫秒且带随机后缀', () => {
  const count = (main.match(/hosts-\$\{new Date\(\)\.toISOString\(\)/g) || []).length;
  assert.ok(count >= 2, '没找到备份名生成，实际 ' + count + ' 处');
  assert.ok(main.includes("slice(0, 23)"), '没有精确到毫秒');
  assert.ok(/hosts-\$\{new Date\(\)[\s\S]{0,120}crypto\.randomBytes\(2\)/.test(main), '没有随机后缀');
});

t('8a fs:rename 补了 checkOverwritable 闸门', () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf("handle('fs:rename'");
  assert.ok(i > 0, '找不到 fs:rename');
  const seg = code.slice(i, code.indexOf("handle('fs:delete'"));
  assert.ok(/checkOverwritable/.test(seg), 'fs:rename 没有覆盖闸门（可以把文件搬进 Startup 或覆盖任意目标）');
  /* 大小写改名分支必须保留 */
  assert.ok(/toLowerCase\(\) === rt\.toLowerCase\(\)/.test(seg), '纯大小写改名被误删了');
});

t('8b fs:rename 在 file-delete 门禁里，且工具表同步', () => {
  const code = stripComments(mainSrc);
  assert.ok(/'fs:rename': 'file-delete'/.test(code), 'fs:rename 不在 CAP_GATED_CHANNELS');
  assert.ok(/'batch-rename': \['file-delete'\]/.test(code), '批量重命名没有登记依赖 file-delete');
  assert.ok(/'batch-ext': \['file-delete'\]/.test(code), '批量改后缀没有登记依赖 file-delete');
});

t('8c 行为：往系统目录改名会被拒，普通目录不受影响', () => {
  const pg = require(path.join(ROOT, 'lib', 'path-guard'));
  const B = String.fromCharCode(92);
  assert.ok(pg.checkOverwritable('C:' + B + 'Windows' + B + 'x.exe'), '系统目录内的目标应被拒');
  assert.strictEqual(pg.checkOverwritable('D:' + B + 'a' + B + 'x.exe'), null, '普通目录不该被拦');
});

/* ==================== 9. LastBootUpTime ==================== */

done();
