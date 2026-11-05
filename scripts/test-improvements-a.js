'use strict';
/* A 组改进的回归测试：文件夹展开 / 英文提示 / 滚轮守卫 / 参数记忆。
 *
 * ============ 为什么必须是 E2E ============
 * 这四项的共同点是「跑起来才知道对不对」：
 *   · 文件夹递归展开依赖真实 fs:stat / fs:list 的返回形状
 *   · 滚轮守卫依赖真实事件冒泡与 defaultPrevented
 *   · 参数记忆依赖渲染 → 事件 → 防抖写盘 → 再渲染的完整链路
 * 静态扫源码只能证明「写了这段代码」，证明不了它真的生效。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(ELECTRON_EXE)) {
  console.log('SKIP  无 electron.exe（CI 未安装 electron）');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimprove-'));

/* 造一棵真实目录树：两个顶层文件 + 一层子目录 */
const tree = path.join(tmp, 'photos');
fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
fs.writeFileSync(path.join(tree, 'a.txt'), 'a');
fs.writeFileSync(path.join(tree, 'b.txt'), 'b');
fs.writeFileSync(path.join(tree, 'sub', 'c.txt'), 'c');

/* 主进程桩：必须返回 {ok:true,data} 信封，否则每个工具页都停在初始化失败 */
fs.writeFileSync(path.join(tmp, 'probe.js'), `
const fs = require('fs');
const path = require('path');
const TREE = ${JSON.stringify(tree)};
let store = {};
module.exports = {
  'store:get': (e,k,d) => ({ ok:true, data: (k in store) ? store[k] : d }),
  'store:set': (e,k,v) => { store[k]=v; return { ok:true, data:true }; },
  'store:health': () => ({ ok:true, data:{ ok:true } }),
  'app:get-autostart': () => ({ ok:true, data:false }),
  'app:set-lang': () => ({ ok:true, data:true }),
  'app:set-accent': () => ({ ok:true, data:true }),
  'app:set-theme': () => ({ ok:true, data:true }),
  'dangerous:list': () => ({ ok:true, data:{} }),
  'dangerous:tool-caps': () => ({ ok:true, data:{} }),
  'update:cleanup': () => ({ ok:true, data:0 }),
  'sys:stats': () => ({ ok:true, data:{cpu:0,mem:0} }),
  'app:get-info': () => ({ ok:true, data:{appVersion:'0.4.0',electron:'43',chrome:'140',node:'22',
    v8:'14',username:'u',hostname:'h',userData:TREE,platform:'win32',isDev:false} }),
  'app:crash-info': () => ({ ok:true, data:{lastSessionCrashed:false,dir:'/x',count:0,totalBytes:0,latest:null} }),
  'fs:stat': (e,p) => { try { const st=fs.statSync(p);
      return {ok:true,data:{size:st.size,isDir:st.isDirectory(),mtime:st.mtimeMs}}; }
    catch(err){ return {ok:false,error:err.message}; } },
  'fs:list': (e,p) => { try {
      const ns = fs.readdirSync(p,{withFileTypes:true});
      const out = ns.map(d=>{ const full=path.join(p,d.name); let sz=0;
        try{sz=fs.statSync(full).size;}catch(x){}
        return {name:d.name,path:full,isDir:d.isDirectory(),size:sz,mtime:0}; });
      return {ok:true,data:out};
    } catch(err){ return {ok:false,error:err.message}; } },
  'fs:read-text': () => ({ ok:true, data:{content:'x'} }),
  'fs:mkdir': () => ({ ok:true, data:true })
};
`, 'utf8');

const PROBE = `(async function () {
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
  const out = { checks: [] };
  const chk = (n, ok, d) => out.checks.push({ n, ok: !!ok, d: d == null ? null : String(d) });

  // ---- A1: 文件夹递归展开 ----
  const ex = await window.ui.expandDroppedPaths([window.__TREE]);
  chk('A1 文件夹被递归展开', ex.files.length === 3, '展开出 ' + ex.files.length + ' 个');
  chk('A1 统计了目录数', ex.dirs >= 2, 'dirs=' + ex.dirs);
  const names = ex.files.map(f => f.split(/[\\\\/]/).pop()).sort().join(',');
  chk('A1 含子目录里的文件', names === 'a.txt,b.txt,c.txt', names);

  // 单个文件不该被"展开"或丢失
  const single = await window.ui.expandDroppedPaths([window.__TREEFILE]);
  chk('A1b 单个文件原样保留', single.files.length === 1 && single.dirs === 0);

  // 不存在的路径不该抛异常（拖入已删除的文件）
  let threw = false;
  try { await window.ui.expandDroppedPaths(['Z:/definitely-not-exist-xyz']); }
  catch (e) { threw = true; }
  chk('A1c 不存在的路径不抛异常', !threw);

  // ---- A2: 英文提示 ----
  // lang 是 app.js 的模块变量，页面外改不了；这里验证文案与样式就位，
  // 渲染条件由自动化测试的源码断言覆盖。
  const noteText = window.i18n.t('tool.bodyNotTranslated');
  chk('A2 英文提示文案已定义', !!(noteText && noteText.length), String(noteText).slice(0, 40));
  let hasStyle = false;
  for (const s of document.styleSheets) {
    try { if ([...s.cssRules].some(r => (r.selectorText || '').indexOf('.tool-i18n-note') >= 0)) { hasStyle = true; break; } }
    catch (e) {}
  }
  chk('A2 提示样式已定义', hasStyle);

  // ---- A4: 滚轮守卫 ----
  window.App.showView({ type: 'tool', toolId: 'img-compress' });
  await tick(700);
  const num = document.querySelector('input[type=number]');
  chk('A4 页面里有 number 输入框', !!num);
  if (num) {
    const before = num.value;
    num.blur();
    const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    num.dispatchEvent(ev);
    chk('A4 未聚焦时滚轮被拦截', ev.defaultPrevented);
    chk('A4 值未被滚轮改变', num.value === before, before + ' -> ' + num.value);
  }

  // ---- B6: 进度条剩余时间 ----
  const prog = window.ui.progressEl();
  chk('B6 progressEl 返回 el', !!prog.el);
  chk('B6 el 里含剩余时间节点', !!prog.el.querySelector('.progress-eta'));
  // 喂几次进度，让速率推算跑起来
  prog.set(0);
  await tick(120);
  prog.set(20);
  await tick(120);
  prog.set(50);
  await tick(60);
  const eta = prog.el.querySelector('.progress-eta');
  chk('B6 达到一定进度后显示剩余时间', !!eta && eta.style.display !== 'none',
    eta ? ('text=' + eta.textContent) : 'no node');
  chk('B6 剩余时间文案可读', !!eta && /约|即将/.test(eta.textContent), eta ? eta.textContent : '');

  /* ---- B6b: 同一个进度条跑第二轮时，ETA 必须复位 ----
   *
   * 【这条锁的是一个具体现象】
   * startedAt 原来只在为 0 时写入、之后再没人清零。于是同一个工具的
   * 进度条被复用两次时（点开始 → 跑完 → 再点开始），第二轮的 elapsed
   * 里含着上一轮的全部耗时，剩余时间整轮偏大：
   *   真跑 10 秒到 50% 应显示「约 10 秒」，实际按 130 秒算出「约 2 分钟」。
   * 进度越靠前偏得越狠，而用户完全无从判断它为什么这么慢。
   *
   * 【怎么构造这个场景才不依赖真实耗时】
   * 关键是让两轮之间有"明显的绝对时间差"，但每轮内部的速率一致：
   *   第一轮：立刻跑到 100%（记为完成）
   *   等 1.2 秒（这就是会污染第二轮的"上一轮耗时"）
   *   第二轮：连续喂三次，每次间隔相同 → 推算出的剩余时间应当与
   *           "单轮速率"一致（几十毫秒量级），而不是把 1.2 秒算进去。
   * 如果不复位，第二轮第一次 set 就带着 1.2s 的 elapsed，进度 20% 时
   * 会算出「约 5 秒」；复位后应是"即将完成"或个位数秒。
   * 所以判据取"是否小于 3 秒"：够宽松（不依赖机器快慢），
   * 又足以把"1.2 秒 × 5 倍 = 6 秒"那种污染区分开。 */
  const prog2 = window.ui.progressEl();
  const eta2 = prog2.el.querySelector('.progress-eta');
  prog2.set(0);
  prog2.set(50);
  prog2.set(100);            // 第一轮跑完
  await tick(1200);          // 期间不做任何事：这段空白不应进入第二轮的计时
  /* 【读取点必须在低进度，不能等到 set(30)】
   * 实测两版在 set(30) 会收敛到同一句"即将完成"：
   * 修复前 elapsed=1305ms / 30% → 剩 3.0 秒 → 被"< 5 秒显示即将完成"吃掉了。
   * 低进度才是差异最大的地方（10% 时修复前显示"约 11 秒"、修复后"即将完成"），
   * 因为污染量是固定的 1.2 秒，而分母越小放大倍数越大。
   * 所以三次取样停在 15%：修复后 elapsed≈90ms → 剩 0.5 秒 → 即将完成；
   * 修复前 elapsed≈1300ms → 剩 7.4 秒 → 「约 7 秒」。两者一眼可分。 */
  prog2.set(10);
  await tick(40);
  prog2.set(12);
  await tick(40);
  prog2.set(15);
  const txt = String(eta2.textContent || '');
  const mSec = /约 (\\d+) 秒/.exec(txt);
  const mMin = /约 (\\d+) 分钟/.exec(txt);
  const estSec = mMin ? Number(mMin[1]) * 60 : (mSec ? Number(mSec[1]) : 0);
  /* 前置：ETA 必须真的显示出来了。否则「estSec=0 秒」可能只是
   * 标签隐藏（textContent 为空）导致的恒真，断言就白写了。 */
  chk('B6b 第二轮确实有 ETA 文案（否则下面的秒数比较是恒真）',
    eta2.style.display !== 'none' && /即将完成|约/.test(txt), 'display=' + eta2.style.display + ' text=' + txt);
  chk('B6b 第二轮进度条的 ETA 不复用上一轮起点', estSec < 2,
    '显示「' + txt + '」→ 估 ' + estSec + ' 秒（把 1.2s 空白算进去会到 ~7s）');

  // ---- B2: 拖入文件夹时的样式类存在 ----
  let hasDirStyle = false;
  for (const sh of document.styleSheets) {
    try { if ([...sh.cssRules].some(r => (r.selectorText || '').indexOf('.dragover-dir') >= 0)) { hasDirStyle = true; break; } }
    catch (e) {}
  }
  chk('B2 拖入目录的区分样式已定义', hasDirStyle);
  // 拖拽区实例上应有 dragover 监听（通过 dropzone 构造后能加类来验证）
  const dz = window.ui.dropzone({ onFiles: () => {} });
  chk('B2 dropzone 可构造', !!dz && dz.classList.contains('dropzone'));

  // ---- B1: 参数记忆 ----
  const q = document.querySelector('input[type=number]');
  if (q) {
    q.value = '42';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    q.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await tick(900); // 等防抖写盘
  window.App.showView({ type: 'home' });
  await tick(300);
  window.App.showView({ type: 'tool', toolId: 'img-compress' });
  await tick(900);
  const q2 = document.querySelector('input[type=number]');
  chk('B1 参数被记住并回填', !!q2 && q2.value === '42', q2 ? ('恢复值=' + q2.value) : 'no input');

  /* ---- B1b: 多行正文（textarea）不进参数记忆 ----
   *
   * 【为什么这条值得单独测】
   * 参数记忆本来是为「质量 80、帧率 30、起始序号 1」这类小参数设计的。
   * textarea 装的是"这一次要处理的正文"：diff3 的三份原文、Markdown 笔记、
   * 粘贴的 JSON。它们动辄几十 KB，被记住的后果有三层：
   *   · hehe-data.json 被撑大 —— 它是整份 JSON 原子改名写的，
   *     越大越慢，断电时越容易写坏（写坏会走 .corrupt 备份那条路）；
   *   · 下次进同一个工具，输入框里自动填着上次那一大坨内容，
   *     用户还没开始就先被旧数据挡住，得先全选删掉；
   *   · 粘贴进来的可能是聊天记录/日志/密钥，存进一个明文配置里，
   *     用户完全不知道。
   * 判据用「store 里有没有 toolParams.<工具> 这个键」——
   * 直接看落盘结果，比看代码里有没有某行过滤更接近事实。 */
  const bigText = 'X'.repeat(4000);
  {
    /* 【选页面有讲究：textarea 的 placeholder 不能命中「不记」规则】
     * PARAM_SKIP_PLACEHOLDER 会过滤掉 placeholder 含「粘贴/输入文本/搜索」的控件 ——
     * 不少 textarea 正是这样被顺带排除的（例如 csv-json 的「粘贴 CSV 文本…」）。
     * 用那种页面测"textarea 不该被记"，即使把标签名过滤删掉也照样绿，
     * 因为别的规则已经挡住了 —— 断言等于没测到东西（这一条实测确认过）。
     *
     * 翻译工具的正文框 placeholder 是「输入要翻译的文本…」，
     * 不含任何被过滤的词，是**真会被记住**的那一类；
     * 同页还有两个语言下拉框，用来证明记忆机制本身是活的。 */
    window.App.showView({ type: 'tool', toolId: 'translate' });
    await tick(700);
    const tas = [...document.querySelectorAll('textarea')].filter((ta) => !ta.readOnly);
    chk('B1b 测试页有可编辑的 textarea（否则这条用例没意义）', tas.length > 0, '可编辑 textarea 数=' + tas.length);
    for (const ta of tas) {
      ta.value = bigText;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const sels = [...document.querySelectorAll('select')];
    chk('B1b 测试页有下拉框（用来证明记忆机制在跑）', sels.length > 0, 'select 数=' + sels.length);
    for (const sel of sels) {
      sel.value = sel.options[sel.options.length - 1].value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await tick(900);   // 等防抖写盘
    const saved = await window.api.invoke(window.Channels.CHANNELS.STORE.GET, 'toolParams.translate', null);
    const dump = JSON.stringify(saved == null ? {} : saved);
    /* 前置：短参数必须真的被记住。否则下面那些"正文没被记住"只是
     * 整页都没记（断言空转、永远绿）—— 这个空转真的发生过：
     * 换成 diff3 页时 store 一直是 null，而断言照样通过。 */
    chk('B1b 该页的下拉框仍被记住（证明记忆机制在跑）',
      dump.indexOf('select#') >= 0, 'store 里的 toolParams.translate = ' + dump.slice(0, 200));
    chk('B1b 多行正文没有被写进参数记忆', dump.indexOf('XXXX') < 0,
      'store 里出现了 4000 字的正文（dump 长度 ' + dump.length + '）');
  }

  /* ---- B1c: 短正文同样不进记忆（这条才真正锁住"按标签名排除"） ----
   *
   * 【为什么 B1b 不够】
   * 这里有**两道独立的闸**：① textarea 按标签名整体排除；
   * ② 单值超过 512 字直接不存（PARAM_MAX_LEN）。
   * B1b 喂的是 4000 字，两道闸都能拦住它 —— 实测把①删掉，B1b 依然绿。
   * 要证明①真的存在、没有被②顶替，必须喂一段**不触发②**的短正文：
   * 比如 20 个字符。这时只有"按标签名排除"能拦住它。
   * （一个防护被另一个更宽的防护遮住，是这类断言最常见的假绿来源。） */
  {
    window.App.showView({ type: 'tool', toolId: 'translate' });
    await tick(700);
    const ta = [...document.querySelectorAll('textarea')].find((x) => !x.readOnly);
    chk('B1c 找到可编辑 textarea', !!ta);
    if (ta) {
      /* 20 字，远小于 512 的上限；同时把下拉框也改一下，保证确实触发了写盘 */
      ta.value = 'SHORTTEXTMARKER-20ch';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      const sel2 = document.querySelector('select');
      if (sel2) {
        sel2.value = sel2.options[0].value;
        sel2.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await tick(900);
      const saved2 = await window.api.invoke(window.Channels.CHANNELS.STORE.GET, 'toolParams.translate', null);
      const dump2 = JSON.stringify(saved2 == null ? {} : saved2);
      chk('B1c 写盘确实发生了（否则下面的"没存"是空转）',
        dump2.indexOf('select#') >= 0, 'store = ' + dump2.slice(0, 200));
      chk('B1c 短正文也没进记忆（20 字，不触发长度闸）', dump2.indexOf('SHORTTEXTMARKER') < 0,
        'store 里出现了短正文：' + dump2.slice(0, 300) + ' ');
    }
  }

  return JSON.stringify(out);
})()`;

fs.writeFileSync(path.join(tmp, 'runner.js'), `
process.on('unhandledRejection', (e) => console.log('REJ ' + e));
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'), fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const PROBE = ${JSON.stringify(PROBE)};
const PROBE_FILE = ${JSON.stringify(path.join(tmp, 'probe.js'))};
const OUT = ${JSON.stringify(path.join(tmp, 'out.json'))};
const TREE = ${JSON.stringify(tree)};
const TREEFILE = ${JSON.stringify(path.join(tree, 'a.txt'))};

app.whenReady().then(async () => {
 try {
  const H = require(PROBE_FILE);
  for (const k of Object.keys(H)) ipcMain.handle(k, H[k]);
  const w = new BrowserWindow({ width: 1200, height: 860, show: false, useContentSize: true,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await w.loadFile(path.join(ROOT, 'index.html'));
  await new Promise(r => setTimeout(r, 1800));
  await w.webContents.executeJavaScript(
    'window.__TREE = ' + JSON.stringify(TREE) + '; window.__TREEFILE = ' + JSON.stringify(TREEFILE) + '; true', true);
  const raw = await w.webContents.executeJavaScript(PROBE, true);
  fs.writeFileSync(OUT, raw, 'utf8');
  console.log('A_DONE');
 } catch (e) { console.log('FATAL ' + (e && e.stack || e)); }
  setTimeout(() => app.exit(0), 200);
});
`, 'utf8');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');
env.HEHE_NOSPLASH = '1';

let raw = '';
try {
  raw = execFileSync(ELECTRON_EXE, [path.join(tmp, 'runner.js')], { env, encoding: 'utf8', timeout: 180000 });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

let out = null;
try { out = JSON.parse(fs.readFileSync(path.join(tmp, 'out.json'), 'utf8')); }
catch (e) {
  console.log('没拿到探测结果');
  console.log(raw.split(/\r?\n/).filter((l) => !/ERROR:net|WSALookup/.test(l)).join('\n').slice(-1200));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

let fail = 0;
for (const c of out.checks) {
  console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.n + (c.ok || c.d == null ? '' : '  -> ' + c.d));
  if (!c.ok) fail++;
}
console.log('\n结果: ' + (out.checks.length - fail) + ' 通过 / ' + fail + ' 失败');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
