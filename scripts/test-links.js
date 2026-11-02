'use strict';
const { t, done, readMain } = require('./lib/harness');
/* 读项目内文件（原 test-round10-fixes.js 的 local 助手）。 */
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

const cp = require('child_process');
const stripComments = require('../lib/src-scan').stripComments;
const mainSrc = readMain({ raw: true });
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

t('权限被拒的活链接判「无法判断」，不再可清理', async () => {
  const L = require('../lib/links.js');
  const me = cp.execFileSync('powershell', ['-NoProfile', '-Command',
    '[Security.Principal.WindowsIdentity]::GetCurrent().Name'], { encoding: 'utf8' }).trim();
  const base = path.join(os.tmpdir(), 'hehe-round10-link');
  fs.rmSync(base, { recursive: true, force: true });
  const realDir = path.join(base, 'real target');
  const linkDir = path.join(base, 'the link');
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(path.join(realDir, 'inside.txt'), 'data');
  try {
    fs.symlinkSync(realDir, linkDir, 'junction');
    assert.strictEqual(L.classifyLink(linkDir, { target: realDir }).kind, 'ok', '基线应判 ok');
    cp.execFileSync('icacls', [linkDir, '/deny', me + ':(F)'], { encoding: 'utf8' });
    /* 权限拒绝后 realpath 会失败，但链接与目标都还在 */
    let rp = 'ok';
    try { fs.realpathSync.native(linkDir); } catch (e) { rp = e.code; }
    if (/EPERM|EACCES/i.test(String(rp))) {
      const cls = L.classifyLink(linkDir, { target: realDir });
      assert.strictEqual(cls.kind, 'opaque', '活链接被判成 ' + cls.kind + '（会被当僵尸删掉）');
      assert.ok(/EPERM|EACCES|权限/.test(cls.reason), '理由要说清是权限：' + cls.reason);
    }
    cp.execFileSync('icacls', [linkDir, '/remove:d', me], { encoding: 'utf8' });
    fs.rmSync(realDir, { recursive: true, force: true });
    assert.strictEqual(L.classifyLink(linkDir, { target: realDir }).kind, 'dead', '目标真没了才是僵尸');
  } finally {
    /* 【清理必须先把拒绝项撤掉】
     * 这条用例会给自己加一条 DENY (F)：若中途断言失败跳到 finally，
     * 直接 rm 会因为权限被拒而删不掉，残留目录还会让**下一次**运行
     * 在本用例的 mkdir 处报 EPERM —— 把「测试失败」变成「测试环境坏了」。 */
    try { cp.execFileSync('icacls', [linkDir, '/remove:d', me], { stdio: 'pipe' }); } catch (e) {}
    try { cp.execFileSync('icacls', [realDir, '/remove:d', me], { stdio: 'pipe' }); } catch (e) {}
    fs.rmSync(base, { recursive: true, force: true });
  }
});

t('新的 opaque 类在三处都登记了（否则会被当成「正常」或渲染崩）', () => {
  const L = require('../lib/links.js');
  assert.ok(L.LINK_KINDS.opaque, 'lib/links.js 的 LINK_KINDS 缺 opaque');
  const code = stripComments(mainSrc);
  assert.ok(/groups = \{ ok: \[\], dead: \[\], loop: \[\], system: \[\], crossvol: \[\], opaque: \[\] \}/.test(code),
    'main.js 的 groups 必须登记 opaque（漏了会被兜底塞进「正常」）');
  const ui = stripComments(read('js/tools/link-doctor.js'));
  assert.ok(/opaque: \{ title:/.test(ui), 'link-doctor 的 KIND_META 缺 opaque');
  assert.ok(/ORDER = \['dead', 'loop', 'system', 'crossvol', 'opaque', 'ok'\]/.test(ui),
    'ORDER 里必须包含 opaque（否则该组不显示）');
});

t('link:remove 仍然只删 dead（opaque 自动被跳过）', () => {
  const code = stripComments(mainSrc);
  assert.ok(/if \(cls\.kind !== 'dead'\)/.test(code), 'link:remove 的二次校验必须仍只放行 dead');
});

/* ================= ⑦ 锁卡粒度 ================= */

t('链接性质判定：目录→junction、文件→符号链接、判不出→如实报错', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r10nat-'));
  try {
    const dir = path.join(root, 'd');
    const file = path.join(root, 'f.txt');
    fs.mkdirSync(dir);
    fs.writeFileSync(file, 'x');
    /* 直接把 linkNature 抽出来跑（它只依赖 fs） */
    const start = mainSrc.indexOf('function linkNature(');
    let i = mainSrc.indexOf('{', start), depth = 0;
    for (; i < mainSrc.length; i++) {
      if (mainSrc[i] === '{') depth++;
      else if (mainSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const linkNature = new Function('fs', mainSrc.slice(start, i) + '\nreturn linkNature;')(fs);
    const jdir = path.join(root, 'jdir');
    fs.symlinkSync(dir, jdir, 'junction');
    assert.strictEqual(linkNature(jdir), 'dir', '目录链接应判 dir');
    assert.strictEqual(linkNature(path.join(root, '不存在')), 'unknown', '判不出时必须是 unknown');
    let madeFileLink = false;
    const flink = path.join(root, 'flink.txt');
    try { fs.symlinkSync(file, flink); madeFileLink = true; } catch (e) { /* 需要特权 */ }
    if (madeFileLink) {
      assert.strictEqual(linkNature(flink), 'file', '文件符号链接应判 file（不能当目录处理）');
    }
    /* 静态兜底：重建时必须按性质分流，且判不出时拒绝重建（不许猜） */
    const code = stripComments(mainSrc);
    assert.ok(/await fsp\.symlink\(absTarget, dstChild, 'junction'\)/.test(code), '缺 junction 分支');
    assert.ok(/await fsp\.symlink\(absTarget, dstChild\);/.test(code), '缺「文件符号链接」分支');
    assert.ok(/无法判断这个链接指向目录还是文件，拒绝重建/.test(code), '判不出时必须拒绝而不是硬建 junction');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('重建链接时「文件」必须走符号链接分支（不能一律 junction）', async () => {
  /* 【为什么要有这条行为用例】
   * 只断言源码里「有那行 fsp.symlink(absTarget, dstChild)」是不够的：
   * 把条件改成 `else if (false)` 那行仍在源码里，静态检查照样绿 ——
   * 实测确实出现过这种「假绿」。这里真的跑一次 restoreLinksIntoTarget，
   * 并把性质**指定为 file**：
   *   - 走对了分支：要么建成（created=1），要么因缺符号链接特权而失败，
   *     但失败原因绝不会是「无法判断」；
   *   - 分支被关掉：会掉进 else，报「无法判断这个链接指向目录还是文件」，被抓出来。 */
  const fsp = fs.promises;
  function extract(name, isAsync) {
    const pat = (isAsync ? 'async function ' : 'function ') + name + '(';
    const start = mainSrc.indexOf(pat);
    if (start < 0) throw new Error('not found: ' + name);
    let i = mainSrc.indexOf('{', start), depth = 0;
    for (; i < mainSrc.length; i++) {
      if (mainSrc[i] === '{') depth++;
      else if (mainSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return mainSrc.slice(start, i);
  }
  const pathExists = async (p) => { try { await fsp.access(p); return true; } catch (e) { return false; } };
  const mod = new Function('fsp', 'path', 'fs', 'pathExists',
    extract('relKey', false) + '\n' + extract('buildLinkKeySet', false) + '\n'
    + extract('linkNature', false) + '\n'
    + extract('copyTreeExcludingLinks', true) + '\n' + extract('restoreLinksIntoTarget', true) + '\n'
    + 'return { copyTreeExcludingLinks, restoreLinksIntoTarget, linkNature };')(fsp, path, fs, pathExists);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r10file-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'inner.txt'), 'inner');
    const jlink = path.join(src, 'jlink');
    fs.symlinkSync(path.join(src, 'sub'), jlink, 'junction');
    const dst = path.join(root, 'dst');
    await mod.copyTreeExcludingLinks(src, dst, [jlink]);
    const natures = new Map([[jlink.toLowerCase(), 'file']]);
    const rr = await mod.restoreLinksIntoTarget(src, dst, [jlink], natures);
    if (rr.created === 1) {
      /* 建成时必须是符号链接（不是 junction）：junction 的 readlink 带 \\?\ 前缀 */
      const t = fs.readlinkSync(path.join(dst, 'jlink'));
      assert.ok(!/^\\\\\?\\/.test(t), '文件分支建出来的居然是 junction（readlink=' + t + '）');
    } else {
      assert.ok(rr.failed.length === 1, '失败时应记一条：' + JSON.stringify(rr.failed));
      assert.ok(!/无法判断/.test(rr.failed[0].error),
        '被当成「性质不明」拒绝了 —— 文件符号链接分支没生效：' + rr.failed[0].error);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

done();
