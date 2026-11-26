'use strict';
/* R22：本轮新增回归的源码契约。行为测试优先，这里锁的是「旧数据/坏数据
 * 不能把整页渲染打断」这类在纯 Node 下没有 DOM 可跑的边界。 */

const { t, done, assert, readSrc } = require('./lib/harness');

function src(rel) {
  /* readSrc 会自动剥块注释，并受 SA-3 的裸 readFileSync 基线约束。 */
  return readSrc(rel);
}

t('S1 快捷启动：null/缺 target 的旧项不能中断整页', () => {
  const s = src('js/tools/launch.js');
  /* 锁的是：quicklaunch 里若有 null 项或旧版没有 target 字段的项，
   * `it.target.length` 会在渲染第一张卡时抛，后面所有快捷项都不显示。
   * 必须先把非对象项过滤掉，再把 target 兜成空串——R23 把跳过改成
   * 先 filter 再判空状态，语义不变。 */
  assert.ok(/\.filter\(\(it\) => it && typeof it === 'object'\)/.test(s),
    '没有过滤 null/非对象快捷项');
  assert.ok(/String\(it\.target == null \? '' : it\.target\)/.test(s),
    'target 没有兜底成字符串');
});

t('S2 快捷启动卡片：长 URL/长名称不能横向溢出卡片', () => {
  const css = src('css/app.css');
  /* 锁的是：快捷启动卡片在 160px 窄格里显示 40 字符的 URL，URL 没有空格，
   * 默认不会换行，会顶出卡片、压到相邻卡片。name/target 都必须能任意断行。 */
  const name = /\.tool-card \.tc-name\s*\{[^}]*overflow-wrap:\s*anywhere/s.test(css);
  const desc = /\.tool-card \.tc-desc\s*\{[^}]*overflow-wrap:\s*anywhere/s.test(css);
  assert.ok(name, '.tc-name 缺少 overflow-wrap:anywhere');
  assert.ok(desc, '.tc-desc 缺少 overflow-wrap:anywhere');
});

done();
