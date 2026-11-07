'use strict';
/* 文件命名/提交相关的纯逻辑（供 main.js 与测试共享）。
 *
 * 【为什么抽出来】
 * test-round2-fixes.js 原来「复刻」了 main.js 里的唯一名生成与临时名改名逻辑。
 * 复刻 = 测副本：main.js 一改，测试照旧全绿（假绿）。
 * 抽到这里之后，main.js 调用它，测试也调用它，逻辑只有一份。
 */

const fs = require('fs');
const path = require('path');

/**
 * 若目标已存在，生成一个不冲突的新路径：`base(1).ext`、`base(2).ext` …
 * 与 `fs:unique-path` IPC 的行为一致。
 * @param {string} p 期望路径
 * @param {(p:string)=>boolean} [exists] 可注入的存在性判断（便于测试）
 */
function uniquePath(p, exists = (x) => fs.existsSync(x)) {
  if (!exists(p)) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  for (let i = 1; i < 1000; i++) {
    const np = path.join(dir, `${base}(${i})${ext}`);
    if (!exists(np)) return np;
  }
  // 999 个都被占了：退化成带时间戳的名字，保证一定不覆盖
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

/**
 * 生成「先写临时名、成功后再改名」所用的临时路径。
 * 目的是避免中途失败时在**最终文件名**下留下半截文件。
 * @param {string} finalOut 最终目标路径
 * @param {string} tag      区分用途的标记（如 'merging'）
 */
/* 【tempPathFor 已搬到 lib/temp-names.js】
 * 原因：它产出的名字必须登记进清扫白名单，而白名单在 temp-names 里。
 * 生成器与白名单分居两个文件时靠人记得同步 —— 实测就是漏了，
 * 导致 `out.mkv.merging-<ts>-<hex>` 这类残留永远不被认成"自己的"。
 * 这里保留导出（调用方零改动），但实现只有一份。 */
const tempPathFor = require('./temp-names').tempPathFor;

module.exports = { uniquePath, tempPathFor };
