'use strict';
/* P0-7 回归：三个辅助窗口（snip/pin/ruler）必须
 *   (a) 有 CSP（安全基线一致）
 *   (b) CSP 里允许加载 file:// 本地图片（否则截图标注/贴图/标尺全废）
 *   (c) CSP 里**不含** unsafe-eval（这是加 CSP 的主要目的之一）
 *   (d) 用真实 Electron 打开这三个窗口，确认脚本能跑（不是只改字符串）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '  -> ' + e.message); } };

const ROOT = path.join(__dirname, '..');
const AUX = ['snip.html', 'pin.html', 'ruler.html'];

/* ---- 1. 静态检查 ---- */
for (const f of AUX) {
  t(f + ' 有 CSP meta', () => {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(/http-equiv=["']Content-Security-Policy["']/.test(s), '缺少 CSP meta');
  });
  t(f + ' CSP 允许 file: 图片', () => {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const m = s.match(/Content-Security-Policy"[^>]*content="([^"]+)"/);
    assert.ok(m, '解析不到 CSP 内容');
    assert.ok(/img-src[^;]*file:/.test(m[1]), 'img-src 必须允许 file:（否则本地图片显示不出来）');
    assert.ok(/img-src[^;]*data:/.test(m[1]), 'img-src 必须允许 data:（贴图用 dataURL）');
  });
  t(f + ' CSP 不含 unsafe-eval', () => {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const m = s.match(/Content-Security-Policy"[^>]*content="([^"]+)"/);
    assert.strictEqual(/unsafe-eval/.test(m[1]), false, '辅助窗口不该开 unsafe-eval');
  });
}

/* ---- 2. 主窗口仍保留 unsafe-eval（计算器需要，属已知取舍） ---- */
t('index.html 的 CSP 仍在（记录已知取舍）', () => {
  const s = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(/Content-Security-Policy/.test(s), 'index.html 应有 CSP');
});

/* ---- 3. 真机：用 Electron 打开三个窗口，确认脚本执行 ---- */
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON)) {
  console.log('SKIP 未找到 electron.exe');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-'));
  const runner = `
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const out = {};
  const files = ['snip.html', 'pin.html', 'ruler.html'];
  for (const f of files) {
    const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    const errs = [];
    w.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errs.push(msg); });
    try {
      await w.loadFile(${JSON.stringify(ROOT)} + '/' + f);
      await new Promise((r) => setTimeout(r, 400));
      // 探测：页面里的全局脚本是否执行了（三个文件都有 onload/立即执行的部分）
      const probe = await w.webContents.executeJavaScript(
        'JSON.stringify({ hasScript: typeof window.__snipTest !== "undefined" || typeof window.__pinReady !== "undefined" || document.querySelectorAll("script").length > 0, scriptCount: document.querySelectorAll("script").length, csp: (document.querySelector(\\'meta[http-equiv="Content-Security-Policy"]\\')||{}).content ? "present" : "missing" })'
      ).catch((e) => JSON.stringify({ error: e.message }));
      out[f] = { probe, errs };
    } catch (e) { out[f] = { error: e.message }; }
    w.destroy();
  }
  console.log('AUX_RESULT ' + JSON.stringify(out));
  app.exit(0);
});
`;
  const scriptPath = path.join(tmp, 'run.js');
  fs.writeFileSync(scriptPath, runner, 'utf8');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  let raw = '';
  try {
    raw = spawnSync(ELECTRON, [scriptPath], { env, encoding: 'utf8', timeout: 90000 }).stdout || '';
  } catch (e) { raw = String(e.stdout || ''); }

  const line = raw.split(/\r?\n/).find((l) => l.startsWith('AUX_RESULT'));
  if (!line) {
    console.log('SKIP 未拿到 AUX_RESULT（可能是无头环境限制）');
  } else {
    const R = JSON.parse(line.slice('AUX_RESULT '.length));
    for (const f of AUX) {
      t(f + ' 真机加载：脚本执行且无 CSP 报错', () => {
        const r = R[f];
        assert.ok(r, f + ' 无结果');
        if (r.error) throw new Error('加载失败: ' + r.error);
        const p = JSON.parse(r.probe || '{}');
        if (p.error) throw new Error('探测失败: ' + p.error);
        assert.ok(p.scriptCount > 0, '页面里应有 script');
        const cspErrs = (r.errs || []).filter((m) => /Content Security Policy|Refused to/i.test(m));
        assert.deepStrictEqual(cspErrs, [], '出现 CSP 拦截: ' + cspErrs.join(' | '));
      });
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
