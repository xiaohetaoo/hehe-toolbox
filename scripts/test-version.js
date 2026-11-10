'use strict';
const { t, done, readMain } = require('./lib/harness');
/* 主进程源码：迁移来的 cmpVer 用例要把真实现从里面抽出来跑。 */
const mainSrc = readMain({ raw: true });
/* 版本号进位规则：每段 0–9，满 10 向前进位。
 * 用户明确要求：以后版本号每过 10 都要向前进位。 */
const assert = require('assert');
const { normalize, isValid, parse, bump, fmt } = require('./version');

/* ---------------- 以下助手随 round13 的用例一起迁来 ----------------
 * loadCmpVer：把 cmpVer 的实现从源码里抽出来求值 ——
 * 它是**真实现**，不是手写副本（副本会与实现分叉，那样测试就假绿了）。 */



function loadCmpVer() {
  const i = mainSrc.indexOf('function cmpVer');
  const j = mainSrc.indexOf('\n}', i) + 2;
  return new Function(mainSrc.slice(i, j) + '\nreturn cmpVer;')();
}

t('合规版本号被接受', () => {
  for (const v of ['0.0.1', '0.1.4', '1.0.0', '9.9.9']) {
    assert.ok(isValid(parse(v)), v + ' 应合规');
  }
});

t('某段 >=10 判为不合规', () => {
  for (const v of ['0.0.14', '0.0.10', '0.10.1', '10.0.0']) {
    assert.ok(!isValid(parse(v)), v + ' 应不合规');
  }
});

t('进位：末位满 10 进中位', () => {
  assert.strictEqual(fmt(normalize([0, 0, 14])), '0.1.4');
  assert.strictEqual(fmt(normalize([0, 0, 10])), '0.1.0');
  // 补丁位 99 = 9 个十 + 9 个一 → 进 9 到中位 → 0.9.9（总值 99）
  assert.strictEqual(fmt(normalize([0, 0, 99])), '0.9.9');
  // 补丁位 100 = 10 个十 → 中位 +10 → 再进高位 → 1.0.0（总值 100）
  assert.strictEqual(fmt(normalize([0, 0, 100])), '1.0.0');
});

t('进位：中位满 10 进高位', () => {
  assert.strictEqual(fmt(normalize([0, 10, 0])), '1.0.0');
  assert.strictEqual(fmt(normalize([0, 12, 3])), '1.2.3');
});

t('进位：连锁进位', () => {
  // 0.9.10 -> 末位 10 进中位 -> 0.10.0 -> 中位 10 进高位 -> 1.0.0
  assert.strictEqual(fmt(normalize([0, 9, 10])), '1.0.0');
});

t('合规版本号 normalize 保持原样', () => {
  for (const [inp, want] of [[[0, 1, 4], '0.1.4'], [[1, 0, 0], '1.0.0'], [[9, 9, 9], '9.9.9']]) {
    assert.strictEqual(fmt(normalize(inp)), want);
  }
});

t('bump 递增并按规则进位', () => {
  assert.strictEqual(fmt(bump([0, 0, 9])), '0.1.0', '0.0.9 +1 => 0.1.0');
  assert.strictEqual(fmt(bump([0, 1, 9])), '0.2.0', '0.1.9 +1 => 0.2.0');
  assert.strictEqual(fmt(bump([0, 9, 9])), '1.0.0', '0.9.9 +1 => 1.0.0');
  assert.strictEqual(fmt(bump([0, 1, 4])), '0.1.5', '0.1.4 +1 => 0.1.5');
  assert.strictEqual(fmt(bump([0, 0, 14])), '0.1.5', '旧写法的 0.0.14 +1 => 0.1.5');
});

t('非法输入返回 null', () => {
  for (const v of ['', 'abc', '1.2', '1.2.3.4', '1.2.x', null, undefined]) {
    assert.strictEqual(parse(v), null, String(v) + ' 应解析失败');
  }
});

t('package.json 当前版本合规', () => {
  const v = require('../package.json').version;
  assert.ok(isValid(parse(v)), `package.json version=${v} 不合规，应按规则进位`);
});
t('数字修订后缀能够解析、校验与格式化，核心版本进位不变', () => {
  assert.deepStrictEqual(parse('0.8.0-1'), [0, 8, 0, 1]);
  for (const version of ['0.8.0-0', '0.8.0-1', '0.8.0-10']) {
    assert.ok(isValid(parse(version)));
    assert.strictEqual(fmt(parse(version)), version);
  }
  assert.strictEqual(fmt(bump(parse('0.8.0-1'))), '0.8.1');
  assert.strictEqual(isValid(parse('0.10.0-1')), false);
  for (const version of ['0.8.0-', '0.8.0--1', '0.8.0-01', '0.8.0-beta', '0.8.0-9007199254740992']) {
    assert.strictEqual(parse(version), null, version);
  }
});

t('5a cmpVer：带 -beta / -rc1 后缀的版本号不能被判成「更旧」', () => {
  const cmpVer = loadCmpVer();
  assert.strictEqual(cmpVer('0.3.5-beta', '0.3.4'), 1,
    '预发布版仍比上一版新；原实现返回 -4（NaN 参与运算）');
  assert.strictEqual(cmpVer('0.4.0-rc1', '0.3.9'), 1);
  assert.strictEqual(cmpVer('0.3.5-beta', '0.3.5'), 0, '同一版本号的不同标记应视为相等');
});

t('5b cmpVer：三态语义（只返回 -1/0/1），且常规比较不变', () => {
  const cmpVer = loadCmpVer();
  const table = [
    ['0.3.5', '0.3.4', 1], ['0.3.4', '0.3.5', -1], ['0.3.5', '0.3.5', 0],
    ['0.3.10', '0.3.9', 1], ['0.0.9', '0.0.10', -1], ['1.0.0', '0.9.9', 1],
    ['v0.3.5', '0.3.4', 1],
  ];
  for (const [a, b, want] of table) {
    assert.strictEqual(cmpVer(a, b), want, 'cmpVer(' + a + ', ' + b + ') 应为 ' + want);
  }
});

t('5c cmpVer：无法解析的输入不抛异常，按 0 处理', () => {
  const cmpVer = loadCmpVer();
  assert.doesNotThrow(() => cmpVer('', '0.3.5'));
  assert.doesNotThrow(() => cmpVer('abc', undefined));
  assert.strictEqual(cmpVer('abc', '0.0.0'), 0, '解析不出来时按 0 比较，不能是 NaN');
});

/* ==================== 6. 数据文件损坏时不能静默覆盖 ==================== */


/* ==================== 7. CLI 的 --write 语义 ====================
 *
 * 这一组锁的是「脚本名说 bump，行为却只打印」那个坑：
 * 发版时照着 npm run version:bump 的输出改，才发现它从来没写过文件。
 * 现在默认仍是「只预览」，但输出里必须**明说没写**；加 --write 才落盘。
 *
 * 【为什么必须在临时副本上跑】
 * 它会改 package.json。真改仓库那份，一次测试失败就能把版本号留在半路。
 * 所以复制一份到临时目录，在副本上执行，跑完删掉。 */
t('7a version.js --next 默认只预览，不写文件，且明说「未写入」', () => {
  const os = require('os');
  const fs2 = require('fs');
  const path2 = require('path');
  const { execFileSync } = require('child_process');
  const tmp = fs2.mkdtempSync(path2.join(os.tmpdir(), 'ver-'));
  try {
    const pkgPath = path2.join(tmp, 'package.json');
    fs2.writeFileSync(pkgPath, JSON.stringify({ name: 'x', version: '0.3.9' }, null, 2) + '\n');
    fs2.mkdirSync(path2.join(tmp, 'scripts'), { recursive: true });
    fs2.copyFileSync(path2.join(__dirname, 'version.js'), path2.join(tmp, 'scripts', 'version.js'));

    const out = execFileSync(process.execPath, [path2.join(tmp, 'scripts', 'version.js'), '--next'],
      { encoding: 'utf8', cwd: tmp });
    assert.ok(/0\.4\.0/.test(out), '应算出下一个版本 0.4.0，实际输出：' + out);
    assert.ok(/未写入/.test(out), '必须明确告知「未写入」，否则使用者会以为已经改了：' + out);
    const after = JSON.parse(fs2.readFileSync(pkgPath, 'utf8')).version;
    assert.strictEqual(after, '0.3.9', '预览模式不许改文件，实际变成了 ' + after);
  } finally {
    fs2.rmSync(tmp, { recursive: true, force: true });
  }
});

t('7b version.js --next --write 会真的写入，且只改 version 一行', () => {
  const os = require('os');
  const fs2 = require('fs');
  const path2 = require('path');
  const { execFileSync } = require('child_process');
  const tmp = fs2.mkdtempSync(path2.join(os.tmpdir(), 'ver-'));
  try {
    const pkgPath = path2.join(tmp, 'package.json');
    /* 特意用带缩进和额外字段的格式，检查写回时不会重排整个文件 */
    const original = JSON.stringify({ name: 'x', version: '0.3.9', description: '保持原样' }, null, 2) + '\n';
    fs2.writeFileSync(pkgPath, original);
    fs2.mkdirSync(path2.join(tmp, 'scripts'), { recursive: true });
    fs2.copyFileSync(path2.join(__dirname, 'version.js'), path2.join(tmp, 'scripts', 'version.js'));

    const out = execFileSync(process.execPath, [path2.join(tmp, 'scripts', 'version.js'), '--next', '--write'],
      { encoding: 'utf8', cwd: tmp });
    assert.ok(/已写入/.test(out), '写了就要说写了：' + out);
    const after = JSON.parse(fs2.readFileSync(pkgPath, 'utf8'));
    assert.strictEqual(after.version, '0.4.0', 'version 没被改到 0.4.0');
    assert.strictEqual(after.description, '保持原样', '其他字段被动了');
    /* 只应该变一行 —— 用 JSON 重写会改变缩进/键序，diff 会显得像动了整个文件 */
    const before = original.split('\n').length;
    const now = fs2.readFileSync(pkgPath, 'utf8').split('\n').length;
    assert.strictEqual(now, before, '行数变了（' + before + ' → ' + now + '），说明重排了整个文件');
  } finally {
    fs2.rmSync(tmp, { recursive: true, force: true });
  }
});

done();
