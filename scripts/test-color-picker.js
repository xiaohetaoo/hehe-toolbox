'use strict';
/* 取色器增强：历史色板 + 多格式输出的换算正确性。
 *
 * ============ 锁的是哪次事故 ============
 * 本轮给取色器加了三样：历史色板（12 个，去重）、多格式输出
 * （HEX / rgb() / hsl() / CSS 变量 / Win32 COLORREF）、初次渲染兜底。
 * 锁的是两件"错了会给出错误颜色值"的事：
 *   1. **Win32 COLORREF 是 BGR 顺序**，不是 RGB。写反了红蓝互换，
 *      而界面上的色块看起来还是对的（因为色块用的是 HEX）——
 *      用户把 COLORREF 粘进注册表或 Win32 调用才发现颜色不对；
 *   2. hue 计算在 max===r/g/b 三种分支下的偏移量（+0 / +2 / +4）
 *      与 gg<bb 时的 +6 修正，少一项就会让接近 360° 的颜色算成 0°。
 *
 * 【为什么用行为断言而不是源码匹配】这两个换算都是纯函数，
 * 可以在测试里直接跑真实逻辑喂已知值。vm 沙箱里跑 dev.js 太重
 * （它依赖 window.ui / window.Registry），所以这里把公式抄进测试 ——
 * 这是个例外：抄写会有漂移风险，所以后面再用一条源码断言
 * 确认实现里确实是这个公式（两边互相印证）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, ROOT } = require('./lib/harness');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* 与实现同源的换算（见下方 CP5 的源码印证） */
function colorRefOf(r, g, b) {
  const v = ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
  return '0x' + v.toString(16).toUpperCase().padStart(6, '0');
}
function rgbToHsl(r, g, b) {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  let h = 0, sl = 0;
  if (max !== min) {
    const d = max - min;
    sl = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0));
    else if (max === gg) h = ((bb - rr) / d + 2);
    else h = ((rr - gg) / d + 4);
    h *= 60;
  }
  return [Math.round(h), Math.round(sl * 100), Math.round(l * 100)];
}

t('CP1 COLORREF 是 BGR 顺序（红蓝不能写反）', () => {
  /* 锁的是：把 0x00BBGGRR 写成 0x00RRGGBB。写反后纯红会得 0xFF0000，
   * 而 Win32 会把它解释成纯蓝。 */
  assert.strictEqual(colorRefOf(255, 0, 0), '0x0000FF', '纯红应在低字节');
  assert.strictEqual(colorRefOf(0, 0, 255), '0xFF0000', '纯蓝应在高字节');
  assert.strictEqual(colorRefOf(0, 255, 0), '0x00FF00');
  assert.strictEqual(colorRefOf(255, 255, 255), '0xFFFFFF');
  assert.strictEqual(colorRefOf(0, 0, 0), '0x000000');
});

t('CP2 HSL 三原色与灰度换算准确', () => {
  assert.deepStrictEqual(rgbToHsl(255, 0, 0), [0, 100, 50]);
  assert.deepStrictEqual(rgbToHsl(0, 255, 0), [120, 100, 50]);
  assert.deepStrictEqual(rgbToHsl(0, 0, 255), [240, 100, 50]);
  assert.deepStrictEqual(rgbToHsl(255, 255, 255), [0, 0, 100]);
  assert.deepStrictEqual(rgbToHsl(0, 0, 0), [0, 0, 0]);
  assert.deepStrictEqual(rgbToHsl(128, 128, 128), [0, 0, 50]);
});

t('CP3 HSL 的 gg<bb 跨零修正（红区绕回 360°）', () => {
  /* 锁的是：max===r 且 g<b 时 hue 要 +6 再乘 60，否则洋红会被算成 -60/0。
   * 这是 HSL 公式里最容易漏的一项。 */
  const magenta = rgbToHsl(255, 0, 255);   // 洋红应在 300°
  assert.strictEqual(magenta[0], 300, '洋红 hue 应为 300，实际 ' + magenta[0]);
  const rose = rgbToHsl(255, 0, 128);      // 偏红的粉，hue 在 300-360 之间
  assert.ok(rose[0] > 300 && rose[0] < 360, 'hue 应在 300-360，实际 ' + rose[0]);
});

t('CP4 历史色板：上限 12 且去重', () => {
  const s = read('js/tools/dev.js');
  /* 锁的是：上限与去重。不去重的话连续点同一个按钮取色会
   * 把历史塞满同一个颜色，参考价值为零。 */
  assert.ok(/HISTORY_MAX\s*=\s*12/.test(s), '上限应为 12');
  /* 锁的是：按 hex 去重的那一行（去掉它历史就会堆满重复色）。 */
  assert.ok(/findIndex\(\(x\)\s*=>\s*x\.hex === hex\)/.test(s), '应有按 hex 去重');
  /* 锁的是：超出上限时的截断（少了这行数组会无限增长）。 */
  assert.ok(/history\.length > HISTORY_MAX/.test(s), '应截断到上限');
});

t('CP5 实现里的公式与测试中的一致', () => {
  const s = read('js/tools/dev.js');
  /* 锁的是：测试抄的公式与实现漂移。上面 CP1/CP2/CP3 用的是测试内
   * 的副本，这条确保实现里确实是同一套公式（两边互相印证）。 */
  /* 锁的是：实现里 COLORREF 的组合顺序（BGR），与测试副本一致。 */
  assert.ok(/\(\(b & 0xff\) << 16\) \| \(\(g & 0xff\) << 8\) \| \(r & 0xff\)/.test(s),
    '实现里的 COLORREF 组合方式应与测试一致（BGR）');
  /* 锁的是：实现里 gg<bb 的 +6 修正没被漏掉（CP3 的行为断言验的是副本，
   * 这条确保实现里真写了这段）。 */
  assert.ok(/gg < bb \? 6 : 0/.test(s), '实现里应有 gg<bb 的 +6 修正');
});

t('CP6 初次渲染就画出色板与格式行', () => {
  const s = read('js/tools/dev.js');
  /* 锁的是：两个容器在页面打开时是空白。paintHistory/paintFormats
   * 只在交互时调用的话，刚进页面看到的是两张空卡片，像坏了。 */
  assert.ok(/paintHistory\(\);\s*\n\s*paintFormats\(/.test(s),
    '页面组装完成后应各调一次 paintHistory / paintFormats');
});

t('CP7 色板样式存在且可聚焦', () => {
  const css = read('css/app.css');
  /* 锁的是：色块没有 focus-visible 样式 —— 键盘用户 Tab 到色块时
   * 看不出焦点在哪（色块本身是纯色，不会像按钮那样有边框变化）。 */
  assert.ok(/\.color-chip/.test(css), '需 .color-chip 样式');
  /* 锁的是：色块焦点样式被删（键盘用户看不出焦点在哪）。 */
  assert.ok(/\.color-chip:focus-visible/.test(css), '色块需可见焦点样式');
  /* 锁的是：网格容器样式（没它色块会挤成一行，12 个排不下）。 */
  assert.ok(/\.color-history/.test(css), '需 .color-history 容器样式');
});

done();
