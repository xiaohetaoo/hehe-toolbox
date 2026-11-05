'use strict';
/* 「按拍摄时间批量重命名」的端到端测试：真实 JPEG 字节 → 真实 IPC handler → 文件名。
 *
 * ============ 这个缺陷为什么必须用 e2e 才抓得住 ============
 * 报告里那条 EXIF-1 有两层叠加，两层都**自己不会报错**：
 *
 *   ① fs:read-file-b64 返回的是 { b64, size } 对象，渲染层却当 base64 字符串
 *      直接 atob() → 每次都抛 InvalidCharacterError → 被 catch 吞成 t = null。
 *   ② 传的第二个参数 65536 主进程根本不收（签名只有 (e, p)），
 *      注释宣称的「只读文件头 64KB」优化从未存在。
 *
 * 两层的结果是：每一张照片都退回文件修改时间。**功能完全失效，但零报错**。
 * 静态断言只能证明"代码里有 r.b64 这个写法"，证明不了"路径真的跑通了"；
 * 而这条路径的每一处错误都被 catch 吃掉，所以必须真的喂一份带 EXIF 的
 * JPEG 进去，看最终算出来的文件名是不是拍摄时间。
 *
 * ============ 为什么能跑在纯 Node 下 ============
 * 两个被测点各自可独立加载：
 *   · ipc/fs-ops.js 是 register(ctx, deps) 形态 → scripts/lib/load-fs-ops-handlers.js
 *   · lib/exif.js 是纯函数 → 直接 require
 * 这样断言跑的是**主进程将来真会执行的同一份代码**，不是副本。
 * （项目历史上出现过"测试复刻一份逻辑"的假绿，见 test-fs-ops.js 文件头。）
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { t, done, readSrc } = require('./lib/harness');
const { loadFsOpsHandlers } = require('./lib/load-fs-ops-handlers');
const exif = require('../lib/exif');

/* ---------------- 造一份真实字节布局的 JPEG ----------------
 * 与 test-exif-lib.js 里的构造器同源，但这里额外留出"文件尾部有大量数据"
 * 的空间 —— 因为要验证 maxBytes 只读文件头时，图片必须足够大，
 * 截断与整读的差别才看得出来。 */
function buildJpeg({ dateTimeOrig, model, tailBytes }) {
  const entries = [];
  const BASE = 8;
  function pushAscii(tag, str) {
    if (!str) return;
    const bytes = [];
    for (const ch of str) bytes.push(ch.charCodeAt(0) & 0xff);
    bytes.push(0);
    while (bytes.length % 4 !== 0) bytes.push(0);
    entries.push({ tag, type: 2, count: bytes.length, data: bytes });
  }
  pushAscii(0x0110, model);
  pushAscii(0x9003, dateTimeOrig);   // DateTimeOriginal（最可靠）

  const ifdCount = entries.length;
  const ifdSize = 2 + ifdCount * 12 + 4;
  const dataOff = BASE + ifdSize;

  const buf = [];
  buf.push(0x49, 0x49, 42, 0, BASE, 0, 0, 0);
  buf.push(ifdCount & 0xff, (ifdCount >> 8) & 0xff);
  const dataParts = [];
  for (const e of entries) {
    const isInline = e.data.length <= 4;
    buf.push(e.tag & 0xff, (e.tag >> 8) & 0xff);
    buf.push(e.type & 0xff, (e.type >> 8) & 0xff);
    buf.push(e.count & 0xff, (e.count >> 8) & 0xff, 0, 0);
    if (isInline) {
      const v = [0, 0, 0, 0];
      for (let i = 0; i < e.data.length; i++) v[i] = e.data[i];
      buf.push(...v);
    } else {
      const off = dataOff + dataParts.reduce((n, p) => n + p.length, 0);
      buf.push(off & 0xff, (off >> 8) & 0xff, (off >> 16) & 0xff, (off >> 24) & 0xff);
      dataParts.push(e.data);
    }
  }
  buf.push(0, 0, 0, 0);
  for (const p of dataParts) buf.push(...p);

  const tiff = Uint8Array.from(buf);
  const app1Len = 2 + 6 + tiff.length;
  const jpeg = [0xFF, 0xD8];
  jpeg.push(0xFF, 0xE1, (app1Len >> 8) & 0xff, app1Len & 0xff);
  jpeg.push(0x45, 0x78, 0x69, 0x66, 0x00, 0x00);
  jpeg.push(...tiff);
  /* 尾部塞垃圾字节模拟真实照片的像素数据。这一段与 EXIF 无关，
   * 但对"只读前 N 字节"的验证是必需的：文件必须比 N 大得多。 */
  const filler = tailBytes || 0;
  for (let i = 0; i < filler; i++) jpeg.push(i & 0xff);
  jpeg.push(0xFF, 0xD9);
  return Uint8Array.from(jpeg);
}

/* base64 → Uint8Array。测试跑在 Node 里，用 Buffer 而不是 atob：
 * atob 只在浏览器/渲染层环境，scripts 的 eslint 环境没声明它。 */
function b64ToBytes(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exif-rename-'));

/* ---------------- 1. handler 层：返回形状与 maxBytes ---------------- */
const handlers = loadFsOpsHandlers();
const readB64 = handlers.get('fs:read-file-b64');

t('fs:read-file-b64 handler 已被 fs-ops 注册（否则下面几条全在空转）', () => {
  assert.ok(typeof readB64 === 'function', '没拿到 fs:read-file-b64 的 handler');
});

t('fs:read-file-b64 返回 { b64, size } 对象，而不是 base64 字符串（缺陷 ① 的根源）', async () => {
  const p = path.join(tmp, 'shape.jpg');
  fs.writeFileSync(p, Buffer.from(buildJpeg({ dateTimeOrig: '2024:11:03 14:30:22' })));
  const r = await readB64({}, p);
  assert.ok(r && typeof r === 'object', '返回值不是对象：' + typeof r);
  assert.strictEqual(typeof r.b64, 'string', 'r.b64 不是字符串');
  assert.strictEqual(typeof r.size, 'number', 'r.size 不是数字');
  /* 形状必须是对象：渲染层所有调用点都按 r.b64 取值。
   * 如果哪天有人把它改回裸 base64 字符串，这些调用点会全部静默失效
   * （取到 undefined），所以形状本身要钉住。 */
  assert.strictEqual(String(r), '[object Object]',
    '返回值已经不是 { b64, size } 对象了 —— 渲染层所有 r.b64 调用点要重查');
});

t('fs:read-file-b64 支持 maxBytes：只读文件头，不整份读（缺陷 ②）', async () => {
  const tail = 200 * 1024; // 200KB 尾部，远大于要读的 64KB
  const jpg = buildJpeg({ dateTimeOrig: '2024:11:03 14:30:22', tailBytes: tail });
  const p = path.join(tmp, 'big.jpg');
  fs.writeFileSync(p, Buffer.from(jpg));
  const full = await readB64({}, p);
  const head = await readB64({}, p, 65536);
  assert.ok(full.b64.length > head.b64.length,
    '传了 maxBytes 之后返回的 base64 反而没变小（' + head.b64.length + ' vs ' + full.b64.length +
    '）—— 参数被忽略了');
  /* 64KB 的 base64 大约是 87384 字符（65536/3*4）。允许几字节误差。 */
  const headBytes = Buffer.from(head.b64, 'base64').length;
  assert.strictEqual(headBytes, 65536, 'maxBytes=65536 实际读到 ' + headBytes + ' 字节');
  // size 仍然报完整文件大小 —— 调用方要靠它判断"是不是被截断了"
  assert.strictEqual(head.size, jpg.length, 'maxBytes 不应改变 size 的语义（它是文件真实大小）');
});

t('maxBytes 比文件还大时退回整读（不会报错、也不会少读）', async () => {
  const p = path.join(tmp, 'small.jpg');
  const jpg = buildJpeg({ dateTimeOrig: '2024:11:03 14:30:22', tailBytes: 10 });
  fs.writeFileSync(p, Buffer.from(jpg));
  const r = await readB64({}, p, 100 * 1024 * 1024);
  const got = Buffer.from(r.b64, 'base64').length;
  assert.strictEqual(got, jpg.length, '读到的字节数应等于文件大小，实际 ' + got + ' / ' + jpg.length);
});

t('maxBytes 传非法值（NaN / 0 / 负数 / 字符串）时退回整读，不静默读 0 字节', async () => {
  const p = path.join(tmp, 'bad.jpg');
  const jpg = buildJpeg({ dateTimeOrig: '2024:11:03 14:30:22', tailBytes: 30 });
  fs.writeFileSync(p, Buffer.from(jpg));
  for (const bad of [NaN, 0, -1, null, 'abc', undefined]) {
    const r = await readB64({}, p, bad);
    const got = Buffer.from(r.b64, 'base64').length;
    assert.strictEqual(got, jpg.length,
      'maxBytes=' + String(bad) + ' 时读到了 ' + got + ' 字节（应为整份 ' + jpg.length + '）');
  }
});

/* ---------------- 2. 与渲染层同构的解析路径 ----------------
 * 这一段**逐字复刻** js/tools/file-tools.js 里 ensureExifTimes 的解码方式。
 * 复刻是有意的：要验的正是"这个写法对不对"。所以下面额外有一条源码断言
 * 钉住 file-tools.js 必须用同样的写法（r.b64），防止两边分叉。 */
function shotTimeFromHandlerResult(r) {
  /* 与渲染层的写法等价（那边是 atob + charCodeAt 逐字节拷贝），
   * 这里用 Buffer 走同一条"base64 → 字节"的路。
   * 有源码断言钉住两边写法一致（见本文件最后一条用例）。 */
  return exif.pickShotTime(exif.parseExif(b64ToBytes(r.b64)));
}

t('渲染层的解码写法能从真实 JPEG 里读出拍摄时间（修复后应当拿到 2024-11-03）', async () => {
  const p = path.join(tmp, 'photo.jpg');
  fs.writeFileSync(p, Buffer.from(buildJpeg({ dateTimeOrig: '2024:11:03 14:30:22', model: 'Pixel 8' })));
  const r = await readB64({}, p, 65536);
  const got = shotTimeFromHandlerResult(r);
  assert.ok(got instanceof Date, '没解析出拍摄时间（会退回文件修改时间）');
  assert.strictEqual(got.getFullYear(), 2024);
  assert.strictEqual(got.getMonth(), 10);
  assert.strictEqual(got.getDate(), 3);
  assert.strictEqual(got.getHours(), 14);
});

t('原缺陷写法（把返回对象当 base64 用）必然拿不到正确字节 —— 这就是以前 100% 退回 mtime', async () => {
  const p = path.join(tmp, 'photo2.jpg');
  fs.writeFileSync(p, Buffer.from(buildJpeg({ dateTimeOrig: '2024:11:03 14:30:22' })));
  const r = await readB64({}, p, 65536);
  /* 缺陷现场：渲染层拿到的是 { b64, size }，却按"base64 字符串"处理。
   * 在浏览器里那一步是 atob(对象) → 抛 InvalidCharacterError；
   * 在 Node 里等价的就是把对象塞给一个只认字符串的解码函数。 */
  let threw = false;
  try {
    const bad = String(r);
    if (bad === '[object Object]') throw new Error("Cannot decode '[object Object]'");
  } catch (e) { threw = true; }
  assert.ok(threw, '把 {b64,size} 当 base64 用居然没失败 —— 缺陷的机理描述需要更正');
  /* 正面确认：正确写法能还原出 EXIF，错写法不能 —— 两者必须都成立。 */
  const ok = shotTimeFromHandlerResult(r);
  assert.ok(ok instanceof Date, '正确写法反而解析不出拍摄时间');
});

t('生成的文件名就是拍摄时间，不是文件修改时间', async () => {
  const p = path.join(tmp, 'IMG_0001.jpg');
  fs.writeFileSync(p, Buffer.from(buildJpeg({ dateTimeOrig: '2024:11:03 14:30:22' })));
  /* 把 mtime 故意设成另一个明显不同的时间：如果代码退回 mtime，断言会立刻看出来 */
  const other = new Date(2030, 0, 1, 8, 0, 0);
  fs.utimesSync(p, other, other);

  const r = await readB64({}, p, 65536);
  const t0 = shotTimeFromHandlerResult(r);
  assert.ok(t0, '解析失败，会退回 mtime');
  const p2 = (n) => String(n).padStart(2, '0');
  const name = t0.getFullYear() + '-' + p2(t0.getMonth() + 1) + '-' + p2(t0.getDate()) +
    '_' + p2(t0.getHours()) + p2(t0.getMinutes()) + p2(t0.getSeconds());
  assert.strictEqual(name, '2024-11-03_143022');
  assert.notStrictEqual(name, '2030-01-01_080000', '拿到的是文件修改时间（说明又退回 mtime 了）');
});

/* ---------------- 3. 源码层面的对账 ----------------
 * 上面那条"逐字复刻"有分叉风险：file-tools.js 改了写法，测试照旧绿。
 * 所以再钉一条，要求调用点确实按对象取 b64。 */
t('file-tools.js 的 EXIF 预取按 r.b64 取值（不能是裸返回值）', () => {
  const src = readSrc('js/tools/file-tools.js');
  const i = src.indexOf('async function ensureExifTimes');
  assert.ok(i > 0, '找不到 ensureExifTimes');
  const seg = src.slice(i, i + 1400);
  // 锁的是：EXIF-1 缺陷 —— 把 {b64,size} 当字符串 atob，每条路径都抛、都被 catch
  // 吞成"退回文件修改时间"。这里验的是取值那一行的写法。
  assert.ok(/const r = await invoke\([^)]*READ_FILE_B64[^)]*\)/.test(seg),
    '没有把返回值先收进变量（原缺陷就是这个形态）');
  // 锁的是：必须从对象上取 .b64，而不是把整个返回值当 base64 用。
  assert.ok(/atob\(r\.b64\)/.test(seg), '没有按 r.b64 解码');
  // 锁的是：maxBytes 参数要真的传出去（以前 handler 不收、参数被丢弃）。
  assert.ok(/READ_FILE_B64[^)]*,\s*65536\s*\)/.test(seg), '没有传 65536 的只读上限');
});

/* ---------------- 清理 ----------------
 * 【不能写成一条 t() 用例】harness 默认是 deferred 模式：同步用例当场打印，
 * 异步用例收集到 done() 才跑。于是一条同步的"清理临时目录"会排在所有
 * 异步用例**前面**执行，把它们要用的文件先删掉 —— 实测 7 条全红在 ENOENT。
 * 改成进程退出时清理：位置对了，也不会影响断言顺序。 */
process.on('exit', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});

done();
