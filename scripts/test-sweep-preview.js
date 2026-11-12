'use strict';
/* 启动清扫必须覆盖 preview-tmp（doc-preview 的转换产物堆积）。
 *
 * ============ 锁的是哪次事故 ============
 * doc-preview 每预览一个 Office 文档，就在 userData/preview-tmp 留一份
 * LibreOffice 转出的 PDF（渲染层把 outDir 指到那里，预览完没人删）。
 * PPT/大 Word 转出的 PDF 可能几十 MB，长期使用一直堆积。
 * 三轮走查发现启动清扫（sweepTempFiles/sweepClipImages）都没覆盖它。
 *
 * 【为什么不能用行为断言】清扫只在启动时跑一次、且只删 24 小时前的
 * 文件 —— 要验证得改系统时间或等一天；行为验证不可行，锁源码形态。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, ROOT } = require('./lib/harness');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

t('SW1 启动清扫必须包含 preview-tmp（文档预览产物）', () => {
  const main = read('main.js');
  /* 锁的是：sweepPreviewTmp 被删 —— Office 文档预览产物会无限堆积。 */
  assert.ok(/async function sweepPreviewTmp\(/.test(main), '缺少 sweepPreviewTmp 函数');
  /* 锁的是：函数存在但没接进启动清扫的 Promise.all —— 等于没生效。 */
  const call = main.match(/Promise\.all\(\[[^\]]*sweepPreviewTmp[^\]]*\]\)/);
  assert.ok(call, 'sweepPreviewTmp 未加入启动清扫的 Promise.all');
  /* 锁的是：清扫目标目录写错（必须是 userData 下的 preview-tmp）。 */
  const fn = main.slice(main.indexOf('async function sweepPreviewTmp'), main.indexOf('async function sweepClipImages'));
  assert.ok(/preview-tmp/.test(fn) && /userData/.test(fn), '清扫目录必须是 userData/preview-tmp');
  /* 锁的是：按 mtime 保留 24 小时内的判断被删 —— 正在预览的文件会被误删。 */
  assert.ok(/mtimeMs/.test(fn) && /maxAgeMs/.test(fn), '清扫必须保留最近文件（mtime 判断）');
});

done();
