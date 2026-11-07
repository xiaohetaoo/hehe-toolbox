'use strict';
/* lib/errors.js 的行为测试。
 *
 * ============ 为什么这个模块值得单独测 ============
 * 它被 main.js 的 IPC 统一包装层调用（`handle()` 的 catch 分支），
 * 也就是说**每一个**失败通道的错误码与建议都从这里出。它是纯函数，
 * 反而不该只是"常量表"——`classify` 有 9 个分支的正则判据，
 * `toPayload` 决定渲染层能不能拿到可操作的建议，`format` 决定用户看到什么。
 *
 * 这一层以前被 test-test-map 列在白名单里（理由写的是"纯常量表"），
 * 那个判断是错的：它有 4 个导出函数、9 条分类规则。白名单撤掉了。
 *
 * ============ 这一组锁的是什么 ============
 * 1) classify 必须按 **errno/code** 判断，不能靠中文文案匹配 ——
 *    文案会变、会翻译，errno 不会。反过来"只认 errno"也不行：
 *    Node 里很多错误（例如自造的 `new Error('未找到 ffmpeg')`）没有 errno。
 *    所以两条路都要走通。
 * 2) 分类顺序是有意为之的（ENOSPC 先于 EPERM 等），调换会让某些错误码漂移。
 * 3) toPayload 的 detail 必须**截断**（只取 stack 前 6 行）——
 *    它会被回传到渲染层，完整堆栈既没用又可能带路径/密码。
 * 4) format 在没有 message 时不能输出 "undefined"。
 */
const assert = require('assert');

const { t, done } = require('./lib/harness');
const E = require('../lib/errors');

t('classify 按 errno 判盘满，不依赖中文文案', () => {
  assert.strictEqual(E.classify(Object.assign(new Error('whatever'), { code: 'ENOSPC' })).code, 'DISK_FULL');
  /* 没有 errno、只有英文文案时也要认出来（有些底层库不挂 code） */
  assert.strictEqual(E.classify(new Error('ENOSPC: no space left on device')).code, 'DISK_FULL');
  /* 纯中文文案同样要认（本项目大量自造错误是中文） */
  assert.strictEqual(E.classify(new Error('no space left on device')).code, 'DISK_FULL');
});

t('classify 把 EACCES / EPERM 都归到 PERMISSION', () => {
  assert.strictEqual(E.classify(Object.assign(new Error('x'), { code: 'EACCES' })).code, 'PERMISSION');
  assert.strictEqual(E.classify(Object.assign(new Error('x'), { code: 'EPERM' })).code, 'PERMISSION');
  assert.strictEqual(E.classify(new Error('permission denied')).code, 'PERMISSION');
  assert.strictEqual(E.classify(new Error('拒绝访问')).code, 'PERMISSION');
});

t('classify 把 EBUSY 归到 FILE_LOCKED（不是 PERMISSION）', () => {
  /* 【这一条锁的是分类顺序】EBUSY 的文案里常常同时出现 "denied"，
   * 如果把 PERMISSION 的判据放在 FILE_LOCKED 前面，占用会被误报成权限问题，
   * 用户会被引导去"以管理员身份运行"——而真正该做的是关掉占用程序。 */
  assert.strictEqual(E.classify(Object.assign(new Error('resource busy'), { code: 'EBUSY' })).code, 'FILE_LOCKED');
  assert.strictEqual(E.classify(new Error('being used by another process')).code, 'FILE_LOCKED');
  assert.strictEqual(E.classify(new Error('正被占用')).code, 'FILE_LOCKED');
});

t('classify 把 ENOENT 归到 NOT_FOUND', () => {
  assert.strictEqual(E.classify(Object.assign(new Error('x'), { code: 'ENOENT' })).code, 'NOT_FOUND');
  assert.strictEqual(E.classify(new Error('no such file or directory')).code, 'NOT_FOUND');
  assert.strictEqual(E.classify(new Error('找不到该文件')).code, 'NOT_FOUND');
});

t('classify 认得「引擎缺失」与「目标体积过小」这两类业务错误', () => {
  /* 这两类没有 errno，是本项目自造的中文错误，只能靠文案。
   * 它们是**可操作**的（去装引擎 / 换更大的目标），
   * 归到 UNKNOWN 的话用户拿到的建议是"可展开技术详情"，等于没建议。 */
  assert.strictEqual(E.classify(new Error('未找到 ffmpeg，请先安装')).code, 'ENGINE_MISSING');
  assert.strictEqual(E.classify(new Error('未找到 ffprobe')).code, 'ENGINE_MISSING');
  assert.strictEqual(E.classify(new Error('未找到 7z')).code, 'ENGINE_MISSING');
  assert.strictEqual(E.classify(new Error('目标体积过小，无法压到目标')).code, 'TOO_LARGE');
  assert.strictEqual(E.classify(new Error('码率仅剩 3kbps')).code, 'TOO_LARGE');
});

t('classify 对认不出的错误返回 UNKNOWN，绝不抛异常', () => {
  for (const input of [null, undefined, '', 'string', 0, {}, [], new Error('完全无法识别的失败')]) {
    const r = E.classify(input);
    assert.ok(r && typeof r.code === 'string', 'classify(' + JSON.stringify(input) + ') 返回了非对象');
  }
  assert.strictEqual(E.classify(new Error('完全无法识别的失败')).code, 'UNKNOWN');
  assert.strictEqual(E.classify(null).code, 'UNKNOWN');
});

t('每个错误码都带可操作的建议（不是空串、不是占位符）', () => {
  /* 建议是这整个模块存在的理由。空建议等于退回成原来的 `toast(原文)`。 */
  const keys = Object.keys(E.CODES);
  assert.ok(keys.length >= 9, '错误码只有 ' + keys.length + ' 个，少于预期的 9 个');
  for (const k of keys) {
    const c = E.CODES[k];
    assert.strictEqual(c.code, k, k + ' 的 code 字段与键不一致');
    assert.ok(typeof c.advice === 'string' && c.advice.length >= 6,
      k + ' 的建议太短或为空：' + JSON.stringify(c.advice));
  }
});

t('toPayload 保留原始 message，并附上 code 与 advice', () => {
  const err = Object.assign(new Error('磁盘已满'), { code: 'ENOSPC' });
  const p = E.toPayload(err);
  assert.strictEqual(p.code, 'DISK_FULL');
  assert.strictEqual(p.message, '磁盘已满');
  assert.ok(p.advice && p.advice === E.CODES.DISK_FULL.advice, 'advice 不是该错误码对应的建议');
});

t('toPayload 的 detail 只取堆栈前 6 行（防止完整堆栈回传渲染层）', () => {
  /* 【为什么必须截断】main.js 的 handle() 把 toPayload 的结果分发给渲染层。
   * 完整堆栈里有绝对路径、有时还有命令行参数（本项目处理过密码泄漏问题）。
   * 6 行足够定位调用点，再多就是噪音与风险。 */
  const err = new Error('boom');
  /* 造一个长堆栈 */
  let fn = () => { throw err; };
  for (let i = 0; i < 10; i++) { const prev = fn; fn = () => prev(); }
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught && caught.stack, '没能造出带堆栈的错误');

  const p = E.toPayload(caught);
  const lines = String(p.detail).split('\n');
  assert.ok(lines.length <= 6, 'detail 有 ' + lines.length + ' 行，超过了 6 行的上限');
  assert.ok(lines.length >= 1, 'detail 是空的');
});

t('toPayload 在没有 stack 时退回 message（不能让 detail 变 undefined）', () => {
  const p = E.toPayload(new Error('没有堆栈的错误'));
  assert.ok(typeof p.detail === 'string' && p.detail.length > 0, 'detail 不是非空字符串：' + JSON.stringify(p.detail));
  const p2 = E.toPayload('纯字符串错误');
  assert.strictEqual(p2.message, '纯字符串错误');
  assert.ok(typeof p2.detail === 'string' && p2.detail.length > 0);
});

t('toPayload 的 extra 会合并进载荷，且不能覆盖 code', () => {
  const err = Object.assign(new Error('x'), { code: 'ENOENT' });
  const p = E.toPayload(err, { stage: 'copy', file: 'a.txt' });
  assert.strictEqual(p.stage, 'copy');
  assert.strictEqual(p.file, 'a.txt');
  assert.strictEqual(p.code, 'NOT_FOUND');
  /* extra 里带了 code 时会覆盖 —— 这是 Object.assign 的语义，属于"调用方显式指定"。
   * 这里锁的是"确实被覆盖"，以免哪天有人改成先 spread extra 再写 code，
   * 让调用方无法覆盖分类结果。 */
  const p2 = E.toPayload(err, { code: 'CUSTOM' });
  assert.strictEqual(p2.code, 'CUSTOM');
});

t('format 输出「说明 + 建议」两段，且对空载荷有兜底', () => {
  const p = E.toPayload(Object.assign(new Error('磁盘已满'), { code: 'ENOSPC' }));
  const s = E.format(p);
  assert.ok(s.includes('磁盘已满'), 'format 没有输出原始说明：' + JSON.stringify(s));
  assert.ok(s.includes('建议：'), 'format 没有输出建议段：' + JSON.stringify(s));

  /* 空 / 残缺载荷不能渲染出 undefined */
  for (const input of [null, undefined, {}, { message: '' }]) {
    const out = E.format(input);
    assert.ok(typeof out === 'string' && out.length > 0, 'format(' + JSON.stringify(input) + ') 输出了空串');
    assert.ok(!/undefined/.test(out), 'format(' + JSON.stringify(input) + ') 里出现了 undefined：' + JSON.stringify(out));
  }
});

/* ==================== err 自带 code / advice 的透传 ====================
 * 锁的是 2026-11-06 复核出的真实退化：
 *   实测 toPayload(pathGuard.err('CRITICAL','这是系统关键目录','请换一个目标路径'))
 *   返回 { code:'UNKNOWN', advice:'可展开技术详情用于排查' }。
 * 也就是说 lib/path-guard.js 与 lib/archive-guard.js 精心给 Error 挂上的
 * 明确码与可操作建议，到了渲染层全被 classify() 抹平：
 *   · js/api.js 里 `if (r && r.code) err.code = r.code` 拿到的恒为 UNKNOWN，
 *     按码分支的逻辑全部失效；
 *   · 用户看不到「请换一个目标路径」，只看到一句通用的排查提示。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { readMain } = require('./lib/harness');

t('toPayload 透传 pathGuard/archiveGuard 自带的 code 与 advice', () => {
  const pg = require(path.join(ROOT, 'lib', 'path-guard'));
  const ag = require(path.join(ROOT, 'lib', 'archive-guard'));

  const a = E.toPayload(pg.err('CRITICAL', '这是系统关键目录', '请换一个目标路径'));
  /* 锁的是：自定义码被 classify 抹成 UNKNOWN。 */
  assert.strictEqual(a.code, 'CRITICAL', 'pathGuard 的 code 丢了：' + a.code);
  /* 锁的是：可操作建议被替换成通用文案。 */
  assert.strictEqual(a.advice, '请换一个目标路径', 'pathGuard 的 advice 丢了：' + a.advice);

  const b = E.toPayload(ag.err('ADS', '文件名含盘符数据流', '去掉冒号'));
  /* 锁的是：第二个守卫模块也走同一条退化路径。 */
  assert.strictEqual(b.code, 'ADS', 'archiveGuard 的 code 丢了：' + b.code);
  assert.strictEqual(b.advice, '去掉冒号', 'archiveGuard 的 advice 丢了：' + b.advice);
});

t('toPayload 透传自定义 code（OCR_TIMEOUT / CAP_DENIED）', () => {
  const ocr = Object.assign(new Error('OCR 超时'), { code: 'OCR_TIMEOUT', advice: '换小一点的图' });
  const p1 = E.toPayload(ocr);
  /* 锁的是：lib/ocr-guard.js 挂的 OCR_TIMEOUT 到界面退化成 UNKNOWN，
   * 调用方无法据此提示「换小图」或「检查语言包」。 */
  assert.strictEqual(p1.code, 'OCR_TIMEOUT', 'OCR_TIMEOUT 丢了：' + p1.code);
  assert.strictEqual(p1.advice, '换小一点的图');

  const cap = Object.assign(new Error('未开启'), { code: 'CAP_DENIED' });
  const p2 = E.toPayload(cap);
  /* 锁的是：门禁拒绝的码传不出来，前端做不了「引导去设置页」的分支。 */
  assert.strictEqual(p2.code, 'CAP_DENIED', 'CAP_DENIED 丢了：' + p2.code);
});

t('toPayload 只在 classify 判不出时透传（认得出来的 errno 不被覆盖）', () => {
  /* 锁的是：透传改得过头 —— 一个带了无关 code 的 EACCES 被自己的 code 顶掉，
   * 反而丢了准确的权限分类与对应的中文建议。 */
  const e = Object.assign(new Error('permission denied'), { code: 'SOME_RANDOM_CODE' });
  const p = E.toPayload(e);
  assert.strictEqual(p.code, E.CODES.PERMISSION.code,
    'EACCES 应仍归为 PERMISSION，实际：' + p.code);
});

t('extra 仍然拥有最后覆盖权（别把既有行为改坏）', () => {
  /* 锁的是：把 Object.assign 的顺序改反 —— extra 是调用方显式指定的，
   * 必须能覆盖 code/advice（既有 test-errors 里 CUSTOM 那条锁着同一件事）。 */
  const p = E.toPayload(Object.assign(new Error('a'), { code: 'X' }), { code: 'OVERRIDE' });
  assert.strictEqual(p.code, 'OVERRIDE', 'extra 没能覆盖 code：' + p.code);
  const q = E.toPayload(Object.assign(new Error('a'), { advice: '原建议' }), { advice: '新建议' });
  assert.strictEqual(q.advice, '新建议', 'extra 没能覆盖 advice：' + q.advice);
});

t('门禁拒绝分支带 code / advice（与正常错误分支形状一致）', () => {
  /* 锁的是：main.js 的 handle 包装里，门禁拒绝只返回 { ok:false, error }，
   * 而 catch 分支返回 { ok:false, error, code, advice }。
   * 形状不一致导致 js/api.js 的两行赋值落空（e.code 恒 undefined）。
   * 【为什么用源码断言】这段在主进程的 ipcMain.handle 包装里，
   * 要跑起来得连整套 Electron + 真实门禁开关，单测环境只能读结构。 */
  const src = readMain({ raw: true });
  const i = src.indexOf('const cap = CAP_GATED_CHANNELS[ch];');
  assert.ok(i > 0, '找不到门禁判定行');
  const seg = src.slice(i, i + 900);
  /* 锁的是：拒绝分支只给 error，不给 code。 */
  assert.ok(/code:\s*'CAP_DENIED'/.test(seg),
    '门禁拒绝分支没有带 code: CAP_DENIED');
  /* 锁的是：给了码却still没有可操作建议 —— 用户不知道怎么开。 */
  assert.ok(/advice:\s*dangerousDeniedAdvice\(cap\)/.test(seg),
    '门禁拒绝分支没有带 advice');
});

t('门禁拒绝的建议文案是中英双语，且指向设置路径', () => {
  /* 锁的是：只加了 advice 但写死中文 —— 英文界面下变成中英混排
   * （与 GATE_TEXT 上面那段注释描述的是同一个问题）。 */
  const src = readMain({ raw: true });
  const i = src.indexOf('const GATE_ADVICE = {');
  assert.ok(i > 0, '找不到 GATE_ADVICE');
  const seg = src.slice(i, i + 600);
  /* 锁的是：只加了 advice 但只写中文 —— 英文界面下又是中英混排。 */
  assert.ok(/zh:\s*\(name\)/.test(seg) && /en:\s*\(name\)/.test(seg),
    'GATE_ADVICE 不是双语');
  /* 文案要能照着做，必须点出设置页路径 */
  /* 锁的是：建议写成「去设置里打开」却不说哪个分区 —— 用户找不到。 */
  assert.ok(/设置\s*→\s*高危功能/.test(seg), '中文建议没有指向「设置 → 高危功能」');
  /* 锁的是：英文侧漏掉了同样的路径指引。 */
  assert.ok(/Settings\s*→\s*High-risk features/.test(seg), '英文建议没有指向设置路径');
});

done();
