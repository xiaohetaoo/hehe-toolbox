'use strict';
const path = require('path');
/* 读项目内文件（迁移来的 25a 用例要读 lib/path-guard.js 的源码）。 */
function read(rel) { return require('fs').readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
const os = require('os');
const assert = require('assert');
const { t, done, readMain } = require('./lib/harness');
const ROOT = path.join(__dirname, '..');
const BS = String.fromCharCode(92);
const stripComments = require('../lib/src-scan').stripComments;
const mainSrc = readMain({ raw: true });
/* 破坏性操作安全网测试（lib/path-guard.js）。
 *
 * 这些断言守护的是「用户数据被毁掉」的场景，比功能 bug 更严重。
 */
const guard = require('../lib/path-guard');

/* ---------- 文件名检查 ---------- */
t('正常文件名通过', () => {
  for (const n of ['a.txt', 'IMG_0001.jpg', '中文名.png', 'file-1_2.tar.gz', '.gitignore']) {
    assert.strictEqual(guard.checkFileName(n), null, n + ' 应通过');
  }
});
t('路径分隔符被拒', () => {
  for (const n of ['a/b.txt', 'a\\b.txt', '../x.txt']) {
    assert.ok(guard.checkFileName(n), n + ' 应被拒');
  }
});
t('NTFS ADS 被拒', () => {
  assert.strictEqual(guard.checkFileName('a.txt:stream').code, 'ADS');
});
t('设备名被拒（含带扩展名形式）', () => {
  assert.strictEqual(guard.checkFileName('CON').code, 'DEVICE_NAME');
  assert.strictEqual(guard.checkFileName('con.txt').code, 'DEVICE_NAME');
  assert.strictEqual(guard.checkFileName('LPT1.log').code, 'DEVICE_NAME');
});
t('尾随点/空格被拒', () => {
  assert.strictEqual(guard.checkFileName('file.').code, 'TRAILING_DOT');
  assert.strictEqual(guard.checkFileName('file ').code, 'TRAILING_DOT');
});
t('Windows 非法字符被拒', () => {
  for (const n of ['a<b', 'a>b', 'a|b', 'a?b', 'a*b']) {
    assert.ok(guard.checkFileName(n), n + ' 应被拒');
  }
});
t('. 与 .. 被拒', () => {
  assert.ok(guard.checkFileName('.'));
  assert.ok(guard.checkFileName('..'));
});
t('空名被拒', () => {
  assert.strictEqual(guard.checkFileName('').code, 'EMPTY_NAME');
});

/* ---------- resolveInside ---------- */
t('resolveInside 允许正常的相对路径', () => {
  const root = path.resolve('C:/data');
  assert.strictEqual(guard.resolveInside(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  assert.strictEqual(guard.resolveInside(root, './a.txt'), path.join(root, 'a.txt'));
});
t('resolveInside 拒绝 .. 穿越', () => {
  const root = path.resolve('C:/data');
  assert.throws(() => guard.resolveInside(root, '../evil.txt'), /超出|穿越/);
  assert.throws(() => guard.resolveInside(root, 'a/../../evil.txt'), /超出|穿越/);
});
t('resolveInside 拒绝绝对路径', () => {
  const root = path.resolve('C:/data');
  assert.throws(() => guard.resolveInside(root, 'C:/Windows/evil.txt'), /绝对路径/);
  assert.throws(() => guard.resolveInside(root, '/etc/passwd'), /绝对路径/);
});
t('resolveInside 拒绝 UNC', () => {
  const root = path.resolve('C:/data');
  assert.throws(() => guard.resolveInside(root, '//server/share/x'), /UNC/);
});
t('resolveInside 拒绝内含设备名的段', () => {
  const root = path.resolve('C:/data');
  assert.throws(() => guard.resolveInside(root, 'CON.txt'), /设备名/);
});
t('resolveInside 不会逃出根目录', () => {
  const root = path.resolve('C:/data');
  const r = guard.resolveInside(root, 'a/b/../c.txt');
  assert.ok(r.startsWith(root + path.sep), r + ' 应在 root 内');
});

/* ---------- 删除闸门 ---------- */
t('拒绝删除磁盘根目录', () => {
  for (const p of ['C:\\', 'D:/', 'C:/']) {
    const r = guard.checkDeletable(p, true);
    assert.ok(r, p + ' 应被拒绝');
  }
});
t('拒绝删除系统关键目录', () => {
  for (const p of ['C:\\Windows', 'C:\\Windows\\System32', 'C:\\Program Files',
                   'C:\\Users', 'C:\\ProgramData', 'C:\\$Recycle.Bin']) {
    const r = guard.checkDeletable(p, true);
    assert.ok(r, p + ' 应被拒绝');
  }
});
t('拒绝删除用户主目录本身', () => {
  const home = path.resolve(os.homedir());
  assert.ok(guard.checkDeletable(home, true), '主目录应被拒绝');
});
t('允许删除主目录下的普通子目录', () => {
  const sub = path.join(path.resolve(os.homedir()), 'Desktop', '某个文件夹');
  assert.strictEqual(guard.checkDeletable(sub, true), null, '普通子目录应放行');
});
t('允许删除临时目录', () => {
  assert.strictEqual(guard.checkDeletable(path.join(os.tmpdir(), 'hehe-x'), true), null);
});
t('空路径被拒', () => {
  assert.ok(guard.checkDeletable('', true));
  assert.ok(guard.checkDeletable(null, true));
});

/* ---------- 覆盖闸门 ---------- */
t('拒绝覆盖系统关键目录内的文件', () => {
  for (const p of ['C:\\Windows\\System32\\drivers\\etc\\hosts',
                   'C:\\Program Files\\app\\config.ini']) {
    assert.ok(guard.checkOverwritable(p), p + ' 应被拒绝');
  }
});
t('允许覆盖普通文件', () => {
  assert.strictEqual(guard.checkOverwritable('C:/Users/x/Desktop/notes.txt'), null);
});

/* ---------- 交叉验证：不能通过组合绕过 ---------- */
t('大写/混合大小写也逃不掉', () => {
  for (const p of ['c:\\windows', 'C:\\WINDOWS\\System32', 'C:\\pROGRAM fILES']) {
    assert.ok(guard.checkDeletable(p, true), p + ' 应被拒绝');
  }
});
t('带尾随分隔符也逃不掉', () => {
  assert.ok(guard.checkDeletable('C:\\Windows\\', true));
  assert.ok(guard.checkDeletable('C:\\Users\\', true));
});
t('UNC 形式的系统目录不被当作关键目录误伤普通路径', () => {
  // \\server\share 不在关键目录列表里，不应被 critical 规则拦
  assert.strictEqual(guard.isCriticalPath('\\\\server\\share\\folder'), false);
});

/* ---------- 尾随点/空格绕过（Windows 会静默去掉，必须归一化后再比较） ---------- */
t('尾随点不能绕过关键目录闸门', () => {
  for (const p of ['C:\\Windows.', 'C:\\Program Files.', 'C:\\$Recycle.Bin.',
                   'C:\\Users\\', 'C:\\ProgramData.']) {
    assert.ok(guard.checkDeletable(p, true), p + ' 应被拒绝');
  }
});
t('尾随空格不能绕过闸门', () => {
  for (const p of ['C:\\Windows ', 'C:\\Program Files ', 'C:\\ProgramData ']) {
    assert.ok(guard.checkDeletable(p, true), p + ' 应被拒绝');
  }
});
t('尾随点不能绕过覆盖闸门', () => {
  for (const p of ['C:\\Windows.\\System32\\x.ini', 'C:\\Program Files.\\a\\b.ini']) {
    assert.ok(guard.checkOverwritable(p), p + ' 应被拒绝');
  }
});
t('家目录加尾点也逃不掉', () => {
  const home = path.resolve(os.homedir());
  assert.ok(guard.checkDeletable(home + '.', true), '主目录尾点应被拒绝');
  assert.ok(guard.checkDeletable(home + ' ', true), '主目录尾空格应被拒绝');
});
t('normalizeForCompare 归一化正确', () => {
  assert.strictEqual(guard.normalizeForCompare('C:\\Windows.'), 'c:\\windows');
  assert.strictEqual(guard.normalizeForCompare('C:\\Windows '), 'c:\\windows');
  assert.strictEqual(guard.normalizeForCompare('C:\\Windows\\'), 'c:\\windows');
  assert.strictEqual(guard.normalizeForCompare('C:\\A.\\B.'), 'c:\\a\\b');
});

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

t('25a checkDeletable：系统目录深层一律拦住（递归与非递归都拦）', () => {
  const PGx = require(path.join(ROOT, 'lib', 'path-guard'));
  const B = String.fromCharCode(92);
  const sys = (x) => path.join('C:', 'Windows', x);
  /* 关键：这些都是「关键目录的第二层以后」，isCriticalPath 判不出来 */
  for (const p of [sys('System32' + B + 'drivers'), sys('System32' + B + 'config' + B + 'SAM'),
    path.join('C:', 'Program Files', 'nodejs', 'node.exe')]) {
    assert.ok(PGx.checkDeletable(p, true), p + ' 递归删除必须被拒（删掉会让系统起不来/无法登录）');
  }
  /* 用户自己的目录照常可删，不能矫枉过正 */
  const mine = path.join(require('os').homedir(), 'Documents', 'a.txt');
  assert.strictEqual(PGx.checkDeletable(mine, true), null, '自己文档目录下的文件应可删');
  assert.strictEqual(PGx.checkDeletable(mine, false), null, '自己文档目录下的文件非递归也应可删');
});

t('25a-2 非递归删除同样不许碰系统目录深层（F2 修复）', () => {
  const PGx = require(path.join(ROOT, 'lib', 'path-guard'));
  /* 锁的是：深层保护被 `if (recursive && …)` 限定 —— 只在递归时生效，
   * 非递归删单个文件全部放行。而 ipc/fs-ops.js 的注释明确承诺
   * 「非递归删除单个文件时，仍然要挡住关键目录里的文件」。
   * 真实后果：管理员 + 已开「文件删除」时可真删 hosts（全机 DNS 失效）
   * 与 SAM（账户数据库）。审查报告用纯函数实测确认。 */
  const mustBlock = [
    path.join('C:', 'Windows', 'System32', 'config', 'SAM'),
    path.join('C:', 'Windows', 'System32', 'drivers', 'etc', 'hosts'),
    path.join('C:', 'Windows', 'System32', 'drivers'),
    path.join('C:', 'Program Files', 'app', 'x.dll'),
    path.join('C:', 'ProgramData', 'app', 'cfg.ini'),
  ];
  for (const p of mustBlock) {
    const r = PGx.checkDeletable(p, false);
    assert.ok(r, p + ' 非递归删除也必须被拒（这是系统目录深层文件）');
    assert.strictEqual(r.code, 'CRITICAL_DEEP', p + ' 应报 CRITICAL_DEEP');
  }
  /* 锁的是：为了拦系统目录而把用户目录一起拦了 ——
   * 那会让「重复文件查找」这类工具的删除功能完全不可用。
   * isCriticalDeep 刻意不含 Users，这条锁住那个边界。 */
  const mine = path.join(require('os').homedir(), 'Downloads', 'x.zip');
  assert.strictEqual(PGx.checkDeletable(mine, false), null, '用户下载目录的文件必须仍可删');
  /* 锁的是：提示语文案不分递归/非递归 —— 非递归删单个文件时
   * 说「拒绝递归删除」会让用户困惑（他并没做递归操作）。 */
  const r1 = PGx.checkDeletable(path.join('C:', 'Windows', 'System32', 'x.dll'), false);
  assert.ok(/拒绝删除/.test(r1.reason) && !/递归/.test(r1.reason),
    '非递归的提示不应出现「递归」字样');
  const r2 = PGx.checkDeletable(path.join('C:', 'Windows', 'System32', 'x'), true);
  assert.ok(/递归/.test(r2.reason), '递归的提示应说明是递归删除');
});

t('25a-3 checkOverwritable 与 checkDeletable 的类型闸门必须一致（F5）', () => {
  const PGx = require(path.join(ROOT, 'lib', 'path-guard'));
  /* 锁的是：两个闸门对同一种垃圾输入给出相反结论 ——
   * checkDeletable 因真实事故（{path,depth} 被降成 [object Object]）
   * 早已严格拒绝非字符串，checkOverwritable 却仍是 String(p || '')。
   * `checkOverwritable({})` 与 `checkOverwritable(123)` 修复前都返回
   * null（放行），与兄弟函数的方向正好相反。
   * 影响：下游 writeFile 对非字符串会抛错，不直接可利用；
   * 但闸门对垃圾输入说「放行」是纵深防御缺口。 */
  const junk = [{}, 123, true, [], null, undefined, NaN];
  for (const v of junk) {
    const r = PGx.checkOverwritable(v);
    assert.ok(r, 'checkOverwritable(' + JSON.stringify(String(v)) + ') 应拒绝非字符串路径');
    assert.strictEqual(r.code, 'BAD_ARG', 'checkOverwritable 对非字符串应报 BAD_ARG');
  }
  /* 锁的是：类型闸门把合法路径一起拦了（正常写盘全废）。
   * 注意 checkOverwritable 的合法输入必须真的走到 CRITICAL 判定 ——
   * 只测「不是 BAD_ARG」还不够，要确认它仍能认出系统目录。 */
  assert.strictEqual(PGx.checkOverwritable(path.join(require('os').homedir(), 'Desktop', 'x.txt')), null,
    '用户桌面文件必须可覆盖');
  const sys = PGx.checkOverwritable(path.join('C:', 'Windows', 'System32', 'drivers', 'etc', 'hosts'));
  assert.ok(sys && sys.code === 'CRITICAL', '系统 hosts 必须仍被判 CRITICAL（不是 BAD_ARG）');

  /* 锁的是：两个函数各写一套类型校验（改一处漏一处）——
   * 现在应共用 stringPathOrError 助手。 */
  const src = read(path.join('lib', 'path-guard.js'));
  assert.ok(/function stringPathOrError/.test(src), '缺少共用的 stringPathOrError 助手');
  const delFn = src.slice(src.indexOf('function checkDeletable'), src.indexOf('function checkOverwritable'));
  const owFn = src.slice(src.indexOf('function checkOverwritable'), src.indexOf('module.exports'));
  /* 锁的是：两处又各自实现类型校验 —— 改一处漏一处。 */
  assert.ok(/stringPathOrError\(/.test(delFn), 'checkDeletable 应使用共用助手');
  /* 锁的是：checkOverwritable 退回自己的 String() 降级。 */
  assert.ok(/stringPathOrError\(/.test(owFn), 'checkOverwritable 应使用共用助手');
});

t('25b isCriticalForOverwrite：第二套 Windows（D:\\Windows）也要挡', () => {
  const PGx = require(path.join(ROOT, 'lib', 'path-guard'));
  const hosts = path.join('D:', 'Windows', 'System32', 'drivers', 'etc', 'hosts');
  assert.ok(PGx.checkOverwritable(hosts),
    'D:\\Windows 下的 hosts 必须拒写 —— 覆盖它会毁掉全机 DNS。' +
    '原实现只查环境变量那套系统目录，注释却写「任意盘符」');
  /* 普通路径不受影响 */
  assert.strictEqual(PGx.checkOverwritable(path.join('D:', 'data', 'a.txt')), null);
});

t('25c resolveInside / resolveTarget：盘符根不能误判为越界', () => {
  const PGx = require(path.join(ROOT, 'lib', 'path-guard'));
  const AGx = require(path.join(ROOT, 'lib', 'archive-guard'));
  const B = String.fromCharCode(92);
  const root = 'D:' + B;
  assert.strictEqual(PGx.resolveInside(root, 'a.txt'), 'D:' + B + 'a.txt',
    '「解压到 D:\\」是常见操作，不能因为 root 以分隔符结尾就判越界');
  assert.strictEqual(AGx.resolveTarget(root, 'a.txt'), 'D:' + B + 'a.txt');
  /* 安全边界不能被放宽：绝对路径 / UNC / 设备名照旧拒绝 */
  assert.throws(() => PGx.resolveInside(root, 'C:' + B + 'x'), /绝对路径|ABS_PATH/);
  assert.throws(() => PGx.resolveInside(root, '//srv/share'), /UNC/);
  /* 盘符根下的 `..` 解析后仍落在本卷（path.resolve('D:\', '../x') === 'D:\x'），
   * 这不是逃逸，不该被拦 —— 但**跨到别的卷**必须拦。 */
  assert.throws(() => PGx.resolveInside(root, 'D:' + B + '..' + B + '..' + B + 'C:' + B + 'x'),
    /绝对路径|ESCAPE/);
});

/* ==================== 26. power-gate 包装剥离 ==================== */

done();
