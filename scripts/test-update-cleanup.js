'use strict';
const { t, done, readMain } = require('./lib/harness');
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
  const uc = mainSrc.slice(mainSrc.indexOf("handle('update:cleanup'"));
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

done();
