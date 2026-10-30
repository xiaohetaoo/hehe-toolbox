'use strict';
/* 第四轮审查（main.js 破坏性操作专项）的回归测试。
 * 重点覆盖：门禁绕过、系统进程保护、密码脱敏、字段缺失守卫。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
}
function body(src, channel) {
  const start = src.indexOf("handle('" + channel + "'");
  assert.ok(start > 0, '找不到 handler: ' + channel);
  return src.slice(start, src.indexOf('\n});', start));
}

const main = read('main.js');

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

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
