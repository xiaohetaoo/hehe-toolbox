/* 模块：网络运维 —— 网络信息 / Ping / 路由追踪 / 端口 / Hosts / 测速 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, renderTable, fmtBytes } = window.ui;
  const { invoke, on, isDesktop } = window.api;
  const MOD = 'net';

  /* 从 URL 推出安全的保存文件名。
   *
   * 原实现：name = decodeURIComponent(url.split('?')[0].split('/').pop())
   *   恶意/特殊 URL 里的 %2F..%2F..%2F 会被还原成 /../../，
   *   拼到 userData 后面就逃出目录，覆盖任意位置的文件。
   *   例如 .../a%2F..%2F..%2FWindows%2Fwin.ini -> 可以写到 C:\Windows 附近。
   *
   * 现在：先解码，然后只取 basename，并逐项挡掉 Windows 危险名。
   * 与主进程 lib/path-guard.js 的 checkFileName 保持同一套规则。 */
  const BAD_NAME_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  function safeNameFromUrl(url) {
    let raw = '';
    try { raw = decodeURIComponent(String(url).split('?')[0].split('#')[0].split('/').pop() || ''); } catch (e) { raw = ''; }
    // 只保留最后一段（挡掉解码后出现的 / 和 \）
    raw = raw.split(/[\\/]/).pop() || '';
    // 去掉控制字符与 Windows 非法字符
    raw = raw.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '');
    if (!raw || raw === '.' || raw === '..') return 'download.bin';
    // 保留设备名但改成可用的名字
    const base = raw.split('.')[0];
    if (BAD_NAME_BASE.test(base)) raw = '_' + raw;
    if (raw.length > 180) {
      const dot = raw.lastIndexOf('.');
      const ext = dot > 0 ? raw.slice(dot) : '';
      raw = raw.slice(0, 180 - ext.length) + ext;
    }
    return raw;
  }

  /* ---------- 网络信息查询 ---------- */
  register({
    id: 'net-info', name: '网络信息查询', module: MOD, icon: 'globe',
    desc: '内网 IP、网关、DNS、MAC、DHCP 与公网 IP 查询',
    keywords: ['ip', '网络', 'dns', 'mac', '网关'],
    render(page) {
      const result = div('');
      result.appendChild(window.ui.loadingBlock('读取网络配置…'));
      const pubBtn = btn('查询公网 IP（联网）', 'btn-secondary btn-sm', async () => {
        pubEl.textContent = '查询中…';
        try { const r = await invoke('net:public-ip'); pubEl.textContent = r.ip; }
        catch (e) { pubEl.textContent = '查询失败：' + e.message; }
      });
      const pubEl = h('span', { class: 'mono', style: { userSelect: 'text' } }, '-');
      invoke('net:interfaces').then(r => {
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
      }).catch(e => { result.innerHTML = `<div class="field-err">${escapeHtml(e.message)}</div>`; });
      function icon(n) { const t = document.createElement('span'); t.innerHTML = window.iconSvg(n); return t.firstChild; }
      page.appendChild(div('card', div('card-title', '公网 IP（需主动联网查询）'), pubBtn, ' ', pubEl));
      page.appendChild(result);
    }
  });

  /* ---------- Ping 测试 ---------- */
  register({
    id: 'ping-test', name: 'Ping 测试', module: MOD, icon: 'activity',
    desc: '连续 Ping、丢包率统计、延迟实时曲线',
    keywords: ['ping', '延迟', '丢包'],
    render(page) {
      const hostIn = h('input', { class: 'input mono', value: 'www.baidu.com', style: { flex: '1' } });
      const canvas = h('canvas', { style: { width: '100%', height: '180px' } });
      const term = div('term', '');
      const statsEl = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px', margin: '12px 0' } });
      let jobId = null, chart = window.ui.lineChart(canvas, { max: null });
      window.App.onCleanup(() => {
        if (unsubStream) try { unsubStream(); } catch (e) {}
        if (unsubExit) try { unsubExit(); } catch (e) {}
        if (jobId) invoke('job:kill', jobId).catch(() => {});
      });
      let latencies = [], sent = 0, recv = 0, running = false;
      let unsubStream, unsubExit;
      const startBtn = btn('▶ 开始 Ping', 'btn-primary', start);
      const stopBtn = btn('■ 停止 Ping', 'btn-danger-plain', stop);
      stopBtn.disabled = true;
      function updateStats() {
        const min = latencies.length ? Math.min(...latencies) : 0;
        const max = latencies.length ? Math.max(...latencies) : 0;
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
        // ping -t 永不自行退出：重复点「开始」必须先杀掉上一个，
        // 否则残留进程一直跑，而 stop() 只认最新的 jobId，旧进程再也取消不掉。
        if (jobId) { try { await invoke('job:kill', jobId); } catch (e) {} jobId = null; }
        running = true; sent = 0; recv = 0; latencies = [];
        term.innerHTML = ''; startBtn.disabled = true; stopBtn.disabled = false;
        try {
          jobId = await invoke('exec:stream', { command: 'ping', args: ['-t', host] });
        } catch (e) {
          // 原来没兜底：exec 失败时按钮永久 disabled、状态停在「进行中」，只能切页恢复
          running = false; startBtn.disabled = false; stopBtn.disabled = true;
          status.textContent = '✗ ' + e.message;
          toast(e.message, 'error');
          return;
        }
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
          chart.draw(latencies, { max: Math.max(50, ...latencies) * 1.2 });
        });
        unsubExit = on('job:exit', (d) => { if (d.id === jobId) { running = false; startBtn.disabled = false; stopBtn.disabled = true; } });
      }
      async function stop() {
        if (jobId) { try { await invoke('job:kill', jobId); } catch (e) {} }
        running = false;
        startBtn.disabled = false; stopBtn.disabled = true;
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
    id: 'tracert', name: '路由追踪', module: MOD, icon: 'branch',
    desc: 'Traceroute 路径追踪，展示每跳延迟',
    keywords: ['tracert', 'traceroute', '路由'],
    render(page) {
      const hostIn = h('input', { class: 'input mono', value: 'www.baidu.com', style: { flex: '1' } });
      const noDns = h('input', { type: 'checkbox', class: 'checkbox' });
      const term = div('term', '');
      let jobId = null, unsubStream, unsubExit;
      window.App.onCleanup(() => {
        if (unsubStream) try { unsubStream(); } catch (e) {}
        if (unsubExit) try { unsubExit(); } catch (e) {}
        if (jobId) invoke('job:kill', jobId).catch(() => {});
      });
      const startBtn = btn('▶ 开始追踪', 'btn-primary', async () => {
        if (!isDesktop) return toast('桌面端可用', 'warn');
        const host = hostIn.value.trim();
        if (!host) return;
        term.innerHTML = ''; startBtn.disabled = true;
        const args = noDns.checked ? ['-d', '-h', '30', host] : ['-h', '30', host];
        jobId = await invoke('exec:stream', { command: 'tracert', args });
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
        unsubExit = on('job:exit', (d) => { if (d.id === jobId) startBtn.disabled = false; });
      });
      page.appendChild(div('card', div('card-title', '目标'),
        div('form-row', hostIn, h('label', { class: 'field-hint' }, noDns, ' 不解析域名（更快）'), startBtn)));
      page.appendChild(div('card', div('card-title', '路径'), term));
    }
  });

  /* ---------- 端口占用查询 ---------- */
  register({
    id: 'port-occupy', name: '端口占用查询', module: MOD, icon: 'plug',
    desc: '查询本机端口占用的进程，一键结束释放端口',
    keywords: ['端口', '占用', 'netstat', '杀进程'],
    render(page) {
      const portIn = h('input', { class: 'input mono input-sm', placeholder: '端口号（留空显示全部监听）', style: { width: '220px' } });
      const result = div('');
      async function query() {
        try {
        result.innerHTML = '';
        result.appendChild(window.ui.loadingBlock('查询 netstat…'));
        const r = await invoke('exec:run', { cmd: 'netstat -ano -p tcp', shellType: 'cmd', timeoutMs: 15000 });
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
        const procs = await invoke('proc:list').catch(() => []);
        const nameMap = new Map(procs.map(p => [p.pid, p.name]));
        const table = renderTable({
          columns: [
            { key: 'proto', title: '协议', width: '70px' },
            { key: 'local', title: '本地地址', render: r => div('mono', null, r.local) },
            { key: 'state', title: '状态', width: '110px', render: r => h('span', { class: r.state === 'LISTENING' ? 'tag tag-green' : 'tag tag-blue' }, r.state) },
            { key: 'pid', title: 'PID', width: '80px' },
            { key: 'name', title: '进程', render: r => nameMap.get(r.pid) || '-' },
            { key: 'act', title: '操作', width: '170px', render: (r, td) => {
                const b1 = btn('任务管理器', 'btn-sm btn-text', () => invoke('exec:stream', { command: 'taskmgr.exe' }).catch(() => toast('启动失败', 'error')));
                const b2 = btn('结束进程', 'btn-sm btn-danger-plain', async () => {
                  if (!(await window.ui.confirmBox({ title: '结束进程', message: `结束 PID ${r.pid}（${nameMap.get(r.pid) || '未知'}）？这可能导致数据丢失。`, danger: true, okText: '结束' }))) return;
                  try { await invoke('proc:kill', r.pid); toast('已结束', 'success'); query(); }
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
    id: 'port-test', name: '端口连通测试', module: MOD, icon: 'plug',
    desc: '测试远程主机指定端口是否开放',
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
          const r = await invoke('net:tcp-test', hostIn.value.trim(), parseInt(portIn.value), 5000);
          result.style.color = r.open ? 'var(--success)' : 'var(--danger)';
          result.textContent = r.open ? `✓ 端口开放（连接耗时 ${r.ms}ms）` : '✗ 端口不通或被拒绝';
        } catch (e) { result.textContent = '✗ ' + e.message; result.style.color = 'var(--danger)'; }
      }
      page.appendChild(div('card', div('card-title', '测试目标'),
        div('form-row', hostIn, h('span', { class: 'form-label', style: { minWidth: 'auto' } }, ':'), portIn,
          btn('测试', 'btn-primary', test)), result));
    }
  });

  /* ---------- 本机端口扫描 ---------- */
  register({
    id: 'port-scan', name: '本机端口扫描', module: MOD, icon: 'target',
    desc: '扫描本机/指定主机开放端口与常见服务',
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
          const r = await invoke('net:scan', hostIn.value.trim(), ports, { concurrency: 400, timeout: 600 });
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
        } catch (e) { status.textContent = '✗ ' + e.message; }
      }
      preset.addEventListener('change', () => { rangeIn.value = preset.value; });
      page.appendChild(div('card', div('card-title', '扫描目标'),
        div('form-row', h('span', { class: 'form-label' }, '主机'), hostIn, ' ', preset),
        div('form-row', h('span', { class: 'form-label' }, '范围'), rangeIn, btn('开始扫描', 'btn-primary', scan)), status));
      page.appendChild(result);
    }
  });

  /* ---------- Hosts 编辑 ---------- */
  register({
    id: 'hosts-edit', name: 'Hosts 编辑', module: MOD, icon: 'file-text',
    desc: '快速编辑系统 Hosts，支持备份还原（写入需管理员权限）',
    keywords: ['hosts', '域名', '解析'],
    render(page) {
      const ta = h('textarea', { class: 'pane-ta mono', style: { minHeight: '320px', fontSize: '12.5px' } });
      const pathEl = div('field-hint', '');
      const status = h('div', { class: 'field-hint' }, '');
      async function load() {
        try {
          const r = await invoke('hosts:read');
          ta.value = r.content;
          pathEl.textContent = r.path;
        } catch (e) { toast(e.message, 'error'); }
      }
      const saveBtn = btn('💾 保存并刷新 DNS', 'btn-primary', async () => {
        try {
          await invoke('hosts:write', ta.value);
          status.innerHTML = '<span class="status-ok">✓ 已保存并刷新 DNS 缓存</span>';
          toast('Hosts 已保存', 'success');
        } catch (e) {
          status.innerHTML = `<span class="status-err">✗ ${escapeHtml(e.message)}</span><br><span class="field-hint">提示：修改 hosts 需要管理员权限，请以管理员身份运行核核工具箱后再试。</span>`;
          toast('保存失败：' + e.message, 'error');
        }
      });
      const bakBtn = btn('备份当前', 'btn-sm btn-secondary', async () => {
        try { const r = await invoke('hosts:backup'); toast('已备份：' + r.name, 'success'); } catch (e) { toast(e.message, 'error'); }
      });
      const restoreBtn = btn('从备份还原…', 'btn-sm btn-secondary', async () => {
        try {
          const list = await invoke('hosts:backups');
          if (!list.length) return toast('暂无备份', 'warn');
          const p = await invoke('dialog:open', { defaultPath: list[0], properties: ['openFile'] });
          if (!p || !p[0]) return;
          if (!(await window.ui.confirmBox({ title: '还原 Hosts', message: '将用备份覆盖当前 hosts 文件，确定？' }))) return;
          await invoke('hosts:restore', p[0]); toast('已还原', 'success'); load();
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
    id: 'speedtest', name: '网速测试', module: MOD, icon: 'wifi',
    desc: '下载/上传带宽测速（Cloudflare 节点，主动触发联网）',
    keywords: ['网速', '带宽', '测速'],
    render(page) {
      const canvas = h('canvas', { style: { width: '100%', height: '180px' } });
      const chart = window.ui.lineChart(canvas, { max: null });
      const downEl = h('div', { class: 'stat-num' }, '--');
      const upEl = h('div', { class: 'stat-num' }, '--');
      const status = h('span', { class: 'field-hint' }, '');
      let samples = [];
      let unsub;
      const downBtn = btn('⬇ 测下载', 'btn-primary', () => run('down'));
      const upBtn = btn('⬆ 测上传', 'btn-secondary', () => run('up'));
      async function run(dir) {
        if (!isDesktop) return toast('桌面端可用（需联网）', 'warn');
        if (unsub) { try { unsub(); } catch (e) {} unsub = null; } // 防连点：先退订上一轮
        downBtn.disabled = upBtn.disabled = true;
        status.textContent = '测试中…'; samples = [];
        /* job:stream 是全局通道，必须只认本次测速的 id，
           否则别的任务发来的 samples 会被画到这条曲线上。 */
        let speedId = null;
        unsub = on('job:stream', (d) => {
          try {
            if (d.id) { if (!speedId) speedId = d.id; else if (d.id !== speedId) return; }
            const j = JSON.parse(d.data);
            if (j.samples && j.samples.length) {
              samples = j.samples.map(s => s.mbps);
              chart.draw(samples, { max: Math.max(10, ...samples) * 1.3 });
            }
          } catch (e) {}
        });
        try {
          const r = await invoke('net:speedtest', { direction: dir, seconds: 10 });
          const mbps = r.mbps;
          if (dir === 'down') downEl.textContent = mbps.toFixed(1);
          else upEl.textContent = mbps.toFixed(1);
          status.textContent = `完成：${fmtBytes(r.bytes)} / ${r.elapsed.toFixed(1)}s`;
          if (r.samples && r.samples.length) { samples = r.samples.map(s => s.mbps); chart.draw(samples, { max: Math.max(10, ...samples) * 1.3 }); }
        } catch (e) { status.textContent = '✗ ' + e.message; }
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
    id: 'wifi-password', name: 'WiFi 密码查看', module: MOD, icon: 'wifi',
    desc: '列出本机已保存的 WiFi 并查看其连接密码',
    keywords: ['wifi', '密码', '无线', 'wlan'],
    render(page) {
      const listBox = div('');
      const status = h('span', { class: 'field-hint' }, '');
      const refreshBtn = btn('🔄 重新加载', 'btn-sm btn-secondary', load);
      async function load() {
        listBox.innerHTML = '';
        listBox.appendChild(window.ui.loadingBlock('读取已保存的 WiFi…'));
        try {
          const r = await invoke('wifi:profiles');
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
                const k = await invoke('wifi:key', name);
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
    id: 'downloader', name: '文件下载', module: MOD, icon: 'download',
    desc: '下载直链文件：断点续传、自动重试、实时进度',
    keywords: ['下载', 'download', '直链', 'url'],
    render(page) {
      const urlIn = h('input', { class: 'input mono', placeholder: 'https://… 直链地址', style: { flex: '1' } });
      const fileIn = h('input', { class: 'input input-sm', placeholder: '保存路径（留空 = 数据目录/文件名）', style: { flex: '1' } });
      const pickBtn = btn('选择…', 'btn-sm btn-secondary', async () => {
        const p = await invoke('dialog:save', {});
        if (p) fileIn.value = p;
      });
      const prog = progressEl(); prog.hide();
      const status = h('span', { class: 'field-hint' }, '');
      const startBtn = btn('⬇ 开始下载', 'btn-primary', start);
      const stopBtn = btn('■ 取消', 'btn-danger-plain', () => { if (jobId) invoke('job:kill', jobId).catch(() => {}); });
      stopBtn.disabled = true;
      let jobId = null, unsub = null, pageDead = false;
      window.App.onCleanup(() => {
        pageDead = true;
        if (unsub) try { unsub(); } catch (e) {}
        if (jobId) invoke('job:kill', jobId).catch(() => {});
      });
      async function start() {
        const url = urlIn.value.trim();
        if (!/^https?:\/\//.test(url)) return toast('请输入 http(s) 直链', 'warn');
        let out = fileIn.value.trim();
        if (!out) {
          const info = await invoke('app:get-info').catch(() => null);
          out = (info && info.userData ? info.userData : 'C:/Users/Public/Downloads') + '/' + safeNameFromUrl(url);
        }
        prog.show(); status.textContent = '连接中…';
        startBtn.disabled = true; stopBtn.disabled = false;
        /* job:stream 是全局通道，TTS/卸载/媒体转换等任务结束时都会广播 {done:true}。
           而 net:download 的 id 要等 invoke 返回才有，注册监听时还拿不到 ——
           所以先记下「本次下载的 id 前缀」：主进程用 'dl2' 前缀生成下载任务 id，
           监听里只认这个前缀 + 已知 id，别的事件一律忽略，避免被别的任务提前判完成。 */
        let myPrefixSeen = null;
        unsub = window.api.on('job:stream', (d) => {
          try {
            const j = JSON.parse(d.data);
            // 还没拿到 jobId 时，只接受下载形态的 id；拿到之后严格比对
            if (jobId) { if (d.id !== jobId) return; }
            else {
              if (!d.id || !/^dl2/.test(String(d.id))) return;
              if (!myPrefixSeen) myPrefixSeen = d.id;
              else if (d.id !== myPrefixSeen) return;
            }
            if (j.pct != null) { prog.set(j.pct); status.textContent = `${(j.mb || 0).toFixed(1)} / ${(j.totalMB || 0).toFixed(1)} MB（${(j.pct || 0).toFixed(0)}%）`; }
            if (j.label && j.pct == null) status.textContent = j.label;
            if (j.done) {
              startBtn.disabled = false; stopBtn.disabled = true; jobId = null;
              prog.hide();
              status.textContent = j.ok ? `✓ 已保存：${j.out || out}` : '✗ ' + (j.error || '失败');
              if (j.ok) toast('下载完成：' + (j.out || out), 'success');
            }
          } catch (e) {}
        });
        const r = await invoke('net:download', { url, out });
        jobId = r.id;
        if (pageDead && jobId) invoke('job:kill', jobId).catch(() => {});
      }
      page.appendChild(div('card', div('card-title', '下载'),
        div('form-row', urlIn),
        div('form-row', fileIn, pickBtn),
        div('form-row', startBtn, ' ', stopBtn, prog.el, status),
        div('field-hint', '支持断点续传与失败自动重试（6 次）')));
    }
  });
})();
