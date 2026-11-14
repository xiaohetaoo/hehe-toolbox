'use strict';
const { t, done, readSrc, readMain } = require('./lib/harness');
const { handlerIndex } = require('./lib/seg-from-handler');
const path = require('path');
const ROOT = path.join(__dirname, '..');
/* 定位 dir:move-precheck 的注册位置：任务 6 之后通道名换成了常量，
 * 所以两种形态都要认。 */
function precheckAt(code) {
  const a = handlerIndex(code, 'dir:move-precheck');
  if (a >= 0) return a;
  return code.indexOf('handle(dirMoveCh.DIR_MOVE.PRECHECK,');
}
/* 定位 dir:move 的注册位置（与 precheckAt 同一套双形态识别）。 */
function moveAt(code) {
  const a = handlerIndex(code, 'dir:move');
  if (a >= 0) return a;
  return code.indexOf('handle(dirMoveCh.DIR_MOVE.MOVE,');
}

const BS = String.fromCharCode(92);
const mainSrc = readMain({ raw: true });
/* 目录搬家的校验与状态机测试（纯逻辑，不碰真实磁盘）。
 * 搬家出错就是数据事故，所以这些规则必须逐条钉死。
 */
const assert = require('assert');
const D = require('../lib/dir-move');
/* 读渲染层源码（新迁移的用例要看 js/tools/dir-move.js 的状态管理）。
 * 用 readSrc 而不是自建 read 助手：它会剥注释，而源码断言必须在没有注释
 * 干扰的文本上做（否则注释里引用的代码片段会被当成命中）。 */
function read(rel) { return readSrc(rel, { raw: true }); }
const stripComments = require('../lib/src-scan').stripComments;

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
  /* 【这一条原来只算不用】r 算出来之后没有任何断言碰过它，
   * 于是「同卷时目标在源内部也要拒绝」这件事其实一直没被验证 ——
   * 真正被断言的只有下面打开 allowSameVolume 之后的 r2。
   * 补上对 r 的断言：同卷 + 内部，拒绝码应当是 DST_INSIDE_SRC
   * （而不是先被同卷规则拦成 DST_SAME —— 那会让用户看到"同盘"这种
   * 与真实原因无关的提示）。 */
  assert.strictEqual(r.code, 'DST_INSIDE_SRC',
    '同卷且目标在源内部时应优先报「目标在源内部」，实际 ' + r.code);
  // 这里把 allowSameVolume 打开以便单独验证「内部」这条
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

/* ================= 搬家成功后作废预检（原 test-round12-fixes.js ④）====================
 * 锁的是：搬家成功后界面没把预检结论作废。用户看到的是「可以搬」，
 * 再点一次却报 SRC_IS_LINK（源目录此刻已经是链接了）—— 说法与行为对不上。
 * 修法要在成功分支同时做两件事：作废预检 + 标记已搬完。
 */

t('搬完之后作废预检、按钮保持禁用，改路径才恢复', () => {
  const src = read('js/tools/dir-move.js');
  const code = stripComments(src);
  /* 注意 state.precheck = null 出现两次：
   *   · invalidate() 里（那是「路径改了」，后面是 moved = false）
   *   · 搬家成功分支（后面才是 moved = true）
   * 所以要找「后面紧跟 moved = true」的那一处，即成功分支。 */
  const re = /state\.precheck = null;(?:[^;]*?;){0,6}?\s*state\.moved = true/s;
  assert.ok(re.test(code),
    '成功分支必须同时标记「已搬完」（invalidate 里那句是 moved=false，不是它）');
  assert.ok(/goBtn\.disabled = done \? true : false/.test(code),
    '成功后不能无条件恢复按钮（失败才恢复）');
  assert.ok(/if \(!state\.precheck && !state\.moved\) return/.test(code),
    'invalidate 必须同时处理「已搬完」状态，否则改路径后那张卡永远不消失');
  assert.ok(/已搬完/.test(src), '应换成「已搬完」的说明卡');
});

t('目标落在系统目录时必须被拒（即使调用方没传 dstProtected）', () => {
  const D = require('../lib/dir-move.js');
  const OK = {
    src: 'C:' + BS + 'Users' + BS + 'u' + BS + 'bigdir', dst: 'D:' + BS + 'backup' + BS + 'bigdir',
    srcExists: true, srcIsDir: true, srcIsLink: false, srcIsRoot: false, srcIsCritical: false,
    dstExists: false, needBytes: 1000, freeBytes: 10737418240, lockedPaths: [],
  };
  const win = process.env.SystemRoot || 'C:' + BS + 'Windows';
  for (const dst of [win, win + BS + 'moved', (process.env.ProgramFiles || 'C:' + BS + 'Program Files') + BS + 'x']) {
    const r = D.validateMove(Object.assign({}, OK, { dst }));
    assert.strictEqual(r.code, 'DST_PROTECTED', dst + ' 应被拒，实际 ' + r.code + ' / ' + r.reason);
  }
  /* 正常目标不受影响 */
  assert.strictEqual(D.validateMove(OK).ok, true, '正常目标不该被误拒');
  /* 显式结论也要生效（main.js 的调用方式） */
  assert.strictEqual(D.validateMove(Object.assign({}, OK, { dstProtected: true })).code, 'DST_PROTECTED');
});

t('main.js 的两处调用都传了 dstProtected（预检 + 执行）', () => {
  const code = stripComments(mainSrc);
  const hits = (code.match(/dstProtected:/g) || []).length;
  assert.ok(hits >= 3, '预检与执行都应传 dstProtected（含返回值），实际 ' + hits + ' 处');
  assert.ok(/isProtectedForModify\(dstAbs\)/.test(code), '目标侧应复用 isProtectedForModify');
});

/* ================= ③ principalEq ================= */

t('预检只走一遍全树（体积 + 链接同一次遍历）', () => {
  const code = stripComments(mainSrc);
  const seg = code.slice(precheckAt(code), moveAt(code));
  assert.ok(/collectLinks\(srcAbs, \{ wantSize: true \}\)/.test(seg), '预检没有用一次遍历同时取体积与链接');
  assert.ok(!/links\.dirSize\(srcAbs\)/.test(seg), '预检里仍在走第二遍（dirSize）');
  assert.ok(/linkCount: treeLinks\.length/.test(seg), 'linkCount 应直接复用遍历结果');
  /* 结果要真的被界面用上（之前算了却没人显示） */
  const ui = stripComments(read('js/tools/dir-move.js'));
  assert.ok(/r\.linkCount/.test(ui), '预检结果里的 linkCount 没有显示给用户');
});

t('盘符根保护：任何存在的盘上的 Windows/Program Files 都拦，不存在的盘不误伤', () => {
  const p = require('../lib/path-guard.js');
  const win = process.env.SystemRoot || 'C:' + BS + 'Windows';
  assert.strictEqual(p.isProtectedForModify(win).protected, true, 'Windows 目录应受保护');
  assert.strictEqual(p.isProtectedForModify(win + BS + 'System32').protected, true);
  assert.strictEqual(p.isProtectedForModify('Q:' + BS + 'Windows').protected, false,
    '不存在的盘不该凭空产生保护项（会误伤同名的普通目录）');
});

t('问题7：checkbox 从 state.recursive 读初值，不硬设 false', () => {
  const tool = read('js/tools/acl-repair.js');
  const code = stripComments(tool);
  assert.ok(/chk\.checked = !!state\.recursive;/.test(code),
    'render() 里应读回 state.recursive —— 硬设 false 会让界面与状态脱节');
  assert.ok(!/chk\.checked = false;/.test(code), '不该硬设 false');
});

t('问题7：换目标路径才复位递归（onChange 与「用这个路径」都要复位）', () => {
  const tool = read('js/tools/acl-repair.js');
  const code = stripComments(tool);
  const onChangeSeg = code.slice(code.indexOf('onChange: (items)'), code.indexOf('onChange: (items)') + 400);
  assert.ok(/state\.recursive = false/.test(onChangeSeg),
    'onChange 里应复位 recursive（换路径沿用上次勾选是危险的默认值）');
  const usePathSeg = code.slice(code.indexOf('usePathBtn'), code.indexOf('usePathBtn') + 500);
  assert.ok(/state\.recursive = false/.test(usePathSeg), '「用这个路径」也应复位');
});

/* ================= 问题 8：lockedPaths 语义与文案 ================= */

t('33 dir-move：剩余空间未知（null）不该报「空间不足」', () => {
  const DMx = require(path.join(ROOT, 'lib', 'dir-move'));
  const r = DMx.validateMove({
    src: 'C:\\a', dst: 'D:\\a', srcExists: true, srcIsDir: true, srcIsLink: false, srcIsRoot: false,
    srcIsCritical: false, dstExists: false, dstProtected: false,
    needBytes: 100 * 1024 * 1024, freeBytes: null, lockedPaths: [],
  });
  assert.strictEqual(r.ok, true,
    'freeBytes=null 表示「读不到剩余空间」，Number(null)===0 会让它变成「剩余 0 GB」而永久拒绝搬家：' + r.reason);
});

/* ==================== 34. archive-guard：文件/目录冲突要双向查 ==================== */

t('6a UNC 目标必须在预检阶段就被拒（不是等到建链接才失败）', () => {
  const dm = require(path.join(ROOT, 'lib', 'dir-move'));
  const B = String.fromCharCode(92);
  const base = { srcExists: true, srcIsDir: true, dstExists: false, needBytes: 1000, freeBytes: 1e12, allowSameVolume: false };
  const uncCases = [
    ['反斜杠', B + B + 'nas' + B + 'share' + B + 'x'],
    ['正斜杠', '//nas/share/x'],
    ['长路径', B + B + '?' + B + 'UNC' + B + 'nas' + B + 's' + B + 'x'],
  ];
  for (const [label, dst] of uncCases) {
    const v = dm.validateMove(Object.assign({}, base, { src: 'C:' + B + 'a', dst }));
    assert.strictEqual(v.ok, false, label + ' UNC 目标应当被拒');
    assert.strictEqual(v.code, 'DST_UNC', label + ' 拒绝码应为 DST_UNC，实际 ' + v.code);
    assert.ok(/网络|UNC|联接|本地/.test(v.reason), label + ' 理由没讲清为什么不行：' + v.reason);
  }
  // 不误伤本地路径
  const local = [B + B + '?' + B + 'D:' + B + 'moved', 'D:' + B + 'moved', 'D:' + B + 'a' + B + 'b'];
  for (const dst of local) {
    const v = dm.validateMove(Object.assign({}, base, { src: 'C:' + B + 'a', dst }));
    assert.strictEqual(v.ok, true, '本地路径 ' + dst + ' 被误判成 UNC 拒绝了');
  }
});

t('6b isUncPath 用原始字符串判断（不能被 normWin 折叠掉开头两个反斜杠）', () => {
  const dm = require(path.join(ROOT, 'lib', 'dir-move'));
  const B = String.fromCharCode(92);
  assert.strictEqual(dm.isUncPath(B + B + 'server' + B + 'share'), true);
  assert.strictEqual(dm.isUncPath('  ' + B + B + 'server' + B + 'share  '), true, '首尾空格应当被 trim');
  assert.strictEqual(dm.isUncPath('D:' + B + 'data'), false);
  /* 关键对照：normWin 会把 \\ 折叠成 \，所以用它判 UNC 永远为假 */
  assert.strictEqual(dm.normWin(B + B + 'server' + B + 'share').startsWith(B + B), false,
    'normWin 折叠了双反斜杠 —— 这正说明 UNC 判据不能用归一后的值');
});

t('6c freeBytes 读不到时必须显式标记「未校验」，不能静默跳过空间检查', () => {
  const dm = require(path.join(ROOT, 'lib', 'dir-move'));
  const B = String.fromCharCode(92);
  const base = { src: 'C:' + B + 'a', dst: 'D:' + B + 'b', srcExists: true, srcIsDir: true, dstExists: false, needBytes: 1e9, allowSameVolume: false };
  const unknown = dm.validateMove(Object.assign({}, base, { freeBytes: null }));
  assert.strictEqual(unknown.ok, true, '空间未知不该直接拒绝（未知 ≠ 不够）');
  assert.strictEqual(unknown.freeBytesUnknown, true, 'freeBytes=null 时没有标记「未知」');
  const known = dm.validateMove(Object.assign({}, base, { freeBytes: 1e12 }));
  assert.strictEqual(known.freeBytesUnknown, false, 'freeBytes 正常时不该标成未知');
  // 真的不够时仍然要拒
  const tight = dm.validateMove(Object.assign({}, base, { freeBytes: 1e6 }));
  assert.strictEqual(tight.code, 'NO_SPACE', '空间确实不够时应当拒绝');
});

t('6d 界面把「未校验」如实说出来', () => {
  const code = stripComments(read('js/tools/dir-move.js'));
  assert.ok(/freeBytesUnknown/.test(code), '界面没有使用 freeBytesUnknown 标记');
  assert.ok(/未校验|空间是否足够未校验/.test(code),
    '界面没明说「空间是否足够未校验」，只写「未知」用户会以为校验过了');
});

/* ==================== 7. 复制期间源条目消失 ==================== */
/* 用可注入的 fsp 桩跑真 verifyCopy。
 *
 * 【为什么必须用桩】"源文件在 readdir 之后、stat 之前被删掉"是一个竞态，
 * 在真实磁盘上无法稳定复现 —— 我先试过"复制完就删源文件"，
 * 结果 verifyCopy 的 readdir 压根看不到它，计数恒为 0（测试假绿）。
 * 只有让 readdir 正常返回目录项、而 stat(源) 单独抛 ENOENT，才能精确命中目标分支。
 * 注意桩要区分源侧/目标侧路径：只让**源**路径消失，目标侧照常返回。 */

t('34 dir-move：D: 这类盘符相对写法必须在 resolve 之前判（第四轮审查）', () => {
  const code = stripComments(read('ipc/dir-acl-links.js'));
  /* 背景：`D:` 是盘符相对写法，path.resolve('D:') 会变成进程 cwd
   * （即应用自己的工作目录）。lib/links.js 里专门写了 isVolumeRootOnly('D:')，
   * 但两处调用点都传的已 resolve 路径 → 判据永远为 false。
   * 后果：用户在「源目录」手输 D:，会去搬应用自己的目录。 */
  const hits = [...code.matchAll(/srcIsRoot[^\n]*isVolumeRootOnly\([^)]*\)/g)].map((m) => m[0]);
  assert.ok(hits.length >= 2, '应有预检与执行两处 srcIsRoot 判定，实际 ' + hits.length);
  for (const h of hits) {
    /* 锁的是：只拿 resolve 后的路径判盘符根 —— 专用判据成为死代码。 */
    assert.ok(/String\(src \|\| ''\)/.test(h), 'srcIsRoot 必须先用原始字符串判一次：' + h);
  }
});

done();
