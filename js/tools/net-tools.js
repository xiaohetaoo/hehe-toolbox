/* 模块：网络运维 —— 网络信息 / Ping / 路由追踪 / 端口 / Hosts / 测速 */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { escapeHtml, div, btn, toast, copyText, renderTable, fmtBytes } = window.ui;
  const { invoke, on, isDesktop } = window.api;
  const MOD = 'net';

  /* 从 URL 推出安全的保存文件名。
   *
   * 【实现已搬到 lib/safe-name.js】原来内联在这里，测试只能「从源码切出函数体
   * 再求值」，那种做法在 CI 上因换行/剥注释差异失败过（v0.9.2）。
   * 现在是纯函数模块，渲染层由 index.html 的 <script> 挂到 window.SafeName，
   * 测试直接 require 同一份 —— 行为断言，不再切源码。
   *
   * 规则要点（详见 lib/safe-name.js 注释）：
   *   · 先解码再只取最后一段，挡掉 %2F..%2F 路径穿越；
   *   · 点开头的隐藏文件名保留（.bashrc / .gitignore / .env 不能被改名）；
   *   · Windows 设备名加前缀、超长截断保留扩展名。 */
  const safeNameFromUrl = (window.SafeName && window.SafeName.fromUrl)
    || ((u) => {   /* 兜底：库未加载时给一个不穿越的实现（宁可保守） */
      const seg = String(u || '').split('?')[0].split('#')[0].split('/').pop() || '';
      return seg.replace(/[\\/]/g, '_') || 'download.bin';
    });

  /* ---------- 网络信息查询 ---------- */
  register({
    id: 'net-info', name: '网络信息查询', nameEn: 'Network Info', module: MOD, icon: 'globe',
    desc: '内网 IP、网关、DNS、MAC、DHCP 与公网 IP 查询', descEn: 'List adapters, IPs, gateways and public IP',
    keywords: ['ip', '网络', 'dns', 'mac', '网关'],
    render(page) {
      const result = div('');
      result.appendChild(window.ui.loadingBlock('读取网络配置…'));
      const pubBtn = btn('查询公网 IP（联网）', 'btn-secondary btn-sm', async () => {
        pubEl.textContent = '查询中…';
        try { const r = await invoke(Channels.CHANNELS.NET.PUBLIC_IP); pubEl.textContent = r.ip; }
        /* 【不能用 e.message】fetch 失败时它恒为 "fetch failed"（实测），
         * 真正的原因在 e.cause.code 里。用户看到中文界面里一句英文，
         * 既不知道是 DNS 还是端口，也不知道下一步做什么。 */
        catch (e) { pubEl.textContent = '✗ ' + (window.NetError ? window.NetError.text(e) : e.message); }
      });
      const pubEl = h('span', { class: 'mono', style: { userSelect: 'text' } }, '-');
      invoke(Channels.CHANNELS.NET.INTERFACES).then(r => {
        result.innerHTML = '';
        const card = div('card', div('card-title', '本机网络配置'));
        card.appendChild(window.ui.kvGrid([['主机名', r.hostname]]));
        for (const a of r.adapters) {
          if (!a.ipv4.length && !a.mac) continue;
          card.appendChild(div('card-title', icon('wifi'), a.name || '适配器'));
          card.appendChild(window.ui.kvGrid([
            ['状态', a.status || '-'],
            ['IPv4 地址', a.ipv4.join(', ') || '-'],
            ['默认网关', a.gateway.join(', ') || '-'],
            ['DNS 服务器', a.dns.join(', ') || '-'],
            ['DHCP 服务器', a.dhcp || a.dhcpEnabled || '-'],
            ['MAC 地址', a.mac || '-']
          ]));
        }
        result.appendChild(card);
      }).catch(e => {
        /* 读网卡失败通常是 PowerShell/ipconfig 层的问题，原文可能是英文；
         * NetError 认不出时会把原文附在建议里，至少不会只剩一句"失败"。 */
        result.innerHTML = `<div class="field-err">${escapeHtml(window.NetError ? window.NetError.text(e) : e.message)}</div>`;
      });
      function icon(n) { const t = document.createElement('span'); t.innerHTML = window.iconSvg(n); return t.firstChild; }
      page.appendChild(div('card', div('card-title', '公网 IP（需主动联网查询）'), pubBtn, ' ', pubEl));
      page.appendChild(result);
    }
  });

  /* ---------- Ping 测试 ---------- */
  register({
    id: 'ping-test', name: 'Ping 测试', nameEn: 'Ping', module: MOD, icon: 'activity',
    desc: '连续 Ping、丢包率统计、延迟实时曲线', descEn: 'Ping a host continuously and watch latency and loss',
    keywords: ['ping', '延迟', '丢包'],
    render(page) {
      const hostIn = h('input', { class: 'input mono', value: 'www.baidu.com', style: { flex: '1' } });
      const canvas = h('canvas', { style: { width: '100%', height: '180px' } });
      const term = div('term', '');
      const statsEl = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px', margin: '12px 0' } });
      let jobId = null, chart = window.ui.lineChart(canvas, { max: null });
      /* 【per-run token】start() 里 await EXEC.STREAM 期间用户可能离开页面
       * 或再点一次「开始」。离开/重开都递增序号，旧请求返回时发现序号不符：
       *   · 界面一律不碰（那是新一趟的界面）；
       *   · 它刚建出来的 job 必须立刻 KILL，否则 ping -t 会在后台一直跑
       *     （永不自行退出），而没有任何界面能取消它。 */
      let pingRunSeq = 0;
      window.App.onCleanup(() => {
        pingRunSeq++;
        if (unsubStream) try { unsubStream(); } catch (e) {}
        if (unsubExit) try { unsubExit(); } catch (e) {}
        if (jobId) { invoke(Channels.CHANNELS.JOB.KILL, jobId).catch(() => {}); jobId = null; }
        /* 【界面必须复位】原来只杀 job 不动界面：复用回来后
         * 「开始 Ping」是灰的、「停止 Ping」是亮的，而实际上什么都没在跑
         * —— 点停止没有对象，点开始又点不动，页面等于废了。 */
        try {
          running = false;
          startBtn.disabled = false; stopBtn.disabled = true;
        } catch (e) {}
      });
      if (window.App.onEnter) {
        window.App.onEnter(() => {
          /* 复用回来：序号前进（让任何在飞的旧请求作废），界面按「没在跑」复位 */
          pingRunSeq++;
          try {
            if (!jobId) { running = false; startBtn.disabled = false; stopBtn.disabled = true; }
          } catch (e) {}
        });
      }
      /* eslint-disable-next-line no-unused-vars -- running 在 Ping 页只写不读：start() 不以它做守卫
       * （重复点「开始」的语义是"杀旧起新"），保留它只为与其它页的状态复位写法一致。 */
      let latencies = [], sent = 0, recv = 0, running = false;
      let unsubStream, unsubExit;
      const startBtn = btn('开始 Ping', 'btn-primary', start, 'play');
      const stopBtn = btn('停止 Ping', 'btn-danger-plain', stop, 'square');
      stopBtn.disabled = true;
      function updateStats() {
        /* 不用 Math.max(...latencies)：ping 次数虽小，但「展开传参」这类写法
         * 一旦数组变大就会 RangeError（栈上限约 12-13 万个参数）。
         * 统一用 reduce，永远没有参数个数上限。 */
        const min = latencies.length ? latencies.reduce((a, b) => (a < b ? a : b), Infinity) : 0;
        const max = latencies.length ? latencies.reduce((a, b) => (a > b ? a : b), -Infinity) : 0;
        const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
        statsEl.innerHTML = '';
        for (const [k, v, u] of [['已发送', sent, ''], ['已接收', recv, ''], ['平均延迟', avg ? avg.toFixed(1) : '-', 'ms'], ['最小/最大', latencies.length ? `${min}/${max}` : '-', 'ms'], ['丢包率', sent ? ((1 - recv / sent) * 100).toFixed(1) : '-', '%']]) {
          statsEl.appendChild(div('', h('div', { class: 'field-hint' }, k), h('div', { class: 'stat-num', style: { fontSize: '20px' } }, String(v), u ? h('span', { class: 'stat-unit' }, u) : null)));
        }
      }
      async function start() {
        if (!isDesktop) return toast('桌面端可用', 'warn');
        const host = hostIn.value.trim();
        if (!host) return;
        /* 【领序号】这一趟 ping 的有效凭证（见 pingRunSeq 的说明） */
        const runToken = ++pingRunSeq;
        // ping -t 永不自行退出：重复点「开始」必须先杀掉上一个，
        // 否则残留进程一直跑，而 stop() 只认最新的 jobId，旧进程再也取消不掉。
        if (jobId) { try { await invoke(Channels.CHANNELS.JOB.KILL, jobId); } catch (e) {} jobId = null; }
        if (runToken !== pingRunSeq) return;   // 杀旧 job 期间又变了，这趟作废
        running = true; sent = 0; recv = 0; latencies = [];
        term.innerHTML = ''; startBtn.disabled = true; stopBtn.disabled = false;
        let newJobId;
        try {
          newJobId = await invoke(Channels.CHANNELS.EXEC.STREAM, { command: 'ping', args: ['-t', host] });
        } catch (e) {
          if (runToken !== pingRunSeq) return;   // 过期不弹错
          // 原来没兜底：exec 失败时按钮永久 disabled、状态停在「进行中」，只能切页恢复
          running = false; startBtn.disabled = false; stopBtn.disabled = true;
          /* 【修 bug】这里原先写 `status.textContent = ...`，但 Ping 页面的 render
           * 作用域里根本没有 status 变量（只有 term / startBtn / stopBtn / statsEl）。
           * 非严格模式下解析成 window.status，赋值静默失效；严格模式下直接抛
           * `status is not defined` —— 而且抛在 catch 里，真正的失败原因被这个次级
           * 报错掩盖。改成写进终端区（term），与其它输出位置保持一致。 */
          try {
            const line = document.createElement('div');
            line.className = 'field-err';
            line.textContent = '✗ ' + (e && e.message ? e.message : String(e));
            term.appendChild(line);
          } catch (e2) {}
          toast((e && e.message) || String(e), 'error');
          return;
        }
        /* 【过期就必须杀掉刚建出来的 job】ping -t 不会自己退出，
         * 漏杀就是一个永久驻留的进程（用户只能在任务管理器里找）。 */
        if (runToken !== pingRunSeq) {
          if (newJobId) invoke(Channels.CHANNELS.JOB.KILL, newJobId).catch(() => {});
          return;
        }
        jobId = newJobId;
        if (unsubStream) try { unsubStream(); } catch (e) {}
        if (unsubExit) try { unsubExit(); } catch (e) {}
        unsubStream = on('job:stream', (d) => {
          if (d.id !== jobId) return;
          const lines = String(d.data).split(/\r?\n/).filter(Boolean);
          for (const line of lines) {
            const el = h('div', null, line);
            /* Windows 中文版在局域网/本机（延迟 <1ms）会输出
                 「来自 192.168.1.1 的回复: 字节=32 时间<1ms TTL=64」
               原来的正则要求 [=：:] 后紧跟数字，遇到 `<` 就匹配不上，
               于是这些成功回复既不计 sent 也不计 recv，丢包率被算高、曲线缺采样点。
               这里统一处理 时间/时间/TTL 之后的 = : < 四种符号。 */
            const m = line.match(/(?:时间|time)\s*[=:：<]\s*(\d+(?:\.\d+)?)\s*ms/i)
              || line.match(/[=：:]\s*(\d+(?:\.\d+)?)\s*ms/i);
            if (m) {
              sent++; recv++;
              latencies.push(parseFloat(m[1]));
              if (latencies.length > 120) latencies.shift();
              el.className = 't-hl';
            } else if (/超时|timed out|unreachable|失败/i.test(line)) { sent++; el.className = 't-err'; }
            term.appendChild(el);
            if (term.children.length > 300) term.firstChild.remove();
            term.scrollTop = term.scrollHeight;
          }
          updateStats();
          /* 同上：展开传参会在大数组上栈溢出，改 reduce（下限 50）。 */
          chart.draw(latencies, { max: latencies.reduce((a, b) => (a > b ? a : b), 50) * 1.2 });
        });
        unsubExit = on('job:exit', (d) => { if (d.id === jobId) { jobId = null; running = false; startBtn.disabled = false; stopBtn.disabled = true; } });
      }
      async function stop() {
        /* 【停止必须立刻生效，不能只在 jobId 存在时才做点什么】
         * start() 里 await EXEC.STREAM 期间 jobId 仍是 null；这段时间点停止，
         * 原来的 `if (jobId) kill` 什么都不做，而 start 恢复后 token 未变，
         * 于是 ping -t 照样起来（永不自行退出）。必须：①递增序号让
         * start 的后续步骤作废；②有 id 就杀；③立刻复位界面。 */
        pingRunSeq++;
        /* 【先复位界面，再等 kill】job:kill 是一次 IPC 往返；放在它后面的话，
         * IPC 一慢（主进程正忙）按钮就晚半拍才复位，用户会再点一次。 */
        const dead = jobId; jobId = null;
        if (unsubStream) { try { unsubStream(); } catch (e) {} unsubStream = null; }
        if (unsubExit) { try { unsubExit(); } catch (e) {} unsubExit = null; }
        running = false;
        startBtn.disabled = false; stopBtn.disabled = true;
        if (dead) { try { await invoke(Channels.CHANNELS.JOB.KILL, dead); } catch (e) {} }
      }
      page.appendChild(div('card', div('card-title', '目标'),
        div('form-row', hostIn, startBtn, ' ', stopBtn),
        statsEl,
        div('field-hint', '延迟曲线（ms）'),
        canvas));
      page.appendChild(div('card', div('card-title', '输出'), term));
    }
  });

  /* ---------- 路由追踪 ---------- */
  register({
    id: 'tracert', name: '路由追踪', nameEn: 'Traceroute', module: MOD, icon: 'branch',
    desc: 'Traceroute 路径追踪，展示每跳延迟', descEn: 'Trace the network path to a host hop by hop',
    keywords: ['tracert', 'traceroute', '路由'],
    render(page) {
      const hostIn = h('input', { class: 'input mono', value: 'www.baidu.com', style: { flex: '1' } });
      const noDns = h('input', { type: 'checkbox', class: 'checkbox' });
      const term = div('term', '');
      let jobId = null, unsubStream, unsubExit;
      /* 【停止追踪必须立刻生效】（同 Ping 的说明）
       * 原实现只 `if (jobId) kill`：在 start 的 await 窗口里 jobId 还是 null，
       * 点停止完全无效，而 start 恢复后 token 未变 → tracert 照样起来。
       * tracert 单次跑几十秒且没有别的入口取消，所以这里要：递增序号、
       * 有 id 就杀、退订、立刻复位按钮。 */
      const stopBtn = btn('停止追踪', 'btn-danger-plain', () => {
        traceRunSeq++;
        if (jobId) { try { invoke(Channels.CHANNELS.JOB.KILL, jobId); } catch (e) {} jobId = null; }
        if (unsubStream) { try { unsubStream(); } catch (e) {} unsubStream = null; }
        if (unsubExit) { try { unsubExit(); } catch (e) {} unsubExit = null; }
        startBtn.disabled = false; stopBtn.disabled = true;
      }, 'square');
      stopBtn.disabled = true;
      /* 【per-run token】同 Ping：EXEC.STREAM 的 await 期间用户可能离开页面，
       * 旧请求返回时必须把自己的 job 杀掉。 */
      let traceRunSeq = 0;
      window.App.onCleanup(() => {
        traceRunSeq++;
        if (unsubStream) try { unsubStream(); } catch (e) {}
        if (unsubExit) try { unsubExit(); } catch (e) {}
        if (jobId) { invoke(Channels.CHANNELS.JOB.KILL, jobId).catch(() => {}); jobId = null; }
        /* 【必须复位按钮】原来只杀 job：复用回来后「开始追踪」永久灰掉、
         * 而 tracert 又没有停止按钮 —— 用户只能切页（当时只能整页重建）救。
         * 现在复位两者，且真正提供了停止按钮。 */
        try {
          startBtn.disabled = false;
          stopBtn.disabled = true;
        } catch (e) {}
      });
      if (window.App.onEnter) {
        window.App.onEnter(() => {
          traceRunSeq++;
          try { if (!jobId) { startBtn.disabled = false; stopBtn.disabled = true; } } catch (e) {}
        });
      }
      const startBtn = btn('开始追踪', 'btn-primary', async () => {
        if (!isDesktop) return toast('桌面端可用', 'warn');
        const host = hostIn.value.trim();
        if (!host) return;
        /* 【领序号 + 杀掉上一个】tracert 单次会跑几十秒；重复点会在
         * 后台叠多个进程，而 unsubStream 只认最新 jobId —— 旧进程再也
         * 取消不掉。与 Ping 页同一处理。 */
        const runToken = ++traceRunSeq;
        if (jobId) { try { await invoke(Channels.CHANNELS.JOB.KILL, jobId); } catch (e) {} jobId = null; }
        if (runToken !== traceRunSeq) return;
        term.innerHTML = ''; startBtn.disabled = true; stopBtn.disabled = false;
        const args = noDns.checked ? ['-d', '-h', '30', host] : ['-h', '30', host];
        let newJobId;
        /* 【补兜底】原来是裸 `jobId = await invoke(Channels.CHANNELS.EXEC.STREAM, ...)`：
         * 启动失败时抛在 await 处，而 `startBtn.disabled = true` 已经在上一行生效，
         * 结果「开始追踪」按钮永久变灰，只能切页面才恢复。 */
        try {
          newJobId = await invoke(Channels.CHANNELS.EXEC.STREAM, { command: 'tracert', args });
        } catch (e) {
          if (runToken !== traceRunSeq) return;
          startBtn.disabled = false; stopBtn.disabled = true;
          try {
            const errLine = h('div', { class: 'field-err' }, '✗ ' + ((e && e.message) || String(e)));
            term.appendChild(errLine);
          } catch (e2) {}
          toast((e && e.message) || String(e), 'error');
          return;
        }
        /* 过期就杀掉刚建出来的 job（tracert 也会跑很久） */
        if (runToken !== traceRunSeq) {
          if (newJobId) invoke(Channels.CHANNELS.JOB.KILL, newJobId).catch(() => {});
          return;
        }
        jobId = newJobId;
        if (unsubStream) try { unsubStream(); } catch (e) {}
        if (unsubExit) try { unsubExit(); } catch (e) {}
        unsubStream = on('job:stream', (d) => {
          if (d.id !== jobId) return;
          for (const line of String(d.data).split(/\r?\n/).filter(Boolean)) {
            const el = h('div', null, line);
            if (/^\s*\d+\s/.test(line)) el.className = 't-hl';
            if (/\*\s*\*\s*\*/.test(line)) el.className = 't-err';
            term.appendChild(el);
            if (term.children.length > 200) term.firstChild.remove();
            term.scrollTop = term.scrollHeight;
          }
        });
        unsubExit = on('job:exit', (d) => {
          if (d.id !== jobId) return;
          jobId = null;
          startBtn.disabled = false; stopBtn.disabled = true;
        });
      }, 'play');
      page.appendChild(div('card', div('card-title', '目标'),
        div('form-row', hostIn, h('label', { class: 'field-hint' }, noDns, ' 不解析域名（更快）'), startBtn, ' ', stopBtn)));
      page.appendChild(div('card', div('card-title', '路径'), term));
    }
  });

  /* ---------- 端口占用查询 ---------- */
  register({
    id: 'port-occupy', name: '端口占用查询', nameEn: 'Port Occupied', module: MOD, icon: 'plug',
    desc: '查询本机端口占用的进程，一键结束释放端口', descEn: 'Find which process is holding a port and free it',
    keywords: ['端口', '占用', 'netstat', '杀进程'],
    render(page) {
      const portIn = h('input', { class: 'input mono input-sm', placeholder: '端口号（留空显示全部监听）', style: { width: '220px' } });
      const result = div('');
      async function query() {
        try {
        result.innerHTML = '';
        result.appendChild(window.ui.loadingBlock('查询 netstat…'));
        const r = await invoke(Channels.CHANNELS.EXEC.RUN, { cmd: 'netstat -ano -p tcp', shellType: 'cmd', timeoutMs: 15000 });
        const rows = [];
        for (const line of r.stdout.split(/\r?\n/)) {
          const m = line.match(/^\s*(TCP|UDP)\s+(\S+)\s+(\S+)\s+(\S*)\s+(\d+)\s*$/);
          if (!m) continue;
          const [, proto, local, remote, state, pid] = m;
          const port = local.split(':').pop();
          if (portIn.value.trim() && port !== portIn.value.trim()) continue;
          if (!portIn.value.trim() && state !== 'LISTENING') continue;
          rows.push({ proto, local, remote, state: state || '-', pid: parseInt(pid) });
        }
        result.innerHTML = '';
        if (!rows.length) { result.appendChild(div('empty-tip', '没有匹配的端口占用')); return; }
        // map pid to name
        const procs = await invoke(Channels.CHANNELS.PROC.LIST).catch(() => []);
        const nameMap = new Map(procs.map(p => [p.pid, p.name]));
        const table = renderTable({
          columns: [
            { key: 'proto', title: '协议', width: '70px' },
            /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
            { key: 'local', title: '本地地址', render: r => div('mono', null, r.local) },
            /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
            { key: 'state', title: '状态', width: '110px', render: r => h('span', { class: r.state === 'LISTENING' ? 'tag tag-green' : 'tag tag-blue' }, r.state) },
            { key: 'pid', title: 'PID', width: '80px' },
            /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
            { key: 'name', title: '进程', render: r => nameMap.get(r.pid) || '-' },
            /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
            { key: 'act', title: '操作', width: '170px', render: (r, td) => {
                const b1 = btn('任务管理器', 'btn-sm btn-text', () => invoke(Channels.CHANNELS.EXEC.STREAM, { command: 'taskmgr.exe' }).catch(() => toast('启动失败', 'error')));
                const b2 = btn('结束进程', 'btn-sm btn-danger-plain', async () => {
                  if (!(await window.ui.confirmBox({ title: '结束进程', message: `结束 PID ${r.pid}（${nameMap.get(r.pid) || '未知'}）？这可能导致数据丢失。`, danger: true, okText: '结束' }))) return;
                  try { await invoke(Channels.CHANNELS.PROC.KILL, r.pid); toast('已结束', 'success'); query(); }
                  catch (e) { toast(e.message, 'error'); }
                });
                td.appendChild(b1); td.appendChild(b2);
              } }
          ],
          rows: rows.slice(0, 300)
        });
        result.appendChild(table);
        if (rows.length > 300) result.appendChild(div('field-hint', `共 ${rows.length} 条，仅显示前 300 条`));
        } catch (e) {
          result.innerHTML = '';
          result.appendChild(div('field-err', '查询失败：' + (e && e.message ? e.message : e)));
        }
      }
      page.appendChild(div('card', div('card-title', '查询'),
        div('form-row', portIn, btn('查询', 'btn-primary', query), h('span', { class: 'field-hint' }, 'Windows: netstat -ano'))));
      page.appendChild(result);
    }
  });

  /* ---------- 端口连通性测试 ---------- */
  register({
    id: 'port-test', name: '端口连通测试', nameEn: 'Port Test', module: MOD, icon: 'plug',
    desc: '测试远程主机指定端口是否开放', descEn: 'Check whether a specific port is reachable',
    keywords: ['端口', 'telnet', '连通'],
    render(page) {
      const hostIn = h('input', { class: 'input mono', value: '127.0.0.1', style: { width: '200px' } });
      const portIn = h('input', { class: 'input mono input-sm', value: '80', style: { width: '100px' } });
      const result = div('');
      result.style.cssText = 'font-size:16px;font-weight:600;margin-top:10px';
      async function test() {
        result.textContent = '测试中…';
        result.style.color = 'var(--text-3)';
        try {
          const r = await invoke(Channels.CHANNELS.NET.TCP_TEST, hostIn.value.trim(), parseInt(portIn.value), 5000);
          result.style.color = r.open ? 'var(--success)' : 'var(--danger)';
          result.textContent = r.open ? `✓ 端口开放（连接耗时 ${r.ms}ms）` : '✗ 端口不通或被拒绝';
        } catch (e) {
          /* 主进程这一路把 errno 写进了 message（connect ECONNREFUSED …），
           * 但仍是英文。统一交给 NetError 说中文。 */
          result.textContent = '✗ ' + (window.NetError ? window.NetError.text(e) : e.message);
          result.style.color = 'var(--danger)';
        }
      }
      page.appendChild(div('card', div('card-title', '测试目标'),
        div('form-row', hostIn, h('span', { class: 'form-label', style: { minWidth: 'auto' } }, ':'), portIn,
          btn('测试', 'btn-primary', test)), result));
    }
  });

  /* ---------- 本机端口扫描 ---------- */
  register({
    id: 'port-scan', name: '本机端口扫描', nameEn: 'Port Scan', module: MOD, icon: 'target',
    desc: '扫描本机/指定主机开放端口与常见服务', descEn: 'Scan common ports on a host to see what is open',
    keywords: ['扫描', '端口', 'scan'],
    render(page) {
      const hostIn = h('input', { class: 'input mono', value: '127.0.0.1', style: { width: '180px' } });
      const rangeIn = h('input', { class: 'input mono input-sm', value: '', style: { flex: '1' }, placeholder: '如 80,443,8000-8100' });
      const preset = h('select', { class: 'select input-sm' },
        h('option', { value: '' }, '常见端口'), h('option', { value: '1-1024' }, '1-1024'), h('option', { value: '1-65535' }, '1-65535（较慢）'));
      // 预设下拉默认是「常见端口」（value=''），但输入框默认 '1-1024'，
      // 而实际扫描范围只看 rangeIn —— 界面说扫常见端口，实际扫 1024 个。
      // 选择预设时把值同步进输入框，让两者始终一致。
      preset.value = '';
      preset.addEventListener('change', () => { rangeIn.value = preset.value; });
      const result = div('');
      const status = h('span', { class: 'field-hint' }, '');
      const COMMON = [21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 443, 445, 873, 993, 995, 1433, 1521, 2375, 3306, 3389, 5432, 5900, 6379, 8080, 8443, 8888, 9090, 9200, 27017, 28017];
      const SERVICES = { 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 110: 'POP3', 135: 'RPC', 139: 'NetBIOS', 143: 'IMAP', 443: 'HTTPS', 445: 'SMB', 1433: 'SQL Server', 3306: 'MySQL', 3389: '远程桌面', 5432: 'PostgreSQL', 6379: 'Redis', 8080: 'HTTP-Alt', 8443: 'HTTPS-Alt', 9090: '管理面板', 9200: 'Elasticsearch', 27017: 'MongoDB' };
      function parsePorts() {
        const v = rangeIn.value.trim();
        if (preset.value && v === preset.value) {
          if (v === '') return COMMON;
        }
        if (!v) return COMMON;
        const set = new Set();
        for (const part of v.split(/[,，]/)) {
          const m = part.trim().match(/^(\d+)-(\d+)$/);
          if (m) { for (let i = +m[1]; i <= +m[2]; i++) set.add(i); }
          else if (/^\d+$/.test(part.trim())) set.add(parseInt(part));
        }
        return [...set].filter(p => p > 0 && p < 65536);
      }
      async function scan() {
        result.innerHTML = '';
        const ports = parsePorts();
        if (!ports.length) return toast('请输入端口范围', 'warn');
        if (ports.length > 65535) return toast('端口数过多', 'warn');
        status.textContent = `扫描中（${ports.length} 个端口）…`;
        try {
          const r = await invoke(Channels.CHANNELS.NET.SCAN, hostIn.value.trim(), ports, { concurrency: 400, timeout: 600 });
          status.textContent = `完成：开放 ${r.open.length} 个`;
          result.innerHTML = '';
          if (!r.open.length) { result.appendChild(div('empty-tip', '未发现开放端口')); return; }
          result.appendChild(renderTable({
            columns: [
              { key: 'p', title: '端口', width: '100px' },
              { key: 's', title: '服务' }
            ],
            rows: r.open.map(p => ({ p, s: SERVICES[p] || '未知' }))
          }));
        } catch (e) {
          /* 端口扫描同样走 net 层（NET.SCAN），失败原文是英文 errno 串 */
          status.textContent = '✗ ' + (window.NetError ? window.NetError.text(e) : e.message);
        }
      }
      page.appendChild(div('card', div('card-title', '扫描目标'),
        div('form-row', h('span', { class: 'form-label' }, '主机'), hostIn, ' ', preset),
        div('form-row', h('span', { class: 'form-label' }, '范围'), rangeIn, btn('开始扫描', 'btn-primary', scan)), status));
      page.appendChild(result);
    }
  });

  /* ---------- Hosts 编辑 ---------- */
  register({
    id: 'hosts-edit', name: 'Hosts 编辑', nameEn: 'Hosts Editor', module: MOD, icon: 'file-text',
    desc: '快速编辑系统 Hosts，支持备份还原（写入需管理员权限）', descEn: 'Edit the hosts file with backup and one-click restore',
    keywords: ['hosts', '域名', '解析'],
    render(page) {
      const ta = h('textarea', { class: 'pane-ta mono', style: { minHeight: '320px', fontSize: '12px' } });
      const pathEl = div('field-hint', '');
      const status = h('div', { class: 'field-hint' }, '');
      async function load() {
        try {
          const r = await invoke(Channels.CHANNELS.HOSTS.READ);
          ta.value = r.content;
          pathEl.textContent = r.path;
        } catch (e) { toast(e.message, 'error'); }
      }
      const saveBtn = btn('保存并刷新 DNS', 'btn-primary', async () => {
        try {
          await invoke(Channels.CHANNELS.HOSTS.WRITE, ta.value);
          status.innerHTML = '<span class="status-ok">✓ 已保存并刷新 DNS 缓存</span>';
          toast('Hosts 已保存', 'success');
        } catch (e) {
          status.innerHTML = `<span class="status-err">✗ ${escapeHtml(e.message)}</span><br><span class="field-hint">提示：修改 hosts 需要管理员权限，请以管理员身份运行核核工具箱后再试。</span>`;
          toast('保存失败：' + e.message, 'error');
        }
      }, 'save');
      const bakBtn = btn('备份当前', 'btn-sm btn-secondary', async () => {
        try { const r = await invoke(Channels.CHANNELS.HOSTS.BACKUP); toast('已备份：' + r.name, 'success'); } catch (e) { toast(e.message, 'error'); }
      });
      const restoreBtn = btn('从备份还原…', 'btn-sm btn-secondary', async () => {
        try {
          const list = await invoke(Channels.CHANNELS.HOSTS.BACKUPS);
          if (!list.length) return toast('没有备份', 'warn');
          const p = await invoke(Channels.CHANNELS.DIALOG.OPEN, { defaultPath: list[0], properties: ['openFile'] });
          if (!p || !p[0]) return;
          if (!(await window.ui.confirmBox({ title: '还原 Hosts', message: '将用备份覆盖当前 hosts 文件，确定？' }))) return;
          await invoke(Channels.CHANNELS.HOSTS.RESTORE, p[0]); toast('已还原', 'success'); load();
        } catch (e) { toast(e.message, 'error'); }
      });
      page.appendChild(div('card', div('card-title', 'Hosts 文件', pathEl),
        div('form-row', saveBtn, bakBtn, restoreBtn),
        ta, status));
      load();
    }
  });

  /* ---------- 网速测试 ---------- */
  register({
    id: 'speedtest', name: '网速测试', nameEn: 'Speed Test', module: MOD, icon: 'wifi',
    desc: '下载/上传带宽测速（Cloudflare 节点，主动触发联网）', descEn: 'Measure download and upload speed',
    keywords: ['网速', '带宽', '测速'],
    render(page) {
      const canvas = h('canvas', { style: { width: '100%', height: '180px' } });
      const chart = window.ui.lineChart(canvas, { max: null });
      const downEl = h('div', { class: 'stat-num' }, '--');
      const upEl = h('div', { class: 'stat-num' }, '--');
      const status = h('span', { class: 'field-hint' }, '');
      let samples = [];
      let unsub;
      const downBtn = btn('测下载', 'btn-primary', () => run('down'), 'download');
      const upBtn = btn('测上传', 'btn-secondary', () => run('up'), 'upload');
      async function run(dir) {
        if (!isDesktop) return toast('桌面端可用（需联网）', 'warn');
        if (unsub) { try { unsub(); } catch (e) {} unsub = null; } // 防连点：先退订上一轮
        downBtn.disabled = upBtn.disabled = true;
        status.textContent = '测试中…'; samples = [];
        /* job:stream 是全局通道，必须只认本次测速的 id，
           否则别的任务发来的 samples 会被画到这条曲线上。
         *
         * 【必须按前缀认领，不能"先到先得"】
         * 原写法 `if (!speedId) speedId = d.id` 会**接管第一个到来的任何 id** ——
         * 只要此刻别的任务（哈希、压缩、下载）恰好在广播，它抢到的就是
         * 别人的 id，接着要么把别人的进度当成测速数据画出来，
         * 要么因为 id 不匹配而把自己真实的事件全过滤掉（曲线一直是空的）。
         * 主进程 net:speedtest 用 'speed' 前缀生成任务 id（见 lib/job-id.js），
         * 所以这里只接受该前缀：`speed` + 纯数字，形如 speed123。
         * 与文件下载页（dlg 前缀）保持同一套判定口径。 */
        const SPEED_PREFIX = 'speed';
        let speedId = null;
        unsub = on('job:stream', (d) => {
          try {
            if (!d || !d.id) return;
            if (speedId) {
              if (d.id !== speedId) return;          // 已认领：只认这一个
            } else if (window.JobPrefix && window.JobPrefix.belongsTo(String(d.id), SPEED_PREFIX)) {
              speedId = d.id;                        // 首次匹配到本前缀才认领
            } else {
              return;                                // 拿到真实 id 之前，别的一律不接管
            }
            const j = JSON.parse(d.data);
            if (j.samples && j.samples.length) {
              samples = j.samples.map(s => s.mbps);
              /* 【不能用 Math.max(10, ...samples)】
               * 展开传参在数组很大时会抛 RangeError: Maximum call stack size
               * exceeded，而报错跟"测速失败"毫无关系，用户猜不到原因。
               * 本项目已有一道守卫（test-lib 的断言 15）专门拦这种写法，
               * 但它的正则只匹配「... 是第一个实参」，这一行 ... 在第二位，
               * 一直漏检。守卫已改成配平括号判实参表（见该断言注释），
               * 这里同步改成 reduce，语义不变（下限 10）。 */
              const peak = samples.reduce((a, b) => (a > b ? a : b), 10);
              chart.draw(samples, { max: peak * 1.3 });
            }
          } catch (e) {}
        });
        try {
          const r = await invoke(Channels.CHANNELS.NET.SPEEDTEST, { direction: dir, seconds: 10 });
          const mbps = r.mbps;
          if (dir === 'down') downEl.textContent = mbps.toFixed(1);
          else upEl.textContent = mbps.toFixed(1);
          status.textContent = `完成：${fmtBytes(r.bytes)} / ${r.elapsed.toFixed(1)}s`;
          if (r.samples && r.samples.length) { samples = r.samples.map(s => s.mbps); chart.draw(samples, { max: samples.reduce((a, b) => (a > b ? a : b), 10) * 1.3 }); }
        } catch (e) {
          /* 测速走 fetch，失败时 e.message 是 "fetch failed" —— 换成中文归因 */
          status.textContent = '✗ ' + (window.NetError ? window.NetError.text(e) : e.message);
        }
        finally { downBtn.disabled = upBtn.disabled = false; if (unsub) unsub(); }
      }
      page.appendChild(div('card', div('card-title', '带宽测试'),
        div('form-row', downBtn, ' ', upBtn, status),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', margin: '12px 0' } },
          div('', h('div', { class: 'field-hint' }, '下载速度 Mbps'), downEl),
          div('', h('div', { class: 'field-hint' }, '上传速度 Mbps'), upEl)),
        div('field-hint', '实时速率（Mbps）'), canvas,
        div('field-hint', '默认使用 Cloudflare 测速节点，仅在你点击按钮时联网')));
    }
  });

  /* ---------- WiFi 密码查看 ---------- */
  register({
    id: 'wifi-password', name: 'WiFi 密码查看', nameEn: 'Wi-Fi Passwords', module: MOD, icon: 'wifi',
    desc: '列出本机已保存的 WiFi 并查看其连接密码', descEn: 'List saved Wi-Fi profiles and their keys',
    keywords: ['wifi', '密码', '无线', 'wlan'],
    render(page) {
      const listBox = div('');
      const status = h('span', { class: 'field-hint' }, '');
      const refreshBtn = btn('重新加载', 'btn-sm btn-secondary', load, 'refresh');
      async function load() {
        listBox.innerHTML = '';
        listBox.appendChild(window.ui.loadingBlock('读取已保存的 WiFi…'));
        try {
          const r = await invoke(Channels.CHANNELS.WIFI.PROFILES);
          listBox.innerHTML = '';
          status.textContent = `${r.names.length} 个配置文件`;
          for (const name of r.names) {
            const row = div('form-row',
              h('span', { class: 'mono', style: { flex: '1' } }, name),
              h('span', { class: 'field-hint wifi-key' }, '—'));
            row.appendChild(btn('查看密码', 'btn-sm btn-text', async () => {
              const keyEl = row.querySelector('.wifi-key');
              keyEl.textContent = '查询中…';
              try {
                const k = await invoke(Channels.CHANNELS.WIFI.KEY, name);
                keyEl.textContent = k.key ? k.key : '（开放网络无密码）';
                // 反复点「查看密码」会重复追加「复制」按钮，一行里堆出好几个
                if (k.key && !row.querySelector('.wifi-copy')) {
                  row.appendChild(btn('复制', 'btn-sm btn-text wifi-copy', () => copyText(k.key)));
                }
              } catch (e) { keyEl.textContent = '✗ ' + (e && e.message ? e.message : e); }
            }));
            listBox.appendChild(row);
          }
        } catch (e) {
          listBox.innerHTML = '';
          listBox.appendChild(div('field-err', '✗ ' + (e && e.message ? e.message : e)));
        }
      }
      page.appendChild(div('card', div('card-title', '已保存的 WiFi'),
        div('form-row', refreshBtn, status), listBox,
        div('field-hint', '密码来自 Windows 已保存的无线网络配置，仅在本机读取，不会上传')));
      load();
    }
  });

  /* ---------- 文件下载器 ---------- */
  register({
    id: 'downloader', name: '文件下载', nameEn: 'Downloader', module: MOD, icon: 'download',
    desc: '下载直链文件：断点续传、自动重试、实时进度', descEn: 'Download files with resume support and a progress bar',
    keywords: ['下载', 'download', '直链', 'url'],
    render(page) {
      const urlIn = h('input', { class: 'input mono', placeholder: 'https://… 直链地址', style: { flex: '1' } });
      const fileIn = h('input', { class: 'input input-sm', placeholder: '保存路径（留空 = 数据目录/文件名）', style: { flex: '1' } });
      const pickBtn = btn('选择…', 'btn-sm btn-secondary', async () => {
        const p = await invoke(Channels.CHANNELS.DIALOG.SAVE, {});
        if (p) fileIn.value = p;
      });
      const prog = progressEl(); prog.hide();
      const status = h('span', { class: 'field-hint' }, '');
      const startBtn = btn('开始下载', 'btn-primary', start, 'download');
      /* 【取消必须立刻生效】（同 Ping/追踪）
       * 原实现只 `if (jobId) kill`：在 await NET.DOWNLOAD 的窗口里 jobId
       * 还是 null，点取消失效；invoke 返回后 token 未变，下载照样开始。
       * 取消要做四件事，缺一不可：
       *   ① 递增序号 —— 让在飞的 start 在返回点作废（并自杀 job）；
       *   ② 有 id 就 kill（已经跑起来的下载）；
       *   ③ 退订并复位按钮/进度 —— 立刻把界面还回"没在下载"；
       *   ④ jobId 置空 —— 否则 later 的 finally 会以为还有活任务。 */
      function doCancel() {
        downloadRunSeq++;
        if (jobId) { invoke(Channels.CHANNELS.JOB.KILL, jobId).catch(() => {}); jobId = null; }
        dropSub();
        try {
          startBtn.disabled = false; stopBtn.disabled = true;
          prog.hide();
          status.textContent = '已取消';
        } catch (e) {}
      }
      const stopBtn = btn('取消', 'btn-danger-plain', doCancel, 'square');
      stopBtn.disabled = true;
      let jobId = null, unsub = null;
      /* 【一个页面同时最多一个订阅】
       * 原来每次 start() 都无条件 subscribe('dlg') 并覆盖 unsub 引用：
       *   · 第一次下载完成后 finally 不退订（jobId 非空那条分支没退）；
       *   · 第二次下载覆盖 unsub，第一次的监听器再也拿不到引用 → 永久残留，
       *     其闭包还持有旧 DOM 与进度条；
       *   · 离开页面只退订最后一个，前面的全泄漏。
       * 多次下载后 window.api 的 job:stream 监听器线性增长。
       * 收口：进 start 先退旧的；done 分支退订；页面 cleanup 退当前。 */
      function dropSub() {
        if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
      }
      /* 【per-run token】每次点「开始下载」领一个序号。
       * 为什么不能用布尔 pageDead：
       *   onEnter 把 pageDead 置 false 会引入竞态 —— 用户点下载后立刻切走，
       *   此时 invoke 还没返回、jobId 仍是 null，cleanup 杀不到任何东西；
       *   等返回时 pageDead 已被 onEnter 复位成 false，那个 job 就漏杀了，
       *   变成后台孤儿下载（用户以为切页就取消了）。
       * 序号方案没有这个窗口：cleanup 递增序号后，任何**旧**请求返回时
       * 序号必然不等，于是无条件 kill 它自己拿到的 id；新请求领的是新序号，
       * 不会被误杀。 */
      let downloadRunSeq = 0;
      window.App.onCleanup(() => {
        downloadRunSeq++;
        dropSub();
        if (jobId) { invoke(Channels.CHANNELS.JOB.KILL, jobId).catch(() => {}); jobId = null; }
        /* 界面复位：复用回来后不该停在"下载中"的灰按钮状态 */
        try { startBtn.disabled = false; stopBtn.disabled = true; } catch (e) {}
      });
      async function start() {
        /* 重入保护：上一次的订阅必须先退掉，否则同一页面会同时有两个
         * job:stream 监听器认领同一批事件（进度条被写两遍）。
         * 【这里写内联退订而不是 dropSub()】start() 会被
         * scripts/test-download-finish.js 单独抠出来求值（它验的是
         * "抛错后界面要复位"），而 dropSub 定义在 start 之外、那个环境里
         * 不存在。内联写法让 start 自包含，测试与实现不必互相迁就。
         * 语义与 dropSub 完全一致（退订 + 置空）。 */
        if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
        const runToken = ++downloadRunSeq;
        const url = urlIn.value.trim();
        if (!/^https?:\/\//.test(url)) return toast('请输入 http(s) 直链', 'warn');
        let out = fileIn.value.trim();
        if (!out) {
          const info = await invoke(Channels.CHANNELS.APP.GET_INFO).catch(() => null);
          out = (info && info.userData ? info.userData : 'C:/Users/Public/Downloads') + '/' + safeNameFromUrl(url);
        }
        prog.show(); status.textContent = '连接中…';
        startBtn.disabled = true; stopBtn.disabled = false;
        /* job:stream 是全局通道，TTS/卸载/媒体转换等任务结束时都会广播 {done:true}。
           而 net:download 的 id 要等 invoke 返回才有，注册监听时还拿不到 ——
           所以先记下「本次下载的 id 前缀」：主进程用 'dlg' 前缀生成下载任务 id
           （原来是 'dl2'，而 'dl' 是它的真前缀，`dl2123` 会被 FFmpeg 下载页
           误认为是自己的任务，已改成不等长的 dlg），
           监听里只认这个前缀 + 已知 id，别的事件一律忽略，避免被别的任务提前判完成。 */
        /* 【myPrefixSeen 已删除】改用 JobPrefix.subscribe('dlg')，
         * 它内部维护 claimedId，语义与原来的 "先认领前缀、之后严格比对" 完全一致；
         * 外层这里只剩 jobId 的业务比对（jobId 是 invoke 返回后才有的，
         * 用于「取消」时传 job:kill）。 */
        unsub = window.JobPrefix.subscribe('dlg', (d) => {
          try {
            const j = JSON.parse(d.data);
            /* 【取消按钮不能依赖 invoke 返回值】
             * jobId 要等 net:download 返回（主进程真的开始下载）才有，
             * 而第一条 job:stream 往往比这个返回值更早到。
             * 不在事件里认领的话，那段时间点「取消」毫无反应 ——
             * 用户看到进度在动、按钮却是死的。
             * 认领后 job:kill 立刻有对象可杀（与 av-convert.js 同一做法）。 */
            if (!jobId) jobId = d.id;
            if (jobId && d.id !== jobId) return;
            if (j.pct != null) { prog.set(j.pct); status.textContent = `${(j.mb || 0).toFixed(1)} / ${(j.totalMB || 0).toFixed(1)} MB（${(j.pct || 0).toFixed(0)}%）`; }
            if (j.label && j.pct == null) status.textContent = j.label;
            if (j.done) {
              startBtn.disabled = false; stopBtn.disabled = true; jobId = null;
              prog.hide();
              status.textContent = j.ok ? `✓ 已保存：${j.out || out}` : '✗ ' + (j.error || '失败');
              if (j.ok) toast('下载完成：' + (j.out || out), 'success');
              /* 【任务结束必须退订】不论成功失败，这条下载已经不会再发事件；
               * 不退订就会一直挂着，累积成监听器泄漏。
               * 内联写法同 start 开头（避免依赖 start 外层的 dropSub）。 */
              if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
            }
          } catch (e) {}
        });
        /* 【invoke 必须有收尾，否则失败后界面永久卡死】
         * 主进程在两种情况下会抛错：保存路径命中 checkOverwritable（选了系统关键目录），
         * 或 fs.existsSync(out) 为真（目标已存在）。最容易踩的是第二条 ——
         * 保存路径留空时 out 由 url 推导，**同一个 URL 下载第二次必然撞上**。
         * 原来这里是裸 await：抛错后
         *   · 产生一个未捕获 rejection；
         *   · 状态永远停在「连接中…」；
         *   · 开始按钮永久置灰（没有 finally 复位）；
         *   · 取消按钮因为 jobId 还是 null 而完全无效；
         *   · unsub 泄漏到下一次进页面（切页时 onCleanup 已跑过）。
         * 现在把整段包进 try/finally，失败路径也要把界面还回可用状态。 */
        /* 【订阅之前再判一次 token】
         * GET_INFO 是一个 await：用户可能在这段时间里离开页面（cleanup 已经
         * downloadRunSeq++ 并 dropSub）。此时若继续往下走，会**在页面已离开
         * 之后新建一个订阅** —— 那个订阅没有任何人负责退订（cleanup 早就跑完了），
         * 永久残留并持有旧 DOM。所以这里必须提前拦下。 */
        if (runToken !== downloadRunSeq) { prog.hide(); return; }
        try {
          const r = await invoke(Channels.CHANNELS.NET.DOWNLOAD, { url, out });
          /* 【过期检查：这趟已作废就彻底收尾，不能只 kill】
           * 典型场景：点下载后立刻切页 —— invoke 还没返回时 cleanup 已跑过、
           * jobId 是 null 所以没杀到东西。而这时**首条 job:stream 可能已经把
           * jobId 写成非空**（流事件比 invoke 返回早）。
           * 原实现 stale 分支只 kill 就 return，随后 finally 看到 jobId 非空
           * 就不做任何清理 —— 结果是：任务被杀了，但监听器、进度条、
           * 按钮状态全部残留，界面永远停在"下载中"。
           * 所以 stale 分支必须自己做完整收尾。 */
          if (runToken !== downloadRunSeq) {
            if (r && r.id) invoke(Channels.CHANNELS.JOB.KILL, r.id).catch(() => {});
            else if (jobId) invoke(Channels.CHANNELS.JOB.KILL, jobId).catch(() => {});
            jobId = null;
            if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
            prog.hide();
            return;
          }
          jobId = r.id;
        } catch (err) {
          /* 过期的那趟不弹错（用户已经不在这一页了） */
          if (runToken !== downloadRunSeq) return;
          status.textContent = '✗ ' + (window.api.errText ? window.api.errText(err) : (err && err.message) || '下载失败');
          toast('下载失败：' + ((err && err.message) || err), 'error');
        } finally {
          /* 无论成功失败都复位：这里的「成功」指的是**任务已受理**，
           * 真正的完成由 job:stream 的 j.done 分支处理（那时才隐藏进度条）。
           * 失败时任务根本没起来，按钮必须恢复可点，否则用户改完路径也点不动。
           * 【条件要点】不能只看 jobId：已过期的这趟必须**强制**收尾，
           * 否则流事件抢先写入的 jobId 会挡住清理。 */
          const stale = runToken !== downloadRunSeq;
          if (stale || !jobId) {
            startBtn.disabled = false; stopBtn.disabled = true;
            prog.hide();
            /* 失败/过期分支内联退订（同 start 开头的理由：保持 start 自包含） */
            if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
            if (stale) jobId = null;
          }
        }
      }
      page.appendChild(div('card', div('card-title', '下载'),
        div('form-row', urlIn),
        div('form-row', fileIn, pickBtn),
        div('form-row', startBtn, ' ', stopBtn, prog.el, status),
        div('field-hint', '支持断点续传与失败自动重试（6 次）')));
    }
  });
})();
