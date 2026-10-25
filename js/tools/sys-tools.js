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
            ['已用', fmtBytes(info.memTotal - info.memFree) + `（${((1 - info.memFree / info.memTotal) * 100).toFixed(0)}%）`]
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
        const unsub = on('job:progress', (d) => { status.textContent = `已扫描 ${fmtNum(d.files)} 个文件，${fmtBytes(d.size)}`; });
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
})();
