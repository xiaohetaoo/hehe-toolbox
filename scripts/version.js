#!/usr/bin/env node
'use strict';
/* 版本号规则校验 + 进位换算。
 *
 * 【规则】每一段都只能是个位数（0–9），满 10 就向前一段进位：
 *   0.0.9  -> 0.1.0
 *   0.1.9  -> 0.2.0
 *   0.9.9  -> 1.0.0
 *   0.0.14 -> 0.1.4   （末位 14 满 10 进 1 到中位，末位留 4）
 *
 * 换句话说：版本号按「三段十进制、每段 0–9」书写，绝不出现 0.0.14 这种
 * 某一段 ≥10 的形态。历史上确实出现过 0.0.13、0.0.14，所以需要这个校验。
 *
 * 用法：
 *   node scripts/version.js                 # 校验当前 package.json
 *   node scripts/version.js 0.0.14          # 校验指定版本号
 *   node scripts/version.js --bump 0.0.14   # 按规则进位（输出 0.1.4）
 *   node scripts/version.js --next          # 当前版本 +1 并规范化
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkgPath = path.join(ROOT, 'package.json');

/* 把「可能超 9 的十进制写法」规范化成每段 0–9 的形态。
 *
 * 做法：从末位往前，把当前段整体（不只是余数）折进高位，最后统一取余。
 * 关键坑：不能「先取余再把商进高位」—— 从末位往前走时，末位的进位会加到
 * 已经处理过的中位上，那一轮就不会再对中位做进位，于是
 * 0.0.99 会得到 0.9.9（数值接近但形态不规范，本应是 1.0.0）。
 * 正确写法是把整段累加进高位，等循环结束后再逐位取余。 */
function normalize(parts) {
  const p = parts.slice(0, 3).map((x) => Math.floor(Number(x) || 0));
  while (p.length < 3) p.push(0);
  // 先累加进位：从末位往前，把当前段整体折进高位
  for (let i = p.length - 1; i > 0; i--) {
    if (p[i] > 9) {
      p[i - 1] += Math.floor(p[i] / 10);
      p[i] = p[i] % 10;
    }
  }
  // 此时低位已规范，但高位可能因进位而 >9，需要再走一遍直到稳定
  // （0.0.99 → 末位 99 折成 中位+9,末位9 → 中位 10 → 再进 → 1.0.0）
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 100) {
    changed = false;
    for (let i = p.length - 1; i > 0; i--) {
      if (p[i] > 9) {
        p[i - 1] += Math.floor(p[i] / 10);
        p[i] = p[i] % 10;
        changed = true;
      }
    }
  }
  // 最高位允许继续增长（1.0.0 之上是 1.0.1；不会往第 4 段加）
  return p;
}

function isValid(parts) {
  if (!Array.isArray(parts) || parts.length !== 3) return false;
  return parts.every((x) => Number.isInteger(x) && x >= 0 && x <= 9);
}

function parse(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function fmt(p) { return p.join('.'); }

/* 版本 +1：末位加一，然后按规则进位规范化 */
function bump(parts) {
  const p = parts.slice(0, 3);
  p[2] += 1;
  return normalize(p);
}

function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--bump' || args[0] === '--next') {
    let base;
    if (args[0] === '--next') {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      base = parse(pkg.version);
      if (!base) { console.error('package.json 里的 version 无法解析'); process.exit(1); }
    } else {
      base = parse(args[1]);
      if (!base) { console.error('用法：node scripts/version.js --bump <x.y.z>'); process.exit(1); }
    }
    console.log(fmt(bump(base)));
    return;
  }

  // 校验模式
  let ver = args[0];
  if (!ver) {
    try { ver = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version; }
    catch (e) { console.error('读不到 package.json'); process.exit(1); }
  }
  const parts = parse(ver);
  if (!parts) { console.error(`✗ 版本号格式不对（应为 x.y.z）：${ver}`); process.exit(1); }
  if (isValid(parts)) {
    console.log(`✓ 版本号合规：${ver}`);
    return;
  }
  const fixed = fmt(normalize(parts));
  console.error(
    `✗ 版本号不合规：${ver}\n` +
    `  规则：每一段只能是 0–9，满 10 向前进位。\n` +
    `  应写为：${fixed}\n` +
    `  （旧的 ${ver} → 新的 ${fixed}）`
  );
  process.exit(1);
}

if (require.main === module) main();
module.exports = { normalize, isValid, parse, bump, fmt };
