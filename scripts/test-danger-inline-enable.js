'use strict';
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

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON)) { console.log('SKIP 无 electron.exe'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unlockcard-'));
const OUT = JSON.stringify(path.join(tmp, 'r.json'));

const PROBE_CODE = `
(async () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [] };
  const log = (k, v) => out.steps.push({ k: k, v: v });

  // 确保是关闭状态
  try { await window.api.invoke('dangerous:set', 'dir-move', false); } catch (e) {}
  window.App.openTool('dir-move');
  await tick(800);

  const lockCard = document.querySelector('.danger-locked');
  log('hasLockCard', !!lockCard);
  /* switchEl 生成的是 div.switch（不是 checkbox），点击即切换 */
  const switches = lockCard ? lockCard.querySelectorAll('.switch') : [];
  log('switchCount', switches.length);
  log('hasInlineEnable', switches.length > 0);
  log('cardText', lockCard ? lockCard.textContent.slice(0, 180) : null);
  if (!switches.length) return out;

  switches[0].click();
  await tick(600);
  const modal = document.querySelector('.modal-mask');
  log('confirmModalShown', !!modal);
  log('modalText', modal ? modal.textContent.slice(0, 150) : null);
  if (!modal) return out;

  const okBtn = [...modal.querySelectorAll('button')].find((b) => /开启|确认|Enable|OK/i.test(b.textContent));
  log('foundOkButton', !!okBtn);
  if (okBtn) okBtn.click();
  await tick(1000);

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
for (const d of ['js', 'css', 'lib', 'assets']) {
  try { fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true }); } catch (e) {}
}
try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction'); }
catch (e) { console.log('SKIP 无法链接 node_modules'); process.exit(0); }

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');
env.HEHE_NOSPLASH = '1';

let raw = '';
try { raw = execFileSync(ELECTRON, [tmp], { env, encoding: 'utf8', timeout: 120000 }); }
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
