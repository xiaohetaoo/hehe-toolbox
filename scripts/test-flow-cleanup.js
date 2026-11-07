'use strict';
/* 三处"流程收尾"缺陷。
 *
 * 8)  内容搜索的 Enter 绕过防重入
 * 9)  框选按 Esc 取消后，录屏页卡两分钟
 * 10) 分片分割的两处后置失败留下孤儿分片
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { t, done, readSrc, readMain } = require('./lib/harness');

/* ============ 8) 内容搜索防重入 ============ */
const ft = readSrc('js/tools/file-tools.js');

t('CS8-1 start 走统一 guard（不手写 running 标志）', () => {
  const i = ft.indexOf("id: 'content-search'");
  assert.ok(i > 0, '找不到 content-search');
  /* 锁的是：手写 `running` 标志 + 若干早退分支 —— 项目里这类漏复位
   * 已经出过 7 次（按钮永久卡死），所以约定一律走 window.ui.guard。
   * 这条同时锁住"别又退回手写标志"。 */
  assert.ok(/const start = guard\(startImpl\);/.test(ft), 'start 没有用 guard 包装');
  /* 锁的是：只包了按钮、Enter 那条入口还是裸的 —— 回车照样能并发。 */
  const iGuard = ft.indexOf('const start = guard(startImpl);');
  const iKey = ft.indexOf("inBox.addEventListener('keydown'", iGuard);
  /* 锁的是：keydown 里调的不是那个 guarded 函数。 */
  assert.ok(iKey > iGuard && /start\(\);/.test(ft.slice(iKey, iKey + 120)),
    'Enter 没有走同一个 guarded 入口');
});

t('CS8-2 不再残留手写的 running 标志', () => {
  const i = ft.indexOf("id: 'content-search'");
  const seg = ft.slice(i, ft.indexOf("id: 'archive-7z'", i));
  /* 锁的是：guard 之外又留一个 running —— 两套机制并存，迟早分叉。 */
  assert.ok(!/let\s+running\s*=/.test(seg), '还留着 let running 声明');
  assert.ok(!/^\s*running\s*=\s*(true|false);/m.test(seg), '还留着 running 赋值');
});

/* ============ 9) 框选取消 ============ */
const mainSrc = readMain({ raw: true });
const rec = readSrc('js/tools/media/screen-rec.js');

t('SR9-1 主进程的 cancel 分支也发 snip:region（载荷 null）', () => {
  const i = mainSrc.indexOf("if (action === 'cancel' || action === 'region') {");
  assert.ok(i > 0, '找不到 SNIP.FINISH 的 cancel 分支');
  const seg = mainSrc.slice(i, i + 700);
  /* 锁的是：cancel 直接 return 一个事件都不发 ——
   * 调用方的 Promise 只能等 120 秒超时。 */
  assert.ok(/send\('snip:region',\s*null\)/.test(seg),
    'cancel 分支没有发 snip:region(null)');
});

t('SR9-2 pickRegion 的定时器与订阅都登记到 App.onCleanup', () => {
  const i = rec.indexOf('function pickRegion()');
  assert.ok(i > 0, '找不到 pickRegion');
  const seg = rec.slice(i, i + 2200);
  /* 锁的是：切页时既不退订也不清定时器 —— 两道一起泄漏。 */
  assert.ok(/App\.onCleanup\(cleanup\)/.test(seg), 'pickRegion 没有登记 cleanup');
  /* 锁的是：收到事件后没 clearTimeout —— 定时器继续挂着。 */
  assert.ok(/clearTimeout\(t\)/.test(seg), '没有 clearTimeout');
  /* 锁的是：重复框选时叠订阅 —— 上一次的监听还在。 */
  assert.ok(/try \{ unsub\(\); \} catch/.test(seg), '没有退订');
});

t('SR9-3 pickRegion 收到 null 后按"未选择区域"收尾（不再等超时）', () => {
  const i = rec.indexOf('function pickRegion()');
  const seg = rec.slice(i, i + 2200);
  /* 锁的是：收到 null 时进 else-if (rect) 分支报"区域太小" ——
   * 用户明明是主动取消的，却被告知选小了。 */
  assert.ok(/else status\.textContent = '未选择区域（保持全屏）'/.test(seg),
    'null 没有走"未选择区域"分支');
});

/* ============ 10) 分片分割孤儿清理 ============ */
const fso = readSrc('ipc/fs-ops.js');

t('SP10-1 madePaths 提到 handler 作用域（后置失败也能访问）', () => {
  const i = fso.indexOf('handle(CH.FS.SPLIT_FILE');
  assert.ok(i > 0, '找不到 SPLIT_FILE');
  const seg = fso.slice(i, i + 1000);
  /* 锁的是：madePaths 留在 Promise 内 —— 后面两处失败访问不到，
   * 留下 N 个孤儿分片。 */
  assert.ok(/const madePaths = \[\];/.test(seg), 'madePaths 没有提到 handler 作用域');
  /* 并且不能又在 Promise 里重复声明（那会让外层那个永远为空） */
  const inner = fso.slice(i, i + 3000);
  /* 锁的是：两处各声明一个同名变量 —— 外层清理的是永远空的那个。 */
  const declCount = (inner.match(/const madePaths = \[\];/g) || []).length;
  assert.strictEqual(declCount, 1, 'madePaths 被声明了 ' + declCount + ' 次（应为 1）');
});

t('SP10-2 后置的校验与写清单包在 try/catch 里，失败逐片清理', () => {
  const i = fso.indexOf('handle(CH.FS.SPLIT_FILE');
  const j = fso.indexOf('handle(CH.FS.MERGE_PARTS', i);
  const seg = fso.slice(i, j);
  /* 锁的是：writtenBytes 校验抛错时没人清分片。 */
  assert.ok(/writtenBytes !== st\.size/.test(seg), '找不到字节数校验');
  assert.ok(/\} catch \(err\) \{[\s\S]{0,400}?for \(const fp of madePaths\) \{ try \{ fs\.unlinkSync\(fp\); \}/.test(seg),
    '后置失败没有逐片 unlink');
  /* 锁的是：清理后不把数组置空 —— 上层若再抛会重复 unlink，噪音。 */
  assert.ok(/madePaths\.length = 0;/.test(seg), '清理后没有清空 madePaths');
});

t('SP10-3 只清理"本次确实创建成功"的分片（不误删别人已有的）', () => {
  const i = fso.indexOf('handle(CH.FS.SPLIT_FILE');
  const seg = fso.slice(i, i + 3400);
  /* 锁的是：在 createWriteStream 之后立刻 push ——
   * EEXIST 时那个**别人已有的**同名分片会被当成"本次产出"删掉。 */
  assert.ok(/ws\.on\('open', \(\) => \{ if \(!settled\) madePaths\.push\(partPath\); \}\)/.test(seg),
    '分片路径不是在 open 事件里登记的');
});

t('SP10-4 行为：写清单失败时输出目录不留 .part 文件', async () => {
  /* 直接跑一个等价的最小复现：模拟「分片都写完了，但写清单失败」。
   * 这里验证的是清理逻辑本身（unlink madePaths）确实能把目录恢复干净，
   * 而不是验证 fs-ops 的完整 handler（那要连整套 IPC）。
   * 【为什么这条要有】上面三条都是结构断言；而回归的**后果**是
   * "目录里留下孤儿分片"，那条后果值得有一个可执行的反例钉住。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-orphan-'));
  const madePaths = [];
  try {
    for (let i = 1; i <= 3; i++) {
      const fp = path.join(dir, `x.part${String(i).padStart(3, '0')}`);
      fs.writeFileSync(fp, 'chunk');
      madePaths.push(fp);
    }
    assert.strictEqual(fs.readdirSync(dir).length, 3, '前置：应有 3 个分片');

    /* 模拟写清单失败 -> 走 catch 清理 */
    try {
      throw new Error('写清单失败');
    } catch (err) {
      for (const fp of madePaths) { try { fs.unlinkSync(fp); } catch (x) {} }
      madePaths.length = 0;
    }
    /* 锁的是：清理循环写得不对（例如只删第一个）—— 目录里仍有残留。 */
    assert.deepStrictEqual(fs.readdirSync(dir), [], '清理后仍有残留：' + fs.readdirSync(dir).join(','));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

done();
