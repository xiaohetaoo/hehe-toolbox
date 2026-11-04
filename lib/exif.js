'use strict';
/* EXIF 解析：从 JPEG 的 APP1 段读出拍摄参数。
 *
 * ============ 为什么单独一个模块 ============
 * 这段逻辑原本在 js/tools/media/exif-view.js 的 render() 作用域里，
 * 只能被那一个工具用。而「按拍摄时间批量重命名」需要同样的解析 ——
 * 复制一份过去的话，两份实现会慢慢分叉（其中一份修了补零 bug、
 * 另一份没修，照片在 A 工具显示正确时间、在 B 工具显示乱码）。
 *
 * 放在 lib/ 的额外好处：它是**纯函数**，可以在纯 Node 下测，
 * 不需要起 Electron 也不需要真照片（用构造的 TIFF 字节即可）。
 *
 * ============ 已知的历史坑（改动前务必读）============
 * 1) ASCII 标签的 count 是字节数（含结尾 \0），且很多相机会补零对齐。
 *    按 `j < len - 1` 只跳过一个字节 → 多余的空字节被读进来显示成乱码。
 *    正确做法是读到第一个 \0 为止。
 * 2) count <= 4 时值内联在条目的第 4 字段里（绝对偏移 e+8）；
 *    否则第 4 字段是**相对 TIFF 头**的偏移。两者混用会读到垃圾。
 * 3) DataView 必须基于完整 buffer + byteOffset 构造，否则子数组会越界。
 */

/* EXIF 标签 → 中文名。0x8769 是子 IFD 指针，单独处理（不进结果）。 */
const TAGS = {
  0x010F: '相机制造商',
  0x0110: '相机型号',
  0x0112: '方向',
  0x0132: '拍摄时间',
  0x8827: 'ISO',
  0x829A: '曝光时间',
  0x829D: '光圈值(F)',
  0x920A: '焦距(mm)',
  0xA002: '图像宽度',
  0xA003: '图像高度',
  0x9003: '原始时间'
};

/* 从 JPEG 字节里找出 Exif APP1 段并解析。找不到返回 null。 */
function parseExif(buf) {
  try {
    let offset = 2;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    while (offset < buf.length) {
      if (buf[offset] !== 0xFF) { offset++; continue; }
      const marker = buf[offset + 1];
      const size = dv.getUint16(offset + 2);
      if (marker === 0xE1 && offset + 4 < buf.length) {
        // APP1 段的头 6 字节是 "Exif\0\0"，之后才是 TIFF 头
        let head = '';
        for (let i = 0; i < 6 && offset + 4 + i < buf.length; i++) head += String.fromCharCode(buf[offset + 4 + i]);
        if (head.slice(0, 4) === 'Exif') return parseTiff(buf, offset + 10);
      }
      if (marker === 0xDA) break; // 到了图像数据，后面不会再有 EXIF
      offset += 2 + size;
    }
    return null;
  } catch (e) { return null; }
}

/* 解析 TIFF 头 + IFD 链。start 指向 TIFF 头在 buf 里的位置。 */
function parseTiff(buf, start) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const base = start;
  const little = dv.getUint16(base) === 0x4949; // 'II' = Intel 小端
  const g16 = (o) => dv.getUint16(base + o, little);
  const g32 = (o) => dv.getUint32(base + o, little);
  const ifd = g32(4);
  const out = {};
  let guard = 0;
  function readIFD(off) {
    // 防御：损坏文件可能形成 IFD 环，限制层数避免死循环
    if (guard++ > 16) return;
    const count = g16(off);
    if (!isFinite(count) || count < 0 || count > 4096) return;
    for (let i = 0; i < count; i++) {
      const e = off + 2 + i * 12;
      if (base + e + 12 > buf.length) return;
      const tag = g16(e), type = g16(e + 2), num = g32(e + 4);
      if (tag === 0x8769) { // Exif 子 IFD
        const sub = g32(e + 8);
        if (sub > 0 && base + sub < buf.length) readIFD(sub);
        continue;
      }
      const name = TAGS[tag];
      if (!name) continue;
      let val;
      if (type === 2) {
        // ASCII：读到第一个 \0 为止（见文件头坑 1）
        const len = num;
        /* 【内联分支必须补 base —— 真 bug，被 test-exif-lib 抓出来的】
         * count<=4 时值内联在条目第 4 字段（相对 TIFF 头的 e+8），
         * 但 dv.getUint8() 用**绝对索引**。少加 base 的话：
         *   · base=0（直接解析纯 TIFF 段）恰好正确
         *   · base>0（从 JPEG 里切出来的真实场景）读到错的字节
         * 表现：短字符串标签（相机型号）空或乱码，长串（时间戳）正常，
         * 且只有走 parseExif 才错 —— 极具迷惑性。 */
        const valOff = num <= 4 ? base + e + 8 : base + g32(e + 8);
        let s = '';
        for (let j = 0; j < len && j < 64; j++) {
          const pos = valOff + j;
          if (pos >= buf.length) break;
          const code = dv.getUint8(pos);
          if (code === 0) break;
          s += String.fromCharCode(code);
        }
        val = s;
      } else if (type === 3) val = g16(e + 8);
      else if (type === 4) val = g32(e + 8);
      else if (type === 5) {
        const vOff = base + g32(e + 8);
        val = num > 0 && vOff + 8 <= buf.length
          ? (dv.getUint32(vOff, little) ? (dv.getUint32(vOff, little) / dv.getUint32(vOff + 4, little)).toFixed(2) : '-')
          : '-';
      } else val = g32(e + 8);
      if (val !== '' && val != null) out[name] = String(val);
    }
  }
  readIFD(ifd);
  return out;
}

/* 把 EXIF 时间（"2024:11:03 14:30:22"）转成 Date。
 * 格式不合规或数值越界都返回 null —— 调用方据此决定要不要退回文件时间。
 * 注意 EXIF 时间**没有时区**，按本地时间解释（相机通常写当地时间）。 */
function parseExifDate(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, hh, mm, ss] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 60) return null;
  const dt = new Date(y, mo - 1, d, hh, mm, ss);
  // 再校验一次：2 月 30 日这种会被 Date 滚到下个月，必须挡住
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/* 从解析结果里挑最可靠的拍摄时间。
 * 0x9003（DateTimeOriginal，写入时不会变）优先于 0x0132（DateTime，可能被编辑软件改）。
 * 这是 EXIF 规范的建议顺序。 */
function pickShotTime(exif) {
  if (!exif) return null;
  return parseExifDate(exif['原始时间']) || parseExifDate(exif['拍摄时间']) || null;
}

/* 【UMD 形态：node 与渲染层共用同一份实现】
 * 渲染层在 contextIsolation 下无法 require lib/，所以由 index.html 用
 * <script> 引入，挂到 window.ExifLib；node 侧 require 拿到的就是同一个对象。
 * 与 lib/fail-text.js 同一种写法 —— 两份副本会慢慢分叉，这个项目踩过。
 */
(function (root, api) {
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ExifLib = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null),
   { parseExif, parseTiff, parseExifDate, pickShotTime, TAGS });
