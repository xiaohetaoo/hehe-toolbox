'use strict';
/* 【文件定位：历史轮次回归，不是模块测试】
 * 本文件为历史轮次回归，行为断言应逐步迁往 test-<模块>.js；新测试不要加到这里。
 * 迁移目标见 scripts/test-test-map.js 打印的「lib 模块 → 测试文件」地图：
 * 找某个模块的测试时，先看那张表，再按模块名找 test-<模块>.js。
 * 保留按轮次命名的理由：每一条断言都对应一次真实故障的现场，
 * 合并进模块文件会丢掉「这一批是一起发现的」这条线索。
 */
/* 原脚本用 cases 收集 + 串行 for 循环，输出严格按注册顺序。
 * 这里显式指定 order:'sequential' 以保持迁移前的输出顺序不变。 */
const { createSuite, readMain } = require('./lib/harness');
const { t, done } = createSuite({ order: 'sequential' });
/* 本轮 8 项修复的回归测试（对应外部报告 1..8 + 两个额外项）。
 *
 * 这些用例的共同特点是：**只测静态文本抓不住，必须测行为或配平**。
 * 所以凡是能跑真实现的，都跑真实现；纯结构约束（如「不要重复全树扫描」）
 * 才退回到源码断言，并且断言的是一条明确的代码特征，不是模糊的包含。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/* 任务 5 把「目录搬家 + 权限/链接」两个域搬到了 ipc/acl-links.js：
 * 这里读「主进程全部源码」（main.js 在前，ipc/ 下的文件按名排序在后）——
 * 断言的语义是「主进程里有这个实现」，与它被放在哪个文件无关。 */
const mainSrc = readMain();
const BS = String.fromCharCode(92);

/* 【stripComments 统一用 lib/src-scan.js 的实现，不要在这里另写一份】
 * 原来这几行是朴素实现：先用两条正则分别去掉块注释与整行行注释。
 * 它有两个真实缺陷：
 *   ① 不识别正则字面量。net-tools.js 里的字符类含一个双引号，
 *      朴素实现会把它当成字符串开头，之后所有注释与字符串判断全部错位
 *      （lib/src-scan.js 的头部注释记录了这次事故）。
 *   ② 只剥「整行」注释（行首到行尾的那一类），行尾注释里的文字被留下，
 *      于是「某个词只出现在注释里」也会被当成代码命中，断言假绿。
 * 实测同一份 main.js：朴素实现剥后 164145 字符，src-scan 剥后 163767 字符 ——
 * 差的 378 字符正是没被去掉的行尾注释，它们会参与后续正则匹配。
 */

const stripComments = require('../lib/src-scan').stripComments;
function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { try { cp.execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', dir], { windowsHide: true }); } catch (e2) {} }
}

/* ================= 问题 1：占用检查只注册普通文件、失败不吞 ================= */
t('问题1：两处占用检查都用 collectLockProbe（只注册普通文件）', () => {
  const code = stripComments(mainSrc);
  const n = (code.match(/collectLockProbe\(/g) || []).length;
  /* 定义 1 次 + 两处调用 */
  assert.ok(n >= 3, 'collectLockProbe 出现 ' + n + ' 次，应有定义 + 两处调用');
  assert.ok(!/names\.map\(\(n\)\s*=>\s*path\.join\(srcAbs,\s*n\)\)/.test(code),
    '还在把 readdir 的全部条目名拼成 probe（目录/链接会留下，整批 ERR 5）');
});

t('问题1：collectLockProbe 只收 isFile()，且不跟随链接', () => {
  const fn = mainSrc.match(/async function collectLockProbe\(dir\)[\s\S]*?\n\}/);
  assert.ok(fn, '找不到 collectLockProbe');
  const code = stripComments(fn[0]);
  assert.ok(/withFileTypes: true/.test(code), '必须用 withFileTypes 拿 Dirent');
  assert.ok(/if \(!ent\.isFile\(\)\) continue;/.test(code),
    '必须只收普通文件 —— 目录/junction 会让整批查询 ERR 5');
});

t('问题1：占用查询失败不再被 .catch(() => null) 静默吞掉', () => {
  const code = stripComments(mainSrc);
  /* 只检查搬家相关的两段：不允许出现「rmQueryLockers(...).catch(() => null)」 */
  assert.ok(!/rmQueryLockers\([^)]*\)\.catch\(\(\)\s*=>\s*null\)/.test(code),
    '仍在用 .catch(() => null) 把查询失败吞成「没有占用」');
  assert.ok(/lockCheckError/.test(code),
    '应把查询失败带进 lockCheckError，让用户看到「查询失败」而不是「没有占用」');
});

t('问题1（行为）：含 junction 的目录，collectLockProbe 不会把链接注册进去', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lkp-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'a');
  fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'b');
  const junction = path.join(src, 'jlink');
  try {
    cp.execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction, path.join(src, 'sub')],
      { windowsHide: true, stdio: 'ignore' });

    /* 抽出真实现求值 */
    const srcFn = mainSrc.match(/async function collectLockProbe\(dir\)[\s\S]*?\n\}/)[0];
    const fsp = fs.promises;
    const fn = new Function('fsp', 'path', srcFn + '\nreturn collectLockProbe;')(fsp, path);
    const r = await fn(src);

    assert.strictEqual(r.error, null, '不该报错：' + r.error);
    assert.strictEqual(r.files.length, 1, '只应收 1 个普通文件，实际 ' + r.files.length);
    assert.ok(r.files[0].endsWith('a.txt'), '收到的应是 a.txt，实际 ' + r.files[0]);
    /* 关键：链接和子目录都不在里面 */
    assert.ok(!r.files.some((f) => f.indexOf('jlink') !== -1), '链接不该被注册（会让整批 ERR 5）');
    assert.ok(!r.files.some((f) => f.indexOf('sub') !== -1), '子目录不该被注册');
  } finally { rmDir(root); }
});

/* ================= 问题 2：mine 精确匹配，不做子串 ================= */
t('问题2：DOMAIN\\admin + BUILTIN\\Administrators(F) 时 hasFull 必须为 false', () => {
  const A = require('../lib/acl-repair');
  const out = [
    'C:' + BS + 'x' + BS + 'a.txt BUILTIN' + BS + 'Administrators:(I)(F)',
    '            BUILTIN' + BS + 'Users:(I)(RX)',
  ].join('\n');
  const r = A.parseIcacls(out, 'DOMAIN' + BS + 'admin');
  assert.strictEqual(r.hasFull, false,
    'hasFull 必须为 false —— admin 不能蹭上 Administrators 的完全控制');
  assert.strictEqual(r.anyFull, true, 'anyFull 仍应为 true（Administrators 确实有 F）');
});

t('问题2：DOMAIN\\sys 与 DOMAIN\\user 同样不得蹭上系统/用户组', () => {
  const A = require('../lib/acl-repair');
  const out = [
    'C:' + BS + 'x' + BS + 'a.txt NT AUTHORITY' + BS + 'SYSTEM:(I)(F)',
    '            BUILTIN' + BS + 'Users:(I)(F)',
  ].join('\n');
  for (const u of ['DOMAIN' + BS + 'sys', 'DOMAIN' + BS + 'user']) {
    const r = A.parseIcacls(out, u);
    assert.strictEqual(r.hasFull, false, u + ' 不该被判成有完全控制');
  }
});

t('问题2：真正属于自己的 ACE 仍要认出来（别矫枉过正）', () => {
  const A = require('../lib/acl-repair');
  const me = 'DOMAIN' + BS + 'me';
  const out = 'C:' + BS + 'x' + BS + 'a.txt ' + me + ':(I)(F)';
  const r = A.parseIcacls(out, me);
  assert.strictEqual(r.hasFull, true, '自己的 (F) 必须被认出来');
  /* 只写用户名（无域）也应匹配 */
  const r2 = A.parseIcacls(out, 'me');
  assert.strictEqual(r2.hasFull, true, '去掉域前缀后也应匹配');
});

t('问题2：deniedForMe 也不再用子串匹配', () => {
  const A = require('../lib/acl-repair');
  const out = 'C:' + BS + 'x' + BS + 'a.txt BUILTIN' + BS + 'Administrators:(DENY)(F)';
  const r = A.parseIcacls(out, 'DOMAIN' + BS + 'admin');
  assert.strictEqual(r.deniedForMe, false, 'admin 不该蹭上 Administrators 的 DENY 项');
  const r2 = A.parseIcacls(out, 'BUILTIN' + BS + 'Administrators');
  assert.strictEqual(r2.deniedForMe, true, '真的是 Administrators 时 DENY 应命中');
});

/* ================= 问题 3：含空格的域组主体不被截断 ================= */
t('问题3：DOMAIN\\Power Users 解析成完整主体，不截成 Users', () => {
  const A = require('../lib/acl-repair');
  const r = A.parseIcacls('C:' + BS + 'x' + BS + 'a.txt DOMAIN' + BS + 'Power Users:(I)(M)');
  assert.strictEqual(r.entries[0].principal, 'DOMAIN' + BS + 'Power Users',
    '实际 ' + JSON.stringify(r.entries[0].principal));
});

t('问题3：NT AUTHORITY\\SYSTEM 保持不变（不被截成 AUTHORITY\\SYSTEM）', () => {
  const A = require('../lib/acl-repair');
  const r = A.parseIcacls('C:' + BS + 'x' + BS + 'a.txt NT AUTHORITY' + BS + 'SYSTEM:(I)(F)');
  assert.strictEqual(r.entries[0].principal, 'NT AUTHORITY' + BS + 'SYSTEM',
    '实际 ' + JSON.stringify(r.entries[0].principal));
});

t('问题3：Remote Desktop Users / Domain Admins / CREATOR OWNER 都完整', () => {
  const A = require('../lib/acl-repair');
  const samples = [
    ['DOMAIN' + BS + 'Remote Desktop Users', 'DOMAIN' + BS + 'Remote Desktop Users'],
    ['MyCompany' + BS + 'Domain Admins', 'MyCompany' + BS + 'Domain Admins'],
    ['CREATOR OWNER', 'CREATOR OWNER'],
    ['BUILTIN' + BS + 'Users', 'BUILTIN' + BS + 'Users'],
  ];
  for (const [raw, want] of samples) {
    const r = A.parseIcacls('C:' + BS + 'x' + BS + 'a.txt ' + raw + ':(I)(F)');
    assert.strictEqual(r.entries[0].principal, want, raw + ' -> ' + JSON.stringify(r.entries[0].principal));
  }
});

t('问题3：路径里含空格时仍能把路径剥掉', () => {
  const A = require('../lib/acl-repair');
  const r = A.parseIcacls('C:' + BS + 'my docs' + BS + 'a.txt BUILTIN' + BS + 'Users:(I)(F)');
  assert.strictEqual(r.entries[0].principal, 'BUILTIN' + BS + 'Users',
    '实际 ' + JSON.stringify(r.entries[0].principal));
});

/* ================= 问题 4：家目录下的 Documents 不该被拦 ================= */
t('问题4：自己家目录下的 Documents/Desktop/Downloads 允许改权限与搬家', () => {
  const pg = require('../lib/path-guard');
  const home = os.homedir();
  for (const sub of ['Documents', 'Desktop', 'Downloads']) {
    const p = path.join(home, sub);
    const r = pg.isProtectedForModify(p);
    assert.strictEqual(r.protected, false, sub + ' 不该被拦（用户就是要在自己目录里操作）');
  }
});

t('问题4：系统目录/盘符根/别人的家目录仍然要拦', () => {
  const pg = require('../lib/path-guard');
  const home = os.homedir();
  const usersRoot = path.dirname(home);
  const checks = [
    ['C:' + BS + 'Windows', 'SYSTEM'],
    ['C:' + BS + 'Windows' + BS + 'System32', 'SYSTEM'],
    ['C:' + BS + 'Program Files', 'SYSTEM'],
    [usersRoot, null],                        // C:\Users 本身
    [home, 'OWN_HOME'],                       // 自己家目录本身
    ['C:' + BS, 'VOLUME_ROOT'],
  ];
  for (const [p, kind] of checks) {
    const r = pg.isProtectedForModify(p);
    assert.strictEqual(r.protected, true, p + ' 应被拦');
    if (kind) assert.strictEqual(r.kind, kind, p + ' 的 kind 应为 ' + kind + '，实际 ' + r.kind);
  }
});

t('问题4：acl:repair 与 dir:move 都改用 isProtectedForModify', () => {
  const code = stripComments(mainSrc);
  assert.ok(!/pathGuard\.isCriticalPath\(target\)/.test(code),
    'acl:repair 仍在用 isCriticalPath（会把家目录下的 Documents 拦掉）');
  assert.ok(!/srcIsCritical:\s*pathGuard\.isCriticalPath\(/.test(code),
    'dir:move 仍在用 isCriticalPath');
  const n = (code.match(/isProtectedForModify/g) || []).length;
  assert.ok(n >= 3, 'isProtectedForModify 应出现至少 3 处（acl + 预检 + 执行），实际 ' + n);
});

t('问题4：提示语区分系统目录与家目录，不用同一句吓人的话', () => {
  const code = mainSrc;
  assert.ok(/kind === 'SYSTEM'/.test(code), '应针对 SYSTEM 单独给提示');
  assert.ok(/kind === 'OWN_HOME'/.test(code), '应针对 OWN_HOME 单独给提示');
  assert.ok(/请直接选中那个文件或它所在的子文件夹/.test(code),
    '家目录的提示应给出可操作建议，而不是「会导致系统更新失败」');
});

/* ================= 问题 5：含 junction 的目录能复制 ================= */
t('问题5：不再用 fsp.cp 直接复制整棵树（会被 junction 打成 EPERM）', () => {
  const code = stripComments(mainSrc);
  assert.ok(!/await fsp\.cp\(srcAbs, dstAbs/.test(code),
    '仍在用 fsp.cp 整树复制 —— 遇到 junction 会 EPERM');
  assert.ok(/copyTreeExcludingLinks/.test(code), '应有「排除链接后复制」的实现');
  assert.ok(/restoreLinksIntoTarget/.test(code), '应有「在目标侧重建链接」的实现');
  assert.ok(!/dereference:\s*true/.test(code),
    '不能靠 dereference: true 绕过 —— 那会把链接目标内容整个复制进来');
});

t('问题5（行为）：源目录含 junction 时，复制 + 重建能完成', async () => {
  const fsp = fs.promises;
  function extract(name, isAsync) {
    const pat = (isAsync ? 'async function ' : 'function ') + name + '(';
    const start = mainSrc.indexOf(pat);
    if (start < 0) throw new Error('not found: ' + name);
    let i = mainSrc.indexOf('{', start);
    let depth = 0;
    for (; i < mainSrc.length; i++) {
      if (mainSrc[i] === '{') depth++;
      else if (mainSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return mainSrc.slice(start, i);
  }
  const pathExists = async (p) => { try { await fsp.access(p); return true; } catch (e) { return false; } };
  /* 沙箱要跟上 main.js 的实现：restoreLinksIntoTarget 现在依赖
   * linkTargetAbs / isInsideTree（内部链接改写），缺了会直接报未定义。 */
  const mod = new Function('fsp', 'path', 'fs', 'pathExists',
    extract('relKey', false) + '\n' + extract('buildLinkKeySet', false) + '\n'
    + extract('linkNature', false) + '\n'
    + extract('linkTargetAbs', false) + '\n'
    + extract('normalizeForComparePath', false) + '\n'
    + extract('isInsideTree', false) + '\n'
    + extract('copyTreeExcludingLinks', true) + '\n' + extract('restoreLinksIntoTarget', true) + '\n'
    + 'return { copyTreeExcludingLinks, restoreLinksIntoTarget, linkNature };')(fsp, path, fs, pathExists);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvj2-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'plain.txt'), 'plain');
  fs.writeFileSync(path.join(src, 'sub', 'inner.txt'), 'inner');
  const junction = path.join(src, 'jlink');
  try {
    cp.execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction, path.join(src, 'sub')],
      { windowsHide: true, stdio: 'ignore' });

    const dst = path.join(root, 'dst');
    /* 与 main.js 里 collectLinks 同语义的收集（不跟随链接） */
    const links = [junction];
    await mod.copyTreeExcludingLinks(src, dst, links);
    assert.ok(fs.existsSync(path.join(dst, 'plain.txt')), '普通文件应被复制');
    assert.ok(fs.existsSync(path.join(dst, 'sub', 'inner.txt')), '子目录文件应被复制');
    assert.ok(!fs.existsSync(path.join(dst, 'jlink')), '复制阶段不该碰链接');

    const rr = await mod.restoreLinksIntoTarget(src, dst, links);
    assert.strictEqual(rr.created, 1, '链接应被重建，实际 created=' + rr.created +
      ' failed=' + JSON.stringify(rr.failed));
    assert.ok(fs.lstatSync(path.join(dst, 'jlink')).isSymbolicLink(), '目标侧应是真正的链接');
    assert.strictEqual(fs.readFileSync(path.join(dst, 'jlink', 'inner.txt'), 'utf8'), 'inner',
      '通过目标侧链接应能读到内容');
  } finally { rmDir(root); }
});

t('问题5：重建失败不会被静默吞掉（应中止并回退）', () => {
  const code = stripComments(mainSrc);
  assert.ok(/linkRestore\.failed/.test(code), '应检查重建失败列表');
  assert.ok(/重建链接失败/.test(code), '失败时应给出明确错误');
});

/* ================= 问题 6：splash 注入 + 配平断言 ================= */
t('问题6：splash 的 webPreferences 也注入了打包标记', () => {
  const code = stripComments(mainSrc);
  /* 找到 splash 的 BrowserWindow（webPreferences 里紧跟 spellcheck: false 的那个） */
  const idx = code.indexOf('function createSplash()');
  assert.ok(idx > 0, '找不到 createSplash');
  const seg = code.slice(idx, idx + 2200);
  assert.ok(/--hehe-packaged=/.test(seg),
    'splash 的 webPreferences 漏了 additionalArguments 注入（preload 的 isDev 会按开发态处理）');
});

t('问题6：测试改成配平断言，不再只数总数', () => {
  const test = read('scripts/test-packaged-isdev.js');
  const code = stripComments(test);
  assert.ok(!/if \(n < 4\)/.test(code), '仍在用「注入点 >= 4」的弱断言');
  /* 配平：带 preload 的窗口数必须等于带注入的窗口数。
   * 允许两种书写顺序（withInject !== withPreload / withPreload !== withInject）。 */
  assert.ok(
    /withPreload\.length !== withInject\.length/.test(code) ||
    /withInject\.length !== withPreload\.length/.test(code),
    '应做配平：带 preload 的窗口数必须等于带注入的窗口数');
});

/* ================= 问题 7：递归勾选读回 state ================= */
t('问题7：checkbox 从 state.recursive 读初值，不硬设 false', () => {
  const tool = read('js/tools/acl-repair.js');
  const code = stripComments(tool);
  assert.ok(/chk\.checked = !!state\.recursive;/.test(code),
    'render() 里应读回 state.recursive —— 硬设 false 会让界面与状态脱节');
  assert.ok(!/chk\.checked = false;/.test(code), '不该硬设 false');
});

t('问题7：换目标路径才复位递归（onChange 与「用这个路径」都要复位）', () => {
  const tool = read('js/tools/acl-repair.js');
  const code = stripComments(tool);
  const onChangeSeg = code.slice(code.indexOf('onChange: (items)'), code.indexOf('onChange: (items)') + 400);
  assert.ok(/state\.recursive = false/.test(onChangeSeg),
    'onChange 里应复位 recursive（换路径沿用上次勾选是危险的默认值）');
  const usePathSeg = code.slice(code.indexOf('usePathBtn'), code.indexOf('usePathBtn') + 500);
  assert.ok(/state\.recursive = false/.test(usePathSeg), '「用这个路径」也应复位');
});

/* ================= 问题 8：lockedPaths 语义与文案 ================= */
t('问题8：lockedPaths 不再假设 lockers 元素有 files 字段', () => {
  const code = stripComments(mainSrc);
  assert.ok(!/x\.files\s\?\s*x\.files\.join/.test(code),
    '仍在用 x.files（rmQueryLockers 返回的 {pid,name,type} 根本没有这个字段）');
});

t('问题8：LOCKED 文案说「进程」不说「文件」，advice 指向占用解锁工具', () => {
  const D = require('../lib/dir-move');
  const r = D.validateMove(Object.assign({}, {
    src: 'C:' + BS + 'a', dst: 'D:' + BS + 'a',
    srcExists: true, srcIsDir: true, srcIsLink: false, srcIsRoot: false,
    srcIsCritical: false, dstExists: false,
    needBytes: 1000, freeBytes: 10 * 1024 * 1024 * 1024,
    lockedPaths: ['123:foo.exe', '456:bar.exe'],
  }));
  assert.strictEqual(r.code, 'LOCKED');
  assert.ok(/个进程/.test(r.reason), '应说「N 个进程」而不是「N 个文件」：' + r.reason);
  assert.ok(!/个文件/.test(r.reason), '不该再说是文件数：' + r.reason);
  assert.ok(/文件占用解锁/.test(r.advice), 'advice 应指向占用解锁工具：' + r.advice);
});

/* ================= 额外项 ================= */
t('额外项1：link:scan 不再递归重扫全树取 LinkType', () => {
  const code = stripComments(mainSrc);
  assert.ok(!/Get-ChildItem -LiteralPath \$\{q\(root\)\} -Recurse/.test(code),
    '仍在用 Get-ChildItem -Recurse 重扫全树（collectLinks 已经遍历过一次）');
  assert.ok(/Get-Item -LiteralPath @\(/.test(code),
    '应改成对已收集的链接做批量 Get-Item');
});

t('额外项2：ownerIsMe 与 mine 共用同一个判定（principalEq）', () => {
  const main = stripComments(mainSrc);
  assert.ok(!/a\.endsWith\(''\\\\'' \+ b\.split/.test(main),
    'ownerIsMe 仍在自己写后缀匹配');
  assert.ok(/aclRepair\.principalEq\(/.test(main),
    'ownerIsMe 应调用 lib 的 principalEq');
  const A = require('../lib/acl-repair');
  assert.strictEqual(typeof A.principalEq, 'function', 'principalEq 应已导出');
});

done();
