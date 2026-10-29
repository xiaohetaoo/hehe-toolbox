/* 模块：系统与硬件 —— 硬件信息 / 监控 / 进程 / 自启 / 磁盘 / 垃圾 / 空目录 / 快捷操作 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, confirmBox, renderTable, fmtBytes, fmtNum, fmtDate, progressEl } = window.ui;
  const { invoke, on, isDesktop } = window.api;
  const MOD = 'system';

  /* ---------- 硬件信息总览 ---------- */
  register({
    id: 'hw-info', name: '硬件信息总览', module: MOD, icon: 'cpu',
    desc: 'CPU、内存、硬盘、显卡、主板、网卡与电池信息',
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
          const info = await invoke('sys:hw-info', !!force);
          if (t !== loadSeq) return;
          body.innerHTML = '';
          body.appendChild(sectionCard('🖥 处理器 CPU', [
            ['型号', info.cpu.Name], ['物理核心', info.cpu.NumberOfCores], ['逻辑核心', info.cpu.NumberOfLogicalProcessors],
            ['基准频率', info.cpu.MaxClockSpeed ? (info.cpu.MaxClockSpeed + ' MHz') : '-'], ['当前负载', info.cpu.LoadPercentage != null ? info.cpu.LoadPercentage + '%' : '-']
          ]));
          body.appendChild(sectionCard('💻 内存', [
            ['总容量', fmtBytes(info.memTotal)], ['可用', fmtBytes(info.memFree)],
            ['已用', fmtBytes(info.memTotal - info.memFree) +
              // memTotal 为 0/缺失时（虚拟机、WMI 异常返回）不能显示 NaN%
              (info.memTotal > 0 ? `（${((1 - info.memFree / info.memTotal) * 100).toFixed(0)}%）` : '')]
          ]));
          body.appendChild(sectionCard('🎮 显卡', info.gpu.map(g => [g.Name, `驱动 ${g.DriverVersion || '-'}`])));
          body.appendChild(sectionCard('💾 硬盘', info.disks.map(d => [d.Model, d.Size ? fmtBytes(Number(d.Size)) + `（${d.InterfaceType || ''}）` : '-'])));
          body.appendChild(sectionCard('📀 分区', info.partitions.filter(p => p.type === 3).map(p =>
            [p.drive + ' ' + p.label, `${fmtBytes(p.size)} 总 / ${fmtBytes(p.free)} 可用`])));
          body.appendChild(sectionCard('🔌 主板与 BIOS', [
            ['主板', `${info.board.Manufacturer || '-'} ${info.board.Product || ''}`],
            ['BIOS', `${info.bios.Manufacturer || '-'} ${info.bios.SMBIOSBIOSVersion || ''}`]
          ]));
          body.appendChild(sectionCard('🖧 网卡', info.nic.map(n => [n.Name, n.MACAddress || '-'])));
          body.appendChild(sectionCard('🦾 操作系统', [
            ['系统', info.os.Caption], ['版本', `${info.os.Version} (${info.os.BuildNumber}) ${info.os.OSArchitecture || ''}`],
            ['上次启动', info.os.LastBootUpTime ? fmtDate(new Date(info.os.LastBootUpTime).getTime()) : '-'],
            ['运行时长', fmtTimeDur(info.uptimeS)]
          ]));
          if (info.battery && info.battery.EstimatedChargeRemaining != null) {
            const batRows = [
              ['电量', info.battery.EstimatedChargeRemaining + '%'],
              ['状态', info.battery.BatteryStatus === 2 ? '接通电源' : '使用电池']
            ];
            try {
              const bat = await invoke('sys:battery-detail');
              if (t !== loadSeq) return;
              if (bat && bat.designCap) {
                batRows.push(['设计容量', bat.designCap + ' mWh']);
                batRows.push(['当前满充容量', bat.fullCap + ' mWh']);
                batRows.push(['电池健康度', h('span', { class: bat.health >= 80 ? 'status-ok' : bat.health >= 60 ? 'status-warn' : 'status-err' }, String(bat.health) + '%')]);
              }
            } catch (e) {}
            body.appendChild(sectionCard('🔋 电池', batRows));
          }
          if (info.temps && info.temps.length) {
            body.appendChild(sectionCard('🌡 温度', info.temps.map(t => [t.name, t.celsius + ' °C'])));
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
      function sectionCard(title, pairs) {
        const card = div('card');
        card.appendChild(div('card-title', null, title));
        card.appendChild(window.ui.kvGrid(pairs.length ? pairs : [['-', '-']]));
        return card;
      }
      page.appendChild(div('card', div('card-title', '硬件概览'), btn('🔄 刷新', 'btn-sm btn-secondary', () => load(true))));
      page.appendChild(body);
      load(false);
    }
  });

  /* ---------- 实时状态监控 ---------- */
  register({
    id: 'monitor', name: '实时状态监控', module: MOD, icon: 'activity',
    desc: 'CPU / 内存实时曲线与磁盘用量，阈值变色提醒',
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
      const unsub = on('sys:stats', (s) => {
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
      invoke('sys:hw-info').then(info => {
        diskBox.innerHTML = '';
        for (const p of info.partitions.filter(x => x.type === 3 && x.size > 0)) {
          const usedPct = (1 - p.free / p.size) * 100;
          diskBox.appendChild(div('form-row',
            h('span', { class: 'form-label', style: { minWidth: '60px' } }, p.drive),
            h('div', { class: 'progress', style: { flex: '1' } }, h('div', { class: 'progress-fill', style: { width: usedPct + '%', background: usedPct >= 90 ? 'var(--danger)' : usedPct >= 70 ? 'var(--warning)' : 'var(--primary)' } })),
            h('span', { class: 'field-hint', style: { width: '180px' } }, `${fmtBytes(p.size - p.free)} / ${fmtBytes(p.size)}（${usedPct.toFixed(0)}%）`)));
        }
      }).catch(() => {});
      page.appendChild(div('card', div('card-title', 'CPU 使用率'), h('div', { style: { marginBottom: '8px' } }, cpuNow, h('span', { class: 'stat-unit' }, '%')), cpuCanvas));
      page.appendChild(div('card', div('card-title', '内存使用率'), h('div', { style: { marginBottom: '8px' } }, memNow, h('span', { class: 'stat-unit' }, '%')), memCanvas));
      page.appendChild(div('card', div('card-title', '磁盘用量'), diskBox));
      window.App.onCleanup(unsub);
    }
  });

  /* ---------- 进程管理 ---------- */
  register({
    id: 'process-manager', name: '进程管理', module: MOD, icon: 'list',
    desc: '进程列表搜索、按资源排序、查看路径、一键结束',
    keywords: ['进程', 'task', '结束进程'],
    render(page) {
      const searchIn = h('input', { class: 'input input-sm', placeholder: '搜索进程名…', style: { flex: '1' } });
      const box = div('');
      const status = h('span', { class: 'field-hint' }, '');
      let procs = [], sortKey = 'cpuPct', sortDir = -1;
      async function refresh() {
        status.textContent = '加载中…';
        try {
          procs = await invoke('proc:list');
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
                    const d = await invoke('proc:detail', r.pid);
                    window.ui.modal({
                      title: `进程详情：${r.name} (${r.pid})`,
                      body: (b) => b.appendChild(window.ui.kvGrid([
                        ['进程名', r.name], ['PID', r.pid], ['内存', fmtBytes(r.memKB * 1024)],
                        ['累计 CPU 时间', r.cpu != null ? r.cpu.toFixed(2) + ' s' : '-'],
                        ['可执行路径', d.path || '-'], ['命令行', d.cmdline || '-']
                      ])),
                      foot: [h('button', { class: 'btn btn-primary', onclick: function () { this.closest('.modal-mask').remove(); } }, '关闭')]
                    });
                  } catch (e) { toast(e.message, 'error'); }
                }));
                td.appendChild(btn('结束', 'btn-sm btn-danger-plain', async () => {
                  if (!(await confirmBox({ title: '结束进程', message: `确定结束进程 ${r.name}（PID ${r.pid}）？未保存的数据可能丢失。`, danger: true, okText: '结束' }))) return;
                  try { await invoke('proc:kill', r.pid); toast('已结束', 'success'); setTimeout(refresh, 500); }
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
      const refreshBtn = btn('🔄 刷新', 'btn-sm btn-secondary', refresh);
      let autoTimer = null;
      window.App.onCleanup(() => { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } });
      const autoSw = window.ui.switchEl(false, (v) => {
        if (v) autoTimer = setInterval(refresh, 4000); else { clearInterval(autoTimer); autoTimer = null; }
      });
      page.appendChild(div('card', div('card-title', '进程列表', status),
        div('form-row', searchIn, refreshBtn, h('label', { class: 'field-hint' }, autoSw, ' 自动刷新(4s)'))));
      page.appendChild(box);
      refresh();
    }
  });

  /* ---------- 开机自启管理 ---------- */
  register({
    id: 'autostart', name: '开机自启管理', module: MOD, icon: 'power',
    desc: '查看注册表自启项，支持禁用 / 启用 / 删除',
    keywords: ['自启', '启动项', '开机'],
    render(page) {
      const box = div('');
      const status = h('span', { class: 'field-hint' }, '');
      async function load() {
        box.innerHTML = '';
        status.textContent = '读取注册表…';
        try {
          const items = await invoke('autostart:list');
          const disabled = await invoke('autostart:disabled-list');
          status.textContent = `${items.length} 个自启项，${disabled.length} 个已禁用`;
          if (!items.length) { box.appendChild(div('empty-tip', '没有开机自启项')); return; }
          const table = renderTable({
            columns: [
              { key: 'name', title: '名称', render: r => h('span', { style: { fontWeight: 500 } }, r.name) },
              { key: 'label', title: '范围', width: '90px', render: r => h('span', { class: 'tag tag-gray' }, r.label) },
              { key: 'cmd', title: '命令', render: r => div('mono', { style: { fontSize: '11.5px' } }, r.cmd) },
              { key: 'act', title: '操作', width: '220px', render: (r, td) => {
                  td.appendChild(btn('禁用', 'btn-sm btn-text', async () => {
                    // 禁用 = 把注册表项移到本应用的备份区（可恢复），但仍是写注册表，
                    // 列表项多时容易点错，所以也确认一次，并说明如何恢复。
                    if (!(await confirmBox({
                      title: '禁用开机自启',
                      message: `禁用「${r.name}」的开机自启？\n\n该自启项会被移到本应用的备份区，之后可在下方「已禁用」列表里恢复启用。`,
                      okText: '禁用'
                    }))) return;
                    try { await invoke('autostart:delete', r, false); toast('已禁用（可恢复）', 'success'); load(); }
                    catch (e) { toast(e.message, 'error'); }
                  }));
                  td.appendChild(btn('永久删除', 'btn-sm btn-danger-plain', async () => {
                    if (!(await confirmBox({ title: '永久删除自启项', message: `删除「${r.name}」的自启注册表项？此操作不可恢复。`, danger: true, okText: '删除' }))) return;
                    try { await invoke('autostart:delete', r, true); toast('已删除', 'success'); load(); }
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
                  try { await invoke('autostart:enable', d); toast('已启用', 'success'); load(); }
                  catch (e) { toast(e.message, 'error'); }
                })));
            }
            box.appendChild(dCard);
          }
        } catch (e) { status.textContent = '✗ ' + e.message; }
      }
      page.appendChild(div('card', div('card-title', '自启项', btn('🔄 刷新', 'btn-sm btn-secondary', load)), status));
      page.appendChild(box);
      load();
    }
  });

  /* ---------- 磁盘空间分析 ---------- */
  register({
    id: 'disk-analyze', name: '磁盘空间分析', module: MOD, icon: 'harddrive',
    desc: '扫描目录，找出大文件与大文件夹占比',
    keywords: ['磁盘', '空间', '大文件', '分析'],
    render(page) {
      const dirIn = h('input', { class: 'input', placeholder: '要分析的目录或分区（如 D:\\）', style: { flex: '1' } });
      const pickBtn = btn('选择目录', 'btn-secondary btn-sm', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) dirIn.value = d[0];
      });
      const status = h('span', { class: 'field-hint' }, '');
      const prog = progressEl(); prog.hide();
      const result = div('');
      const scanBtn = btn('开始分析', 'btn-primary', async () => {
        const dir = dirIn.value.trim();
        if (!dir) return toast('请选择目录', 'warn');
        result.innerHTML = ''; prog.show(); scanBtn.disabled = true;
        const unsub = on('job:progress', (d) => { if (d.kind === 'scan') status.textContent = `已扫描 ${fmtNum(d.files)} 个文件，${fmtBytes(d.size)}`; });
        try {
          const r = await invoke('fs:scan-tree', dir, {});
          status.textContent = `完成：${fmtNum(r.files)} 个文件 / ${fmtNum(r.dirCount)} 个文件夹 / 总计 ${fmtBytes(r.totalSize)}`;
          result.innerHTML = '';
          const c1 = div('card', div('card-title', `最大文件 TOP ${r.topFiles.length}`));
          const maxF = r.topFiles[0] ? r.topFiles[0].size : 1;
          for (const f of r.topFiles.slice(0, 20)) {
            c1.appendChild(div('form-row',
              h('div', { class: 'progress', style: { flex: '1', height: '10px' } }, h('div', { class: 'progress-fill', style: { width: (f.size / maxF * 100) + '%' } })),
              h('span', { class: 'mono', style: { width: '70px', fontSize: '12px', textAlign: 'right' } }, fmtBytes(f.size)),
              btn('查看', 'btn-sm btn-text', () => invoke('fs:show-item', f.path))));
            c1.appendChild(div('mono', { style: { fontSize: '11.5px', color: 'var(--text-3)', marginTop: '-6px', marginBottom: '6px', wordBreak: 'break-all' } }, f.path));
          }
          const c2 = div('card', div('card-title', '最大文件夹'));
          const maxD = r.topDirs[0] ? r.topDirs[0].size : 1;
          for (const d of r.topDirs.slice(0, 20)) {
            c2.appendChild(div('form-row',
              h('span', { class: 'mono', style: { flex: '1', fontSize: '12px', wordBreak: 'break-all' } }, d.path),
              h('div', { class: 'progress', style: { width: '160px' } }, h('div', { class: 'progress-fill', style: { width: (d.size / maxD * 100) + '%' } })),
              h('span', { class: 'mono', style: { width: '80px', fontSize: '12px', textAlign: 'right' } }, fmtBytes(d.size))));
          }
          result.appendChild(c1); result.appendChild(c2);
        } catch (e) {
          status.textContent = '✗ ' + e.message;
        } finally { prog.hide(); scanBtn.disabled = false; unsub(); }
      });
      page.appendChild(div('card', div('card-title', '分析目标'),
        div('form-row', dirIn, pickBtn),
        div('form-row', scanBtn, prog.el, status)));
      page.appendChild(result);
    }
  });

  /* ---------- 垃圾清理 ---------- */
  register({
    id: 'junk-clean', name: '垃圾清理', module: MOD, icon: 'trash',
    desc: '扫描临时文件与缓存，勾选后一键清理（含回收站）',
    keywords: ['垃圾', '清理', '缓存', '临时文件'],
    render(page) {
      const box = div('');
      const status = h('span', { class: 'field-hint' }, '');
      let items = [];
      const scanBtn = btn('开始扫描', 'btn-primary', async () => {
        if (!isDesktop) return toast('桌面端可用', 'warn');
        box.innerHTML = ''; status.textContent = '扫描中…'; scanBtn.disabled = true;
        try {
          items = await invoke('fs:scan-junk');
          status.textContent = items.length ? `发现 ${items.length} 类可清理项` : '很干净，没有发现可清理项 ✓';
          draw();
        } catch (e) { status.textContent = '✗ ' + e.message; }
        finally { scanBtn.disabled = false; }
      });
      function draw() {
        box.innerHTML = '';
        for (const it of items) {
          const cb = h('input', { type: 'checkbox', class: 'checkbox', checked: true, dataset: { id: it.id } });
          box.appendChild(div('form-row', cb,
            div('', h('div', null, h('b', null, it.label)), h('div', { class: 'field-hint mono', style: { fontSize: '11.5px' } }, it.path)),
            h('span', { class: 'tag tag-blue', style: { marginLeft: 'auto' } }, fmtBytes(it.size)),
            h('span', { class: 'field-hint', style: { width: '80px', textAlign: 'right' } }, it.files + ' 个文件')));
        }
      }
      const cleanBtn = btn('🧹 清理勾选项', 'btn-danger', async () => {
        const selected = items.filter(it => box.querySelector(`input[data-id="${it.id}"]`)?.checked);
        if (!selected.length) return toast('请先扫描并勾选', 'warn');
        const total = selected.reduce((s, i) => s + i.size, 0);
        if (!(await confirmBox({ title: '清理垃圾文件', message: `将永久删除 ${selected.length} 类共约 ${fmtBytes(total)} 的文件（不进回收站），确定继续？`, danger: true, okText: '清理' }))) return;
        try {
          const targets = selected.flatMap(i => i.targets);
          const r = await invoke('fs:clean-junk', targets, true);
          toast(`已清理 ${fmtBytes(r.bytes)}`, 'success');
          scanBtn.click();
        } catch (e) { toast(e.message, 'error'); }
      });
      const rbBtn = btn('清空回收站', 'btn-danger-plain', async () => {
        if (!(await confirmBox({ title: '清空回收站', message: '确定清空系统回收站？此操作不可恢复。', danger: true, okText: '清空' }))) return;
        try { await invoke('sys:recycle-empty'); toast('回收站已清空', 'success'); }
        catch (e) { toast(e.message, 'error'); }
      });
      page.appendChild(div('card', div('card-title', '扫描与清理'),
        div('form-row', scanBtn, cleanBtn, rbBtn, status)));
      page.appendChild(box);
    }
  });

  /* ---------- 空目录批量清理 ---------- */
  register({
    id: 'empty-dir-clean', name: '空目录清理', module: MOD, icon: 'folder',
    desc: '递归扫描并删除指定路径下的所有空文件夹',
    keywords: ['空目录', '空文件夹', '清理'],
    render(page) {
      const dirIn = h('input', { class: 'input', placeholder: '要扫描的目录', style: { flex: '1' } });
      const pickBtn = btn('选择目录', 'btn-secondary btn-sm', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) dirIn.value = d[0];
      });
      const status = h('span', { class: 'field-hint' }, '');
      const box = div('');
      let dirs = [];
      const scanBtn = btn('扫描空目录', 'btn-primary', async () => {
        const dir = dirIn.value.trim();
        if (!dir) return toast('请选择目录', 'warn');
        box.innerHTML = ''; status.textContent = '扫描中…';
        try {
          const r = await invoke('fs:scan-empty-dirs', dir);
          dirs = r.dirs.filter(d => d.path !== dir);
          status.textContent = dirs.length ? `发现 ${dirs.length} 个空目录` : '没有空目录 ✓';
          draw();
        } catch (e) { status.textContent = '✗ ' + e.message; }
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
      const delBtn = btn('🗑 删除全部空目录', 'btn-danger', async () => {
        if (!dirs.length) return toast('请先扫描', 'warn');
        if (!(await confirmBox({ title: '删除空目录', message: `将删除 ${dirs.length} 个空目录，确定继续？`, danger: true, okText: '删除' }))) return;
        try {
          const r = await invoke('fs:delete-empty', dirs);
          toast(`已删除 ${r.deleted} 个空目录`, 'success');
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
    id: 'quick-ops', name: '系统快捷操作', module: MOD, icon: 'zap',
    desc: '锁屏、休眠、重启、关机、清空回收站与剪贴板',
    keywords: ['锁屏', '关机', '重启', '休眠'],
    render(page) {
      const actions = [
        ['🔒 立即锁屏', '锁屏后需输入密码解锁，继续？', 'lock', false],
        ['🌙 睡眠', '进入睡眠状态，继续？', 'sleep', false],
        ['💤 休眠', '进入休眠状态（内存写入硬盘），继续？', 'hibernate', false],
        ['🔄 重启系统', '系统将立即重启，未保存数据会丢失！', 'restart', true],
        ['⏻ 关机', '系统将立即关机，未保存数据会丢失！', 'shutdown', true]
      ];
      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' } });
      for (const [label, msg, action, danger] of actions) {
        const b = btn(label, danger ? 'btn-danger-plain' : 'btn-secondary', async () => {
          if (!(await confirmBox({ title: label, message: msg, danger, okText: '确认执行' }))) return;
          try { await invoke('sys:power', action); toast('已执行', 'success'); }
          catch (e) { toast(e.message, 'error'); }
        });
        b.style.height = '52px';
        grid.appendChild(b);
      }
      page.appendChild(div('card', div('card-title', '电源操作'), grid));
      page.appendChild(div('card', div('card-title', '清理操作'),
        div('form-row',
          btn('🗑 清空回收站', 'btn-danger-plain', async () => {
            if (!(await confirmBox({ title: '清空回收站', message: '确定清空回收站？不可恢复。', danger: true, okText: '清空' }))) return;
            try { await invoke('sys:recycle-empty'); toast('已清空', 'success'); } catch (e) { toast(e.message, 'error'); }
          }),
          btn('📋 清空剪贴板', 'btn-secondary', async () => {
            try { await invoke('clip:write-text', ''); toast('剪贴板已清空', 'success'); } catch (e) { toast(e.message, 'error'); }
          }))));
    }
  });

  /* ---------- 右键菜单管理 ---------- */
  register({
    id: 'ctxmenu-manage', name: '右键菜单管理', module: MOD, icon: 'list',
    desc: '管理文件/文件夹右键菜单项，禁用冗余项（可随时恢复）',
    keywords: ['右键', '菜单', 'context', '清理'],
    render(page) {
      const box = div('');
      const status = h('span', { class: 'field-hint' }, '');
      page.appendChild(div('card', div('card-title', '说明', btn('🔄 刷新', 'btn-sm btn-secondary', load), status),
        div('field-hint', '列出注册表中的经典右键菜单项。禁用会写入 LegacyDisable 标记（可随时恢复，不删除任何内容）；写入需要管理员权限，普通权限下仅可查看。')));
      async function load() {
        box.innerHTML = '';
        status.textContent = '读取注册表…';
        try {
          const groups = await invoke('ctxmenu:list');
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
                          try { await invoke('ctxmenu:toggle', r, false); toast('已启用', 'success'); load(); }
                          catch (e) { toast(/access|拒绝/i.test(e.message) ? '需要管理员权限，请以管理员身份运行工具箱' : e.message, 'error'); }
                        })
                      : btn('禁用', 'btn-sm btn-text', async () => {
                          try { await invoke('ctxmenu:toggle', r, true); toast('已禁用（可恢复）', 'success'); load(); }
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
    id: 'win-classic-menu', name: '经典右键菜单', module: MOD, icon: 'list',
    desc: '一键切换 Win11 右键菜单为 Win10 经典样式（可随时还原）',
    keywords: ['右键', '菜单', '经典', 'win11', 'contextmenu'],
    render(page) {
      const statusLine = h('div', { class: 'field-hint' }, '检测当前状态…');
      async function refresh() {
        try { const s = await invoke('ctxmenu:classic-status'); statusLine.textContent = s.on ? '当前：经典菜单（Win10 样式）' : '当前：Win11 新版菜单'; }
        catch (e) { statusLine.textContent = '状态检测失败'; }
      }
      // 以主进程回写的真实注册表状态为准：不再无条件弹「已切换」，
      // 写失败或被系统拒绝时如实报错，避免又一次假阳性。
      const apply = (on) => invoke('ctxmenu:classic', on, false).then((r) => {
        const nowOn = !!(r && r.on);
        if (nowOn === !!on) toast(on ? '已切换为经典菜单' : '已恢复 Win11 菜单', 'success');
        else toast(on ? '切换失败：注册表未写入，请检查权限' : '恢复失败：注册表项未能清除，请检查权限', 'error');
        refresh();
      }).catch((e) => toast(e.message, 'error'));
      page.appendChild(div('card', div('card-title', '右键菜单样式'), statusLine,
        div('form-row',
          btn('切换为经典菜单', 'btn-primary', async () => {
            if (!(await confirmBox({ title: '切换经典菜单', message: '将注册表写入经典菜单开关，需要重启资源管理器后生效。立即重启资源管理器吗？（不重启也可稍后手动注销/重启系统）', okText: '切换并立即生效' })))
              return apply(true);
            // 成功/失败必须是互斥的：原来 catch 里弹了错误后又无条件弹「已切换并重启」，
            // 用户会同时看到红色"需要管理员权限"和绿色"已切换"，无法判断到底改没改。
            try {
              const r = await invoke('ctxmenu:classic', true, true);
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
    id: 'window-manager', name: '窗口管理', module: MOD, icon: 'grid',
    desc: '列出当前所有窗口：置顶/取消置顶、调节透明度、置底',
    keywords: ['窗口', '置顶', '透明', '管理', 'topmost'],
    render(page) {
      const listBox = div('');
      const status = h('span', { class: 'field-hint' }, '');
      const refreshBtn = btn('🔄 刷新', 'btn-sm btn-secondary', load);
      async function load() {
        listBox.innerHTML = '';
        listBox.appendChild(window.ui.loadingBlock('枚举窗口…'));
        try {
          const rows = await invoke('winmgr:list');
          listBox.innerHTML = '';
          status.textContent = `${rows.length} 个窗口`;
          for (const w of rows) {
            const row = div('form-row',
              h('span', { class: 'tag ' + (w.topmost ? 'tag-orange' : 'tag-gray'), style: { width: '52px', justifyContent: 'center' } }, w.topmost ? '置顶' : '普通'),
              h('span', { class: 'mono', style: { width: '110px', fontSize: '11px' } }, w.proc),
              h('span', { style: { flex: '1', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: w.title }, w.title));
            row.appendChild(btn(w.topmost ? '取消置顶' : '置顶', 'btn-sm btn-text', async () => {
              try { await invoke('winmgr:topmost', w.hwnd, !w.topmost); toast('已' + (w.topmost ? '取消置顶' : '置顶'), 'success'); load(); }
              catch (e) { toast(e.message, 'error'); }
            }));
            const opSel = h('select', { class: 'select', style: { width: '76px', fontSize: '12px' } },
              h('option', { value: '' }, '透明'),
              h('option', { value: '255' }, '100%'), h('option', { value: '200' }, '80%'),
              h('option', { value: '150' }, '60%'), h('option', { value: '100' }, '40%'));
            opSel.addEventListener('change', async () => {
              if (!opSel.value) return;
              try { await invoke('winmgr:opacity', w.hwnd, +opSel.value); toast('透明度已调整', 'success', 1000); }
              catch (e) { toast(e.message, 'error'); }
            });
            row.appendChild(opSel);
            row.appendChild(btn('置底', 'btn-sm btn-text', async () => {
              try { await invoke('winmgr:bottom', w.hwnd); toast('已置底', 'success', 1000); }
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
    id: 'services-power', name: '服务与电源', module: MOD, icon: 'server',
    desc: '查看并启停 Windows 服务（启停需管理员权限），切换电源计划',
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
          allSvc = await invoke('svc:list');
          svcStatus.textContent = `${allSvc.length} 个服务`;
          renderSvc();
        } catch (e) { svcBox.innerHTML = ''; svcBox.appendChild(div('field-err', '✗ ' + e.message)); }
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
        try { await invoke('svc:action', s.Name, action); toast(`已${action === 'start' ? '启动' : '停止'}：${s.DisplayName || s.Name}`, 'success'); loadSvc(); }
        catch (e) { toast(e.message.includes('1060') || e.message.includes('访问') || /5$|拒绝/.test(e.message) ? '需要管理员权限：请以管理员身份运行核核工具箱' : e.message, 'error'); }
      }
      svcFilter.addEventListener('input', window.ui.debounce(renderSvc, 150));
      const powerBox = div('');
      async function loadPower() {
        powerBox.innerHTML = '';
        powerBox.appendChild(window.ui.loadingBlock('读取电源计划…'));
        try {
          const plans = await invoke('power:list');
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
              try { await invoke('power:set', p.guid); toast('已切换：' + p.name, 'success'); loadPower(); }
              catch (e) { toast(e.message, 'error'); }
            }));
            powerBox.appendChild(row);
          }
        } catch (e) { powerBox.innerHTML = ''; powerBox.appendChild(div('field-err', '✗ ' + e.message)); }
      }
      page.appendChild(div('card', div('card-title', 'Windows 服务'),
        div('form-row', btn('🔄 刷新', 'btn-sm btn-secondary', loadSvc), svcFilter, svcStatus),
        div('field-hint', '启动/停止服务需要管理员权限运行'), svcBox));
      page.appendChild(div('card', div('card-title', '电源计划'), powerBox));
      loadSvc(); loadPower();
    }
  });

  /* ---------- 定时任务 ---------- */
  register({
    id: 'scheduler', name: '定时任务', module: MOD, icon: 'timer',
    desc: '定时关机/重启/睡眠/锁屏/提醒，倒计时精确到秒，可取消',
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
      let timer = null, targetTs = 0, mode = '';
      window.App.onCleanup(() => { if (timer) clearInterval(timer); });
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
          try {
            await invoke('exec:run', { cmd: `shutdown /${m === 'shutdown' ? 's' : 'r'} /t ${mins * 60}`, shellType: 'cmd' });
          } catch (e) {
            /* 被高危门禁拦住时只弹一句 toast 是不够的 —— 用户根本不知道
             * 「系统电源操作」这个开关在哪，只会以为是坏了。
             * 这里直接给出可点的引导，一键跳到设置页对应分区。 */
            const msg = window.api.errText ? window.api.errText(e) : (e && e.message) || String(e);
            const denied = (e && e.code === 'CAP_DENIED') || /高危功能|已默认关闭/.test(msg);
            if (denied) {
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
          arm(confirmMsg, mins * 60, () => {});
          status.textContent = `系统将在 ${mins} 分钟后${confirmMsg}（shutdown 计划，可点击取消）`;
        } else {
          if (!(await confirmBox({ title: '定时' + confirmMsg, message: `${mins} 分钟后执行「${confirmMsg}」？`, okText: '确定' }))) return;
          arm(confirmMsg, mins * 60, async () => {
            const cmd = m === 'sleep' ? 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0' : 'rundll32.exe user32.dll,LockWorkStation';
            invoke('exec:run', { cmd, shellType: 'cmd' }).catch(() => {});
          });
          status.textContent = `将在 ${mins} 分钟后${confirmMsg}`;
        }
      }
      async function cancel() {
        if (timer) { clearInterval(timer); timer = null; }
        try { await invoke('exec:run', { cmd: 'shutdown /a', shellType: 'cmd' }); } catch (e) {} // 取消系统的关机计划（如有）
        countdown.textContent = '已取消'; countdown.className = 'tag tag-gray';
        status.textContent = '已取消定时任务（含系统关机计划）';
      }
      page.appendChild(div('card', div('card-title', '一次性定时'),
        div('form-row', h('span', { class: 'form-label' }, '动作'), modeSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '分钟'), minIn, msgIn),
        div('form-row', btn('⏲ 设置', 'btn-primary', apply), ' ', btn('取消', 'btn-danger-plain', cancel), countdown, status),
        div('field-hint', '关机/重启走系统 shutdown 计划（关机前弹窗可跳过）；睡眠/锁屏/提醒在应用内计时')));

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
        const list = await invoke('sched:list').catch(() => []);
        rList.innerHTML = '';
        if (!list.length) { rList.appendChild(div('empty-tip', '暂无周期任务')); return; }
        for (const s of list) {
          const desc = s.type === 'daily' ? `每天 ${s.hhmm} 提醒：${s.message}`
            : s.type === 'loop' ? `每 ${s.everyMin} 分钟提醒：${s.message || '（循环提醒）'}`
            : `每天 ${s.hhmm} 自动清理本应用临时文件`;
          rList.appendChild(div('form-row',
            h('span', { class: 'tag ' + (s.type === 'clean' ? 'tag-green' : 'tag-blue'), style: { width: '48px', justifyContent: 'center' } }, s.type === 'clean' ? '清理' : '提醒'),
            h('span', { style: { flex: '1', fontSize: '12px' } }, desc),
            btn('删除', 'btn-sm btn-text', async () => { await invoke('sched:remove', s.id); loadRecurring(); })));
        }
      }
      const rAddBtn = btn('＋ 添加周期任务', 'btn-primary', async () => {
        const t = rType.value;
        const s = { type: t };
        if (t === 'daily') { s.hhmm = rTime.value || '09:00'; s.message = rMsg.value.trim(); if (!s.message) return toast('请输入提醒内容', 'warn'); }
        else if (t === 'loop') { s.everyMin = Math.max(1, +rEvery.value || 60); s.message = rMsg.value.trim() || '循环提醒'; }
        else { s.hhmm = rTime.value || '03:00'; s.message = ''; }
        try { await invoke('sched:add', s); toast('已添加（重启应用后依然生效）', 'success'); rMsg.value = ''; loadRecurring(); }
        catch (e) { toast(e.message, 'error'); }
      });
      const refreshR = () => { rTime.style.display = rType.value === 'loop' ? 'none' : ''; rEvery.style.display = rType.value === 'loop' ? '' : 'none'; };
      rType.addEventListener('change', refreshR); refreshR();
      page.appendChild(div('card', div('card-title', '周期任务（持久化）'),
        div('form-row', h('span', { class: 'form-label' }, '类型'), rType,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '时间'), rTime,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '间隔'), rEvery, rMsg),
        div('form-row', rAddBtn),
        rList,
        div('field-hint', '周期任务由主进程调度并随配置持久化：到点弹系统通知；自动清理只删除本应用自己的临时文件（截图、录制分段、FFmpeg 下载包），不会动系统临时目录里的其他文件')));
      loadRecurring();
    }
  });
})();
