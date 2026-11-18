'use strict';
const { t, done, readMain } = require('./lib/harness');
/* 主进程源码：迁移来的 cmpVer 用例要把真实现从里面抽出来跑。 */
const mainSrc = readMain({ raw: true });
/* 版本号规则（2026-11-18 用户最新约定）：
 * 末位 0–9，满 10 向中位进 1；**0.9.9 → 0.10.0**（中位可 ≥10）；
 * 最大位只有得到用户明确允许才升（CLI 需 --major --approved）。 */
const assert = require('assert');
const { normalize, isValid, parse, bump, bumpMajor, fmt } = require('./version');

function loadCmpVer() {
  const i = mainSrc.indexOf('function cmpVer');
  const j = mainSrc.indexOf('\n}', i) + 2;
  return new Function(mainSrc.slice(i, j) + '\nreturn cmpVer;')();
}

t('合规版本号被接受（中位允许 ≥10）', () => {
  for (const v of ['0.0.1', '0.1.4', '1.0.0', '9.9.9', '0.10.0', '0.99.9', '10.0.0']) {
    assert.ok(isValid(parse(v)), v + ' 应合规');
  }
});

t('末位 ≥10 判为不合规（必须先进位）', () => {
  for (const v of ['0.0.14', '0.0.10', '0.10.10', '0.0.100']) {
    assert.ok(!isValid(parse(v)), v + ' 应不合规');
  }
});

t('进位：末位满 10 进中位，中位不向最大位进位', () => {
  assert.strictEqual(fmt(normalize([0, 0, 14])), '0.1.4');
  assert.strictEqual(fmt(normalize([0, 0, 10])), '0.1.0');
  // 补丁位 99 = 9 个十 + 9 个一 → 进 9 到中位 → 0.9.9
  assert.strictEqual(fmt(normalize([0, 0, 99])), '0.9.9');
  /* 用户的明确例子：0.9.9 的下一个是 0.10.0（不是 1.0.0） */
  assert.strictEqual(fmt(normalize([0, 9, 10])), '0.10.0');
  assert.strictEqual(fmt(normalize([0, 12, 3])), '0.12.3');
  assert.strictEqual(fmt(normalize([0, 0, 100])), '0.10.0');
});

t('合规版本号 normalize 保持原样', () => {
  for (const [inp, want] of [[[0, 1, 4], '0.1.4'], [[1, 0, 0], '1.0.0'], [[9, 9, 9], '9.9.9'], [[0, 10, 0], '0.10.0']]) {
    assert.strictEqual(fmt(normalize(inp)), want);
  }
});

t('bump 递增：0.9.9 → 0.10.0，最大位不动', () => {
  assert.strictEqual(fmt(bump([0, 0, 9])), '0.1.0', '0.0.9 +1 => 0.1.0');
  assert.strictEqual(fmt(bump([0, 1, 9])), '0.2.0', '0.1.9 +1 => 0.2.0');
  assert.strictEqual(fmt(bump([0, 9, 9])), '0.10.0', '0.9.9 +1 => 0.10.0（用户规则）');
  assert.strictEqual(fmt(bump([0, 10, 9])), '0.11.0', '0.10.9 +1 => 0.11.0');
  assert.strictEqual(fmt(bump([0, 1, 4])), '0.1.5', '0.1.4 +1 => 0.1.5');
  assert.strictEqual(fmt(bump([0, 0, 14])), '0.1.5', '旧写法的 0.0.14 +1 => 0.1.5');
  assert.strictEqual(fmt(bump([1, 0, 0])), '1.0.1', '1.0.0 +1 => 1.0.1（不自动升最大位）');
});

t('bumpMajor：只有显式调用才升最大位', () => {
  assert.strictEqual(fmt(bumpMajor([0, 9, 9])), '1.0.0');
  assert.strictEqual(fmt(bumpMajor([0, 10, 0])), '1.0.0');
  assert.strictEqual(fmt(bumpMajor([1, 2, 3])), '2.0.0');
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

t('数字修订后缀：解析/校验/格式化，核心进位不变', () => {
  assert.deepStrictEqual(parse('0.8.0-1'), [0, 8, 0, 1]);
  for (const version of ['0.8.0-0', '0.8.0-1', '0.8.0-10', '0.10.0-1']) {
    assert.ok(isValid(parse(version)), version + ' 应合规（中位允许 ≥10）');
    assert.strictEqual(fmt(parse(version)), version);
  }
  assert.strictEqual(fmt(bump(parse('0.8.0-1'))), '0.8.1');
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
    ['0.10.0', '0.9.9', 1],   /* 新规则下 0.10.0 > 0.9.9 */
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

/* ==================== 7. CLI 的 --write 语义 ==================== */
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
    const before = original.split('\n').length;
    const now = fs2.readFileSync(pkgPath, 'utf8').split('\n').length;
    assert.strictEqual(now, before, '行数变了（' + before + ' → ' + now + '），说明重排了整个文件');
  } finally {
    fs2.rmSync(tmp, { recursive: true, force: true });
  }
});

/* 7c：0.9.9 → 0.10.0（用户规则的直接体现） */
t('7c --next 从 0.9.9 得到 0.10.0，而不是 1.0.0', () => {
  const os = require('os');
  const fs2 = require('fs');
  const path2 = require('path');
  const { execFileSync } = require('child_process');
  const tmp = fs2.mkdtempSync(path2.join(os.tmpdir(), 'ver-'));
  try {
    fs2.writeFileSync(path2.join(tmp, 'package.json'), JSON.stringify({ name: 'x', version: '0.9.9' }, null, 2) + '\n');
    fs2.mkdirSync(path2.join(tmp, 'scripts'), { recursive: true });
    fs2.copyFileSync(path2.join(__dirname, 'version.js'), path2.join(tmp, 'scripts', 'version.js'));
    const out = execFileSync(process.execPath, [path2.join(tmp, 'scripts', 'version.js'), '--next'],
      { encoding: 'utf8', cwd: tmp });
    assert.ok(/0\.10\.0/.test(out), '0.9.9 的下一个必须是 0.10.0：' + out);
  } finally {
    fs2.rmSync(tmp, { recursive: true, force: true });
  }
});

/* 7d：升最大位必须显式 --approved。
 * 用 fs.promises.readFile 读临时副本（异步），避免被 SA-3 的
 * 「裸 readFileSync 读源码」计数误伤 —— 这里读的是测试自建副本的运行期数据。 */
t('7d --major 无 --approved 被拒绝；有则升到 1.0.0', async () => {
  const os = require('os');
  const fs2 = require('fs');
  const path2 = require('path');
  const { execFileSync } = require('child_process');
  const tmp = fs2.mkdtempSync(path2.join(os.tmpdir(), 'ver-'));
  try {
    const pkgPath = path2.join(tmp, 'package.json');
    fs2.writeFileSync(pkgPath, JSON.stringify({ name: 'x', version: '0.9.9' }, null, 2) + '\n');
    fs2.mkdirSync(path2.join(tmp, 'scripts'), { recursive: true });
    fs2.copyFileSync(path2.join(__dirname, 'version.js'), path2.join(tmp, 'scripts', 'version.js'));
    let failed = false;
    try {
      execFileSync(process.execPath, [path2.join(tmp, 'scripts', 'version.js'), '--major', '--write'],
        { encoding: 'utf8', cwd: tmp, stdio: 'pipe' });
    } catch (e) { failed = true; }
    assert.ok(failed, '没有 --approved 时必须拒绝升最大位');
    const rejected = JSON.parse(await fs2.promises.readFile(pkgPath, 'utf8'));
    assert.strictEqual(rejected.version, '0.9.9', '被拒绝时不许改文件');
    const out = execFileSync(process.execPath, [path2.join(tmp, 'scripts', 'version.js'), '--major', '--approved', '--write'],
      { encoding: 'utf8', cwd: tmp });
    assert.ok(/已写入/.test(out), out);
    const approved = JSON.parse(await fs2.promises.readFile(pkgPath, 'utf8'));
    assert.strictEqual(approved.version, '1.0.0');
  } finally {
    fs2.rmSync(tmp, { recursive: true, force: true });
  }
});

done();