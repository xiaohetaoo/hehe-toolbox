/* 模块：系统与硬件 —— 硬件信息 / 监控 / 进程 / 自启 / 磁盘 / 垃圾 / 空目录 / 快捷操作 */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
  const { escapeHtml, div, btn, icon, toast, copyText, confirmBox, renderTable, fmtBytes, fmtNum, fmtDate, progressEl } = window.ui;
  const { invoke, on, isDesktop } = window.api;
  const MOD = 'system';

  /* ---------- 硬件信息总览 ---------- */
  register({
    id: 'hw-info', name: '硬件信息总览', nameEn: 'Hardware Info', module: MOD, icon: 'cpu',
    desc: 'CPU、内存、硬盘、显卡、主板、网卡与电池信息', descEn: 'Overview of CPU, memory, GPU, disks and the operating system',
    keywords: ['硬件', 'cpu', '显卡', '主板'],
    render(page) {
      const body = div('');
      body.appendChild(window.ui.loadingBlock('读取硬件信息（首次约需 2-3 秒）…'));
      let loadSeq = 0; // 快速连点刷新时丢弃过期加载
      async function load(force) {
        const t = ++loadSeq;
        body.innerHTML = '';
        body.appendChild(window.ui.loadingBlock('读取硬件信息（首次约需 2-3 秒）…'));
        try {
          const info = await invoke(Channels.CHANNELS.SYS.HW_INFO, !!force);
          if (t !== loadSeq) return;
          body.innerHTML = '';
          body.appendChild(sectionCard('处理器 CPU', [
            ['型号', info.cpu.Name], ['物理核心', info.cpu.NumberOfCores], ['逻辑核心', info.cpu.NumberOfLogicalProcessors],
            ['基准频率', info.cpu.MaxClockSpeed ? (info.cpu.MaxClockSpeed + ' MHz') : '-'], ['当前负载', info.cpu.LoadPercentage != null ? info.cpu.LoadPercentage + '%' : '-']
          ], 'cpu'));
          body.appendChild(sectionCard('内存', [
            ['总容量', fmtBytes(info.memTotal)], ['可用', fmtBytes(info.memFree)],
            ['已用', fmtBytes(info.memTotal - info.memFree) +
              // memTotal 为 0/缺失时（虚拟机、WMI 异常返回）不能显示 NaN%
              (info.memTotal > 0 ? `（${((1 - info.memFree / info.memTotal) * 100).toFixed(0)}%）` : '')]
          ], 'monitor'));
          body.appendChild(sectionCard('显卡', info.gpu.map(g => [g.Name, `驱动 ${g.DriverVersion || '-'}`]), 'monitor'));
          body.appendChild(sectionCard('硬盘', info.disks.map(d => [d.Model, d.Size ? fmtBytes(Number(d.Size)) + `（${d.InterfaceType || ''}）` : '-']), 'harddrive'));
          body.appendChild(sectionCard('分区', info.partitions.filter(p => p.type === 3).map(p =>
            [p.drive + ' ' + p.label, `${fmtBytes(p.size)} 总 / ${fmtBytes(p.free)} 可用`])));
          body.appendChild(sectionCard('主板与 BIOS', [
            ['主板', `${info.board.Manufacturer || '-'} ${info.board.Product || ''}`],
            ['BIOS', `${info.bios.Manufacturer || '-'} ${info.bios.SMBIOSBIOSVersion || ''}`]
          ]));
          body.appendChild(sectionCard('网卡', info.nic.map(n => [n.Name, n.MACAddress || '-'])));
          body.appendChild(sectionCard('操作系统', [
            ['系统', info.os.Caption], ['版本', `${info.os.Version} (${info.os.BuildNumber}) ${info.os.OSArchitecture || ''}`],
            ['上次启动', fmtBoot(info.os.LastBootUpTime)],
            ['运行时长', fmtTimeDur(info.uptimeS)]
          ]));
          if (info.battery && info.battery.EstimatedChargeRemaining != null) {
            const batRows = [
              ['电量', info.battery.EstimatedChargeRemaining + '%'],
              ['状态', info.battery.BatteryStatus === 2 ? '接通电源' : '使用电池']
            ];
            try {
              const bat = await invoke(Channels.CHANNELS.SYS.BATTERY_DETAIL);
              if (t !== loadSeq) return;
              if (bat && bat.designCap) {
                batRows.push(['设计容量', bat.designCap + ' mWh']);
                batRows.push(['当前满充容量', bat.fullCap + ' mWh']);
                batRows.push(['电池健康度', h('span', { class: bat.health >= 80 ? 'status-ok' : bat.health >= 60 ? 'status-warn' : 'status-err' }, String(bat.health) + '%')]);
              }
            } catch (e) {}
            body.appendChild(sectionCard('电池', batRows));
          }
          if (info.temps && info.temps.length) {
            /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
            body.appendChild(sectionCard('温度', info.temps.map(t => [t.name, t.celsius + ' °C'])));
          }
        } catch (e) {
          if (t !== loadSeq) return;
          body.innerHTML = '';
          body.appendChild(div('field-err', '✗ ' + (e && e.message ? e.message : e)));
        }
      }
      function fmtTimeDur(s) {
        const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
        return (d ? d + ' 天 ' : '') + h + ' 小时 ' + m + ' 分钟';
      }
      /* 【日期字段必须防 NaN】
       * 主进程现在已经把 LastBootUpTime 解析成毫秒数字（修在数据出口，
       * 见 main.js 的 parsePsDate）。这里再兜一层，因为：
       *   · 老版本主进程 / 别的调用方可能仍然传 "/Date(...)/" 字符串；
       *   · null、空串、"NaN" 之类都会让 new Date(...).getTime() 得到 NaN，
       *     而 fmtDate 内部一串 getFullYear/getMonth 会把它渲染成
       *     "NaN-NaN-NaN NaN:NaN:NaN" —— 用户看到的是乱码而不是「取不到」。
       * 拿不到就显示 "-"，这是项目一贯的诚实原则。 */
      function fmtBoot(v) {
        if (v == null || v === '') return '-';
        let ms;
        if (typeof v === 'number') ms = v;
        else {
          const s = String(v).trim();
          const m = s.match(/^\/Date\(([-+]?\d+)\)\/$/);   // PS 5.1 的形态
          ms = m ? Number(m[1]) : new Date(s).getTime();
        }
        if (!Number.isFinite(ms)) return '-';
        return fmtDate(ms);
      }
      /* 标题左侧的图标走统一的 SVG 图标库（用 card-title 自带的主色图标位），
       * 不再往标题文字里塞 emoji —— emoji 的字重、基线、颜色都不受控，
       * 在本项目的深色主题下还会被系统换成彩色字形，和整套线性图标对不上。 */
      function sectionCard(title, pairs, iconName) {
        const card = div('card');
        card.appendChild(div('card-title', null, iconName ? icon(iconName) : null, title));
        card.appendChild(window.ui.kvGrid(pairs.length ? pairs : [['-', '-']]));
        return card;
      }
      page.appendChild(div('card', div('card-title', '硬件概览'), btn('刷新', 'btn-sm btn-secondary', () => load(true), 'refresh')));
      page.appendChild(body);
      load(false);
    }
  });

  /* ---------- 实时状态监控 ---------- */
  register({
    id: 'monitor', name: '实时状态监控', nameEn: 'Live Monitor', module: MOD, icon: 'activity',
    desc: 'CPU / 内存实时曲线与磁盘用量，阈值变色提醒', descEn: 'Real-time CPU, memory, disk and network charts',
    keywords: ['监控', 'cpu', '内存', '曲线'],
    render(page) {
      const cpuCanvas = h('canvas', { style: { width: '100%', height: '180px' } });
      const memCanvas = h('canvas', { style: { width: '100%', height: '180px' } });
      const cpuChart = window.ui.lineChart(cpuCanvas, {});
      const memChart = window.ui.lineChart(memCanvas, {});
      const cpuNow = h('div', { class: 'stat-num' }, '--');
      const memNow = h('div', { class: 'stat-num' }, '--');
      const diskBox = div('');
      const cpuHist = [], memHist = [];
      /* 【订阅必须可重入】cleanup 会退订，而保活复用时界面不会重新 render ——
       * 不退订会泄漏，退订后不重绑则曲线永久冻结。
       * 所以抽成 bindStats()：每次先退旧的再挂新的（幂等），
       * onEnter 时重新调用即可。 */
      let unsubStats = null;
      function bindStats() {
        if (unsubStats) { try { unsubStats(); } catch (e) {} unsubStats = null; }
        unsubStats = on('sys:stats', (s) => {
          cpuHist.push(s.cpu); memHist.push(s.memPct);
          if (cpuHist.length > 120) cpuHist.shift();
          if (memHist.length > 120) memHist.shift();
          cpuNow.textContent = s.cpu.toFixed(1);
          memNow.textContent = s.memPct.toFixed(1);
          cpuNow.style.color = s.cpu >= 80 ? 'var(--warning)' : 'var(--primary)';
          memNow.style.color = s.memPct >= 80 ? 'var(--warning)' : 'var(--primary)';
          cpuChart.draw(cpuHist, {});
          memChart.draw(memHist, {});
        });
      }
      /* 磁盘信息也抽成函数：复用回来时刷新一次（容量可能已经变了） */
      function loadDisks() {
        return invoke(Channels.CHANNELS.SYS.HW_INFO).then(info => {
          diskBox.innerHTML = '';
          for (const p of info.partitions.filter(x => x.type === 3 && x.size > 0)) {
            const usedPct = (1 - p.free / p.size) * 100;
            diskBox.appendChild(div('form-row',
              h('span', { class: 'form-label', style: { minWidth: '60px' } }, p.drive),
              h('div', { class: 'progress', style: { flex: '1' } }, h('div', { class: 'progress-fill', style: { width: usedPct + '%', background: usedPct >= 90 ? 'var(--danger)' : usedPct >= 70 ? 'var(--warning)' : 'var(--primary)' } })),
              h('span', { class: 'field-hint', style: { width: '180px' } }, `${fmtBytes(p.size - p.free)} / ${fmtBytes(p.size)}（${usedPct.toFixed(0)}%）`)));
          }
        }).catch((e) => {
          /* 【不能只写 .catch(() => {})】
           * 读硬件信息失败时（WMI 被策略禁用、磁盘刚拔出等），原来这条空 catch
           * 会让「磁盘用量」卡片永远是空白 —— 用户看着一个空卡片，既不知道是
           * 还在加载、还是这台机器没有磁盘、还是查询失败。如实写一句原因。 */
          diskBox.innerHTML = '';
          diskBox.appendChild(div('field-err', '✗ 读取磁盘分区失败：' + ((e && e.message) || String(e))));
        });
      }
      bindStats();
      loadDisks();
      page.appendChild(div('card', div('card-title', 'CPU 使用率'), h('div', { style: { marginBottom: '8px' } }, cpuNow, h('span', { class: 'stat-unit' }, '%')), cpuCanvas));
      page.appendChild(div('card', div('card-title', '内存使用率'), h('div', { style: { marginBottom: '8px' } }, memNow, h('span', { class: 'stat-unit' }, '%')), memCanvas));
      page.appendChild(div('card', div('card-title', '磁盘用量'), diskBox));
      window.App.onCleanup(() => {
        if (unsubStats) { try { unsubStats(); } catch (e) {} unsubStats = null; }
      });
      /* 【复用回来要重新订阅并刷新磁盘】否则曲线冻在离开那一刻，
       * 磁盘用量也不再更新 —— 用户以为监控卡死了。 */
      if (window.App.onEnter) {
        window.App.onEnter(() => { bindStats(); loadDisks(); });
      }
    }
  });

  /* ---------- 进程管理 ---------- */
  register({
    id: 'process-manager', name: '进程管理', nameEn: 'Process Manager', module: MOD, icon: 'list',
    desc: '进程列表搜索、按资源排序、查看路径、一键结束', descEn: 'List processes with CPU and memory, and end the ones you choose',
    keywords: ['进程', 'task', '结束进程'],
    render(page) {
      const searchIn = h('input', { class: 'input input-sm', placeholder: '搜索进程名…', style: { flex: '1' } });
      const box = div('');
      const status = h('span', { class: 'field-hint' }, '');
      let procs = [], sortKey = 'cpuPct', sortDir = -1;
      async function refresh() {
        status.textContent = '加载中…';
        try {
          procs = await invoke(Channels.CHANNELS.PROC.LIST);
          status.textContent = `共 ${procs.length} 个进程`;
          draw();
        } catch (e) { status.textContent = '✗ ' + e.message; }
      }
      function draw() {
        box.innerHTML = '';
        const q = searchIn.value.trim().toLowerCase();
        let data = q ? procs.filter(p => p.name.toLowerCase().includes(q)) : [...procs];
        data.sort((a, b) => ((b[sortKey] || 0) - (a[sortKey] || 0)) * (sortDir === -1 ? 1 : -1));
        const table = renderTable({
          columns: [
            { key: 'name', title: '进程名', sortable: true, sortVal: r => r.name, render: r => h('span', { style: { fontWeight: 500 } }, r.name) },
            { key: 'pid', title: 'PID', width: '80px', sortable: true },
            { key: 'cpuPct', title: 'CPU%', width: '80px', sortable: true, render: r => r.cpuPct != null ? h('span', { class: r.cpuPct > 30 ? 'status-err' : r.cpuPct > 10 ? 'status-warn' : '' }, String(r.cpuPct)) : '-' },
            { key: 'memKB', title: '内存', width: '100px', sortable: true, sortVal: r => r.memKB, render: r => fmtBytes(r.memKB * 1024) },
            { key: 'act', title: '操作', width: '200px', render: (r, td) => {
                td.appendChild(btn('详情', 'btn-sm btn-text', async () => {
                  try {
                    const d = await invoke(Channels.CHANNELS.PROC.DETAIL, r.pid);
                    const dlg = window.ui.modal({
                      title: `进程详情：${r.name} (${r.pid})`,
                      body: (b) => b.appendChild(window.ui.kvGrid([
                        ['进程名', r.name], ['PID', r.pid], ['内存', fmtBytes(r.memKB * 1024)],
                        ['累计 CPU 时间', r.cpu != null ? r.cpu.toFixed(2) + ' s' : '-'],
                        ['可执行路径', d.path || '-'], ['命令行', d.cmdline || '-']
                      ])),
                      /* 走 dlg.close() 而不是 closest('.modal-mask').remove()：
                       * 后者只摘节点、不清 ui.js 里的 openOverlays 记录，
                       * 会留下一个"幽灵遮罩"让下一次 Escape 落空。 */
                      foot: [h('button', { class: 'btn btn-primary', onclick: () => dlg.close() }, '关闭')]
                    });
                  } catch (e) { toast(e.message, 'error'); }
                }));
                td.appendChild(btn('结束', 'btn-sm btn-danger-plain', async () => {
                  if (!(await confirmBox({ title: '结束进程', message: `确定结束进程 ${r.name}（PID ${r.pid}）？未保存的数据可能丢失。`, danger: true, okText: '结束' }))) return;
                  try { await invoke(Channels.CHANNELS.PROC.KILL, r.pid); toast('已结束', 'success'); setTimeout(refresh, 500); }
                  catch (e) { toast(e.message, 'error'); }
                }));
              } }
          ],
          rows: data.slice(0, 300),
          empty: '无匹配进程'
        });
        box.appendChild(table);
        if (data.length > 300) box.appendChild(div('field-hint', `共 ${data.length} 个，显示前 300`));
      }
      searchIn.addEventListener('input', window.ui.debounce(draw, 200));
      const refreshBtn = btn('刷新', 'btn-sm btn-secondary', refresh, 'refresh');
      let autoTimer = null;
      const autoSw = window.ui.switchEl(false, (v) => {
        if (v) autoTimer = setInterval(refresh, 4000); else { clearInterval(autoTimer); autoTimer = null; }
      });
      /* 【清理必须把开关也打回 off】否则保活复用后界面显示「自动刷新(4s) 开」
       * 而 timer 早已被清掉 —— 用户以为在自动刷新，实际数据不再更新。
       * set(false) 同时同步 class 与 aria-checked（switchEl 两份状态）。 */
      window.App.onCleanup(() => {
        if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
        try { autoSw.set(false); } catch (e) {}
      });
      /* 【复用回来时按真实状态重刷视觉】见 security.js 同一处说明：
       * 不自动恢复刷新（用户切走时它是关的），只保证显示与实际一致。 */
      if (window.App.onEnter) {
        window.App.onEnter(() => {
          if (!autoTimer) { try { autoSw.set(false); } catch (e) {} }
        });
      }
      page.appendChild(div('card', div('card-title', '进程列表', status),
        div('form-row', searchIn, refreshBtn, h('label', { class: 'field-hint' }, autoSw, ' 自动刷新(4s)'))));
      page.appendChild(box);
      refresh();
    }
  });

  /* ---------- 开机自启管理 ---------- */
  register({
    id: 'autostart', name: '开机自启管理', nameEn: 'Startup Apps', module: MOD, icon: 'power',
    desc: '查看注册表自启项（可禁用/删除），并只读汇总启动文件夹、计划任务与自启服务', descEn: 'Manage registry startup entries; read-only view of Startup folders, scheduled tasks and auto services',
    keywords: ['自启', '启动项', '开机', '启动文件夹', '计划任务', '服务'],
    render(page) {
      const box = div('');
      const status = h('span', { class: 'field-hint' }, '');
      async function load() {
        box.innerHTML = '';
        status.textContent = '读取注册表…';
        try {
          const items = await invoke(Channels.CHANNELS.AUTOSTART.LIST);
          const disabled = await invoke(Channels.CHANNELS.AUTOSTART.DISABLED_LIST);
          status.textContent = `${items.length} 个自启项，${disabled.length} 个已禁用`;
          if (!items.length) { box.appendChild(div('empty-tip', '没有开机自启项')); return; }
          const table = renderTable({
            columns: [
              { key: 'name', title: '名称', render: r => h('span', { style: { fontWeight: 500 } }, r.name) },
              { key: 'label', title: '范围', width: '90px', render: r => h('span', { class: 'tag tag-gray' }, r.label) },
              { key: 'cmd', title: '命令', render: r => div('mono', { style: { fontSize: '11px' } }, r.cmd) },
              { key: 'act', title: '操作', width: '220px', render: (r, td) => {
                  td.appendChild(btn('禁用', 'btn-sm btn-text', async () => {
                    // 禁用 = 把注册表项移到本应用的备份区（可恢复），但仍是写注册表，
                    // 列表项多时容易点错，所以也确认一次，并说明如何恢复。
                    if (!(await confirmBox({
                      title: '禁用开机自启',
                      message: `禁用「${r.name}」的开机自启？\n\n该自启项会被移到本应用的备份区，之后可在下方「已禁用」列表里恢复启用。`,
                      okText: '禁用'
                    }))) return;
                    try { await invoke(Channels.CHANNELS.AUTOSTART.DELETE, r, false); toast('已禁用（可恢复）', 'success'); load(); }
                    catch (e) { toast(e.message, 'error'); }
                  }));
                  td.appendChild(btn('永久删除', 'btn-sm btn-danger-plain', async () => {
                    if (!(await confirmBox({ title: '永久删除自启项', message: `删除「${r.name}」的自启注册表项？此操作不可恢复。`, danger: true, okText: '删除' }))) return;
                    try { await invoke(Channels.CHANNELS.AUTOSTART.DELETE, r, true); toast('已删除', 'success'); load(); }
                    catch (e) { toast(e.message, 'error'); }
                  }));
                } }
            ],
            rows: items
          });
          box.appendChild(table);
          if (disabled.length) {
            const dCard = div('card');
            dCard.style.marginTop = '12px';
            dCard.appendChild(div('card-title', '已禁用（可恢复启用）'));
            for (const d of disabled) {
              dCard.appendChild(div('form-row', h('span', { style: { flex: '1' } }, d.name), h('span', { class: 'field-hint' }, d.label),
                btn('恢复启用', 'btn-sm btn-text', async () => {
                  try { await invoke(Channels.CHANNELS.AUTOSTART.ENABLE, d); toast('已启用', 'success'); load(); }
                  catch (e) { toast(e.message, 'error'); }
                })));
            }
            box.appendChild(dCard);
          }
        } catch (e) { status.textContent = '✗ ' + e.message; }
      }
      /* ---------- 其他自启来源（只读汇总） ----------
       * 启动文件夹 / 计划任务 / 自启服务同样会开机自动运行。
       * 这里**只展示、不代改**：删错计划任务能毁掉系统更新/备份/驱动安装，
       * 所以只给「打开对应系统界面」，改动留给用户在自己的工具里做。 */
      const extraBox = div('');
      const CAP = 40;
      function sectionCard(title, total, rows, emptyText) {
        const card = div('card', div('card-title', title,
          h('span', { class: 'field-hint' }, total + ' 个')));
        if (!rows.length) { card.appendChild(div('empty-tip', emptyText)); return card; }
        for (const r of rows) {
          card.appendChild(div('form-row',
            h('span', { class: 'mono', style: { flex: '1', wordBreak: 'break-all', fontSize: '12px' } }, r.name),
            r.meta ? h('span', { class: 'tag tag-gray' }, r.meta) : null,
            r.hint ? h('span', { class: 'field-hint', style: { fontSize: '11px' } }, r.hint) : null));
        }
        if (total > rows.length) card.appendChild(div('field-hint', `只显示前 ${rows.length} 个（共 ${total} 个）`));
        return card;
      }
      async function loadExtra() {
        extraBox.innerHTML = '';
        extraBox.appendChild(window.ui.loadingBlock('读取启动文件夹 / 计划任务 / 自启服务…'));
        let inv;
        try { inv = await invoke(Channels.CHANNELS.AUTOSTART.INVENTORY); }
        catch (e) { extraBox.innerHTML = ''; extraBox.appendChild(div('empty-tip', '读取失败：' + e.message)); return; }
        extraBox.innerHTML = '';
        const head = div('card', div('card-title', '其他自启来源（只读）'),
          div('field-hint', '这三类同样会开机自动运行，但改动需要系统工具或管理员权限 —— 本工具只做展示，不代改。'));
        for (const d of (inv.startupDirs || [])) {
          head.appendChild(div('form-row', h('span', { style: { fontWeight: 500 } }, d.label),
            h('span', { class: 'field-hint mono', style: { flex: '1', wordBreak: 'break-all', fontSize: '11px' } }, d.dir),
            d.exists ? btn('打开', 'btn-sm btn-text', () => invoke(Channels.CHANNELS.FS.OPEN_PATH, d.dir), 'external') : h('span', { class: 'tag tag-gray' }, '不存在')));
        }
        head.appendChild(div('form-row',
          btn('打开任务计划', 'btn-sm btn-secondary', () => invoke(Channels.CHANNELS.FS.OPEN_PATH, (inv.panels || {}).tasks), 'external'),
          btn('打开服务', 'btn-sm btn-secondary', () => invoke(Channels.CHANNELS.FS.OPEN_PATH, (inv.panels || {}).services), 'external')));
        extraBox.appendChild(head);
        const dirRows = (inv.startupDirs || []).flatMap((d) => d.items.map((it) => ({ name: it.name, hint: d.label })));
        extraBox.appendChild(sectionCard('启动文件夹里的项目', dirRows.length, dirRows.slice(0, CAP), '启动文件夹是空的'));
        const tRows = (inv.tasks || []).map((t) => ({ name: t.name, meta: t.state, hint: t.path }));
        extraBox.appendChild(sectionCard('计划任务（不含 Microsoft 系统任务）', tRows.length, tRows.slice(0, CAP), '没有第三方计划任务'));
        const sRows = (inv.services || []).map((s) => ({ name: s.displayName, meta: s.state, hint: s.name }));
        extraBox.appendChild(sectionCard('自动启动的服务', sRows.length, sRows.slice(0, CAP), '没有自动启动的服务'));
      }
      page.appendChild(div('card', div('card-title', '自启项', btn('刷新', 'btn-sm btn-secondary', () => { load(); loadExtra(); }, 'refresh')), status));
      page.appendChild(box);
      page.appendChild(extraBox);
      load();
      loadExtra();
    }
  });

  /* ---------- 磁盘空间分析（空间分析器：分区总览 + 大文件 + 逐层下钻） ---------- */
  register({
    id: 'disk-analyze', name: '磁盘空间分析', nameEn: 'Disk Usage', module: MOD, icon: 'harddrive',
    desc: '扫描目录找出大文件与大文件夹，可逐层下钻（只读，不改动任何文件）', descEn: 'Find large files and folders with level-by-level drill-down (read-only)',
    keywords: ['磁盘', '空间', '大文件', '大文件夹', '下钻', '占用', '分析', 'du'],
    render(page) {
      const dirIn = h('input', { class: 'input', placeholder: '要分析的目录或分区（如 D:\\）', style: { flex: '1' } });
      const status = h('span', { class: 'field-hint' }, '');
      const prog = progressEl(); prog.hide();
      const result = div('');
      let scanRoot = '';     // 本次扫描的根，面包屑从它开始
      let topFiles = [];     // 全盘最大文件（scan-tree 的结果）
      let levelSeq = 0;      // 快速连点目录时丢弃过期响应
      let busy = false;
      /* 【per-run 序号】SCAN_TREE 是阻塞式长操作（全盘扫描可能几分钟），
       * 切页后结果不该写回新页面。 */
      let diskScanSeq = 0;
      /* 【页面会被保活复用，但扫描仍然只允许一趟】
       * SCAN_TREE 是阻塞式长操作，主进程没有可取消的 job id；切页只
       * 能让结果作废，不能让扫描提前结束。因此离开页面时保留 busy 闸：
       *   · 旧扫描的进度/结果都按序号丢弃；
       *   · 旧扫描的 finally 仍然负责把 progress/按钮恢复 —— 否则用户
       *     切回来会看到一个永远灰着的「开始分析」；
       *   · 在它收尾之前不允许再起第二趟，避免两条 job:progress 争同一个
       *     状态行（SCAN_TREE 的进度事件不带本轮 token）。 */
      window.App.onCleanup(() => {
        diskScanSeq++;
        try {
          prog.hide();
          if (busy) {
            status.textContent = '已离开页面，上一轮分析会在后台收尾';
            scanBtn.disabled = true;
          }
        } catch (e) {}
      });
      if (window.App.onEnter) {
        window.App.onEnter(() => {
          diskScanSeq++;
          try {
            if (busy) {
              /* 旧扫描还没结束：按钮先保持禁用，等它的 finally 恢复。 */
              prog.hide();
              scanBtn.disabled = true;
              status.textContent = '上一轮分析仍在后台收尾，完成后可重新开始';
            } else {
              prog.hide();
              scanBtn.disabled = false;
              if (/正在分析|分析中|扫描中|已离开页面/.test(status.textContent || '')) {
                status.textContent = '上一次分析已中断，可重新开始';
              }
            }
          } catch (e) {}
        });
      }

      const pickBtn = btn('选择目录', 'btn-secondary btn-sm', async () => {
        const d = await invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: ['openDirectory'] });
        if (d && d[0]) { dirIn.value = d[0]; scan(); }
      });

      async function scan() {
        const dir = dirIn.value.trim();
        if (!dir) return toast('请选择目录', 'warn');
        if (busy) return toast('正在分析，请稍候', 'warn');
        const runToken = ++diskScanSeq;
        busy = true;
        scanBtn.disabled = true;
        result.innerHTML = ''; prog.show(); status.textContent = '扫描中…';
        const unsub = on('job:progress', (d) => {
          /* 旧一趟的进度不能写进新一趟：页面保活复用后序号会变。 */
          if (runToken !== diskScanSeq) return;
          if (d.kind === 'scan') status.textContent = `已扫描 ${fmtNum(d.files)} 个文件，${fmtBytes(d.size)}`;
        });
        try {
          const r = await invoke(Channels.CHANNELS.FS.SCAN_TREE, dir, {});
          if (runToken !== diskScanSeq) return;   // 页面已离开，结果不写回
          scanRoot = r.root; topFiles = r.topFiles || [];
          status.textContent = `完成：${fmtNum(r.files)} 个文件 / ${fmtNum(r.dirCount)} 个文件夹 / 总计 ${fmtBytes(r.totalSize)}`;
          /* 【先退订再下钻】下钻会发 job:progress，不退订的话它的进度
           * 会把刚写好的「完成：…」覆盖掉（真机 CDP 验证时抓到：
           * 完成后状态栏显示「已扫描 1 个文件，5.0 MB」）。 */
          try { unsub(); } catch (e) {}
          await openDir(r.root);
        } catch (e) {
          if (runToken !== diskScanSeq) return;
          status.textContent = '✗ ' + e.message;
        } finally {
          /* 不管这一趟是否已被页面切换作废，都要恢复「可再次开始」：
           * 主进程的扫描已经结束，busy 若留着就会把按钮永久锁死。
           * 结果/进度行仍按 token 丢弃，只有按钮和进度条归位。 */
          try {
            prog.hide();
            busy = false;
            scanBtn.disabled = false;
            if (runToken !== diskScanSeq && /扫描中|正在分析|收尾/.test(status.textContent || '')) {
              status.textContent = '上一轮分析已完成，可重新开始';
            }
          } catch (e) {}
          unsub();
        }
      }

      /* 面包屑：从扫描根到当前目录的每一段都可点。
       * 【为什么按字符串切而不是记路径栈】用户可能从工具栏/输入框跳到任意层，
       * 一条路径随时能重算出来，栈反而要处理"跳层"这种非树形操作。 */
      function breadcrumb(dir) {
        const box = div('form-row');
        box.style.flexWrap = 'wrap';
        box.style.gap = '4px';
        const chain = [];
        let cur = dir;
        while (cur && cur.length >= scanRoot.length) {
          chain.unshift(cur);
          if (cur === scanRoot) break;
          const parent = window.PathText.dirname(cur);
          if (!parent || parent === cur) break;
          cur = parent;
        }
        if (!chain.length) chain.push(dir);
        chain.forEach((p, i) => {
          if (i) box.appendChild(h('span', { class: 'field-hint' }, '›'));
          const isLast = i === chain.length - 1;
          const label = p === scanRoot ? p : (p.split(/[\\/]/).pop() || p);
          if (isLast) box.appendChild(h('span', { style: { fontWeight: 600, wordBreak: 'break-all' } }, label));
          else box.appendChild(btn(label, 'btn-sm btn-text', () => openDir(p)));
        });
        /* 上一级：扫描根已经是顶了，再往上是盘符根，没有可分析的意义 */
        if (dir !== scanRoot) {
          box.appendChild(btn('上一级', 'btn-sm btn-secondary', () => {
            const parent = window.PathText.dirname(dir);
            if (parent && parent !== dir && parent.length >= scanRoot.length) openDir(parent);
          }, 'arrow-left'));
        }
        return div('card', box, volumeEl);
      }

      /* 分区容量条：statfs 取不到时如实说「取不到」，不画假百分比 */
      const volumeEl = h('div', { class: 'field-hint' }, '');
      function paintVolume(volume) {
        if (!volume || !(volume.total > 0)) {
          volumeEl.textContent = '分区容量：取不到（不影响目录统计）';
          return;
        }
        const used = Math.max(0, volume.total - volume.free);
        const pct = Math.round(used / volume.total * 100);
        volumeEl.textContent = `分区：已用 ${fmtBytes(used)} / 共 ${fmtBytes(volume.total)}（${pct}%），剩余 ${fmtBytes(volume.free)}`;
      }

      /* 逐层展示当前目录的直接子项 */
      async function openDir(dir) {
        const seq = ++levelSeq;
        result.innerHTML = '';
        result.appendChild(window.ui.loadingBlock('统计「' + dir + '」的直接子项…'));
        let r;
        try {
          r = await invoke(Channels.CHANNELS.FS.DIR_CHILDREN, dir);
        } catch (e) {
          if (seq === levelSeq) {
            result.innerHTML = '';
            result.appendChild(div('empty-tip', '无法读取：' + e.message));
          }
          return;
        }
        if (seq !== levelSeq) return;
        result.innerHTML = '';
        paintVolume(r.volume);
        result.appendChild(breadcrumb(r.dir));

        const rows = r.children || [];
        const maxSize = rows.length ? rows[0].size : 1;
        const card = div('card', div('card-title', '当前目录',
          h('span', { class: 'field-hint' }, fmtBytes(r.totalSize) + ' · ' + rows.length + ' 项')));
        if (!rows.length) card.appendChild(div('empty-tip', '这个目录是空的'));
        for (const it of rows) {
          const pct = maxSize ? Math.max(1, it.size / maxSize * 100) : 0;
          const row = div('form-row',
            icon(it.isDir ? 'folder' : 'file'),
            h('span', { class: 'mono', style: { flex: '1', wordBreak: 'break-all', fontWeight: it.isDir ? 500 : 400 } }, it.name),
            h('div', { class: 'progress', style: { width: '120px' } }, h('div', { class: 'progress-fill', style: { width: pct + '%' } })),
            h('span', { class: 'mono', style: { width: '88px', textAlign: 'right', fontSize: '12px' } }, fmtBytes(it.size)),
            h('span', { class: 'field-hint', style: { width: '66px', textAlign: 'right' } }, fmtNum(it.files) + ' 个'),
            it.isDir ? btn('进入', 'btn-sm btn-text', () => openDir(it.path), 'chev-right')
              : btn('定位', 'btn-sm btn-text', () => invoke(Channels.CHANNELS.FS.SHOW_ITEM, it.path), 'eye'));
          card.appendChild(row);
        }
        if (r.truncated) card.appendChild(div('field-hint', '子项太多，只显示体积最大的前 ' + rows.length + ' 项'));
        result.appendChild(card);

        /* 全盘最大文件：scan-tree 已经算过，直接展示；点行可定位 */
        if (topFiles.length) {
          const c = div('card', div('card-title', `全盘最大文件 TOP ${Math.min(20, topFiles.length)}`));
          const maxF = topFiles[0] ? topFiles[0].size : 1;
          for (const f of topFiles.slice(0, 20)) {
            c.appendChild(div('form-row',
              h('div', { class: 'progress', style: { flex: '1', height: '10px' } }, h('div', { class: 'progress-fill', style: { width: (f.size / maxF * 100) + '%' } })),
              h('span', { class: 'mono', style: { width: '70px', fontSize: '12px', textAlign: 'right' } }, fmtBytes(f.size)),
              btn('定位', 'btn-sm btn-text', () => invoke(Channels.CHANNELS.FS.SHOW_ITEM, f.path), 'eye')));
            c.appendChild(div('mono', { style: { fontSize: '11px', color: 'var(--text-3)', marginTop: '-6px', marginBottom: '6px', wordBreak: 'break-all' } }, f.path));
          }
          result.appendChild(c);
        }
      }

      const scanBtn = btn('开始分析', 'btn-primary', scan);
      page.appendChild(div('card', div('card-title', '分析目标'),
        div('form-row', dirIn, pickBtn),
        div('form-row', scanBtn, prog.el, status),
        div('field-hint', '只读扫描，不会修改或删除任何文件。下钻按层统计，体积大的目录首次进入需要等几秒。')));
      page.appendChild(result);
    }
  });

  /* ---------- 垃圾清理 ---------- */
  register({
    id: 'junk-clean', name: '垃圾清理', nameEn: 'Junk Cleanup', module: MOD, icon: 'trash',
    desc: '扫描临时文件、缓存、安装包与系统日志，勾选后一键清理（含回收站）', descEn: 'Scan temp files, caches, installers and system logs, then clean the selected ones',
    keywords: ['垃圾', '清理', '缓存', '临时文件', '安装包', '更新缓存', '日志'],
    render(page) {
      const box = div('');
      const status = h('span', { class: 'field-hint' }, '');
      let items = [];
      const scanBtn = btn('开始扫描', 'btn-primary', async () => {
        if (!isDesktop) return toast('桌面端可用', 'warn');
        box.innerHTML = ''; status.textContent = '扫描中…'; scanBtn.disabled = true;
        try {
          items = await invoke(Channels.CHANNELS.FS.SCAN_JUNK);
          status.textContent = items.length ? `发现 ${items.length} 类可清理项` : '很干净，没有发现可清理项 ✓';
          draw();
        } catch (e) { status.textContent = '✗ ' + e.message; }
        finally { scanBtn.disabled = false; }
      });
      function draw() {
        box.innerHTML = '';
        for (const it of items) {
          /* 【默认勾选策略】安装包这类「可能是用户还要用的东西」默认不勾，
           * 其余清理项默认勾上（与改造前一致）。 */
          const cb = h('input', { type: 'checkbox', class: 'checkbox', checked: !it.defaultOff, dataset: { id: it.id } });
          const meta = div('');
          if (it.hint) meta.appendChild(h('div', { class: 'field-hint', style: { fontSize: '11px' } }, it.hint));
          box.appendChild(div('form-row', cb,
            div('', h('div', null, h('b', null, it.label)),
              h('div', { class: 'field-hint mono', style: { fontSize: '11px' } }, it.path),
              meta),
            it.needsAdmin ? h('span', { class: 'tag tag-orange', style: { marginLeft: 'auto' } }, '需要管理员') : null,
            h('span', { class: 'tag tag-blue', style: { marginLeft: it.needsAdmin ? '6px' : 'auto' } }, fmtBytes(it.size)),
            h('span', { class: 'field-hint', style: { width: '80px', textAlign: 'right' } }, it.files + ' 个文件')));
        }
      }
      const cleanBtn = btn('清理勾选项', 'btn-danger', async () => {
        const selected = items.filter(it => box.querySelector(`input[data-id="${it.id}"]`)?.checked);
        if (!selected.length) return toast('请先扫描并勾选', 'warn');
        const total = selected.reduce((s, i) => s + i.size, 0);
        if (!(await confirmBox({ title: '清理垃圾文件', message: `将永久删除 ${selected.length} 类共约 ${fmtBytes(total)} 的文件（不进回收站），确定继续？`, danger: true, okText: '清理' }))) return;
        try {
          const targets = selected.flatMap(i => i.targets);
          const r = await invoke(Channels.CHANNELS.FS.CLEAN_JUNK, targets, true);
          /* 有失败时不能报成功：用户会以为都清掉了。
           * （主进程现在会拒绝「不在本次扫描结果内」的路径，这类拒绝也必须可见。） */
          const nErr = (r.errors || []).length;
          if (nErr) toast(`已清理 ${fmtBytes(r.bytes)}，${nErr} 项未能清理：` + r.errors.slice(0, 3).join('；'), 'warn', 6000);
          else toast(`已清理 ${fmtBytes(r.bytes)}`, 'success');
          scanBtn.click();
        } catch (e) { toast(e.message, 'error'); }
      }, 'refresh');
      const rbBtn = btn('清空回收站', 'btn-danger-plain', async () => {
        if (!(await confirmBox({ title: '清空回收站', message: '确定清空系统回收站？此操作不可恢复。', danger: true, okText: '清空' }))) return;
        try { await invoke(Channels.CHANNELS.SYS.RECYCLE_EMPTY); toast('回收站已清空', 'success'); }
        catch (e) { toast(e.message, 'error'); }
      });
      page.appendChild(div('card', div('card-title', '扫描与清理'),
        div('form-row', scanBtn, cleanBtn, rbBtn, status)));
      page.appendChild(box);
    }
  });

  /* ---------- 系统还原点 ---------- */
  register({
    id: 'restore-points', name: '系统还原点', nameEn: 'Restore Points', module: MOD, icon: 'clock',
    desc: '查看、创建与清理系统还原点（删除不可恢复，需开启高危能力）', descEn: 'List, create and clean Windows restore points',
    keywords: ['还原点', '系统还原', '卷影副本', 'rstrui', 'restore'],
    render(page) {
      const status = h('span', { class: 'field-hint' }, '');
      const storageEl = div('field-hint', '');
      const box = div('');
      const descIn = h('input', { class: 'input input-sm', value: '核核工具箱手动还原点', maxlength: '100', style: { flex: '1' } });
      let points = [];
      let rstrui = '';

      async function load() {
        status.textContent = '读取中…';
        try {
          const r = await invoke(Channels.CHANNELS.SYS.RESTORE_LIST);
          points = r.points || [];
          rstrui = r.rstrui || '';
          if (r.note) status.textContent = r.note;
          else status.textContent = points.length
            ? `${points.length} 个还原点（系统盘 ${r.systemDrive || '?'}）`
            : '没有还原点（可能系统保护未启用，或从未创建过）';
          /* 存储占用单独取：它需要管理员，取不到也要如实说 */
          let st = null;
          try { st = await invoke(Channels.CHANNELS.SYS.RESTORE_STORAGE); } catch (e) { st = null; }
          if (st && st.storage) {
            const s = st.storage;
            storageEl.textContent = '卷影存储：已用 ' + fmtBytes(s.used || 0)
              + (s.max ? ' / 上限 ' + fmtBytes(s.max) + (s.pct != null ? `（${s.pct}%）` : '') : ' / 上限未知');
          } else {
            storageEl.textContent = '卷影存储占用：取不到' + (st && st.note ? '（' + st.note + '）' : '（需要管理员）');
          }
          draw();
        } catch (e) {
          status.textContent = '✗ ' + e.message;
        }
      }

      function draw() {
        box.innerHTML = '';
        if (!points.length) { box.appendChild(div('empty-tip', '没有可显示的还原点')); return; }
        box.appendChild(renderTable({
          columns: [
            { key: 'time', title: '创建时间', width: '170px', render: (p) => h('span', { class: 'mono', style: { fontSize: '12px' } }, p.time ? fmtDate(p.time, true) : '未知') },
            { key: 'seq', title: '序号', width: '70px', render: (p) => h('span', { class: 'mono' }, String(p.seq || '')) },
            { key: 'desc', title: '描述', render: (p) => h('span', null, p.description || '（无描述）') },
          ],
          rows: points,
        }));
      }

      const createBtn = btn('创建还原点', 'btn-primary', async () => {
        if (!(await confirmBox({ title: '创建还原点', message: `将用描述「${descIn.value.trim() || '核核工具箱手动还原点'}」创建一个系统还原点。\n\n创建需要系统保护已开启，且可能耗时十几秒。`, okText: '创建' }))) return;
        try { await invoke(Channels.CHANNELS.SYS.RESTORE_CREATE, descIn.value); toast('已创建还原点', 'success'); load(); }
        catch (e) { toast(e.message, 'error', 8000); }
      }, 'plus');
      const enableBtn = btn('启用系统保护', 'btn-secondary', async () => {
        if (!(await confirmBox({ title: '启用系统保护', message: '将为系统盘启用系统保护。\n\n这会占用一部分磁盘空间（Windows 默认上限约为该盘的 10%）。', okText: '启用' }))) return;
        try { await invoke(Channels.CHANNELS.SYS.RESTORE_ENABLE); toast('已启用系统保护', 'success'); load(); }
        catch (e) { toast(e.message, 'error', 8000); }
      }, 'shield');
      const openBtn = btn('打开系统还原', 'btn-secondary', () => {
        /* 【取不到 rstrui 时要说明，而不是"点了没反应"】
         * rstrui 由主进程按系统盘探测；在精简版 Windows / 未安装「系统还原」
         * 组件时为空。按钮照旧可点，但原实现是静默 return —— 用户分不清是
         * 应用卡住了还是系统确实没有这个程序。 */
        if (rstrui) invoke(Channels.CHANNELS.FS.OPEN_PATH, rstrui).catch((e) => toast(e.message, 'error'));
        else toast('本机没有找到系统还原程序（rstrui.exe）。可在开始菜单搜索「创建还原点」或运行 systempropertiesprotection', 'warn', 8000);
      }, 'external');
      const delOldBtn = btn('删除最旧的还原点', 'btn-danger-plain', async () => {
        if (!(await confirmBox({ title: '删除最旧的还原点', message: '将删除系统中最早的卷影副本（还原点）。\n\n删除后无法恢复。确定继续？', danger: true, okText: '删除' }))) return;
        try { await invoke(Channels.CHANNELS.SYS.RESTORE_DELETE, 'oldest'); toast('已删除最旧的还原点', 'success'); load(); }
        catch (e) { toast(e.message, 'error', 8000); }
      }, 'trash');
      const delAllBtn = btn('删除全部还原点', 'btn-danger', async () => {
        if (!(await confirmBox({
          title: '删除全部还原点',
          message: '将删除系统盘上「全部卷影副本」：系统还原点、部分备份软件与「文件历史」的副本都可能在其中，且不可恢复。\n\n确定要继续吗？',
          danger: true, okText: '全部删除'
        }))) return;
        try { await invoke(Channels.CHANNELS.SYS.RESTORE_DELETE, 'all'); toast('已删除全部还原点', 'success'); load(); }
        catch (e) { toast(e.message, 'error', 8000); }
      }, 'trash');

      page.appendChild(div('card', div('card-title', '系统还原点', btn('刷新', 'btn-sm btn-secondary', load, 'refresh')),
        div('form-row', descIn, createBtn, enableBtn, openBtn),
        div('form-row', delOldBtn, delAllBtn),
        status, storageEl,
        div('field-hint', '说明：列表与创建需要系统保护已开启；删除卷影副本需要管理员权限，且会清除该卷上的其它卷影副本。')));
      page.appendChild(box);
      load();
    }
  });

  /* ---------- 空目录批量清理 ---------- */
  register({
    id: 'empty-dir-clean', name: '空目录清理', nameEn: 'Empty Folder Cleanup', module: MOD, icon: 'folder',
    desc: '递归扫描并删除指定路径下的所有空文件夹', descEn: 'Scan and delete empty directories in bulk',
    keywords: ['空目录', '空文件夹', '清理'],
    render(page) {
      const dirIn = h('input', { class: 'input', placeholder: '要扫描的目录', style: { flex: '1' } });
      const pickBtn = btn('选择目录', 'btn-secondary btn-sm', async () => {
        const d = await invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: ['openDirectory'] });
        if (d && d[0]) dirIn.value = d[0];
      });
      const status = h('span', { class: 'field-hint' }, '');
      const box = div('');
      let dirs = [];
      let scanningDirs = false;
      const scanBtn = btn('扫描空目录', 'btn-primary', async () => {
        const dir = dirIn.value.trim();
        if (!dir) return toast('请选择目录', 'warn');
        /* SCAN_EMPTY_DIRS 会递归整棵目录树；双击/两指连点会并发两趟，
         * 后一趟覆盖前一趟的 dirs，删除按钮就可能拿着半截列表去删。 */
        if (scanningDirs) return toast('正在扫描，请稍候', 'warn');
        scanningDirs = true;
        scanBtn.disabled = true;
        box.innerHTML = ''; status.textContent = '扫描中…';
        try {
          const r = await invoke(Channels.CHANNELS.FS.SCAN_EMPTY_DIRS, dir);
          dirs = r.dirs.filter(d => d.path !== dir);
          status.textContent = dirs.length ? `发现 ${dirs.length} 个空目录` : '没有空目录 ✓';
          draw();
        } catch (e) { status.textContent = '✗ ' + e.message; }
        finally { scanningDirs = false; scanBtn.disabled = false; }
      });
      function draw() {
        box.innerHTML = '';
        if (!dirs.length) return;
        const scroll = div('table-scroll');
        const table = h('table', { class: 'table' });
        const tbody = h('tbody');
        for (const d of dirs) {
          const tr = h('tr', null, h('td', { class: 'mono', style: { fontSize: '12px' } }, d.path));
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        scroll.appendChild(table);
        box.appendChild(scroll);
      }
      const delBtn = btn('删除全部空目录', 'btn-danger', async () => {
        if (!dirs.length) return toast('请先扫描', 'warn');
        if (!(await confirmBox({ title: '删除空目录', message: `将删除 ${dirs.length} 个空目录，确定继续？`, danger: true, okText: '删除' }))) return;
        try {
          /* 【必须传路径字符串，不能传扫描结果对象】
           * r.dirs 的元素是 { path, depth } 对象。早期这里直接 invoke(..., dirs)
           * 把**对象数组**发过去，主进程 for (const p of dirs) 里 p 是个对象：
           *   1, 'trash') pathGuard.checkDeletable(obj) 内部 String(p) 得到 "[object Object]"，
           *      既不是根、不是关键目录、不是家目录 → 闸门直接放行（形同虚设）；
           *   2) fsp.rmdir(obj) 抛 ERR_INVALID_ARG_TYPE，被内层 catch 收进 errors，
           *      deleted 恒为 0；
           *   3) 界面仍然 toast「已删除 0 个空目录」，而且是 success（绿色）样式，
           *      而 r.errors 从头到尾没人读。
           * 结果：点「删除全部空目录」一个都删不掉，用户却以为成功了。 */
          const r = await invoke(Channels.CHANNELS.FS.DELETE_EMPTY, dirs.map((d) => (typeof d === 'string' ? d : d && d.path)));
          /* 【成功/失败要分开说，不能一律绿色】
           * 有失败时用 warn，并把前 3 条原因列出来 —— 否则用户只看到
           * 「已删除 3 个」，不知道另外几个为什么没删掉。 */
          const nErr = (r.errors || []).length;
          if (nErr) {
            const head = r.deleted
              ? `已删除 ${r.deleted} 个，${nErr} 个失败：`
              : `未能删除任何空目录（${nErr} 个失败）：`;
            toast(head + (r.errors || []).slice(0, 3).join('；'), 'warn', 6000);
          } else {
            toast(`已删除 ${r.deleted} 个空目录`, 'success');
          }
          scanBtn.click();
        } catch (e) { toast(e.message, 'error'); }
      });
      page.appendChild(div('card', div('card-title', '目标目录'),
        div('form-row', dirIn, pickBtn),
        div('form-row', scanBtn, delBtn, status)));
      page.appendChild(box);
    }
  });

  /* ---------- 系统快捷操作 ---------- */
  register({
    id: 'quick-ops', name: '系统快捷操作', nameEn: 'Quick Actions', module: MOD, icon: 'zap',
    desc: '锁屏、休眠、重启、关机、清空回收站与剪贴板', descEn: 'Common system actions such as sleep, lock and empty the recycle bin',
    keywords: ['锁屏', '关机', '重启', '休眠'],
    render(page) {
      const actions = [
        ['立即锁屏', '锁屏后需输入密码解锁，继续？', 'lock', false, 'lock'],
        ['睡眠', '进入睡眠状态，继续？', 'sleep', false, 'moon'],
        ['休眠', '进入休眠状态（内存写入硬盘），继续？', 'hibernate', false, 'moon'],
        ['重启系统', '系统将立即重启，未保存数据会丢失！', 'restart', true, 'refresh'],
        ['关机', '系统将立即关机，未保存数据会丢失！', 'shutdown', true, 'power']
      ];
      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' } });
      for (const [label, msg, action, danger, iconName] of actions) {
        const b = btn(label, danger ? 'btn-danger-plain' : 'btn-secondary', async () => {
          if (!(await confirmBox({ title: label, message: msg, danger, okText: '确认执行' }))) return;
          try { await invoke(Channels.CHANNELS.SYS.POWER, action); toast('已执行', 'success'); }
          catch (e) { toast(e.message, 'error'); }
        }, iconName);
        b.style.height = '52px';
        grid.appendChild(b);
      }
      page.appendChild(div('card', div('card-title', '电源操作'), grid));
      page.appendChild(div('card', div('card-title', '清理操作'),
        div('form-row',
          btn('清空回收站', 'btn-danger-plain', async () => {
            if (!(await confirmBox({ title: '清空回收站', message: '确定清空回收站？不可恢复。', danger: true, okText: '清空' }))) return;
            try { await invoke(Channels.CHANNELS.SYS.RECYCLE_EMPTY); toast('已清空', 'success'); } catch (e) { toast(e.message, 'error'); }
          }, 'trash'),
          btn('清空剪贴板', 'btn-secondary', async () => {
            try { await invoke(Channels.CHANNELS.CLIP.WRITE_TEXT, ''); toast('剪贴板已清空', 'success'); } catch (e) { toast(e.message, 'error'); }
          }, 'clipboard'))));
    }
  });

  /* ---------- 右键菜单管理 ---------- */
  register({
    id: 'ctxmenu-manage', name: '右键菜单管理', nameEn: 'Context Menu', module: MOD, icon: 'list',
    desc: '管理文件/文件夹右键菜单项，禁用冗余项（可随时恢复）', descEn: 'Add or remove this app in the Explorer right-click menu',
    keywords: ['右键', '菜单', 'context', '清理'],
    render(page) {
      const box = div('');
      const status = h('span', { class: 'field-hint' }, '');
      page.appendChild(div('card', div('card-title', '说明', btn('刷新', 'btn-sm btn-secondary', load, 'refresh'), status),
        div('field-hint', '列出注册表中的经典右键菜单项。禁用会写入 LegacyDisable 标记（可随时恢复，不删除任何内容）；写入需要管理员权限，普通权限下仅可查看。')));
      async function load() {
        box.innerHTML = '';
        status.textContent = '读取注册表…';
        try {
          const groups = await invoke(Channels.CHANNELS.CTXMENU.LIST);
          const total = groups.reduce((s, g) => s + g.items.length, 0);
          const disabledN = groups.reduce((s, g) => s + g.items.filter(i => i.disabled).length, 0);
          status.textContent = `共 ${total} 项，${disabledN} 项已禁用`;
          for (const g of groups) {
            if (!g.items.length) continue;
            const card = div('card');
            card.style.border = '1px solid var(--border-light)';
            card.appendChild(div('card-title', g.label, h('span', { class: 'tag tag-gray', style: { marginLeft: 'auto' } }, `${g.items.length} 项`)));
            card.appendChild(renderTable({
              columns: [
                { key: 'name', title: '名称', render: r => h('span', { style: { fontWeight: 500 } }, r.name) },
                { key: 'display', title: '显示文本', render: r => r.display || h('span', { class: 'field-hint' }, '-') },
                { key: 'command', title: '命令 / 处理器', render: r => div('mono', { style: { fontSize: '11px' } }, r.command || '-') },
                { key: 'state', title: '状态', width: '80px', render: r => r.disabled ? h('span', { class: 'tag tag-gray' }, '已禁用') : h('span', { class: 'tag tag-green' }, '启用') },
                { key: 'act', title: '操作', width: '90px', render: (r, td) => {
                    td.appendChild(r.disabled
                      ? btn('启用', 'btn-sm btn-text', async () => {
                          try { await invoke(Channels.CHANNELS.CTXMENU.TOGGLE, r, false); toast('已启用', 'success'); load(); }
                          catch (e) { toast(/access|拒绝/i.test(e.message) ? '需要管理员权限，请以管理员身份运行工具箱' : e.message, 'error'); }
                        })
                      : btn('禁用', 'btn-sm btn-text', async () => {
                          try { await invoke(Channels.CHANNELS.CTXMENU.TOGGLE, r, true); toast('已禁用（可恢复）', 'success'); load(); }
                          catch (e) { toast(/access|拒绝/i.test(e.message) ? '需要管理员权限，请以管理员身份运行工具箱' : e.message, 'error'); }
                        }));
                  } }
              ],
              rows: g.items
            }));
            box.appendChild(card);
          }
          if (total === 0) box.appendChild(div('empty-tip', '没有找到可管理的右键菜单项'));
        } catch (e) { status.textContent = '✗ ' + e.message; }
      }
      page.appendChild(box);
      load();
    }
  });

  /* ---------- Win11 经典右键菜单 ---------- */
  register({
    id: 'win-classic-menu', name: '经典右键菜单', nameEn: 'Classic Context Menu', module: MOD, icon: 'list',
    desc: '一键切换 Win11 右键菜单为 Win10 经典样式（可随时还原）', descEn: 'Restore the Windows 10 style right-click menu on Windows 11',
    keywords: ['右键', '菜单', '经典', 'win11', 'contextmenu'],
    render(page) {
      const statusLine = h('div', { class: 'field-hint' }, '检测当前状态…');
      async function refresh() {
        try { const s = await invoke(Channels.CHANNELS.CTXMENU.CLASSIC_STATUS); statusLine.textContent = s.on ? '当前：经典菜单（Win10 样式）' : '当前：Win11 新版菜单'; }
        catch (e) { statusLine.textContent = '状态检测失败'; }
      }
      // 以主进程回写的真实注册表状态为准：不再无条件弹「已切换」，
      // 写失败或被系统拒绝时如实报错，避免又一次假阳性。
      /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
      const apply = (on) => invoke(Channels.CHANNELS.CTXMENU.CLASSIC, on, false).then((r) => {
        const nowOn = !!(r && r.on);
        if (nowOn === !!on) toast(on ? '已切换为经典菜单' : '已恢复 Win11 菜单', 'success');
        else toast(on ? '切换失败：注册表未写入，请检查权限' : '恢复失败：注册表项未能清除，请检查权限', 'error');
        refresh();
      }).catch((e) => toast(e.message, 'error'));
      page.appendChild(div('card', div('card-title', '右键菜单样式'), statusLine,
        div('form-row',
          btn('切换为经典菜单', 'btn-primary', async () => {
            /* 【取消按钮不能叫「取消」—— 它其实会改系统状态】
             * 这段流程是「切换 + 是否立即重启」两件事合在一个确认框里：
             *   · 确定  → 写注册表 + 立即重启资源管理器；
             *   · 取消  → 仍然写注册表，只是不重启（走下面 apply(true)）。
             * 但 cancelText 默认是「取消」，用户点它时以为"什么都没变"，
             * 结果注册表已被改动、还弹了「已切换为经典菜单」。
             * 功能上「只切换、稍后生效」是合理的选项，所以要保留 ——
             * 改的是**按钮怎么说**，让它如实描述会发生什么。
             * （不要改成 `return;`：那会让"稍后生效"这个选项彻底消失。） */
            if (!(await confirmBox({ title: '切换经典菜单', message: '将注册表写入经典菜单开关，需要重启资源管理器后生效。立即重启资源管理器吗？（不重启也可稍后手动注销/重启系统）', okText: '切换并立即生效', cancelText: '仅切换，稍后生效' })))
              return apply(true);
            // 成功/失败必须是互斥的：原来 catch 里弹了错误后又无条件弹「已切换并重启」，
            // 用户会同时看到红色"需要管理员权限"和绿色"已切换"，无法判断到底改没改。
            try {
              const r = await invoke(Channels.CHANNELS.CTXMENU.CLASSIC, true, true);
              if (r && r.on) toast('已切换并重启资源管理器', 'success');
              else toast('切换失败：注册表未写入，请检查权限', 'error');
            } catch (e) {
              toast('切换失败：' + e.message, 'error');
            }
            refresh();
          }),
          btn('恢复 Win11 菜单', 'btn-secondary', async () => {
            await apply(false);
            toast('如未立即生效，请重启资源管理器或注销重登', 'info');
          })),
        div('field-hint', '只修改当前用户的注册表项，不删除任何内容，可随时切回 Win11 样式。')));
      refresh();
    }
  });

  /* ---------- 窗口管理 ---------- */
  register({
    id: 'window-manager', name: '窗口管理', nameEn: 'Window Manager', module: MOD, icon: 'grid',
    desc: '列出当前所有窗口：置顶/取消置顶、调节透明度、置底', descEn: 'List windows and control topmost, opacity and stacking',
    keywords: ['窗口', '置顶', '透明', '管理', 'topmost'],
    render(page) {
      const listBox = div('');
      const status = h('span', { class: 'field-hint' }, '');
      const refreshBtn = btn('刷新', 'btn-sm btn-secondary', load, 'refresh');
      async function load() {
        listBox.innerHTML = '';
        listBox.appendChild(window.ui.loadingBlock('枚举窗口…'));
        try {
          const rows = await invoke(Channels.CHANNELS.WINMGR.LIST);
          listBox.innerHTML = '';
          status.textContent = `${rows.length} 个窗口`;
          for (const w of rows) {
            const row = div('form-row',
              h('span', { class: 'tag ' + (w.topmost ? 'tag-orange' : 'tag-gray'), style: { width: '52px', justifyContent: 'center' } }, w.topmost ? '置顶' : '普通'),
              h('span', { class: 'mono', style: { width: '110px', fontSize: '11px' } }, w.proc),
              h('span', { style: { flex: '1', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: w.title }, w.title));
            row.appendChild(btn(w.topmost ? '取消置顶' : '置顶', 'btn-sm btn-text', async () => {
              try { await invoke(Channels.CHANNELS.WINMGR.TOPMOST, w.hwnd, !w.topmost); toast('已' + (w.topmost ? '取消置顶' : '置顶'), 'success'); load(); }
              catch (e) { toast(e.message, 'error'); }
            }));
            const opSel = h('select', { class: 'select', style: { width: '76px', fontSize: '12px' } },
              h('option', { value: '' }, '透明'),
              h('option', { value: '255' }, '100%'), h('option', { value: '200' }, '80%'),
              h('option', { value: '150' }, '60%'), h('option', { value: '100' }, '40%'));
            opSel.addEventListener('change', async () => {
              if (!opSel.value) return;
              try { await invoke(Channels.CHANNELS.WINMGR.OPACITY, w.hwnd, +opSel.value); toast('透明度已调整', 'success', 1000); }
              catch (e) { toast(e.message, 'error'); }
            });
            row.appendChild(opSel);
            row.appendChild(btn('置底', 'btn-sm btn-text', async () => {
              try { await invoke(Channels.CHANNELS.WINMGR.BOTTOM, w.hwnd); toast('已置底', 'success', 1000); }
              catch (e) { toast(e.message, 'error'); }
            }));
            listBox.appendChild(row);
          }
        } catch (e) {
          listBox.innerHTML = '';
          listBox.appendChild(div('field-err', '✗ ' + (e && e.message ? e.message : e)));
        }
      }
      page.appendChild(div('card', div('card-title', '当前窗口'),
        div('form-row', refreshBtn, status), listBox,
        div('field-hint', '部分窗口（自绘界面、UWP 应用）不接受透明度调整；调回 100% 即可取消透明')));
      load();
    }
  });

  /* ---------- 服务与电源计划 ---------- */
  register({
    id: 'services-power', name: '服务与电源', nameEn: 'Services & Power', module: MOD, icon: 'server',
    desc: '查看并启停 Windows 服务（启停需管理员权限），切换电源计划', descEn: 'Manage Windows services and switch power plans',
    keywords: ['服务', 'service', '电源', '计划', 'powercfg'],
    render(page) {
      const svcBox = div('');
      const svcFilter = h('input', { class: 'input input-sm', placeholder: '按名称过滤服务…', style: { width: '200px' } });
      const svcStatus = h('span', { class: 'field-hint' }, '');
      let allSvc = [];
      async function loadSvc() {
        svcBox.innerHTML = '';
        svcBox.appendChild(window.ui.loadingBlock('读取服务列表…'));
        try {
          allSvc = await invoke(Channels.CHANNELS.SVC.LIST);
          svcStatus.textContent = `${allSvc.length} 个服务`;
          renderSvc();
        } catch (e) { svcBox.innerHTML = ''; svcBox.appendChild(div('field-err', '✗ ' + escapeHtml(e.message))); }
      }
      function renderSvc() {
        const q = svcFilter.value.trim().toLowerCase();
        const list = q ? allSvc.filter(s => (s.Name + s.DisplayName).toLowerCase().includes(q)) : allSvc.slice(0, 100);
        svcBox.innerHTML = '';
        svcBox.appendChild(h('div', { class: 'field-hint', style: { marginBottom: '6px' } }, q ? `匹配 ${list.length} 个` : `显示前 100 个（共 ${allSvc.length}，输入过滤）`));
        for (const s of list) {
          const running = s.Status === 'Running';
          const row = div('form-row',
            h('span', { class: 'tag ' + (running ? 'tag-green' : 'tag-gray'), style: { width: '60px', justifyContent: 'center' } }, running ? '运行' : '停止'),
            h('span', { style: { flex: '1', fontSize: '12px' } }, s.DisplayName || s.Name),
            h('span', { class: 'field-hint mono', style: { fontSize: '11px' } }, s.Name));
          if (running) row.appendChild(btn('停止', 'btn-sm btn-danger-plain', () => act(s, 'stop')));
          else row.appendChild(btn('启动', 'btn-sm btn-text', () => act(s, 'start')));
          svcBox.appendChild(row);
        }
      }
      async function act(s, action) {
        // 停止服务属于破坏性操作：可能让依赖它的程序异常退出、数据写入中断。
        // 服务列表动辄几百条，容易点错行，所以停止前必须确认。
        if (action === 'stop') {
          const label = s.DisplayName || s.Name;
          if (!(await confirmBox({
            title: '停止 Windows 服务',
            message: `确定停止服务「${label}」（${s.Name}）？\n\n停止后，依赖该服务的程序可能异常退出或中断数据写入。`,
            danger: true, okText: '停止服务'
          }))) return;
        }
        try { await invoke(Channels.CHANNELS.SVC.ACTION, s.Name, action); toast(`已${action === 'start' ? '启动' : '停止'}：${s.DisplayName || s.Name}`, 'success'); loadSvc(); }
        catch (e) { toast(e.message.includes('1060') || e.message.includes('访问') || /5$|拒绝/.test(e.message) ? '需要管理员权限：请以管理员身份运行核核工具箱' : e.message, 'error'); }
      }
      svcFilter.addEventListener('input', window.ui.debounce(renderSvc, 150));
      const powerBox = div('');
      async function loadPower() {
        powerBox.innerHTML = '';
        powerBox.appendChild(window.ui.loadingBlock('读取电源计划…'));
        try {
          const plans = await invoke(Channels.CHANNELS.POWER.LIST);
          powerBox.innerHTML = '';
          for (const p of plans) {
            const row = div('form-row',
              h('span', { class: 'tag ' + (p.active ? 'tag-green' : 'tag-gray'), style: { width: '60px', justifyContent: 'center' } }, p.active ? '使用中' : '可用'),
              h('span', { style: { flex: '1' } }, p.name));
            if (!p.active) row.appendChild(btn('切换', 'btn-sm btn-text', async () => {
              // 切电源计划会立刻改变系统功耗策略（如「节能」会让编译/渲染明显变慢），
              // 属于不易察觉但影响实际工作的改动，切换前确认一次。
              if (!(await confirmBox({
                title: '切换电源计划',
                message: `确定切换到「${p.name}」？\n\n切换会立即改变系统功耗策略，正在进行的编译、渲染等任务可能明显变慢。`,
                okText: '切换'
              }))) return;
              try { await invoke(Channels.CHANNELS.POWER.SET, p.guid); toast('已切换：' + p.name, 'success'); loadPower(); }
              catch (e) { toast(e.message, 'error'); }
            }));
            powerBox.appendChild(row);
          }
        } catch (e) { powerBox.innerHTML = ''; powerBox.appendChild(div('field-err', '✗ ' + escapeHtml(e.message))); }
      }
      page.appendChild(div('card', div('card-title', 'Windows 服务'),
        div('form-row', btn('刷新', 'btn-sm btn-secondary', loadSvc, 'refresh'), svcFilter, svcStatus),
        div('field-hint', '启动/停止服务需要管理员权限运行'), svcBox));
      page.appendChild(div('card', div('card-title', '电源计划'), powerBox));
      loadSvc(); loadPower();
    }
  });

  /* ---------- 定时任务 ---------- */
  register({
    id: 'scheduler', name: '定时任务', nameEn: 'Scheduled Tasks', module: MOD, icon: 'timer',
    desc: '定时关机/重启/睡眠/锁屏/提醒，倒计时精确到秒，可取消', descEn: 'Run a command or notification on a schedule',
    keywords: ['定时', '关机', '重启', '睡眠', '锁屏', '提醒', '倒计时'],
    render(page) {
      const modeSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'shutdown' }, '关机'), h('option', { value: 'restart' }, '重启'),
        h('option', { value: 'sleep' }, '睡眠'), h('option', { value: 'lock' }, '锁屏'),
        h('option', { value: 'remind' }, '提醒我'));
      const minIn = h('input', { type: 'number', class: 'input input-sm', value: '30', min: '1', style: { width: '80px' } });
      const msgIn = h('input', { class: 'input input-sm', placeholder: '提醒时显示的文字，如「该喝水了」', style: { flex: '1' } });
      const countdown = h('span', { class: 'tag tag-blue' }, '未设置');
      const status = h('span', { class: 'field-hint' }, '');
      /* mode 现在被清理函数读取（判断是否要复位倒计时文案），不再"赋值后未使用"，
       * 所以去掉 eslint-disable。 */
      let timer = null, targetTs = 0, mode = '';
      /* onceId：本页最近一次用「睡眠/锁屏」建出的主进程一次性定时 id。
       * 取消时只撤这一条，不清空整张列表（列表里的其它条目有自己的「删除」）。
       * pageShown：页面当前是否在前台（cleanup 置 false、onEnter 置 true）。
       * apply 的几处 await 返回后据此判断"还能不能动界面"。 */
      let onceId = null;
      let pageShown = true;
      /* 【清理必须把倒计时复位成「未设置」】
       * 只有「提醒」这种应用内计时会因为切页而停（关机/重启/睡眠/锁屏
       * 都由主进程接管，切页不影响）。原来只清 timer 不改文案，
       * 保活复用后界面还挂着「提醒我 29:30」在倒数，实际早停了。 */
      /* 【清理必须把倒计时状态说清楚】
       * 这个卡片里有两类定时，切页的影响完全不同：
       *   · 「提醒」走页面内 setInterval → 切页就停，必须明确说"已停止"；
       *   · 关机/重启走系统 shutdown 计划、睡眠/锁屏走主进程持久化计时
       *     → 切页**不影响**，倒计时文案不能装成"停了"，也不能继续假装
       *     在倒数（timer 已经清了，秒数不会动了）。
       * 【原来的判断写的是 mode === '提醒我'，而 arm('提醒', …) 实际写的是
       * '提醒' —— 条件永不成立，于是离开页面后界面一直挂着「提醒 29:30」
       * 在假倒数，实际 timer 早被清掉、提醒永远不会来。 */
      window.App.onCleanup(() => {
        pageShown = false;
        if (timer) { clearInterval(timer); timer = null; }
        if (mode === '提醒') {
          /* 应用内计时：真的停了，如实说 */
          countdown.textContent = '已停止（离开页面）';
          countdown.className = 'tag tag-gray';
          status.textContent = '提醒会在离开页面时停止；若要跨页面提醒请改用「一次性定时」';
        } else if (mode) {
          /* 系统级定时：仍在生效，只是这个页面不再倒数 */
          countdown.textContent = mode + '（已交给系统）';
          countdown.className = 'tag tag-blue';
          status.textContent = mode + ' 的计时由系统/主进程负责，切换页面不影响；可点「取消」撤销';
        }
      });
      /* 【复用回来：系统级定时恢复"会跳动的"倒数】
       * 提醒已经停了（上面如实说），不重启；关机/重启/睡眠/锁屏仍在系统里跑，
       * 按 targetTs 与当前时间重算一遍剩余，恢复成正常的倒计时外观。
       * 【必须重起 interval，不能只画一帧】
       * 只算一次的话，界面会定格在"回来那一刻"的剩余时间 —— 用户盯着它
       * 一分钟都不会动，看起来像卡死（这正是本轮要修的"静帧"）。
       * 这些模式的 fire 回调是空函数（真正的执行在系统/主进程），
       * 所以这里的 interval 纯粹负责刷新文案，到点显示「已触发」并自清。
       * cleanup 清的是同一个 timer 变量，因此这里起的会被一起收掉。 */
      if (window.App.onEnter) {
        window.App.onEnter(() => {
          pageShown = true;
          try {
            if (!mode || mode === '提醒') return;
            if (timer) { clearInterval(timer); timer = null; }
            if (targetTs - Date.now() <= 0) {
              /* 【必须同时清状态机】只写"已触发"就 return 的话，mode 仍非空：
               * 用户随后离开页面，cleanup 看到 mode 非空，会把「已触发」
               * 覆盖成「<mode>（已交给系统）」，status 还说"可点取消" ——
               * 与"已经到点执行完了"的事实完全矛盾。
               * 清掉 mode/targetTs 后 cleanup 走的是"没有定时在跑"的分支，
               * 不再改写任何倒计时文案。 */
              mode = ''; targetTs = 0;
              countdown.textContent = '已触发（已结束）';
              countdown.className = 'tag tag-green';
              status.textContent = '定时已到点执行完毕';
              return;
            }
            const label = mode;
            countdown.textContent = `${label} ${fmtLeft(targetTs - Date.now())}`;
            countdown.className = 'tag tag-orange';
            timer = setInterval(() => {
              const left = targetTs - Date.now();
              if (left <= 0) {
                clearInterval(timer); timer = null;
                countdown.textContent = '已触发（已结束）'; countdown.className = 'tag tag-green';
                /* 到点清状态机：同 arm 的说明，避免被 cleanup 误描述成"已停止" */
                mode = ''; targetTs = 0;
                status.textContent = '定时已到点执行完毕';
              } else {
                countdown.textContent = `${label} ${fmtLeft(left)}`;
              }
            }, 500);
          } catch (e) {}
        });
      }
      function fmtLeft(ms) {
        const s = Math.max(0, Math.ceil(ms / 1000));
        return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }
      function arm(label, secs, fire) {
        if (timer) clearInterval(timer);
        targetTs = Date.now() + secs * 1000;
        mode = label;
        countdown.textContent = `${label} ${fmtLeft(secs * 1000)}`;
        countdown.className = 'tag tag-orange';
        timer = setInterval(() => {
          const left = targetTs - Date.now();
          if (left <= 0) {
            clearInterval(timer); timer = null;
            countdown.textContent = '已触发'; countdown.className = 'tag tag-green';
            /* 【到点后必须清掉状态机】否则离开页面时 cleanup 会按 mode
             * 仍非空把「已触发」改写成「提醒：已停止（离开页面）」——
             * 提醒其实已经正常响过了，却被描述成"因为离开页面而没响"。
             * 系统级模式同理：到点后不该再被当成"还在等"。 */
            mode = ''; targetTs = 0;
            fire();
          } else countdown.textContent = `${label} ${fmtLeft(left)}`;
        }, 500);
      }
      async function apply() {
        const mins = Math.max(1, +minIn.value || 1);
        const m = modeSel.value;
        if (m === 'remind') {
          if (!msgIn.value.trim()) return toast('请输入提醒内容', 'warn');
          arm('提醒', mins * 60, () => {
            try { new Notification('核核工具箱 · 定时提醒', { body: msgIn.value }); } catch (e) {}
            toast('⏰ ' + msgIn.value, 'info', 5000);
          });
          status.textContent = `将在 ${mins} 分钟后提醒`;
          return;
        }
        const confirmMsg = { shutdown: '关机', restart: '重启', sleep: '睡眠', lock: '锁屏' }[m];
        if (m === 'shutdown' || m === 'restart') {
          if (!(await confirmBox({ title: '定时' + confirmMsg, message: `${mins} 分钟后执行「${confirmMsg}」，确定？（期间可在此取消）`, okText: '确定' }))) return;
          let runRes = null;
          try {
            /* allowNonZero：非零退出也要拿到 { code, stdout, stderr }。
             * 不传的话主进程会 reject，而退出码（数字）不会随 IPC 错误回到这里
             * —— 下面按 code 分支的逻辑就成了永远走不到的死代码。 */
            runRes = await invoke(Channels.CHANNELS.EXEC.RUN, { cmd: `shutdown /${m === 'shutdown' ? 's' : 'r'} /t ${mins * 60}`, shellType: 'cmd', allowNonZero: true });
          } catch (e) {
            /* 被高危门禁拦住时只弹一句 toast 是不够的 —— 用户根本不知道
             * 「系统电源操作」这个开关在哪，只会以为是坏了。
             * 这里直接给出可点的引导，一键跳到设置页对应分区。 */
            const msg = window.api.errText ? window.api.errText(e) : (e && e.message) || String(e);
            const denied = (e && e.code === 'CAP_DENIED') || /高危功能|已默认关闭/.test(msg);
            if (denied) {
              /* 已离开页面就不再弹二级确认框（它会出现在别的工具页上），只留一句提示 */
              if (!pageShown) return toast(msg, 'error', 8000);
              const go = await confirmBox({
                title: '需要先开启「系统电源操作」',
                message: msg + '\n\n是否现在前往设置页开启？开启后即可使用定时关机 / 重启。',
                okText: '去设置开启'
              });
              if (go && window.App.openSettings) window.App.openSettings('danger');
              return;
            }
            return toast(msg, 'error');
          }
          /* 【必须检查退出码，否则是"假成功"】
           * shutdown 在以下情况会**以非零码退出**：
           *   1190 —— 已有一个关机/重启计划在排队（新的这次没排上）
           *   5    —— 拒绝访问（权限不足 / 被策略拦）
           *   1116 —— 当前没有待执行的关机计划（排期时不应出现，
           *            它是取消 `shutdown /a` 在"无计划"时的正常返回，见 cancel）
           * 原实现只看 invoke 有没有抛错就 arm() 并写"系统将在 N 分钟后执行"，
           * 而主进程的 runCmd 在"进程非零退出但打印过输出"时是 resolve 的，
           * 于是界面启动倒计时、承诺关机会发生，实际什么都没排上。
           * 现在：非零必须当作失败，不 arm、不改状态行，并如实报错。 */
          /* 【await 期间离开页面：计划已排上，但不能再动界面】
           * 确认框与 EXEC.RUN 都是 await；用户可能在此期间切走（cleanup 已跑）。
           * 计划是真的排上了，所以 mode/targetTs 必须记下来（回来时 onEnter
           * 据此恢复倒计时、用户也才能点取消）；但此时不 arm —— arm 起的
           * interval 没有任何人负责清，会一直空转到下次进出页面。 */
          if (!pageShown) { mode = confirmMsg; targetTs = Date.now() + mins * 60 * 1000; return; }
          const code = runRes && typeof runRes.code === 'number' ? runRes.code : 0;
          if (code !== 0) {
            const detail = (runRes && (runRes.stderr || runRes.stdout)) || '';
            status.textContent = '✗ 排期失败';
            return toast(`无法安排定时${confirmMsg}（shutdown 退出码 ${code}）` + (detail ? '：' + String(detail).split(/\r?\n/)[0] : '')
              + '。常见原因：已有一个关机/重启计划在排队（先点「取消」），或当前权限不足。', 'error', 8000);
          }
          arm(confirmMsg, mins * 60, () => {});
          status.textContent = `系统将在 ${mins} 分钟后${confirmMsg}（shutdown 计划，可点击取消）`;
        } else {
          if (!(await confirmBox({ title: '定时' + confirmMsg, message: `${mins} 分钟后执行「${confirmMsg}」？`, okText: '确定' }))) return;
          /* 【睡眠/锁屏交给主进程，不用页面 setInterval】
           * 原来这里是 arm(..., () => invoke(EXEC.RUN, ...)) —— 而 arm 的
           * setInterval 会被 App.onCleanup 在切页时清掉。用户设了
           * 「30 分钟后睡眠」，切到别的工具页待一会儿，倒计时没了、
           * 睡眠也不会发生，界面那句承诺已经落空。
           * 同一个卡片里关机/重启走系统 shutdown 计划（切页不影响），
           * 两种行为不一致最容易让人不信任。
           * 改走 SCHED.ONCE_ADD：主进程持久化计时，切页、关窗、重启都不影响。 */
          try {
            const r = await invoke(Channels.CHANNELS.SCHED.ONCE_ADD, { action: m === 'sleep' ? 'sleep' : 'lock', minutes: mins });
            /* 记下这一条的主进程 id：取消时只撤它自己建的这条，
             * 不再清空整张列表（见 cancel 的说明）。 */
            onceId = r && r.item ? r.item.id : null;
            /* 【await 期间离开页面】定时已交给主进程（切页不影响），但界面不能再动：
             * 只记状态、不 arm、不刷新列表；回来时 onEnter 会按 targetTs 恢复倒计时。 */
            if (!pageShown) { mode = confirmMsg; targetTs = Date.now() + mins * 60 * 1000; return; }
            /* 界面仍显示倒计时，但它只是"展示"，真正的执行在主进程 */
            arm(confirmMsg, mins * 60, () => {});
            const at = new Date(r.item.fireAt);
            status.textContent = `将在 ${minutesLaterText(at)}（${confirmMsg}）—— 已交给主进程，切换页面不影响`;
            loadOnce();
          } catch (e) {
            return toast(e.message, 'error');
          }
        }
      }
      /* 「还有多久」的人话表述：只给小时分钟，不给秒 —— 用户设的是分钟级 */
      function minutesLaterText(at) {
        const left = Math.max(0, Math.round((at.getTime() - Date.now()) / 60000));
        const h = Math.floor(left / 60), mm = left % 60;
        return (h ? h + ' 小时 ' : '') + mm + ' 分钟后执行';
      }
      async function cancel() {
        if (timer) { clearInterval(timer); timer = null; }
        /* 【取消必须核实"真的取消了"再改状态】
         * 原实现先把 mode/targetTs 清零，再用 try/catch 吞掉 shutdown /a 与
         * 每个 ONCE_REMOVE 的错误，最后无条件写"已取消定时任务"。
         * 问题：若取消本身失败（权限不足、计划已被系统拒绝、ONCE_REMOVE 抛错），
         * 系统里的关机计划**仍在**，而界面说已取消 —— 用户以为安全了，
         * 到点照样关机。这是比"没取消"更糟的假成功。
         *
         * 现在的顺序：
         *   ① 先清显示用的 interval（它纯粹是装饰，不清会继续倒数）；
         *   ② 逐项执行取消，**收集每一项的真实结果**（不吞错）；
         *   ③ 全部成功才清 mode/targetTs 并显示"已取消"；
         *   ④ 有任何失败 → 保留可操作状态（按钮仍可点、状态行报错），
         *      并明确告诉用户"可能仍在生效"，让他能重试或手动 shutdown /a。
         */
        /* ---- ① 提醒：纯应用内计时，不发任何 IPC ---- */
        if (mode === '提醒') {
          mode = ''; targetTs = 0; onceId = null;
          countdown.textContent = '已取消'; countdown.className = 'tag tag-gray';
          status.textContent = '已取消提醒';
          return;
        }
        /* 【按"当前是哪一种定时"决定取消什么，而不是一律全清】
         * 原实现只要 mode 非空就 `shutdown /a`，并且无条件清空整张一次性定时列表：
         *   · 睡眠/锁屏根本没有系统关机计划，`shutdown /a` 必然以 1116 退出
         *     （"no shutdown was in progress"）→ 被记成失败 → 用户设了睡眠后点取消，
         *     主进程里的定时**其实已经撤掉了**，界面却说"取消失败，计划可能仍在生效"，
         *     mode 也不清 —— 必现的假失败（权限不足是退出码 5，不是 1116）。
         *   · 取消一个"提醒"会把列表里所有睡眠/锁屏定时一起删掉（提醒与它们无关）。
         * 现在：
         *   · 关机/重启  → `shutdown /a`；0 = 已中止，1116 = 本来就没有计划，都算成功；
         *                  其它退出码 / 抛错才算失败。
         *   · 睡眠/锁屏  → 只撤本页建的那一条（onceId）；拿不到 onceId 时才退回"全撤"。
         *                  顺带 `shutdown /a` 兜底（用户先排过关机又排了睡眠的情况），
         *                  它的失败只作附注，不改变"定时已取消"的结论。
         *   · 没有倒计时  → 只做一次 `shutdown /a` 兜底（例如计划是重启应用前排的）。 */
        const failures = [];
        const isShutdownPlan = mode === '关机' || mode === '重启';
        const isOncePlan = mode === '睡眠' || mode === '锁屏';
        let sideNote = '';

        /* ---- ② 系统关机计划（兜底，总是试一次） ---- */
        let planAborted = false;
        try {
          const r = await invoke(Channels.CHANNELS.EXEC.RUN, { cmd: 'shutdown /a', shellType: 'cmd', allowNonZero: true });
          const code = r && typeof r.code === 'number' ? r.code : 0;
          planAborted = code === 0;
          /* 1116 = "没有正在进行的关机"：对"取消"而言就是目标状态，算成功。 */
          if (code !== 0 && code !== 1116) {
            const detail = String((r && (r.stderr || r.stdout)) || '').split(/\r?\n/)[0];
            const msg = 'shutdown /a 退出码 ' + code + (detail ? '（' + detail + '）' : '');
            if (isShutdownPlan) failures.push('取消防关机计划失败：' + msg);
            else sideNote = '未能确认系统关机计划：' + msg;
          }
        } catch (e) {
          const msg = (window.api.errText ? window.api.errText(e) : (e && e.message)) || String(e);
          /* 新版主进程带 allowNonZero 不会走到这里；旧版主进程会把 1116 当 reject，
           * 且数字退出码不会回到渲染层 —— 只能认"确实没有计划"这句原文。 */
          const noPlan = e && (e.code === 1116 || /no shutdown was in progress/i.test(e.stderr || e.stdout || (e.message || '')));
          /* 睡眠/锁屏模式下被电源门禁拦下：本应用没开「系统电源操作」，
           * 关机计划不可能是从这里排出去的 —— 不算失败，也不必附注吓人。 */
          const gated = e && e.code === 'CAP_DENIED';
          if (noPlan || (gated && !isShutdownPlan)) { /* 本来就没有（可由本应用排出的）计划：算成功 */ }
          else if (isShutdownPlan) failures.push('取消防关机计划失败：' + msg);
          else sideNote = '未能确认系统关机计划：' + msg;
        }

        /* ---- ③ 主进程里的一次性睡眠/锁屏：只撤本页建的那条 ---- */
        if (isOncePlan) {
          try {
            const list = await invoke(Channels.CHANNELS.SCHED.ONCE_LIST);
            const all = Array.isArray(list) ? list : [];
            /* onceId 对不上（已被到点消费 / 在列表里手动删过）→ 没有东西要撤，直接算成功 */
            const targets = onceId ? all.filter((it) => it && it.id === onceId) : all;
            for (const it of targets) {
              try {
                await invoke(Channels.CHANNELS.SCHED.ONCE_REMOVE, it.id);
              } catch (e) {
                /* 【每个都要单独记账，不能一 catch 全吞】
                 * 原来是一个 catch 包住整个循环：第一条失败后剩下的全不执行，
                 * 而界面照样说"已取消"—— 可能还留着第二个、第三个计划。 */
                failures.push('撤销「' + (it.action === 'lock' ? '锁屏' : '睡眠') + '」定时失败：' + ((e && e.message) || String(e)));
              }
            }
          } catch (e) {
            failures.push('读取一次性定时列表失败：' + ((e && e.message) || String(e)));
          }
        }

        /* ---- ④ 决策：全成功才真正清状态 ---- */
        loadOnce();
        if (!failures.length) {
          const hadMode = !!mode;
          mode = ''; targetTs = 0;
          onceId = null;
          countdown.textContent = '已取消'; countdown.className = 'tag tag-gray';
          let ok = '已取消定时任务';
          if (!hadMode) ok = planAborted ? '已中止系统里遗留的关机计划' : '没有正在倒计时的定时，系统里也没有待执行的关机计划';
          else if (isShutdownPlan) ok += planAborted ? '（系统关机计划已中止）' : '（系统里已没有待执行的关机计划）';
          if (sideNote) ok += '；' + sideNote + '，如排过关机请手动运行 shutdown /a';
          status.textContent = ok;
          return;
        }
        /* 有失败：不清 mode/targetTs（计划可能仍在），把问题如实摆出来 */
        status.innerHTML = '<span class="status-err">✗ 取消失败，计划可能仍在生效</span>';
        countdown.className = 'tag tag-red';
        /* 【失败后倒计时必须继续跳】上面已经 clearInterval；不重挂的话界面会停在
         * 红色的"关机"两个字上一动不动，看起来像卡死。重挂展示用的 interval
         * （fire 是空函数，真正的执行在系统/主进程），文案由它每 500ms 刷新。 */
        if (isShutdownPlan || isOncePlan) {
          arm(mode, Math.max(1, Math.ceil((targetTs - Date.now()) / 1000)), () => {});
          countdown.className = 'tag tag-red';
        } else {
          countdown.textContent = '取消失败';
        }
        /* 明确给出下一步：用户可以重试，或手动执行 shutdown /a */
        toast('取消失败：' + failures[0] + (failures.length > 1 ? `（共 ${failures.length} 项失败）` : '')
          + '\n如仍显示已排期，可手动运行 shutdown /a', 'error', 10000);
      }
      /* 列出主进程里挂着的一次性定时，让用户看得见、能单独删 */
      const onceList = div('');
      async function loadOnce() {
        const list = await invoke(Channels.CHANNELS.SCHED.ONCE_LIST).catch(() => []);
        onceList.innerHTML = '';
        if (!list || !list.length) { onceList.appendChild(div('empty-tip', '没有挂起的一次性定时')); return; }
        for (const it of list) {
          const at = new Date(it.fireAt);
          onceList.appendChild(div('form-row',
            h('span', { class: 'tag tag-orange', style: { width: '48px', justifyContent: 'center' } }, it.action === 'lock' ? '锁屏' : '睡眠'),
            h('span', { style: { flex: '1', fontSize: '12px' } }, `${minutesLaterText(at)}（${at.toLocaleTimeString('zh-CN', { hour12: false })}）`),
            btn('删除', 'btn-sm btn-text', async () => {
              await invoke(Channels.CHANNELS.SCHED.ONCE_REMOVE, it.id).catch(() => {});
              loadOnce();
            })));
        }
      }
      /* 主进程到点执行时推一条，界面同步刷新列表（多个窗口都收到）。
       * 【订阅要能"关掉再装回来"】
       * 保活复用不重新 render，所以切走时退订、切回来必须重新订阅，
       * 否则定时到点后这个页面收不到通知，列表永远停在旧数据上。
       * 抽成函数：初次 render 调一次、onEnter 再调一次（可重入，先退旧的）。 */
      let unsubOnce = null;
      function bindOnce() {
        if (unsubOnce) { try { unsubOnce(); } catch (e) {} unsubOnce = null; }
        unsubOnce = window.api.on('sched:once-fired', () => { loadOnce(); });
      }
      bindOnce();
      window.App.onCleanup(() => { try { if (unsubOnce) unsubOnce(); } catch (e) {} unsubOnce = null; });
      /* 【复用回来必须同时 loadOnce()】
       * 只 bindOnce() 会漏掉「离开期间已经触发的事件」：事件在那一瞬间推过来时
       * 本页已退订，列表仍是旧数据；返回后不重新拉一次，用户看到的是
       * 一个已经执行完却还挂在"待执行"里的定时 —— 与主进程状态不一致。 */
      if (window.App.onEnter) window.App.onEnter(() => { bindOnce(); loadOnce(); });
      page.appendChild(div('card', div('card-title', '一次性定时'),
        div('form-row', h('span', { class: 'form-label' }, '动作'), modeSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '分钟'), minIn, msgIn),
        div('form-row', btn('设置', 'btn-primary', apply, 'timer'), ' ', btn('取消', 'btn-danger-plain', cancel, 'square'), countdown, status),
        /* 【提示文案必须如实反映两种不同的持久性】
         * 关机/重启走系统 shutdown 计划：切页、关程序都仍然会执行。
         * 睡眠/锁屏走主进程持久化计时：切页不影响，重启后仍会恢复。
         * 提醒是应用内的 toast + 系统通知，切页会停 —— 这条必须写出来。 */
        div('field-hint', '关机/重启走系统 shutdown 计划（关机前弹窗可跳过）；睡眠/锁屏由主进程计时，切换页面、重开应用都仍然生效；提醒在应用内计时，离开页面会停止'),
        div('field-hint', { style: { marginTop: '6px' } }, '挂起中的一次性定时：'),
        onceList));
      loadOnce();

      /* ---- 周期任务（主进程持久化调度，重启应用后依然生效） ---- */
      const rType = h('select', { class: 'select input-sm' },
        h('option', { value: 'daily' }, '每天定时提醒'),
        h('option', { value: 'loop' }, '循环提醒（每 N 分钟）'),
        h('option', { value: 'clean' }, '每天自动清理本应用临时文件'));
      const rTime = h('input', { type: 'time', class: 'input input-sm', value: '09:00', style: { width: '100px' } });
      const rEvery = h('input', { type: 'number', class: 'input input-sm', value: '60', min: '1', style: { width: '70px' } });
      const rMsg = h('input', { class: 'input input-sm', placeholder: '提醒时显示的文字（选择「提醒」时必填）', style: { flex: '1' } });
      const rList = div('');
      async function loadRecurring() {
        const list = await invoke(Channels.CHANNELS.SCHED.LIST).catch(() => []);
        rList.innerHTML = '';
        if (!list.length) { rList.appendChild(div('empty-tip', '没有周期任务')); return; }
        for (const s of list) {
          const desc = s.type === 'daily' ? `每天 ${s.hhmm} 提醒：${s.message}`
            : s.type === 'loop' ? `每 ${s.everyMin} 分钟提醒：${s.message || '（循环提醒）'}`
            : `每天 ${s.hhmm} 自动清理本应用临时文件`;
          rList.appendChild(div('form-row',
            h('span', { class: 'tag ' + (s.type === 'clean' ? 'tag-green' : 'tag-blue'), style: { width: '48px', justifyContent: 'center' } }, s.type === 'clean' ? '清理' : '提醒'),
            h('span', { style: { flex: '1', fontSize: '12px' } }, desc),
            btn('删除', 'btn-sm btn-text', async () => { await invoke(Channels.CHANNELS.SCHED.REMOVE, s.id); loadRecurring(); })));
        }
      }
      const rAddBtn = btn('添加周期任务', 'btn-primary', async () => {
        const t = rType.value;
        const s = { type: t };
        if (t === 'daily') { s.hhmm = rTime.value || '09:00'; s.message = rMsg.value.trim(); if (!s.message) return toast('请输入提醒内容', 'warn'); }
        else if (t === 'loop') { s.everyMin = Math.max(1, +rEvery.value || 60); s.message = rMsg.value.trim() || '循环提醒'; }
        else { s.hhmm = rTime.value || '03:00'; s.message = ''; }
        try { await invoke(Channels.CHANNELS.SCHED.ADD, s); toast('已添加（重启应用后依然生效）', 'success'); rMsg.value = ''; loadRecurring(); }
        catch (e) { toast(e.message, 'error'); }
      });
      /* 「时间」和「间隔」各有「标签 + 控件」两段，必须一起隐藏。
       * 旧实现只藏了控件（rEvery.style.display），「间隔」这个小标签留在原地悬空，
       * 于是 daily 模式下会看到一个没有任何控件跟随的「间隔」二字。 */
      const timeWrap = h('span', { class: 'form-inline' },
        h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '时间'), rTime);
      const everyWrap = h('span', { class: 'form-inline' },
        h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '间隔'), rEvery);
      const refreshR = () => {
        const isLoop = rType.value === 'loop';
        timeWrap.style.display = isLoop ? 'none' : '';
        everyWrap.style.display = isLoop ? '' : 'none';
      };
      rType.addEventListener('change', refreshR); refreshR();
      page.appendChild(div('card', div('card-title', '周期任务（持久化）'),
        div('form-row', h('span', { class: 'form-label' }, '类型'), rType,
          timeWrap, everyWrap, rMsg),
        div('form-row', rAddBtn),
        rList,
        div('field-hint', '周期任务由主进程调度并随配置持久化：到点弹系统通知；自动清理只删除本应用自己的临时文件（截图、录制分段、FFmpeg 下载包），不会动系统临时目录里的其他文件')));
      loadRecurring();
    }
  });
})();
