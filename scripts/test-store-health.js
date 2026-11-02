'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const assert = require('assert');
const { t, done, readMain } = require('./lib/harness');
const mainSrc = readMain({ raw: true });

/* 数据文件健康检查的行为测试（原 test-round13 的 6a / 6b）。
 *
 * 锁的是：损坏的数据文件必须**先另存副本再回退默认值** ——
 * 直接覆盖等于把用户攒了几年的收藏/便签一次性删掉，而且无从恢复。
 * 6b 锁的是 store:health 通道确实存在且渲染层会用它提示用户。 */

/* 读项目内文件（6a 要读 main.js 的 loadStore 实现）。 */
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { try { cp.execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', dir], { windowsHide: true }); } catch (e2) {} }
}

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

t('6a loadStore 行为：损坏的数据文件要先另存副本，再回退默认值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12x-store-'));
  try {
    const fake = path.join(dir, 'hehe-data.json');
    const good = {
      settings: { theme: 'dark' }, favorites: ['a', 'b'],
      notes: Array.from({ length: 50 }, (_, i) => ({ id: 'n' + i, text: '笔记' + i })),
    };
    const raw = JSON.stringify(good, null, 2);
    fs.writeFileSync(fake, raw.slice(0, raw.length - 40));   // 模拟断电截断

    /* 抽出 loadStore 的真实现，注入假的 storeFile / storeData。
     * 用 ctx 对象回传：new Function 里的局部变量改完要能带出来。 */
    const i = mainSrc.indexOf('function loadStore');
    const j = mainSrc.indexOf('function saveStore');
    assert.ok(i > 0 && j > i, '找不到 loadStore');
    const body = mainSrc.slice(i, j);
    const ctx = { data: { settings: {}, favorites: [], notes: [] }, failed: false, copy: null };
    const run2 = new Function('fs', 'storeFile', 'ctx', 'console',
      'let storeData = ctx.data, storeLoadFailed = ctx.failed, storeCorruptCopy = ctx.copy;' +
      body +
      '\nloadStore();\nctx.data = storeData; ctx.failed = storeLoadFailed; ctx.copy = storeCorruptCopy;');
    run2(fs, () => fake, ctx, { error: () => {}, warn: () => {} });

    assert.strictEqual(ctx.failed, true, '解析失败必须标记 storeLoadFailed');
    assert.ok(ctx.copy, '必须另存一份损坏文件的副本，否则 200ms 后就被默认值覆盖了');
    assert.ok(fs.existsSync(ctx.copy), '副本文件应真实存在：' + ctx.copy);
    assert.strictEqual(fs.readFileSync(ctx.copy, 'utf8'), fs.readFileSync(fake, 'utf8'),
      '副本内容必须与损坏的原文件逐字节相同');

    /* 关键后置条件：即使用户随后改了设置、原文件被覆盖，副本仍在 */
    const after = { settings: { closeToTray: false }, favorites: [], notes: [] };
    fs.writeFileSync(fake, JSON.stringify(after, null, 2));
    assert.ok(fs.existsSync(ctx.copy), '原文件被覆盖后，副本必须仍然存在');
  /* 锁的是：「6a loadStore 行为：损坏的数据文件要先另存副本，再回退默认值」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    assert.ok(/笔记/.test(fs.readFileSync(ctx.copy, 'utf8')), '副本里应还留有可抢救的原始内容');
  } finally { rmDir(dir); }
});

t('6b main.js 暴露了 store:health，且渲染层真的会用它提示用户', () => {
  /* 锁的是：「6b main.js 暴露了 store:health，且渲染层真的会用它提示用户」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/handle\('store:health'/.test(mainSrc), '缺少 store:health 通道');
  /* 锁的是：「6b main.js 暴露了 store:health，且渲染层真的会用它提示用户」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/corruptCopy/.test(mainSrc), 'store:health 应带上副本路径');
  /* 光「调用了通道」不够 —— 必须真的把结果用于提示，且用户的可见反馈要带上
   * 副本文件名（否则用户不知道去哪找原数据）。这里查的是行为链，不是某个变量名。 */
  const app = read('js/app.js');
  /* 锁的是：「6b main.js 暴露了 store:health，且渲染层真的会用它提示用户」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  const m = app.match(/store:health[\s\S]{0,900}?\n    \}/);
  assert.ok(m, '渲染层没有读取 store:health，用户不会知道数据文件坏了');
  const block = m[0];
  /* 锁的是：「6b main.js 暴露了 store:health，且渲染层真的会用它提示用户」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/health\.ok === false|!health\.ok/.test(block),
    '必须显式判断 health.ok === false 才提示（否则每次启动都会弹）');
  /* 锁的是：「6b main.js 暴露了 store:health，且渲染层真的会用它提示用户」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/toast\(/.test(block), '发现损坏后必须 toast 告知用户');
  /* 锁的是：「6b main.js 暴露了 store:health，且渲染层真的会用它提示用户」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/corruptCopy/.test(block), '提示里要带副本文件名，否则用户不知道去哪找原数据');
});

done();
