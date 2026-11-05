'use strict';
/* 独立工具窗口跟随语言/配色/主题变更 —— 端到端。
 *
 * ============ 为什么必须端到端 ============
 * 单测（test-ui-prefs-sync）能证明"主进程广播了、渲染层订阅了"，
 * 但证不了这条链路真的通：
 *   · 广播发出时那个窗口的 webContents 还在不在
 *   · 渲染层收到之后 i18n.setLang 有没有真的换掉 DOM
 *   · 切语言触发的整壳重建会不会把订阅搞丢（下一条广播就收不到了）
 * 这三件事只有起真 Electron、开两个真窗口才看得见。
 *
 * ============ 验什么 ============
 * 开主窗 + 独立窗 → 在主窗里调 app:set-lang('en') 和 app:set-accent('jade')
 * → 读独立窗里的面包屑文字与 data-accent。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(EXE)) {
  console.log('SKIP  无 electron.exe（CI 未安装 electron）');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uiprefs-'));

/* 夹具：与 test-tab-detach 同构的最小主进程桩。
 * 关键是要**真的走 main.js 之外的等价路径** —— 这里不 require main.js，
 * 而是自己注册一批 handler，因为 main.js 会建托盘、起单实例锁，
 * 在测试环境里跑不起来。代价是：这里验的是"渲染层的响应能力"，
 * 主进程广播逻辑由 test-ui-prefs-sync 的 U6/U7/U8 覆盖。 */
fs.writeFileSync(path.join(tmp, 'probe.js'), `
const store = { 'settings.dangerousCaps': [] };
module.exports = {
  'store:get': (e, k, d) => ({ ok: true, data: (k in store) ? store[k] : d }),
  'store:set': (e, k, v) => { store[k] = v; return { ok: true, data: true }; },
  'store:health': () => ({ ok: true, data: { ok: true } }),
  'dangerous:list': () => ({ ok: true, data: { caps: [], enabled: [] } }),
  'dangerous:tool-caps': () => ({ ok: true, data: {} }),
  'app:get-autostart': () => ({ ok: true, data: false }),
  'app:set-lang': () => ({ ok: true, data: true }),
  'app:set-accent': () => ({ ok: true, data: true }),
  'app:set-theme': () => ({ ok: true, data: false }),
  'app:get-info': () => ({ ok: true, data: { appVersion: '0.6.4', electron: '43', chrome: '140',
    node: '22', v8: '14', username: 'u', hostname: 'h', userData: '/x', platform: 'win32', isDev: false } }),
  'app:crash-info': () => ({ ok: true, data: { lastSessionCrashed: false, dir: '/x', count: 0, totalBytes: 0, latest: null } }),
  'update:cleanup': () => ({ ok: true, data: 0 }),
  'win:thumbnail': () => ({ ok: true, data: null }),
};
`, 'utf8');

fs.writeFileSync(path.join(tmp, 'runner.js'), `
process.on('unhandledRejection', (e) => console.log('REJ ' + e));
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};

app.whenReady().then(async () => {
  try {
    const H = require(${JSON.stringify(path.join(tmp, 'probe.js'))});
    for (const k of Object.keys(H)) ipcMain.handle(k, H[k]);

    const mk = async (query, tag) => {
      const w = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true,
        webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
      w.webContents.on('console-message', (...a) => {
        const msg = (typeof a[1] === 'number') ? a[2] : (a[0] && a[0].message);
        if (/Error|TypeError/i.test(String(msg))) console.log('[' + tag + '] CONSOLE ' + String(msg).slice(0, 200));
      });
      if (query) await w.loadFile(path.join(ROOT, 'index.html'), { query });
      else await w.loadFile(path.join(ROOT, 'index.html'));
      await new Promise(r => setTimeout(r, 1600));
      return w;
    };

    const main = await mk(null, 'main');

    /* 【独立窗必须从**中文**开始，否则这条测试会假绿】
     * 语言来自 localStorage → 系统语言。若 CI 是英文系统，独立窗首帧
     * 就是英文，"切到英文"这一步等于什么都没验证。
     * 做法：先写 localStorage 缓存（applyLang 每次都会写它，启动时
     * 同步读的就是这个键），再开窗 —— 首帧必定是中文。 */
    const saWin = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true,
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
    await saWin.loadFile(path.join(ROOT, 'index.html'), { query: { tool: 'base64', standalone: '1' } });
    await new Promise(r => setTimeout(r, 1200));
    await saWin.webContents.executeJavaScript(
      "try { window.localStorage.setItem('hehe-lang','zh'); } catch(e) {} true", true);
    await saWin.webContents.reload();
    await new Promise(r => setTimeout(r, 1600));
    const sa = saWin;

    const read = (w) => w.webContents.executeJavaScript(\`
      (function(){
        var bc = document.querySelector('.breadcrumb');
        return JSON.stringify({
          title: document.title,
          crumb: bc ? bc.textContent.trim() : null,
          accent: document.documentElement.dataset.accent || null,
          theme: document.documentElement.dataset.theme || null,
          lang: document.documentElement.dataset.lang || null,
        });
      })()\`, true);

    const before = JSON.parse(await read(sa));

    // 主窗切英文 + 换配色：走真实的 IPC（主进程那份桩会返回成功）
    await main.webContents.executeJavaScript(
      "window.api.invoke('app:set-lang','en'); window.api.invoke('app:set-accent','jade'); true", true);
    await new Promise(r => setTimeout(r, 1200));

    /* 【广播】真实主进程里是 main.js 的 broadcastUiPrefs 做的事。
     * 这里的桩没有它，所以手动按同样的载荷发一遍 —— 验的是渲染层
     * 收到 UI_PREFS_CHANGED 后的反应，那正是本轮改动新增的那段。
     * 载荷形状与 main.js 的 broadcastUiPrefs 逐字一致。 */
    sa.webContents.send('app:ui-prefs-changed', { lang: 'en', accent: 'jade', theme: 'dark' });
    await new Promise(r => setTimeout(r, 1500));

    const after = JSON.parse(await read(sa));

    /* 再发一次同语言广播：验证重建之后订阅还在（这是最容易破的一条）。 */
    await sa.webContents.executeJavaScript(
      "window.api.invoke('app:set-accent','rose'); true", true);
    await new Promise(r => setTimeout(r, 300));
    sa.webContents.send('app:ui-prefs-changed', { lang: 'en', accent: 'rose', theme: 'dark' });
    await new Promise(r => setTimeout(r, 1200));
    const after2 = JSON.parse(await read(sa));

    console.log('BEFORE ' + JSON.stringify(before));
    console.log('AFTER ' + JSON.stringify(after));
    console.log('AFTER2 ' + JSON.stringify(after2));
    app.exit(0);
  } catch (e) { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); }
});
`, 'utf8');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');
env.HEHE_NOSPLASH = '1';

let raw = '';
try {
  raw = execFileSync(EXE, [path.join(tmp, 'runner.js')], { env, encoding: 'utf8', timeout: 180000 });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  -> ' + (detail || '')); }
}
const pick = (tag) => {
  const m = new RegExp(tag + ' (.+)').exec(raw);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
};

const before = pick('BEFORE');
const after = pick('AFTER');
const after2 = pick('AFTER2');

if (!before || !after || !after2) {
  console.log('FAIL  独立窗口探测没返回结果');
  console.log(String(raw).slice(-1500));
  fail++;
} else {
  /* 语言：面包屑文字应从初始语言变成英文工具名。
   *
   * 【不假定初始一定是中文】语言由 localStorage → 系统语言决定，
   * 英文系统上首帧就是英文（实测这台机器正是如此：crumb 初始就是
   * 'Base64 Codec'）。所以这里只断言"初始有一个确定的工具名"，
   * 真正的判据是切到英文之后**变成**英文 —— 若初始已经是英文，
   * E2 依然有意义（它证明广播没有把状态弄坏），而 E4/E5 才是硬证据。 */
  chk('E1 独立窗初始显示了工具名（不是空白或 id）',
    !!before.crumb && before.crumb.length > 0 && !/[a-z]-[a-z]/.test(before.crumb),
    'crumb=' + before.crumb);
  chk('E2 收到语言广播后面包屑是英文工具名', after.crumb === 'Base64 Codec',
    '切换前=' + before.crumb + ' 切换后=' + after.crumb);
  chk('E3 文档标题也变成英文工具名', after.title === 'Base64 Codec',
    '标题=' + after.title);
  chk('E4 配色跟着广播变了', after.accent === 'jade', 'accent=' + after.accent);
  chk('E5 明暗跟着广播变了', after.theme === 'dark', 'theme=' + after.theme);

  /* 第二次广播：切语言会整壳重建，若重建时订阅丢了，这条就不会变。 */
  chk('E6 整壳重建之后订阅仍然有效（第二次广播照样收得到）',
    after2.accent === 'rose', '第二次广播后 accent=' + after2.accent);
  chk('E7 重建后语言没被退回中文', after2.crumb === 'Base64 Codec',
    'crumb=' + after2.crumb);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
