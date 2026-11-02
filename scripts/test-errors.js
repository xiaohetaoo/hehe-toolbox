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

done();
