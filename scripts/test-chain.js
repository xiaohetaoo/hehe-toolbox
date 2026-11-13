'use strict';
/* 工具链（js/tools/chain.js）的执行引擎契约。
 *
 * ============ 设计说明 ============
 * 工具链是新功能，它锁的是**几件一旦做错就会静默产生错误结果的事**：
 * 操作通道的调用签名（传错了也不报错，只是结果错位）、
 * 图片压缩的正确落地点（误用音视频通道会"假成功"）、
 * 失败策略（单文件坏不该丢整批）。
 *
 * 【为什么不能只用行为断言】真正跑一遍要渲染层 canvas + IPC + 磁盘，
 * Node 侧构造不出来。那部分由 CDP 真机走查覆盖（7 项全过：
 * 3 张 PNG 压缩成 -min.png 落盘、逐文件报告、0 异常）。
 *
 * 每条源码匹配断言上方都写明「锁的是」——那是 SA-4 的硬要求，
 * 也是给下一个改这里的人看的：先说清锁的是什么，再说怎么锁。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, ROOT } = require('./lib/harness');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

t('CH1 六个操作都在，且都有 run 函数', () => {
  const s = read('js/tools/chain.js');
  /* 锁的是：操作清单完整。少一个意味着那条流水线凭空消失，
   * 而用户存的链里还留着那个 id —— 执行时会静默跳过这一步。 */
  for (const id of ['compress-image', 'zip', 'unzip', 'hash', 'rename-seq', 'to-pdf']) {
    assert.ok(s.indexOf("id: '" + id + "'") !== -1, '缺少操作 ' + id);
  }
  /* 锁的是：每个操作都有可执行的 run。只有元数据没有 run 的操作
   * 加进链里会在执行到它时抛「not a function」，而那已经是第三步了。 */
  const runs = (s.match(/async run\(ctx\)/g) || []).length;
  assert.ok(runs >= 6, '每个操作都要有 run，实际 ' + runs + ' 个');
});

t('CH2 zip:compress 用位置参数 (paths, outZip)', () => {
  const s = read('js/tools/chain.js');
  /* 锁的是：zip:compress 的调用签名。主进程是
   * handle(…, async (e, paths, outZip) => …) 两个位置参数；
   * 传成对象会让 paths 变成一个对象，AdmZip 把错的路径收进去 ——
   * 而且**不报错**，用户拿到一个内容不对的 zip。 */
  /* 锁的是：先取出这段调用原文再逐项判 —— 直接对全文判会被
   * 注释里的示例文字误命中（注释里也写了 ZIP.COMPRESS 三个字）。 */
  const m = s.match(/ZIP\.COMPRESS[\s\S]{0,120}/);
  assert.ok(m, '应调用 ZIP.COMPRESS');
  /* 锁的是：第一参数不能是对象字面量（会被当成 paths）。 */
  assert.ok(!/ZIP\.COMPRESS,\s*\{/.test(m[0]), 'zip:compress 第一个参数不能是对象');
  /* 锁的是：按位置顺序传 ctx.files 与输出路径。 */
  assert.ok(/ZIP\.COMPRESS,\s*ctx\.files\s*,/.test(m[0]), 'zip:compress 应传 (ctx.files, outZip)');
});

t('CH3 zip:extract 用位置参数 (zipPath, outDir)', () => {
  const s = read('js/tools/chain.js');
  /* 锁的是：zip:extract 同样两个位置参数。传对象会让 AdmZip(path)
   * 收到 [object Object]，直接抛「找不到文件」—— 表现是解压全失败。 */
  const m = s.match(/ZIP\.EXTRACT[\s\S]{0,100}/);
  assert.ok(m, '应调用 ZIP.EXTRACT');
  /* 锁的是：第一参数不能是对象（否则路径变成 [object Object]）。 */
  assert.ok(!/ZIP\.EXTRACT,\s*\{/.test(m[0]), 'zip:extract 第一个参数不能是对象');
});

t('CH4 图片压缩走 canvas + write-file-b64，不用 ffmpeg', () => {
  const s = read('js/tools/chain.js');
  /* 锁的是：图片压缩的正确落地点。ffmpeg:convert 的 extMap 全是
   * mp4/webm/mp3，opts 里没有 image 概念 —— 传进去会得到一段
   * 「转换成功但文件还是原样」的假成功。img-compress 工具本身也是 canvas 编码。 */
  /* 锁的是：必须用 canvas.toDataURL(mime, q) 做有损编码。 */
  assert.ok(/toDataURL\(mime/.test(s), '需用 canvas.toDataURL(mime, q) 编码');
  /* 锁的是：编码结果必须经 fs:write-file-b64 落盘（渲染层没有直接写文件的能力）。 */
  assert.ok(/WRITE_FILE_B64/.test(s), '需用 fs:write-file-b64 写盘');
  /* 锁的是：不能误用音视频通道做图片压缩（那是"假成功"的来源）。 */
  assert.ok(!/FFMPEG\.CONVERT/.test(s), '不应误用 ffmpeg:convert 做图片压缩');
});

t('CH5 单文件失败不中断整批', () => {
  const s = read('js/tools/chain.js');
  /* 锁的是：失败策略。用户一次拖 50 张，第 3 张坏了就丢掉其余 47 张
   * 好的，这不合理 —— 所以按文件记失败、其余继续跑。 */
  assert.ok(/s\.failed\s*=/.test(s), '需有逐文件 failed 标记');
  /* 锁的是：每一轮只把还活着的文件投给下一步（否则失败文件会被反复重试）。 */
  assert.ok(/filter\(\(s\)\s*=>\s*!s\.failed\)/.test(s), '每步只投还活着的文件');
});

t('CH6 第一步就失败时抛出', () => {
  const s = read('js/tools/chain.js');
  /* 锁的是：与「单文件失败」相反的另一半策略。第一步对全部文件都失败
   * 通常是参数错或环境缺失（比如 ffmpeg 没装），继续跑只会产生 N 条
   * 一样的错误 —— 立刻抛出让人一眼看到根因。 */
  assert.ok(/if \(si === 0\) throw e/.test(s), '第一步失败应直接抛出');
});

t('CH7 工具链存 store，不另建持久化', () => {
  const s = read('js/tools/chain.js');
  /* 锁的是：复用 settings.chains。另建一套文件持久化会绕开 store 的
   * 容量上限与损坏容错（那套逻辑在 lib/prefs-spec.js 里统一管着）。 */
  assert.ok(/STORE\.GET/.test(s) && /STORE\.SET/.test(s), '需走 store:get / store:set');
  /* 锁的是：键名。改成别的名字会让用户已存的链"消失"（读不到旧键）。 */
  assert.ok(/settings\.chains/.test(s), '键名应为 settings.chains');
});

t('CH8 哈希用单文件通道逐个调', () => {
  const s = read('js/tools/chain.js');
  /* 锁的是：fs:hash-file-multi 的签名是 (path, algos)——单文件版，
   * 不是一批。传数组进去会让 hashFileMulti 拿数组当路径，全部失败。 */
  const m = s.match(/HASH_FILE_MULTI[\s\S]{0,120}/);
  assert.ok(m, '应调用 HASH_FILE_MULTI');
  /* 锁的是：不能把整个文件列表当第一参数传进去。 */
  assert.ok(!/HASH_FILE_MULTI,\s*ctx\.files/.test(m[0]), '不能把整个 ctx.files 当第一参数');
  /* 锁的是：必须逐个文件调（上面那条的正面写法）。 */
  assert.ok(/for \(const p of ctx\.files\)/.test(s), '应逐个文件调用');
});

t('CH9 报告逐文件给成功/失败两条路径', () => {
  const s = read('js/tools/chain.js');
  /* 锁的是：报告形态。用户关心"我这个文件成了没成"，不是"第 2 步成功"。
   * 只有步骤级汇总的话，失败时用户不知道是哪个文件。 */
  assert.ok(/chain-report-row/.test(s), '需逐文件报告行');
  /* 锁的是：失败要有独立样式 —— 与成功混在一起时看不出哪些出了问题。 */
  assert.ok(/chain-report-err/.test(s), '失败要有独立样式');
  /* 锁的是：成功也要有独立样式（成功行的内容是最终路径，要能读清）。 */
  assert.ok(/chain-report-ok/.test(s), '成功要有独立样式');
});

t('CH10 index.html 引入 chain.js', () => {
  const html = read('index.html');
  /* 锁的是：脚本真的被加载。漏了就是"工具注册了但页面空白"。 */
  assert.ok(html.indexOf('js/tools/chain.js') > 0, 'index.html 需引入 js/tools/chain.js');
  /* 锁的是：加载顺序在 ui.js 之后（它解构 window.ui 与 window.Channels，
   * 提前加载会拿到 undefined 并在注册时就抛错）。 */
  assert.ok(html.indexOf('js/ui.js') < html.indexOf('js/tools/chain.js'), 'chain.js 应在 ui.js 之后');
});

done();
