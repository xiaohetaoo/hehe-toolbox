'use strict';
/* 【文件定位：历史轮次回归，不是模块测试】
 * 本文件为历史轮次回归，行为断言应逐步迁往 test-<模块>.js；新测试不要加到这里。
 * 迁移目标见 scripts/test-test-map.js 打印的「lib 模块 → 测试文件」地图：
 * 找某个模块的测试时，先看那张表，再按模块名找 test-<模块>.js。
 * 保留按轮次命名的理由：每一条断言都对应一次真实故障的现场，
 * 合并进模块文件会丢掉「这一批是一起发现的」这条线索。
 */
/* 原脚本用 cases 收集 + 串行 for 循环，输出严格按注册顺序。
 * 这里显式指定 order:'sequential' 以保持迁移前的输出顺序不变。 */
const { createSuite, readTree, readMain } = require('./lib/harness');
const { t, done } = createSuite({ order: 'sequential' });
/* 第 14 轮修复项的回归测试。
 *
 * 与前面几轮一样，凡是能跑真实现的都从 main.js / lib / js 里抽出**真函数**来跑；
 * 只有纯结构约束才退回源码断言，而且源码断言必须先剥注释（注释不是代码）。
 *
 * 覆盖：
 *   1. pinWins 的 Map 键类型（数字/字符串混用导致拖动缩放关闭静默失效）
 *   2. app.js 的 finally 引用 try 内 let（每次必抛 ReferenceError）
 *   3. alertBox 的对象实参（弹出空白框）+ 失败明细内容
 *   4. 截图导出裁剪必须乘 devicePixelRatio
 *   5. restoreLinksIntoTarget 清目标侧同名项：目录要能删、清不掉要记账
 *   6. UNC 目标必须提前拒；freeBytes 读不到要显式标记
 *   7. 复制期间源文件消失不该中止整次搬家（copy 与 verify 两处都要容忍）
 *   8. target-size 早退必须解锁（见 test-dz-el.js 扩展）
 *   9. 测速任务的 job id 必须按前缀认领，不能先到先得
 *  10. 表达式求值要挡住 ±Infinity，不只是 NaN
 *  11. 摄像头清理注册不能放在 rec:audio-devices 的 then 里
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/* 任务 5 把「目录搬家 + 权限/链接」两个域搬到了 ipc/dir-acl-links.js：
 * 这里读「主进程全部源码」（main.js + ipc/），断言的语义是
 * 「主进程里有这个实现」，与它被放在哪个文件无关。 */
const mainSrc = readMain();

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

/* 【剥注释与函数抽取统一走 lib/src-scan.js】
 * 早期这里各自实现一份，结果踩了两个坑：
 *   · stripComments 不识别正则字面量 → net-tools.js 里 /[\u0000-\u001f<>:"|?*]/g
 *     中的 " 被当成字符串开头，之后所有注释/字符串判断全部错位；
 *   · 抽取函数时同理：regexAllowed 内部就有 /[a-zA-Z0-9_$])}]/，
 *     朴素配平会被其中的 } 带偏，报「括号不配平」。
 * 现在只有一份实现，谁 require 谁一致。 */
const { stripComments, extractFn } = require(path.join(ROOT, 'lib', 'src-scan'));

/* ==================== 1. pinWins 的 Map 键类型 ==================== */
/* 抽出 pinKey / pinWins / pinWinOf 的真实现，用一个假的 BrowserWindow 跑。 */
function loadPinKeyBlock() {
  const block = extractFn(
    mainSrc,
    'function pinWinOf(',
    'pinWinOf');
  // 还需要 pinKey 与 pinWins 的声明
  const kStart = mainSrc.indexOf('const pinKey =');
  const kEnd = mainSrc.indexOf('const pinWins = new Map();', kStart);
  assert.ok(kStart > 0 && kEnd > kStart, '找不到 pinKey 声明');
  const decls = mainSrc.slice(kStart, kEnd + 'const pinWins = new Map();'.length);
  return new Function(decls + '\n' + block + '\nreturn { pinKey, pinWins, pinWinOf };')();
}

t('1a pinKey：数字、字符串、带空格的值都归一成同一个键', () => {
  const { pinKey } = loadPinKeyBlock();
  assert.strictEqual(pinKey(12), '12', '数字 12 应归一成字符串 "12"');
  assert.strictEqual(pinKey('12'), '12', '字符串 "12" 应保持原样');
  assert.strictEqual(pinKey(12), pinKey('12'), '同一次窗口的两个来源必须得到同一个键');
  assert.strictEqual(pinKey(null), '', 'null 不能变成 "null"');
  assert.strictEqual(pinKey(undefined), '', 'undefined 不能变成 "undefined"');
  assert.strictEqual(pinKey(0), '0', '0 是合法的窗口 id，不能被当成空');
});

t('1b pinWinOf：登记时用数字、查询时用字符串（渲染层的真实路径）也找得到', () => {
  const { pinKey, pinWins, pinWinOf } = loadPinKeyBlock();
  const fakeWin = { id: 12, isDestroyed: () => false, _pos: null, setPosition(x, y) { this._pos = [x, y]; } };
  // 模拟 createPinWindow 的登记：必须用 pinKey 包一层（旧写法直接 set(bw.id))
  pinWins.set(pinKey(fakeWin.id), fakeWin);
  // 模拟渲染层：URLSearchParams.get('id') 拿回来的是字符串，原样 IPC 发回来
  const found = pinWinOf('12');
  assert.ok(found, "Map 里存 12、查 '12' 必须找到窗口（这正是拖动/缩放/关闭全失效的根因）");
  assert.strictEqual(found, fakeWin);
  // 反向：真的不存在的 id 依然找不到
  assert.strictEqual(pinWinOf('99'), null, '不存在的 id 应返回 null');
  // 已销毁的窗口也当找不到
  const dead = { id: 7, isDestroyed: () => true };
  pinWins.set(pinKey(dead.id), dead);
  assert.strictEqual(pinWinOf('7'), null, '已销毁的窗口应返回 null');
});

t('1c 三个贴图 handler 取不到窗口时必须返回 false，不能假装成功', () => {
  const code = stripComments(mainSrc);
  for (const ch of ['win:pin-move', 'win:pin-resize', 'win:pin-close']) {
    const i = code.indexOf("handle('" + ch + "'");
    assert.ok(i > 0, '找不到 handler ' + ch);
    const seg = code.slice(i, code.indexOf('\n});', i));
    /* 旧写法：const bw = pinWins.get(id); if (bw && ...) ...; return true;
     * —— 取不到也 return true。新写法必须显式 return false。 */
    assert.ok(/if\s*\(\s*!bw\s*\)\s*return false/.test(seg),
      ch + ' 取不到窗口时没有 return false（会静默假装成功）');
    assert.ok(!/pinWins\.get\(id\)/.test(seg),
      ch + ' 仍在直接用 pinWins.get(id)（没有做键类型归一）');
    assert.ok(/pinWinOf\(/.test(seg), ch + ' 没有走 pinWinOf 的归一查找');
  }
});

t('1d createPinWindow 登记与删除都用同一个归一键', () => {
  const code = stripComments(mainSrc);
  assert.ok(/pinWins\.set\(\s*pinKey\(bw\.id\)\s*,\s*bw\s*\)/.test(code),
    '登记时没用 pinKey（数字键与字符串键会分家）');
  assert.ok(/pinWins\.delete\(\s*pinKey\(bw\.id\)\s*\)/.test(code),
    'closed 里没用 pinKey 删除，会留下一个查不到的僵尸条目');
  assert.ok(/String\(bw\.id\)/.test(code), 'URL 里传的仍然应是 String(bw.id)');
});

/* ==================== 2. finally 不能引用 try 内的 let ==================== */
t('2a app.js：dlId 与 unsub 都在 try 之外声明', () => {
  const raw = read('js/app.js');
  const code = stripComments(raw);
  const fnStart = code.indexOf('async function checkUpdate(');
  assert.ok(fnStart > 0, '找不到 checkUpdate');
  const fnBody = extractFn(code, 'async function checkUpdate(');

  /* 【不能用 indexOf('try {')】前面那句 `if (updUnsub) { try { updUnsub(); } ... }` 里
   * 也有一个内联的 try，会被先命中，导致 beforeTry 只取到函数头一小段。
   * 找**行首**的主 try：前面只有空白。 */
  const mMain = fnBody.match(new RegExp('\\n[ \\t]*try[ \\t]*\\{'));
  assert.ok(mMain, 'checkUpdate 里找不到主 try');
  const tryAt = mMain.index;
  assert.ok(tryAt > 0, 'checkUpdate 里找不到 try');
  const declBefore = fnBody.slice(0, tryAt);
  assert.ok(/let\s+dlId\s*=/.test(declBefore), 'dlId 必须在 try 之前声明（否则 finally 读不到）');
  assert.ok(/let\s+unsub\s*=/.test(declBefore), 'unsub 必须在 try 之前声明');
  // 反面：try 内部不许再出现一次 let dlId（那会遮蔽外层，finally 永远读到 null）
  const tryToFinally = fnBody.slice(tryAt, fnBody.indexOf('finally'));
  assert.ok(!/let\s+dlId/.test(tryToFinally), 'try 内又声明了一次 dlId，会遮蔽外层变量');
  // finally 里确实在用它 —— 这才是必须提前声明的理由
  const fin = fnBody.slice(fnBody.indexOf('finally'));
  assert.ok(/dlId/.test(fin), 'finally 里已不再引用 dlId，本项约束失去意义（请同步更新测试）');
});

t('2b 行为验证：块级作用域下 finally 读 try 内 let 会抛 ReferenceError', () => {
  /* 用最小样例证明这个缺陷机理是真的（而不是"我以为会抛"）。
   * 这段代码不依赖项目，只演示 JS 语义。
   *
   * 【为什么用 new Function 而不是直接写这段代码】
   * 要验证的正是「finally 里读一个只存在于 try 块内的 let」，
   * 直接写出来会被 lint 的 no-undef 判为「引用未定义变量」——
   * 而这里**引用一个不存在的变量恰是实验本身**。
   * 与其加一行 disable 注释（那会把 no-undef 在这附近的真实报警也一起关掉），
   * 不如把这段实验代码放进 new Function：它是一个自包含的字符串，
   * 作用域与文件隔离，既保住了实验语义，又不会污染本文件的静态检查。 */
  const makeThrowing = new Function(
    'try { let inner = 1; throw new Error("boom"); }\n'
    + 'finally { void inner; }');
  let thrown = null;
  try { makeThrowing(); } catch (e) { thrown = e; }
  assert.ok(thrown && /ReferenceError/.test(thrown.name || ''),
    'JS 语义与预期不符：finally 读 try 内 let 应当抛 ReferenceError，实际 ' + (thrown && thrown.name));
});

t('2c 行为验证：提到外部之后，finally 能正常读到（模拟修好的写法）', () => {
  let seen = undefined, ran = false;
  try {
    (function () {
      let dlId = null;
      try { dlId = 'dlg123'; }
      finally { seen = dlId; ran = true; }
    })();
  } catch (e) { assert.fail('修好的写法不应该抛：' + e.message); }
  assert.strictEqual(seen, 'dlg123', 'finally 应该读到 try 里赋的值');
  assert.strictEqual(ran, true, 'finally 必须真的执行完（原来异常会把它后半段顶掉）');
});

/* ==================== 3. alertBox 的对象实参 ==================== */
t('3a alertBox 收到对象时兼容，并且 console.warn 提示调用方', () => {
  const uiSrc = read('js/ui.js');
  const block = extractFn(uiSrc, 'function alertBox(');
  /* 真的跑一遍：用一个假的 modal/h 桩，验证对象形态不会得到空白正文。 */
  let modalTitle = null, modalBody = null;
  const fakeH = (tag, attrs, child) => ({ tag, attrs, child });
  const fakeModal = (opts) => { modalTitle = opts.title; opts.body({ appendChild: (n) => { modalBody = n; } }); return { close() {} }; };
  const warns = [];
  const alertBox = new Function('modal', 'h', 'console', block + '\nreturn alertBox;')(
    fakeModal, fakeH, { warn: (...a) => warns.push(a.join(' ')) });

  alertBox({ title: '部分文件未能重命名', message: '明细文本' });
  assert.ok(modalBody && modalBody.child === '明细文本', '对象实参的 message 字段没有被取出来当正文');
  assert.strictEqual(modalTitle, '部分文件未能重命名', '对象实参的 title 字段没有被用上');
  assert.ok(warns.length >= 1 && /alertBox/.test(warns[0]), '误用对象时应当 console.warn 提醒');

  // 正常写法不受影响
  alertBox('普通文本', '自定义标题');
  assert.strictEqual(modalBody.child, '普通文本');
  assert.strictEqual(modalTitle, '自定义标题');
});

t('3b 失败明细的空白框问题：正文必须保留换行（pre-wrap）', () => {
  const uiSrc = read('js/ui.js');
  const block = stripComments(extractFn(uiSrc, 'function alertBox('));
  assert.ok(/whiteSpace\s*:\s*'pre-wrap'/.test(block),
    'alertBox 正文没有 pre-wrap：多行失败明细会被压成一长条，文件名与原因对不上号');
});

/* ==================== 4. 截图导出裁剪乘 dpr ==================== */
t('4a 截图导出：源矩形必须乘 dpr，目标尺寸用逻辑像素', () => {
  const raw = read('js/auxwin/snip-2.js');
  const code = stripComments(raw);
  const i = code.indexOf('const dpr = devicePixelRatio');
  assert.ok(i > 0, '找不到导出裁剪那段');
  /* 取到 payload.dataUrl 之前，即整段「算坐标 → 建 canvas → drawImage」 */
  const seg = code.slice(i, code.indexOf('payload.dataUrl', i));
  assert.ok(seg.indexOf('drawImage') > 0, '取到的片段里没有 drawImage，抽取边界已失效');

  /* 【必须真的执行源码里那一段，不能另写一份同构代码】
   * 本用例最初的写法是：先 new Function 建了 `fn`（包住真实 seg），
   * 但**从未调用它**；真正跑的是紧跟着另写的 `run` —— 里面是手抄的算式。
   * 于是这条测试测的是测试自己写的代码，与 snip-2.js 无关。
   * 实测确认：把源码里 `sw = sel.w * dpr` 改成 `sw = sel.w`
   * （非 100% 缩放下截图横向错位），6 个 drawImage 断言仍然全绿。
   *
   * 现在改成：把 seg 里真实那段塞进函数执行，只注入它需要的外部量
   * （devicePixelRatio / canvas / document / sel / payload）。
   * document.createElement 返回一个会记录调用的假 canvas。 */
  const calls = [];
  const fakeOctx = {
    scale: (x, y) => calls.push({ op: 'scale', x, y }),
    drawImage: (cv, sx, sy, sw, sh, dx, dy, dw, dh) =>
      calls.push({ op: 'drawImage', sx, sy, sw, sh, dx, dy, dw, dh }),
  };
  const makeFakeCanvas = () => ({
    width: 0,
    height: 0,
    getContext: () => fakeOctx,
    toDataURL: () => 'data:image/png;base64,STUB',
  });

  const dpr = 1.5;
  const sel = { x: 100, y: 50, w: 200, h: 120 };
  const payload = {};
  /* 真实源码片段里引用的外部量全部由形参注入，片段本身不改一字 */
  const run = new Function('devicePixelRatio', 'canvas', 'document', 'sel', 'payload',
    `return (function () {
       ${seg}
       return { out: out, octx: octx, sx: sx, sy: sy, sw: sw, sh: sh };
     })();`);
  const got = run(dpr, {}, { createElement: makeFakeCanvas }, sel, payload);

  const draw = calls.find((c) => c.op === 'drawImage');
  assert.ok(draw, '源码片段没有调用 drawImage（抽取的代码段可能已不完整）');
  assert.strictEqual(draw.sx, sel.x * dpr, '源矩形 x 没乘 dpr（只截到左上角 1/dpr 那块再拉满，内容会错位）');
  assert.strictEqual(draw.sy, sel.y * dpr, '源矩形 y 没乘 dpr');
  assert.strictEqual(draw.sw, sel.w * dpr, '源矩形宽没乘 dpr');
  assert.strictEqual(draw.sh, sel.h * dpr, '源矩形高没乘 dpr');
  // 目标矩形保持逻辑尺寸（由 octx.scale 放大）
  assert.strictEqual(draw.dw, sel.w, '目标宽应当保持逻辑尺寸（缩放交给 octx.scale）');
  assert.strictEqual(draw.dh, sel.h, '目标高应当保持逻辑尺寸');
  const sc = calls.find((c) => c.op === 'scale');
  assert.ok(sc && sc.x === dpr, 'octx.scale 没有按 dpr 缩放');
  /* 输出画布也必须是位图尺寸（逻辑 × dpr），否则高清屏导出会糊 */
  assert.strictEqual(got.out.width, sel.w * dpr, '输出画布宽没用位图尺寸');
  assert.strictEqual(got.out.height, sel.h * dpr, '输出画布高没用位图尺寸');
});

/* 【4b 已删除 —— 它是 4a 的源码断言副本，且覆盖更窄】
 *
 * 原来的 4b 做两件事：
 *   ① 正则查源码里有 sel.x * dpr（源矩形起点乘了 dpr）
 *   ② 查源码没有 drawImage(canvas, sel.x, …)（没把逻辑坐标直接当源起点）
 * 但它**完全不查 sw / sh**（源矩形的宽和高）。实测确认：
 * 把源码里 sw = sel.w * dpr 改成 sw = sel.w（非 100% 缩放下截图横向
 * 错位、内容被拉伸），4b 仍然 PASS。
 *
 * 而 4a 现在是真的把那段源码抽出来执行、断言 drawImage 收到的四个源参数
 * 全部等于「逻辑值 × dpr」—— 4b 那两条正则能覆盖的、以及覆盖不了的维度，
 * 4a 的行为断言都覆盖了，而且不会因为「等价写法 / 换行 / 改注释」误报。
 *
 * 留一份窄口径的源码断言只会制造虚假的安全感：它绿着，但真正会出错的那
 * 两个维度（sw/sh）它看不见。按 harness 头部定的规矩
 * ——「能写成行为断言的，一律写成行为断言」—— 删掉是对的。
 */

/* ==================== 5. 清目标侧同名项 ==================== */
t('5a restoreLinksIntoTarget：同名目录要能删，且清不掉要记账', () => {
  const code = stripComments(mainSrc);
  const fn = extractFn(code, 'async function restoreLinksIntoTarget(');
  /* 反面：不能再是「unlinkSync + 空 catch」 */
  assert.ok(!/catch\s*\(\s*e\s*\)\s*\{\s*\}/.test(fn),
    '仍有空 catch（清不掉同名项会被静默忽略，后面 symlink 再撞一次，报错说不清原因）');
  assert.ok(/lstatSync/.test(fn), '没有先判类型：unlinkSync 删不掉目录');
  assert.ok(/rmSync/.test(fn), '没有针对目录的删除分支');
  assert.ok(/created\.failed\.push|throw new Error/.test(fn),
    '清不掉时既没记进 failed 也没抛出 —— 上层无法说清原因');
});
t('5b 行为验证：unlinkSync 对目录确实失败（这是必须分类型删除的理由）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r14-unlink-'));
  try {
    const d = path.join(dir, 'sub');
    fs.mkdirSync(d);
    let err = null;
    try { fs.unlinkSync(d); } catch (e) { err = e; }
    assert.ok(err, 'unlinkSync 居然能删目录？本项前提不成立');
    assert.ok(/EPERM|EISDIR|EACCES/.test(err.code || ''), 'unlinkSync 删目录的错误码异常：' + err.code);
    // 而按类型分派的写法能删掉
    fs.rmSync(d, { recursive: true, force: true });
    assert.ok(!fs.existsSync(d), 'rmSync 应当能删掉目录');
  } finally { rmDir(dir); }
});

/* ==================== 6. UNC 目标与 freeBytes 未知 ==================== */
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
function loadVerifyCopyWithStub(vanishSuffix, vanishInSrc) {
  const vBlock = extractFn(mainSrc, 'async function verifyCopy(');
  const hBlock = extractFn(mainSrc, 'function hashFile(');
  const realFsp = fs.promises;
  const fspStub = {
    readdir: (...a) => realFsp.readdir(...a),
    stat: async (p) => {
      if (vanishSuffix && p.endsWith(vanishSuffix) && (!vanishInSrc || p.includes(vanishInSrc))) {
        const e = new Error('ENOENT: no such file or directory, stat ' + p);
        e.code = 'ENOENT';
        throw e;
      }
      return realFsp.stat(p);
    },
  };
  const { verifyCopy } = new Function('fs', 'fsp', 'path', 'crypto',
    hBlock + '\n' + vBlock + '\nreturn { verifyCopy };')(fs, fspStub, path, require('crypto'));
  return verifyCopy;
}

t('7a verifyCopy：源文件在复制后消失 → 不抛错，计入 skippedFiles', async () => {
  const verifyCopy = loadVerifyCopyWithStub('c.txt', 'src');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r14-vc-'));
  try {
    const src = path.join(dir, 'src'), dst = path.join(dir, 'dst');
    fs.mkdirSync(src); fs.mkdirSync(dst);
    for (const n of ['a.txt', 'b.txt', 'c.txt']) {
      fs.writeFileSync(path.join(src, n), 'x');
      fs.writeFileSync(path.join(dst, n), 'x');
    }
    const r = await verifyCopy(src, dst);
    assert.strictEqual(r.ok, true, '源里少了一个文件不该让校验失败（旧行为是抛「读取源文件失败」）');
    assert.strictEqual(r.skippedFiles, 1, '消失的文件没有被计数');
    assert.strictEqual(r.skippedDirs, 0, '没有目录消失，skippedDirs 应为 0');
    assert.strictEqual(r.files, 2, '剩余 2 个文件仍应被校验');
    assert.ok(r.skippedList.includes('c.txt'), '消失的条目名应当被记下来：' + JSON.stringify(r.skippedList));
  } finally { rmDir(dir); }
});

t('7b verifyCopy：目标侧真的缺文件时才必须失败（不能一律容忍）', async () => {
  const verifyCopy = loadVerifyCopyWithStub(null, null);   // 不制造任何"消失"
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r14-vc2-'));
  try {
    const src = path.join(dir, 'src'), dst = path.join(dir, 'dst');
    fs.mkdirSync(src); fs.mkdirSync(dst);
    fs.writeFileSync(path.join(src, 'a.txt'), 'x');
    fs.writeFileSync(path.join(src, 'b.txt'), 'x');
    fs.writeFileSync(path.join(dst, 'a.txt'), 'x');
    // b.txt 在源侧存在、目标侧缺失 —— 这是真正的不完整副本
    await assert.rejects(() => verifyCopy(src, dst), /目标缺少文件/,
      '源侧在、目标侧缺，必须仍然报校验失败（否则搬家会说成功但少了文件）');
  } finally { rmDir(dir); }
});

t('7c verifyCopy：源子目录整个消失 → 不当致命错，计入 skippedDirs', async () => {
  const vBlock = extractFn(mainSrc, 'async function verifyCopy(');
  const hBlock = extractFn(mainSrc, 'function hashFile(');
  const realFsp = fs.promises;
  const fspStub = {
    /* 让 readdir 对"已消失的子目录"抛 ENOENT，模拟目录在遍历中被删掉 */
    readdir: async (p, o) => {
      if (String(p).includes('gone')) {
        const e = new Error('ENOENT: no such file or directory, scandir ' + p);
        e.code = 'ENOENT';
        throw e;
      }
      return realFsp.readdir(p, o);
    },
    stat: (...a) => realFsp.stat(...a),
  };
  const { verifyCopy } = new Function('fs', 'fsp', 'path', 'crypto',
    hBlock + '\n' + vBlock + '\nreturn { verifyCopy };')(fs, fspStub, path, require('crypto'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r14-vc3-'));
  try {
    const src = path.join(dir, 'src'), dst = path.join(dir, 'dst');
    fs.mkdirSync(src); fs.mkdirSync(dst);
    fs.mkdirSync(path.join(src, 'keep')); fs.mkdirSync(path.join(dst, 'keep'));
    fs.writeFileSync(path.join(src, 'keep', 'a.txt'), 'x');
    fs.writeFileSync(path.join(dst, 'keep', 'a.txt'), 'x');
    // 一个子目录：源侧存在（readdir 能看到 dirent），但遍历它时已不存在
    fs.mkdirSync(path.join(src, 'gone'));
    fs.mkdirSync(path.join(dst, 'gone'));
    const r = await verifyCopy(src, dst);
    assert.strictEqual(r.ok, true, '源目录消失不该让整次校验失败（旧行为是抛「读取源目录失败」）');
    assert.ok(r.skippedDirs >= 1, '消失的目录没有被计入 skippedDirs，实际 ' + r.skippedDirs);
    assert.strictEqual(r.skippedFiles, 0, '这是目录消失，不该记成文件');
  } finally { rmDir(dir); }
});

t('7d copyTreeExcludingLinks：复制期间源文件消失 → 跳过并计数，不抛出', async () => {
  /* 抽出真实现来跑：构造源目录，然后在复制开始后删掉一个源文件。
   * 直接实现"中途删除"较难精确，改用等价场景：
   * 让 readdir 能看到文件、但 copyFile 时文件已不存在 ——
   * 用一个同名目录占位不现实，所以这里用「复制前删掉」+ 伪造 dirent
   * 的方式验证分支：直接传一个不存在的文件路径给 copyFile 触发 ENOENT。 */
  const code = stripComments(mainSrc);
  const fn = extractFn(code, 'async function copyTreeExcludingLinks(');
  /* 结构断言（剥注释后）：ENOENT 分支必须跳过并计数，EBUSY/EPERM 必须抛出 */
  assert.ok(/ENOENT/.test(fn) && /noteGone/.test(fn), '复制循环里没有 ENOENT 的容忍分支');
  assert.ok(/EBUSY|EPERM|EACCES/.test(fn), '被占用/没权限的分支不存在（真被占用必须让用户处理）');
  assert.ok(/throw/.test(fn), '被占用时没有抛出 —— 会得到一份悄悄变少的副本');
  assert.ok(/skippedFiles/.test(fn) && /skippedDirs/.test(fn),
    '文件与目录没有分开计数（文案会把目录说成「文件」）');
  /* 行为：verify 一下 stats 结构真的区分两类 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r14-cp-'));
  try {
    const src = path.join(dir, 'src'), dst = path.join(dir, 'dst');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'a.txt'), 'hello');
    /* 依赖 relKey/buildLinkKeySet，这两个也在主进程源码里 —— 一并注入 */
    const helperBlock = extractFn(code, 'function relKey(') + '\n' + extractFn(code, 'function buildLinkKeySet(');
    const realFn = new Function('fs', 'fsp', 'path',
      helperBlock + '\n' + fn + '\nreturn copyTreeExcludingLinks;')(fs, fs.promises, path);
    const stats = await realFn(src, dst, []);
    assert.strictEqual(stats.files, 1, '正常复制应计入 1 个文件');
    assert.strictEqual(stats.skippedFiles, 0, '没有消失的文件');
    assert.strictEqual(stats.skippedDirs, 0, '没有消失的目录');
    assert.strictEqual(stats.skippedDisappeared, 0, '汇总计数应为 0');
    assert.ok(fs.existsSync(path.join(dst, 'a.txt')), '文件应当被复制过去');
  } finally { rmDir(dir); }
});

t('7e copyTreeExcludingLinks：消失的目录不会在目标侧留下空目录', async () => {
  const code = stripComments(mainSrc);
  const fn = extractFn(code, 'async function copyTreeExcludingLinks(');
  /* 结构断言：判为消失的目录必须清理掉刚建的空目录（否则目标树多一个空目录，
   * 而 verifyCopy 只从源侧往目标侧对，永远发现不了它）。 */
  assert.ok(/readdir\(/.test(fn) && /rm\(/.test(fn),
    '消失目录的分支没有清理目标侧刚建出来的空目录');
});

/* ==================== 8. target-size 早退解锁 ==================== */
t('8a target-size：解锁动作收在一个函数里，早退与 finally 都调用', () => {
  const code = stripComments(read('js/tools/target-size.js'));
  const fn = extractFn(code, 'async function run(');
  assert.ok(/function unlockUi\s*\(\s*\)/.test(fn), '没有统一的解锁函数');
  assert.ok(/finally\s*\{[\s\S]*?unlockUi\s*\(\s*\)/.test(fn), 'finally 里没调用 unlockUi');
  assert.ok(/fs:mkdir[\s\S]{0,300}?unlockUi\s*\(\s*\)/.test(fn), 'fs:mkdir 失败分支没调用 unlockUi');
  assert.ok(/setLocked\s*\(false\)/.test(fn), 'unlockUi 里没解锁选择器');
});

/* ==================== 9. 测速 job id 按前缀认领 ==================== */
t('9a 测速任务按 speed 前缀认领，不能先到先得', () => {
  const code = stripComments(read('js/tools/net-tools.js'));
  /* 反面：不许再有 `if (!speedId) speedId = d.id` 这种接管任意 id 的写法 */
  assert.ok(!/if\s*\(\s*!speedId\s*\)\s*speedId\s*=\s*d\.id/.test(code),
    '仍在"先到先得"：别的任务先广播就会抢走 id，曲线画的是别人的数据');
  assert.ok(/speed/.test(code), '没有用 speed 前缀判定归属');
  assert.ok(/belongsTo|JobPrefix/.test(code), '没有走统一的 belongsTo 判定');
});
t('9b 行为验证：先到来的其它 id 不会被认领，本前缀的才认领', () => {
  const JP = require(path.join(ROOT, 'lib', 'job-id'));
  /* 复刻页面里的认领顺序：用真实的 belongsTo，验证"先到先得"与"按前缀"的区别 */
  const claimByPrefix = (incoming, current) => {
    if (current) return incoming === current ? current : null;
    return JP.belongsTo(incoming, 'speed') ? incoming : null;
  };
  const claimFirstCome = (incoming, current) => current || incoming || null;

  // 别的任务先来
  assert.strictEqual(claimByPrefix('job42', null), null, '别的任务（job42）不该被当成测速任务');
  assert.strictEqual(claimFirstCome('job42', null), 'job42', '旧写法确实会接管（证明缺陷前提成立）');
  // 本任务来了才认领
  assert.strictEqual(claimByPrefix('speed7', null), 'speed7', '本前缀的 id 应当被认领');
  // 已认领后别的 id 一律忽略
  assert.strictEqual(claimByPrefix('job9', 'speed7'), null, '认领后不该被别的 id 打断');
  assert.strictEqual(claimByPrefix('speed7', 'speed7'), 'speed7', '自己的 id 应当继续接受');
});

/* ==================== 10. 表达式求值的 ±Infinity ==================== */
t('10a 除零与溢出必须抛错，不能返回 Infinity', () => {
  const ev = require(path.join(ROOT, 'lib', 'expr-eval'));
  const evaluate = (s) => ev.evaluate(s);
  for (const s of ['1/0', '-1/0', '1e308*10', '2^1024']) {
    assert.throws(() => evaluate(s), /无法计算/,
      s + ' 应当抛错（原来会原样返回 Infinity，下游算出"∞"这种无意义结果）');
  }
  // 0/0 与取余 0 原本就抛，保持
  assert.throws(() => evaluate('0/0'), /无法计算/);
  assert.throws(() => evaluate('1%0'), /无法计算/);
  // 正常计算不受影响
  assert.strictEqual(evaluate('1/3'), 1 / 3);
  assert.strictEqual(evaluate('2+3'), 5);
  assert.strictEqual(evaluate('100-10%'), 99.9, '百分比语义不能被误伤');
  assert.strictEqual(evaluate('50%+10%'), 0.6);
});
t('10b 错误文案要说明原因（不能只说「无法计算」）', () => {
  const ev = require(path.join(ROOT, 'lib', 'expr-eval'));
  try { ev.evaluate('1/0'); assert.fail('应当抛错'); }
  catch (e) {
    assert.ok(/除数|溢出|有限/.test(e.message),
      '错误文案没说明是除零还是溢出，用户无从判断：' + e.message);
  }
});

/* ==================== 11. 摄像头清理注册位置 ==================== */
t('11a 清理回调的注册不在 rec:audio-devices 的 then 里', () => {
  const code = stripComments(readTree('js/tools/media'));
  /* 定位 invoke('rec:audio-devices') 到它配对的 .catch(() => {}) 之间的那段，
   * 断言 onCleanup 不在其中 —— 枚举失败时也要注册清理。 */
  const i = code.indexOf("invoke('rec:audio-devices')");
  assert.ok(i > 0, "找不到 invoke('rec:audio-devices')");
  /* 取这段 then 链的结束：从上往下找第一个 "}).catch(() => {});" */
  const endMark = '}).catch(() => {});';
  const end = code.indexOf(endMark, i);
  assert.ok(end > i, '找不到 rec:audio-devices 的 catch 结尾');
  const chain = code.slice(i, end);
  assert.ok(!/onCleanup/.test(chain),
    'onCleanup 仍写在 rec:audio-devices 的 then 里：枚举失败时清理不会注册，摄像头灯会一直亮');
  // 但必须仍然注册了（从全文件层面确认它没被删掉）
  const after = code.slice(end);
  assert.ok(/onCleanup[\s\S]{0,200}stopPreview/.test(after) || /onCleanup[\s\S]{0,200}stopPreview/.test(code),
    '停止预览的清理回调整体丢了');
});

t('11b 行为验证：rec:audio-devices reject 时清理回调仍被注册', async () => {
  /* 用桩模拟页面：invoke 对 rec:audio-devices 直接 reject，
   * 断言 onCleanup 仍然被调用了注册（旧写法会因为 .catch 吞掉而不执行）。 */
  const cleanups = [];
  const App = { onCleanup: (fn) => { cleanups.push(fn); } };
  let registered = false;
  const invoke = async (ch) => {
    if (ch === 'rec:audio-devices') throw new Error('ffmpeg 不可用');
    return {};
  };
  /* 旧写法（把注册放在 then 里）： */
  invoke('rec:audio-devices').then(() => { App.onCleanup(() => {}); registered = true; }).catch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(registered, false, '旧写法（then 内注册）在 reject 时确实没注册（前提成立）');
  assert.strictEqual(cleanups.length, 0, '旧写法确实一条清理都没注册');

  /* 新写法（注册在 then 之外）： */
  const cleanups2 = [];
  const App2 = { onCleanup: (fn) => cleanups2.push(fn) };
  invoke('rec:audio-devices').catch(() => {});          // 枚举自己失败，不影响下面
  App2.onCleanup(() => {});                              // 无条件注册
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(cleanups2.length, 1, '新写法应当在枚举失败时也注册清理');
});

t('11c 页面销毁后不再启动摄像头预览（避免迟到的 getUserMedia 亮灯不灭）', () => {
  const code = stripComments(readTree('js/tools/media'));
  const fn = extractFn(code, 'async function startPreview(');
  assert.ok(/destroyed/.test(fn), 'startPreview 里没有 destroyed 判断');
  const n = (fn.match(/destroyed/g) || []).length;
  assert.ok(n >= 3, 'destroyed 判断太少（至少要在入口、await 之后、拿到 stream 之后各查一次），实际 ' + n + ' 处');
  assert.ok(/getTracks\(\)[\s\S]{0,80}stop/.test(fn),
    '拿到 stream 后发现页面已销毁，必须把 track 停掉，否则摄像头一直亮着');
  assert.ok(/destroyed\s*=\s*true/.test(code), '清理回调里没有置 destroyed 标志');
});

/* ==================== 执行 ==================== */
done();
