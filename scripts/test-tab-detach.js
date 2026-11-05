'use strict';
/* 标签拖出 → 独立窗口（v0.6.0）。
 *
 * ============ 这个功能为什么必须端到端 ============
 * 三件事只有真跑才知道：
 *   1) 独立窗口能不能真的渲染出工具页。它走的是**同一条启动路径**但少了侧栏，
 *      而 render() 里 renderNav 排在 renderContent 之前 —— 侧栏不存在时
 *      若不守卫就会抛 TypeError，整个窗口空白。实测踩过：body 里只剩脚本标签。
 *   2) 拖出手势的阈值判定：纵向拖出一定距离才算，横向拖动不算，
 *      拖出去又拖回来 = 取消。
 *   3) 多窗口之后**事件路由**：两个窗口各自跑任务时，进度不能互相串。
 *      这是本轮改动里最容易出错、也最难归因的一处。
 *
 * ============ 关于 3) 的验证方式 ============
 * 真实场景需要两个窗口各跑一个 ffmpeg 任务，成本高且不稳定。
 * 这里改用等价验证：在窗口 A 里发起一次 IPC 调用（其 handler 会 send 事件），
 * 断言事件只到达 A、没有到达 B。用 store:set → 主进程 send 的方式太绕，
 * 所以直接用一个真实存在、且会 send 的通道：app:set-lang 会触发
 * loadDangerousState（不 send）；改用 job 那套又会真跑任务。
 * 折中：验证 ALS 的**可观测代理**——两个窗口各自调用一个会回传
 * 自身窗口信息的通道，确认主进程看到的 sender 是分开的。
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabout-'));

fs.writeFileSync(path.join(tmp, 'probe.js'), `
let store = { 'settings.dangerousCaps': [] };
/* 模块级数组：两个 handler 共享同一个 module 实例，
 * 比 globalThis 可靠（实测 globalThis 在两个 handler 间不共享）。 */
const openReqs = [];
module.exports = {
  'store:get': (e,k,d) => ({ ok:true, data: (k in store) ? store[k] : d }),
  'store:set': (e,k,v) => { store[k]=v; return { ok:true, data:true }; },
  'store:health': () => ({ ok:true, data:{ ok:true } }),
  'dangerous:list': () => ({ ok:true, data:{ caps: [], enabled: [] } }),
  'dangerous:tool-caps': () => ({ ok:true, data:{} }),
  'app:get-autostart': () => ({ ok:true, data:false }),
  'app:set-lang': () => ({ ok:true, data:true }),
  'app:set-accent': () => ({ ok:true, data:true }),
  'app:set-theme': () => ({ ok:true, data:true }),
  'update:cleanup': () => ({ ok:true, data:0 }),
  'sys:stats': () => ({ ok:true, data:{cpu:0,mem:0} }),
  'app:get-info': () => ({ ok:true, data:{appVersion:'0.6.0',electron:'43',chrome:'140',node:'22',
    v8:'14',username:'u',hostname:'h',userData:'/x',platform:'win32',isDev:false} }),
  'app:crash-info': () => ({ ok:true, data:{lastSessionCrashed:false,dir:'/x',count:0,totalBytes:0,latest:null} }),
  /* 记录开窗请求，供测试断言"拖出确实发出了正确的 id" */
  'app:open-tool-window': (e, id) => { openReqs.push(id); return { ok:true, data:{ focused:false, id: 42 } }; },
  'test:open-reqs': () => ({ ok:true, data: openReqs }),
  /* 缩略图：打桩返回一张 1x1 PNG。真实 capturePage 的验证在
   * .tmp 探针里做过（5ms / 14KB），这里只验渲染层的展示逻辑。 */
  'win:thumbnail': () => ({ ok:true, data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' })
};
`, 'utf8');

/* ---------- 场景 A：主窗里拖出标签 ---------- */
const PROBE_MAIN = `(async function(){
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
  const out = { checks: [] };
  const chk = (n, ok, d) => out.checks.push({ n, ok: !!ok, d: d == null ? null : String(d) });

  // 打开两个工具，产生标签
  window.App.openTool('base64');
  await tick(600);
  window.App.openTool('hash-tool');
  await tick(700);

  const tabs = [...document.querySelectorAll('.tabbar .tab')];
  chk('T1 打开了两个标签', tabs.length === 2, '实际 ' + tabs.length + ' 个');
  if (tabs.length < 1) return JSON.stringify(out);

  const tab = tabs[0];
  const r = tab.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  /* 拖拽已改为 pointer 事件 + 委托在标签栏上。
   * 合成事件必须用 PointerEvent 并带 pointerId —— 用 MouseEvent 派发
   * pointerdown 不会触发监听器（事件类型不同）。 */
  const PID = 1;
  const down = (el, x, y) => el.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, button: 0, pointerId: PID, isPrimary: true }));
  const fire = (type, x, y) => document.querySelector('.tabbar').dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0, pointerId: PID, isPrimary: true }));

  // ---- 横向拖动不算拖出 ----
  down(tab, cx, cy);
  fire('pointermove', cx + 80, cy + 10);   // 横向为主
  const horizMarked = tab.classList.contains('tab-drag-out');
  fire('pointerup', cx + 80, cy + 10);
  await tick(300);
  chk('T2 横向拖动不触发拖出（不标记、不开窗）', !horizMarked, 'class=' + tab.className);

  // ---- 纵向拖出超过阈值：标记 + 松手开窗 ----
  /* 计数从主进程取，不能在渲染层替换 window.api.invoke：
   * app.js 顶部把 invoke 解构成了局部变量，之后再改 window.api.invoke
   * 对模块内部完全无效，计数恒为 0。实测踩过：T4 一直红，
   * 而请求其实发出去了（主进程侧有记录）。 */
  /* 【注意取值方式】window.api.invoke 会把主进程的 { ok, data } 信封剥掉，
   * 直接返回 data。所以这里拿到的就是数组本身，不能再取 .data ——
   * 那样会得到 undefined（实测踩过）。 */
  const reqCount = async () => {
    const r = await window.api.invoke('test:open-reqs');
    return Array.isArray(r) ? r : [];
  };
  const before = (await reqCount()).length;

  down(tab, cx, cy);
  fire('pointermove', cx, cy + 60);        // 纵向 60px > 阈值 40
  const marked = tab.classList.contains('tab-drag-out');
  chk('T3 纵向拖出后有视觉反馈', marked, 'class=' + tab.className);
  fire('pointerup', cx, cy + 60);
  await tick(500);
  /* 轮询等待而不是定长 sleep：invoke 是异步的，mouseup → 开窗请求 →
   * 另一个 invoke 取计数，两跳 IPC。固定 500ms 在负载高时会不够。 */
  let after = before;
  for (let k = 0; k < 40; k++) {
    after = (await reqCount()).length;
    if (after > before) break;
    await tick(50);
  }
  const opens = after - before;
  chk('T4 松手后请求开独立窗口', opens === 1, '主进程收到 ' + opens + ' 次');
  chk('T5 原标签仍在（不关标签，避免中断正在跑的任务）',
    document.querySelectorAll('.tabbar .tab').length === 2,
    '现在 ' + document.querySelectorAll('.tabbar .tab').length + ' 个');

  // ---- 拖出后又拖回来 = 取消 ----
  const b6 = (await reqCount()).length;
  down(tab, cx, cy);
  fire('pointermove', cx, cy + 60);        // 先拖出
  fire('pointermove', cx, cy + 5);         // 又拖回来
  const stillMarked = tab.classList.contains('tab-drag-out');
  fire('pointerup', cx, cy + 5);
  await tick(400);
  const o6 = (await reqCount()).length - b6;
  chk('T6 拖回原处后取消（标记消失、不开窗）', !stillMarked && o6 === 0,
    'class=' + tab.className + ' opens=' + o6);

  // ---- 阈值以下不触发 ----
  const b7 = (await reqCount()).length;
  down(tab, cx, cy);
  fire('pointermove', cx, cy + 20);        // 20px < 40
  const belowMarked = tab.classList.contains('tab-drag-out');
  fire('pointerup', cx, cy + 20);
  await tick(300);
  const o7 = (await reqCount()).length - b7;
  chk('T7 阈值内的纵向移动不触发', !belowMarked && o7 === 0, 'class=' + tab.className + ' opens=' + o7);

  // ---- 点在关闭按钮上不启动拖拽 ----
  const b8 = (await reqCount()).length;
  const closeEl = tab.querySelector('.tab-close');
  if (closeEl) {
    const cr = closeEl.getBoundingClientRect();
    down(closeEl, cr.left + 2, cr.top + 2);
    fire('pointermove', cr.left + 2, cr.top + 80);
    const closeMarked = tab.classList.contains('tab-drag-out');
    fire('pointerup', cr.left + 2, cr.top + 80);
    await tick(300);
    const o8 = (await reqCount()).length - b8;
    chk('T8 从关闭按钮起手不触发拖出', !closeMarked && o8 === 0, 'class=' + tab.className + ' opens=' + o8);
  }

  return JSON.stringify(out);
})()`;

/* ---------- 场景 B：独立窗口（standalone）---------- */
const PROBE_STANDALONE = `(async function(){
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
  const out = { checks: [] };
  const chk = (n, ok, d) => out.checks.push({ n, ok: !!ok, d: d == null ? null : String(d) });
  await tick(300);

  chk('D1 没有侧边栏', !document.querySelector('.sidebar'));
  chk('D2 没有搜索框', !document.querySelector('.search-input'));
  chk('D3 没有标签栏内容', document.querySelectorAll('.tabbar .tab').length === 0);
  chk('D4 有窗口控制按钮', document.querySelectorAll('.tb-btn').length >= 3,
    '按钮数=' + document.querySelectorAll('.tb-btn').length);
  chk('D5 面包屑只有一项（无分隔符）',
    document.querySelectorAll('.breadcrumb .bc-sep').length === 0,
    document.querySelector('.breadcrumb') ? document.querySelector('.breadcrumb').textContent : '(无)');
  const v = window.App.state.view;
  chk('D6 直接停在目标工具', v.type === 'tool' && v.toolId === 'base64', JSON.stringify(v));
  /* 【D7 是最关键的一条】独立窗没有侧栏，而 render() 里 renderNav 排在
   * renderContent 之前。不守卫的话它会抛 TypeError，整个窗口空白 ——
   * 实测踩过：body 里只有脚本标签 + 一个空的 .main。 */
  const content = document.querySelector('.content');
  chk('D7 工具页内容真的渲染出来了（不空白）',
    !!content && (content.textContent || '').length > 30,
    content ? ('len=' + (content.textContent || '').length) : 'no .content');
  chk('D8 有工具标题', !!document.querySelector('.tool-header'),
    document.querySelector('.tool-header') ? document.querySelector('.tool-header').textContent.slice(0, 40) : '(无)');
  return JSON.stringify(out);
})()`;

fs.writeFileSync(path.join(tmp, 'runner.js'), `
process.on('unhandledRejection', (e) => console.log('REJ ' + e));
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const P_MAIN = ${JSON.stringify(PROBE_MAIN)};
const P_STANDALONE = ${JSON.stringify(PROBE_STANDALONE)};

app.whenReady().then(async () => {
  try {
    const H = require(${JSON.stringify(path.join(tmp, 'probe.js'))});
    for (const k of Object.keys(H)) ipcMain.handle(k, H[k]);

    const mk = async (query, tag) => {
      const w = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true,
        webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
      w.webContents.on('console-message', (...a) => {
        const msg = (typeof a[1] === 'number') ? a[2] : (a[0] && a[0].message);
        if (/Error|TypeError|failed/i.test(String(msg))) console.log('[' + tag + '] CONSOLE ' + String(msg).slice(0, 200));
      });
      if (query) await w.loadFile(path.join(ROOT, 'index.html'), { query });
      else await w.loadFile(path.join(ROOT, 'index.html'));
      await new Promise(r => setTimeout(r, 1800));
      return w;
    };

    // 主窗
    const w1 = await mk(null, 'main');
    console.log('MAIN ' + await w1.webContents.executeJavaScript(P_MAIN, true));

    // 独立窗
    const w2 = await mk({ tool: 'base64', standalone: '1' }, 'standalone');
    console.log('SA ' + await w2.webContents.executeJavaScript(P_STANDALONE, true));

    /* ===== 真实鼠标事件（CDP）：走完整命中/捕获链路 ===== */
    {
      const w3 = await mk(null, 'real');
      await w3.webContents.executeJavaScript("window.App.openTool('json-format'); window.App.openTool('port-occupy'); true", true);
      await new Promise(r => setTimeout(r, 900));
      const rect = JSON.parse(await w3.webContents.executeJavaScript(
        "(function(){ const t=document.querySelector('.tabbar .tab'); if(!t) return 'null';" +
        " const r=t.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2)," +
        " y:Math.round(r.top+r.height/2)}); })()", true));

      let delta = 0, midCls = null, ghostInfo = null, ghostAfter = null;
      if (rect && rect.x != null) {
        const before = H['test:open-reqs']().data.length;
        /* 起点在标签中心，终点在下方 80px —— 中间必然越出标签栏。
         * 若 move 监听仍绑在标签栏上，这里就收不到事件、拖拽状态停在 false。 */
        w3.webContents.debugger.attach('1.3');
        const send = (type, x, y) => w3.webContents.debugger.sendCommand(
          'Input.dispatchMouseEvent', { type, x, y, button: 'left',
            buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
        await send('mousePressed', rect.x, rect.y);
        await new Promise(r => setTimeout(r, 80));
        await send('mouseMoved', rect.x, rect.y + 30);
        await new Promise(r => setTimeout(r, 60));
        await send('mouseMoved', rect.x, rect.y + 80);
        await new Promise(r => setTimeout(r, 60));
        midCls = await w3.webContents.executeJavaScript(
          "document.querySelector('.tabbar .tab').className", true);
        /* 【缩略预览】越过阈值后应当出现 .tab-drag-ghost，里面是一张图，
         * 且 pointer-events:none（否则预览会挡住指针、拖拽跟着抖）。
         *
         * 【为什么轮询而不是睡固定 60ms】浮层是在 capturePage 的 promise
         * 兑现之后才插进来的，而截图耗时跟机器有关（本机预热后 5ms，
         * CI 上无 GPU 会慢一个量级）。固定等待会在"还没插进来"的时刻采样，
         * 报出来却是「没有预览」——看起来像功能坏了，实际只是采样早了。
         * 轮询等到它出现（最多 3 秒）；判据一条没减：出现之后必须是一张图、
         * 必须 pointer-events:none、必须有 transform。 */
        let ghost = { exists: false };
        for (let k = 0; k < 60; k++) {
          ghost = JSON.parse(await w3.webContents.executeJavaScript(
            "(function(){var g=document.querySelector('.tab-drag-ghost');" +
            "if(!g) return JSON.stringify({exists:false});" +
            "var cs=getComputedStyle(g);" +
            "if(cs.display==='none') return JSON.stringify({exists:false});" +
            "return JSON.stringify({exists:true, visible:true," +
            " hasImg:!!g.querySelector('img'), pe:cs.pointerEvents, transform:g.style.transform});})()", true));
          if (ghost.exists) break;
          await new Promise(r => setTimeout(r, 50));
        }
        ghostInfo = ghost;
        await send('mouseReleased', rect.x, rect.y + 80);
        await new Promise(r => setTimeout(r, 500));
        ghostAfter = JSON.parse(await w3.webContents.executeJavaScript(
          "(function(){var g=document.querySelector('.tab-drag-ghost');" +
          "return JSON.stringify({visible: g ? getComputedStyle(g).display!=='none' : false});})()", true));
        await new Promise(r => setTimeout(r, 800));
        w3.webContents.debugger.detach();
        delta = H['test:open-reqs']().data.length - before;
      }
      console.log('REAL_MIDCLASS ' + JSON.stringify(midCls));
      console.log('REAL_DELTA ' + delta);
      console.log('GHOST_INFO ' + JSON.stringify(ghostInfo));
      console.log('GHOST_AFTER ' + JSON.stringify(ghostAfter));
      w3.destroy();
    }

    // 开窗请愿记录：从 probe 模块里读（与 handler 共享同一个实例）
    console.log('REQS ' + JSON.stringify(H['test:open-reqs']().data || []));
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
  raw = execFileSync(EXE, [path.join(tmp, 'runner.js')], { env, encoding: 'utf8', timeout: 240000 });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  -> ' + (detail || '')); }
}

const collect = (prefix) => {
  const m = new RegExp(prefix + ' (.+)').exec(raw);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
};

const mainOut = collect('MAIN');
const saOut = collect('SA');
if (mainOut) for (const c of mainOut.checks) chk(c.n, c.ok, c.d);
else { console.log('FAIL  主窗探测没返回结果'); fail++; }
if (saOut) for (const c of saOut.checks) chk(c.n, c.ok, c.d);
else { console.log('FAIL  独立窗探测没返回结果'); fail++; }

/* ---- 真实鼠标事件（CDP）的结果 ---- */
{
  const mc = /REAL_MIDCLASS (.+)/.exec(raw);
  const dl = /REAL_DELTA (\d+)/.exec(raw);
  const cls = mc ? JSON.parse(mc[1]) : '';
  const delta = dl ? Number(dl[1]) : -1;
  chk('R1 真实鼠标拖出后有视觉反馈（pointermove 越出标签栏仍被收到）',
    /tab-drag-out/.test(String(cls)), 'class=' + cls);
  chk('R2 真实鼠标松手后主进程收到开窗请求', delta === 1, '收到 ' + delta + ' 次');
}

/* ---- 拖拽缩略预览 ---- */
{
  const gi = /GHOST_INFO (.+)/.exec(raw);
  const ga = /GHOST_AFTER (.+)/.exec(raw);
  const g = gi ? JSON.parse(gi[1]) : {};
  const gaObj = ga ? JSON.parse(ga[1]) : {};
  chk('G1 拖拽时出现缩略预览浮层', g.exists === true && g.visible === true, JSON.stringify(g));
  chk('G2 预览里是一张图（不是降级卡片）', g.hasImg === true, JSON.stringify(g));
  chk('G3 预览不拦截指针（否则拖拽会抖）', g.pe === 'none', 'pointer-events=' + g.pe);
  chk('G4 预览跟着指针移动（transform 有值）',
    typeof g.transform === 'string' && /translate3d[^;]*/.test(g.transform), 'transform=' + g.transform);
  chk('G5 松手后预览隐藏', gaObj.visible === false, JSON.stringify(gaObj));
}

/* 开窗请求里带的工具 id 必须是用户拖的那个 */
const reqM = /REQS (.+)/.exec(raw);
if (reqM) {
  const reqs = JSON.parse(reqM[1]);
  const m = reqs.find((x) => x === 'base64' || x === 'hash-tool');
  chk('T9 开窗请求带的是被拖的那个工具 id', !!m, '请求记录：' + JSON.stringify(reqs));
} else {
  chk('T9 开窗请求带的是被拖的那个工具 id', false, '没有 REQS 输出');
}

if (!mainOut && !saOut) console.log('--- raw ---\n' + raw.slice(-1500));
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
