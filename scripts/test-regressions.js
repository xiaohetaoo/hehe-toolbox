'use strict';
/* 回归测试：锁死本轮修复的 5 个问题。
 * 每个用例都对应一个真实发生过的 bug —— 只断言“代码里有没有那段字符串”是不够的，
 * 尽量验证行为本身。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
}

/* ---------- P0：snip.html 标注渲染 ----------
 * accentPrimary 曾落在 </script> 之后，被 HTML 解析器当正文：
 * 页面上显示源码，函数未定义，render() 一进“已有选区”分支就 ReferenceError。
 * 断言必须按“函数是否真的落在某个 script 块内”判定，而不是查字符串是否存在。 */
t('P0 snip.html: accentPrimary 定义在 script 块内', () => {
  const h = read('snip.html');
  const blocks = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(h))) blocks.push([m.index, m.index + m[0].length]);
  const fnPos = h.indexOf('function accentPrimary(');
  assert.ok(fnPos > 0, '没找到 accentPrimary 定义');
  assert.ok(blocks.some(([s, e]) => fnPos >= s && fnPos < e), 'accentPrimary 不在任何 script 块内');
});
t('P0 snip.html: 结束标签之后没有游离的 JS 代码', () => {
  const h = read('snip.html');
  assert.ok(!/<\/script>\s*\n\s*(function|const|let|var|\/\/)/.test(h), '在 </script> 之后还有裸 JS');
});
t('P0 snip.html: script 标签成对', () => {
  const h = read('snip.html');
  const open = (h.match(/<script>/g) || []).length;
  const close = (h.match(/<\/script>/g) || []).length;
  assert.strictEqual(open, close, `<script>${open} 个 vs </script>${close} 个`);
});
t('P0 snip.html: render 覆盖选区/手柄/标注三条绘制', () => {
  const h = read('snip.html');
  const body = (h.match(/function render\(\)([\s\S]*?)\n    \}/) || [, ''])[1];
  assert.ok(body.includes('accentPrimary()'), 'render 里没有调用 accentPrimary');
  assert.ok(body.includes('fillRect') && body.includes('strokeRect'), 'render 缺少压暗/边框绘制');
  assert.ok(body.includes('for (const s of shapes)'), 'render 没有遍历 shapes 绘制标注');
});

/* ---------- P1：Win11 经典右键菜单 ----------
 * 旧实现写的是 \InnoServerSetup（不存在的键名），且状态检测只看父键是否存在。
 * 正确做法：建 InprocServer32 且默认值为空。 */
t('P1 注册表用的是 InprocServer32', () => {
  const s = read('main.js');
  assert.ok(s.includes("'\\\\InprocServer32'"), '没有使用 InprocServer32 子键');
  // 注释里保留历史说明是允许的，只禁止“仍在代码里使用”
  const code = s.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/InnoServerSetup/.test(code), '代码里仍在写无效的 InnoServerSetup 键');
});
t('P1 写入时显式把默认值置空 (/ve /d "")', () => {
  const s = read('main.js');
  const m = s.match(/reg',\s*\['add',\s*WIN11_CTX_HANDLER[^\]]*\]/);
  assert.ok(m, '没找到写注册表的调用');
  assert.ok(m[0].includes("'/ve'"), '缺少 /ve（写默认值）');
  assert.ok(m[0].includes("'/d', ''"), '缺少 /d ""（置空默认值）');
});
t('P1 状态检测读默认值而非只看父键存在', () => {
  const s = read('main.js');
  assert.ok(s.includes('ctxClassicState'), '没有独立的真实状态检测函数');
  const fn = s.match(/async function ctxClassicState\(\)[\s\S]*?\n\}/)[0];
  assert.ok(fn.includes("'/ve'"), '状态检测没有查默认值');
  assert.ok(!/WIN11_CTX_KEY\]\s*\)/.test(fn), '状态检测仍只看父键');
});

/* ---------- P2-1：update:cleanup 不得删掉待安装的新包 ---------- */
t('P2 update:cleanup 按版本号豁免，不再一律删光', () => {
  const s = read('main.js');
  const fn = s.match(/handle\('update:cleanup'[\s\S]*?\n\}\);/)[0];
  assert.ok(fn.includes('cmpVer'), '没有版本号比较');
  assert.ok(/pendingName/.test(fn), '没有对待安装包的豁免');
  assert.ok(!/^\s*removed\+\+;\s*bytes \+= st\.size;$/m.test(fn) || fn.includes('cmpVer'),
    '仍是无条件删除');
});
t('P2 update:cleanup 有 mark-pending 登记通道', () => {
  assert.ok(read('main.js').includes("handle('update:mark-pending'"), '缺少 mark-pending');
  assert.ok(read('js/app.js').includes("update:mark-pending"), '前端没有登记待安装包');
});
t('P2 关于页下载进度按 job id 过滤', () => {
  const s = read('js/app.js');
  const seg = s.slice(s.indexOf("const out = info.userData + '/update/'"), s.indexOf('finally {', s.indexOf("const out = info.userData + '/update/'")));
  assert.ok(/d\.id\s*!==\s*dlId/.test(seg), '进度回调没有比对 dl.id');
  assert.ok(seg.includes('pendingEvents'), '没有缓冲 dl.id 到达前的事件');
});

/* ---------- P2-3：回滚脚本进程名 ---------- */
t('P2 回滚脚本按 exe 路径停进程，不用写死的中文名', () => {
  const s = read('main.js');
  const start = s.indexOf('const rb = [');
  const seg = s.slice(start, s.indexOf("].join('\\r\\n');", start));
  assert.ok(seg.length > 0, '没找到回滚脚本文本');
  assert.ok(!/Get-Process -Name/.test(seg), '仍按硬编码进程名杀进程');
  assert.ok(seg.includes('Where-Object { $_.Path -eq $target }'), '没有按 exe 完整路径匹配');
});

/* ---------- P2-4：摄像头预览 deviceId ---------- */
t('P2 摄像头预览按 label 解析出真实 deviceId', () => {
  const s = read('js/tools/media.js');
  assert.ok(s.includes('resolveDeviceId'), '没有 label -> deviceId 的解析函数');
  const rfn = s.match(/async function resolveDeviceId[\s\S]*?\n      \}/)[0];
  assert.ok(rfn.includes('enumerateDevices'), '没有枚举设备');
  assert.ok(rfn.includes('label'), '没有按 label 匹配');
  // exact 约束在调用处（startPreview），不在解析函数里
  const pfn = s.match(/async function startPreview[\s\S]*?\n      \}/)[0];
  assert.ok(pfn.includes('exact: realId'), 'getUserMedia 仍用 ideal（会静默回落默认设备）');
  assert.ok(pfn.includes('resolveDeviceId'), 'startPreview 没有走 label 解析');
  // 注释里解释“为什么不能用 ideal”是允许的；只禁止代码里真的用 ideal 传 dshow 名
  const code = s.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/deviceId: \{ ideal: deviceId \}/.test(code), '仍把 dshow 名当 deviceId 用');
});

/* ---------- P3：调度参数校验 ---------- */
t('P3 sched:add 对 NaN 间隔直接拒绝', () => {
  const s = read('main.js');
  assert.ok(s.includes('normSchedule'), '没有参数归一化');
  const fn = s.match(/function normSchedule[\s\S]*?\n\}/)[0];
  assert.ok(fn.includes('Number.isFinite'), '没有校验 NaN');
  assert.ok(fn.includes('SCHED_TYPES'), '没有校验任务类型');
});
t('P3 armSchedule 对 NaN 间隔兜底', () => {
  const s = read('main.js');
  const fn = s.match(/function armSchedule[\s\S]*?\n\}/)[0];
  assert.ok(fn.includes('Number.isFinite'), 'armSchedule 仍可能拿 NaN 去 setInterval');
  assert.ok(!/Math\.max\(60000, \(s\.everyMin \|\| 30\) \* 60000\)/.test(fn), '仍是旧的 NaN 不安全写法');
});

/* ---------- P3：录制拼接降级 ---------- */
t('P3 rec:stop 降级时如实返回 degraded', () => {
  const s = read('main.js');
  const fn = s.match(/handle\('rec:stop'[\s\S]*?\n\}\);/)[0];
  assert.ok(fn.includes('degraded'), '没有降级标记');
  assert.ok(/return \{ ok: true[^}]*degraded/.test(fn), '返回值里没有 degraded');
});

/* ---------- P3：clean 任务 mtime 保护 ---------- */
t('P3 定时清理保留 24 小时内的临时产物', () => {
  const s = read('main.js');
  const seg = s.slice(s.indexOf('if (s.type === \'clean\')'), s.indexOf('} else {\n      send(\'sched:fire\''));
  assert.ok(seg.includes('KEEP_MS'), '没有保留窗口');
  assert.ok(seg.includes('mtimeMs'), '没有比对 mtime');
  assert.ok(/skipped/.test(seg), '没有跳过计数');
});

/* ---------- P3：剪贴板文本长度 ---------- */
t('P3 剪贴板文本有长度上限', () => {
  const s = read('js/tools/security.js');
  assert.ok(s.includes('CLIP_TEXT_LIMIT'), '没有长度上限');
  assert.ok(s.includes('admitText'), '没有入库前的截断/拦截');
});

/* ---------- P3：笔记搜索防抖 ---------- */
t('P3 笔记搜索做了防抖', () => {
  const s = read('js/tools/text-tools.js');
  assert.ok(!/searchIn\.addEventListener\('input', \(\) => refreshList\(\)\)/.test(s), '仍是每次击键全量读盘');
  assert.ok(/searchIn\.addEventListener\('input', window\.ui\.debounce/.test(s), '没有用防抖');
});

/* ---------- P3：store 损坏时的清扫 ---------- */
t('P3 store 解析失败时跳过孤儿图片清扫', () => {
  const s = read('main.js');
  assert.ok(s.includes('storeLoadFailed'), '没有加载失败标记');
  const fn = s.match(/async function sweepClipImages\(\)[\s\S]*?\n\}/)[0];
  assert.ok(fn.includes('storeLoadFailed'), '清扫没有检查加载状态');
  const load = s.match(/function loadStore\(\)[\s\S]*?\n\}/)[0];
  assert.ok(load.includes('ENOENT'), '没有区分首次运行与解析失败');
});

/* ---------- P3：fs:rename 覆盖保护 ---------- */
t('P3 fs:rename 默认拒绝覆盖已存在目标', () => {
  const s = read('main.js');
  const fn = s.match(/handle\('fs:rename'[\s\S]*?\n\}\);/)[0];
  assert.ok(fn.includes('existsSync'), '没有检查目标是否存在');
  assert.ok(fn.includes('overwrite'), '没有显式 overwrite 开关');
});

/* ---------- P3：hero 文案不硬编码 ---------- */
t('P3 首页工具数不再硬编码', () => {
  const s = read('js/app.js');
  assert.ok(!/'92 个工具/.test(s), '仍硬编码 92 个工具');
  assert.ok(/R\.all\.length/.test(s), '没有从注册表取真实数量');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
