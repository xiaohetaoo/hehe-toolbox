'use strict';
/* PDF 增强三件套（js/tools/pdf-plus.js）：水印页码 / 提取文字 / 瘦身。
 *
 * ============ 锁的是哪次事故 / 哪个决策 ============
 * 这三个功能各有**一个不可回避的物理限制**，而限制没处理好时
 * 用户拿到的是"看起来成功、实际不对"的结果 —— 比直接报错更糟：
 *
 *   ① 水印：pdf-lib 的标准字体只支持 Latin-1，写中文会抛
 *      "WinAnsi cannot encode"。若不提前拦住，用户会得到一份
 *      中文全变成乱码/问号的 PDF。
 *   ② 提取文字：只能读 PDF 里**本来就有**的文字层。扫描件是图片，
 *      读出来是空 —— 必须明确指向 OCR，否则用户以为文件坏了。
 *   ③ 瘦身：不能重编码页面内的图片流，所以对扫描件效果有限。
 *      必须如实说明收益来源，不能让用户以为点了就能从 50MB 变 5MB。
 *
 * 本文件用**真实的 pdf-lib** 跑，因为这些限制都是库的真实行为，
 * 不能靠 mock 假装。
 */
const assert = require('assert');
const path = require('path');

const { t, done, ROOT, readSrc } = require('./lib/harness');

const PDFLibPath = path.join(ROOT, 'node_modules', 'pdf-lib');
let PDFLib = null;
try { PDFLib = require(PDFLibPath); } catch (e) { PDFLib = null; }

t('PP1 中文水印的判定与拒绝（标准字体只能 Latin-1）', () => {
  /* 锁的是：isLatin1 判据退化（比如只判 ASCII）—— 那样 "CONFIDENTIEL"
   * 这类合法西文水印会被误拒，而中文却可能漏过去。
   * 判据必须与 pdf-lib 的真实能力一致：Latin-1 覆盖 0~0xFF。 */
  const src = readSrc('js/tools/pdf-plus.js');
  /* 锁的是：中文水印检测被删 —— 用户会得到乱码 PDF。 */
  assert.ok(/function isLatin1\(/.test(src), '缺少 isLatin1');
  assert.ok(/charCodeAt\(i\) > 0xFF/.test(src),
    'isLatin1 的判据必须是 >0xFF（Latin-1 范围），不能只判 ASCII');
  /* 锁的是：检测到非 Latin-1 后没拦住（只是打个警告就继续写） */
  assert.ok(/!isLatin1\(wmText\.value\)/.test(src), '生成前必须用 isLatin1 拦住中文水印');
});

t('PP2 pdf-lib 确实会因为中文抛错（验证我们拦得对）', async () => {
  if (!PDFLib) { console.log('SKIP 未安装 pdf-lib'); return; }
  const { PDFDocument, StandardFonts } = PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const pg = doc.addPage([200, 200]);
  /* 锁的是：我们对"中文会失败"这个前提判断错了 —— 如果 pdf-lib 其实
   * 能写中文，那前面那个拦截就是无谓的限制。 */
  let threw = false;
  try {
    pg.drawText('机密', { x: 10, y: 10, size: 20, font });
    await doc.save();
  } catch (e) { threw = true; }
  assert.strictEqual(threw, true, 'pdf-lib 写中文应当抛错（我们的拦截基于此）');
});

t('PP3 水印与页码写进 PDF 后可被读回（页数不变、体积增加）', async () => {
  if (!PDFLib) { console.log('SKIP 未安装 pdf-lib'); return; }
  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;

  /* 造一份 3 页 PDF */
  const mk = async () => {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 3; i++) {
      const p = d.addPage([595, 842]);
      p.drawText('page ' + (i + 1), { x: 60, y: 760, size: 24, font: f, color: rgb(0, 0, 0) });
    }
    return await d.save();
  };

  const before = await mk();
  const doc = await PDFDocument.load(before, { ignoreEncryption: true });
  const pages = doc.getPages();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    const { width, height } = pg.getSize();
    pg.drawText('DRAFT', {
      x: width / 2 - 60, y: height / 2, size: 48, font,
      color: rgb(1, 0, 0), opacity: 0.15, rotate: degrees(45),
    });
    const label = (i + 1) + ' / ' + pages.length;
    const nw = font.widthOfTextAtSize(label, 10);
    pg.drawText(label, { x: (width - nw) / 2, y: 24, size: 10, font, color: rgb(0.35, 0.35, 0.35) });
  }
  const after = await doc.save();

  /* 锁的是：写水印时意外改动了页数（copyPages/addPage 用错会加页）。 */
  const back = await PDFDocument.load(after);
  assert.strictEqual(back.getPageCount(), 3, '页数应保持 3，实际 ' + back.getPageCount());
  /* 锁的是：drawText 根本没写进去（体积完全没变）。 */
  assert.ok(after.length > before.length,
    '加了水印后体积应变大（' + before.length + ' -> ' + after.length + '）');
});

t('PP4 瘦身真的变小，且页数与可读性不变', async () => {
  if (!PDFLib) { console.log('SKIP 未安装 pdf-lib'); return; }
  const { PDFDocument, StandardFonts, rgb } = PDFLib;

  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const p = d.addPage([595, 842]);
    p.drawText('page ' + (i + 1), { x: 60, y: 760, size: 24, font: f, color: rgb(0, 0, 0) });
  }
  /* 灌一堆元数据，给瘦身有东西可删 */
  d.setTitle('A deliberately long title used to inflate metadata for the slimmer test');
  d.setProducer('TestProducer with a deliberately long name so there is something to strip');
  d.setKeywords(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
  const before = await d.save();

  const doc = await PDFDocument.load(before, { ignoreEncryption: true, updateMetadata: false });
  try {
    doc.setTitle(''); doc.setAuthor(''); doc.setSubject('');
    doc.setKeywords([]); doc.setProducer(''); doc.setCreator('');
  } catch (e) { /* 老版本 pdf-lib 可能没有某些 setter */ }
  const after = await doc.save({ useObjectStreams: true, addDefaultPage: false });

  const back = await PDFDocument.load(after);
  /* 锁的是：瘦身把页弄丢了（save 参数用错会掉页）。 */
  assert.strictEqual(back.getPageCount(), 3, '瘦身后页数应仍是 3');
  /* 锁的是：瘦身实际没减小（元数据没清掉、或 useObjectStreams 没生效）。 */
  assert.ok(after.length < before.length,
    '瘦身后应更小（' + before.length + ' -> ' + after.length + '）');
  /* 锁的是：元数据没被清 —— 那是瘦身的主要收益来源之一。 */
  assert.strictEqual(back.getTitle() || '', '', '标题应已被清空，实际 "' + (back.getTitle() || '') + '"');
});

t('PP5 三个工具都注册了且都有 render', () => {
  const src = readSrc('js/tools/pdf-plus.js');
  for (const id of ['pdf-watermark', 'pdf-extract-text', 'pdf-slim']) {
    /* 锁的是：某个工具被漏注册（用户看不到入口，或点了空白页）。 */
    assert.ok(src.indexOf("id: '" + id + "'") >= 0, '缺少工具 ' + id);
  }
  const renders = (src.match(/render\(page\)/g) || []).length;
  assert.ok(renders >= 3, '三个工具都应有 render，实际 ' + renders + ' 个');
});

t('PP6 扫描件（无文字层）必须给出 OCR 指引', () => {
  const src = readSrc('js/tools/pdf-plus.js');
  /* 锁的是：空结果只是静默显示 —— 用户以为 PDF 坏了，
   * 而真正该做的是用 OCR。这条指引是这个功能的关键一环。 */
  assert.ok(/没有文字层|是扫描件/.test(src), '缺少扫描件提示文案');
  assert.ok(/batch-ocr|screenshot-ocr/.test(src), '应引导到 OCR 工具');
  /* 锁的是：弹窗里说"去 OCR"但按钮不跳转（说了等于没说）。 */
  assert.ok(/openTool\('batch-ocr'\)|openTool\(OCR_TOOL\)/.test(src), '缺少跳转 OCR 的按钮');
});

t('PP7 页码「跳过前几页」的语义是排版惯例（跳过页不计数）', () => {
  const src = readSrc('js/tools/pdf-plus.js');
  /* 锁的是：页码按物理页算（跳 2 页后第 3 页显示 3）——
   * 那与界面提示「封面/目录通常不计页码」矛盾：书籍排版的预期是
   * 正文第 1 页显示「1」。修复于审查轮（自审抓到）。
   * 判据：页码计算必须是 i + 1 - skip，且 n-of-total 的分母要扣除 skip。 */
  assert.ok(/const n = i \+ 1 - skip;/.test(src),
    '页码应扣除跳过的页数（i + 1 - skip），不是 i + 1');
  assert.ok(/total - skip/.test(src),
    'n-of-total 的分母应扣除跳过页数（否则 1/300 出现在 298 页正文的书里）');
  /* 锁的是：skip 后页码变成 0 或负数 —— skip ≥ total 时没有正文页可标。 */
  assert.ok(/Math\.max\(1, total - skip\)/.test(src), '分母必须夹到至少 1');
});

t('PP8 平铺水印的循环必须覆盖整页（含旋转出界）', () => {
  const src = readSrc('js/tools/pdf-plus.js');
  /* 锁的是：平铺范围写成 0..width/0..height —— 旋转后的文字
   * 基线原点在页外，页面边缘会出现没画到的三角区。
   * 正确范围是 -size..2*size（三倍覆盖）。 */
  const i = src.indexOf("wmMode.value === 'tile'");
  const seg = src.slice(i, i + 900);
  assert.ok(/y = -height/.test(seg) && /x = -width/.test(seg),
    '平铺起点应从负半页开始（覆盖旋转出界）');
  assert.ok(/y < height \* 2/.test(seg) && /x < width \* 2/.test(seg),
    '平铺终点应到两倍页宽（覆盖旋转出界）');
});

done();
