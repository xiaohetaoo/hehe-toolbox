'use strict';
/* 行为验证：update:cleanup 的判定逻辑（不能靠“代码里有 cmpVer”就算数）。
 * 复刻 main.js 里的取舍规则，在临时目录造出各种版本号的包，看谁被删、谁被留。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
}

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
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
