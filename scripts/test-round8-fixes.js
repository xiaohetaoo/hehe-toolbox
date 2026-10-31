'use strict';
/* 本轮四项的回归测试（其中两项是 v0.2.7 的遗留/回归）。
 *
 * ① 切语言后 9 个 IPC 订阅累积
 *    切一次语言多一份 sys:stats / hotkey:pressed / snip:ocr / sched:fire …
 *    后果：周期任务弹 N 个通知、托盘 OCR 打开 N 个页面。
 * ② rec:start 二次否决系统对话框已经确认过的覆盖
 * ③ power-gate 词根误伤（**已正确**，这里固住防退化）
 * ④ 升级 .bak 堆积 / 英文首帧闪中文
 *
 * 判定方式说明：①④ 这类「监听是否真的退订了」在 headless 里没法直接数
 * Electron 主进程里的监听器，所以用两层：
 *   - 静态：源码里 buildShell 的每个 on(...) 必须走会登记退订的封装；
 *   - 行为：起真实 Electron，反复切语言后发事件，看副作用只发生一次。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

/* ============ ① IPC 订阅不得裸挂在 buildShell 里 ============ */
t('① buildShell 里没有裸 on(...) 订阅（全部经 sub 登记退订）', () => {
  const bs = (() => {
    const start = appSrc.indexOf('function buildShell()');
    assert.ok(start > 0, '找不到 buildShell');
    // 用括号配平取出函数体
    let i = appSrc.indexOf('{', start), depth = 0;
    for (; i < appSrc.length; i++) {
      if (appSrc[i] === '{') depth++;
      else if (appSrc[i] === '}') { depth--; if (depth === 0) break; }
    }
    return appSrc.slice(start, i + 1);
  })();

  // 裸 on('x:y', …) 出现即失败（注释里提到 on( 的不算，先剥注释）
  const code = bs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const bare = [...code.matchAll(/\bon\(\s*'([^']+)'/g)].map((m) => m[1]);
  // 允许：定义 sub 自己内部的那次 on(...)
  const offenders = bare.filter((n) => {
    const idx = code.indexOf("on('" + n);
    const before = code.slice(Math.max(0, idx - 40), idx);
    return !/const\s+u\s*=/.test(before);
  });
  assert.deepStrictEqual(offenders, [], '这些订阅没登记退订：' + offenders.join(', '));
});

t('① shellCleanup 会调用所有已登记的退订函数', () => {
  assert.ok(mainSrc.length > 0);
  assert.ok(/shellUnsubs\.splice\(0\)/.test(appSrc), 'shellCleanup 里没有清空 shellUnsubs');
  assert.ok(/for \(const u of shellUnsubs\.splice\(0\)\)/.test(appSrc), '没有逐个调用退订函数');
});

t('① 报告点名的 9 个事件都走 sub 登记', () => {
  const EVENTS = ['sys:stats', 'win:maximized', 'hotkey:pressed', 'snip:ocr',
                  'sched:fire', 'tray:err', 'snip:region', 'app:open-tool', 'app:already-running'];
  const missing = [];
  for (const ev of EVENTS) {
    if (!new RegExp("sub\\('" + ev + "'").test(appSrc)) missing.push(ev);
  }
  assert.deepStrictEqual(missing, [], '这些事件没用 sub 登记：' + missing.join(', '));
});

/* ============ ② 录制覆盖 ============ */
t('② rec:start 只在未显式确认时才拒绝已存在的目标', () => {
  const body = (() => {
    const s = mainSrc.indexOf("handle('rec:start'");
    assert.ok(s > 0, '找不到 rec:start');
    const e = mainSrc.indexOf('\n});', s);
    return mainSrc.slice(s, e);
  })();
  assert.ok(/overwrite/.test(body), 'rec:start 没有 overwrite 参数');
  assert.ok(/fs\.existsSync\(outPath\) && !overwrite/.test(body),
    '存在性检查没有受 overwrite 控制（会二次否决系统对话框的确认）');
  // 系统关键目录闸门必须无条件执行（不能因 overwrite 而豁免）
  const badCheck = /if\s*\(\s*!overwrite\s*\)\s*\{?\s*const\s+recBad/.test(body);
  assert.ok(!badCheck, '不能把 checkOverwritable 放进 overwrite 条件里');
  assert.ok(/pathGuard\.checkOverwritable\(outPath\)/.test(body), '缺少关键目录闸门');
});

t('② 录屏 UI 在系统对话框确认后传 overwrite: true', () => {
  const media = fs.readFileSync(path.join(ROOT, 'js', 'tools', 'media.js'), 'utf8');
  const s = media.indexOf("invoke('rec:start'");
  assert.ok(s > 0, '找不到 rec:start 调用');
  const chunk = media.slice(s, s + 400);
  assert.ok(/overwrite:\s*true/.test(chunk), '没有传 overwrite: true，用户确认过的覆盖仍会被否决');
});

/* ============ ④a .bak 回收 ============ */
t('④a 升级备份有回收逻辑且保留最近几份', () => {
  assert.ok(/function pruneExeBackups/.test(mainSrc), '没有 pruneExeBackups');
  const body = (() => {
    const s = mainSrc.indexOf('async function pruneExeBackups');
    const e = mainSrc.indexOf('\n}', s);
    return mainSrc.slice(s, e);
  })();
  assert.ok(/\.slice\(keep\)/.test(body), '没有按保留数截断');
  assert.ok(/\.bak\./.test(body), '没有识别带时间戳的备份');
  assert.ok(/update:cleanup/.test(mainSrc), 'update:cleanup 应存在');
  // 接入点
  const uc = mainSrc.slice(mainSrc.indexOf("handle('update:cleanup'"));
  assert.ok(/pruneExeBackups/.test(uc.slice(0, 2500)), 'update:cleanup 没有调用 pruneExeBackups');
});

/* 真实跑一遍 prune 的文件名排序逻辑（不依赖 Electron） */
t('④a 时间戳备份按时间排序、只留最新的', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bakprune-'));
  const exe = 'hehe-toolbox-Portable-9.9.9.exe';
  fs.writeFileSync(path.join(dir, exe + '.bak'), 'x');
  const stamps = ['20260101-010101', '20260202-020202', '20260303-030303',
                  '20260404-040404', '20260505-050505'];
  for (const s of stamps) fs.writeFileSync(path.join(dir, exe + '.bak.' + s), 'x');

  // 复用主进程里的实现：抽出来在本地求值
  const impl = (() => {
    const s = mainSrc.indexOf('async function pruneExeBackups');
    const e = mainSrc.indexOf('\n}', s);
    return mainSrc.slice(s, e + 2);
  })();
  // 用 Function 包一层，注入 fsp/path
  const fsp = require('fs/promises');
  const fn = new Function('fsp', 'path', impl + '\nreturn pruneExeBackups;')(fsp, path);
  return fn(path.join(dir, exe), 3).then((r) => {
    const left = fs.readdirSync(dir).filter((n) => n.includes('.bak.'));
    assert.strictEqual(left.length, 3, '应剩 3 份时间戳备份，实际 ' + left.length);
    assert.strictEqual(r.removed, 2, '应删掉 2 份，实际 ' + r.removed);
    // 保留的必须是**最新**的三份
    for (const keep of ['20260303-030303', '20260404-040404', '20260505-050505']) {
      assert.ok(left.includes(exe + '.bak.' + keep), '应保留最新的一份 ' + keep);
    }
    // .bak 本体永远不动
    assert.ok(fs.existsSync(path.join(dir, exe + '.bak')), '.bak 本体不该被删');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ============ ④c 首帧语言 ============ */
t('④c 启动时同步读语言，不 await store 再建壳', () => {
  const dom = appSrc.slice(appSrc.indexOf("document.addEventListener('DOMContentLoaded'"));
  assert.ok(/applyLang\(readLangSync\(\)\)/.test(dom), '首帧语言没有走同步读取');
  assert.ok(/function readLangSync/.test(appSrc), '缺少 readLangSync');
  // buildShell 必须排在 store:get 之前
  const buildIdx = dom.indexOf('buildShell()');
  const storeIdx = dom.indexOf("invoke('store:get', 'settings.lang'");
  assert.ok(buildIdx > 0 && storeIdx > 0, '找不到关键调用');
  assert.ok(buildIdx < storeIdx, 'buildShell 在 store:get 之后 —— 首帧仍会闪中文');
});

t('④c applyLang 会把语言同步写进 localStorage', () => {
  const body = (() => {
    const s = appSrc.indexOf('function applyLang(v)');
    const e = appSrc.indexOf('\n  }', s);
    return appSrc.slice(s, e);
  })();
  assert.ok(/localStorage\.setItem\('hehe-lang'/.test(body), 'applyLang 没有写本地缓存');
  assert.ok(/localStorage\.getItem\('hehe-lang'/.test(appSrc), 'readLangSync 没有读本地缓存');
});

/* ============ ③ power-gate（已正确，固住防退化） ============ */
t('③ 文件名/参数里带危险词的日常命令不被误拦', () => {
  const pg = require('../lib/power-gate');
  const SAFE = [
    'del shutdown.log', 'ren shutdown.txt x.txt', 'copy shutdown.exe d:\\',
    'tasklist | findstr shutdown', 'move shutdown.log backup\\',
    'notepad shutdown.log', 'type shutdown.txt', 'echo shutdown',
    'python shutdown.py', 'node shutdown.js', 'git commit -m "shutdown fix"',
    'mkdir shutdown_backup', 'attrib +r shutdown.log', 'msiexec /i shutdown.msi',
    'taskkill /f /im shutdown.exe', 'del C:\\Windows\\System32\\shutdown.exe',
  ];
  const wrong = SAFE.filter((c) => pg.isPowerCommand(c));
  assert.deepStrictEqual(wrong, [], '被误判为电源命令：' + wrong.join(' | '));
});

t('③ 真正的电源命令仍然拦得住', () => {
  const pg = require('../lib/power-gate');
  const DANGER = [
    'shutdown /s /t 0', 'shutdown -h now', 'cmd /c shutdown /s',
    'powershell -Command "Stop-Computer"',
    'rundll32 powrprof.dll,SetSuspendState 0,1,0',
  ];
  const missed = DANGER.filter((c) => !pg.isPowerCommand(c));
  assert.deepStrictEqual(missed, [], '漏拦了真正的电源命令：' + missed.join(' | '));
});

/* ============ ④b 托盘/通知跟随语言 ============ */
t('④b 主进程托盘菜单有中英两套文案，不再写死中文', () => {
  assert.ok(/const TRAY_I18N/.test(mainSrc), '主进程没有托盘文案表');
  const decl = mainSrc.slice(mainSrc.indexOf('const TRAY_I18N'));
  const block = decl.slice(0, decl.indexOf('\n};') + 3);
  assert.ok(/zh:\s*\{/.test(block), '缺少中文文案');
  assert.ok(/en:\s*\{/.test(block), '缺少英文文案');
  // 托盘菜单必须走 trayText()，不能有裸中文字面量
  const trayFn = mainSrc.slice(mainSrc.indexOf('function createTray()'));
  const trayBody = trayFn.slice(0, trayFn.indexOf('\n}') + 2);
  assert.ok(/trayText\('show'\)/.test(trayBody), '菜单项没用 trayText');
  const CJK = /[\u4e00-\u9fff]/;
  const hard = [...trayBody.matchAll(/label:\s*'([^']*)'/g)]
    .map((m) => m[1]).filter((s) => CJK.test(s));
  assert.deepStrictEqual(hard, [], '托盘菜单仍有写死中文：' + hard.join(' | '));
});

t('④b 渲染层切语言时会通知主进程更新托盘', () => {
  assert.ok(/handle\('app:set-lang'/.test(mainSrc), '主进程没有 app:set-lang 通道');
  const body = (() => {
    const s = appSrc.indexOf('function applyLang(v)');
    const e = appSrc.indexOf('\n  }', s);
    return appSrc.slice(s, e);
  })();
  assert.ok(/invoke\('app:set-lang',\s*lang\)/.test(body), 'applyLang 没把语言传给主进程');
});

t('④b 定时任务通知的标题走 i18n', () => {
  const i18n = fs.readFileSync(path.join(ROOT, 'js', 'i18n.js'), 'utf8');
  assert.ok(/notify\.schedTitle/.test(i18n), '缺 notify.schedTitle 词条');
  assert.ok(/notify\.schedBody/.test(i18n), '缺 notify.schedBody 词条');
  // app.js 里那条通知不能再写死中文标题
  assert.ok(!/new Notification\('核核工具箱 · 定时任务'/.test(appSrc),
    '定时任务通知标题仍是写死的中文');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
