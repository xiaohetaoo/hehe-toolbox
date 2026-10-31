'use strict';
/* 链接安全语义测试（这是本项目最危险的一块，必须逐条钉死）。
 *
 * 核心命题：removeLinkOnly 只能删链接，绝不会碰目标数据；
 * 且当调用方误传「解析后的目标路径」时，必须被拦住而不是删掉真实数据。
 *
 * 会被测的行为全部亲测过（见 lib/links.js 顶部注释里的实测结论）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('../lib/links');

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

function mkJunction() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lnk-'));
  const target = path.join(root, 'real-data');
  const link = path.join(root, 'link');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'precious.txt'), '不能被删的数据');
  fs.mkdirSync(path.join(target, 'sub'));
  fs.writeFileSync(path.join(target, 'sub', 'deep.txt'), '深层数据');
  const r = execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target],
    { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  if (!fs.existsSync(link)) throw new Error('建 junction 失败: ' + r);
  return { root, target, link };
}
function cleanup(c) {
  try { fs.rmSync(c.root, { recursive: true, force: true }); }
  catch (e) { try { execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', c.root], { windowsHide: true }); } catch (e2) {} }
}

/* ---------- 1. 识别 ---------- */
t('linkStat 能识别 junction 且不跟随', () => {
  const c = mkJunction();
  try {
    const st = L.linkStat(c.link);
    assert.strictEqual(st.isLink, true, 'junction 应被识别为链接');
    assert.strictEqual(st.exists, true);
    // 对普通目录应报 isLink=false
    assert.strictEqual(L.linkStat(c.target).isLink, false, '普通目录不该被当成链接');
  } finally { cleanup(c); }
});

t('linkStat 对不存在的路径返回 exists=false 而不抛', () => {
  const st = L.linkStat(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now()));
  assert.strictEqual(st.exists, false);
  assert.strictEqual(st.isLink, false);
});

/* ---------- 2. 安全删除：只删链接 ---------- */
t('removeLinkOnly 删掉链接但目标数据完好', async () => {
  const c = mkJunction();
  try {
    const r = await L.removeLinkOnly(c.link);
    assert.strictEqual(r.removed, true);
    assert.ok(!fs.existsSync(c.link), '链接应已消失');
    assert.ok(fs.existsSync(c.target), '目标目录必须还在');
    assert.ok(fs.existsSync(path.join(c.target, 'precious.txt')), '目标里的文件必须完好');
    assert.ok(fs.existsSync(path.join(c.target, 'sub', 'deep.txt')), '目标的子目录必须完好');
  } finally { cleanup(c); }
});

t('removeLinkOnly 会记录目标（供汇报用）但不使用它删除', async () => {
  const c = mkJunction();
  try {
    const r = await L.removeLinkOnly(c.link);
    assert.ok(r.target, '应记录目标路径');
    assert.ok(String(r.target).toLowerCase().indexOf('real-data') !== -1, '目标应指向 real-data');
  } finally { cleanup(c); }
});

/* ---------- 3. 最关键：误传「解析后目标」必须被拦住 ---------- */
t('把 resolveReal 的结果传给 removeLinkOnly，会被拒绝而不是删数据', async () => {
  const c = mkJunction();
  try {
    const resolved = fs.realpathSync.native(c.link);   // 这就是「解析后的目标」
    let threw = null;
    try { await L.removeLinkOnly(resolved); } catch (e) { threw = e; }

    assert.ok(threw, '对目标路径的删除必须报错');
    assert.strictEqual(threw.code, 'LINK_UNSAFE', '应抛 LINK_UNSAFE，实际 ' + threw.code);
    // 最重要的后置条件：数据一点没少
    assert.ok(fs.existsSync(c.target), '目标目录必须还在');
    assert.ok(fs.existsSync(path.join(c.target, 'precious.txt')), '目标里的文件必须完好');
  } finally { cleanup(c); }
});

t('assertIsLinkItself 拒绝普通目录/文件', () => {
  const c = mkJunction();
  try {
    assert.throws(() => L.assertIsLinkItself(c.target), /不是链接/, '普通目录应被拒绝');
  } finally { cleanup(c); }
});

t('assertIsLinkItself 接受真正的链接', () => {
  const c = mkJunction();
  try {
    const r = L.assertIsLinkItself(c.link);
    assert.strictEqual(r.st.isLink, true);
  } finally { cleanup(c); }
});

/* ---------- 4. 卷与根判定 ---------- */
t('sameVolume 判断同卷', () => {
  const tmp = os.tmpdir();
  assert.strictEqual(L.sameVolume(tmp, path.join(tmp, 'x')).toString(), 'true');
});

t('isVolumeRootOnly 识别盘符根', () => {
  assert.ok(L.isVolumeRootOnly('C:\\'), 'C:\\ 是盘符根');
  assert.ok(!L.isVolumeRootOnly('C:\\Windows'), 'C:\\Windows 不是盘符根');
});

t('volumeRoot 取盘符', () => {
  const v = L.volumeRoot('C:\\Users\\x');
  assert.strictEqual(v, 'c:\\');
});

/* ---------- 5. 体检分类 ---------- */
t('classifyLink 对正常链接判为 ok', () => {
  const c = mkJunction();
  try {
    const r = L.classifyLink(c.link, { type: 'junction', target: c.target });
    assert.strictEqual(r.kind, 'ok', '正常链接应判 ok，实际 ' + r.kind + '（' + r.reason + '）');
    assert.ok(r.target, '应给出解析后的目标');
  } finally { cleanup(c); }
});

t('classifyLink 对僵尸链接判为 dead', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-'));
  const target = path.join(root, 'gone');
  const link = path.join(root, 'deadlink');
  fs.mkdirSync(target);
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { windowsHide: true });
  // 删掉目标 → 链接变僵尸
  fs.rmSync(target, { recursive: true, force: true });
  try {
    const r = L.classifyLink(link, { type: 'junction', target });
    assert.ok(r.kind === 'dead' || r.kind === 'loop',
      '目标不存在应判 dead（或 loop），实际 ' + r.kind + '：' + r.reason);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); }
    catch (e) { try { execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', root], { windowsHide: true }); } catch (e2) {} }
  }
});

t('classifyLink 对普通目录标记 notLink', () => {
  const c = mkJunction();
  try {
    const r = L.classifyLink(c.target, null);
    assert.strictEqual(r.notLink, true, '普通目录应标记 notLink');
  } finally { cleanup(c); }
});

/* ---------- 目标所在卷不可用 ≠ 僵尸链接 ----------
 * 移动硬盘/U 盘/网络盘没插时，realpath 必然失败。早期实现失败即判 dead，
 * 于是这些仍然有效的链接被列为「目标已不存在，可以清理」——
 * 用户点一下批量清理，链接就没了（数据没丢，但原路径打不开）。
 * 卷不可达是**暂时**状态，必须归 crossvol（不可清理）。 */
t('目标声明在不可用卷上 → 判 crossvol，不是 dead', () => {
  const c = mkJunction();
  try {
    /* 链接本身在本机卷上，但 readlink 声明的目标在 Q:\ 这种不存在的盘。
     * 这是移动硬盘拔掉时的真实形态。 */
    const r = L.classifyLink(c.link, { type: 'junction', target: 'Q:\\gone\\dir' });
    assert.strictEqual(r.kind, 'crossvol',
      '卷不可用时应判 crossvol，实际 ' + r.kind + '：' + r.reason);
    assert.ok(/不可用/.test(r.reason), '原因要说清卷不可用：' + r.reason);
  } finally { cleanup(c); }
});

t('crossvol 在 LINK_KINDS 里明确标注不可清理', () => {
  const k = L.LINK_KINDS.crossvol;
  assert.ok(k, 'crossvol 类型缺失');
  assert.strictEqual(k.sev, 'warn', 'crossvol 应是警告级而不是坏');
  assert.ok(/不可清理/.test(k.desc), 'crossvol 的描述必须写明不可清理：' + k.desc);
});

t('卷可用但目标确实没了 → 仍判 dead（该清的还得能清）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dead2-'));
  const target = path.join(root, 'gone');
  const link = path.join(root, 'deadlink');
  fs.mkdirSync(target);
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { windowsHide: true });
  fs.rmSync(target, { recursive: true, force: true });
  try {
    const tt = fs.readlinkSync(link);
    const r = L.classifyLink(link, { type: 'junction', target: tt });
    assert.strictEqual(r.kind, 'dead',
      '同卷目标消失应判 dead（可清理），实际 ' + r.kind + '：' + r.reason);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); }
    catch (e) { try { execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', root], { windowsHide: true }); } catch (e2) {} }
  }
});

/* ---------- 6. dirSize 不跟随链接 ---------- */
t('dirSize 统计字节且不把链接目标算进来', async () => {
  const c = mkJunction();
  try {
    // 在根下放一个真文件
    const other = path.join(c.root, 'own.txt');
    fs.writeFileSync(other, 'x'.repeat(100));
    const r = await L.dirSize(c.root);
    // c.root 下有 target(真目录，含 2 个文件) + link(链接，应被跳过) + own.txt
    assert.ok(r.files >= 3, '应统计到真实文件，实际 ' + r.files);
    // 链接不应让文件数翻倍
    assert.ok(r.files <= 4, '不应把链接目标重复计入，实际 ' + r.files);
  } finally { cleanup(c); }
});

Promise.all(pending).then(() => {
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
});
