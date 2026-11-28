'use strict';
/* 第 28 轮回归：页面保活后的长任务状态、异步换文件竞态。
 *
 * 这几条都不是"跑一次看起来正常"就能发现的：必须先离开/换文件，
 * 再让旧的 await 晚到，才会看到按钮永久灰、旧文档/旧压缩包覆盖新内容。
 * 这里锁住序号与"提交前再判一次"的接线，避免以后又退回无条件写状态。
 */
const assert = require('assert');
const { t, readSrc } = require('./lib/harness');

t('R28-01 磁盘分析页离开/返回后不会把扫描按钮永久锁死', () => {
  const src = readSrc('js/tools/sys-tools.js');
  const start = src.indexOf("id: 'disk-analyze'");
  const next = src.indexOf("id: 'junk-clean'", start);
  const seg = src.slice(start, next === -1 ? src.length : next);
  /* 锁的是：页面被保活复用，旧扫描 finally 若无条件复位会盖掉新状态；
   * cleanup 只递增序号不管按钮，回来就会看到一个永远灰着的入口。 */
  assert.ok(/window\.App\.onCleanup\(\(\) => \{[\s\S]{0,260}diskScanSeq\+\+/.test(seg), 'cleanup 没有作废当前扫描');
  assert.ok(/window\.App\.onEnter\(\(\) => \{[\s\S]{0,320}scanBtn\.disabled = true/.test(seg), '返回时旧扫描未结束却把按钮放开');
  /* 锁的是：旧扫描的 job:progress 不带 token，必须靠本页序号丢弃。 */
  assert.ok(/if \(runToken !== diskScanSeq\) return;/.test(seg), '进度监听没有按本轮序号过滤');
  /* 锁的是：旧 finally 不恢复按钮，主进程扫描结束后入口就永久不可用。 */
  assert.ok(/finally \{[\s\S]{0,400}busy = false;[\s\S]{0,200}scanBtn\.disabled = false;/.test(seg), 'finally 没有恢复按钮/闸门');
  /* 锁的是：连点会并发两趟 SCAN_TREE，状态行被两套进度互相覆盖。 */
  assert.ok(/if \(busy\) return toast\('正在分析，请稍候'/.test(seg), '重复点击没有明确拦截');
});

t('R28-02 PDF 页面管理：换文件时旧读取晚到不能覆盖新文档', () => {
  const src = readSrc('js/tools/pdf-pages.js');
  /* 锁的是：文件选择器可连续换文件，READ_FILE_B64 / PDFDocument.load
   * 是两个 await；没有 loadSeq 时 A 的结果会覆盖 B 的界面。 */
  assert.ok(/let loadSeq = 0;/.test(src), '没有为选文件加载建立序号');
  assert.ok(/onChange: async \(items\)[\s\S]{0,260}doc = null; srcB64 = null;/.test(src), '换文件时没有先清掉旧文档');
  /* 锁的是：两次 await 之间不判序号，晚到的 A 仍会提交。 */
  assert.ok(/const myLoad = \+\+loadSeq;/.test(src), 'loadDoc 没有领本轮序号');
  assert.ok(/if \(myLoad !== loadSeq\) return;/.test(src) && (src.match(/if \(myLoad !== loadSeq\) return;/g) || []).length >= 3,
    'loadDoc 的两个 await 之后没有分别丢弃过期结果');
  /* 锁的是：取消选择后旧读取仍会把文档塞回来。 */
  assert.ok(/function reset\(\) \{[\s\S]{0,80}loadSeq\+\+;/.test(src), 'reset 没有作废在飞读取');
});

t('R28-03 压缩包预览：换包后旧 LIST 结果不能覆盖新包', () => {
  const src = readSrc('js/tools/file-tools.js', { raw: true });
  const start = src.indexOf('/* 预览：不解压直接列出内容 */');
  const end = src.indexOf("id: 'global-search'", start);
  const seg = src.slice(start, end === -1 ? src.length : end);
  /* 锁的是：7z l 读大包可能几秒；没有序号时旧结果会写进新包的预览框。 */
  assert.ok(/let pvSeq = 0;/.test(seg), '预览没有轮次序号');
  assert.ok(/pvSeq\+\+;/.test(seg) && /listArchive\(pvSeq\)/.test(seg), '换包没有作废旧读取');
  /* 锁的是：只看 pvPath.p 不够 —— 两个包路径不同才安全，旧结果必须整段丢。 */
  assert.ok(/if \(mySeq !== pvSeq \|\| pvPath\.p !== archive\) return;/.test(seg), 'LIST 返回后没有丢弃过期结果');
  /* 锁的是：按钮回调会传 MouseEvent，不能把它当序号；否则点击永远不显示。 */
  assert.ok(/const mySeq = typeof seqToken === 'number' \? seqToken : \+\+pvSeq;/.test(seg), '按钮点击传入的事件对象被误当成序号');
});

t('R28-04 文档预览：转换期间换文件不能把新文件塞进旧流程', () => {
  const src = readSrc('js/tools/office.js');
  /* 锁的是：Office 转换有多个 await，后续若继续读可变的 filePath，
   * 用户在转换期间换文件，旧请求会去转换新文件（结果与预览框错位）。 */
  assert.ok(/const target = filePath;/.test(src), 'previewRun 没有捕获本次文件');
  assert.ok(/files: \[target\]/.test(src), 'Office 转换仍在使用可变的 filePath');
  /* 锁的是：只捕获 target 还不够，旧预览仍会往已清空的 view 里继续追加页面。 */
  assert.ok(/const mySeq = \+\+previewSeq;/.test(src), '预览没有领本轮序号');
  assert.ok(/if \(mySeq !== previewSeq\) return;/.test(src), '旧预览没有在 await 后停笔');
  /* 锁的是：renderPdf 若仍不判序号，旧 PDF 的循环会继续 append canvas。 */
  assert.ok(/async function renderPdf\(p, seqToken\)/.test(src), 'renderPdf 没有接收本轮序号');
  /* 锁的是：PDF 预览入口若仍读 filePath，换文件后会把新文件当旧预览目标。 */
  assert.ok(/return await renderPdf\(target, mySeq\)/.test(src), 'PDF 预览仍在使用可变的 filePath');
});

t('R28-05 空目录扫描双击不会并发两趟递归扫描', () => {
  const src = readSrc('js/tools/sys-tools.js');
  /* 锁的是：SCAN_EMPTY_DIRS 是整棵目录树的递归调用；两趟并发后一趟的
   * dirs 会覆盖前一趟，删除按钮可能用半截列表去删。 */
  assert.ok(/if \(scanningDirs\) return toast\('正在扫描，请稍候'/.test(src), '空目录扫描没有拦截重复点击');
  assert.ok(/scanningDirs = true;[\s\S]{0,40}scanBtn\.disabled = true;/.test(src), '空目录扫描开始前没有占闸');
  /* 锁的是：finally 不恢复 scanningDirs/按钮，扫描一次后入口永久不可用。 */
  assert.ok(/finally \{ scanningDirs = false; scanBtn\.disabled = false; \}/.test(src), '空目录扫描结束没有复位');
});

t('R28-06 PDF 水印/提取/瘦身：处理期间换文件不能把 A 内容存成 B 名', () => {
  const src = readSrc('js/tools/pdf-plus.js');
  /* 锁的是：三个页面都在 await 之后读可变的 pdfPath；用户在处理期间
   * 换了 B，旧内容会以 B 的默认文件名保存，用户以为处理的是 B。 */
  assert.strictEqual((src.match(/const srcPath = pdfPath;/g) || []).length, 3, '三个 PDF 处理页没有全部捕获源路径');
  assert.ok(/READ_FILE_B64, srcPath/.test(src), '读取仍在使用可变的 pdfPath');
  /* 锁的是：默认文件名若仍读 pdfPath，旧内容会被命名成新文件的 -stamped。 */
  assert.ok(/String\(srcPath\)\.replace\(\/\\\.pdf\$\/i, ''\) \+ '-stamped\.pdf'/.test(src), '水印默认文件名仍取可变路径');
  /* 锁的是：瘦身默认文件名同理，保存框弹出前用户已换文件就会错名。 */
  assert.ok(/String\(srcPath\)\.replace\(\/\\\.pdf\$\/i, ''\) \+ '-slim\.pdf'/.test(src), '瘦身默认文件名仍取可变路径');
});

t('R28-07 屏幕坐标 4 个数字块在窄工具窗自动落列', () => {
  const src = readSrc('js/tools/dev.js');
  /* 锁的是：560px 工具窗里固定 repeat(4,1fr) 只剩 ~100px 一列，
   * 「X (物理像素)」标签会换行、四个数字块高低不齐。 */
  assert.ok(/repeat\(auto-fit, minmax\(120px, 1fr\)\)/.test(src), '坐标页仍是固定 4 列');
});

t('R28-08 网络实时速率 5 个指标在窄窗自动落列', () => {
  const src = readSrc('js/tools/net-tools.js');
  /* 锁的是：560px 窗里 5 个固定列只剩 ~90px，速率/累计流量会挤成窄柱。 */
  assert.ok(/repeat\(auto-fit, minmax\(100px, 1fr\)\)/.test(src), '实时速率仍是固定 5 列');
});

t('R28-09 同一个 zip 重复拖入不会并发解压到同一目录', () => {
  const src = readSrc('js/tools/file-tools.js', { raw: true });
  /* 锁的是：onChange 自动解压，同一个包连续触发会并发写同一个 -extracted
   * 目标目录；不同包目标不同，不能用一个全局 busy 把换包也挡掉。 */
  assert.ok(/const unzipDirs = new Set\(\);/.test(src), '自动解压没有按目标目录占闸');
  assert.ok(/if \(unzipDirs\.has\(dir\)\) return toast\('这个压缩包正在解压，请稍候'/.test(src), '重复拖入没有拦截');
  /* 锁的是：finally 不释放目录，解压过一次后同一个包再也拖不进去。 */
  assert.ok(/finally \{ unzipDirs\.delete\(dir\); \}/.test(src), '解压结束没有释放目标目录');
});

t('R28-10 三栏 diff 的列允许收缩，长行不撑破页面', () => {
  const src = readSrc('js/tools/diff3.js');
  /* 锁的是：grid 的 1fr 默认 min-width:auto，超长行会把三栏撑出容器；
   * 两处（表头与数据行）都必须用 minmax(0,1fr) 才允许列内断行。 */
  assert.ok((src.match(/gridTemplateColumns: '44px minmax\(0, 1fr\) minmax\(0, 1fr\) minmax\(0, 1fr\)'/g) || []).length >= 2,
    'diff3 仍有可被长行撑开的 1fr 列');
});
