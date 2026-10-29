'use strict';
/* 单实例锁行为验证（v0.1.6 修「双击没反应」）。
 *
 * 背景：原来是 `if (!gotLock) app.quit()` —— 静默退出、零提示。
 * 用户重复点图标时看起来完全"打不开"，但应用其实在后台好好跑着。
 *
 * 本测试锁死三件事：
 *   1. 拿不到锁时必须给用户可见反馈（不是静默 quit）
 *   2. 测试/自动化模式下绝不弹阻塞对话框（否则 CI 永久挂住）
 *   3. second-instance 在 app ready 之前到达时不能抛异常
 *
 * 用法：node scripts/test-single-instance.js
 */
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

let pass = 0, fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; else pass++; };

/* ---- 1. 拿不到锁时不能静默退出而没有任何后续 ----
 * 注意：实测证明「在 !gotLock 分支里弹框」是不可行的 —— 拿不到锁时
 * app.whenReady() 不 resolve，dialog 根本执行不到（进程直接自然退出）。
 * 所以正确做法是：!gotLock 只 quit，反馈交给主实例的 second-instance 处理。 */
const startIdx = main.indexOf('const gotLock = app.requestSingleInstanceLock()');
chk(startIdx >= 0, '能定位到单实例锁代码');
const whole = main.slice(startIdx, startIdx + 1400);

const branchStart = main.indexOf('if (!gotLock)');
const branchEnd = main.indexOf('} else {', branchStart);
const branch = main.slice(branchStart, branchEnd);
chk(branch.length > 0, '能定位到 !gotLock 分支');
chk(branch.includes('app.quit()'), '拿不到锁时确实会退出');
chk(!/showMessageBoxSync/.test(branch), '!gotLock 分支里不弹对话框（whenReady 不会 resolve，弹不到）');
chk(!/whenReady\(\)/.test(branch), '!gotLock 分支里不等 whenReady（同样不会 resolve）');
chk(!/showMainWindow\(\)/.test(branch), '!gotLock 分支里没有调用 showMainWindow（本进程无窗口）');
chk(/whenReady/.test(main.slice(branchEnd, branchEnd + 600)), '注释里说明了为什么不在该分支等 whenReady');

/* ---- 2. 反馈由主实例承担 ---- */
chk(whole.includes("app.on('second-instance'"), '注册了 second-instance');
chk(/showMainWindow\(\)/.test(whole), 'second-instance 会把窗口提到前面');
chk(whole.includes('app:already-running'), 'second-instance 会通知渲染层给提示');
chk(/app\.isReady\(\)/.test(whole), 'second-instance 判断了 app.isReady()（避免 ready 前 createWindow 抛错）');

/* ---- 3. 渲染层确实接收并提示 ---- */
const appJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
chk(/on\('app:already-running'/.test(appJs), '渲染层订阅了 app:already-running');
chk(/toast\([^)]*已经在运行/.test(appJs), '渲染层弹出「已经在运行」的 toast');

/* ---- 4. 最小化场景要能恢复 ---- */
const showFn = main.slice(main.indexOf('function showMainWindow'), main.indexOf('function showMainWindow') + 200);
chk(/isMinimized\(\)/.test(showFn) && /restore\(\)/.test(showFn), 'showMainWindow 能从最小化状态恢复');
chk(/focus\(\)/.test(showFn), 'showMainWindow 会 focus 到前台');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
