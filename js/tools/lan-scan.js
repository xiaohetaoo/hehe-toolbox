/* 模块：网络运维 —— 局域网设备扫描 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, renderTable, copyText, progressEl } = window.ui;
  const { invoke } = window.api;
  const MOD = 'net';

  register({
    id: 'lan-scan',
    name: '局域网设备',
    module: MOD,
    icon: 'wifi',
    desc: '扫描本机所在网段，列出网里有哪设备（IP / MAC / 主机名），可复制成表格',
    keywords: ['局域网', 'LAN', '内网', '扫描', '设备', 'ARP', '网段', '谁在线', 'scan'],
    render(page) {
      const state = { result: null, running: false, ip: null };

      page.appendChild(div('card',
        div('card-title', '能看到什么'),
        div('field-hint',
          '列出与本机在同一网段（/24）的设备：IP、MAC 地址、能反查到的主机名，并标出哪台是你自己。'),
        div('field-hint', { style: { marginTop: '6px', color: 'var(--text-3)' } },
          '⚠ 结果**可能不全**：Windows 防火墙默认挡 ICMP，很多手机/打印机也不回应，' +
          '它们只能靠 ARP 缓存被发现，所以刚从休眠回来的设备可能不在列表里。' +
          '只要设备在 ARP 表里就一定不会漏。')));

      const prog = progressEl(); prog.hide();
      const status = h('div', { class: 'field-hint' }, '');

      /* 【多网卡时用户必须能改】
       * 装了 VMware / Hyper-V / WSL 的机器上有多块网卡，默认选「第一个私有网段」
       * 仍可能选中虚拟网卡（它也是 192.168.x）。主进程会把全部候选地址回传，
       * 这里做成下拉让用户自己指定要扫哪块网卡的网段。
       * 选择变化时清掉上次结果 —— 留着旧结果会让人误以为是新网段的。 */
      const ifaceSel = h('select', { class: 'input input-sm', style: { maxWidth: '420px' } });
      ifaceSel.style.display = 'none';
      ifaceSel.addEventListener('change', () => {
        state.ip = ifaceSel.value || null;
        state.result = null;
        resultBox.innerHTML = '';
        status.textContent = '已切换到 ' + (ifaceSel.value || '（默认）') + '，点「开始扫描」重扫';
      });
      const resultBox = div('');

      let unsub = null;

      async function doScan() {
        if (state.running) return;
        state.running = true;
        scanBtn.disabled = true;
        prog.show(); prog.set(0);
        status.textContent = '正在扫描本机所在网段…（约 10–30 秒）';
        resultBox.innerHTML = '';

        /* 订阅进度：254 个地址分批扫，界面上要有推进感。
         * 【通道必须是 job:progress，不是 job:stream】
         * 主进程这条扫描是用 send('job:progress', { id, kind:'lan', done, total }) 推进度的，
         * 早期这里订阅 job:stream 并试图 JSON.parse(d.data) 过滤 /^lanscan/ ——
         * 两边对不上，于是进度条恒为 0、状态文字停在「正在扫描…」，扫描 10-30 秒
         * 期间界面完全静止，用户会以为卡死并反复点。
         * 统一到 job:progress（与本项目其它按 kind 过滤的工具一致），
         * 只按 kind === 'lan' 过滤，不额外匹配 id —— 同一时刻只会有一次扫描。 */
        if (unsub) { try { unsub(); } catch (e) {} }
        unsub = window.api.on('job:progress', (d) => {
          if (!d || d.kind !== 'lan') return;
          const pct = d.total ? Math.round(d.done / d.total * 100) : 0;
          prog.set(pct);
          status.textContent = '扫描中 ' + d.done + '/' + d.total + '，已发现 ' + (d.found || 0) + ' 台响应';
        });

        try {
          /* 带上用户选定的网卡地址（没选就传空，由主进程按私有网段默认挑） */
          const r = await invoke('lan:scan', state.ip ? { ip: state.ip } : {});
          state.result = r;
          render();
          syncIfaceSel(r);
          status.textContent = '完成：发现 ' + r.devices.length + ' 台设备';
        } catch (e) {
          status.textContent = '✗ ' + e.message;
          toast(e.message, 'error');
        } finally {
          if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
          prog.hide();
          scanBtn.disabled = false;
          state.running = false;
        }
      }

      /* 把主进程回传的全部候选地址填进下拉。只有一块网卡时不必显示 ——
       * 多出一个无意义的选择项反而让人以为要自己配对。
       * 至少两块才显示，且默认值与主进程实际用的那个对齐（r.selfIp）。 */
      function syncIfaceSel(r) {
        ifaceSel.innerHTML = '';
        const list = (r && r.ifaces) || [];
        if (list.length < 2) { ifaceSel.style.display = 'none'; return; }
        for (const x of list) {
          const o = h('option', { value: x.ip },
            x.ip + (x.adapter ? ' · ' + x.adapter : '') + (x.isPrivate ? '' : '（非内网段）'));
          ifaceSel.appendChild(o);
        }
        ifaceSel.value = r.selfIp || (list[0] && list[0].ip) || '';
        state.ip = ifaceSel.value || null;
        ifaceSel.style.display = '';
      }

      function render() {
        resultBox.innerHTML = '';
        const r = state.result;
        if (!r) return;
        /* ---- 概览 ---- */
        const head = div('card');
        head.appendChild(div('card-title',
          '本机 ' + r.selfIp + ' · 网段 ' + r.subnet.network + ' · 共扫描 ' + r.scanned + ' 个地址' +
          (r.adapter ? '（网卡 ' + r.adapter + '）' : '')));
        const stats = r.stats || {};
        const chips = div('form-row');
        chips.appendChild(h('span', { class: 'tag tag-green' }, '发现 ' + (stats.total || 0) + ' 台'));
        if (stats.arpOnly) chips.appendChild(h('span', { class: 'tag tag-orange' }, '仅 ARP: ' + stats.arpOnly));
        if (stats.pingOnly) chips.appendChild(h('span', { class: 'tag' }, '仅 ping: ' + stats.pingOnly));
        head.appendChild(chips);

        const acts = div('form-row', { style: { marginTop: '8px' } });
        acts.appendChild(btn('复制为表格', 'btn-sm btn-secondary', () => {
          const lines = ['IP\tMAC\t主机名\t说明'];
          for (const d of r.devices) {
            lines.push([d.ip, d.mac || '(未知)', d.name || '', d.isSelf ? '本机' : ''].join('\t'));
          }
          copyText(lines.join('\n'));
        }));
        acts.appendChild(btn('重新扫描', 'btn-sm btn-secondary', doScan));
        head.appendChild(acts);

        /* ---- 局限说明：必须说清楚，否则用户会以为网里只有这几台 ---- */
        if (r.caveats && r.caveats.length) {
          for (const c of r.caveats) {
            head.appendChild(div('field-hint', { style: { marginTop: '6px', color: 'var(--text-3)' } }, '· ' + c));
          }
        }
        resultBox.appendChild(head);

        /* ---- 设备表 ---- */
        if (!r.devices.length) {
          resultBox.appendChild(div('card', div('card-title', '没有发现设备'),
            div('field-hint', '这不太正常 —— 至少应该能看到网关。若确实连不上网，请检查网络连接与防火墙。')));
          return;
        }

        const card = div('card');
        card.appendChild(div('card-title', '设备列表'));
        card.appendChild(renderTable({
          columns: [
            {
              key: 'ip', title: 'IP 地址', width: '150px',
              render: (row) => {
                const wrap = h('span', { style: { fontFamily: 'monospace', fontSize: '12px' } });
                wrap.appendChild(h('span', null, row.ip));
                if (row.isSelf) wrap.appendChild(h('span', { class: 'tag tag-green', style: { marginLeft: '6px' } }, '本机'));
                return wrap;
              },
            },
            {
              key: 'mac', title: 'MAC 地址', width: '150px',
              render: (row) => h('span', {
                style: { fontFamily: 'monospace', fontSize: '12px' },
              }, row.mac || '（未知）'),
            },
            {
              key: 'name', title: '主机名',
              render: (row) => h('span', { style: { fontSize: '12px' } }, row.name || '—'),
            },
            {
              key: 'source', title: '发现方式', width: '100px',
              render: (row) => {
                const label = { 'arp': 'ARP', 'ping': 'Ping', 'arp+ping': 'ARP+Ping' }[row.source] || row.source;
                const cls = row.source === 'arp' ? 'tag-orange' : 'tag-green';
                return h('span', { class: 'tag ' + cls }, label);
              },
            },
          ],
          rows: r.devices,
          rowKey: (row) => row.ip,
          empty: '无设备',
        }));
        resultBox.appendChild(card);
      }

      const scanBtn = btn('📡 扫描局域网设备', 'btn-primary', doScan);

      page.appendChild(div('card',
        div('card-title', '扫描'),
        div('form-row', scanBtn),
        div('form-row', { style: { marginTop: '8px' } },
          h('span', { class: 'field-hint', style: { marginRight: '8px' } }, '扫描网卡：'), ifaceSel),
        status,
        prog.el));
      page.appendChild(resultBox);

      window.App.onCleanup(() => {
        if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
      });
    },
  });
})();
