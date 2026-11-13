'use strict';
/* 三个批量工具的取消守卫测试 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, ROOT } = require('./lib/harness');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* 通用断言：有 cancelFlag 声明、循环里有 break、有停止按钮、收尾复位 */
function checkCancel(rel, loopRe, btnName) {
  const s = read(rel);
  /* 锁的是：cancelFlag 声明存在（漏了会成隐式全局，严格模式下抛错） */
  assert.ok(/let cancelFlag/.test(s), rel + ' 缺 let cancelFlag 声明');
  /* 锁的是：循环内必须检查标志 —— 只声明不检查等于没有取消能力。 */
  const loopMatch = s.match(loopRe);
  assert.ok(loopMatch, rel + ' 找不到批量循环');
  const loopStart = loopMatch.index;
  const loopEnd = s.indexOf('        }', loopStart);
  const loopBody = s.slice(loopStart, loopEnd > 0 ? loopEnd : loopStart + 3000);
  /* 锁的是：循环内检查标志的那一行 —— 只声明不检查等于没有取消能力。 */
  assert.ok(/if \(cancelFlag\) break/.test(loopBody), rel + ' 循环内缺 cancelFlag break');
  /* 锁的是：停止按钮存在且点击置位标志 */
  assert.ok(new RegExp("btn\\('" + btnName + "'").test(s), rel + ' 缺停止按钮');
  /* 锁的是：按钮点击必须置位标志（否则按钮是个空壳）。 */
  assert.ok(/cancelFlag = true/.test(s), rel + ' 停止按钮应置位 cancelFlag');
}

t('BC1 img-compress 有停止能力', () => {
  checkCancel('js/tools/media/img-compress.js', /for \(let i = 0; i < paths\.length; i\+\+\)/, '停止');
});

t('BC2 img-watermark 有停止能力', () => {
  checkCancel('js/tools/media/img-watermark.js', /for \(let i = 0; i < paths\.length; i\+\+\)/, '停止');
});

t('BC3 batch-ocr 有停止能力', () => {
  checkCancel('js/tools/media/batch-ocr.js', /for \(const it of imgs\)/, '停止');
});

t('BC4 三个工具的收尾都复位标志与按钮', () => {
  /* 锁的是：取消后再跑第二次 —— 标志没复位的话第二次直接 break，
   * 表现为「停止之后再也压不动」。 */
  for (const rel of ['js/tools/media/img-compress.js', 'js/tools/media/img-watermark.js',
    'js/tools/media/batch-ocr.js']) {
    const s = read(rel);
    const resets = (s.match(/cancelFlag = false/g) || []).length;
    /* 锁的是：收尾复位标志 —— 没有它第二次运行直接 break。 */
    assert.ok(resets >= 1, rel + ' 缺 cancelFlag 复位');
    /* 锁的是：收尾复位停止按钮 —— 没有它第二次运行时按钮仍是禁用。 */
    assert.ok(/stopBtn\.disabled = true|ocrStopBtn\.disabled = true|wmStopBtn\.disabled = true/.test(s),
      rel + ' 缺停止按钮复位');
  }
});

done();
