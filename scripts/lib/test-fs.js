'use strict';
/* 测试公用的临时目录清理。
 *
 * ============ 为什么要抽出来 ============
 * 实测 `function rmDir(...)` 在 7 个测试文件里各有一份，其中 5 份逐字相同、
 * 2 份是「用 maxRetries 重试」的变体。它们干的是同一件事：删 %TEMP% 里刚建的
 * 测试目录。Windows 上这个动作会**偶然失败**（杀软/索引服务正巧打开着里面
 * 的文件，rmSync 报 EBUSY/EPERM），所以每份实现都得带兜底。
 *
 * 七份各自维护的后果不是「代码重复」这种审美问题，而是**兜底强度不一致**：
 * 用 maxRetries 的那两份能扛住的偶发占用，另外五份扛不住 —— 于是同一台机器上
 * 有的测试偶发失败、有的不会，排查时完全看不出规律。
 *
 * ============ 这三级兜底各自挡什么 ============
 *   1. rmSync + maxRetries：让 Node 自己在内核返回 EBUSY/EPERM 时重试
 *      （maxRetries 只对这类可重试错误生效，比手写循环准确）。
 *   2. cmd.exe rmdir /s /q：Node 的 rmSync 在 Windows 上对「目录被设为只读」、
 *      「路径过长」这两种情况会直接失败，而系统自带的 rmdir 能处理。
 *   3. 彻底放弃：测试收尾失败**不该让用例变红** —— 它清理的是 %TEMP% 里的
 *      东西，操作系统迟早会回收。真失败了就留个目录，不能因此判测试失败。
 *      这条是刻意的：清理属于 best-effort，把它当断言会让无关的环境问题
 *      变成假红。
 */
const fs = require('fs');
const cp = require('child_process');

/**
 * 删除一个临时目录（best-effort，永不抛出）。
 * @param {string} p 要删的路径
 */
function rmDir(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return;
  } catch (e) {
    /* 落到第二级 */
  }
  try {
    cp.execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', String(p)], { windowsHide: true });
  } catch (e2) {
    /* 第三级：放弃。见文件头的说明 —— 清理失败不该让用例变红。 */
  }
}

module.exports = { rmDir };
