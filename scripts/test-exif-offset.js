'use strict';
/* P1-5 核验：EXIF 里 ASCII(type=2) 标签的值偏移是否正确。
 *
 * 报告说「长度 ≤4 的字符串型标签偏移少加 base」，需要读的是错误位置。
 * 实际逻辑：
 *   - IFD 条目结构：tag(2) type(2) count(4) value/offset(4)，共 12 字节
 *   - 若 count*size <= 4，值**内联**在条目内，绝对偏移 = 条目偏移 e + 8
 *   - 否则第 4 个字段是**相对 TIFF 头(base)** 的偏移，绝对偏移 = base + 值
 * 本测试用一份构造的 EXIF 数据直接验证读取位置对不对。
 */
const assert = require('assert');
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '  -> ' + e.message); } };

/* 复刻 media.js 里读 EXIF ASCII 标签的逻辑（与源码逐字对应），
 * 用构造数据验证偏移算得对不对。注意与源码同步：遇 \0 截断。 */
function readAsciiTag(dv, base, e, num, g32) {
  const valOff = num <= 4 ? e + 8 : base + g32(e + 8);
  const len = num;
  let s = '';
  for (let j = 0; j < len && j < 64; j++) {
    const code = dv.getUint8(valOff + j);
    if (code === 0) break;
    s += String.fromCharCode(code);
  }
  return s;
}

/* 构造一个最小 TIFF 块：
 *   [0..1]  TIFF 头 'II'（小端）
 *   [2..3]  42
 *   [4..7]  指向 IFD0 的偏移（相对 base = 8）
 *   [8...]  IFD0: count(2) entries(12*n) nextIFD(4)
 * 这里手工摆布：base = 0（整个 dv 从 TIFF 头开始）
 */
function buildTiff() {
  // 大小：头 8 + IFD 2 + 2 条目*12 + next 4 + 字符串数据
  const buf = Buffer.alloc(64, 0);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  let p = 0;
  // TIFF 头
  buf.write('II', 0, 'ascii'); p = 2;
  dv.setUint16(p, 42, true); p += 2;
  dv.setUint32(p, 8, true); p += 4;          // IFD0 在偏移 8
  // IFD0 起点 = 8
  const ifd0 = 8;
  dv.setUint16(ifd0, 3, true);               // 3 个条目
  // --- 条目1：Orientation(type=3 SHORT, count=1) 内联值 = 6 ---
  const e1 = ifd0 + 2 + 0 * 12;
  dv.setUint16(e1, 0x0112, true);            // tag
  dv.setUint16(e1 + 2, 3, true);             // type SHORT
  dv.setUint32(e1 + 4, 1, true);             // count 1
  dv.setUint16(e1 + 8, 6, true);             // 内联值 6（旋转 90°）
  // --- 条目2：短 ASCII(type=2, count=4) 内联 "AB\0" ---
  const e2 = ifd0 + 2 + 1 * 12;
  dv.setUint16(e2, 0x010e, true);            // ImageDescription
  dv.setUint16(e2 + 2, 2, true);             // type ASCII
  dv.setUint32(e2 + 4, 4, true);             // count 4（<=4 → 内联）
  dv.setUint8(e2 + 8, 0x41);                 // 'A'
  dv.setUint8(e2 + 9, 0x42);                 // 'B'
  dv.setUint8(e2 + 10, 0x00);                // 结束符
  dv.setUint8(e2 + 11, 0x00);
  // --- 条目3：长 ASCII(type=2, count=10) 偏移指向数据区 ---
  const e3 = ifd0 + 2 + 2 * 12;
  const dataOff = 48;                        // 数据放在偏移 48
  dv.setUint16(e3, 0x0131, true);            // Software
  dv.setUint16(e3 + 2, 2, true);             // ASCII
  dv.setUint32(e3 + 4, 10, true);            // count 10（>4 → 偏移）
  dv.setUint32(e3 + 8, dataOff, true);       // 相对 TIFF 头的偏移
  // 在 dataOff 写入 "MyCam\0\0\0\0\0"
  const s = 'MyCam\0\0\0\0\0';
  for (let i = 0; i < s.length; i++) buf.writeUInt8(s.charCodeAt(i), dataOff + i);
  return { dv, base: 0, entries: [{ e: e1, tag: 0x0112 }, { e: e2, tag: 0x010e }, { e: e3, tag: 0x0131 }] };
}

const g32 = (dv, off) => dv.getUint32(off, true);

t('短 ASCII（count=4，内联在条目里）读到正确内容', () => {
  const { dv, base, entries } = buildTiff();
  const e = entries[1].e;
  const num = dv.getUint32(e + 4, true);
  const got = readAsciiTag(dv, base, e, num, (o) => g32(dv, o));
  assert.strictEqual(got, 'AB', '应读到 "AB"，实际 "' + got + '"');
});

t('长 ASCII（count=10，值在数据区）读到正确内容', () => {
  const { dv, base, entries } = buildTiff();
  const e = entries[2].e;
  const num = dv.getUint32(e + 4, true);
  const got = readAsciiTag(dv, base, e, num, (o) => g32(dv, o));
  assert.strictEqual(got, 'MyCam', '应读到 "MyCam"（遇 \\0 应截断），实际 "' + got + '"');
});

t('Orientation（SHORT 内联）读到 6', () => {
  const { dv, entries } = buildTiff();
  const e = entries[0].e;
  assert.strictEqual(dv.getUint16(e + 8, true), 6, '内联 SHORT 值应为 6');
});

/* ---- 对照：如果「短标签也加 base」会读到什么 ---- */
t('对照实验：短标签若错误地加 base，读到的是错误内容', () => {
  const { dv, base, entries } = buildTiff();
  const e = entries[1].e;
  const num = dv.getUint32(e + 4, true);
  // 故意用 base + (e+8) 这种错误写法（base=0 时碰巧相同，故这里把 base 设为非 0 验证）
  const wrongBase = 8; // 模拟「TIFF 头不在 0 而是在 8」的场景
  const wrong = (() => {
    const valOff = num <= 4 ? wrongBase + e + 8 : wrongBase + g32(dv, e + 8);
    let s = '';
    for (let j = 0; j < num - 1 && j < 64; j++) s += String.fromCharCode(dv.getUint8(valOff + j));
    return s;
  })();
  assert.notStrictEqual(wrong, 'AB', '错误写法不该碰巧读到正确值（这证明 base 的用法必须区分）');
});

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
