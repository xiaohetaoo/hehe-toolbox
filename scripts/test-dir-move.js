'use strict';
/* 目录搬家的校验与状态机测试（纯逻辑，不碰真实磁盘）。
 * 搬家出错就是数据事故，所以这些规则必须逐条钉死。
 */
const assert = require('assert');
const D = require('../lib/dir-move');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

const OK = {
  src: 'C:\\Users\\u\\bigdir', dst: 'D:\\backup\\bigdir',
  srcExists: true, srcIsDir: true, srcIsLink: false, srcIsRoot: false,
  srcIsCritical: false, dstExists: false,
  needBytes: 1000, freeBytes: 10 * 1024 * 1024 * 1024, lockedPaths: [],
};

t('正常请求通过校验', () => {
  const r = D.validateMove(OK);
  assert.strictEqual(r.ok, true, '应通过，实际被拒：' + r.reason);
});

/* ---------- 拒绝项逐条验 ---------- */
t('源不存在 → 拒绝', () => {
  const r = D.validateMove(Object.assign({}, OK, { srcExists: false }));
  assert.strictEqual(r.code, 'SRC_MISSING');
});

t('源不是目录 → 拒绝', () => {
  const r = D.validateMove(Object.assign({}, OK, { srcIsDir: false }));
  assert.strictEqual(r.code, 'SRC_NOT_DIR');
});

t('源本身是链接 → 拒绝（不能再套一层）', () => {
  const r = D.validateMove(Object.assign({}, OK, { srcIsLink: true }));
  assert.strictEqual(r.code, 'SRC_IS_LINK');
});

t('源是盘符根 → 拒绝', () => {
  const r = D.validateMove(Object.assign({}, OK, { srcIsRoot: true }));
  assert.strictEqual(r.code, 'SRC_IS_ROOT');
});

t('源在系统目录内 → 拒绝', () => {
  const r = D.validateMove(Object.assign({}, OK, { srcIsCritical: true }));
  assert.strictEqual(r.code, 'SRC_CRITICAL');
});

/* ---------- 残留 .hehe-bak 必须拦住，且拦在复制之前 ----------
 * 第 6 步删备份失败后 .hehe-bak 会残留。若不拦，下次对同一目录搬家会先
 * 完整复制一份 → 到「源改名为 .bak」才 EPERM（因为 .bak 已存在）→ 再删副本。
 * 表现就是「这个目录再也搬不动了」，每次都白等一次完整拷贝。 */
t('残留 .hehe-bak → 拒绝，且带完整路径', () => {
  const r = D.validateMove(Object.assign({}, OK, {
    bakExists: true, bakPath: 'C:\\Users\\u\\bigdir.hehe-bak',
  }));
  assert.strictEqual(r.ok, false, '有残留备份时必须拒绝');
  assert.strictEqual(r.code, 'BAK_LEFTOVER', '应给专门的 code，实际 ' + r.code);
  assert.ok(/bigdir\.hehe-bak/.test(r.reason), '提示里要有完整路径：' + r.reason);
  assert.ok(/残留/.test(r.reason), '要说清是上次残留：' + r.reason);
});

t('残留备份的提示不引导自动删除（那是用户数据）', () => {
  const r = D.validateMove(Object.assign({}, OK, {
    bakExists: true, bakPath: 'C:\\Users\\u\\bigdir.hehe-bak',
  }));
  assert.ok(/不会自动删/.test(r.advice), '应明确说不会自动删：' + r.advice);
  assert.ok(/手动删除/.test(r.advice), '应让用户自己确认后删：' + r.advice);
});

t('没有残留备份时不影响正常校验', () => {
  const r = D.validateMove(Object.assign({}, OK, { bakExists: false }));
  assert.strictEqual(r.ok, true, '不该因为这条检查误拒：' + r.reason);
});

t('残留备份检查排在复制相关项之前（早失败、零代价）', () => {
  /* 目标已存在也会被拒，但如果 .bak 残留，应该先报 .bak ——
   * 因为那是「这台机器上这个目录再也搬不动」的真实原因，
   * 而 DST_EXISTS 换个目标就好了，用户会以为是目标选错。
   * 这里用「两者同时成立」来验证优先级。 */
  const r = D.validateMove(Object.assign({}, OK, {
    bakExists: true, bakPath: 'C:\\Users\\u\\bigdir.hehe-bak', dstExists: true,
  }));
  assert.strictEqual(r.code, 'BAK_LEFTOVER', '应先报残留备份，实际 ' + r.code);
});

t('目标与源相同 → 拒绝', () => {
  const r = D.validateMove(Object.assign({}, OK, { dst: 'C:\\Users\\u\\bigdir' }));
  assert.strictEqual(r.code, 'DST_SAME');
});

t('目标在源内部 → 拒绝（会无限递归）', () => {
  const r = D.validateMove(Object.assign({}, OK, { src: 'D:\\a', dst: 'D:\\a\\b' }));
  // 注意同卷也会被拒；这里把 allowSameVolume 打开以便单独验证「内部」这条
  const r2 = D.validateMove(Object.assign({}, OK, { src: 'D:\\a', dst: 'D:\\a\\b', allowSameVolume: true }));
  assert.strictEqual(r2.code, 'DST_INSIDE_SRC', '应报「目标在源内部」，实际 ' + r2.code);
});

t('源在目标内部 → 拒绝', () => {
  const r = D.validateMove(Object.assign({}, OK, { src: 'D:\\a\\b', dst: 'D:\\a', allowSameVolume: true }));
  assert.strictEqual(r.code, 'SRC_INSIDE_DST', '应报「源在目标内部」，实际 ' + r.code);
});

t('同卷 → 拒绝（同卷不需要复制）', () => {
  const r = D.validateMove(Object.assign({}, OK, { src: 'D:\\a', dst: 'D:\\b' }));
  assert.strictEqual(r.code, 'SAME_VOLUME');
  // 显式允许后应通过
  const r2 = D.validateMove(Object.assign({}, OK, { src: 'D:\\a', dst: 'D:\\b', allowSameVolume: true }));
  assert.strictEqual(r2.ok, true, 'allowSameVolume 时应通过');
});

t('目标已存在同名 → 拒绝', () => {
  const r = D.validateMove(Object.assign({}, OK, { dstExists: true }));
  assert.strictEqual(r.code, 'DST_EXISTS');
});

t('空间不足 → 拒绝，且说明需要多少', () => {
  const r = D.validateMove(Object.assign({}, OK, {
    needBytes: 5 * 1024 * 1024 * 1024,
    freeBytes: 4 * 1024 * 1024 * 1024,
  }));
  assert.strictEqual(r.code, 'NO_SPACE');
  assert.ok(/需要/.test(r.reason), '应说明需要多少空间：' + r.reason);
});

t('空间刚好够但没留余量 → 拒绝（预留 5% 或 64MB）', () => {
  const need = 1000 * 1024 * 1024;  // 1000MB
  const r = D.validateMove(Object.assign({}, OK, { needBytes: need, freeBytes: need + 1024 * 1024 }));
  assert.strictEqual(r.code, 'NO_SPACE', '应因余量不足被拒，实际 ' + r.code);
});

t('有文件被占用 → 拒绝，并给可操作建议', () => {
  const r = D.validateMove(Object.assign({}, OK, { lockedPaths: ['C:\\Users\\u\\bigdir\\x.log'] }));
  assert.strictEqual(r.code, 'LOCKED');
  assert.ok(/文件占用解锁/.test(r.advice), '建议里应指向占用查询工具：' + r.advice);
});

/* ---------- 路径归一与包含判断 ---------- */
t('normWin 统一斜杠、去尾分隔符、转小写', () => {
  assert.strictEqual(D.normWin('C:/Users/A/'), 'c:\\users\\a');
  assert.strictEqual(D.normWin('C:\\Users\\A\\\\B'), 'c:\\users\\a\\b');
});

t('isInside 不会被前缀相似的目录骗过', () => {
  // C:\AB 不应被当成 C:\A 的子目录
  assert.strictEqual(D.isInside('C:\\AB', 'C:\\A'), false, 'C:\\AB 不是 C:\\A 的子目录');
  assert.strictEqual(D.isInside('C:\\A\\B', 'C:\\A'), true, 'C:\\A\\B 是 C:\\A 的子目录');
});

t('volOf 取盘符根', () => {
  assert.strictEqual(D.volOf('D:\\x\\y'), 'd:\\');
});

/* ---------- 搬家计划 ---------- */
t('计划包含七个步骤且顺序正确', () => {
  const p = D.movePlan('C:\\a', 'D:\\b');
  assert.strictEqual(p.length, 7, '应为 7 步，实际 ' + p.length);
  const ids = p.map((x) => x.id);
  assert.deepStrictEqual(ids, ['check', 'copy', 'verify', 'rename', 'link', 'linkcheck', 'dropbak'],
    '步骤顺序不对：' + ids.join(' → '));
  for (const step of p) {
    assert.ok(step.label && step.detail, '每步都要有可展示的说明');
  }
});

/* ---------- 回退计划：这是最关键的一组 ---------- */
t('check 阶段失败：不需要回退', () => {
  const r = D.rollbackPlan('check', {});
  assert.deepStrictEqual(r.actions, []);
});

t('copy/verify 阶段失败：只删目标副本，源不动', () => {
  const a = D.rollbackPlan('copy', {});
  const b = D.rollbackPlan('verify', {});
  assert.deepStrictEqual(a.actions, ['remove-dst']);
  assert.deepStrictEqual(b.actions, ['remove-dst']);
  assert.ok(/源目录完好/.test(a.note), '应说明源完好');
});

t('rename 后失败：必须把 .bak 改回原名（原路径立即恢复）', () => {
  const r = D.rollbackPlan('rename', {});
  assert.deepStrictEqual(r.actions, ['rename-bak-back']);
  assert.ok(/恢复/.test(r.note), '应说明原路径恢复');
});

t('link 阶段失败：先拆链接再改回原名（最危险中间态）', () => {
  const r = D.rollbackPlan('link', {});
  assert.deepStrictEqual(r.actions, ['remove-link', 'rename-bak-back'],
    '必须先删链接再改名，顺序不对：' + r.actions.join(', '));
  assert.ok(/没有丢失/.test(r.note), '应安抚用户数据没丢');
});

t('linkcheck 失败：同样拆链接 + 改回原名', () => {
  const r = D.rollbackPlan('linkcheck', {});
  assert.deepStrictEqual(r.actions, ['remove-link', 'rename-bak-back']);
});

t('dropbak 之后失败：无操作可做，但要告知数据在哪', () => {
  const r = D.rollbackPlan('dropbak', { dstPath: 'D:\\backup\\bigdir' });
  assert.deepStrictEqual(r.actions, []);
  assert.ok(/D:\\backup\\bigdir/.test(r.note), '应指出数据位置：' + r.note);
});

t('每个阶段都有明确的回退说明（不允许出现 no-op 的未知分支）', () => {
  for (const s of ['check', 'copy', 'verify', 'rename', 'link', 'linkcheck', 'dropbak']) {
    const r = D.rollbackPlan(s, { dstPath: 'D:\\x' });
    assert.ok(r.note && r.note.length > 0, s + ' 缺少说明');
  }
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
