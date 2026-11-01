'use strict';
/* 本应用临时产物的**唯一**命名来源。
 *
 * ============ 为什么必须有这个模块 ============
 * 临时产物前缀原来散落在十几处代码里（hehe-snip-、hehe-ffmpeg-、hehe-7zx-、
 * .hehe-bak、hehe-tgt-、hehe-uniq-、.hehe-w-、hehe-rec-、hehe-update-…）。
 * 而「哪些临时文件属于我们自己」由 main.js 的 OWN_TEMP_PATTERNS 用**手写正则**
 * 描述 —— 两处是独立的事实，只能靠人肉保持同步。
 *
 * 真实事故：`.hehe-7zx-*` 暂存目录带**前导点**，而清理白名单里的正则
 * 写的是 `^hehe-7zx-`（不带点）。于是那个目录永远匹配不上白名单，
 * 一旦 7z 解压中途崩溃，它就永久残留在用户目录里，而「清理临时文件」
 * 功能扫不到它。表现是"用户目录里有个莫名奇妙的隐藏文件夹，删了又出现"。
 *
 * 现在的约束是：**先在这里定义生成函数，再由生成函数反推出白名单正则**。
 * scripts/test-temp-names.js 会逐条校验：每个生成函数产出的名字
 * 都必须被 OWN_TEMP_PATTERNS 命中 —— 新增一种产物却忘了登记时，
 * 测试立刻红，而不是等用户磁盘里堆满垃圾。
 *
 * ============ 设计取舍 ============
 * · 生成函数都要能注入"时间/随机源"，这样测试可以造出确定的样例名，
 *   而且能顺便验证"同一毫秒内两次调用不会撞名"（撞名在这里是真事故：
 *   两次截图写出同一个 PNG 路径，第一张会被覆盖）。
 * · 不引入 path 依赖之外的东西：这个模块要能被 main.js（node）与
 *   测试直接 require，不依赖 Electron（app.getPath 由调用方传 tempDir 进来）。
 */

const path = require('path');
const crypto = require('crypto');

/* ============ 前缀常量 ============
 * 改这里就等于改全项目的临时产物命名。注意带前导点的几个：
 * 它们在用户目录里是隐藏文件，正则里必须写成 `\.?前缀`（点可有可无），
 * 否则老版本留下的无点文件会漏在白名单外。 */
const PREFIX = {
  SNIP: 'hehe-snip-',          // 截图临时 PNG
  FFMPEG_ZIP: 'hehe-ffmpeg-',  // FFmpeg 安装包下载
  FFMPEG_WIN: 'hehe-ffmpeg-win', // FFmpeg 解压产物（.gz 形态）
  REC_SEG: 'hehe-rec-',        // 录制分段目录
  TGT: 'hehe-tgt-',            // 目标体积压缩暂存目录
  UNIQ: 'hehe-uniq-',          // 通用解压暂存目录
  SEVEN: '.hehe-7zx-',         // 7z 解压暂存目录（**带前导点**）
  WRITE_TMP: '.hehe-w-',       // 原子写入临时文件（**带前导点**）
  WRITE_BAK: '.hehe-bak-',     // 原子写入的替换备份（**带前导点**）
  DIRMOVE_BAK: '.hehe-bak',    // 目录搬家的备份后缀（无分隔符，接在原路径后）
  UPDATE_LOG: 'hehe-update-',  // 升级脚本日志
  ROLLBACK_LOG: 'hehe-rollback-', // 回滚脚本日志
  PART: '.part-',              // 下载中断的残留后缀（接在目标名后）
  CRYPT: '.hehe-crypt-',       // 加解密临时文件
};

/** 时间戳 + 随机后缀，保证同一毫秒内多次调用不撞名。
 *  【为什么不是纯 Date.now()】截图/下载/解压都可能在同一毫秒内发生两次，
 *  纯时间戳会撞名，后写的覆盖先写的。历史上截图就踩过这个。 */
function stamp(opts) {
  const now = (opts && typeof opts.now === 'number') ? opts.now : Date.now();
  const hex = (opts && typeof opts.hex === 'string') ? opts.hex
    : crypto.randomBytes(3).toString('hex');
  return now + '-' + hex;
}

/* ============ 生成函数 ============
 * 每个函数都接受 opts：{ tempDir, now, hex }，便于测试造确定样例。
 * 不传 tempDir 时返回**文件名**（不带目录）—— 调用方自己拼路径。
 */

/** 截图临时 PNG。目录由调用方给（main.js 用 app.getPath('temp')）。 */
function snipTmp(opts) {
  const name = PREFIX.SNIP + stamp(opts) + '.png';
  return (opts && opts.tempDir) ? path.join(opts.tempDir, name) : name;
}

/** FFmpeg 安装包下载到本地的 zip。 */
function ffmpegZip(opts) {
  const name = PREFIX.FFMPEG_ZIP + (opts && opts.now ? opts.now : Date.now()) + '.zip';
  return (opts && opts.tempDir) ? path.join(opts.tempDir, name) : name;
}

/** 录制分段目录。 */
function recSegDir(opts) {
  const name = PREFIX.REC_SEG + (opts && opts.now ? opts.now : Date.now());
  return (opts && opts.tempDir) ? path.join(opts.tempDir, name) : name;
}

/** 目标体积压缩的暂存目录。 */
function tgtTmpDir(opts) {
  const name = PREFIX.TGT + stamp(opts);
  return (opts && opts.tempDir) ? path.join(opts.tempDir, name) : name;
}

/** 通用解压的暂存目录。 */
function uniqTmpDir(opts) {
  const name = PREFIX.UNIQ + stamp(opts);
  return (opts && opts.tempDir) ? path.join(opts.tempDir, name) : name;
}

/** 7z 解压暂存目录（在目标目录下，带前导点所以是隐藏的）。 */
function sevenStagingDir(outDir, opts) {
  const name = PREFIX.SEVEN + stamp(opts);
  return outDir ? path.join(outDir, name) : name;
}

/** 原子写入的临时文件：同目录下 `.hehe-w-<tag>.tmp`。 */
function writeTmp(destPath, tag) {
  return path.join(path.dirname(destPath), PREFIX.WRITE_TMP + tag + '.tmp');
}

/** 原子写入时的替换备份：同目录下 `.hehe-bak-<tag>`。 */
function writeBak(destPath, tag) {
  return path.join(path.dirname(destPath), PREFIX.WRITE_BAK + tag);
}

/** 目录搬家的备份路径：原路径 + `.hehe-bak`（**贴在后缀上，不加分隔符**）。 */
function dirmoveBak(srcPath) {
  return srcPath + PREFIX.DIRMOVE_BAK;
}

/** 下载中断残留：目标名 + `.part-<ts>-<hex>`。 */
function downloadPart(destPath, opts) {
  return destPath + PREFIX.PART + stamp(opts);
}

/** 加解密临时文件。 */
function cryptTmp(outPath, opts) {
  return outPath + PREFIX.CRYPT + stamp(opts);
}

/** 升级/回滚脚本日志的文件名（PowerShell 侧拼 `$env:TEMP`，所以只给文件名）。 */
function updateLogName(stampStr) {
  return PREFIX.UPDATE_LOG + (stampStr || '') + '.log';
}
function rollbackLogName(stampStr) {
  return PREFIX.ROLLBACK_LOG + (stampStr || '') + '.log';
}

/* ============ 白名单正则 ============
 * 这里是 OWN_TEMP_PATTERNS 的**唯一来源**。
 * 每条都对应上面一个生成函数；scripts/test-temp-names.js 会拿生成函数的
 * 真实产出逐个去测，保证"能生成的一定能被清理"。
 *
 * 【注意前导点】标记 dot: true 的是"可能带前导点"的产物：
 * 正则必须写成 `\.?前缀` 才能同时兼容老版本留下的无点文件。 */
const OWN_TEMP_PATTERNS = [
  /* 截图临时图：hehe-snip-<ts>-<hex>.png（老版本无 hex 后缀，用可选组兼容） */
  /^hehe-snip-\d+(-[0-9a-f]+)?\.png$/i,
  /* 下载未完成的 .part 残留：<任意目标名>.part-<ts>-<hex> */
  /^hehe-.*\.part-\d+-[0-9a-f]+$/i,
  /* 录制分段目录 */
  /^hehe-rec-\d+$/i,
  /* FFmpeg 下载包 */
  /^hehe-ffmpeg-.*\.zip$/i,
  /^hehe-ffmpeg-win.*\.gz$/i,
  /* 升级 / 回滚脚本日志 */
  /^hehe-update-.*\.log$/i,
  /^hehe-rollback-.*\.log$/i,
  /* 7z 解压暂存目录（可能带前导点） */
  /^\.?hehe-7zx-.+/i,
  /* 目标体积压缩暂存目录 */
  /^hehe-tgt-.+/i,
  /* 通用解压暂存目录 */
  /^hehe-uniq-.+/i,
  /* 原子写入的临时文件与备份（实际名带前导点） */
  /^\.?hehe-w-.+/i,
  /^\.?hehe-bak-.+/i,
  /* 加解密临时文件 */
  /^.*\.hehe-crypt-\d+-[0-9a-f]+$/i,
];

/** 某个名字是否属于本应用的临时产物（清理白名单的唯一判定入口）。 */
function isOwnTempName(name) {
  const s = String(name == null ? '' : name);
  return OWN_TEMP_PATTERNS.some((re) => re.test(s));
}

module.exports = {
  PREFIX, OWN_TEMP_PATTERNS, isOwnTempName,
  snipTmp, ffmpegZip, recSegDir, tgtTmpDir, uniqTmpDir, sevenStagingDir,
  writeTmp, writeBak, dirmoveBak, downloadPart, cryptTmp,
  updateLogName, rollbackLogName,
};
