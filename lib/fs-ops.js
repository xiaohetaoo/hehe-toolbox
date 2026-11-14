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

/**
 * 生成 ffmpeg concat 解复用器清单里的一行：`file '<路径>'`。
 *
 * 【为什么必须转义单引号】录制分段目录在 %TEMP% 下，路径里含 Windows 用户名。
 * 用户名带单引号（如 O'Brien）时，未转义的 `file 'C:/Users/O'Brien/…'`
 * 会在 O 后面的引号处提前闭合，concat 直接失败 —— 实测（ffmpeg 6.x/7.x）：
 * 暂停过的录制（多段拼接）整段降级成「只保住第一段」。
 *
 * 【转义形态是实测挑出来的，不是猜的】对含单引号的路径逐形态真跑 concat：
 *   · 引号内写 \'        → 失败（单引号内反斜杠是字面量，不转义）
 *   · 双引号包裹          → 失败（concat 不认双引号）
 *   · 闭合引号式 '…'\''…' → 成功（结束引号 + 转义引号 + 重开引号）
 *   · 无引号 + 反斜杠转义  → 成功
 * 取闭合引号式：与 shell 单引号转义同构，路径里其余字符（空格、中文、
 * 反斜杠已统一成正斜杠）都不需要再处理。
 *
 * @param {string} p 分段文件的绝对路径
 * @returns {string} 清单行（不含行尾换行）
 */
function concatFileLine(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/');
  return "file '" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * 把 src 放进 root 下的 relName 位置，**绝不覆盖已存在的文件**。
 *
 * 【为什么不能 uniquePath + rename】
 * uniquePath 是「先查存在、再返回名字」，Windows 的 rename 是
 * MOVEFILE_REPLACE_EXISTING 语义（目标已存在就覆盖，实测）。两步之间
 * 只要有人创建了同名文件（并发解压、同步盘、资源管理器里手建），
 * 那个文件就被静默覆盖 —— 而失败回滚还会把覆盖后的内容搬走再删掉，
 * 用户文件彻底消失。zip:extract 早就改用 `open(...,'wx')` 排他创建，
 * 7z 这条提交路径漏了（第四轮审查）。
 *
 * 做法：用 `open('wx')` 先原子地占住名字（EEXIST 就换下一个编号），
 * 再 rename 覆盖**我们自己刚创建的空占位文件** —— 这一步无论何时发生
 * 都只可能盖掉自己的东西。
 *
 * @param {string} src 已有文件（staging 里的那份）
 * @param {string} root 目标根目录（relName 必须落在它内部）
 * @param {string} relName 目标相对名
 * @returns {Promise<string>} 最终落盘路径
 */
async function placeUnique(src, root, relName) {
  const guard = require('./path-guard');
  const base = guard.resolveInside(root, relName);
  const dir = path.dirname(base);
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  for (let i = 0; i < 10000; i++) {
    const cand = i === 0 ? base : path.join(dir, `${stem}(${i})${ext}`);
    let fh;
    try {
      fh = await fs.promises.open(cand, 'wx');   // 原子占位：已存在则 EEXIST
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    try { await fh.close(); } catch (e) { /* 关不掉也能继续，rename 会失败并回滚 */ }
    try {
      await fs.promises.rename(src, cand);
      return cand;
    } catch (e) {
      /* rename 失败：删掉自己刚建的占位文件再抛，别留一个空文件冒充结果 */
      await fs.promises.rm(cand, { force: true }).catch(() => {});
      throw e;
    }
  }
  throw new Error('无法生成不重名的目标路径：' + relName);
}

module.exports = { uniquePath, tempPathFor, concatFileLine, placeUnique };
