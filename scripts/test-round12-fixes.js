'use strict';
/* 第十二轮审查修复的回归测试。
 *
 * 每条锁的是：
 *   R1 http-client 连点「发送」会并发两个请求，后完成的覆盖先完成的 ——
 *      请求与响应对不上（ui.guard 是项目对这类问题的统一收口）。
 *   R2 office.js 的 4 个 PDF 长任务 + 图片转 PDF + 文档预览 + 翻译
 *      同样没有防重入（同文件里 pdf2img / pdf-office-convert 有 running 标志，
 *      说明是漏写不是设计）。渲染层没有真 Electron 无法跑行为断言，
 *      且这里锁的是「按钮是否接上 guard」这一接线事实 —— 源码断言。
 *   R3 cqFor 对无效 crf 的回退值必须等于界面默认 crf23（23+7=30）：
 *      早期写成 CQ_MIN+CQ_OFFSET（=25），等于把「没填」当成 crf18，
 *      实测 cq25 体积比 cq30 大 40% 左右。行为断言（纯函数）。
 *   R4 局域网设备列表必须始终包含本机：防火墙拦 ICMP 时本机 ping 不通自己，
 *      ARP 也可能没命中 → 列表里没有本机行，用户无法分辨哪个是自己。
 *      行为断言（纯函数）。
 *   R5 渲染层要给 source:'self' 一个「本机」标签，否则界面显示英文裸值。
 */

const assert = require('assert');
const { readSrc } = require('./lib/harness');
const hw = require('../lib/hw-encode');
const ls = require('../lib/lan-scan');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
};

t('R1 HTTP 客户端的 send 接上了 ui.guard', () => {
  /* 锁的是：R12-1 send 无防重入（连点并发请求，响应乱序覆盖）。
   * 只能源码断言：并发覆盖需要真网络竞态才能观察，CI 里跑不了。 */
  const dev = readSrc('js/tools/dev.js');
  /* 锁的是：接上 guard 后旧的裸 async function send 必须消失。 */
  assert.ok(/const send = window\.ui\.guard\(async/.test(dev), 'send 未接 ui.guard');
  /* 锁的是：同上，防止有人把 guard 拆掉又改回函数声明。 */
  assert.ok(!/async function send\(\)/.test(dev), 'send 仍是裸 async function');
});

t('R2 office.js 七处长任务全部接上防重入', () => {
  /* 锁的是：R12-2 七个长任务按钮无防重入（连点并发跑两份 pdf-lib / 两次
   * LibreOffice / 翻译乱序）。同文件另两处早有 running 标志，是漏写不是设计；
   * 接线事实只能源码断言 —— 下面循环里每一条 assert 都属于这一组回归。 */
  const office = readSrc('js/tools/office.js');
  /* 锁的是：同上（循环内逐个按钮核对接线）。 */
  for (const [name, re] of [
    ['mergeBtn', /const mergeBtn = btn\('合并为一个 PDF', 'btn-primary', guard\(async/],
    ['extractBtn', /const extractBtn = btn\('提取页面', 'btn-secondary', guard\(async/],
    ['splitBtn', /const splitBtn = btn\('拆分 PDF', 'btn-secondary', guard\(async/],
    ['rotBtn', /const rotBtn = btn\('旋转全部页面', 'btn-secondary', guard\(async/],
    ['img2pdf', /const btn2 = btn\('转换为 PDF', 'btn-primary', window\.ui\.guard\(async/],
    ['doc-preview', /const preview = window\.ui\.guard\(previewRun\)/],
    ['translate', /const go = window\.ui\.guard\(goRun\)/],
  ]) {
    /* 锁的是：同上，单条按钮的接线断言。 */
    assert.ok(re.test(office), name + ' 未接防重入');
  }
});

t('R3 cqFor 无效 crf 回退到界面默认（crf23 → cq30）', () => {
  assert.strictEqual(hw.cqFor(NaN), 30);
  assert.strictEqual(hw.cqFor(undefined), 30);
  assert.strictEqual(hw.cqFor('abc'), 30);
  assert.strictEqual(hw.cqFor(23), 30);
  /* clamp 行为不回退 */
  assert.strictEqual(hw.cqFor(0), 18);
  assert.strictEqual(hw.cqFor(51), 40);
  assert.strictEqual(hw.cqFor(14), 21);
});

t('R4 局域网扫描始终列出本机', () => {
  const r = ls.mergeDevices({
    arp: [{ ip: '192.168.1.1', mac: 'aa:bb', type: 'dynamic' }],
    pinged: ['192.168.1.1'],
    selfIp: '192.168.1.100',
    names: {},
  });
  assert.strictEqual(r[0].isSelf, true, '本机必须排最前');
  assert.strictEqual(r[0].source, 'self');
  /* 本机已在 ARP 命中时不得重复出现 */
  const r2 = ls.mergeDevices({
    arp: [{ ip: '192.168.1.100', mac: 'my-mac', type: 'dynamic' }],
    pinged: [],
    selfIp: '192.168.1.100',
    names: {},
  });
  assert.strictEqual(r2.length, 1);
  assert.strictEqual(r2[0].isSelf, true);
});

t('R5 渲染层为 self 来源提供「本机」标签', () => {
  /* 锁的是：R12-4 配套——后端补了 self 来源，前端必须有中文标签，
   * 否则表格里显示英文裸值 "self"。 */
  const lan = readSrc('js/tools/lan-scan.js');
  assert.ok(lan.includes("'self': '本机'"), '渲染层未映射 self 标签');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);