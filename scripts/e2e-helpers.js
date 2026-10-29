'use strict';
/* e2e 测试用的辅助：定位 Python、生成测试图片。
 *
 * 【为什么需要】
 * test-snip-e2e.js / test-target-e2e.js 原来把 python 路径**硬编码**成
 * `C:/Users/67153/.dsh/.../python.exe`。换台机器就跑不了，而且报错很难懂。
 *
 * 现在：
 * 1. 按 环境变量 → PATH → 常见安装位置 → DSH runtime 的顺序找 python；
 * 2. **找不到也不用 python** —— 纯 Node 生成 PNG（不依赖任何第三方库），
 *    这样测试在任何机器上都能跑。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * 尝试定位一个可用的 python 解释器。
 * @returns {string|null}
 */
function findPython() {
  // 1. 显式指定
  if (process.env.HEHE_PYTHON && fs.existsSync(process.env.HEHE_PYTHON)) {
    return process.env.HEHE_PYTHON;
  }
  // 2. PATH 里找
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const names = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
    for (const n of names) {
      const r = spawnSync(cmd, [n], { timeout: 5000, encoding: 'utf8', windowsHide: true });
      const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.trim());
      if (line && fs.existsSync(line.trim())) return line.trim();
    }
  } catch (e) {}
  // 3. 常见安装位置
  const guesses = [
    'C:/Python313/python.exe', 'C:/Python312/python.exe', 'C:/Python311/python.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs/Python/Python312/python.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs/Python/Python311/python.exe'),
    '/usr/bin/python3', '/usr/local/bin/python3'
  ];
  for (const g of guesses) { if (g && fs.existsSync(g)) return g; }
  return null;
}

/**
 * 纯 Node 生成一张最小 PNG（纯色）。不依赖 PIL / canvas。
 * PNG 结构：IHDR + IDAT（zlib 压缩的扫描行）+ IEND。
 * @param {string} outPath
 * @param {number} w
 * @param {number} h
 * @param {[number,number,number]} rgb
 */
function writeSolidPng(outPath, w, h, rgb) {
  const zlib = require('zlib');
  const [r, g, b] = rgb || [255, 255, 255];

  // 每行：filter byte(0) + w 个 RGB 三元组
  const rowLen = 1 + w * 3;
  const raw = Buffer.alloc(rowLen * h);
  for (let y = 0; y < h; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter = None
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type = truecolor RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(outPath, png);
  return outPath;
}

/* 标准 CRC32（PNG 用的多项式） */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

/**
 * 生成测试用白底图：优先纯 Node（无依赖），失败再退回 python+PIL。
 * @returns {{ok:boolean, method:string, path:string}}
 */
function makeWhiteImage(outPath, w = 400, h = 300) {
  try {
    writeSolidPng(outPath, w, h, [255, 255, 255]);
    return { ok: true, method: 'node', path: outPath };
  } catch (e) {
    const py = findPython();
    if (!py) return { ok: false, method: 'none', path: outPath };
    const script = path.join(path.dirname(outPath), '_gen.py');
    fs.writeFileSync(script, [
      'from PIL import Image',
      `Image.new("RGB", (${w}, ${h}), (255, 255, 255)).save(r"${outPath}")`,
      'print("ok")'
    ].join('\n'), 'utf8');
    try {
      spawnSync(py, [script], { stdio: 'ignore', timeout: 30000 });
      return { ok: fs.existsSync(outPath), method: 'python', path: outPath };
    } catch (e2) {
      return { ok: false, method: 'none', path: outPath };
    }
  }
}

/**
 * 纯 Node 生成噪点图（压缩率低，适合测「目标体积压缩」）。
 * 用随机 RGB 让 PNG 几乎不可压缩 —— 这点很重要：
 * 纯色图体积太小，一压就达标，测不出多轮逼近的效果。
 */
function writeNoisePng(outPath, w, h) {
  const zlib = require('zlib');
  const rowLen = 1 + w * 3;
  const raw = Buffer.alloc(rowLen * h);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % 256; };
  for (let y = 0; y < h; y++) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = rnd();
      raw[off + 2 + x * 3] = rnd();
      raw[off + 3 + x * 3] = rnd();
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(outPath, png);
  return outPath;
}

module.exports = { findPython, writeSolidPng, makeWhiteImage, writeNoisePng };
