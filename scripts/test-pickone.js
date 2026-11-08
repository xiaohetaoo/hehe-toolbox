'use strict';
/* js/tools/launch.js 的 pickOne 契约测试（源码级）。
 *
 * ============ 锁的是哪个回归 ============
 * pickOne 的按钮回调曾经写成 `md.close(); resolve(val);`。
 * md.close() 会触发 modal 的 onClose → resolve(null)。Promise 只锁定
 * **第一次** resolve —— null 先到，val 永远无效。
 * 后果：「命令收藏」「快捷启动栏」的添加流程在选择执行环境/类型后
 * 100% 静默失败（真机复现：三步弹窗全部走完，无 toast、无列表刷新、
 * store 里 commands 仍为 []）。修复：先 resolve(val) 再 md.close()。
 * 本文件锁两个不变量：
 *   1) 按钮回调里 resolve(val) 必须在 md.close() 之前；
 *   2) onClose 的 resolve(null) 与按钮的 resolve(val) 不能颠倒。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

const SRC = readSrc('js/tools/launch.js');

t('pickOne 按钮回调：resolve(val) 必须先于 md.close()（锁的是"选择后静默失败"回归）', () => {
  /* 定位 pickOne 函数体：从 function pickOne 到下一个顶级 function/register */
  const start = SRC.indexOf('function pickOne');
  assert.ok(start >= 0, '找不到 pickOne 定义');
  const end = SRC.indexOf('register(', start);
  const body = SRC.slice(start, end > 0 ? end : start + 2000);

  const resolveIdx = body.indexOf('resolve(val)');
  const closeIdx = body.indexOf('md.close()');
  assert.ok(resolveIdx > 0, '按钮回调里没有 resolve(val)');
  assert.ok(closeIdx > resolveIdx,
    'pickOne 的按钮回调里 md.close() 在 resolve(val) 之前 —— close 触发 onClose 的 ' +
    'resolve(null) 会先锁住 Promise，pickOne 永远返回 null，添加流程 100% 静默失败');

  /* 锁的是：取消路径。onClose 必须 resolve(null)，否则用户点 × / 遮罩时
   * Promise 永远悬着、add() 卡死在 await；悬着的 Promise 在行为测试里只表现
   * 为「用例超时」，无法区分是谁的错，所以源码级锁死。 */
  assert.ok(/onClose:\s*\(\)\s*=>\s*resolve\(null\)/.test(body),
    'pickOne 缺少 onClose: () => resolve(null)（取消时 Promise 永远悬着）');
});

/* 锁的是：取消路径的调用方兜底。修复回归时只改 pickOne 内部顺序，两个 add() 的
 * if (!x) return 兜底同样关键 —— 用户关掉弹窗时流程必须静默退出；
 * 源码断言是因为「取消」要走 UIA 三步弹窗才能触发，行为测试在本机环境无法稳定执行。 */
t('快捷启动 add() 与命令收藏 add() 都在 pickOne 之后判空返回（取消时静默退出）', () => {
  assert.ok(/const type = await pickOne\('添加快捷项[^']*'[\s\S]{0,200}?if\s*\(!type\)\s*return;/.test(SRC),
    '快捷启动 add() 在 pickOne 之后没有判空返回');
  /* 锁的是：命令收藏的取消兜底（同上：取消走不到行为断言，源码锁死）。 */
  assert.ok(/const shell = await pickOne\('选择执行环境'[\s\S]{0,120}?if\s*\(!shell\)\s*return;/.test(SRC),
    '命令收藏 add() 在 pickOne 之后没有判空返回');
});

done();
