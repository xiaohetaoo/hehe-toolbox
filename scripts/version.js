#!/usr/bin/env node
'use strict';
/* 版本号规则校验 + 进位换算（2026-11-18 按用户最新规则修订）。
 *
 * 【规则】x.y.z，从 0.0.1 开始；**末位每满 10 向中位进 1**：
 *   0.0.9  -> 0.1.0
 *   0.1.9  -> 0.2.0
 *   0.9.9  -> 0.10.0     ← 关键变化（旧实现给 1.0.0，与用户规则冲突）
 *   0.10.9 -> 0.11.0
 *   0.0.14 -> 0.1.4
 *
 * 中位（y）**可以 ≥10**，不向最大位进位；最大位（x = major）只能由用户
 * 明确允许后升：CLI 里必须同时给 `--major` 与 `--approved`，否则拒绝。
 * 这就是用户原话「我的允许才能升最大的版本号」在脚本层的落实。
 *
 * 用法：
 *   node scripts/version.js                 # 校验当前 package.json
 *   node scripts/version.js 0.10.0          # 校验指定版本号
 *   node scripts/version.js --next          # 当前版本 +1（只动末位/中位）
 *   node scripts/version.js --bump 0.0.14   # 按规则进位（输出 0.1.4）
 *   node scripts/version.js --major --approved   # 升最大位（需用户明确允许）
 *   加 --write 才真的写 package.json；默认只预览。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkgPath = path.join(ROOT, 'package.json');

/* 把「末位可能超 9 的写法」规范化：只做末位 → 中位的进位。
 * 中位不向最大位进位（用户规则：0.9.9 → 0.10.0）。
 * 例：0.0.14 → 0.1.4；0.9.10 → 0.10.0；0.0.100 → 0.10.0。 */
function normalize(parts) {
  const p = parts.slice(0, 3).map((x) => Math.max(0, Math.floor(Number(x) || 0)));
  while (p.length < 3) p.push(0);
  /* 末位整段折进中位，再取余 —— 不能先取余再进位（0.0.99 会算错）。 */
  p[1] += Math.floor(p[2] / 10);
  p[2] = p[2] % 10;
  return p;
}

/* 合规判据：三段都是整数，**末位 0–9**；中位允许 ≥10（如 0.10.0）。
 * 最大位不设上限（升它由 CLI 的 --approved 把关，不在校验层拦）。 */
function isValid(parts) {
  if (!Array.isArray(parts) || ![3, 4].includes(parts.length)) return false;
  const [x, y, z] = parts;
  return Number.isInteger(x) && x >= 0
    && Number.isInteger(y) && y >= 0
    && Number.isInteger(z) && z >= 0 && z <= 9
    && (parts.length === 3 || (Number.isSafeInteger(parts[3]) && parts[3] >= 0));
}

function parse(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(0|[1-9]\d*))?$/);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4] !== undefined) {
    const revision = Number(m[4]);
    if (!Number.isSafeInteger(revision)) return null;
    parts.push(revision);
  }
  return parts;
}

function fmt(p) { return p.slice(0, 3).join('.') + (p.length === 4 ? '-' + p[3] : ''); }

/* 版本 +1：末位加一，按规则向前进位（只进到中位）。 */
function bump(parts) {
  const p = parts.slice(0, 3);
  p[2] += 1;
  return normalize(p);
}

/* 升最大位：x+1，中位/末位归零。**调用方必须已获得用户允许**。 */
function bumpMajor(parts) {
  const p = parts.slice(0, 3);
  p[0] += 1;
  p[1] = 0;
  p[2] = 0;
  return p;
}

function main() {
  const args = process.argv.slice(2);

  const isBump = args[0] === '--bump' || args[0] === '--next' || args[0] === '--major';
  if (isBump) {
    const doWrite = args.includes('--write');
    const wantMajor = args[0] === '--major';
    /* 【最大位必须用户明确允许】用户规则：我的允许才能升最大的版本号。
     * 只给 --major 而没有 --approved 一律拒绝，避免"顺手"升到 1.x。 */
    if (wantMajor && !args.includes('--approved')) {
      console.error(
        '✗ 升最大版本号需要用户明确允许。\n' +
        '  请先在对话里取得用户同意，再加 --approved 重试：\n' +
        '    node scripts/version.js --major --approved --write\n' +
        '  只升末位/中位用 --next 即可（0.9.9 → 0.10.0）。'
      );
      process.exit(1);
    }
    let base;
    if (args[0] === '--next' || wantMajor) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      base = parse(pkg.version);
      if (!base) { console.error('package.json 里的 version 无法解析'); process.exit(1); }
    } else {
      base = parse(args[1]);
      if (!base) { console.error('用法：node scripts/version.js --bump <x.y.z>'); process.exit(1); }
    }
    const next = fmt(wantMajor ? bumpMajor(base) : bump(base));
    if (!doWrite) {
      console.log(next);
      console.log('（仅预览，未写入 package.json。加 --write 才会落盘）');
      return;
    }
    /* 只替换 version 字段，不重排 package.json 的其他内容。 */
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const updated = raw.replace(/("version"\s*:\s*)"[^"]*"/, '$1"' + next + '"');
    if (updated === raw) {
      console.error('✗ 没找到 version 字段，未写入');
      process.exit(1);
    }
    fs.writeFileSync(pkgPath, updated);
    console.log('✓ 已写入 package.json：' + fmt(base) + ' → ' + next);
    console.log('别忘了同时写 docs/release-notes/v' + next + '.md');
    return;
  }

  // 校验模式
  let ver = args[0];
  if (!ver) {
    try { ver = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version; }
    catch (e) { console.error('读不到 package.json'); process.exit(1); }
  }
  const parts = parse(ver);
  if (!parts) { console.error(`✗ 版本号格式不对（应为 x.y.z 或 x.y.z-n）：${ver}`); process.exit(1); }
  if (isValid(parts)) {
    console.log(`✓ 版本号合规：${ver}`);
    return;
  }
  const fixed = fmt(normalize(parts));
  console.error(
    `✗ 版本号不合规：${ver}\n` +
    `  规则：末位 0–9（满 10 向中位进 1），中位可 ≥10，最大位需用户允许才升。\n` +
    `  应写为：${fixed}\n` +
    `  （旧的 ${ver} → 新的 ${fixed}）`
  );
  process.exit(1);
}

if (require.main === module) main();
module.exports = { normalize, isValid, parse, bump, bumpMajor, fmt };