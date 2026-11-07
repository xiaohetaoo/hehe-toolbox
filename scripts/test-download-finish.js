'use strict';
/* 下载器的收尾：invoke 失败后界面必须回到可用状态。
 *
 * ============ 锁的是哪个回归 ============
 * js/tools/net-tools.js 的 start() 在
 *   prog.show(); status='连接中…'; startBtn.disabled=true;
 * 之后是**裸 await invoke(NET.DOWNLOAD, …)**，没有 try/catch/finally。
 *
 * 主进程有两条抛错路径（都在 net:download 里）：
 *   · 保存路径命中 pathGuard.checkOverwritable（选到系统关键目录）
 *   · fs.existsSync(out) 为真（目标已存在）
 * 第二条在"保存路径留空"时极易命中：out 由 URL 推导，同一个 URL 下第二次
 * 必然撞上。于是用户看到的是：
 *   状态永远停在「连接中…」、开始按钮永久置灰、取消按钮因为 jobId 还是
 *   null 而完全无效、job:stream 的订阅泄漏到下一次进页面。
 *
 * ============ 验证方式 ============
 * 把 start() 的真实现从源码里抽出来跑（不手写副本 —— 副本会与实现分叉），
 * 给它一组桩：invoke 的 NET.DOWNLOAD 直接 reject，其余按需返回。
 * 然后断言 finally 把按钮/进度/订阅都还回去了。
 * 这样测的是"抛错之后会怎样"，正是回归所在。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

const src = readSrc('js/tools/net-tools.js');

/* 把 start() 函数体抠出来求值。它依赖的外层变量（urlIn/fileIn/prog/status/
 * startBtn/stopBtn/jobId/unsub/pageDead/invoke/toast/JobPrefix/Channels）
 * 全部在 wrapper 里以参数或闭包变量的形式提供。 */
function extractStart() {
  /* 【必须先定位到 downloader 那一段再找 start】
   * 这个文件里有多个工具各有自己的 start()（Ping 也是），
   * 直接 indexOf('async function start()') 会抓到 Ping 那个 ——
   * 于是断言测的是另一个工具，下载器的回归完全没被覆盖（假绿）。 */
  const dl = src.indexOf("id: 'downloader'");
  assert.ok(dl > 0, '找不到 downloader 注册块');
  const i = src.indexOf('async function start() {', dl);
  assert.ok(i > dl, '找不到 downloader 的 start()');
  /* 花括号配平，取到函数结束 */
  let depth = 0, end = -1;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  assert.ok(end > i, 'start() 花括号不配平');
  return src.slice(i, end);
}

/* 最小 DOM / 依赖桩 */
function makeStub() {
  const calls = { kill: [], download: [], subscribe: [], unsub: 0, toast: [] };
  const el = () => ({ value: '', disabled: false, textContent: '', show() {}, hide() {}, set() {} });
  const urlIn = el(); urlIn.value = 'https://example.com/a.bin';
  const fileIn = el(); fileIn.value = '';            // 留空 -> 走"由 URL 推导"那条最易撞的路径
  const prog = el();
  const status = el();
  const startBtn = el();
  const stopBtn = el();

  const invoke = (ch, ...args) => {
    if (ch === 'net:download') { calls.download.push(args); return Promise.reject(new Error('目标文件已存在')); }
    if (ch === 'job:kill') { calls.kill.push(args[0]); return Promise.resolve(true); }
    if (ch === 'app:get-info') return Promise.resolve({ userData: 'C:/tmp' });
    return Promise.resolve(null);
  };
  const JobPrefix = {
    subscribe(prefix, fn) {
      calls.subscribe.push(prefix);
      calls._lastSub = fn;
      return () => { calls.unsub++; };
    }
  };
  const toast = (msg) => { calls.toast.push(msg); };
  /* api.errText 是可选的（老版本没有），这里给上以验证被使用 */
  const api = { errText: (e) => (e && e.message) || '错误' };

  return { calls, urlIn, fileIn, prog, status, startBtn, stopBtn, invoke, JobPrefix, toast, api, el };
}

function buildStart() {
  const body = extractStart();
  const st = makeStub();
  const wrapper = new Function(
    'urlIn', 'fileIn', 'prog', 'status', 'startBtn', 'stopBtn', 'invoke', 'toast',
    'window', 'Channels', 'App', 'jobId', 'unsub', 'pageDead', 'safeNameFromUrl', 'div', 'h',
    /* JobPrefix 是裸标识符（不是 window.JobPrefix）—— 在 IIFE 里由外层作用域提供 */
    '_JobPrefix',
    `let _jobId = jobId, _unsub = unsub, _dead = pageDead;
     ${body}
     return {
       start,
       state: () => ({ jobId: _jobId, unsub: _unsub, dead: _dead })
     };`
  );
  /* 注意：函数体里的 jobId/unsub 是外层 let 变量，上面用 _jobId 等别名承接。
   * start() 内部对 jobId 的赋值会改到 _jobId —— 我们需要把它读回来验证。 */
  const apiObj = {
    start: null,
    state: null
  };
  const ret = wrapper(
    st.urlIn, st.fileIn, st.prog, st.status, st.startBtn, st.stopBtn, st.invoke, st.toast,
    { api: st.api, JobPrefix: st.JobPrefix, App: { onCleanup() {} } },
    { CHANNELS: { NET: { DOWNLOAD: 'net:download' }, JOB: { KILL: 'job:kill' }, APP: { GET_INFO: 'app:get-info' }, DIALOG: { SAVE: 'dialog:save' } } },
    { onCleanup() {} }, null, null, false,
    () => 'a.bin', () => ({}), () => ({}),
    st.JobPrefix
  );
  apiObj.start = ret.start;
  apiObj.state = ret.state;
  return { api: apiObj, st };
}

t('D1 NET.DOWNLOAD 抛错后，开始按钮恢复可点（不再永久置灰）', async () => {
  const { api, st } = buildStart();
  await api.start();
  /* 锁的是：没有 finally -> 抛错后 startBtn.disabled 永远停在 true，
   * 用户改完保存路径也点不动。 */
  assert.strictEqual(st.startBtn.disabled, false, '开始按钮仍是禁用状态');
});

t('D2 抛错后状态行给出错误信息（不停在「连接中…」）', async () => {
  const { api, st } = buildStart();
  await api.start();
  /* 锁的是：状态行停在「连接中…」—— 用户以为还在连，实际早就失败了。 */
  assert.ok(/✗/.test(st.status.textContent), '状态行没有显示失败：' + JSON.stringify(st.status.textContent));
  assert.ok(/已存在/.test(st.status.textContent), '状态行没有带上真实原因：' + JSON.stringify(st.status.textContent));
});

t('D3 抛错后退订 job:stream 订阅（不泄漏到下一次进页面）', async () => {
  const { api, st } = buildStart();
  await api.start();
  /* 锁的是：订阅泄漏 —— 下一次进页面时会收到上一轮的残留事件。 */
  assert.strictEqual(st.calls.unsub, 1, 'unsub 没有被调用（调用 ' + st.calls.unsub + ' 次）');
});

t('D4 抛错后取消按钮回到禁用（没有任务可取消）', async () => {
  const { api, st } = buildStart();
  await api.start();
  /* 锁的是：任务没起来，取消按钮却亮着 —— 点了什么都不会发生。 */
  assert.strictEqual(st.stopBtn.disabled, true, '取消按钮仍可点');
});

t('D5 抛错后进度条隐藏（不残留一条空进度）', async () => {
  const { api, st } = buildStart();
  let hidden = 0;
  st.prog.hide = () => { hidden++; };
  await api.start();
  /* 锁的是：prog.show() 之后没有任何路径隐藏它。 */
  assert.ok(hidden >= 1, '进度条没有被隐藏');
});

t('D6 job:stream 先到的事件会认领 jobId，让取消按钮立刻可用', () => {
  /* 锁的是：jobId 只由 invoke 返回值赋值 —— 而第一条 job:stream 往往先到，
   * 那段时间点「取消」因为 jobId 为 null 而完全无效。
   * 【为什么用源码断言】认领发生在 subscribe 回调里，要触发它得跑完整的
   * JobPrefix 前缀匹配与 JSON 解析；这里锁的是「认领这一行在不在」。 */
  const i = src.indexOf("if (!jobId) jobId = d.id;");
  /* 锁的是：认领逻辑被删 —— 取消按钮回到「点了没反应」。 */
  assert.ok(i > 0, 'subscribe 回调里没有 `if (!jobId) jobId = d.id;`');
  /* 认领必须排在「id 不匹配就 return」之前，否则永远走不到 */
  const j = src.indexOf('if (jobId && d.id !== jobId) return;', i - 400);
  /* 锁的是：两句顺序写反 —— 认领被 return 挡在前面，等于没有。 */
  assert.ok(j > i, '认领语句必须排在 id 比对之前');
});

t('D7 失败时提示里带上可操作的原因（走 api.errText）', async () => {
  const { api, st } = buildStart();
  await api.start();
  /* 锁的是：只吞掉错误不告诉用户 —— 与"卡死"相比只是换了个坏法。 */
  assert.ok(st.calls.toast.length > 0, '失败时没有 toast 提示');
  assert.ok(/已存在/.test(st.calls.toast[0]), 'toast 没带真实原因：' + JSON.stringify(st.calls.toast[0]));
});

done();
