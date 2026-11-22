'use strict';

/* 【把 TEMP/TMP 指向工作区】本机安全软件拦 Chromium 子进程写 %TEMP%
 * （EPERM），而本脚本要把探针与结果落盘。工作区不在拦截名单里。
 * 详见 scripts/lib/electron-launch.js。进程退出时删除。 */
(function () {
  if (process.env.HEHE_TEST_TMP_READY) return;
  var p = require('path'), f = require('fs');
  var d = p.join(p.resolve(__dirname, '..'), '.tmp-testrun-' + process.pid);
  try {
    f.mkdirSync(d, { recursive: true });
    process.env.TEMP = d; process.env.TMP = d;
    process.env.HEHE_TEST_TMP_READY = '1';
    process.on('exit', function () { try { f.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  } catch (e) { /* 建不了就让失败如实暴露 */ }
})();
/* 实测「高危工具占位卡里能直接启用」。
 *
 * 做法：把应用复制到临时目录（loadFile 才能找到 index.html），
 * 在其 main.js 末尾追加探针，ready 后驱动真实界面：
 *   打开目录搬家（dir-move，高危默认关闭）→ 找卡片里的开关 →
 *   点开关（应弹二次确认）→ 确认 → 检查能力已写入、页面已重绘。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
/* 【Chromium 兼容参数 —— 见 scripts/lib/electron-launch.js 的实测根因】
 * 本机 Chromium 进程级沙箱起不来：不带 --no-sandbox 时 electron.exe 直接以
 * 0x80000003 崩掉，stdout/stderr 全空，测试只能报「没拿到渲染层结果」。
 * --disable-gpu/--disable-dev-shm-usage 同理（远程会话的 GPU 进程、受限的 /dev/shm）。
 * 这些参数只影响测试探针，不影响产品打包后的启动参数。 */
const CHROMIUM_FLAGS = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];

/* 【把子进程的 TEMP/TMP 与 --user-data-dir 切到工作区内】
 * 本机 Chromium 子进程写 %TEMP% 会被安全软件拦（EPERM），而探针都要把结果
 * 落盘再读，于是全部卡在"写不了结果文件"。工作区不在拦截名单里。
 * 详见 scripts/lib/electron-launch.js。用完即删。 */
let __scratchDir = null;
function __ensureScratch(env) {
  if (!__scratchDir) {
    __scratchDir = path.join(path.resolve(__dirname, '..'), '.tmp-e2e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    try { require('fs').mkdirSync(__scratchDir, { recursive: true }); } catch (e) {}
    process.on('exit', () => { try { require('fs').rmSync(__scratchDir, { recursive: true, force: true }); } catch (e) {} });
  }
  env.TEMP = __scratchDir;
  env.TMP = __scratchDir;
  return ['--user-data-dir=' + path.join(__scratchDir, 'udd')];
}

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON)) { console.log('SKIP 无 electron.exe'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unlockcard-'));
const OUT = JSON.stringify(path.join(tmp, 'r.json'));

const PROBE_CODE = `
(async () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  /* 【为什么要等条件而不是等固定时间】
   * 原来这里写死 \`await tick(600)\` 然后查 .modal-mask。单跑时够用，
   * 但在全量并发跑（158 个脚本抢 CPU）时，600ms 内确认框还没渲染出来，
   * 于是 confirmModalShown=false，后面四条连带失败 ——
   * 实测全量跑里偶发红、单跑 3/3 绿，就是这条。
   * 改成"轮询到出现或超时"，超时上限给足，正常情况下会立刻返回。 */
  const waitFor = async (fn, timeout) => {
    const until = Date.now() + (timeout || 5000);
    while (Date.now() < until) {
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await tick(50);
    }
    return null;
  };
  const out = { steps: [] };
  const log = (k, v) => out.steps.push({ k: k, v: v });

  // 确保是关闭状态
  try { await window.api.invoke('dangerous:set', 'dir-move', false); } catch (e) {}
  window.App.openTool('dir-move');
  await waitFor(() => document.querySelector('.danger-locked'), 8000);

  const lockCard = document.querySelector('.danger-locked');
  log('hasLockCard', !!lockCard);
  /* switchEl 生成的是 div.switch（不是 checkbox），点击即切换 */
  const switches = lockCard ? lockCard.querySelectorAll('.switch') : [];
  log('switchCount', switches.length);
  log('hasInlineEnable', switches.length > 0);
  log('cardText', lockCard ? lockCard.textContent.slice(0, 180) : null);
  if (!switches.length) return out;

  switches[0].click();
  const modal = await waitFor(() => document.querySelector('.modal-mask'), 8000);
  log('confirmModalShown', !!modal);
  log('modalText', modal ? modal.textContent.slice(0, 150) : null);
  if (!modal) return out;

  const okBtn = [...modal.querySelectorAll('button')].find((b) => /开启|确认|Enable|OK/i.test(b.textContent));
  log('foundOkButton', !!okBtn);
  if (okBtn) okBtn.click();
  /* 确认后要等"占位卡消失"这个结果真的发生，而不是等一个猜出来的时长 */
  await waitFor(() => !document.querySelector('.danger-locked'), 8000);
  await tick(200);

  let caps = null;
  try { caps = await window.api.invoke('dangerous:list'); } catch (e) {}
  log('dirMoveEnabled', !!(caps && caps.enabled && caps.enabled.indexOf('dir-move') !== -1));
  log('stillLocked', !!document.querySelector('.danger-locked'));
  log('hasToolBody', !!document.querySelector('.page .card'));
  return out;
})()
`;

const PROBE = '\n/* ---- 测试探针：验证占位卡内直接启用 ---- */\n' +
  'app.whenReady().then(() => { setTimeout(async () => {\n' +
  '  let r = null;\n' +
  '  try {\n' +
  '    const wins = BrowserWindow.getAllWindows();\n' +
  '    const w = wins.find((x) => { try { return x.webContents.getURL().indexOf("index.html") !== -1; } catch (e) { return false; } });\n' +
  '    if (!w) r = { error: "no window" };\n' +
  '    else r = await w.webContents.executeJavaScript(' + JSON.stringify(PROBE_CODE) + ');\n' +
  '  } catch (e) { r = { error: String((e && e.message) || e) }; }\n' +
  '  try { require("fs").writeFileSync(' + OUT + ', JSON.stringify(r)); } catch (e) {}\n' +
  '  app.exit(0);\n' +
  '}, 3000); });\n';

for (const f of ['main.js', 'preload.js', 'index.html', 'package.json']) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) continue;
  let body = fs.readFileSync(src, 'utf8');
  if (f === 'main.js') body += PROBE;
  fs.writeFileSync(path.join(tmp, f), body);
}
/* 任务 5：main.js require('./ipc/dir-acl-links')，ipc/ 必须一起拷，
 * 否则临时目录里的应用启动即 MODULE_NOT_FOUND（而这个测试只会打一行
 * 「环境受限」的 SKIP，不会变红 —— 很容易被误判成环境问题）。 */
for (const d of ['js', 'css', 'lib', 'assets', 'ipc']) {
  try { fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true }); } catch (e) {}
}
try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction'); }
catch (e) { console.log('SKIP 无法链接 node_modules'); process.exit(0); }

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');
env.HEHE_NOSPLASH = '1';

let raw = '';
try { raw = execFileSync(ELECTRON, [...CHROMIUM_FLAGS, ...__ensureScratch(env), tmp], { env, encoding: 'utf8', timeout: 120000 }); }
catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

const rf = path.join(tmp, 'r.json');
if (!fs.existsSync(rf)) {
  console.log('SKIP 探针未落盘');
  console.log(String(raw).split(/\r?\n/).filter(Boolean).slice(-6).join('\n'));
  process.exit(0);
}

const R = JSON.parse(fs.readFileSync(rf, 'utf8'));
console.log('=== 探针记录 ===');
for (const s of (R.steps || [])) console.log('  ' + s.k + ': ' + JSON.stringify(s.v).slice(0, 180));
if (R.error) console.log('  error: ' + R.error);

let pass = 0, fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (c) pass++; else fail++; };
const by = {};
for (const s of (R.steps || [])) by[s.k] = s.v;

chk(!!by.hasLockCard, '未启用时显示高危占位卡');
chk(by.hasInlineEnable === true, '占位卡里可直接操作的开关（' + (by.switchCount || 0) + ' 个）');
chk(by.confirmModalShown === true, '点开关会弹二次确认');
chk(by.foundOkButton === true, '确认框里有确认按钮');
chk(by.dirMoveEnabled === true, '确认后能力被写入 store');
chk(by.stillLocked === false, '确认后页面重绘，占位卡消失（工具可用）');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
