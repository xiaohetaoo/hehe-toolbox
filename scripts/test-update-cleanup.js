'use strict';
const { t, done, readMain } = require('./lib/harness');
/* segFromHandler 统一到 scripts/lib/seg-from-handler.js —— 见那里的文件头说明。 */
const { segFromHandler, handlerIndex } = require('./lib/seg-from-handler');
/* 【迁移说明】用例来自 test-round8-fixes.js，原先用 fs.readFileSync(main.js)。
 * 任务 6 之后 ffmpeg:/target:/rec: 等域搬到了 ipc/，所以读「主进程全部源码」——
 * 断言的语义一直是"主进程里有这个实现"，与它在哪个文件无关。 */
const mainSrc = readMain({ raw: true });
/* 行为验证：update:cleanup 的判定逻辑（不能靠“代码里有 cmpVer”就算数）。
 * 复刻 main.js 里的取舍规则，在临时目录造出各种版本号的包，看谁被删、谁被留。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function cmpVer(a, b) {
  const pa = String(a || '').split('.').map(Number), pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/* 与 main.js 中 update:cleanup 完全一致的取舍规则 */
function cleanup(dir, current, pendingName) {
  const removed = [], kept = [];
  for (const n of fs.readdirSync(dir)) {
    if (!/^hehe-toolbox-Portable-.*\.exe$/i.test(n)) continue;
    const vm = n.match(/hehe-toolbox-Portable-(.+?)\.exe$/i);
    const ver = vm ? vm[1] : '';
    if (pendingName && n === pendingName) { kept.push([n, '待安装']); continue; }
    if (!/^\d+\.\d+\.\d+/.test(ver)) { kept.push([n, '版本号不可解析']); continue; }
    if (cmpVer(ver, current) > 0) { kept.push([n, '更新版本']); continue; }
    fs.unlinkSync(path.join(dir, n));
    removed.push(n);
  }
  return { removed, kept };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updclean-'));

/* 1. 核心场景：刚下载还没装的新版包必须留下 */
{
  const dir = path.join(tmp, 'a'); fs.mkdirSync(dir);
  for (const n of [
    'hehe-toolbox-Portable-0.0.12.exe', // 旧版，应删
    'hehe-toolbox-Portable-0.0.13.exe', // 当前版本，应删
    'hehe-toolbox-Portable-0.0.14.exe', // 刚下的新版，必须留
    'hehe-toolbox-Portable-abc.exe',    // 版本号不可解析，保守保留
    'other-file.exe'                    // 不匹配模式，不归我们管
  ]) fs.writeFileSync(path.join(dir, n), 'x');
  const r = cleanup(dir, '0.0.13', null);
  t('旧版与当前版被清理，新版保留', () => {
    assert.ok(r.removed.includes('hehe-toolbox-Portable-0.0.12.exe'), '0.0.12 应删');
    assert.ok(r.removed.includes('hehe-toolbox-Portable-0.0.13.exe'), '0.0.13 应删');
    assert.ok(!r.removed.includes('hehe-toolbox-Portable-0.0.14.exe'), '0.0.14 是刚下的新版，不能删！');
    assert.ok(fs.existsSync(path.join(dir, 'hehe-toolbox-Portable-0.0.14.exe')), '0.0.14 文件应仍在');
  });
  t('版本号不可解析时保守保留', () => {
    assert.ok(fs.existsSync(path.join(dir, 'hehe-toolbox-Portable-abc.exe')), 'abc 应保留');
  });
  t('不匹配命名规则的文件不动', () => {
    assert.ok(fs.existsSync(path.join(dir, 'other-file.exe')), 'other-file.exe 不应被删');
    assert.ok(!r.removed.includes('other-file.exe'));
  });
}

/* 2. 登记为待安装的包，即使版本号更旧也豁免 */
{
  const dir = path.join(tmp, 'b'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'hehe-toolbox-Portable-0.0.12.exe'), 'x');
  const r = cleanup(dir, '0.0.13', 'hehe-toolbox-Portable-0.0.12.exe');
  t('显式登记待安装的包被豁免', () => {
    assert.ok(fs.existsSync(path.join(dir, 'hehe-toolbox-Portable-0.0.12.exe')), '待安装包不应被删');
    /* 【这一条原来只检查「文件还在」，cleanup() 的返回值 r 算了却没人看】
     * 「文件还在」有两种可能：① 真的被「待安装」这条规则豁免（期望）
     * ② 整个 cleanup 根本没扫到这个目录（同样是"文件还在"，但假绿）。
     * 返回值里的 kept 正是用来区分这两者的，所以必须断言它 ——
     * 断言到具体的豁免理由，而不是只断言"数组非空"。 */
    assert.deepStrictEqual(r.kept, [['hehe-toolbox-Portable-0.0.12.exe', '待安装']],
      '应由「待安装」这条规则豁免，实际 kept=' + JSON.stringify(r.kept));
    assert.deepStrictEqual(r.removed, [], '这个目录里没有该删的包');
  });
}

/* 3. 回归对照：旧逻辑会把这个目录清空 */
{
  const dir = path.join(tmp, 'c'); fs.mkdirSync(dir);
  for (const n of ['hehe-toolbox-Portable-0.0.14.exe', 'hehe-toolbox-Portable-0.0.15.exe'])
    fs.writeFileSync(path.join(dir, n), 'x');
  cleanup(dir, '0.0.13', null);
  t('升级链上多个新版包都保留（旧逻辑会全删）', () => {
    assert.strictEqual(fs.readdirSync(dir).length, 2, '仍在目录里的包数');
  });
}

/* 4. 同版本号比较函数本身 */
/* ---------------- 以下助手随 round13 的用例一起迁来 ----------------
 * segFromHandler：按花括号配平取 handler 体（函数体里有嵌套的 {}）。 */








t('cmpVer 语义正确', () => {
  assert.strictEqual(cmpVer('0.0.14', '0.0.13'), 1);
  assert.strictEqual(cmpVer('0.0.13', '0.0.13'), 0);
  assert.strictEqual(cmpVer('0.1.0', '0.0.99'), 1);
  assert.strictEqual(cmpVer('1.0.0', '1.0.0'), 0);
  assert.strictEqual(cmpVer('0.0.9', '0.0.10'), -1, '9 < 10 必须按数字比，不能按字符串');
});

fs.rmSync(tmp, { recursive: true, force: true });

t('升级备份有回收逻辑且保留最近几份', () => {
  assert.ok(/function pruneExeBackups/.test(mainSrc), '没有 pruneExeBackups');
  const body = (() => {
    const s = mainSrc.indexOf('async function pruneExeBackups');
    const e = mainSrc.indexOf('\n}', s);
    return mainSrc.slice(s, e);
  })();
  assert.ok(/\.slice\(keep\)/.test(body), '没有按保留数截断');
  assert.ok(/\.bak\./.test(body), '没有识别带时间戳的备份');
  assert.ok(/update:cleanup/.test(mainSrc), 'update:cleanup 应存在');
  // 接入点
  const uc = mainSrc.slice(handlerIndex(mainSrc, 'update:cleanup'));
  /* 锁的是：update:cleanup 不再回收历史备份（.bak 会无限堆积）。 */
  assert.ok(/pruneExeBackups/.test(uc.slice(0, 2500)), 'update:cleanup 没有调用 pruneExeBackups');
});

/* 真实跑一遍 prune 的文件名排序逻辑（不依赖 Electron）
 *
 * 【这条用例是异步的，输出位置因此与迁移前不同 —— 这是修好了一个隐患】
 * 它返回 Promise。迁移前那份自建 t() 是**同步**的：
 *     try { fn(); pass++; console.log('PASS  ' + name); } catch ...
 * 于是它拿到 Promise 就当通过了，立刻打 PASS（所以原来这条排在第 7 位），
 * **异步断言如果失败根本不会被记录**（Promise reject 时已经没人接了）。
 * 公共骨架 scripts/lib/harness.js 的 t() 会识别 thenable 并等待，
 * 因此这条现在落在结果行之前（最后一位），而且失败能被抓到了。
 * 断言集合与原版完全一致（已逐条核对）。
 */

t('时间戳备份按时间排序、只留最新的', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bakprune-'));
  const exe = 'hehe-toolbox-Portable-9.9.9.exe';
  fs.writeFileSync(path.join(dir, exe + '.bak'), 'x');
  const stamps = ['20260101-010101', '20260202-020202', '20260303-030303',
                  '20260404-040404', '20260505-050505'];
  for (const s of stamps) fs.writeFileSync(path.join(dir, exe + '.bak.' + s), 'x');

  // 复用主进程里的实现：抽出来在本地求值
  const impl = (() => {
    const s = mainSrc.indexOf('async function pruneExeBackups');
    const e = mainSrc.indexOf('\n}', s);
    return mainSrc.slice(s, e + 2);
  })();
  // 用 Function 包一层，注入 fsp/path
  const fsp = require('fs/promises');
  const fn = new Function('fsp', 'path', impl + '\nreturn pruneExeBackups;')(fsp, path);
  return fn(path.join(dir, exe), 3).then((r) => {
    const left = fs.readdirSync(dir).filter((n) => n.includes('.bak.'));
    assert.strictEqual(left.length, 3, '应剩 3 份时间戳备份，实际 ' + left.length);
    assert.strictEqual(r.removed, 2, '应删掉 2 份，实际 ' + r.removed);
    // 保留的必须是**最新**的三份
    for (const keep of ['20260303-030303', '20260404-040404', '20260505-050505']) {
      assert.ok(left.includes(exe + '.bak.' + keep), '应保留最新的一份 ' + keep);
    }
    // .bak 本体永远不动
    assert.ok(fs.existsSync(path.join(dir, exe + '.bak')), '.bak 本体不该被删');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ============ ④c 首帧语言 ============ */

t('20 update:apply：并发调用要被挡住（连点两次会跑两份替换脚本）', () => {
  const seg = segFromHandler(mainSrc, 'update:apply');
  /* 锁的是：并发 apply 会同时跑两份替换脚本，互相覆盖 exe。 */
  assert.ok(/updateApplying/.test(seg), '缺少升级单飞标志');
  /* 锁的是：第二次调用没有直接拒绝（会真的再起一份脚本）。 */
  assert.ok(/if \(updateApplying\) throw/.test(seg), '第二次调用应直接拒绝');
  /* 锁的是：校验失败要能重试：commit 之前的错误必须放开标志。 */
  assert.ok(/updateApplyingCommitted/.test(seg), '需要区分「已启动替换脚本」与「还没开始」');
  /* 锁的是：前置错误后标志没放开 —— 用户第一次失败就再也点不动。 */
  assert.ok(/if \(!updateApplyingCommitted\) updateApplying = false;/.test(seg),
    '校验失败等前置错误应放开标志，让用户能重试');
});

/* ==================== 21. 截图临时文件 ==================== */

/* ============ 22. 更新/回滚脚本的 UTF-8 BOM（第四轮审查） ============
 * 这个缺陷的判据只能是「真跑一次 PowerShell」：历史上正是「对源码做
 * 字符串断言」让它活了下来（测试断言的是 Get-FileHash 这些字样，
 * 而真正的失败发生在 PS 5.1 解析脚本文件的那一刻）。 */
t('22a 脚本必须加 BOM，且加 BOM 后 PS 5.1 真的能读出中文路径', () => {
  const psScript = require('../lib/ps-script');
  /* 锁的是：withBom 的实现 —— 首字符必须是 U+FEFF，且重复调用不能叠加。 */
  assert.strictEqual(psScript.withBom('echo 1')[0], '\uFEFF', 'withBom 没有加 BOM');
  assert.strictEqual(psScript.withBom('\uFEFFecho 1'), '\uFEFFecho 1', 'withBom 不幂等');

  const { spawnSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hehe-ps-bom-'));
  const cnDir = path.join(tmp, '核核工具箱');
  fs.mkdirSync(cnDir);
  const target = path.join(cnDir, 'new.exe');
  fs.writeFileSync(target, 'x');
  const body = "if (Test-Path -LiteralPath '" + target + "') { 'EXISTS' } else { 'MISSING' }";
  const scriptPath = path.join(tmp, 'probe.ps1');
  fs.writeFileSync(scriptPath, psScript.withBom(body), 'utf8');
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { encoding: 'utf8' });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  if (r.error) { console.log('SKIP  powershell.exe 不可用：' + r.error.message); return; }
  /* 锁的是：带 BOM 的脚本在 PS 5.1 下必须按 UTF-8 解码 ——
   * 这条一旦红，说明「升级永远不生效」的根因回来了（或换了新引擎）。 */
  assert.ok(String(r.stdout).includes('EXISTS'),
    'PS 5.1 读带 BOM 的脚本仍读不到中文路径，输出：' + String(r.stdout).trim());
});

t('22b 主进程两处脚本都必须走 withBom（不许回退成裸 utf8 写盘）', () => {
  /* 锁的是：ps 与 rb 两条写盘都加了 BOM。只加 apply-update.ps1 的话，
   * 「双击回退」的兜底仍是坏的（用户升级失败后唯一的自救路径）。 */
  assert.ok(/psScript\.withBom\(ps\)/.test(mainSrc), 'apply-update.ps1 没有加 BOM');
  /* 锁的是：rollback.ps1 也必须加 BOM —— 它是升级失败时唯一的自救路径。 */
  assert.ok(/psScript\.withBom\(rb\)/.test(mainSrc), 'rollback.ps1 没有加 BOM');
  /* 锁的是：主进程必须真的 require lib/ps-script，否则上面的 BOM 是摆设。 */
  assert.ok(/require\('\.\/lib\/ps-script'\)/.test(mainSrc), '主进程没有引用 lib/ps-script');
});

t('23 更新脚本起不来时必须报错，不能静默退出假装升级', () => {
  const impl = mainSrc.slice(mainSrc.indexOf('async function updateApplyImpl'),
    mainSrc.indexOf('// 清理 update 下载目录'));
  assert.ok(impl.length > 500, '找不到 updateApplyImpl 的实现片段');
  /* 锁的是：① 用绝对路径调 powershell（绕开 PATH 异常）；
   * ② 等 'spawn'/'error' 确认真的起来了；③ 没起来要放开单飞标志并抛错，
   * 否则应用照样 1 秒后退出，用户重启回来还是旧版且没有任何提示。 */
  assert.ok(/WindowsPowerShell/.test(impl), '没有按绝对路径定位 powershell.exe');
  /* 锁的是：没有等待 spawn/error 事件就认定脚本起来了。 */
  assert.ok(/once\('spawn'/.test(impl) && /once\('error'/.test(impl),
    '没有等待 spawn/error 来确认脚本进程真的起来了');
  /* 锁的是：起不来时没有单独的失败分支（会继续假装升级）。 */
  assert.ok(/if \(!psStarted\)/.test(impl), '起不来时没有走失败分支');
  /* 锁的是：失败分支不放单飞标志 —— 用户连点都无法重试。 */
  assert.ok(/updateApplying = false;/.test(impl), '起不来时必须放开升级单飞标志，允许重试');
});

t('24 更新包重复下载不能死锁：自己的旧包可清，用户文件仍拒绝', () => {
  const { isOwnUpdateArtifact } = require('../lib/update-file');
  const userData = path.join(os.tmpdir(), 'hehe-ud-probe');
  const own = path.join(userData, 'update', 'hehe-toolbox-Portable-0.9.0.exe');
  /* 锁的是：自己的更新包必须被认出来。认不出来 → 第二次下载撞上
   * 「目标文件已存在」，而界面此时没有下载/安装按钮 = 死锁。 */
  assert.strictEqual(isOwnUpdateArtifact(own, userData), true, '自己的更新包应被认出');
  /* 锁的是：判据不能放宽到「userData 下任意 exe」—— 那会删用户文件。 */
  assert.strictEqual(isOwnUpdateArtifact(path.join(userData, '我的文档', 'x.exe'), userData), false,
    'userData 下普通 exe 不能算更新包');
  assert.strictEqual(isOwnUpdateArtifact(path.join(userData, 'update', 'notes.txt'), userData), false,
    'update 目录里的非 exe 不能算更新包');
  assert.strictEqual(isOwnUpdateArtifact(own + '.bak', userData), false,
    '备份文件不能算更新包');
  /* 锁的是：大小写归一 —— Windows 上路径比较必须忽略大小写。 */
  assert.strictEqual(isOwnUpdateArtifact(own.toUpperCase(), userData.toUpperCase()), true,
    '路径比较必须忽略大小写');

  const at = mainSrc.indexOf('handle(CH.NET.DOWNLOAD');
  assert.ok(at >= 0, '找不到 net:download');
  const seg = mainSrc.slice(at, at + 2200);
  /* 锁的是：下载闸门在「目标已存在」时，必须先认领自己的更新包并清掉旧件，
   * 否则重复下载永远被拒（第四轮审查的 P1 死锁）。 */
  assert.ok(/isOwnUpdateArtifact\(out, app\.getPath\('userData'\)\)/.test(seg),
    'net:download 必须按 isOwnUpdateArtifact 认领自己的更新包');
  /* 锁的是：认领了却不真的删旧包 —— 重复下载仍然被「已存在」挡住。 */
  assert.ok(/await fsp\.rm\(out, \{ force: true \}\)/.test(seg),
    '认领后必须真的清掉旧包（否则还是下不了）');
  /* 锁的是：非自己的目标仍然要拒绝 —— 不能为了修死锁放宽用户文件保护。 */
  assert.ok(/目标文件已存在，为避免覆盖已拒绝/.test(seg),
    '用户路径仍必须拒绝覆盖');
});

t('25 update:apply 的替换目标不能由渲染层指定（第四轮审查）', () => {
  const stripComments = require('../lib/src-scan').stripComments;
  const impl = stripComments(mainSrc.slice(mainSrc.indexOf('async function updateApplyImpl'),
    mainSrc.indexOf('// 清理 update 下载目录')));
  assert.ok(impl.length > 500, '找不到 updateApplyImpl 的实现片段');
  /* 背景：原表达式是 `PORTABLE_EXECUTABLE_FILE || opts.target || getPath('exe')`。
   * 绿色版没有 PORTABLE_EXECUTABLE_FILE 注入，于是渲染层传 target 就能让
   * 主进程用一份合法更新包覆盖任意 .exe（只校验 .exe 后缀）；
   * newExe 那边却审到了目录 + 资产名 + 体积 + SHA256 + PE 头。
   * 锁的是：target 只剩两个可信来源（打包器注入 / Electron 自己的 exe）。 */
  assert.ok(/process\.env\.PORTABLE_EXECUTABLE_FILE \|\| app\.getPath\('exe'\)/.test(impl),
    'target 应只来自 PORTABLE_EXECUTABLE_FILE 或 app.getPath(exe)');
  /* 锁的是：又接受渲染层传入的 target —— 任意 exe 覆盖的注入面复发。 */
  assert.ok(!/opts\.target/.test(impl), '不能再用 opts.target（渲染层可控）');
});

done();
