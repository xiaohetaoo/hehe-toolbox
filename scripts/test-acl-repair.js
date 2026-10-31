'use strict';
/* 权限修复的纯逻辑测试。
 *
 * 重点：判定要准（区分占用/权限/系统目录）、分寸要守住（只处理用户选中的目标）、
 * 命令构造顺序要对（takeown 必须先于 icacls）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../lib/acl-repair');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

/* 以下几条用的都是**真实 icacls 输出格式**（本机实测抓的）：
 * 第一行是「路径 + 主体」，后续行只有主体；权限位前还有 (I) 继承标记。
 * 早期测试用了编造的格式（域账号后直接跟括号），把解析器的 bug 藏住了 ——
 * 那个 bug 把继承标记 (I) 当成了权限位、把路径当成了主体名。 */
const REAL_ACL_OUTPUT = [
  'D:/x/a.txt BUILTIN\\Administrators:(I)(F)',
  '            NT AUTHORITY\\SYSTEM:(I)(F)',
  '            NT AUTHORITY\\Authenticated Users:(I)(M)',
  '            BUILTIN\\Users:(I)(RX)',
].join('\n');

t('解析真实 icacls 输出：认出全部 ACE 与完全控制', () => {
  const r = A.parseIcacls(REAL_ACL_OUTPUT);
  assert.strictEqual(r.entries.length, 4, '真实输出有 4 条 ACE，实际 ' + r.entries.length);
  /* hasFull 的语义已收窄为「当前用户自己有完全控制」；这条用例没传 userName，
   * 无从判断归属，所以断言 anyFull（存在某个主体有 F）。
   * hasFull 本身的行为见「hasFull 只认当前用户」那组用例。 */
  assert.strictEqual(r.anyFull, true, '应认出存在 (F) 完全控制（anyFull）');
  const admin = r.entries[0];
  assert.strictEqual(admin.perms, 'F', '第一条权限位应为 F 而不是继承标记 I，实际 ' + admin.perms);
  assert.ok(/Administrators/.test(admin.principal), '主体名应保留完整域名，实际 ' + admin.principal);
  assert.ok(!/a\.txt/.test(admin.principal), '路径不该被当成主体名：' + admin.principal);
});

t('解析真实格式：认出 M / RX 等中间权限，不把 (I) 当权限', () => {
  const r = A.parseIcacls(REAL_ACL_OUTPUT);
  const perms = r.entries.map((e) => e.perms);
  assert.ok(perms.indexOf('M') !== -1, '应认出 (M) 修改权限：' + perms.join(','));
  assert.ok(perms.indexOf('RX') !== -1, '应认出 (RX) 读取执行：' + perms.join(','));
  assert.strictEqual(perms.indexOf('I'), -1, '继承标记 (I) 不该被当成权限位：' + perms.join(','));
});

t('解析 DENY 项：DENY 不是权限位', () => {
  const out = [
    'D:/x/a.txt BUILTIN\\Users:(DENY)(F)',
    '            BUILTIN\\Users:(I)(RX)',
  ].join('\n');
  const r = A.parseIcacls(out);
  assert.strictEqual(r.hasDeny, true, '应认出 DENY，实际 ' + JSON.stringify(r.entries));
  const denyEntry = r.entries.find((e) => e.deny);
  assert.ok(denyEntry, '应找到拒绝项');
  assert.strictEqual(denyEntry.perms, 'F', 'DENY 行的权限位应为 F，实际 ' + denyEntry.perms);
});

t('给了用户名时能判断「拒绝项是针对我的」', () => {
  const out = 'D:/x/a.txt DOMAIN\\alice:(DENY)(F)';
  const r = A.parseIcacls(out, 'DOMAIN\\alice');
  assert.strictEqual(r.deniedForMe, true, '应识别拒绝项命中自己，实际 ' + JSON.stringify(r.entries));
});

t('空输出不崩', () => {
  const r = A.parseIcacls('');
  assert.deepStrictEqual(r.entries, []);
  assert.strictEqual(r.hasFull, false);
});

/* ---------- hasFull 只认当前用户（P3 修复的核心） ---------- */
t('hasFull 只认当前用户那条 ACE，不是「任意主体有 F」', () => {
  /* 文件属主是 Administrators、ACL 里只有 Admin/SYSTEM 有 (F)，
   * 当前用户 bob 根本没有 ACE —— 这种情况最常见的表现是「用户删不掉」。 */
  const out = [
    'C:\\a.txt BUILTIN\\Administrators:(I)(F)',
    '           NT AUTHORITY\\SYSTEM:(I)(F)',
  ].join('\n');
  const r = A.parseIcacls(out, 'XIAO\\bob');
  assert.strictEqual(r.anyFull, true, 'anyFull 应仍为 true（Admin 确实有 F）');
  assert.strictEqual(r.hasFull, false,
    'hasFull 必须为 false —— 别人有 F 不等于当前用户有 F');
});

t('当前用户自己有 (F) 时 hasFull 为 true', () => {
  const out = 'C:\\a.txt XIAO\\bob:(I)(F)';
  const r = A.parseIcacls(out, 'XIAO\\bob');
  assert.strictEqual(r.hasFull, true);
});

t('属主是 Administrators 但当前用户非管理员 → 诊断不判「没问题」', () => {
  const out = [
    'C:\\a.txt BUILTIN\\Administrators:(I)(F)',
    '           NT AUTHORITY\\SYSTEM:(I)(F)',
  ].join('\n');
  const acl = A.parseIcacls(out, 'XIAO\\bob');
  const d = A.diagnose({
    exists: true, isDir: false, ownerIsMe: false,
    ownerName: 'BUILTIN\\Administrators', acl, isAdmin: false,
  });
  assert.strictEqual(d.ok, false, '不能判为无需修复（那会让用户以为权限没问题）');
  assert.ok(d.codes.indexOf('NO_WRITE') !== -1 || d.codes.indexOf('OWNER') !== -1,
    '应报缺权限或所有者问题，实际 ' + d.codes);
});

/* ---------- 诊断 ---------- */
t('路径不存在 → 直接报 NOT_EXIST', () => {
  const r = A.diagnose({ exists: false });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.codes, ['NOT_EXIST']);
});

t('一切正常 → ok', () => {
  const r = A.diagnose({ exists: true, isDir: false, ownerIsMe: true, acl: { hasFull: true, entries: [{}] }, isAdmin: false });
  assert.strictEqual(r.ok, true, '应判为无需修复');
  assert.deepStrictEqual(r.codes, []);
});

t('所有者不是你 → 报 OWNER 且提示需要管理员', () => {
  const r = A.diagnose({ exists: true, ownerIsMe: false, ownerName: 'Administrators', acl: {}, isAdmin: false });
  assert.ok(r.codes.indexOf('OWNER') !== -1, '应报 OWNER');
  assert.strictEqual(r.needAdmin, true, '非管理员时应提示需要提权');
  assert.ok(r.messages.join(' ').indexOf('管理员') !== -1, '消息里应提到管理员');
});

t('是管理员时，「所有者不是你」不再提示需要提权', () => {
  const r = A.diagnose({ exists: true, ownerIsMe: false, acl: {}, isAdmin: true });
  assert.strictEqual(r.needAdmin, false, '已是管理员时不需要再提权');
});

t('有文件被占用 → 优先提示「这是占用问题，不是权限问题」', () => {
  const r = A.diagnose({ exists: true, ownerIsMe: true, acl: { hasFull: true, entries: [{}] }, lockedPaths: ['a.log'] });
  assert.ok(r.codes.indexOf('LOCKED') !== -1, '应报 LOCKED');
  assert.ok(/占用/.test(r.messages.join(' ')), '消息里应说明是占用问题');
});

t('没有完全控制 → 报 NO_WRITE', () => {
  const r = A.diagnose({ exists: true, ownerIsMe: true, acl: { hasFull: false, entries: [{ principal: 'x', perms: 'R' }] } });
  assert.ok(r.codes.indexOf('NO_WRITE') !== -1, '应报缺写入权限');
});

t('目录的风险提示要说清「会波及子项」', () => {
  const r = A.diagnose({ exists: true, isDir: true, childCount: 42, ownerIsMe: false });
  assert.ok(/全部 42 个条目/.test(r.risk), '应写出影响的条目数，实际：' + r.risk);
});

t('文件的风险提示只说「只作用于它本身」', () => {
  const r = A.diagnose({ exists: true, isDir: false, ownerIsMe: false });
  assert.ok(/只作用于它本身/.test(r.risk), '实际：' + r.risk);
});

t('目录但子项数量未知时也给出诚实说明', () => {
  const r = A.diagnose({ exists: true, isDir: true, childCount: -1 });
  assert.ok(/数量未知/.test(r.risk), '实际：' + r.risk);
});

/* ---------- 命令构造 ---------- */
t('takeown 必须排在 icacls 之前（顺序是硬的）', () => {
  const r = A.buildRepairCommands({ path: 'C:\\tmp\\d', isDir: true, user: 'me', recursive: true });
  assert.strictEqual(r.steps.length, 2, '应为两步');
  assert.strictEqual(r.steps[0].tool, 'takeown', '第一步必须是 takeown');
  assert.strictEqual(r.steps[1].tool, 'icacls', '第二步必须是 icacls');
});

t('递归模式带 /R 与 /D Y（避免非交互卡住）', () => {
  const r = A.buildRepairCommands({ path: 'C:\\tmp\\d', isDir: true, user: 'me', recursive: true });
  const a = r.steps[0].args.join(' ');
  assert.ok(/\/R/.test(a), 'takeown 应带 /R');
  assert.ok(/\/D Y|\/D Y/.test(a), 'takeown 应带 /D Y，实际 ' + a);
  assert.ok(r.steps[1].args.join(' ').indexOf('/T') !== -1, 'icacls 应带 /T');
});

t('非递归模式不带 /R 与 /T（只动选中的那一个）', () => {
  const r = A.buildRepairCommands({ path: 'C:\\tmp\\f.txt', isDir: false, user: 'me', recursive: false });
  assert.ok(!/\/R/.test(r.steps[0].args.join(' ')), '不该带 /R');
  assert.ok(!/\/T/.test(r.steps[1].args.join(' ')), '不该带 /T');
});

t('icacls 授予带继承标记 (OI)(CI)', () => {
  const r = A.buildRepairCommands({ path: 'C:\\tmp\\d', isDir: true, user: 'me', recursive: false });
  const g = r.steps[1].args.join(' ');
  assert.ok(/\(OI\)\(CI\)F/.test(g), '应含 (OI)(CI)F 继承标记，实际 ' + g);
});

t('没有路径 / 用户时明确报错', () => {
  assert.throws(() => A.buildRepairCommands({}), /没有指定目标路径/);
  assert.throws(() => A.buildRepairCommands({ path: 'x' }), /没有指定要授权的用户/);
});

/* ---------- 拒绝时的下一步建议 ---------- */
t('系统关键目录：不给「提权修复」的引导', () => {
  const r = A.adviceForRejection({ code: 'CRITICAL' });
  assert.strictEqual(r.retryable, false, '系统目录不该引导提权修复');
  assert.ok(/不建议/.test(r.advice), '应明确说不建议改：' + r.advice);
});

t('普通拒绝：给出「权限修复」的下一步', () => {
  const r = A.adviceForRejection({ code: 'EPERM' });
  assert.strictEqual(r.retryable, true);
  assert.ok(/权限修复/.test(r.advice), '应指向权限修复工具');
  assert.ok(/子项/.test(r.advice), '应提醒会影响子项');
});

/* ---------- P1-1：readAclFacts 必须把当前用户名传给 parseIcacls ----------
 * lib 的 hasFull 只在 `userName && entry.mine` 时置真。早期 readAclFacts 调
 * parseIcacls(out.aclRaw) 没传第二个参数，而且取用户名的 ps 还在解析**之后**——
 * 于是 hasFull 恒 false，两条判据连带着全错：
 *   acl:diagnose 对权限正常的文件也报「缺少写入权限」；
 *   acl:repair 修完复核 gained 恒 false，界面永远说「复核没读到完全控制」。
 * 这是「结论必错」，所以要钉死顺序与参数。 */
t('readAclFacts 把当前用户名传给 parseIcacls（hasFull 才能正确）', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = mainSrc.match(/async function readAclFacts\(target\) \{[\s\S]*?\n\}/);
  assert.ok(fn, '找不到 readAclFacts');
  const code = fn[0].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/parseIcacls\([^)]*,\s*out\.me/.test(code),
    'parseIcacls 的第二个参数必须传 out.me —— 否则 hasFull 恒 false');
  /* 顺序：取 me 的那次 ps 必须在解析之前 */
  const meIdx = code.indexOf('WindowsIdentity]::GetCurrent().Name');
  const parseIdx = code.indexOf('parseIcacls');
  assert.ok(meIdx > 0 && parseIdx > 0, '两处调用都应存在');
  assert.ok(meIdx < parseIdx,
    '取当前用户名的调用必须在 parseIcacls 之前，实际顺序反了');
});

/* ---------- P2-2：修复结果不能被自动重查抹掉 ----------
 * 修复后自动重查会重建整块 resultBox，早期结果刚渲染就被清掉，
 * 用户永远看不到命令输出与「已取得完全控制」。 */
t('权限修复把结果存进 state，重查后能复现', () => {
  const tool = fs.readFileSync(path.join(__dirname, '..', 'js', 'tools', 'acl-repair.js'), 'utf8');
  assert.ok(/repair:\s*null/.test(tool), 'state 里应有 repair 字段');
  assert.ok(/state\.repair\s*=\s*r/.test(tool), '拿到结果后应存进 state.repair');
  assert.ok(/if \(state\.repair\) renderRepairResult/.test(tool),
    'render() 末尾应按 state.repair 重画修复结果');
});

/* ---------- ownerIsMe 三态：null（读不到）不能当成「不是你」 ----------
 * CI 的 runneradmin 上实测到了：Get-Acl 返回空（owner=null），
 * 而 hasFull=true、权限完全正常。早期 `if (!x.ownerIsMe)` 把 null 也当成
 * 「所有者不是你」，于是诊断报「当前所有者不是你，因此你无法修改它的权限」——
 * 把「读不到」渲染成「有问题」，正是本模块要避免的那类错误。 */
t('ownerIsMe 为 null（读不到）时，不报「所有者不是你」', () => {
  const r = A.diagnose({
    exists: true, isDir: false, childCount: -1,
    ownerIsMe: null, ownerName: null,
    acl: { entries: [{ principal: 'BUILTIN\\Users', perms: 'F', deny: false, mine: true }], hasFull: true, hasDenied: false },
    isAdmin: false, lockedPaths: [],
  });
  assert.strictEqual(r.ok, true, '读不到所有者不该判成「有问题」，实际 codes=' + JSON.stringify(r.codes));
  assert.ok(!/所有者不是你/.test(r.messages.join(' ')),
    '不该编出「所有者不是你」：' + r.messages.join(' | '));
  assert.ok(/无法读取所有者信息/.test(r.messages.join(' ')),
    '应如实说明读不到所有者：' + r.messages.join(' | '));
});

t('ownerIsMe 为 false 时仍然要报 OWNER（真问题不能漏）', () => {
  const r = A.diagnose({
    exists: true, isDir: false, childCount: -1,
    ownerIsMe: false, ownerName: 'Administrators',
    acl: { entries: [{ principal: 'BUILTIN\\Users', perms: 'F', deny: false, mine: true }], hasFull: true, hasDenied: false },
    isAdmin: false, lockedPaths: [],
  });
  assert.strictEqual(r.ok, false, '明确「所有者不是你」应算问题');
  assert.ok(r.codes.indexOf('OWNER') !== -1, '应报 OWNER，实际 ' + JSON.stringify(r.codes));
  assert.ok(/所有者不是你/.test(r.messages.join(' ')), '应说明所有者不是你');
});

t('ownerIsMe 为 true 时一切正常', () => {
  const r = A.diagnose({
    exists: true, isDir: false, childCount: -1,
    ownerIsMe: true, ownerName: 'me',
    acl: { entries: [{ principal: 'me', perms: 'F', deny: false, mine: true }], hasFull: true, hasDenied: false },
    isAdmin: false, lockedPaths: [],
  });
  assert.strictEqual(r.ok, true, '正常文件应判 ok，实际 codes=' + JSON.stringify(r.codes));
  assert.deepStrictEqual(r.codes, [], '不该有任何 codes');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
