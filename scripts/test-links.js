'use strict';
const { t, done, readMain } = require('./lib/harness');

/* ================= ① 内部链接改写 ================= */

/* ============ 顶层数据声明（必须在第一条 t() 之前）
 * 【为什么】harness 的 deferred 模式里同步用例**当场执行**。
 * 声明放在用例后面的话，用例跑起来时还在 TDZ —— 报错是
 * "Cannot access 'assert' before initialization"，看着莫名其妙，
 * 实际是声明顺序问题。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const stripComments = require('../lib/src-scan').stripComments;
const mainSrcL = readMain({ raw: true });
/* PS_PATH_BATCH 从 main.js 源码里读出来，与实现同源。 */
const PS_PATH_BATCH = Number((mainSrcL.match(/const PS_PATH_BATCH = (\d+);/) || [])[1]);
const fsp = fs.promises;
const BS = String.fromCharCode(92);
const os = require('os');
/* mainSrc：主进程全部源码。迁移来的用例里一半要看 handler 形态，
 * 它们的语义是「主进程里有这个实现」，与在哪个文件无关。 */
const mainSrc = mainSrcL;
const pathExists = async (p) => { try { await fsp.access(p); return true; } catch (e) { return false; } };
/* ================================================================= */

t('① 源树内部的链接：搬家完成后目标侧仍能 readdir（不再变死链）', async () => {
  const mod = makeMoveSandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-t1-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'inner.txt'), 'inner');
    const back = path.join(src, 'sub', 'back');        // 目标落在源树内部
    fs.symlinkSync(path.join(src, 'sub'), back, 'junction');

    const links = [back];
    const dst = path.join(root, 'dst');
    await mod.copyTreeExcludingLinks(src, dst, links);
    const rr = await mod.restoreLinksIntoTarget(src, dst, links, new Map());
    assert.strictEqual(rr.created, 1, '应重建 1 个链接，实际 created=' + rr.created +
      ' failed=' + JSON.stringify(rr.failed));
    assert.deepStrictEqual(rr.failed, [], '不该有失败');
    assert.strictEqual(rr.innerRewritten, 1, '应记下 1 个「目标在源树内部」的改写');

    /* 走完第 3、6 步：源改名 .hehe-bak → 删 .bak */
    fs.renameSync(src, src + '.hehe-bak');
    fs.rmSync(src + '.hehe-bak', { recursive: true, force: true });

    const dstBack = path.join(dst, 'sub', 'back');
    const names = fs.readdirSync(dstBack);             // 旧实现这里会 ENOENT
    assert.ok(names.indexOf('inner.txt') !== -1, '应能读出链接内的文件：' + names.join(','));
    const tgt = fs.readlinkSync(dstBack);
    assert.ok(tgt.toLowerCase().indexOf(dst.toLowerCase()) === 0,
      '链接目标应改写为新位置，实际仍指向 ' + tgt);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('① 指向源目录自身的链接（. → src）也要改写', async () => {
  const mod = makeMoveSandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-t2-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'marker.txt'), 'm');
    const self = path.join(src, 'sub', 'to-root');     // 指向源目录**自身**
    fs.symlinkSync(src, self, 'junction');
    const dst = path.join(root, 'dst');
    await mod.copyTreeExcludingLinks(src, dst, [self]);
    const rr = await mod.restoreLinksIntoTarget(src, dst, [self], new Map());
    assert.strictEqual(rr.innerRewritten, 1, '指向源自身的链接也应算「内部」');
    fs.renameSync(src, src + '.hehe-bak');
    fs.rmSync(src + '.hehe-bak', { recursive: true, force: true });
    const names = fs.readdirSync(path.join(dst, 'sub', 'to-root'));
    assert.ok(names.indexOf('marker.txt') !== -1, '应能读到源目录的内容：' + names.join(','));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('① 目标在源树之外的链接保持原样（不该被改写）', async () => {
  const mod = makeMoveSandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-t3-'));
  try {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'o.txt'), 'o');
    const src = path.join(root, 'src');
    fs.mkdirSync(src, { recursive: true });
    const ext = path.join(src, 'ext');
    fs.symlinkSync(outside, ext, 'junction');
    const dst = path.join(root, 'dst');
    await mod.copyTreeExcludingLinks(src, dst, [ext]);
    const rr = await mod.restoreLinksIntoTarget(src, dst, [ext], new Map());
    assert.strictEqual(rr.innerRewritten, 0, '源树外的链接不该被改写');
    assert.strictEqual(rr.created, 1);
    assert.strictEqual(fs.readFileSync(path.join(dst, 'ext', 'o.txt'), 'utf8'), 'o');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('① 建完自检：链接指向的东西此刻不存在时必须报失败', async () => {
  const mod = makeMoveSandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-t1b-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'sub', 'deeper'), { recursive: true });
    const link = path.join(src, 'sub', 'back');
    fs.symlinkSync(path.join(src, 'sub', 'deeper'), link, 'junction');

    /* 目标侧只建了 dst 根：sub 会被 mkdir 出来，但 sub\deeper 没有 ——
     * 于是改写后的链接指向一个不存在的目录，正是自检要抓的形态。
     * （不调 copyTreeExcludingLinks，就是要让「内容没复制过去」这件事发生。） */
    const dst = path.join(root, 'dst');
    fs.mkdirSync(dst, { recursive: true });
    const rr = await mod.restoreLinksIntoTarget(src, dst, [link], new Map());
    assert.strictEqual(rr.created, 0, '这种情况下不允许报成功（实际 created=' + rr.created + '）');
    assert.strictEqual(rr.failed.length, 1, '应记一条失败：' + JSON.stringify(rr.failed));
    assert.ok(/重建后的链接打不开/.test(rr.failed[0].error),
      '错误信息应说明是「建完打不开」，实际：' + rr.failed[0].error);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

t('① 悬空链接的判据必须是 stat（access 会穿过悬空链接返回成功）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-t1c-'));
  try {
    const gone = path.join(root, 'gone');
    fs.mkdirSync(gone, { recursive: true });
    const j = path.join(root, 'j');
    fs.symlinkSync(gone, j, 'junction');
    fs.rmdirSync(gone);
    /* 这条断言记录的是 Node 的真实行为，是本修复的判据依据 */
    assert.strictEqual((() => { try { fs.accessSync(j); return true; } catch (e) { return false; } })(), true,
      'access 对悬空链接返回成功（正因如此不能拿它当「活着」的判据）');
    assert.strictEqual((() => { try { fs.statSync(j); return true; } catch (e) { return false; } })(), false,
      'stat 会跟随链接，目标不存在时报 ENOENT');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('① 源改名后的抽查（真正的兜底）：照抄旧路径的链接必须被拦住', async () => {
  const mod = makeMoveSandbox();
  /* 用「把 isInsideTree 换成恒 false」模拟老 bug，验证兜底不是摆设 */
  const OLD = new Function('fsp', 'path', 'fs', 'pathExists',
    extract('relKey', false) + '\n'
    + extract('buildLinkKeySet', false) + '\n'
    + extract('linkNature', false) + '\n'
    + extract('linkTargetAbs', false) + '\n'
    + 'function isInsideTree() { return false; }\n'
    + extract('copyTreeExcludingLinks', true) + '\n'
    + extract('restoreLinksIntoTarget', true) + '\n'
    + 'return { copyTreeExcludingLinks, restoreLinksIntoTarget };')(fsp, path, fs, pathExists);
  const VERIFY = new Function('fs', 'path', 'relKey',
    extract('verifyInnerLinksReadable', true) + '\nreturn verifyInnerLinksReadable;'
  )(fs, path, (root, full) => path.relative(path.resolve(root), path.resolve(full)).split(path.sep).join('/'));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-t1d-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'inner.txt'), 'inner');
    const back = path.join(src, 'sub', 'back');
    fs.symlinkSync(path.join(src, 'sub'), back, 'junction');
    const dst = path.join(root, 'dst');
    await OLD.copyTreeExcludingLinks(src, dst, [back]);
    const rr = await OLD.restoreLinksIntoTarget(src, dst, [back], new Map());
    assert.strictEqual(rr.created, 1, '老实现会「成功」');
    assert.strictEqual(rr.srcReadableLinks.length, 1, '应记下「源侧可读」的链接供后面抽查');

    fs.renameSync(src, src + '.hehe-bak');    // 这一刻坏链才暴露
    const v = await VERIFY(dst, src, rr.srcReadableLinks);
    assert.strictEqual(v.ok, false, '源改名后必须拦下坏链，否则又是「搬家完成但链接是死的」');
    assert.ok(/打不开/.test(v.reason), '理由应说清是链接打不开：' + v.reason);

    /* 正确实现下同一个抽查必须通过 */
    const src2 = path.join(root, 'src2');
    fs.mkdirSync(path.join(src2, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src2, 'sub', 'i2.txt'), 'i2');
    const back2 = path.join(src2, 'sub', 'back');
    fs.symlinkSync(path.join(src2, 'sub'), back2, 'junction');
    const dst2 = path.join(root, 'dst2');
    await mod.copyTreeExcludingLinks(src2, dst2, [back2]);
    const rr2 = await mod.restoreLinksIntoTarget(src2, dst2, [back2], new Map());
    fs.renameSync(src2, src2 + '.hehe-bak');
    const v2 = await VERIFY(dst2, src2, rr2.srcReadableLinks);
    assert.strictEqual(v2.ok, true, '改写正确时抽查应通过：' + JSON.stringify(v2));

    /* 源侧本来就悬空的，不参与抽查（不误伤） */
    const src3 = path.join(root, 'src3');
    fs.mkdirSync(path.join(src3, 'sub'), { recursive: true });
    const gone = path.join(root, 'gone3');
    fs.mkdirSync(gone, { recursive: true });
    const dang = path.join(src3, 'sub', 'dang');
    fs.symlinkSync(gone, dang, 'junction');
    fs.rmdirSync(gone);
    const dst3 = path.join(root, 'dst3');
    await mod.copyTreeExcludingLinks(src3, dst3, [dang]);
    const rr3 = await mod.restoreLinksIntoTarget(src3, dst3, [dang], new Map());
    fs.renameSync(src3, src3 + '.hehe-bak');
    assert.strictEqual(rr3.srcReadableLinks.length, 0, '源侧悬空的链接不该进抽查清单');
    const v3 = await VERIFY(dst3, src3, rr3.srcReadableLinks);
    assert.strictEqual(v3.ok, true, '不该因此判搬家失败');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

t('① 第 5 步（源改名之后）真的会抽查目标树里的链接', () => {
  /* 这条用静态断言：完整流程横跨「复制 → 校验 → 改名 → 建链接 → 验证」，
   * 单测里复刻整条链的成本远大于收益，而这里要钉住的是「有没有接上」。
   * 行为层面的判据已由上面那条「源改名后的抽查」用例覆盖。 */
  const code = stripComments(mainSrc);
  assert.ok(/verifyInnerLinksReadable\(dstAbs, srcAbs, innerLinkCheckList\)/.test(code),
    '第 5 步没有调用 verifyInnerLinksReadable（源改名后就没人在看树里的链接了）');
  /* 必须在 linkcheck 这一段里、且排在 verifyLinkReadable 之后（源改名之后） */
  const seg = code.slice(code.indexOf("emit('linkcheck'"), code.indexOf("emit('linkcheck'") + 1200);
  assert.ok(/verifyLinkReadable/.test(seg), 'linkcheck 段里应先验顶层链接');
  assert.ok(/verifyInnerLinksReadable/.test(seg), 'linkcheck 段里必须有树内链接抽查');
  assert.ok(seg.indexOf('verifyLinkReadable') < seg.indexOf('verifyInnerLinksReadable'),
    '抽查应排在顶层验证之后');
  /* 抽查清单必须由复制阶段传下来，且不能恒为空 */
  assert.ok(/innerLinkCheckList = linkRestore\.srcReadableLinks/.test(code),
    '复制阶段没有把「源侧可读的链接」交给第 5 步');
  assert.ok(/let innerLinkCheckList = \[\];/.test(code), 'innerLinkCheckList 应有函数级作用域声明');
});

t('① 预检返回 innerLinkCount，界面也用它', () => {
  const code = stripComments(mainSrc);
  assert.ok(/innerLinkCount/.test(code), 'main.js 没返回 innerLinkCount');
  const ui = read('js/tools/dir-move.js');
  assert.ok(/r\.innerLinkCount/.test(ui), '界面没用 innerLinkCount');
  assert.ok(/改写成新位置的对应路径/.test(ui), '界面应说清「会改写」而不是「原样重建」');
  assert.ok(!/个（会原样重建到新位置）/.test(ui), '仍保留了「一律原样重建」的旧文案');
});

/* ================= ② 电源门禁 ================= */

t('② /a 豁免必须逐段判：混着真关机命令时要拦', () => {
  const P = require('../lib/power-gate.js');
  for (const cmd of ['shutdown /a & shutdown /s', 'shutdown /s /t 0 & shutdown /a',
    'shutdown /? & shutdown /s']) {
    assert.strictEqual(P.isPowerCommand(cmd), true, '穿透了：' + cmd);
  }
  /* 真·取消/帮助仍要放行 */
  for (const cmd of ['shutdown /a', 'shutdown /?', 'cmd /c shutdown /a', 'shutdown /a /t 0']) {
    assert.strictEqual(P.isPowerCommand(cmd), false, '被误拦：' + cmd);
  }
});

t('② 换行不能被归一成空格（PowerShell 认换行当分隔符）', () => {
  const P = require('../lib/power-gate.js');
  assert.ok(P.normalizeCommand('echo hi\nshutdown /s').indexOf('\n') !== -1,
    'normalizeCommand 把换行吃掉了：' + JSON.stringify(P.normalizeCommand('echo hi\nshutdown /s')));
  for (const cmd of ['echo hi\nshutdown /s', 'echo shutdown\nshutdown /s', 'exit\nshutdown /s /t 0']) {
    assert.strictEqual(P.isPowerCommand(cmd), true, '换行绕过了门禁：' + JSON.stringify(cmd));
  }
  /* 真文本仍放行 */
  assert.strictEqual(P.isPowerCommand('echo shutdown'), false);
  assert.strictEqual(P.isPowerCommand('type shutdown.txt'), false);
});

t('② 不再对 norm 做「整条都是文本命令」的豁免', () => {
  const code = stripComments(read('lib/power-gate.js'));
  assert.ok(!/allTextSegments\(norm\)/.test(code),
    '仍保留了 allTextSegments(norm) —— 那是一条没有真实语义的放行路径');
  assert.ok(/allTextSegments\(raw\)/.test(code), 'raw 的逐段判定必须保留');
});

/* ================= ③ 分批 ================= */

t('③ 两处批量 Get-Item 都按 PS_PATH_BATCH 分块', () => {
  const code = stripComments(mainSrc);
  assert.ok(/const PS_PATH_BATCH = \d+;/.test(code), '没有分块常量');
  assert.ok(PS_PATH_BATCH >= 10 && PS_PATH_BATCH <= 200,
    '分块大小应在 10~200 之间（太小起进程多、太大会超命令行上限），实际 ' + PS_PATH_BATCH);
  const hits = (code.match(/i \+= PS_PATH_BATCH/g) || []).length;
  assert.ok(hits >= 2, 'link:scan 与 linkNatures 两处都要分批，实际 ' + hits + ' 处');
  assert.ok(!/const arr = found\.map\(q\)\.join\(','\)/.test(code),
    'link:scan 仍把全部路径拼成一条');
});

t('③ 600 个长路径：不抛 ENAMETOOLONG，结构完整', async () => {
  const linkNatures = makeLinkNatures(psStrict);
  const many = [];
  for (let i = 0; i < 600; i++) {
    many.push(path.join(os.tmpdir(), 'r11-nope-' + i + '-' + 'x'.repeat(70), 'link-' + i));
  }
  /* 先确认「不分批会炸」，证明这条用例有意义 */
  let unsplitFails = false;
  try {
    cp.execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-Item -LiteralPath @(' + many.map((x) => "'" + x + "'").join(',') + ') -ErrorAction SilentlyContinue'],
    { encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
  } catch (e) { unsplitFails = /ENAMETOOLONG/.test(String(e.code) + String(e.message)); }
  if (!unsplitFails) {
    console.log('      （提示）本机命令行上限比 32767 宽松，未复现 ENAMETOOLONG，仍验证分批结构');
  }
  const r = await linkNatures(many);
  assert.ok(r.natures instanceof Map, '应返回 {natures, error}');
  assert.strictEqual(r.natures.size, 0, '这些路径都不存在，应全部判不出来');
  assert.strictEqual(r.error, null, '悬空/不存在不是系统性失败，error 应为 null：' + r.error);
});

/* ================= ④ 源受保护原因 ================= */

t('④ SRC_CRITICAL 的 reason 里带上具体原因（与目标侧对齐）', () => {
  const D = require('../lib/dir-move.js');
  const reason = '这是你自己的用户目录本身，修改它的权限会波及下面所有文件；请选中具体的文件或子文件夹';
  const r = D.validateMove({
    src: 'C:' + BS + 'Users' + BS + 'u', dst: 'D:' + BS + 'backup',
    srcExists: true, srcIsDir: true, srcIsLink: false, srcIsRoot: false,
    srcIsCritical: true, srcProtectedKind: 'OWN_HOME', srcProtectedReason: reason,
    dstExists: false, needBytes: 1, freeBytes: 1e12, lockedPaths: [],
  });
  assert.strictEqual(r.code, 'SRC_CRITICAL');
  assert.ok(r.reason.indexOf(reason) !== -1, 'reason 里没有具体原因：' + r.reason);
  assert.ok(/具体子文件夹/.test(r.advice), 'OWN_HOME 的建议应指向子文件夹：' + r.advice);
  /* 没传原因时退回原来的笼统文案，不崩 */
  const r2 = D.validateMove({
    src: 'C:' + BS + 'Windows', dst: 'D:' + BS + 'b',
    srcExists: true, srcIsDir: true, srcIsLink: false, srcIsRoot: false,
    srcIsCritical: true, dstExists: false, needBytes: 1, freeBytes: 1e12, lockedPaths: [],
  });
  assert.strictEqual(r2.reason, '源目录位于系统关键目录内，拒绝操作');
});

t('④ main.js 两处都把 srcProtectedReason 传给 validateMove', () => {
  const code = stripComments(mainSrc);
  const hits = (code.match(/srcProtectedReason:/g) || []).length;
  assert.ok(hits >= 3, '预检与执行都应传（含返回值），实际 ' + hits + ' 处');
});

/* ================= ⑤ linkNatures 失败上报 ================= */

t('⑤ linkNatures 返回 {natures, error} 而不是裸 Map', () => {
  const code = stripComments(mainSrc);
  assert.ok(/return \{ natures: out, error: null \};/.test(code), '成功分支应返回结构');
  /* 失败分支：断言「同一个返回对象里既有 natures 又有 error」。
   * 注意 `natures: out` 在文件里出现两次 —— 一次是成功分支的 return，
   * 一次是失败分支的 return（后者才是要查的），所以取最后一次。 */
  const at = code.lastIndexOf('natures: out');
  assert.ok(at >= 0, '找不到 linkNatures 的返回值');
  const win = code.slice(at, at + 500);
  assert.ok(/error:\s*errors\.length/.test(win),
    '失败分支应带上 error（且来自分批收集的 errors）：\n' + win.slice(0, 200));
  const hits = (code.match(/linkNatures\(/g) || []).length;
  assert.ok(hits >= 2, '两个调用点都要适配新返回值，实际 ' + hits + ' 处');
});

t('⑤ 真失败会带 error 出来，且文案被截断', async () => {
  const failing = makeLinkNatures(() => Promise.reject(
    Object.assign(new Error('spawn powershell ENAMETOOLONG'), { code: 'ENAMETOOLONG' })));
  const r = await failing([path.join(os.tmpdir(), 'a'), path.join(os.tmpdir(), 'b')]);
  assert.ok(r.error, '查询失败必须带 error 出来');
  assert.ok(/ENAMETOOLONG/.test(r.error), 'error 里应有错误码：' + r.error);
  assert.ok(String(r.error).length < 300, 'error 文案应被截断（不塞整条命令行）：' + String(r.error).length);
});

t('⑤ 悬空链接不算查询失败（它本来就正常）', async () => {
  const linkNatures = makeLinkNatures(psStrict);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-t5-'));
  try {
    const gone = path.join(root, 'gone');
    fs.mkdirSync(gone, { recursive: true });
    const dangling = path.join(root, 'dangling');
    fs.symlinkSync(gone, dangling, 'junction');
    fs.rmdirSync(gone);                      // 目标删掉 → 悬空 junction
    const r = await linkNatures([dangling]);

    /* ① 悬空链接**不是**查询失败 —— 任何环境都必须成立。
     *    查不到性质 ≠ 查询失败；后者会让搬运被整体拒掉。 */
    assert.strictEqual(r.error, null, '悬空链接不该被报成查询失败：' + r.error);

    /* ② 【关键不变量：读不到时不能猜成 'file'】
     * 这条才是真正会酿成事故的一层。实测两个环境行为不同：
     *   本机：Attributes 含 Directory → 判出 'dir'
     *   GitHub windows-latest：Attributes 为空串 → 旧实现走 else 判成 'file'
     * 判成 'file' 的后果不是显示错误，而是重建走 fsp.symlink()（需要
     * SeCreateSymbolicLinkPrivilege），非管理员下必然 EPERM，搬家中止回滚 ——
     * 能不能搬成功居然取决于 PowerShell 读不读得到那个 Attributes。
     * 所以断言的是「要么判出 dir，要么干脆不登记」，绝不能是 'file'。 */
    const n = r.natures.get(dangling.toLowerCase());
    if (n === undefined) {
      console.log('      （提示）本机 PowerShell 读不到悬空 junction 的 Attributes → 不登记（正确行为）');
    } else {
      assert.strictEqual(n, 'dir',
        '悬空 junction 若能判出性质，必须是「目录」；判成 ' + n + ' 会让重建走需要特权的符号链接分支');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('⑤ 预检与界面都把 linkNaturesError 显示出来', () => {
  const code = stripComments(mainSrc);
  assert.ok(/linkNaturesError/.test(code), 'main.js 没返回 linkNaturesError');
  const ui = read('js/tools/dir-move.js');
  assert.ok(/r\.linkNaturesError/.test(ui), '界面没用 linkNaturesError');
  assert.ok(/这不代表没有文件链接/.test(ui), '要说明「查不到 ≠ 没有文件链接」');
});

/* ================= 附带：链接类型列 ================= */

t('⑤ Attributes 读不到时不能登记成 file（否则重建走需要特权的分支）', async () => {
  /* 直接喂一个「Get-Item 有输出、但 Attributes 是空串」的假 ps：
   * 这正是 GitHub windows-latest 上悬空 junction 的真实表现。 */
  const fakePs = () => Promise.resolve({ stdout: "C:\\x\\dang\t\n", stderr: '' });
  const linkNatures = makeLinkNatures(fakePs);
  const r = await linkNatures(['C:\\x\\dang']);
  assert.strictEqual(r.error, null, '这不是查询失败');
  assert.strictEqual(r.natures.get('c:\\x\\dang'), undefined,
    'Attributes 为空时必须「不登记」，绝不能兜底成 file —— ' +
    'file 会走 fsp.symlink()（需要 SeCreateSymbolicLinkPrivilege），非管理员下必然 EPERM');
});

/* ================= 附带：链接类型列 ================= */

t('附带：link:scan 的类型查询失败不再全静默，且类型真的显示出来', () => {
  const code = stripComments(mainSrc);
  assert.ok(/typeQueryError/.test(code), 'link:scan 没上报类型查询失败');
  const ui = read('js/tools/link-doctor.js');
  assert.ok(/r\.typeQueryError/.test(ui), '界面没用 typeQueryError');
  assert.ok(/key: 'linkType'/.test(ui), '一直在算 linkType 却没显示过（那条提示会变成空话）');
});

/* ---------------- 以下助手随 round11 的用例一起迁来 ----------------
 * extract() 按花括号配平取一个函数的完整源码；makeLinkNatures() 把
 * shortErr / linkNature / linkNatures 三段拼起来求值 —— 是**真实现**，
 * 不是手写副本。
 * psStrict 是严格版 PowerShell 调用替身：非零退出即 reject。与生产的 ps()
 * 不同（生产版「非零不抛」），因为这一组要验证的正是"查询失败要如实回报"，
 * 失败必须冒出来才测得到。 */

function extract(name, isAsync) {
  const pat = (isAsync ? 'async function ' : 'function ') + name + '(';
  const start = mainSrc.indexOf(pat);
  if (start < 0) throw new Error('main.js 里找不到 ' + name);
  let i = mainSrc.indexOf('{', start), depth = 0;
  for (; i < mainSrc.length; i++) {
    if (mainSrc[i] === '{') depth++;
    else if (mainSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return mainSrc.slice(start, i);
}

/* 把搬家相关的几个函数装进一个沙箱（与 main.js 同一份源码） */
function makeMoveSandbox() {
  return new Function('fsp', 'path', 'fs', 'pathExists',
    extract('relKey', false) + '\n'
    + extract('buildLinkKeySet', false) + '\n'
    + extract('linkNature', false) + '\n'
    + extract('linkTargetAbs', false) + '\n'
    + extract('normalizeForComparePath', false) + '\n'
    + extract('isInsideTree', false) + '\n'
    + extract('copyTreeExcludingLinks', true) + '\n'
    + extract('restoreLinksIntoTarget', true) + '\n'
    + 'return { copyTreeExcludingLinks, restoreLinksIntoTarget, linkNature, linkTargetAbs, isInsideTree };'
  )(fsp, path, fs, pathExists);
}

/* 与 main.js 的 runCmd 同语义：非零退出算失败（用来暴露 ENAMETOOLONG） */
function psStrict(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    cp.execFile('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: timeoutMs || 60000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve({ stdout, stderr: '' })));
  });
}
function makeLinkNatures(ps) {
  return new Function('ps', 'fs', 'path', 'PS_PATH_BATCH',
    extract('shortErr', false) + '\n'
    + extract('linkNature', false) + '\n'
    + extract('linkNatures', true) + '\n'
    + 'return linkNatures;')(ps, fs, path, PS_PATH_BATCH);
}

done();


function psStrict(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    cp.execFile('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: timeoutMs || 60000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve({ stdout, stderr: '' })));
  });
}

function makeLinkNatures(ps) {
  return new Function('ps', 'fs', 'path', 'PS_PATH_BATCH',
    extract('shortErr', false) + '\n'
    + extract('linkNature', false) + '\n'
    + extract('linkNatures', true) + '\n'
    + 'return linkNatures;')(ps, fs, path, PS_PATH_BATCH);
}
/* ---------------------------------------------------------------- */



/* 读项目内文件（原 test-round10-fixes.js 的 local 助手）。 */
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

/* 链接安全语义测试（这是本项目最危险的一块，必须逐条钉死）。
 *
 * 核心命题：removeLinkOnly 只能删链接，绝不会碰目标数据；
 * 且当调用方误传「解析后的目标路径」时，必须被拦住而不是删掉真实数据。
 *
 * 会被测的行为全部亲测过（见 lib/links.js 顶部注释里的实测结论）。
 */
const { execFileSync } = require('child_process');
const L = require('../lib/links');

function mkJunction() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lnk-'));
  const target = path.join(root, 'real-data');
  const link = path.join(root, 'link');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'precious.txt'), '不能被删的数据');
  fs.mkdirSync(path.join(target, 'sub'));
  fs.writeFileSync(path.join(target, 'sub', 'deep.txt'), '深层数据');
  const r = execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target],
    { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  if (!fs.existsSync(link)) throw new Error('建 junction 失败: ' + r);
  return { root, target, link };
}
function cleanup(c) {
  try { fs.rmSync(c.root, { recursive: true, force: true }); }
  catch (e) { try { execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', c.root], { windowsHide: true }); } catch (e2) {} }
}

/* ---------- 1. 识别 ---------- */
t('linkStat 能识别 junction 且不跟随', () => {
  const c = mkJunction();
  try {
    const st = L.linkStat(c.link);
    assert.strictEqual(st.isLink, true, 'junction 应被识别为链接');
    assert.strictEqual(st.exists, true);
    // 对普通目录应报 isLink=false
    assert.strictEqual(L.linkStat(c.target).isLink, false, '普通目录不该被当成链接');
  } finally { cleanup(c); }
});

t('linkStat 对不存在的路径返回 exists=false 而不抛', () => {
  const st = L.linkStat(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now()));
  assert.strictEqual(st.exists, false);
  assert.strictEqual(st.isLink, false);
});

/* ---------- 2. 安全删除：只删链接 ---------- */
t('removeLinkOnly 删掉链接但目标数据完好', async () => {
  const c = mkJunction();
  try {
    const r = await L.removeLinkOnly(c.link);
    assert.strictEqual(r.removed, true);
    assert.ok(!fs.existsSync(c.link), '链接应已消失');
    assert.ok(fs.existsSync(c.target), '目标目录必须还在');
    assert.ok(fs.existsSync(path.join(c.target, 'precious.txt')), '目标里的文件必须完好');
    assert.ok(fs.existsSync(path.join(c.target, 'sub', 'deep.txt')), '目标的子目录必须完好');
  } finally { cleanup(c); }
});

t('removeLinkOnly 会记录目标（供汇报用）但不使用它删除', async () => {
  const c = mkJunction();
  try {
    const r = await L.removeLinkOnly(c.link);
    assert.ok(r.target, '应记录目标路径');
    assert.ok(String(r.target).toLowerCase().indexOf('real-data') !== -1, '目标应指向 real-data');
  } finally { cleanup(c); }
});

/* ---------- 3. 最关键：误传「解析后目标」必须被拦住 ---------- */
t('把 resolveReal 的结果传给 removeLinkOnly，会被拒绝而不是删数据', async () => {
  const c = mkJunction();
  try {
    const resolved = fs.realpathSync.native(c.link);   // 这就是「解析后的目标」
    let threw = null;
    try { await L.removeLinkOnly(resolved); } catch (e) { threw = e; }

    assert.ok(threw, '对目标路径的删除必须报错');
    assert.strictEqual(threw.code, 'LINK_UNSAFE', '应抛 LINK_UNSAFE，实际 ' + threw.code);
    // 最重要的后置条件：数据一点没少
    assert.ok(fs.existsSync(c.target), '目标目录必须还在');
    assert.ok(fs.existsSync(path.join(c.target, 'precious.txt')), '目标里的文件必须完好');
  } finally { cleanup(c); }
});

t('assertIsLinkItself 拒绝普通目录/文件', () => {
  const c = mkJunction();
  try {
    assert.throws(() => L.assertIsLinkItself(c.target), /不是链接/, '普通目录应被拒绝');
  } finally { cleanup(c); }
});

t('assertIsLinkItself 接受真正的链接', () => {
  const c = mkJunction();
  try {
    const r = L.assertIsLinkItself(c.link);
    assert.strictEqual(r.st.isLink, true);
  } finally { cleanup(c); }
});

/* ---------- 4. 卷与根判定 ---------- */
t('sameVolume 判断同卷', () => {
  const tmp = os.tmpdir();
  assert.strictEqual(L.sameVolume(tmp, path.join(tmp, 'x')).toString(), 'true');
});

t('isVolumeRootOnly 识别盘符根', () => {
  assert.ok(L.isVolumeRootOnly('C:\\'), 'C:\\ 是盘符根');
  assert.ok(!L.isVolumeRootOnly('C:\\Windows'), 'C:\\Windows 不是盘符根');
});

t('volumeRoot 取盘符', () => {
  const v = L.volumeRoot('C:\\Users\\x');
  assert.strictEqual(v, 'c:\\');
});

/* ---------- 5. 体检分类 ---------- */
t('classifyLink 对正常链接判为 ok', () => {
  const c = mkJunction();
  try {
    const r = L.classifyLink(c.link, { type: 'junction', target: c.target });
    assert.strictEqual(r.kind, 'ok', '正常链接应判 ok，实际 ' + r.kind + '（' + r.reason + '）');
    assert.ok(r.target, '应给出解析后的目标');
  } finally { cleanup(c); }
});

t('classifyLink 对僵尸链接判为 dead', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-'));
  const target = path.join(root, 'gone');
  const link = path.join(root, 'deadlink');
  fs.mkdirSync(target);
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { windowsHide: true });
  // 删掉目标 → 链接变僵尸
  fs.rmSync(target, { recursive: true, force: true });
  try {
    const r = L.classifyLink(link, { type: 'junction', target });
    assert.ok(r.kind === 'dead' || r.kind === 'loop',
      '目标不存在应判 dead（或 loop），实际 ' + r.kind + '：' + r.reason);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); }
    catch (e) { try { execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', root], { windowsHide: true }); } catch (e2) {} }
  }
});

t('classifyLink 对普通目录标记 notLink', () => {
  const c = mkJunction();
  try {
    const r = L.classifyLink(c.target, null);
    assert.strictEqual(r.notLink, true, '普通目录应标记 notLink');
  } finally { cleanup(c); }
});

/* ---------- 目标所在卷不可用 ≠ 僵尸链接 ----------
 * 移动硬盘/U 盘/网络盘没插时，realpath 必然失败。早期实现失败即判 dead，
 * 于是这些仍然有效的链接被列为「目标已不存在，可以清理」——
 * 用户点一下批量清理，链接就没了（数据没丢，但原路径打不开）。
 * 卷不可达是**暂时**状态，必须归 crossvol（不可清理）。 */
t('目标声明在不可用卷上 → 判 crossvol，不是 dead', () => {
  const c = mkJunction();
  try {
    /* 链接本身在本机卷上，但 readlink 声明的目标在 Q:\ 这种不存在的盘。
     * 这是移动硬盘拔掉时的真实形态。 */
    const r = L.classifyLink(c.link, { type: 'junction', target: 'Q:\\gone\\dir' });
    assert.strictEqual(r.kind, 'crossvol',
      '卷不可用时应判 crossvol，实际 ' + r.kind + '：' + r.reason);
    assert.ok(/不可用/.test(r.reason), '原因要说清卷不可用：' + r.reason);
  } finally { cleanup(c); }
});

t('crossvol 在 LINK_KINDS 里明确标注不可清理', () => {
  const k = L.LINK_KINDS.crossvol;
  assert.ok(k, 'crossvol 类型缺失');
  assert.strictEqual(k.sev, 'warn', 'crossvol 应是警告级而不是坏');
  assert.ok(/不可清理/.test(k.desc), 'crossvol 的描述必须写明不可清理：' + k.desc);
});

t('卷可用但目标确实没了 → 仍判 dead（该清的还得能清）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dead2-'));
  const target = path.join(root, 'gone');
  const link = path.join(root, 'deadlink');
  fs.mkdirSync(target);
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { windowsHide: true });
  fs.rmSync(target, { recursive: true, force: true });
  try {
    const tt = fs.readlinkSync(link);
    const r = L.classifyLink(link, { type: 'junction', target: tt });
    assert.strictEqual(r.kind, 'dead',
      '同卷目标消失应判 dead（可清理），实际 ' + r.kind + '：' + r.reason);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); }
    catch (e) { try { execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', root], { windowsHide: true }); } catch (e2) {} }
  }
});

/* ---------- 6. dirSize 不跟随链接 ---------- */
t('dirSize 统计字节且不把链接目标算进来', async () => {
  const c = mkJunction();
  try {
    // 在根下放一个真文件
    const other = path.join(c.root, 'own.txt');
    fs.writeFileSync(other, 'x'.repeat(100));
    const r = await L.dirSize(c.root);
    // c.root 下有 target(真目录，含 2 个文件) + link(链接，应被跳过) + own.txt
    assert.ok(r.files >= 3, '应统计到真实文件，实际 ' + r.files);
    // 链接不应让文件数翻倍
    assert.ok(r.files <= 4, '不应把链接目标重复计入，实际 ' + r.files);
  } finally { cleanup(c); }
});

t('权限被拒的活链接判「无法判断」，不再可清理', async () => {
  const L = require('../lib/links.js');
  const me = cp.execFileSync('powershell', ['-NoProfile', '-Command',
    '[Security.Principal.WindowsIdentity]::GetCurrent().Name'], { encoding: 'utf8' }).trim();
  const base = path.join(os.tmpdir(), 'hehe-round10-link');
  fs.rmSync(base, { recursive: true, force: true });
  const realDir = path.join(base, 'real target');
  const linkDir = path.join(base, 'the link');
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(path.join(realDir, 'inside.txt'), 'data');
  try {
    fs.symlinkSync(realDir, linkDir, 'junction');
    assert.strictEqual(L.classifyLink(linkDir, { target: realDir }).kind, 'ok', '基线应判 ok');
    cp.execFileSync('icacls', [linkDir, '/deny', me + ':(F)'], { encoding: 'utf8' });
    /* 权限拒绝后 realpath 会失败，但链接与目标都还在 */
    let rp = 'ok';
    try { fs.realpathSync.native(linkDir); } catch (e) { rp = e.code; }
    if (/EPERM|EACCES/i.test(String(rp))) {
      const cls = L.classifyLink(linkDir, { target: realDir });
      assert.strictEqual(cls.kind, 'opaque', '活链接被判成 ' + cls.kind + '（会被当僵尸删掉）');
      assert.ok(/EPERM|EACCES|权限/.test(cls.reason), '理由要说清是权限：' + cls.reason);
    }
    cp.execFileSync('icacls', [linkDir, '/remove:d', me], { encoding: 'utf8' });
    fs.rmSync(realDir, { recursive: true, force: true });
    assert.strictEqual(L.classifyLink(linkDir, { target: realDir }).kind, 'dead', '目标真没了才是僵尸');
  } finally {
    /* 【清理必须先把拒绝项撤掉】
     * 这条用例会给自己加一条 DENY (F)：若中途断言失败跳到 finally，
     * 直接 rm 会因为权限被拒而删不掉，残留目录还会让**下一次**运行
     * 在本用例的 mkdir 处报 EPERM —— 把「测试失败」变成「测试环境坏了」。 */
    try { cp.execFileSync('icacls', [linkDir, '/remove:d', me], { stdio: 'pipe' }); } catch (e) {}
    try { cp.execFileSync('icacls', [realDir, '/remove:d', me], { stdio: 'pipe' }); } catch (e) {}
    fs.rmSync(base, { recursive: true, force: true });
  }
});

t('新的 opaque 类在三处都登记了（否则会被当成「正常」或渲染崩）', () => {
  const L = require('../lib/links.js');
  assert.ok(L.LINK_KINDS.opaque, 'lib/links.js 的 LINK_KINDS 缺 opaque');
  const code = stripComments(mainSrc);
  assert.ok(/groups = \{ ok: \[\], dead: \[\], loop: \[\], system: \[\], crossvol: \[\], opaque: \[\] \}/.test(code),
    'main.js 的 groups 必须登记 opaque（漏了会被兜底塞进「正常」）');
  const ui = stripComments(read('js/tools/link-doctor.js'));
  assert.ok(/opaque: \{ title:/.test(ui), 'link-doctor 的 KIND_META 缺 opaque');
  assert.ok(/ORDER = \['dead', 'loop', 'system', 'crossvol', 'opaque', 'ok'\]/.test(ui),
    'ORDER 里必须包含 opaque（否则该组不显示）');
});

t('link:remove 仍然只删 dead（opaque 自动被跳过）', () => {
  const code = stripComments(mainSrc);
  assert.ok(/if \(cls\.kind !== 'dead'\)/.test(code), 'link:remove 的二次校验必须仍只放行 dead');
});

/* ================= ⑦ 锁卡粒度 ================= */

t('链接性质判定：目录→junction、文件→符号链接、判不出→如实报错', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r10nat-'));
  try {
    const dir = path.join(root, 'd');
    const file = path.join(root, 'f.txt');
    fs.mkdirSync(dir);
    fs.writeFileSync(file, 'x');
    /* 直接把 linkNature 抽出来跑（它只依赖 fs） */
    const start = mainSrc.indexOf('function linkNature(');
    let i = mainSrc.indexOf('{', start), depth = 0;
    for (; i < mainSrc.length; i++) {
      if (mainSrc[i] === '{') depth++;
      else if (mainSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const linkNature = new Function('fs', mainSrc.slice(start, i) + '\nreturn linkNature;')(fs);
    const jdir = path.join(root, 'jdir');
    fs.symlinkSync(dir, jdir, 'junction');
    assert.strictEqual(linkNature(jdir), 'dir', '目录链接应判 dir');
    assert.strictEqual(linkNature(path.join(root, '不存在')), 'unknown', '判不出时必须是 unknown');
    let madeFileLink = false;
    const flink = path.join(root, 'flink.txt');
    try { fs.symlinkSync(file, flink); madeFileLink = true; } catch (e) { /* 需要特权 */ }
    if (madeFileLink) {
      assert.strictEqual(linkNature(flink), 'file', '文件符号链接应判 file（不能当目录处理）');
    }
    /* 静态兜底：重建时必须按性质分流，且判不出时拒绝重建（不许猜） */
    const code = stripComments(mainSrc);
    assert.ok(/await fsp\.symlink\(absTarget, dstChild, 'junction'\)/.test(code), '缺 junction 分支');
    assert.ok(/await fsp\.symlink\(absTarget, dstChild\);/.test(code), '缺「文件符号链接」分支');
    assert.ok(/无法判断这个链接指向目录还是文件，拒绝重建/.test(code), '判不出时必须拒绝而不是硬建 junction');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('重建链接时「文件」必须走符号链接分支（不能一律 junction）', async () => {
  /* 【为什么要有这条行为用例】
   * 只断言源码里「有那行 fsp.symlink(absTarget, dstChild)」是不够的：
   * 把条件改成 `else if (false)` 那行仍在源码里，静态检查照样绿 ——
   * 实测确实出现过这种「假绿」。这里真的跑一次 restoreLinksIntoTarget，
   * 并把性质**指定为 file**：
   *   - 走对了分支：要么建成（created=1），要么因缺符号链接特权而失败，
   *     但失败原因绝不会是「无法判断」；
   *   - 分支被关掉：会掉进 else，报「无法判断这个链接指向目录还是文件」，被抓出来。 */
  function extract(name, isAsync) {
    const pat = (isAsync ? 'async function ' : 'function ') + name + '(';
    const start = mainSrc.indexOf(pat);
    if (start < 0) throw new Error('not found: ' + name);
    let i = mainSrc.indexOf('{', start), depth = 0;
    for (; i < mainSrc.length; i++) {
      if (mainSrc[i] === '{') depth++;
      else if (mainSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return mainSrc.slice(start, i);
  }
  const pathExists = async (p) => { try { await fsp.access(p); return true; } catch (e) { return false; } };
  const mod = new Function('fsp', 'path', 'fs', 'pathExists',
    extract('relKey', false) + '\n' + extract('buildLinkKeySet', false) + '\n'
    + extract('linkNature', false) + '\n'
    + extract('copyTreeExcludingLinks', true) + '\n' + extract('restoreLinksIntoTarget', true) + '\n'
    + 'return { copyTreeExcludingLinks, restoreLinksIntoTarget, linkNature };')(fsp, path, fs, pathExists);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r10file-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'inner.txt'), 'inner');
    const jlink = path.join(src, 'jlink');
    fs.symlinkSync(path.join(src, 'sub'), jlink, 'junction');
    const dst = path.join(root, 'dst');
    await mod.copyTreeExcludingLinks(src, dst, [jlink]);
    const natures = new Map([[jlink.toLowerCase(), 'file']]);
    const rr = await mod.restoreLinksIntoTarget(src, dst, [jlink], natures);
    if (rr.created === 1) {
      /* 建成时必须是符号链接（不是 junction）：junction 的 readlink 带 \\?\ 前缀 */
      const t = fs.readlinkSync(path.join(dst, 'jlink'));
      assert.ok(!/^\\\\\?\\/.test(t), '文件分支建出来的居然是 junction（readlink=' + t + '）');
    } else {
      assert.ok(rr.failed.length === 1, '失败时应记一条：' + JSON.stringify(rr.failed));
      assert.ok(!/无法判断/.test(rr.failed[0].error),
        '被当成「性质不明」拒绝了 —— 文件符号链接分支没生效：' + rr.failed[0].error);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('linkNatures 返回 {natures, error} 而不是裸 Map', () => {
  const code = stripComments(mainSrc);
  assert.ok(/return \{ natures: out, error: null \};/.test(code), '成功分支应返回结构');
  /* 失败分支：断言「同一个返回对象里既有 natures 又有 error」。
   * 注意 `natures: out` 在文件里出现两次 —— 一次是成功分支的 return，
   * 一次是失败分支的 return（后者才是要查的），所以取最后一次。 */
  const at = code.lastIndexOf('natures: out');
  assert.ok(at >= 0, '找不到 linkNatures 的返回值');
  const win = code.slice(at, at + 500);
  assert.ok(/error:\s*errors\.length/.test(win),
    '失败分支应带上 error（且来自分批收集的 errors）：\n' + win.slice(0, 200));
  const hits = (code.match(/linkNatures\(/g) || []).length;
  assert.ok(hits >= 2, '两个调用点都要适配新返回值，实际 ' + hits + ' 处');
});

t('预检与界面都把 linkNaturesError 显示出来', () => {
  const code = stripComments(mainSrc);
  assert.ok(/linkNaturesError/.test(code), 'main.js 没返回 linkNaturesError');
  const ui = read('js/tools/dir-move.js');
  assert.ok(/r\.linkNaturesError/.test(ui), '界面没用 linkNaturesError');
  assert.ok(/这不代表没有文件链接/.test(ui), '要说明「查不到 ≠ 没有文件链接」');
});

/* ================= 附带：链接类型列 ================= */

t('Attributes 读不到时不能登记成 file（否则重建走需要特权的分支）', async () => {
  /* 直接喂一个「Get-Item 有输出、但 Attributes 是空串」的假 ps：
   * 这正是 GitHub windows-latest 上悬空 junction 的真实表现。 */
  const fakePs = () => Promise.resolve({ stdout: "C:\\x\\dang\t\n", stderr: '' });
  const linkNatures = makeLinkNatures(fakePs);
  const r = await linkNatures(['C:\\x\\dang']);
  assert.strictEqual(r.error, null, '这不是查询失败');
  assert.strictEqual(r.natures.get('c:\\x\\dang'), undefined,
    'Attributes 为空时必须「不登记」，绝不能兜底成 file —— ' +
    'file 会走 fsp.symlink()（需要 SeCreateSymbolicLinkPrivilege），非管理员下必然 EPERM');
});

/* ================= 附带：链接类型列 ================= */

t('附带：link:scan 的类型查询失败不再全静默，且类型真的显示出来', () => {
  const code = stripComments(mainSrc);
  assert.ok(/typeQueryError/.test(code), 'link:scan 没上报类型查询失败');
  const ui = read('js/tools/link-doctor.js');
  assert.ok(/r\.typeQueryError/.test(ui), '界面没用 typeQueryError');
  assert.ok(/key: 'linkType'/.test(ui), '一直在算 linkType 却没显示过（那条提示会变成空话）');
});

t('额外项1：link:scan 不再递归重扫全树取 LinkType', () => {
  const code = stripComments(mainSrc);
  assert.ok(!/Get-ChildItem -LiteralPath \$\{q\(root\)\} -Recurse/.test(code),
    '仍在用 Get-ChildItem -Recurse 重扫全树（collectLinks 已经遍历过一次）');
  assert.ok(/Get-Item -LiteralPath @\(/.test(code),
    '应改成对已收集的链接做批量 Get-Item');
});

done();
