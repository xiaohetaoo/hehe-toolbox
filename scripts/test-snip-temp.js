'use strict';
const assert = require('assert');
const { t, done, readMain } = require('./lib/harness');
const mainSrc = readMain({ raw: true });

/* 截图临时文件的行为测试（原 test-round13 的 21a / 21b）。
 *
 * 锁的是：
 *   21a  文件名带随机后缀（同一毫秒连按两次截图不能撞名），
 *        且必须仍在临时白名单内（否则启动清扫会删掉 / 或永远不删）。
 *   21b  窗口关闭 / 取消 / 保存后都要清掉临时 PNG（否则 %TEMP% 无限增长）。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

t('21a 截图：文件名带随机后缀（同一毫秒两次不撞名）且仍在临时白名单内', () => {
  /* 【改成行为断言】原来是在 main.js 里截 `const snipTmp =` 后面 300 字符，
   * 看里面有没有 randomBytes —— 那是在断言「实现里出现了某个 API 名」。
   * 任务 10 把临时名生成搬进 lib/temp-names.js（随机后缀由那里的 stamp() 提供）
   * 之后 main.js 只剩一行委托，断言自然失配（而行为完全正确）。
   * 真正要守的是两个语义：
   *   1) 同一毫秒两次调用**不撞名**（撞名会让后一张截图覆盖前一张）；
   *   2) 生成出来的名字**仍在清理白名单里**（否则崩溃残留永远清不掉）。 */
  const T = require('../lib/temp-names');
  const pathMod = require('path');
  const NOW = 1700000000000;
  const a = T.snipTmp({ now: NOW });
  const b = T.snipTmp({ now: NOW });
  assert.notStrictEqual(a, b, '同一毫秒两次调用撞名了（后一张截图会覆盖前一张）');
  assert.ok(T.isOwnTempName(pathMod.basename(a)), '生成的截图临时名不在白名单里：' + a);

  /* 白名单形态断言保留，但直接跑真实现（不再从 main.js 抠源码求值） */
  const isOwn = (n) => T.isOwnTempName(n);
  assert.ok(isOwn('hehe-snip-1700000000000.png'), '老格式必须在白名单里');
  assert.ok(isOwn('hehe-snip-1700000000000-abc123.png'), '带随机后缀的新格式必须在白名单里');
  assert.ok(isOwn('hehe-toolbox-Portable-0.3.5.exe.part-1700000000-abcdef'), '下载残留的 .part 也要能被清理');
  assert.ok(!isOwn('照片.png'), '白名单不能误伤别人的文件');
  assert.ok(!isOwn('random.part-123-abc'), '白名单不能误伤别人的 .part');
});

t('21b 截图：窗口关闭 / 取消 / 保存后都要清掉临时 PNG', () => {
  /* 【这段要覆盖「变量声明 → 清理函数 → 窗口事件」，不是单个函数】
   * 原来用 `mainSrc.indexOf('// 贴剪贴板图片（托盘/工具用）')` 当右边界。
   * 换成 segFromFn('let snipSrcFile = null') 是**错**的 —— 那是个变量声明，
   * 它后面的第一个 '{' 属于下一个函数，配平会取到很窄的一段，
   * 于是 dropSnipSrc 与 snipWin.on 都不在里面（实测这条立刻红了）。
   * 正确的边界是「声明处 → 下一个顶层定义」，用「走到下一个 'function ' 之前」
   * 来定位：这两个定义在该区间内是连续的，中间不会插入别的顶层函数。
   * 若将来中间插入了新函数，这条会因取到的片段变短而红 —— 那是应该被看见的。 */
  const start = mainSrc.indexOf('let snipSrcFile = null');
  assert.ok(start > 0, '找不到 snipSrcFile 声明');
  const nextFn = mainSrc.indexOf('\nfunction ', start + 10);
  const seg = mainSrc.slice(start, nextFn > start ? nextFn : start + 3000);
  assert.ok(/dropSnipSrc/.test(seg), '缺少统一的临时文件清理函数');
  assert.ok(/snipWin\.on\('closed', \(\) => \{ snipWin = null; dropSnipSrc\(\); \}\)/.test(seg),
    '窗口关闭时必须清理（Esc 取消 / 直接关窗都走这条路）');
  assert.ok(/finally \{[\s\S]{0,400}fs\.rmSync\(file, \{ force: true \}\)/.test(seg),
    '"另存为"分支必须自己收尾，否则每保存一次就多留一张');
});

/* ==================== 22. seven:extract 回滚改成搬回 ==================== */

done();
