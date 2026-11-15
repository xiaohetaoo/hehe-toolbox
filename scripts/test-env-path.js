'use strict';
/* 用户 PATH 操作的纯函数测试（lib/env-path.js）。
 *
 * 这组函数负责"加入/移除用户环境"里唯一会写全机共享配置的部分：
 * 前置顺序、去重、只删自己加的项。写错一次就会遮住用户的系统 Python/Java，
 * 或者删掉别人加的工具路径 —— 所以逐条用样本钉住。
 */
const { t, done } = require('./lib/harness');
const assert = require('assert');
const ep = require('../lib/env-path');

t('EP1 拆分 PATH：容忍尾随分号、空白与空项', () => {
  /* 锁的是：把空项当成一项 —— 拼回去会多出 `;;`，部分老程序按空项解析成当前目录。 */
  assert.deepStrictEqual(ep.splitPath('C:\\a;;D:\\b; '), ['C:\\a', 'D:\\b']);
  assert.deepStrictEqual(ep.splitPath(''), []);
  assert.deepStrictEqual(ep.splitPath(null), []);
});

t('EP2 前置：只加新项、原顺序与重复项都保留、大小写去重', () => {
  const cur = 'C:\\Windows;C:\\tools;c:\\tools';
  const r = ep.prependEntries(cur, ['D:\\envs\\node', 'c:\\windows']);
  /* 锁的是：把用户已有项重排/去掉 —— 系统目录或重复项被改动，
   * 撤销时也恢复不回来（v0.8.8 真机踩过：应用后 PATH 反而变短）。 */
  assert.strictEqual(r.value, 'D:\\envs\\node;C:\\Windows;C:\\tools;c:\\tools');
  assert.deepStrictEqual(r.added, ['D:\\envs\\node']);
  /* 锁的是：重复调用会不断累加 —— 每次点「加入环境」PATH 长一截。 */
  const again = ep.prependEntries(r.value, ['D:\\envs\\node']);
  assert.strictEqual(again.value, r.value);
  assert.deepStrictEqual(again.added, []);
});

t('EP3 移除：只摘整项匹配，不碰别人的路径', () => {
  const cur = 'D:\\envs\\node;C:\\Windows;D:\\envs\\node\\Scripts;C:\\tools';
  const r = ep.removeEntries(cur, ['d:\\envs\\node', 'D:\\envs\\node\\']);
  /* 锁的是：按前缀模糊删 —— `D:\envs\node\Scripts` 会被连带删掉（工具链目录可能相似）。
   * 两个入参归一后是同一项，所以只应删掉 1 条。 */
  assert.strictEqual(r.value, 'C:\\Windows;D:\\envs\\node\\Scripts;C:\\tools');
  assert.strictEqual(r.removed.length, 1);
  /* 锁的是：尾分号被吃掉 —— 撤销后 PATH 与原始值不是逐字一致（真机 E2E 抓到）。 */
  assert.strictEqual(ep.removeEntries('D:\\envs\\node;C:\\Windows;', ['D:\\envs\\node']).value,
    'C:\\Windows;');
});

t('EP4 hasEntry：大小写与尾分隔符都视为同一项', () => {
  /* 锁的是：`C:\Tools\` 与 `c:\tools` 判成两项 —— 会重复添加或删不干净。 */
  assert.strictEqual(ep.hasEntry('C:\\Windows;c:\\Tools\\', 'C:\\tools'), true);
  assert.strictEqual(ep.hasEntry('C:\\Windows', 'C:\\tools'), false);
});

t('EP5 长度预警：超过阈值要能被发现（不是静默接受）', () => {
  /* 锁的是：超长 PATH 仍然放行且不提示 —— 新终端里部分程序读不到后半段。 */
  assert.strictEqual(ep.pathTooLong('a;'.repeat(1200)), true);
  assert.strictEqual(ep.pathTooLong('C:\\a;C:\\b'), false);
  /* 阈值可注入，便于测试不依赖魔法数字 */
  assert.strictEqual(ep.pathTooLong('12345', 4), true);
});

done();