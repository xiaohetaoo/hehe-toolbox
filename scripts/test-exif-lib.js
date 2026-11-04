'use strict';
/* lib/exif.js 的行为测试。
 *
 * ============ 为什么这个模块必须测 ============
 * 它是「按拍摄时间批量重命名」的基础：解析错了，用户几百张照片会被
 * 批量改成错误的日期，而且**不可逆**（重命名后原文件名就没了）。
 *
 * 这个解析器有三处历史坑，每处都曾经把带 EXIF 的照片解析成乱码：
 *   1) ASCII 标签补零：只跳过一个 \0 会把多余空字节读进来
 *   2) count<=4 时值内联在条目里，否则是相对 TIFF 头的偏移
 *   3) DataView 必须基于完整 buffer + byteOffset
 * 所以这里不只测"能读出来"，还要用**构造的字节**覆盖这些边界。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

const exif = require('../lib/exif');

/* ---------------- parseExifDate ---------------- */
t('parseExifDate 解析标准 EXIF 时间', () => {
  const d = exif.parseExifDate('2024:11:03 14:30:22');
  assert.ok(d instanceof Date);
  assert.strictEqual(d.getFullYear(), 2024);
  assert.strictEqual(d.getMonth(), 10); // 0-based
  assert.strictEqual(d.getDate(), 3);
  assert.strictEqual(d.getHours(), 14);
  assert.strictEqual(d.getMinutes(), 30);
  assert.strictEqual(d.getSeconds(), 22);
});

t('parseExifDate 也接受连字符分隔（部分软件这么写）', () => {
  const d = exif.parseExifDate('2024-11-03 14:30:22');
  assert.ok(d);
  assert.strictEqual(d.getFullYear(), 2024);
});

t('parseExifDate 对非法月份返回 null（不是滚到下一年）', () => {
  assert.strictEqual(exif.parseExifDate('2024:13:03 14:30:22'), null);
  assert.strictEqual(exif.parseExifDate('2024:00:03 14:30:22'), null);
});

t('parseExifDate 对 2 月 30 日返回 null（JS Date 会静默滚到 3 月）', () => {
  // 这是最容易漏的一条：new Date(2023,1,30) 不报错，直接变成 3 月 2 日。
  // 不挡住的话，用户照片会被改成不存在的日期。
  assert.strictEqual(exif.parseExifDate('2023:02:30 10:00:00'), null);
  assert.ok(exif.parseExifDate('2024:02:29 10:00:00'), '闰年 2/29 应当合法');
  assert.strictEqual(exif.parseExifDate('2023:02:29 10:00:00'), null, '平年 2/29 应被拒');
});

t('parseExifDate 对空值/非字符串/垃圾返回 null', () => {
  assert.strictEqual(exif.parseExifDate(''), null);
  assert.strictEqual(exif.parseExifDate(null), null);
  assert.strictEqual(exif.parseExifDate(undefined), null);
  assert.strictEqual(exif.parseExifDate('0000:00:00 00:00:00'), null);
  assert.strictEqual(exif.parseExifDate('not a date'), null);
});

/* ---------------- pickShotTime ---------------- */
t('pickShotTime 优先用「原始时间」(0x9003)', () => {
  const d = exif.pickShotTime({ '原始时间': '2024:01:02 03:04:05', '拍摄时间': '2020:01:01 00:00:00' });
  assert.strictEqual(d.getFullYear(), 2024, 'DateTimeOriginal 优先于 DateTime');
});

t('pickShotTime 缺原始时间时回退到拍摄时间', () => {
  const d = exif.pickShotTime({ '拍摄时间': '2021:05:06 07:08:09' });
  assert.strictEqual(d.getFullYear(), 2021);
});

t('pickShotTime 两者都没有时返回 null（调用方据此退用文件时间）', () => {
  assert.strictEqual(exif.pickShotTime({}), null);
  assert.strictEqual(exif.pickShotTime(null), null);
});

t('pickShotTime 遇到损坏的时间字符串不会抛异常', () => {
  assert.strictEqual(exif.pickShotTime({ '原始时间': 'xxxx', '拍摄时间': 'yyyy' }), null);
});

/* ---------------- parseExif：字节级 ---------------- */
/* 构造一个最小可用的 JPEG：SOI + APP1(Exif) + EOI。
 * 这样才能覆盖「补零」「内联偏移」这些只有在真实字节布局下才暴露的问题。 */
function buildJpeg({ dateTime, dateTimeOrig, model }) {
  // TIFF 头（小端）+ IFD0 + 可选的 Exif 子 IFD
  const entries = [];
  const BASE = 8; // TIFF 头 8 字节

  function pushAscii(tag, str) {
    if (!str) return;
    const bytes = [];
    for (const ch of str) bytes.push(ch.charCodeAt(0) & 0xff);
    bytes.push(0); // 结尾 \0
    // 故意补几个 0，模拟"相机补零对齐"（坑 1）
    while (bytes.length % 4 !== 0) bytes.push(0);
    entries.push({ tag, type: 2, count: bytes.length, data: bytes });
  }
  pushAscii(0x0110, model);          // 相机型号
  pushAscii(0x0132, dateTime);       // 拍摄时间
  pushAscii(0x9003, dateTimeOrig);   // 原始时间

  // 先算 IFD 大小，决定数据区起点
  const ifdCount = entries.length;
  const ifdSize = 2 + ifdCount * 12 + 4;
  let dataOff = BASE + ifdSize;

  const buf = [];
  // TIFF 头：'II' + 42 + IFD0 偏移(8)
  buf.push(0x49, 0x49, 42, 0, BASE, 0, 0, 0);
  // IFD
  buf.push(ifdCount & 0xff, (ifdCount >> 8) & 0xff);
  const dataParts = [];
  for (const e of entries) {
    const isInline = e.data.length <= 4;
    // tag / type / count
    buf.push(e.tag & 0xff, (e.tag >> 8) & 0xff);
    buf.push(e.type & 0xff, (e.type >> 8) & 0xff);
    buf.push(e.count & 0xff, (e.count >> 8) & 0xff, 0, 0);
    if (isInline) {
      const v = [0, 0, 0, 0];
      for (let i = 0; i < e.data.length; i++) v[i] = e.data[i];
      buf.push(...v);
    } else {
      // 第 4 字段是相对 TIFF 头的偏移（坑 2）
      const off = dataOff + dataParts.reduce((n, p) => n + p.length, 0);
      buf.push(off & 0xff, (off >> 8) & 0xff, (off >> 16) & 0xff, (off >> 24) & 0xff);
      dataParts.push(e.data);
    }
  }
  // 下一个 IFD = 0
  buf.push(0, 0, 0, 0);
  for (const p of dataParts) buf.push(...p);

  const tiff = Uint8Array.from(buf);
  const app1Len = 2 + 6 + tiff.length; // 长度字段(2) + 'Exif\0\0'(6) + TIFF
  const jpeg = [0xFF, 0xD8]; // SOI
  jpeg.push(0xFF, 0xE1, (app1Len >> 8) & 0xff, app1Len & 0xff);
  jpeg.push(0x45, 0x78, 0x69, 0x66, 0x00, 0x00); // 'Exif\0\0'
  jpeg.push(...tiff);
  jpeg.push(0xFF, 0xD9); // EOI
  return Uint8Array.from(jpeg);
}

t('parseExif 能读出相机型号与拍摄时间', () => {
  const jpg = buildJpeg({ dateTime: '2024:11:03 14:30:22', dateTimeOrig: '2024:11:03 14:30:22', model: 'Pixel 8' });
  const r = exif.parseExif(jpg);
  assert.ok(r, 'should parse');
  assert.strictEqual(r['相机型号'], 'Pixel 8');
  assert.strictEqual(r['原始时间'], '2024:11:03 14:30:22');
});

t('parseExif 剥掉补零空字节（坑 1：多余空字节会显示成乱码）', () => {
  const jpg = buildJpeg({ dateTime: '2024:11:03 14:30:22', model: 'AB' }); // 'AB' 补零到 4 字节
  const r = exif.parseExif(jpg);
  assert.strictEqual(r['相机型号'], 'AB', '尾部的 \\0 必须被剥掉，实际: ' + JSON.stringify(r['相机型号']));
});

t('parseExif 对没有 EXIF 的 JPEG 返回 null（截图就是这种）', () => {
  const plain = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xD9]);
  assert.strictEqual(exif.parseExif(plain), null);
});

t('parseExif 对损坏字节不抛异常', () => {
  for (const bad of [new Uint8Array(0), new Uint8Array([0xFF]), new Uint8Array(64).fill(0xFF)]) {
    let threw = false;
    try { exif.parseExif(bad); } catch (e) { threw = true; }
    assert.strictEqual(threw, false, '坏输入不能抛');
  }
});

t('parseExif 截断的 EXIF 不会死循环（只读文件头 64KB 的场景）', () => {
  const jpg = buildJpeg({ dateTime: '2024:11:03 14:30:22', model: 'Camera' });
  const truncated = jpg.subarray(0, 20); // 人为截断
  const t0 = Date.now();
  let threw = false;
  try { exif.parseExif(truncated); } catch (e) { threw = true; }
  assert.strictEqual(threw, false);
  assert.ok(Date.now() - t0 < 1000, '不应耗时过久（防 IFD 环）');
});

/* ---------------- UMD 形态 ---------------- */
t('UMD：node require 拿到的对象带全部导出', () => {
  for (const k of ['parseExif', 'parseExifDate', 'pickShotTime', 'TAGS']) {
    assert.ok(exif[k], '缺导出: ' + k);
  }
});

/* 锁的是：渲染层要靠 window.ExifLib 拿到同一份实现。
 * 不能用行为断言的原因：这里没有浏览器全局，只能验证"提供了挂载点"和
 * "index.html 确实引入了它"这两件事实。 */
/* 锁的是：渲染层能不能拿到 EXIF 解析。
 * 不能用行为断言的原因：这是"构建配置"而不是运行时逻辑 ——
 * 页面里没有 window.ExifLib 时，调用点会拿到 undefined 并在
 * 使用时报 TypeError（而不是"解析失败"），排查起来很绕。
 * 用 readSrc 读（它会剥注释），避免被注释里的示例命中。 */
t('index.html 引入了 lib/exif.js（渲染层才拿得到 window.ExifLib）', () => {
  /* 【这里必须用 raw:true】
   * readSrc 默认会剥注释，而 stripComments 对 HTML 的处理是把
   * <!-- ... --> 整段删掉 —— 我们的 <script> 标签恰好紧跟在一段
   * HTML 注释之后，剥完连标签一起没了，断言必然失败（假红）。
   * 要验的是"标签存不存在"，本来就该看原文。 */
  const html = readSrc('index.html', { raw: true });
  // 锁的是：script 标签真实存在，否则 window.ExifLib 是 undefined。
  assert.ok(/<script src="lib\/exif\.js"><\/script>/.test(html), 'index.html 必须引入 lib/exif.js');
});

done();
