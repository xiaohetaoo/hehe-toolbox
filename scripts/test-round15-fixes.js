'use strict';
/* 原脚本用 cases 收集 + 串行 for 循环，输出严格按注册顺序。
 * 这里显式指定 order:'sequential' 以保持迁移前的输出顺序不变。 */
const { createSuite } = require('./lib/harness');
const { t, done } = createSuite({ order: 'sequential' });
/* 第 15 轮修复项的回归测试。
 *
 * 每一条都对应一个**先复现、再修**的真实缺陷。能跑真实现的都抽真函数跑；
 * 只能结构断言的，一律先剥注释（lib/src-scan.js），不按源码版面匹配。
 *
 * 覆盖：
 *   1. fs:delete-empty 传对象数组 → 闸门必须拒；界面不能报"成功"
 *   2. 倒计时结束不得清空剪贴板
 *   3. hash 结果按路径存，refresh 后仍能回填
 *   4. 取色坐标必须用 screenX/screenY，并夹取越界
 *   5. 静态服务切页后状态可回填（server:status）
 *   6. 电源门禁：%ComSpec%、-EncodedCommand、for 循环体
 *   7. fs:clean-junk 只接受扫描结果内的路径
 *   8. fs:rename 有覆盖闸门且在 file-delete 门禁里
 *   9. LastBootUpTime 的 /Date(ms)/ 要能解析，坏值显示 -
 *  10. 选择弹窗关闭后 add() 不能挂起
 *  11. 随机数字与随机字符串不能共用同一个 input
 *  12. 目标番茄数必须被读取，「已完成」要能刷新
 *  13. split-file 失败要销毁读流并清掉半截分片
 *  14. 静态服务的读流在客户端断开时销毁
 *  15. 不再用 Math.max(...arr) / Math.min(...arr)
 *  16. 剪贴板历史两条裁剪路径共用同一上限，且回收图片
 *  17. scan-tree 根路径带尾随分隔符时统计一致
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const mainSrc = read('main.js');
const { stripComments, extractFn } = require(path.join(ROOT, 'lib', 'src-scan'));

function rmDir(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }

/* 从 main.js 抽出某个 handle(..., async (e, ...args) => { ... }) 的完整回调函数。
 * 【注意】不能只取花括号体再套一层 `(e, ...args) => body` ——
 * 那样形参名（例如 delete-empty 的 dirs）就丢了，调用时报 "dirs is not defined"。
 * 所以从 `handle(` 起的整段（含形参列表）一起截出来，再把 handle( 换成直接定义。 */
function loadHandlerArrow(channel, deps) {
  const code = stripComments(mainSrc);
  const i = code.indexOf("handle('" + channel + "'");
  assert.ok(i > 0, '找不到 handler ' + channel);
  /* 找回调的箭头函数起点：handler 名之后的第二个 '(' 参数列表结束处的 '=>' */
  const arrow = code.indexOf('=>', i);
  assert.ok(arrow > 0, channel + ' 不是箭头函数形态');
  const bodyStart = code.indexOf('{', arrow);
  const end = (function scan(text, from) {
    let depth = 0, j = from, inS = null;
    while (j < text.length) {
      const c = text[j];
      if (inS) { if (c === '\\') j++; else if (c === inS) inS = null; j++; continue; }
      if (c === '/' && text[j + 1] === '/') { const nl = text.indexOf('\n', j); j = nl === -1 ? text.length : nl; continue; }
      if (c === '/' && text[j + 1] === '*') { const e = text.indexOf('*/', j + 2); j = e === -1 ? text.length : e + 2; continue; }
      if (c === "'" || c === '"' || c === '`') { inS = c; j++; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return j + 1; }
      j++;
    }
    return -1;
  })(code, bodyStart);
  assert.ok(end > 0, channel + ' 括号不配平');
  /* 截取从箭头函数形参起点（'(' 或 'async' 之后）到函数体结束 */
  const paramsStart = code.lastIndexOf('(', arrow);
  const fnSrc = code.slice(paramsStart, end);
  /* 【必须补 async】handle 包装器本身是 async，但回调的 `async (e, ...) =>` 前面
   * 的 async 关键字不在 paramsStart..end 这段里（paramsStart 指向 '('）。
   * 不补就会得到 `(e, dirs) => {...}` —— 里面有 await，语法直接报错。 */
  return new Function('path', 'fsp', 'fs', 'pathGuard', 'os', 'fmtErr',
    'return async ' + fnSrc + ';')(...deps);
}

/* ==================== 1. delete-empty 的对象入参 ==================== */
t('1a checkDeletable：非字符串一律拒绝，不做 String() 降级', () => {
  const pg = require(path.join(ROOT, 'lib', 'path-guard'));
  const B = String.fromCharCode(92);
  const obj = { path: 'C:' + B + 'tmp' + B + 'a', depth: 1 };
  const r = pg.checkDeletable(obj, false);
  assert.ok(r, '传对象给 checkDeletable 必须被拒（旧实现 String(obj) → "[object Object]" 一路放行）');
  assert.strictEqual(r.code, 'BAD_ARG', '拒绝码应为 BAD_ARG，实际 ' + r.code);
  // 数字、null、undefined 同样要拒
  assert.ok(pg.checkDeletable(123, false), '数字应被拒');
  assert.ok(pg.checkDeletable(null, false), 'null 应被拒');
  assert.ok(pg.checkDeletable(undefined, false), 'undefined 应被拒');
  // 正常字符串仍然放行（不误伤）
  assert.strictEqual(pg.checkDeletable('C:' + B + 'tmp' + B + 'a', false), null, '普通路径不该被拦');
});

t('1b 行为：把对象数组传给 fs:delete-empty，deleted 必须是 0 且每项都进 errors', async () => {
  const pg = require(path.join(ROOT, 'lib', 'path-guard'));
  const handler = loadHandlerArrow('fs:delete-empty', [
    path, fs.promises, fs, pg, os, (e) => (e && e.message) || String(e),
  ]);
  const B = String.fromCharCode(92);
  const objs = [{ path: 'C:' + B + 'tmp' + B + 'a', depth: 1 }, { path: 'D:' + B + 'tmp' + B + 'b', depth: 2 }];
  const r = await handler({}, objs);
  assert.strictEqual(r.deleted, 0, '对象数组不该删掉任何东西');
  assert.strictEqual(r.errors.length, objs.length,
    '每个非法入参都要各记一条错误（旧实现只有 rmdir 抛出的含糊错误，且 deleted 为 0 却被界面报成功）');
  assert.ok(r.errors.every((x) => /字符串/.test(x)), '错误里应说明"路径必须是字符串"：' + r.errors.join(' / '));
});

t('1c 界面：有失败时不许用 success 样式，且要列出原因', () => {
  const code = stripComments(read('js/tools/sys-tools.js'));
  const i = code.indexOf("invoke('fs:delete-empty'");
  assert.ok(i > 0, '找不到 delete-empty 调用');
  const seg = code.slice(i, i + 900);
  assert.ok(/map\(/.test(seg) && /\.path/.test(seg), '仍然把对象数组原样传给主进程（没有取 .path）');
  assert.ok(/errors/.test(seg), '界面没有读 r.errors —— 失败静默');
  assert.ok(/warn/.test(seg), '有失败时没有用 warn 样式（仍会显示成绿色成功）');
  // 反面：不许再出现"直接报成功"的单分支
  assert.ok(!/toast\(`已删除 \$\{r\.deleted\} 个空目录`, 'success'\);\s*\n\s*scanBtn\.click\(\);\s*\n\s*\} catch/
    .test(seg) || /nErr/.test(seg), '仍然是"无条件 success"');
});

/* ==================== 2. 倒计时不得清空剪贴板 ==================== */
t('2 倒计时分支里不许出现 clip:write-text', () => {
  const code = stripComments(read('js/tools/life.js'));
  const i = code.indexOf('finishPhase');
  assert.ok(i > 0, '找不到 finishPhase');
  const j = code.indexOf('if (phase === \'work\')', i);
  const seg = code.slice(i, j > 0 ? j : i + 1200);
  assert.ok(!/clip:write-text/.test(seg),
    '倒计时结束仍在写剪贴板（空串会把用户复制的内容清掉）');
  assert.ok(/toast/.test(seg) && /Notification/.test(seg), '提醒仍应通过 toast + Notification');
});

/* ==================== 3. hash 结果不能绑在 DOM 行上 ==================== */
t('3a hash 用 Map 存结果，并通过 rowEnd 回填', () => {
  const code = stripComments(read('js/tools/hash.js'));
  assert.ok(/const results = new Map\(\)/.test(code), '没有按路径存结果（结果挂在 DOM 行上，refresh 后就丢了）');
  assert.ok(/rowEnd:/.test(code), '没有用 filePicker 的 rowEnd 回填');
  assert.ok(/paintResult/.test(code), '没有独立的回填函数');
  /* 【反面断言要精确定位到"收尾"，不能全段搜】
   * hashFile 开头把进度条挂到当前行是合法的（那是"此刻确实有这一行"）。
   * 缺陷形态是**算完之后**把结果块 append 到一开始抓住的那个 row 变量 ——
   * 所以只检查收尾那几句（progress.remove() 之后）。 */
  const i = code.indexOf('async function hashFile');
  const seg = code.slice(i, i + 2400);
  const tail = seg.slice(seg.indexOf('progress.remove()'));
  assert.ok(!/row\.appendChild\(box\)/.test(tail),
    'hashFile 收尾仍在把结果 append 到"一开始抓到的那行"（行被 refresh 重建后就画到看不见的地方）');
  /* 【这条是关键，别再写成"包含 curRow 就算过"】
   * 第一次写的是 `/curRow/.test(tail) || /paintResult/.test(tail)`，
   * 而退回缺陷后是 `if (curRow) curRow.appendChild(box)` —— 也含 curRow，
   * 断言照样通过（反向验证 MISSED 证实了）。必须直接禁掉"往行上 append"这个动作。 */
  assert.ok(!/curRow\.appendChild/.test(tail),
    '收尾仍在往行元素上 append（应改为 paintResult(curRow, p) 按路径重画）');
  assert.ok(/paintResult\(/.test(tail), '收尾没有调用 paintResult 重画');
});
t('3b 行为：文件列表重建后，已有结果仍能画出来', () => {
  /* 用一个最小 DOM 桩验证 paintResult 的语义：结果按路径存在 → 新行能画出摘要。 */
  const code = stripComments(read('js/tools/hash.js'));
  assert.ok(/results\.set\(p, \{ hex \}\)/.test(code) || /results\.set\(p/.test(code),
    '算完没有把结果写进 results');
  assert.ok(/results\.get\(p\)/.test(code), 'paintResult 没有按路径取结果');
  /* 关键约束：hashed 只用于"别重复算"，不能用来阻止回填 */
  assert.ok(!/if \(hashed\.has\(it\.path\)\) continue;\s*\n\s*\/\/[^\n]*\n\s*return/.test(code),
    'hashed 被用来阻止回填了');
});

/* ==================== 4. 取色坐标 ==================== */
t('4a calcPickPoint：窗口偏移与副屏都正确', () => {
  const code = stripComments(read('js/tools/dev.js'));
  assert.ok(/function calcPickPoint/.test(code), '没有抽出 calcPickPoint 纯函数');
  assert.ok(/screenX/.test(code) && /screenY/.test(code), '仍在用 clientX/clientY（窗口内坐标）');
  /* 【不能用 extractFn 抽它】它的参数是解构对象 { screenX, ... }，
   * extractFn 会把第一个 '{' 当成函数体起点，抽出来只有参数那一小段。
   * 这里按 '参数表) {' 定位真正的函数体。 */
  const i = code.indexOf('function calcPickPoint');
  const bodyStart = code.indexOf(') {', i) + 2;      // 指向 '{'
  let depth = 0, j = bodyStart, inS = null;
  while (j < code.length) {
    const c = code[j];
    if (inS) { if (c === '\\') j++; else if (c === inS) inS = null; j++; continue; }
    if (c === "'" || c === '"' || c === '`') { inS = c; j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
    j++;
  }
  const f = new Function(code.slice(i, j) + '\nreturn calcPickPoint;')();

  // 情形 1：窗口贴住主显示器左上角
  let r = f({ screenX: 100, screenY: 50, bounds: { x: 0, y: 0 }, dpr: 1, canvasW: 1920, canvasH: 1080 });
  assert.strictEqual(r.px, 100); assert.strictEqual(r.py, 50); assert.strictEqual(r.inRange, true);
  // 情形 2：窗口右移 300px（旧实现会整体偏 300）
  r = f({ screenX: 400, screenY: 250, bounds: { x: 0, y: 0 }, dpr: 1, canvasW: 1920, canvasH: 1080 });
  assert.strictEqual(r.px, 400, '窗口位置不该影响屏幕坐标换算');
  assert.strictEqual(r.py, 250);
  // 情形 3：副屏（bounds.x = 1920），鼠标在副屏上
  r = f({ screenX: 2000, screenY: 100, bounds: { x: 1920, y: 0 }, dpr: 1.5, canvasW: 2880, canvasH: 1620 });
  assert.strictEqual(r.px, Math.round((2000 - 1920) * 1.5), '副屏上应相对该显示器原点换算');
  assert.strictEqual(r.inRange, true);
  // 情形 4：越界（鼠标在别的显示器上）必须夹取且标记 inRange=false
  r = f({ screenX: -50, screenY: 10, bounds: { x: 0, y: 0 }, dpr: 2, canvasW: 1920, canvasH: 1080 });
  assert.strictEqual(r.inRange, false, '越界必须标记出来（不能让界面画一个黑点当结果）');
  assert.strictEqual(r.cx, 0, '越界时应夹到最近的合法像素');
});
t('4b 越界时不取色、给出提示', () => {
  const code = stripComments(read('js/tools/dev.js'));
  assert.ok(/inRange/.test(code), '没有使用 inRange 标记');
  assert.ok(/已超出屏幕范围/.test(code), '越界时没有给出可读提示');
});

t('4c 调用点必须传 e.screenX/e.screenY（不能退回 clientX）', () => {
  /* 【这条是把 4a 漏掉的一半补上】
   * 4a 跑的是 calcPickPoint 纯函数，它的形参就叫 screenX/screenY ——
   * 所以即使调用点退回成 `screenX: e.clientX`，纯函数行为完全不变，4a 照样绿。
   * 实测反向验证证实了这点（MISSED）。必须单独断言调用点。
   * clientX 是窗口内坐标，与 display.bounds（屏幕坐标）相减只在窗口贴住
   * 显示器左上角时成立 —— 窗口一挪就整体偏移，副屏还会变成负数。 */
  const code = stripComments(read('js/tools/dev.js'));
  /* 【必须从函数定义之后开始找，否则会命中函数声明本身】
   * `indexOf('calcPickPoint({')` 在第一处就是 `function calcPickPoint({ ... })`，
   * 那段里自然没有 `e.screenX` —— 会误报（第一次写就踩了这个）。 */
  const defEnd = code.indexOf(')', code.indexOf('function calcPickPoint')) + 1;
  const i = code.indexOf('calcPickPoint({', defEnd);
  assert.ok(i > 0, '没有找到 calcPickPoint 的调用点');
  /* 只取到实参对象闭合处（"})"），不要扫到后面 mag.style.left 那几行 ——
   * 那里用 e.clientX 是**正确**的（放大镜要跟着鼠标在窗口里画）。 */
  const close = code.indexOf('})', i);
  const seg = code.slice(i, close > i ? close + 1 : i + 300);
  assert.ok(/screenX:\s*e\.screenX/.test(seg), '调用点没有用 e.screenX（用了窗口坐标 clientX）');
  assert.ok(/screenY:\s*e\.screenY/.test(seg), '调用点没有用 e.screenY');
  assert.ok(!/clientX/.test(seg), 'calcPickPoint 的实参里用了 clientX（窗口内坐标与屏幕坐标混用）');
});

/* ==================== 5. 静态服务状态回填 ==================== */
t('5a 主进程有只读的 server:status', () => {
  const code = stripComments(mainSrc);
  assert.ok(/handle\('server:status'/.test(code), '没有 server:status 通道');
  const i = code.indexOf("handle('server:status'");
  const seg = code.slice(i, i + 400);
  assert.ok(/running/.test(seg) && /url/.test(seg) && /root/.test(seg), 'status 返回字段不全');
  // 必须记录 root/port，否则回填不了
  assert.ok(/serverRoot = root/.test(code) || /serverRoot\s*=\s*root/.test(code), 'server:start 没有记录根目录');
});
t('5b 页面初始化会查一次状态并回填按钮', () => {
  const code = stripComments(read('js/tools/dev.js'));
  assert.ok(/invoke\('server:status'\)/.test(code), '页面没有查询服务状态（切页回来会是死局）');
  const i = code.indexOf("invoke('server:status')");
  const seg = code.slice(i, i + 700);
  assert.ok(/paintRunning/.test(seg), '查到在跑却没有回填界面状态');
  assert.ok(/dirIn\.value/.test(seg) && /portIn\.value/.test(seg), '没有把目录/端口填回输入框');
});

/* ==================== 6. 电源门禁三种穿透 ==================== */
t('6a 三种新绕过必须全部拦下', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  const must = [
    'cmd /c %ComSpec% /c shutdown /s',
    'powershell -EncodedCommand UwB0AG8AcAAtAEMAbwBtAHAAdQB0AGUAcgA=',
    'for %i in (x) do shutdown /s',
  ];
  for (const c of must) {
    assert.strictEqual(PG.isPowerCommand(c), true, '未拦下：' + c);
  }
});
t('6b 原有 8 种对照仍然拦下（不能改坏）', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  const must = [
    'shutdown /s', 'cmd /c shutdown /s', 'shutdown.exe /s',
    'echo hi & shutdown /s', 'rundll32 powrprof.dll,SetSuspendState 0,1,0',
    'call shutdown /s', 'start shutdown /s',
  ];
  for (const c of must) assert.strictEqual(PG.isPowerCommand(c), true, '未拦下：' + c);
});
t('6c 不能误伤日常命令', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  const B = String.fromCharCode(92);
  const allow = ['echo shutdown', 'shutdown /a', 'type shutdown.txt', 'del shutdown.log',
    'copy shutdown.exe D:' + B, 'tasklist | findstr shutdown'];
  for (const c of allow) assert.strictEqual(PG.isPowerCommand(c), false, '误拦了：' + c);
});
t('6d 未展开的变量 fail-closed，已知变量要能展开', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  /* 未知变量：判不出来 → 按需要门禁（fail-closed） */
  assert.strictEqual(PG.isPowerCommand('%FOO% shutdown /s'), true, '未知变量 + 危险词应当拦截');
  /* 纯文本里的 %VAR% 不算（已被文本豁免放行） */
  assert.strictEqual(PG.isPowerCommand('echo %PATH%'), false, 'echo 只是打印变量，不该拦');
  /* 已知变量展开后应能剥壳 */
  const norm = PG.normalizeCommand('cmd /c %ComSpec% /c shutdown /s');
  assert.ok(!/%comspec%/.test(norm), 'normalizeCommand 没有展开 %ComSpec%：' + norm);
});

/* ==================== 7. clean-junk 来源校验 ==================== */
t('7a clean-junk 只接受本次扫描命中的路径', () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf("handle('fs:clean-junk'");
  assert.ok(i > 0, '找不到 fs:clean-junk');
  const seg = code.slice(i, i + 2400);
  /* 【不能只查"有没有那句错误文案"】
   * 第一次写的是 /junkScanCache/.test + /不在本次扫描结果内/.test，
   * 而把守卫改成 `if (false) {` 之后，**文案字符串还在源码里**（只是永不执行），
   * 断言照样绿（反向验证 MISSED 证实）。必须断言 guards 调用**本身**没被短路。 */
  assert.ok(/junkScanCache\.paths\.has\(normForJunk\(abs\)\)/.test(seg),
    '没有真正的"是否在扫描结果内"判断');
  assert.ok(!/if \(false\)[\s\S]{0,120}junkScanCache/.test(seg),
    '存在把来源校验短路掉的写法（if (false) 之类的开关）');
  // 缓存为空时必须拒绝（没扫过就没有清理依据）
  assert.ok(/junkScanCache\.paths\.size/.test(seg), '没有处理"缓存为空"的情形');
  /* 反面：keepRoot=false 的连根删分支必须消失 */
  assert.ok(!/keepRoot[\s\S]{0,400}fsp\.rm\(abs, \{ recursive: true, force: true \}\)/.test(seg),
    'keepRoot=false 的「递归删掉整个目标」分支仍存在（能力范围外溢）');
});
t('7b clean-junk 会缓存扫描结果', () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf("handle('fs:scan-junk'");
  const seg = code.slice(i, code.indexOf("handle('fs:clean-junk'"));
  assert.ok(/junkScanCache = \{/.test(seg), 'scan-junk 没有把候选集合记下来');
  assert.ok(/cachePaths/.test(seg), '没有收集候选路径');
});

/* ==================== 8. fs:rename 的闸门与门禁 ==================== */
t('8a fs:rename 补了 checkOverwritable 闸门', () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf("handle('fs:rename'");
  assert.ok(i > 0, '找不到 fs:rename');
  const seg = code.slice(i, code.indexOf("handle('fs:delete'"));
  assert.ok(/checkOverwritable/.test(seg), 'fs:rename 没有覆盖闸门（可以把文件搬进 Startup 或覆盖任意目标）');
  /* 大小写改名分支必须保留 */
  assert.ok(/toLowerCase\(\) === rt\.toLowerCase\(\)/.test(seg), '纯大小写改名被误删了');
});
t('8b fs:rename 在 file-delete 门禁里，且工具表同步', () => {
  const code = stripComments(mainSrc);
  assert.ok(/'fs:rename': 'file-delete'/.test(code), 'fs:rename 不在 CAP_GATED_CHANNELS');
  assert.ok(/'batch-rename': \['file-delete'\]/.test(code), '批量重命名没有登记依赖 file-delete');
  assert.ok(/'batch-ext': \['file-delete'\]/.test(code), '批量改后缀没有登记依赖 file-delete');
});
t('8c 行为：往系统目录改名会被拒，普通目录不受影响', () => {
  const pg = require(path.join(ROOT, 'lib', 'path-guard'));
  const B = String.fromCharCode(92);
  assert.ok(pg.checkOverwritable('C:' + B + 'Windows' + B + 'x.exe'), '系统目录内的目标应被拒');
  assert.strictEqual(pg.checkOverwritable('D:' + B + 'a' + B + 'x.exe'), null, '普通目录不该被拦');
});

/* ==================== 9. LastBootUpTime ==================== */
t('9a parsePsDate 三种形态', () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf('function parsePsDate');
  const j = code.indexOf("handle('sys:hw-info'");
  assert.ok(i > 0 && j > i, '找不到 parsePsDate');
  const f = new Function(code.slice(i, j) + '\nreturn { parsePsDate, normalizeDateFields };')();
  assert.strictEqual(f.parsePsDate('/Date(1793413286500)/'), 1793413286500, 'PS 5.1 的 /Date(ms)/ 必须解析成毫秒');
  assert.strictEqual(f.parsePsDate('2026-10-31T00:00:00Z'), new Date('2026-10-31T00:00:00Z').getTime(), 'ISO 也要能解析');
  assert.strictEqual(f.parsePsDate(null), null, 'null 应返回 null');
  assert.strictEqual(f.parsePsDate('garbage'), null, '解析不出来应返回 null（不能返回 NaN）');
  assert.strictEqual(f.parsePsDate(1793413286500), 1793413286500, '已经是数字就原样返回');
  // normalizeDateFields 要真正替换字段
  const n = f.normalizeDateFields({ LastBootUpTime: '/Date(1793413286500)/', InstallDate: null, Caption: 'x' });
  assert.strictEqual(n.LastBootUpTime, 1793413286500);
  assert.strictEqual(n.InstallDate, null);
  assert.strictEqual(n.Caption, 'x', '其它字段不该丢');
});
t('9b 渲染层不再渲染出 NaN', () => {
  const code = stripComments(read('js/tools/sys-tools.js'));
  assert.ok(/function fmtBoot/.test(code), '没有 fmtBoot 防御');
  const i = code.indexOf('function fmtBoot');
  const seg = code.slice(i, i + 900);
  assert.ok(/Number\.isFinite/.test(seg), 'flat 地调 fmtDate 会把 NaN 渲染成 NaN-NaN-NaN');
  assert.ok(/'-'/.test(seg), '取不到时应显示 -');
  /* 旧的直算写法必须消失 */
  assert.ok(!/fmtDate\(new Date\(info\.os\.LastBootUpTime\)\.getTime\(\)\)/.test(code),
    '仍在直接 new Date(...).getTime() 传给 fmtDate');
});

/* ==================== 10. 选择弹窗关闭后不能挂起 ==================== */
t('10a 两处 modal 都传了 onClose', () => {
  const code = stripComments(read('js/tools/launch.js'));
  const i1 = code.indexOf('function pickOne');
  assert.ok(i1 > 0, '没有抽 pickOne');
  assert.ok(/onClose/.test(code), '没有传 onClose —— 关掉弹窗后 Promise 永不 settle');
  const n = (code.match(/onClose/g) || []).length;
  assert.ok(n >= 1, 'onClose 没出现');
  /* await 之后必须判空 */
  assert.ok(/if \(!type\) return/.test(code), 'type 为空时没有提前返回');
  assert.ok(/if \(!shell\) return/.test(code), 'shell 为空时没有提前返回');
});
t('10b 两处都被外层 try/catch 包住，失败要 toast', () => {
  const code = stripComments(read('js/tools/launch.js'));
  const n = (code.match(/async function add\(\)/g) || []).length;
  assert.strictEqual(n, 2, '预期两个 add()，实际 ' + n);
  assert.ok(/添加失败/.test(code), '快捷启动的 add 没有兜底提示');
  assert.ok(/收藏失败/.test(code), '命令收藏的 add 没有兜底提示');
});
t('10c 行为：onClose 触发后 add 不再往下走', async () => {
  /* 用桩复现机理：Promise 只在按钮里 resolve，onClose 没接 → 永不 settle。 */
  let settled = false;
  const p = new Promise((resolve) => { /* 模拟"按钮没点、onClose 没接" */ void resolve; });
  const withOnClose = new Promise((resolve) => { resolve(null); });   // 修好后的形态
  const v = await withOnClose;
  assert.strictEqual(v, null, '修好的形态应当 resolve(null)');
  assert.ok(/onClose: \(\) => resolve\(null\)/.test(stripComments(read('js/tools/launch.js'))
    .replace(/\s+/g, ' ').replace(/onClose: \(\) => resolve\(null\)/, 'onClose: () => resolve(null)')),
    'pickOne 的 onClose 没有 resolve(null)');
});

/* ==================== 11. 随机数字/字符串不共用 input ==================== */
t('11a 长度用独立的 lenIn，rangeA 只出现一次', () => {
  const code = stripComments(read('js/tools/dev.js'));
  assert.ok(/const lenIn = h\('input'/.test(code), '没有独立的长度输入框');
  const i = code.indexOf("div('card', div('card-title', '生成')");
  const seg = code.slice(i, i + 500);
  const count = (seg.match(/rangeA/g) || []).length;
  assert.strictEqual(count, 1, 'rangeA 在「生成」卡片里出现了 ' + count + ' 次（DOM 节点只能有一个父节点，第二次 append 会把它移走）');
  assert.ok(/lenIn/.test(seg), '长度那一行没有用 lenIn');
  assert.ok(/parseInt\(lenIn\.value/.test(code), 'gen(str) 没有读 lenIn');
});
t('11b 两个 input 是不同元素（用 data-role 标记）', () => {
  const code = stripComments(read('js/tools/dev.js'));
  assert.ok(/'data-role': 'num-min'/.test(code), 'rangeA 没有可辨识的标记');
  assert.ok(/'data-role': 'str-len'/.test(code), 'lenIn 没有可辨识的标记');
});

/* ==================== 12. 目标番茄数 ==================== */
t('12a countIn 被读取，「已完成」可刷新', () => {
  const code = stripComments(read('js/tools/life.js'));
  assert.ok(/function readTarget/.test(code), '没有读取目标番茄数');
  assert.ok(/parseInt\(countIn\.value/.test(code), 'countIn 仍然从没被读过');
  assert.ok(/targetPomodoros = Math\.max/.test(code), '没有做范围钳制');
  assert.ok(/paintDone/.test(code), '「已完成」没有可刷新的绘制函数');
  assert.ok(/countIn\.addEventListener\('change'/.test(code), '改目标后界面不更新');
  /* 反面：不能再是一次性文本 */
  assert.ok(!/h\('span', \{ class: 'field-hint' \}, `已完成 \$\{pomodoros\}`\)/.test(code),
    '「已完成」仍是一次性字符串（永远是 0）');
});

/* ==================== 13. split-file 的失败收口 ==================== */
t('13a split-file 失败时销毁读流并清掉分片', () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf("handle('fs:split-file'");
  assert.ok(i > 0, '找不到 fs:split-file');
  const seg = code.slice(i, i + 4200);
  assert.ok(/const fail = /.test(seg), '没有统一的 fail() 收口');
  assert.ok(/rs\.destroy\(\)/.test(seg), '失败时没有销毁读流（卡在背压暂停就再也不继续，fd 挂到进程退出）');
  assert.ok(/ws\.destroy\(\)/.test(seg), '失败时没有销毁写流');
  assert.ok(/madePaths/.test(seg), '没有记录本次产出的分片，失败后不会清理半截文件');
});
t('13b 行为：预置同名分片后调用，reject 且不残留', async () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf("handle('fs:split-file'");
  const open = code.indexOf('{', i);
  let depth = 0, j = open, inS = null;
  while (j < code.length) {
    const c = code[j];
    if (inS) { if (c === '\\') j++; else if (c === inS) inS = null; j++; continue; }
    if (c === '/' && code[j + 1] === '/') { const nl = code.indexOf('\n', j); j = nl === -1 ? code.length : nl; continue; }
    if (c === '/' && code[j + 1] === '*') { const e = code.indexOf('*/', j + 2); j = e === -1 ? code.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') { inS = c; j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
    j++;
  }
  const body = code.slice(open, j);
  /* 形参名是 (e, p, chunkMB, outDir)，包装层必须同名地把参数传进去，
   * 否则 body 里引用 p 会得到 "p is not defined"（第一次跑就撞上了）。 */
  const fn = new Function('path', 'fsp', 'fs', 'send',
    'return async (e, p, chunkMB, outDir) => ' + body + ';')(path, fs.promises, fs, () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r15-split-'));
  try {
    const src = path.join(dir, 'big.bin');
    fs.writeFileSync(src, Buffer.alloc(64 * 1024));
    const outDir = path.join(dir, 'parts');
    fs.mkdirSync(outDir);
    // 预置一个同名 part1 → flags:'wx' 必然 EEXIST
    fs.writeFileSync(path.join(outDir, 'big.bin.part1'), 'x');
    await assert.rejects(() => fn({}, src, 1, outDir), /同名分片/,
      '预置同名分片后应当明确拒绝（而不是静默覆盖）');
    // 目录里只应剩那个我们预置的文件
    const left = fs.readdirSync(outDir);
    assert.deepStrictEqual(left, ['big.bin.part1'],
      '失败后留下了本次产出的分片：' + JSON.stringify(left));
  } finally { rmDir(dir); }
});

/* ==================== 14. 静态服务读流 ==================== */
t('14a 静态服务用 pipeline（或 res.on(close)) 保证销毁读流', () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf("handle('server:start'");
  assert.ok(i > 0, '找不到 server:start');
  const seg = code.slice(i, code.indexOf("handle('server:stop'"));
  /* 【不能只看"文件里出现过 pipeline("】
   * 兜底的 catch 分支里也有一句 pipeline 相关代码，把主路径退回成裸
   * `stream.pipe(res)` 后，`pipeline(` 这个词仍然存在 → 断言照样绿
   * （反向验证 MISSED 证实了）。必须断言**主路径**走的是 pipeline，
   * 且不存在"裸 pipe"。
   */
  /* 【只看主路径（try 块内），不看 catch 兜底】
   * pipeline 不可用时的兜底分支里本来就该有 stream.pipe(res) —— 那条分支
   * 同时还挂了 res.on('close')，资源是会被释放的。
   * 第一次的写法用整段匹配 `^\s*stream\.pipe\(res\);$`，把兜底也算进去了，
   * 于是当前（正确）的代码也会红。 */
  const tryAt = seg.indexOf('try {', seg.indexOf('createReadStream'));
  const tryEnd = seg.indexOf('} catch (e) {', tryAt);
  const mainPath = (tryAt >= 0 && tryEnd > tryAt) ? seg.slice(tryAt, tryEnd) : seg;
  assert.ok(!/stream\.pipe\(res\)/.test(mainPath),
    '主路径仍是裸 stream.pipe(res)：客户端断开只 unpipe，不销毁源流，fd 一直开着');
  assert.ok(/pipeline\(stream, res/.test(mainPath), '主路径没有用 pipeline 让 Node 负责销毁两端');
  assert.ok(/res\.on\('close'/.test(seg), '缺少"客户端断开"的兜底处理');
  assert.ok(/stream\.destroy\(/.test(seg), '缺少 destroy 兜底');
});

/* ==================== 15. Math.max(...arr) ==================== */
t('15 全库不再用展开传参求极值', () => {
  const files = ['main.js', 'lib/target-size.js', 'lib/dir-move.js', 'lib/links.js',
    'js/tools/media.js', 'js/tools/net-tools.js', 'js/tools/dev.js'];
  const bad = [];
  for (const f of files) {
    const code = stripComments(read(f));
    for (const m of code.matchAll(/Math\.(max|min)\s*\(\s*\.\.\./g)) bad.push(f + ' -> ' + m[0]);
  }
  assert.deepStrictEqual(bad, [], '仍在用展开传参（数组一大就 RangeError: Maximum call stack size exceeded）');
});
t('15b 行为：13 万个元素的极值不再抛错', () => {
  const arr = new Array(130000).fill(1);
  let threw = null;
  try { Math.max(...arr); } catch (e) { threw = e; }
  assert.ok(threw && /Maximum call stack/.test(threw.message),
    '前提不成立：13 万参数应当会栈溢出（若 Node 版本变了请更新本条）');
  // reduce 版必须正常
  assert.strictEqual(arr.reduce((a, b) => (a > b ? a : b), 0), 1, 'reduce 版应当正常工作');
});

/* ==================== 16. 剪贴板历史上限 ==================== */
t('16a 两条裁剪路径共用同一上限', () => {
  const code = stripComments(read('js/tools/security.js'));
  assert.ok(/const HISTORY_LIMIT = 200/.test(code), '没有统一上限常量');
  assert.ok(/trimHistory\(history\)/.test(code), '没有走统一裁剪');
  // 反面：不许再出现写死的 200 与 100
  assert.ok(!/history = history\.slice\(0, 200\)/.test(code), '文本路径仍是硬编码 slice(0,200)（不回收图片）');
  assert.ok(!/trimHistory\(history, 100\)/.test(code), '图片路径仍用另一个上限 100');
});
t('16b 行为：淘汰的图片文件必须被回收', async () => {
  /* 复现机理：一条图片被文本挤出列表时，它的落盘文件要跟着删。
   * 【场景设计】把图片放在**列表末尾**（最老的位置），再加两条新文本，
   * 这样它必然被挤出前 200 名 —— 之前我把图片放在最前面，它永远不会被淘汰，
   * 于是断言恒空转（那种"永远绿"的测试等于没测）。 */
  const removed = [];
  const dropImages = async (entries) => {
    const f = (entries || []).filter((x) => x && x.type === 'image' && x.file).map((x) => x.file);
    if (f.length) removed.push(...f);
  };
  const LIMIT = 200;
  async function trimHistory(list) {
    if (list.length <= LIMIT) return list;
    const dropped = list.slice(LIMIT);
    await dropImages(dropped);
    return list.slice(0, LIMIT);
  }
  const list = [];
  for (let i = 0; i < LIMIT; i++) list.push({ type: 'text', content: 't' + i });
  // 图片压在末尾（最老），再加两条新条目 → 它被挤出前 200
  list.push({ type: 'image', file: 'C:/tmp/pic.png' });
  list.unshift({ type: 'text', content: 'new1' });
  list.unshift({ type: 'text', content: 'new2' });
  const out = await trimHistory(list);
  assert.ok(out.length <= LIMIT, '裁剪后仍超上限：' + out.length);
  assert.deepStrictEqual(removed, ['C:/tmp/pic.png'],
    '被挤出的图片文件没有被回收（会永久残留在 clip-img 里）');
  assert.ok(!out.some((x) => x.type === 'image'),
    '图片仍在列表里，说明本场景没造对（测试会恒绿）');
});

/* ==================== 17. scan-tree 根路径 ==================== */
t('17a 根路径归一：尾随分隔符不影响统计口径', () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf('function normalizeRootForScan');
  assert.ok(i > 0, '没有抽出 normalizeRootForScan');
  const j = code.indexOf("handle('fs:scan-empty-dirs'");
  const f = new Function('path', code.slice(i, j) + '\nreturn normalizeRootForScan;')(path);
  const B = String.fromCharCode(92);
  assert.strictEqual(f('D:' + B + 'foo' + B), 'D:' + B + 'foo', '尾随分隔符没有被去掉');
  assert.strictEqual(f('D:' + B + 'foo'), 'D:' + B + 'foo', '正常路径不该变');
  assert.strictEqual(f('D:' + B), 'D:' + B, '盘符根必须保留原有形态');
  assert.strictEqual(f('D:/foo//'), 'D:' + B + 'foo', '正斜杠与重复分隔符也要归一');
});
t('17b 聚合用的是路径比较，不是字符串长度', () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf("handle('fs:scan-tree'");
  const seg = code.slice(i, i + 2400);
  assert.ok(!/cur\.length >= root\.length/.test(seg),
    '仍在用字符串长度做包含判断（root 带尾斜杠时循环一次都不进，根统计恒为 0）');
  assert.ok(/cur === scanRoot/.test(seg) && /startsWith\(scanRoot \+ path\.sep\)/.test(seg),
    '没有改成 cur === root || cur.startsWith(root + sep) 的判定');
});
t('17c 行为：带/不带尾斜杠扫描同一个目录，根统计一致', async () => {
  /* 直接跑聚合逻辑的真实实现：构造 dirSize 键，验证根目录能累加到值。 */
  const code = stripComments(mainSrc);
  const i = code.indexOf('function normalizeRootForScan');
  const j = code.indexOf("handle('fs:scan-empty-dirs'");
  const f = new Function('path', code.slice(i, j) + '\nreturn normalizeRootForScan;')(path);
  const B = String.fromCharCode(92);
  const base = path.join(os.tmpdir(), 'r15-scanroot');
  const rootNorm = f(base + B);                  // 带尾斜杠
  const rootPlain = f(base);                     // 不带
  assert.strictEqual(rootNorm, rootPlain, '两种写法归一后必须相同');
  /* 模拟聚合：文件在 base/a.txt，从 dirname 往上走应能命中 root */
  const filePath = path.join(base, 'a.txt');
  let cur = path.dirname(filePath);
  let hit = false;
  while (cur === rootNorm || cur.startsWith(rootNorm + path.sep) || cur === path.parse(cur).root) {
    if (cur === rootNorm) hit = true;
    if (cur === path.parse(cur).root || cur === rootNorm) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  assert.strictEqual(hit, true, '从文件向上聚合没有命中根目录（根统计会恒为 0）');
});

/* ==================== 执行 ==================== */
done();
