/* 模块：网络运维 —— 局域网设备扫描 */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, renderTable, copyText, progressEl, guard } = window.ui;
  const { invoke } = window.api;
  const MOD = 'net';

  register({
    id: 'lan-scan',
    name: '局域网设备', nameEn: 'LAN Scan',
    module: MOD,
    icon: 'wifi',
    desc: '扫描本机所在网段，列出网里有哪设备（IP / MAC / 主机名），可复制成表格', descEn: 'Find devices on the local network with their IP, MAC and vendor',
    keywords: ['局域网', 'LAN', '内网', '扫描', '设备', 'ARP', '网段', '谁在线', 'scan'],
    render(page) {
      const state = { result: null, ip: null };

      page.appendChild(div('card',
        div('card-title', '能看到什么'),
        div('field-hint',
          '列出与本机在同一网段（/24）的设备：IP、MAC 地址、能反查到的主机名，并标出哪台是你自己。'),
        div('field-hint', { style: { marginTop: '6px', color: 'var(--text-3)' } },
          '⚠ 结果可能不全：本工具用的是 TCP 80 端口探测（Node 没有原生 ICMP），' +
          '只对开着 80 端口的设备有效 —— 手机、打印机、以及防火墙后面的机器大多不回应，' +
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
      /* 扫描的 per-run 序号（见 doScanOnce 里的说明）。
       * 离开页面与复用回来各 +1，保证任何旧扫描的 token 都落后于当前值。 */
      let scanRunSeq = 0;

      /* 【手写守卫换成统一收口】
       * 这段原来是 `if (state.running) return; state.running = true;` +
       * 在 finally 里复位 —— 本项目已经因为「置位后某个早退忘了复位」
       * 出过 7 次按钮永久卡死。这里改用 ui.guard()：并发直接挡掉，
       * 按钮禁用/恢复也交给 before/after 成对执行，任何出口都不会漏。
       * doScanOnce 是函数声明（提升），所以 guard 那行能写在按钮前面。 */
      const doScan = guard(doScanOnce, {
        before: () => { scanBtn.disabled = true; },
        after: () => { scanBtn.disabled = false; },
      });

      async function doScanOnce() {
        /* 【per-run token】LAN.SCAN 是**阻塞式** handler（扫完才 resolve），
         * 中途没有 job id 可 kill。所以"离开页面就停扫"做不到硬取消，
         * 只能用序号让迟到的结果作废：
         *   · cleanup 递增序号 → 旧扫描返回时发现序号变了，不写 state、
         *     不渲染、不改状态行（页面已经不在了，也没人会看）；
         *   · 复用回来后新扫描领新序号，旧的那次绝不会覆盖它 ——
         *     注释里承诺的「同一时刻只会有一次扫描」由此成立。
         * 这比"尽力 kill"更诚实：主进程那边会扫完（约 10–30 秒），
         * 但界面上不会再出现"两次扫描结果互相覆盖"。 */
        const runToken = ++scanRunSeq;
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
         * 只按 kind === 'lan' 过滤；同一页面内 guard 保证不会并发，
         * 但离开页面后上一轮主进程扫描仍可能收尾发进度，所以再按
         * 本轮 token 过滤（见下方 myToken）。 */
        const myToken = 'lan' + runToken;
        if (unsub) { try { unsub(); } catch (e) {} }
        /* 【订阅句柄必须按「这一趟」保存，不能共用外层的 unsub】
         * 旧实现 run1 触发 run2 时，run2 会把 unsub 换成自己的监听；
         * run1 的 finally 却对着这个共享变量执行 unsub()/置 null，
         * 于是**把 run2 刚建立的进度订阅拆掉**，run2 在整个扫描期间
         * 收不到 job:progress，进度条停在 0。这里用局部 myUnsub，
         * 旧的一趟只清理自己那份。 */
        let myUnsub = null;
        myUnsub = window.api.on('job:progress', (d) => {
          if (!d || d.kind !== 'lan') return;
          /* 不属于本轮扫描的进度（旧页面/旧一趟收尾）直接丢。
           * 老版本主进程不带 token 时按原行为接收，避免升级瞬间没进度。 */
          if (d.token && d.token !== myToken) return;
          /* 【两个阶段分开描述，不要只看 done/total】
           * 扫描阶段 total=254，反查阶段 total≤30。若统一按「扫描中 x/y」显示，
           * 反查时会突然变成「扫描中 3/30」—— 用户以为扫描重头开始了。
           * phase 由主进程给（'scan' | 'resolve'）；老版本主进程不发这个字段，
           * 那时按 done/total 也照旧能显示，所以这里不做强制判断。 */
          if (d.phase === 'resolve') {
            const rp = d.total ? Math.round(d.done / d.total * 100) : 0;
            prog.set(rp);
            status.textContent = '正在反查主机名 ' + d.done + '/' + d.total + '…（已发现 ' + (d.found || 0) + ' 台响应）';
            return;
          }
          const pct = d.total ? Math.round(d.done / d.total * 100) : 0;
          prog.set(pct);
          status.textContent = '扫描中 ' + d.done + '/' + d.total + '，已发现 ' + (d.found || 0) + ' 台响应';
        });
        /* 外层仍记「当前那一份」，供离开页面时统一退订；旧的一趟在
         * finally 里只碰自己的 myUnsub，不会把这里指向的新监听清掉。 */
        unsub = myUnsub;

        try {
          /* 带上用户选定的网卡地址（没选就传空，由主进程按私有网段默认挑） */
          const r = await invoke(Channels.CHANNELS.LAN.SCAN, { ip: state.ip || '', token: myToken });
          /* 【过期就直接丢】这趟扫描期间用户可能离开了页面或又点了一次扫描。
           * 不判的话，旧结果会覆盖新扫描的中间状态（两者都写 state.result
           * 与 resultBox），界面在两次结果之间来回闪。 */
          if (runToken !== scanRunSeq) return;
          state.result = r;
          render();
          syncIfaceSel(r);
          status.textContent = '完成：发现 ' + r.devices.length + ' 台设备';
        } catch (e) {
          if (runToken !== scanRunSeq) return;   // 过期的失败不弹错
          status.textContent = '✗ ' + e.message;
          toast(e.message, 'error');
        } finally {
          /* 只退自己那一份；共享的 unsub 可能已经指向新一趟的监听。 */
          if (myUnsub) { try { myUnsub(); } catch (e) {} }
          if (unsub === myUnsub) unsub = null;
          /* 进度条同理：旧的一趟收尾时不能把新一趟正在用的进度条藏掉。 */
          if (runToken === scanRunSeq) prog.hide();
          /* 【按钮必须在这里恢复】doScan 走了 guard：这个 async 函数返回后
           * guard 才解锁，但按钮的 disabled 是 doScanOnce 自己置的，
           * 没人恢复就会一直灰着 —— 用户以为扫描没结束。
           * 只在这一趟仍有效时才恢复，避免旧扫描把新扫描的按钮解开。 */
          if (runToken === scanRunSeq) {
            try { scanBtn.disabled = false; } catch (e) {}
          }
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
        if (stats.pingOnly) chips.appendChild(h('span', { class: 'tag' }, '仅 80 端口: ' + stats.pingOnly));
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
              key: 'source', title: '发现方式', width: '110px',
              render: (row) => {
                /* 内部数据里这两个值仍叫 ping（历史字段名，改动会牵动合并逻辑与
                 * 单测），但界面上必须说清它其实是 TCP 80 端口探测 ——
                 * 写「Ping」会让用户以为漏扫是因为没回应 ICMP。
                 * self 是 v0.9.2 起新增的：本机始终列出（防火墙拦 ICMP 时
                 * ARP/ping 都可能不命中本机，用户会找不到"哪一行是我"）。 */
                const label = {
                  'arp': '仅 ARP',
                  'ping': '仅 80 端口',
                  'arp+ping': 'ARP + 80 端口',
                  'self': '本机',
                }[row.source] || row.source;
                const cls = row.source === 'arp' ? 'tag-orange'
                  : row.source === 'self' ? 'tag-blue' : 'tag-green';
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

      const scanBtn = btn('扫描局域网设备', 'btn-primary', doScan, 'wifi');

      page.appendChild(div('card',
        div('card-title', '扫描'),
        div('form-row', scanBtn),
        div('form-row', { style: { marginTop: '8px' } },
          h('span', { class: 'field-hint', style: { marginRight: '8px' } }, '扫描网卡：'), ifaceSel),
        status,
        prog.el));
      page.appendChild(resultBox);

      window.App.onCleanup(() => {
        /* 递增序号：在飞的扫描返回时作废（LAN.SCAN 阻塞且无 job id，
         * 无法硬取消 —— 见 doScanOnce 里的说明）。 */
        scanRunSeq++;
        if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
        /* 【界面必须完整复位，不只是隐藏进度条】
         * LAN.SCAN 是阻塞式、没有 job id，cleanup 杀不掉它。
         * 原来只 prog.hide()，于是用户返回时看到：
         *   · 状态行还写着「正在扫描本机所在网段…（约 10–30 秒）」；
         *   · 「开始扫描」按钮仍是灰的（doScanOnce 里置的 disabled 没人恢复）；
         *   · 进度条却已经不在了 —— 既没进度、也点不动、文案还说在扫描，
         *     用户唯一的判断就是"卡死了"。
         * 现在把文案、按钮、进度三样一起归位，并说清后台会怎样收尾。 */
        try {
          prog.hide();
          scanBtn.disabled = false;
          status.textContent = '已离开页面，上一轮扫描结果作废（后台会自行收尾）';
        } catch (e) {}
      });
      if (window.App.onEnter) {
        window.App.onEnter(() => {
          scanRunSeq++;
          /* 复用回来：把状态行与按钮恢复到"可以重新扫描"的一致状态。
           * 不自动重启扫描 —— 用户离开时那次已经被作废了。 */
          try {
            scanBtn.disabled = false;
            prog.hide();
            if (/正在扫描|扫描中|反查主机名/.test(status.textContent || '')) {
              status.textContent = '上一次扫描已中断，可重新开始';
            }
          } catch (e) {}
        });
      }
    },
  });
})();
