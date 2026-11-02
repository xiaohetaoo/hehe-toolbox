'use strict';
const { t, done, readMain } = require('./lib/harness');
/* round-10 回归测试：一批「结论会错、门禁会漏」的问题。
 *
 * 编号与报告一致：
 *   ① ACL-1     含空格路径 + S-1-* / Mandatory Label 的主体解析
 *   ② DIRMOVE-1 目录搬家对目标路径零闸门
 *   ③ ACL-2     principalEq 的内建主体规则曾是死代码
 *   ④ PG-3/PG-4 电源门禁：链式命令穿透文本豁免；分段不认引号
 *   ⑤ LINKDOC-2 权限被拒的活链接被判「僵尸」可清理
 *   ⑥ 重入守卫  见 scripts/test-reentry-guard.js（那里做静态+行为覆盖）
 *   ⑦ 锁卡粒度  link-doctor / acl-repair 不该整页锁
 *   ⑧ V-2       danger.text 的 {name} 占位符没插值
 *   ⑨ V-3       高危能力名称/描述在英文界面仍是中文
 *   ⑩ P4 批次   ** 星号、文件符号链接被重建为 junction、
 *               预检两次全树遍历、盘符根保护、lan-scan 文案（TCP 80 不是 ping）
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const BS = String.fromCharCode(92);

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
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

/* 任务 5 把「目录搬家 + 权限/链接」两个域搬到了 ipc/acl-links.js：
 * 这里读「主进程全部源码」（main.js 在前，ipc/ 下的文件按名排序在后）——
 * 断言的语义是「主进程里有这个实现」，与它被放在哪个文件无关。 */
const mainSrc = readMain();

/* ================= ① 主体解析 ================= */

/* 【任务 6 之后 handle 有两种形态】这两个域的通道名换成了常量：
 *   handle(dirMoveCh.DIR_MOVE.PRECHECK, ...)  ← 现在
 *   handle('dir:move-precheck', ...)      ← 迁移前
 * 所以切片定位不能只写字面量。这里给出两个能匹配任一形态的正则，
 * 在各用例里用 code.search(...) 取位置。 */
/* 【任务 6 之后 handle 有两种形态】这两个域的通道名换成了常量：
 *   handle(dirMoveCh.DIR_MOVE.PRECHECK, ...)   ← 现在
 *   handle('dir:move-precheck', ...)           ← 迁移前
 * 所以切片定位不能只写字面量。下面这两个小函数两种形态都认。 */
function handlerPos(code, literal, expr) {
  const a = code.indexOf("handle('" + literal + "'");
  if (a >= 0) return a;
  return code.indexOf("handle(" + expr + ",");
}
function precheckAt(code) { return handlerPos(code, "dir:move-precheck", "dirMoveCh.DIR_MOVE.PRECHECK"); }
function moveAt(code) { return handlerPos(code, "dir:move", "dirMoveCh.DIR_MOVE.MOVE"); }
t('① 单行 icacls：路径含空格 + 裸 SID 不再把路径吃进主体', () => {
  const A = require('../lib/acl-repair.js');
  const line = 'C:' + BS + 'my docs' + BS + 'a.txt S-1-4-500487088-111393684:(I)(W,D,DC)';
  const r = A.parseIcacls(line, 'DOMAIN' + BS + 'admin');
  assert.strictEqual(r.entries[0].principal, 'S-1-4-500487088-111393684',
    '实际解析成 ' + r.entries[0].principal);
});

t('① 单行 icacls：路径含空格 + Everyone 不再把路径吃进主体', () => {
  const A = require('../lib/acl-repair.js');
  const r = A.parseIcacls('C:' + BS + 'my docs' + BS + 'a.txt Everyone:(I)(F)', 'me');
  assert.strictEqual(r.entries[0].principal, 'Everyone', '实际 ' + r.entries[0].principal);
});

t('① 单行 icacls：BUILTIN\\Users / NT AUTHORITY\\SYSTEM 仍然正确', () => {
  const A = require('../lib/acl-repair.js');
  const a = A.parseIcacls('C:' + BS + 'my docs' + BS + 'a.txt BUILTIN' + BS + 'Users:(I)(RX)', 'me');
  assert.strictEqual(a.entries[0].principal, 'BUILTIN' + BS + 'Users');
  const b = A.parseIcacls('C:' + BS + 'my docs' + BS + 'a.txt NT AUTHORITY' + BS + 'SYSTEM:(I)(F)', 'me');
  assert.strictEqual(b.entries[0].principal, 'NT AUTHORITY' + BS + 'SYSTEM');
});

t('① 多行 icacls：按续行缩进（路径长度+1）精确切主体列', () => {
  const A = require('../lib/acl-repair.js');
  const p = 'C:' + BS + 'my docs' + BS + 'folder' + BS + 'a.txt';   // 末段目录无扩展名
  const pad = ' '.repeat(p.length + 1);
  const sid = 'S-1-5-21-1111111111-2222222222-3333333333-4444';
  const out = [
    p + ' ' + sid + ':(I)(R)',
    pad + 'BUILTIN' + BS + 'Users:(I)(RX)',
    pad + 'Mandatory Label' + BS + 'Medium Mandatory Level:(I)(NW)',
  ].join('\n');
  const r = A.parseIcacls(out, 'me');
  assert.strictEqual(r.entries[0].principal, sid, 'SID 行：' + r.entries[0].principal);
  assert.strictEqual(r.entries[1].principal, 'BUILTIN' + BS + 'Users');
  assert.strictEqual(r.entries[2].principal, 'Mandatory Label' + BS + 'Medium Mandatory Level',
    'Mandatory Label 被切错：' + r.entries[2].principal);
  assert.ok(!r.entries.some((e) => /docs/i.test(e.principal)),
    '又把路径当主体了：' + r.entries.map((e) => e.principal).join(','));
});

t('① 没有续行时用调用方给的路径剥前缀（pathHint）', () => {
  const A = require('../lib/acl-repair.js');
  const r = A.parseIcacls('C:' + BS + 'my docs' + BS + 'folder Everyone:(I)(F)', 'me',
    { path: 'C:' + BS + 'my docs' + BS + 'folder' });
  assert.strictEqual(r.entries[0].principal, 'Everyone', '实际 ' + r.entries[0].principal);
});

t('① 含空格的多词组主体（Power Users 等）不能被截短', () => {
  const A = require('../lib/acl-repair.js');
  for (const raw of ['DOMAIN' + BS + 'Power Users', 'MyCompany' + BS + 'Domain Admins',
    'DOMAIN' + BS + 'Remote Desktop Users', 'CREATOR OWNER']) {
    const r = A.parseIcacls('C:' + BS + 'x' + BS + 'a.txt ' + raw + ':(I)(M)', 'me');
    assert.strictEqual(r.entries[0].principal, raw, '被截成 ' + r.entries[0].principal);
  }
});

t('① tailLooksLikePath 只认「路径残留」形态', () => {
  const A = require('../lib/acl-repair.js');
  assert.strictEqual(A.tailLooksLikePath('a.txt Everyone'), true, '文件名残留应被认出');
  assert.strictEqual(A.tailLooksLikePath('a.txt S-1-4-500487088-111393684'), true, 'SID 残留应被认出');
  assert.strictEqual(A.tailLooksLikePath('Power Users'), false, '正常多词组名不该被误拒');
  assert.strictEqual(A.tailLooksLikePath('Medium Mandatory Level'), false);
});

/* ================= ② 目标闸门 ================= */

t('② 目标落在系统目录时必须被拒（即使调用方没传 dstProtected）', () => {
  const D = require('../lib/dir-move.js');
  const OK = {
    src: 'C:' + BS + 'Users' + BS + 'u' + BS + 'bigdir', dst: 'D:' + BS + 'backup' + BS + 'bigdir',
    srcExists: true, srcIsDir: true, srcIsLink: false, srcIsRoot: false, srcIsCritical: false,
    dstExists: false, needBytes: 1000, freeBytes: 10737418240, lockedPaths: [],
  };
  const win = process.env.SystemRoot || 'C:' + BS + 'Windows';
  for (const dst of [win, win + BS + 'moved', (process.env.ProgramFiles || 'C:' + BS + 'Program Files') + BS + 'x']) {
    const r = D.validateMove(Object.assign({}, OK, { dst }));
    assert.strictEqual(r.code, 'DST_PROTECTED', dst + ' 应被拒，实际 ' + r.code + ' / ' + r.reason);
  }
  /* 正常目标不受影响 */
  assert.strictEqual(D.validateMove(OK).ok, true, '正常目标不该被误拒');
  /* 显式结论也要生效（main.js 的调用方式） */
  assert.strictEqual(D.validateMove(Object.assign({}, OK, { dstProtected: true })).code, 'DST_PROTECTED');
});

t('② main.js 的两处调用都传了 dstProtected（预检 + 执行）', () => {
  const code = stripComments(mainSrc);
  const hits = (code.match(/dstProtected:/g) || []).length;
  assert.ok(hits >= 3, '预检与执行都应传 dstProtected（含返回值），实际 ' + hits + ' 处');
  assert.ok(/isProtectedForModify\(dstAbs\)/.test(code), '目标侧应复用 isProtectedForModify');
});

/* ================= ③ principalEq ================= */

t('③ 内建/系统主体不会靠「去域后缀」蹭成当前用户', () => {
  const A = require('../lib/acl-repair.js');
  const bad = [
    ['BUILTIN' + BS + 'Users', 'MyCo' + BS + 'users'],
    ['NT AUTHORITY' + BS + 'SYSTEM', 'MyCo' + BS + 'system'],
    ['BUILTIN' + BS + 'Users', 'Users'],
    ['MANDATORY LABEL' + BS + 'Medium Mandatory Level', 'MyCo' + BS + 'Medium Mandatory Level'],
    ['DOMAIN' + BS + 'admin', 'BUILTIN' + BS + 'Administrators'],
  ];
  for (const [p, u] of bad) {
    assert.strictEqual(A.principalEq(p, u), false, p + ' 与 ' + u + ' 不该判为同一账号');
  }
  /* 正常判定不受影响 */
  assert.strictEqual(A.principalEq('XIAO' + BS + 'bob', 'bob'), true, '去域比较仍要工作');
  assert.strictEqual(A.principalEq('BUILTIN' + BS + 'Users', 'BUILTIN' + BS + 'users'), true,
    '逐字相同（只差大小写）仍是同一主体');
  assert.strictEqual(A.principalEq('XIAO' + BS + 'bob', 'XIAO' + BS + 'bob'), true);
});

/* ================= ④ 电源门禁 ================= */

t('④ 纯文本命令的豁免不能作用在整条命令上（链式命令必须被拦）', () => {
  const P = require('../lib/power-gate.js');
  for (const cmd of ['echo hi & shutdown /s /t 0', 'type nul & shutdown /s', 'dir > x.txt && shutdown /s',
    'cmd /c echo hi & shutdown /s', 'foo.exe\r\nshutdown /s']) {
    assert.strictEqual(P.isPowerCommand(cmd), true, '穿透了：' + cmd);
  }
  /* 真·纯文本仍要放行，否则日常命令会被误拦 */
  for (const cmd of ['echo shutdown', 'type shutdown.txt', 'dir shutdown.log', 'tasklist | findstr shutdown',
    'echo a; echo b', 'echo shutdown & echo ok']) {
    assert.strictEqual(P.isPowerCommand(cmd), false, '被误拦：' + cmd);
  }
});

t('④ 分段要认引号：参数里的 & 不该被当成命令分隔符（PG-4）', () => {
  const P = require('../lib/power-gate.js');
  assert.strictEqual(P.isPowerCommand('app.exe --msg "hello & shutdown now"'), false,
    '引号内的 & 被当成了分隔符（普通参数被误判成电源操作）');
  assert.strictEqual(P.isPowerCommand("app.exe --msg 'x; shutdown /s'"), false);
  assert.strictEqual(P.isPowerCommand('echo hi & shutdown /s'), true, '引号外的真命令仍要拦');
});

/* ================= ⑤ 链接体检 ================= */

t('⑤ 权限被拒的活链接判「无法判断」，不再可清理', async () => {
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

t('⑤ 新的 opaque 类在三处都登记了（否则会被当成「正常」或渲染崩）', () => {
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

t('⑤ link:remove 仍然只删 dead（opaque 自动被跳过）', () => {
  const code = stripComments(mainSrc);
  assert.ok(/if \(cls\.kind !== 'dead'\)/.test(code), 'link:remove 的二次校验必须仍只放行 dead');
});

/* ================= ⑦ 锁卡粒度 ================= */

t('⑦ link-doctor / acl-repair 改为部分锁（不再整页锁死）', () => {
  const app = stripComments(read('js/app.js'));
  assert.ok(/DELETE_ONLY_TOOLS = new Set\(\['local-notes', 'clipboard-history', 'link-doctor', 'acl-repair'\]\)/.test(app),
    'DELETE_ONLY_TOOLS 没包含 link-doctor / acl-repair');
  assert.ok(/requiresWholeToolLock\(toolId\)/.test(app), '部分锁的分支被别人改掉了');
});

t('⑦ 部分锁提示卡复述「本工具的哪一项」而不是一句删除文案', () => {
  const app = stripComments(read('js/app.js'));
  assert.ok(/T\('danger\.partialNotice', \{ op: names \}\)/.test(app),
    '提示卡没有按工具列出被锁的能力名');
  assert.ok(/dangerousCapInfo\[id\]/.test(app), '没有取能力名（会退化成 id）');
  assert.ok(!/T\('settings\.notice\.deleteOnly'\)/.test(app),
    '标题仍是「删除功能默认关闭」，与链接清理/权限修复对不上');
});

/* ================= ⑧ danger.text 占位符 ================= */

t('⑧ danger.text 的 {name} 真的被传进去了', () => {
  const app = read('js/app.js');
  assert.ok(/T\('danger\.text', \{ name: T\('danger\.category'\) \}\)/.test(app),
    'danger.text 仍未插值（界面上会显示「{name}」）');
  /* i18n.js 是浏览器脚本（引用 window），这里按源码检查两套字典都有键 */
  const i18n = read('js/i18n.js');
  const cats = i18n.match(/'danger\.category':/g) || [];
  assert.strictEqual(cats.length, 2, 'danger.category 必须在 zh / en 两套字典里都有，实际 ' + cats.length + ' 处');
  const texts = i18n.match(/'danger\.text':[^\n]*/g) || [];
  assert.strictEqual(texts.length, 2, 'danger.text 应有两条（zh/en）');
  for (const line of texts) {
    assert.ok(/\{name\}/.test(line), 'danger.text 应保留 {name} 占位符：' + line);
  }
});

/* ================= ⑨ 高危能力名称双语 ================= */

t('⑨ DANGEROUS_CAPS 的名称/描述中英双语，且随语言切换', () => {
  const a = mainSrc.indexOf('const CAP_TEXT = {');
  const b = mainSrc.indexOf("handle('dangerous:list'");
  assert.ok(a > 0 && b > a, '找不到 CAP_TEXT 区块');
  const body = mainSrc.slice(a, b);
  const mk = new Function('let uiLang = "zh"; ' + body +
    ' return { caps: DANGEROUS_CAPS, ids: DANGEROUS_CAP_IDS, capText, setLang(l){ uiLang = l; } };');
  const m = mk();
  const IDS = ['file-delete', 'junk-clean', 'recycle-empty', 'process-kill', 'service-stop',
    'system-power', 'hosts-edit', 'registry-edit', 'dir-move', 'acl-repair'];
  assert.deepStrictEqual(m.ids, IDS, '能力清单的项或顺序变了（设置页顺序由它决定）');
  assert.strictEqual(m.caps['acl-repair'].name, '取得所有权 / 修复权限', 'zh 名称不对');
  m.setLang('en');
  const zhLeft = [];
  for (const id of IDS) {
    const c = m.caps[id];
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(c.name + c.desc)) zhLeft.push(id);
  }
  assert.deepStrictEqual(zhLeft, [], '英文界面下这些能力名/描述仍是中文：' + zhLeft.join(','));
  assert.strictEqual(m.caps['file-delete'].name, 'Delete files');
  m.setLang('zh');
  assert.strictEqual(m.caps['file-delete'].name, '删除文件', '切回中文要能复原');
});

t('⑨ 门禁拒绝文案也是双语的', () => {
  const code = stripComments(mainSrc);
  assert.ok(/const GATE_TEXT = \{/.test(code), '没有 GATE_TEXT');
  assert.ok(/GATE_TEXT\[uiLang\]/.test(code), 'dangerousDenied 没有按语言取文案');
  assert.ok(/dangerousDenied\('system-power'\)/.test(code), '电源门禁也应走双语文案');
});

/* ================= ⑩ P4 批次 ================= */

t('⑩ 用户可见文案里不再有 Markdown 星号', () => {
  const FILES = ['js/tools/lan-scan.js', 'js/tools/mojibake-fix.js', 'js/tools/disk-health.js',
    'js/tools/link-doctor.js', 'js/tools/dir-move.js', 'js/tools/acl-repair.js', 'lib/lan-scan.js'];
  const offenders = [];
  for (const rel of FILES) {
    /* 只看字符串字面量里的 **：注释里的 ** 是排版习惯，用户看不到 */
    const src = read(rel);
    const re = /'([^'\\]|\\.)*'/g;
    let m;
    while ((m = re.exec(src))) {
      if (m[0].includes('**')) offenders.push(rel + ': ' + m[0].slice(0, 60));
    }
  }
  assert.deepStrictEqual(offenders, [], '这些文案会被原样显示星号：\n  ' + offenders.join('\n  '));
});

t('⑩ 链接性质判定：目录→junction、文件→符号链接、判不出→如实报错', () => {
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

t('⑩ 重建链接时「文件」必须走符号链接分支（不能一律 junction）', async () => {
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

t('⑩ 预检只走一遍全树（体积 + 链接同一次遍历）', () => {
  const code = stripComments(mainSrc);
  const seg = code.slice(precheckAt(code), moveAt(code));
  assert.ok(/collectLinks\(srcAbs, \{ wantSize: true \}\)/.test(seg), '预检没有用一次遍历同时取体积与链接');
  assert.ok(!/links\.dirSize\(srcAbs\)/.test(seg), '预检里仍在走第二遍（dirSize）');
  assert.ok(/linkCount: treeLinks\.length/.test(seg), 'linkCount 应直接复用遍历结果');
  /* 结果要真的被界面用上（之前算了却没人显示） */
  const ui = stripComments(read('js/tools/dir-move.js'));
  assert.ok(/r\.linkCount/.test(ui), '预检结果里的 linkCount 没有显示给用户');
});

t('⑩ 盘符根保护：任何存在的盘上的 Windows/Program Files 都拦，不存在的盘不误伤', () => {
  const p = require('../lib/path-guard.js');
  const win = process.env.SystemRoot || 'C:' + BS + 'Windows';
  assert.strictEqual(p.isProtectedForModify(win).protected, true, 'Windows 目录应受保护');
  assert.strictEqual(p.isProtectedForModify(win + BS + 'System32').protected, true);
  assert.strictEqual(p.isProtectedForModify('Q:' + BS + 'Windows').protected, false,
    '不存在的盘不该凭空产生保护项（会误伤同名的普通目录）');
});

t('⑩ lan-scan 文案与实现一致：是 TCP 80 探测，不是 ping/ICMP', () => {
  const ui = read('js/tools/lan-scan.js');
  assert.ok(!/挡 ICMP|不回应 ICMP|仅 ping/.test(ui), '界面仍把探测说成 ping/ICMP');
  assert.ok(/TCP 80 端口探测/.test(ui), '界面应说明是 TCP 80 探测');
  const lib = read('lib/lan-scan.js');
  assert.ok(!/Windows 防火墙默认会挡掉 ping/.test(lib), 'lib 的 caveats 仍说 ping');
  assert.ok(/TCP 80 端口探测/.test(lib), 'lib 的 caveats 应说明 TCP 80');
  /* 而实现确实是 TCP 80 */
  assert.ok(/s\.connect\(80, ip\)/.test(stripComments(mainSrc)), '实现应仍是 TCP 80');
});

t('⑩ 锟斤拷这类字符串乱码现在能修（借 .NET 的 CP936 编码器）', () => {
  const m = require('../lib/mojibake.js');
  assert.ok(m.EXTERNAL_CHAINS.some(([f, to]) => f === 'gbk' && to === 'utf-8'), '缺少 GBK→UTF-8 这条链');
  assert.strictEqual(m.PS_CODEPAGE.gbk, 936);
  const code = stripComments(mainSrc);
  assert.ok(/analyzeWithEncoder/.test(code), '主进程没有走带编码器的分析路径');
  return (async () => {
    const psRunner = (script, timeoutMs) => Promise.resolve({
      stdout: cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { encoding: 'utf8', timeout: timeoutMs || 30000 }),
    });
    const orig = '中文测试内容';
    const broken = new TextDecoder('gbk', { fatal: false }).decode(Buffer.from(orig, 'utf8'));
    const r = await m.analyzeWithEncoder(broken, psRunner);
    assert.strictEqual(r.best.text, orig, '没能还原：' + JSON.stringify(r.best.text));
    assert.strictEqual(r.externalTried, true);
  })();
});

/* 等异步用例结束 */
done();
