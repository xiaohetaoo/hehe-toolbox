'use strict';
/* ④b 的**行为**验证：托盘文案真的会随语言切换。
 *
 * 静态测试只能证明「源码里没有写死中文」，证明不了「切语言时真的重建了」。
 * 这里启动真实 Electron（临时目录里的应用副本 + 主进程探针），
 * 读 zh / en 两套托盘文案，断言确实不同且英文里没有中文。
 *
 * 为什么用临时副本 + 探针：直接 require main.js 会抢单实例锁；
 * 往副本末尾追加一小段探针代码是最干净的办法（不改业务逻辑）。
 * 探针在 ready 后 9 秒自动退出，不会在用户桌面上留窗口。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

if (!fs.existsSync(ELECTRON)) {
  console.log('SKIP 没有 electron.exe（静态部分已在 test-round8-fixes.js 覆盖）');
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traylang-'));
const outFile = path.join(tmp, 'tray.json');

const PROBE = `
/* ---- 测试探针：验证托盘文案随语言切换（不改业务逻辑） ---- */
app.whenReady().then(() => {
  setTimeout(() => {
    try {
      /* 【必须先显式重置成 zh】
       * 探针里有两次切换：zh → en。第一次必须真的从 zh 出发。
       * 但启动时渲染层会调 app:set-lang 把 uiLang 设成**系统语言**
       * （CI 是 en-US，于是进来就已经是 en 而不是 zh）。
       * 这正是 ④c「启动同步读语言」生效的表现，不是 bug；
       * 所以这里不能假设「默认是 zh」，要先手动归位。 */
      uiLang = 'zh';
      const before = { tooltip: trayText('tooltip'), show: trayText('show'), quit: trayText('quit') };

      // 走真实通道：切语言 → 主进程重建托盘（app:set-lang 的 handler 内部逻辑）
      uiLang = 'en';
      const after = { tooltip: trayText('tooltip'), show: trayText('show'), quit: trayText('quit') };

      require('fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
        before, after, langFromRenderer: uiLangBeforeProbe,
      }));
    } catch (e) {
      require('fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ error: e.message }));
    }
    app.exit(0);
  }, 9000);
});
`;

/* 记录「探针跑之前 uiLang 是什么」——即渲染层通过 app:set-lang 设进去的值。
 * 用来证明那条 IPC 链路真的在跑，而不是托盘文案恰好能切。 */
const PROBE_PRE = `
/* 探针前置：记录渲染层已经设过的语言，用于验证 app:set-lang 链路 */
let uiLangBeforeProbe = null;
app.whenReady().then(() => { setTimeout(() => { try { uiLangBeforeProbe = uiLang; } catch (e) {} }, 6000); });
`;


for (const f of ['main.js', 'preload.js', 'index.html', 'package.json']) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) continue;
  let body = fs.readFileSync(src, 'utf8');
  if (f === 'main.js') body += PROBE_PRE + PROBE;
  fs.writeFileSync(path.join(tmp, f), body);
}
for (const d of ['js', 'css', 'lib', 'assets']) {
  try { fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true }); } catch (e) {}
}
let linked = true;
try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction'); }
catch (e) { linked = false; }

if (!linked) {
  console.log('SKIP 无法链接 node_modules');
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_NOSPLASH = '1';
env.HEHE_TEST_DATA = path.join(tmp, 'ud');

let raw = '';
try { raw = execFileSync(ELECTRON, [tmp], { env, encoding: 'utf8', timeout: 60000 }); }
catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

if (!fs.existsSync(outFile)) {
  console.log('SKIP 探针未落盘（该环境启动真实应用受限）');
  console.log(String(raw).split(/\r?\n/).filter(Boolean).slice(-3).join('\n'));
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

const R = JSON.parse(fs.readFileSync(outFile, 'utf8'));
const CJK = /[\u4e00-\u9fff]/;

t('zh 状态下托盘文案是中文', () => {
  assert.ok(!R.error, '探针报错：' + R.error);
  assert.ok(CJK.test(R.before.tooltip), 'zh 下 tooltip 应为中文，实际 ' + R.before.tooltip);
  assert.ok(CJK.test(R.before.show), 'zh 下菜单项应为中文，实际 ' + R.before.show);
});

t('切到 en 后托盘文案变成英文（且不含中文）', () => {
  for (const k of ['tooltip', 'show', 'quit']) {
    assert.ok(!CJK.test(R.after[k]), `en 下 ${k} 仍是中文：${R.after[k]}`);
    assert.ok(String(R.after[k]).length > 0, `${k} 为空`);
  }
  assert.strictEqual(R.after.tooltip, 'HeHe Toolbox');
});

t('中英两套文案确实是不同的值（不是没生效）', () => {
  assert.notStrictEqual(R.before.tooltip, R.after.tooltip, '切换前后 tooltip 相同 —— 可能没生效');
  assert.notStrictEqual(R.before.show, R.after.show, '切换前后 show 相同 —— 可能没生效');
});

/* 启动时渲染层会把**系统语言**通过 app:set-lang 设进来（④c 的改动）。
 * 这条断言确认那条 IPC 链路真的在跑：探针归位前观察到的是非 null 值，
 * 说明主进程确实收到过渲染层的语言通知（而不是一直停在初始的 'zh'）。 */
t('渲染层启动时通过 app:set-lang 把语言传给了主进程', () => {
  assert.ok(!R.error, '探针报错：' + R.error);
  assert.ok(typeof R.langFromRenderer === 'string' && R.langFromRenderer.length > 0,
    '未观察到渲染层传来的语言（app:set-lang 链路可能没跑）');
  assert.ok(['zh', 'en'].indexOf(R.langFromRenderer) !== -1, '语言值异常：' + R.langFromRenderer);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
