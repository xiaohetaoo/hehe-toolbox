'use strict';
/* 第五轮审查：破坏性 bug 的回归测试。
 *
 * 本轮的核心是「杜绝破坏性 bug」——用户数据被毁掉比功能失效严重得多。
 * 每个用例都对应一个已确认的真实 bug。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const guard = require('../lib/path-guard');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
}
/* 取 main.js 中某个 handle 块的正文 */
function handlerBody(src, channel) {
  const start = src.indexOf("handle('" + channel + "'");
  assert.ok(start > 0, '找不到 handler: ' + channel);
  const end = src.indexOf('\n});', start);
  return src.slice(start, end);
}
/* 取升级脚本（const ps = [ ... ].join('\r\n');）的正文 */
function updateScriptBody(src) {
  const start = src.indexOf('const ps = [');
  assert.ok(start > 0, '找不到升级脚本');
  const end = src.indexOf("].join('", start);
  assert.ok(end > start, '找不到升级脚本结尾');
  return src.slice(start, end);
}

/* ================= P0：fs:delete 无边界 ================= */
t('P0 fs:delete 有路径闸门', () => {
  const fn = handlerBody(read('main.js'), 'fs:delete');
  assert.ok(fn.includes('pathGuard.checkDeletable'), '没有调用删除闸门');
  assert.ok(fn.includes('pathGuard.err'), '闸门拒绝时没有返回结构化错误');
});
t('P0 fs:delete 不再是裸的 fsp.rm', () => {
  const fn = handlerBody(read('main.js'), 'fs:delete');
  assert.ok(!/handle\('fs:delete'.*fsp\.rm\(p, \{ recursive: !!recursive, force: true \}\);/.test(fn),
    '仍是零校验的裸调用');
});

/* ================= P0：写文件覆盖 + 半截文件 ================= */
t('P0 fs:write-text / fs:write-file-b64 走原子写', () => {
  const s = read('main.js');
  assert.ok(s.includes('async function writeFileAtomic'), '没有原子写辅助函数');
  const fn = handlerBody(s, 'fs:write-text');
  assert.ok(fn.includes('writeFileAtomic'), 'fs:write-text 没用原子写');
  const fn2 = handlerBody(s, 'fs:write-file-b64');
  assert.ok(fn2.includes('writeFileAtomic'), 'fs:write-file-b64 没用原子写');
});
t('P0 原子写失败会清理临时文件', () => {
  const s = read('main.js');
  const fn = s.match(/async function writeFileAtomic[\s\S]*?\n\}/)[0];
  assert.ok(fn.includes("rm(tmp, { force: true })"), '失败时没清理临时文件');
  assert.ok(fn.includes('rename(tmp, dest)'), '没有用 rename 做原子提交');
});
t('P0 原子写有覆盖保护', () => {
  const s = read('main.js');
  const fn = s.match(/async function writeFileAtomic[\s\S]*?\n\}/)[0];
  assert.ok(fn.includes('checkOverwritable'), '没有检查是否可覆盖');
});

/* ================= P0：%TEMP% 清理越界 ================= */
t('P0 fs:scan-junk 的临时项只扫本应用产物', () => {
  const fn = handlerBody(read('main.js'), 'fs:scan-junk');
  assert.ok(fn.includes('ownOnly'), '没有 ownOnly 标记');
  assert.ok(fn.includes('isOwnTempName'), '没有用白名单过滤');
  // 关键：temp 这一项不能把整个 os.tmpdir() 作为 target
  const tempLine = fn.match(/\{ id: 'temp'[^\n]*/);
  assert.ok(tempLine, '找不到 temp 候选');
  assert.ok(tempLine[0].includes('ownOnly: true'), 'temp 项未标记 ownOnly');
  assert.ok(!/targets: \[c\.path\]/.test(fn.match(/ownOnly[\s\S]*?continue;/)[0] || ''), 'ownOnly 分支仍用了整个目录');
});
t('P0 fs:clean-junk 拒绝清理 %TEMP% 里的非本应用产物', () => {
  const fn = handlerBody(read('main.js'), 'fs:clean-junk');
  assert.ok(fn.includes('tmpRoot'), '没有识别 %TEMP% 根');
  assert.ok(fn.includes('isOwnTempName'), '没有用白名单校验');
  assert.ok(fn.includes('checkDeletable'), '没有系统关键目录闸门');
});
t('P0 临时产物白名单覆盖所有本应用目录', () => {
  const s = read('main.js');
  const fn = s.match(/const OWN_TEMP_PATTERNS = \[[\s\S]*?\];/)[0];
  for (const p of ['hehe-7zx-', 'hehe-tgt-', 'hehe-snip-', 'hehe-rec-']) {
    assert.ok(fn.includes(p), '白名单缺少 ' + p);
  }
});

/* ================= P1：升级脚本三个破坏点 ================= */
t('P1 升级脚本备份不覆盖历史版本', () => {
  const fn = updateScriptBody(read('main.js'));
  assert.ok(fn.includes('$stamp'), '没有带时间戳的备份');
  assert.ok(/Destination \(\$backup \+ "\." \+ \$stamp\)/.test(fn), '历史备份没保留');
});
t('P1 升级脚本替换后校验大小', () => {
  const fn = updateScriptBody(read('main.js'));
  assert.ok(fn.includes('$srcLen'), '没有记录源大小');
  assert.ok(fn.includes('$dstLen'), '没有记录目标大小');
  assert.ok(fn.includes('大小不符'), '没有大小校验');
});
t('P1 升级脚本启动失败时保留下载包', () => {
  const fn = updateScriptBody(read('main.js'));
  assert.ok(fn.includes('$launched'), '没有记录启动成功与否');
  // Remove-Item newExe 必须在 if (-not $launched) 这道闸门之后
  const rmIdx = fn.indexOf('Remove-Item -LiteralPath $newExe');
  const guardIdx = fn.indexOf('if (-not $launched)');
  assert.ok(guardIdx > 0 && rmIdx > guardIdx, '删除下载包没有被启动成功条件保护');
});

/* ================= P1：hosts 写入 ================= */
t('P1 hosts:write 备份失败时中止写入', () => {
  const fn = handlerBody(read('main.js'), 'hosts:write');
  assert.ok(fn.includes('backedUp'), '没有记录备份是否成功');
  assert.ok(!/catch \(err\) \{ \/\* 备份失败不阻断/.test(fn), '备份失败仍然继续写入');
});
t('P1 hosts:write 不退化成非原子覆盖写', () => {
  const fn = handlerBody(read('main.js'), 'hosts:write');
  assert.ok(!/fsp\.writeFile\(HOSTS_PATH, content/.test(fn), '仍有直接写系统 hosts 的路径');
  assert.ok(fn.includes('rename(tmp, HOSTS_PATH)'), '没有用 rename 原子替换');
});

/* ================= P1：录制降级 ================= */
t('P1 rec:stop 降级时保留分段目录', () => {
  const fn = handlerBody(read('main.js'), 'rec:stop');
  const rmIdx = fn.indexOf('fsp.rm(recSegDir');
  const guardIdx = fn.indexOf('if (!degraded)');
  assert.ok(guardIdx > 0, '没有按 degraded 判断是否清理');
  assert.ok(rmIdx > guardIdx, '分段目录无条件被删');
});
t('P1 渲染层会显示 degraded', () => {
  const s = read('js/tools/media.js');
  assert.ok(s.includes('r.degraded'), '渲染层忽略了 degraded');
  assert.ok(s.includes('escapeHtml(r.degraded)'), 'degraded 没有转义就插入 HTML');
});

/* ================= P1：图片自我覆盖 ================= */
t('P1 图片压缩输出一律取唯一名（既不盖原图也不盖已有输出）', () => {
  const s = read('js/tools/media.js');
  assert.ok(s.includes('function samePath'), '缺少 samePath 辅助函数（其它地方仍在用）');
  // 现在的做法比 samePath 更严：输出路径无条件过 unique-path，
  // 因此既防「输出==输入」，也防「输出与目录里已有文件同名」。
  assert.ok(/const finalPath = await invoke\('fs:unique-path', outPath\)/.test(s),
    '压缩输出没有无条件唯一化');
});
t('P1 水印输出一律取唯一名', () => {
  const s = read('js/tools/media.js');
  assert.ok(/const outPath = await invoke\('fs:unique-path', outDir\.replace/.test(s),
    '水印输出没有无条件唯一化');
  assert.ok(s.includes('_wm.'), '没有水印命名逻辑');
  assert.ok(s.includes('hasExt'), '没有区分有无扩展名（无扩展名时替换逻辑会失效）');
});

/* ================= P1：proc:kill 自我保护 ================= */
t('P1 proc:kill 不能杀自己', () => {
  const fn = handlerBody(read('main.js'), 'proc:kill');
  assert.ok(fn.includes('process.pid'), '没有自我保护');
  assert.ok(/n === process\.pid/.test(fn), '没有比较自身 pid');
  assert.ok(fn.includes('Number.isInteger'), '没有校验 pid 合法性');
});

/* ================= P1：merge-parts 路径穿越与覆盖 ================= */
t('P1 fs:merge-parts 限制清单里的 name 在目录内', () => {
  const fn = handlerBody(read('main.js'), 'fs:merge-parts');
  assert.ok(fn.includes('resolveInside'), '没有限制 man.name 的路径');
});
t('P1 fs:merge-parts 指定输出路径时不覆盖已有文件', () => {
  const fn = handlerBody(read('main.js'), 'fs:merge-parts');
  assert.ok(fn.includes('checkOverwritable'), '没有覆盖保护');
  assert.ok(fn.includes('fs.existsSync(finalOut)'), '没有检查目标是否已存在');
});

/* ================= P1：zip 解压不覆盖 ================= */
t('P1 zip:extract 同名不覆盖', () => {
  const fn = handlerBody(read('main.js'), 'zip:extract');
  assert.ok(fn.includes('uniqueTarget'), '解压仍会覆盖同名文件');
});
t('P1 uniqueTarget 自身有穿越防护', () => {
  const s = read('main.js');
  const fn = s.match(/async function uniqueTarget[\s\S]*?\n\}/)[0];
  assert.ok(fn.includes('resolveInside'), 'uniqueTarget 没有路径校验');
});

/* ================= P2：门禁一致性 ================= */
t('P2 path-guard 模块存在且导出完整', () => {
  const g = require('../lib/path-guard');
  for (const k of ['checkFileName', 'resolveInside', 'checkDeletable', 'checkOverwritable', 'isCriticalPath']) {
    assert.strictEqual(typeof g[k], 'function', '缺少导出: ' + k);
  }
});
t('P2 path-guard 已进构建配置', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.build.files.includes('lib/**/*'), 'lib 未进构建');
});
t('P2 path-guard 测试已接入 npm test', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.scripts.test.includes('test-path-guard.js'), '未接入 npm test');
});

/* ================= 第二轮：子代理审查发现的破坏性 bug ================= */

/* P0-1 下载器文件名路径穿越 */
t('P0 下载文件名不从 URL 直接取（防 %2F..%2F 穿越）', () => {
  const s = read('js/tools/net-tools.js');
  assert.ok(s.includes('safeNameFromUrl'), '没有安全文件名函数');
  // 旧的裸 decodeURIComponent 拼接必须消失
  const code = s.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/decodeURIComponent\(url\.split\('\?'\)\[0\]\.split\('\/'\)\.pop\(\)/.test(code),
    '仍在直接用 URL 末段当文件名');
  const fn = s.match(/function safeNameFromUrl[\s\S]*?\n  \}/)[0];
  assert.ok(fn.includes('split(/[\\\\/]/)'), '没有取 basename');
  assert.ok(fn.includes('BAD_NAME_BASE'), '没有挡 Windows 设备名');
});

/* P0-2 Office 转换覆盖同基名文件 */
t('P0 office:convert COM 分支用 uniqueTarget', () => {
  const s = read('main.js');
  const fn = s.match(/\/\/ Office COM 引擎[\s\S]*?\n\}\);/);
  const body = fn ? fn[0] : s.slice(s.indexOf("results.push({ input: f, out: null, ok: false, err: `COM 引擎不支持"), s.indexOf('return { engine: \'Office COM\''));
  assert.ok(s.includes('uniqueTarget(outDir, base + \'.\' + target)'), 'COM 分支没有唯一化输出名');
});
t('P0 office:convert LibreOffice 分支先转临时目录再挪', () => {
  const s = read('main.js');
  const i = s.indexOf("if (soffice) {");
  const seg = s.slice(i, i + 1600);
  assert.ok(seg.includes('hehe-uniq-'), '没有用临时目录中转');
  assert.ok(seg.includes('uniqueTarget'), '没有唯一化输出名');
});

/* P0-3 PDF 拆分/转图片固定命名 */
t('P0 PDF 拆分输出目录带时间戳', () => {
  const s = read('js/tools/office.js');
  assert.ok(/-split-' \+ stamp/.test(s), '拆分目录没有时间戳');
  assert.ok(s.includes("'fs:unique-path', `${dir}/part-"), '分片没有唯一化');
});
t('P0 PDF 转图片输出目录带时间戳', () => {
  const s = read('js/tools/office.js');
  assert.ok(/-images-' \+ stamp/.test(s), '图片目录没有时间戳');
  assert.ok(s.includes("'fs:unique-path', `${outDir}/page-"), '页面图片没有唯一化');
});

/* P0 writeFileAtomic 不得先删原文件 */
t('P0 writeFileAtomic 不用「先 rm 后 rename」', () => {
  const s = read('main.js');
  const fn = s.match(/async function writeFileAtomic[\s\S]*?\n\}/)[0];
  assert.ok(!/fsp\.rm\(dest, \{ force: true \}\)\.catch\(\(\) => \{\}\);\s*\n\s*await fsp\.rename\(tmp, dest\)/.test(fn),
    '仍是先删目标再改名（会丢原文件）');
  assert.ok(fn.includes('.hehe-bak-'), '没有备份中转');
  assert.ok(/rename\(bak, dest\)/.test(fn), '失败时没有把备份搬回去');
});

/* P1-4 笔记文件名过滤 */
t('P1 笔记文件名挡住设备名与尾随点', () => {
  const s = read('js/tools/text-tools.js');
  assert.ok(s.includes('safeNoteName'), '没有安全文件名函数');
  const fn = s.match(/function safeNoteName[\s\S]*?\n      \}/)[0];
  assert.ok(fn.includes('DEVICE_BASE'), '没有挡 Windows 设备名');
  assert.ok(/\[\. \]\+\$/.test(fn), '没有去尾随点/空格');
  assert.ok(fn.includes('replace(/^\\.+/, \'\')'), '没有去首部点');
});

/* P1-5 批量改后缀 */
t('P1 批量改后缀拒绝非法后缀字符', () => {
  const s = read('js/tools/file-tools.js');
  assert.ok(/新后缀不能包含/.test(s), '没有校验新后缀');
});
t('P1 批量改后缀正确处理无扩展名文件', () => {
  const s = read('js/tools/file-tools.js');
  assert.ok(s.includes('lastIndexOf(\'.\')'), '没有正确判断扩展名');
  assert.ok(s.includes('hasExt'), '没有区分有无扩展名');
  assert.ok(!/item\.path\.slice\(0, item\.path\.length - ext\.length\) \+ to/.test(s), '仍是旧拼接写法');
});

/* P1-6 批量操作失败可见 */
t('P1 批量改后缀失败时列出明细', () => {
  const s = read('js/tools/file-tools.js');
  assert.ok(s.includes('failures.push'), '没有收集失败明细');
  assert.ok(/alertBox\(\{[\s\S]{0,200}部分文件未能修改/.test(s), '没有弹失败明细');
});
t('P1 批量重命名失败时列出明细', () => {
  const s = read('js/tools/file-tools.js');
  assert.ok(/alertBox\(\{[\s\S]{0,200}部分文件未能重命名/.test(s), '没有弹失败明细');
});

/* P2-8 音频剪辑固定命名 */
t('P2 音频剪辑输出名唯一化', () => {
  const s = read('js/tools/media.js');
  assert.ok(/fs:unique-path', src\.replace\(\/\\\.\\w\+\$\/, '_cut\./.test(s), '音频剪辑没有唯一化');
});

/* P2-10 notes:pdf 原子写 */
t('P2 notes:pdf 用原子写', () => {
  const s = read('main.js');
  const i = s.indexOf("handle('notes:pdf'");
  const seg = s.slice(i, i + 1200);
  assert.ok(!/fs\.writeFileSync\(outFile/.test(seg), '仍是 writeFileSync 直写');
  assert.ok(seg.includes('writeFileAtomic'), '没有用原子写');
});

/* P2-11 GIF 残file */
t('P2 GIF 转码失败时清理残缺文件', () => {
  const s = read('main.js');
  const i = s.indexOf('let gifOut = null;');
  const seg = s.slice(i, i + 900);
  assert.ok(seg.includes('gifTarget'), '没有独立的 gif 目标变量');
  assert.ok(/rm\(gifTarget/.test(seg), '失败时没有删除残缺 gif');
});

/* P2 audio-cut 自我覆盖防护 */
t('P2 ffmpeg:audio-cut 拒绝输出等于输入', () => {
  const s = read('main.js');
  const i = s.indexOf("handle('ffmpeg:audio-cut'");
  const seg = s.slice(i, i + 700);
  assert.ok(seg.includes('输出文件不能与源文件相同'), '没有自我覆盖检查');
  assert.ok(seg.includes('checkOverwritable'), '没有覆盖闸门');
});

/* ================= 结构性检查：不允许重复注册 IPC 通道 ================= */
t('main.js 没有重复注册的 IPC 通道', () => {
  const s = read('main.js');
  const re = /handle\('([^']+)'/g;
  const seen = new Map();
  let m;
  while ((m = re.exec(s))) {
    const ch = m[1];
    const line = s.slice(0, m.index).split('\n').length;
    if (!seen.has(ch)) seen.set(ch, []);
    seen.get(ch).push(line);
  }
  const dups = [...seen.entries()].filter(([, v]) => v.length > 1);
  assert.deepStrictEqual(dups.map(([k, v]) => `${k}@${v.join(',')}`), [],
    '重复注册会让应用启动即报 "Attempted to register a second handler" 并卡死');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
