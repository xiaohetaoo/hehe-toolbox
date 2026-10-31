'use strict';
/* 目录搬家端到端实测：在真实目录上跑完整条链，验证每个后置条件。
 *
 * 这是本项目最危险的功能（最坏情况是「源目录删了、链接是坏的、数据在别处」），
 * 所以必须用真实 IO 验证，不能只靠纯逻辑单测：
 *   1) 搬完后原路径是链接、能打开、内容正确
 *   2) 新位置数据完整（含中文文件名、嵌套子目录）
 *   3) .bak 已删除
 *   4) 危险中间态（已改名、链接未建成）能回退
 *
 * 跨盘才能搬家（同卷会被拒），所以源放系统临时目录、目标放第二块盘。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const links = require('../lib/links');
const D = require('../lib/dir-move');

let pass = 0, fail = 0;
const pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { pass++; console.log('PASS  ' + name); },
        (e) => { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
      ));
    } else { pass++; console.log('PASS  ' + name); }
  } catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

function pickOtherDrive() {
  for (const L of ['D', 'E', 'F']) {
    const root = L + ':\\';
    try {
      fs.accessSync(root);
      const probe = path.join(root, 'hehe-probe-' + Date.now());
      fs.writeFileSync(probe, 'x');
      fs.rmSync(probe);
      return root;
    } catch (e) {}
  }
  return null;
}

const otherDrive = pickOtherDrive();
if (!otherDrive) {
  console.log('SKIP 本机没有第二块可写磁盘，跳过跨盘搬家实测');
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
console.log('目标盘:', otherDrive);

/* 安全清理：先拆链接再用安全入口，绝不递归删掉可能指向数据的东西 */
async function safeCleanup(p) {
  try {
    if (fs.existsSync(p) && links.linkStat(p).isLink) await links.removeLinkOnly(p);
  } catch (e) {}
  try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
}

/* ---------- 校验层 ---------- */
t('跨盘校验能通过（真实路径）', () => {
  const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-src-'));
  const dst = path.join(otherDrive, 'hehe-mv-' + Date.now());
  try {
    const v = D.validateMove({
      src: srcRoot, dst, srcExists: true, srcIsDir: true,
      srcIsLink: false, srcIsRoot: false, srcIsCritical: false,
      dstExists: false, needBytes: 1000, freeBytes: 10 * 1024 * 1024 * 1024,
      lockedPaths: [],
    });
    assert.strictEqual(v.ok, true, '跨盘应通过：' + v.reason);
  } finally { try { fs.rmSync(srcRoot, { recursive: true, force: true }); } catch (e) {} }
});

t('同盘校验被拒（同盘搬家没意义）', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-a-'));
  const b = path.join(path.dirname(a), 'mv-b-' + Date.now());
  try {
    const v = D.validateMove({
      src: a, dst: b, srcExists: true, srcIsDir: true, srcIsLink: false,
      srcIsRoot: false, srcIsCritical: false, dstExists: false,
      needBytes: 100, freeBytes: 1e12, lockedPaths: [],
    });
    assert.strictEqual(v.code, 'SAME_VOLUME', '同盘应被拒，实际 ' + (v.code || '通过'));
  } finally { try { fs.rmSync(a, { recursive: true, force: true }); } catch (e) {} }
});

/* ---------- 完整搬家 ---------- */
t('完整搬家：复制 → 校验 → 改名 → 建链 → 验链 → 删备份', async () => {
  const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-full-'));
  const dst = path.join(otherDrive, 'hehe-mv-' + Date.now());
  const bakPath = srcRoot + '.hehe-bak';

  fs.writeFileSync(path.join(srcRoot, 'a.txt'), 'AAA');
  fs.writeFileSync(path.join(srcRoot, '中文名.txt'), '中文内容');
  fs.mkdirSync(path.join(srcRoot, 'sub'));
  fs.writeFileSync(path.join(srcRoot, 'sub', 'deep.txt'), 'DEEP');

  try {
    // 1) 复制
    await fs.promises.cp(srcRoot, dst, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    assert.ok(fs.existsSync(path.join(dst, 'a.txt')));
    assert.ok(fs.existsSync(path.join(dst, '中文名.txt')));
    assert.ok(fs.existsSync(path.join(dst, 'sub', 'deep.txt')));

    // 2) 改名 .bak
    await fs.promises.rename(srcRoot, bakPath);
    assert.ok(!fs.existsSync(srcRoot), '改名后原路径应为空');
    assert.ok(fs.existsSync(bakPath), '.bak 应存在');

    // 3) 建 junction
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', srcRoot, dst], { windowsHide: true, timeout: 15000 });
    assert.ok(fs.existsSync(srcRoot), '链接应出现');

    // 4) 验证链接
    assert.ok(fs.lstatSync(srcRoot).isSymbolicLink(), '原路径应是链接');
    const real = fs.realpathSync.native(srcRoot);
    assert.strictEqual(path.resolve(real).toLowerCase(), path.resolve(dst).toLowerCase(),
      '链接应指向新位置，实际 ' + real);
    assert.strictEqual(fs.readFileSync(path.join(srcRoot, 'a.txt'), 'utf8'), 'AAA');
    assert.strictEqual(fs.readFileSync(path.join(srcRoot, '中文名.txt'), 'utf8'), '中文内容');
    assert.strictEqual(fs.readFileSync(path.join(srcRoot, 'sub', 'deep.txt'), 'utf8'), 'DEEP');

    // 5) 删备份
    await fs.promises.rm(bakPath, { recursive: true, force: true });
    assert.ok(!fs.existsSync(bakPath), '.bak 应已删除');
    assert.ok(fs.existsSync(srcRoot), '原路径仍可访问');
  } finally {
    await safeCleanup(srcRoot);
    await safeCleanup(bakPath);
    await safeCleanup(dst);
  }
});

/* ---------- 危险中间态回退 ---------- */
t('建链接失败时能把 .bak 改回原名（数据完好）', async () => {
  const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-rb-'));
  const dst = path.join(otherDrive, 'hehe-rb-' + Date.now());
  const bakPath = srcRoot + '.hehe-bak';
  fs.writeFileSync(path.join(srcRoot, 'data.txt'), 'IMPORTANT');

  try {
    await fs.promises.cp(srcRoot, dst, { recursive: true, force: false, errorOnExist: true });
    await fs.promises.rename(srcRoot, bakPath);
    assert.ok(!fs.existsSync(srcRoot), '应处于「原路径为空」的危险中间态');

    /* 【实测】Windows 允许对不存在的目标建 junction（悬空链接），
     * mklink /J 不会报错。所以「建链接失败」要另找触发方式：
     * 用一个已存在同名项的原路径 —— 这时 mklink 会失败。 */
    fs.mkdirSync(srcRoot);          // 原位置占住，让 mklink 无法建链接
    let linkErr = null;
    try {
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', srcRoot, dst], { windowsHide: true });
    } catch (e) { linkErr = e; }
    assert.ok(linkErr, '原位置被占用时 mklink 应失败');
    fs.rmSync(srcRoot, { recursive: true, force: true });   // 清掉占位目录

    // 按 rollbackPlan('link') 的指引回退
    const plan = D.rollbackPlan('link', { bakPath, srcPath: srcRoot, dstPath: dst });
    assert.deepStrictEqual(plan.actions, ['remove-link', 'rename-bak-back']);

    // 执行「rename-bak-back」
    await fs.promises.rename(bakPath, srcRoot);
    assert.ok(fs.existsSync(srcRoot), '回退后原路径应恢复');
    assert.strictEqual(fs.readFileSync(path.join(srcRoot, 'data.txt'), 'utf8'), 'IMPORTANT', '数据必须完好');
  } finally {
    await safeCleanup(srcRoot);
    await safeCleanup(bakPath);
    await safeCleanup(dst);
  }
});

/* ---------- 链接体检在真实目录上可用 ---------- */
t('链接体检能正确分类真实链接', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-scan-'));
  const goodTarget = path.join(root, 'good-target');
  const goodLink = path.join(root, 'good-link');
  fs.mkdirSync(goodTarget);
  fs.writeFileSync(path.join(goodTarget, 'x.txt'), 'x');
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', goodLink, goodTarget], { windowsHide: true });

  // 造一个僵尸链接：先建再删目标
  const deadTarget = path.join(root, 'dead-target');
  const deadLink = path.join(root, 'dead-link');
  fs.mkdirSync(deadTarget);
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', deadLink, deadTarget], { windowsHide: true });
  fs.rmSync(deadTarget, { recursive: true, force: true });

  try {
    const good = links.classifyLink(goodLink, { target: goodTarget });
    assert.strictEqual(good.kind, 'ok', '正常链接应判 ok，实际 ' + good.kind + '：' + good.reason);

    const dead = links.classifyLink(deadLink, { target: deadTarget });
    assert.ok(dead.kind === 'dead' || dead.kind === 'loop',
      '僵尸链接应判 dead/loop，实际 ' + dead.kind + '：' + dead.reason);

    // 清理僵尸链接必须安全（不碰任何目标）
    await links.removeLinkOnly(deadLink);
    assert.ok(!fs.existsSync(deadLink), '僵尸链接应被删除');
  } finally {
    await safeCleanup(goodLink);
    await safeCleanup(deadLink);
    await safeCleanup(goodTarget);
    await safeCleanup(root);
  }
});

Promise.all(pending).then(() => {
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
});
