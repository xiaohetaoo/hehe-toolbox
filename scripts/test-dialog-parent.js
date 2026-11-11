'use strict';
/* 锁的是：对话框父窗口归属（R1）。
 *
 * 历史回归：dialog:open / dialog:save 把父窗口写死为主窗 `win`。
 * 独立工具窗口里点「选择文件 / 保存文件」时，对话框挂在主窗上 ——
 * 不居中于发起它的窗口、不是它的模态子窗口，用户还能继续点独立窗，
 * 容易连点出好几个对话框。窗口控制（win:minimize/maximize/close）此前
 * 已经用 senderWindow() 修过同类问题，dialog 漏了。
 *
 * 为什么不能用行为断言：showOpenDialog 的父窗口归属要真的弹出对话框才能
 * 观察，自动化测试里无法弹出原生对话框（会阻塞 CI）；jsdom 没有 Electron。
 * 所以用源码断言锁两个事实：
 *   1) 两条 dialog handler 的第一个实参是 senderWindow()（按发起者路由）；
 *   2) 不再有写死 `showOpenDialog(win` / `showSaveDialog(win` 的调用。
 * 断言锚定完整调用行，而非模糊匹配 —— 上面三行内写明锁的是哪个回归。 */
const { readSrc } = require('./lib/harness');
const assert = require('assert');

const src = readSrc('main.js');

let pass = 0, fail = 0;
function chk(cond, name) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

/* 锁的是：dialog:open 的父窗口必须按发起窗口路由；写死 win 时独立窗口的
 * 对话框全部挂到主窗（R1 的直接现场）。 */
chk(/handle\(CH\.DIALOG\.OPEN, async \(e, opts = \{\}\) => \{\s*\n\s*const r = await dialog\.showOpenDialog\(senderWindow\(\), \{/.test(src),
  'dialog:open 父窗口是 senderWindow()');
/* 锁的是：dialog:save 同上；保存对话框在独立窗口场景下同样必须归属发起者。 */
chk(/handle\(CH\.DIALOG\.SAVE, async \(e, opts = \{\}\) => \{\s*\n\s*const r = await dialog\.showSaveDialog\(senderWindow\(\), \{/.test(src),
  'dialog:save 父窗口是 senderWindow()');
/* 锁的是：写死主窗的旧写法必须整体消失 —— 只要还有一处残留，那个场景就
 * 仍是「对话框挂在主窗」。全项目 39 个调用点都经这两条通道，这里是最上游。 */
chk(!/showOpenDialog\(win[,)]/.test(src), 'main.js 不再有 showOpenDialog(win,…)');
chk(!/showSaveDialog\(win[,)]/.test(src), 'main.js 不再有 showSaveDialog(win,…)');
/* 锁的是：senderWindow 定义必须先于 dialog handler（main.js 顺序敏感，
 * 函数声明虽会提升，但这行保证提取/搬运时不会把定义搬到使用之后成 TDZ ——
 * senderWindow 是 function 声明没问题，真正要防的是将来有人把它改成
 * const 箭头函数）。 */
const defPos = src.indexOf('function senderWindow');
const dlgPos = src.indexOf('handle(CH.DIALOG.OPEN');
assert.ok(defPos >= 0 && dlgPos >= 0, 'senderWindow 与 dialog handler 都存在');
chk(defPos < dlgPos, 'senderWindow 定义在 dialog handler 之前');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
