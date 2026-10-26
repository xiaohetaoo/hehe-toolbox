/* 模块：快捷启动 —— 快捷启动栏 / 命令收藏 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, confirmBox, promptBox, renderTable, fmtDate } = window.ui;
  const { invoke, isDesktop } = window.api;
  const MOD = 'launch';

  register({
    id: 'quick-launch', name: '快捷启动栏', module: MOD, icon: 'zap',
    desc: '自定义添加软件、文件夹、网址，一键打开',
    keywords: ['启动', '快捷方式', '软件', '网址'],
    render(page) {
      const list = div('');
      async function load() {
        const items = await invoke('store:get', 'quicklaunch', []);
        list.innerHTML = '';
        if (!items.length) { list.appendChild(div('empty-tip', '还没有快捷项，点「＋ 添加」创建一个')); return; }
        const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '12px' } });
        for (const [i, it] of items.entries()) {
          const card = div('tool-card');
          card.style.flexDirection = 'column';
          card.style.alignItems = 'center';
          card.style.textAlign = 'center';
          card.appendChild(div('tc-icon', iconFor(it.type)));
          card.appendChild(div('tc-name', it.name));
          card.appendChild(div('tc-desc', it.target.length > 40 ? it.target.slice(0, 40) + '…' : it.target));
          const ops = div('', { style: { display: 'flex', gap: '4px', marginTop: '8px' } });
          ops.appendChild(btn('打开', 'btn-sm btn-primary', () => open(it)));
          ops.appendChild(btn('删除', 'btn-sm btn-text', async () => {
            if (!(await confirmBox({ title: '删除快捷项', message: `删除「${it.name}」？` }))) return;
            const cur = await invoke('store:get', 'quicklaunch', []);
            // 旧数据没有 id 字段，只能按 name+target+type 定位；
            // 直接 findIndex(x => x.id === it.id) 会在 undefined === undefined 时命中第一条，导致删错项。
            const idx = cur.findIndex(x => it.id
              ? x.id === it.id
              : (x.name === it.name && x.target === it.target && x.type === it.type));
            if (idx < 0) { load(); return; } // 索引可能因并发删除过期，避免误删
            cur.splice(idx, 1);
            await invoke('store:set', 'quicklaunch', cur);
            load();
          }));
          card.appendChild(ops);
          grid.appendChild(card);
        }
        list.appendChild(grid);
      }
      function iconFor(type) {
        const t = document.createElement('span');
        t.innerHTML = window.iconSvgLg(type === 'url' ? 'globe' : type === 'dir' ? 'folder' : 'zap');
        return t.firstChild;
      }
      async function open(it) {
        try {
          if (it.type === 'url') await invoke('shell:open-url', it.target);
          else await invoke('fs:open-path', it.target);
          toast('已打开：' + it.name, 'success', 1200);
        } catch (e) { toast(e.message, 'error'); }
      }
      async function add() {
        const type = await new Promise((resolve) => {
          const b1 = btn('软件 / 文件', 'btn-secondary', () => { md.close(); resolve('app'); });
          const b2 = btn('文件夹', 'btn-secondary', () => { md.close(); resolve('dir'); });
          const b3 = btn('网址', 'btn-secondary', () => { md.close(); resolve('url'); });
          const md = window.ui.modal({
            title: '添加快捷项 - 选择类型',
            body: (b) => { b.appendChild(div('form-row', b1, b2, b3)); },
            foot: []
          });
        });
        let target = '';
        if (type === 'url') {
          target = await promptBox({ title: '添加网址', label: '网址：', placeholder: 'https://' });
          target = String(target || '').trim();
          // 提前校验协议，避免存进去之后点击「打开」才报错
          if (target && !/^https?:\/\//i.test(target)) { toast('网址需以 http:// 或 https:// 开头', 'error'); return; }
        } else {
          const p = await invoke('dialog:open', { properties: type === 'dir' ? ['openDirectory'] : ['openFile'] });
          target = p && p[0];
        }
        if (!target) return;
        const name = await promptBox({ title: '命名', label: '显示名称：', value: String(target).split(/[\\/]/).pop().replace(/\.\w+$/, '') || '快捷项' });
        if (!name) return;
        const items = await invoke('store:get', 'quicklaunch', []);
        items.push({ id: 'ql' + Date.now(), name, target, type });
        await invoke('store:set', 'quicklaunch', items);
        toast('已添加', 'success');
        load();
      }
      page.appendChild(div('card', div('card-title', '我的快捷启动', btn('➕ 添加', 'btn-primary', add, 'plus'))));
      page.appendChild(div('card', list));
      load();
    }
  });

  register({
    id: 'command-collection', name: '命令收藏', module: MOD, icon: 'terminal',
    desc: '保存常用 CMD / PowerShell 命令，一键执行并查看输出',
    keywords: ['命令', 'cmd', 'powershell', 'shell'],
    render(page) {
      const list = div('');
      const out = div('term', '执行输出将显示在这里');
      out.style.maxHeight = '300px';
      let current = null, unsubStream, unsubExit;
      window.App.onCleanup(() => {
        if (unsubStream) try { unsubStream(); } catch (e) {}
        if (unsubExit) try { unsubExit(); } catch (e) {}
        if (current) invoke('job:kill', current).catch(() => {});
      });
      async function load() {
        const items = await invoke('store:get', 'commands', []);
        list.innerHTML = '';
        if (!items.length) { list.appendChild(div('empty-tip', '还没有收藏命令')); return; }
        const table = renderTable({
          columns: [
            { key: 'name', title: '名称', render: r => div(null, { style: { fontWeight: 500 } }, r.name) },
            { key: 'cmd', title: '命令', render: r => div('mono', { style: { fontSize: '12px' } }, r.cmd) },
            { key: 'type', title: '类型', width: '100px', render: r => h('span', { class: 'tag ' + (r.shell === 'ps' ? 'tag-blue' : 'tag-gray') }, r.shell === 'ps' ? 'PowerShell' : 'CMD') },
            { key: 'act', title: '操作', width: '220px', render: (r, td) => {
                td.appendChild(btn('▶ 执行', 'btn-sm btn-primary', () => run(r)));
                td.appendChild(btn('删除', 'btn-sm btn-text', async () => {
                  const items = await invoke('store:get', 'commands', []);
                  const idx = items.findIndex(x => x.id === r.id);
                  // findIndex 未命中时返回 -1，splice(-1,1) 会误删最后一条，必须先挡住
                  if (idx < 0) { load(); return; }
                  items.splice(idx, 1);
                  await invoke('store:set', 'commands', items);
                  load();
                }));
              } }
          ],
          rows: items
        });
        list.appendChild(table);
      }
      async function run(r) {
        if (!isDesktop) return toast('桌面端可用', 'warn');
        out.innerHTML = `<div class="t-dim">$ ${escapeHtml(r.cmd)}</div>`;
        try {
          const job = await invoke('exec:stream', { command: r.shell === 'ps' ? 'powershell.exe' : 'cmd.exe', args: r.shell === 'ps' ? ['-NoProfile', '-Command', r.cmd] : ['/c', r.cmd] });
          current = job;
          if (unsubStream) unsubStream();
          if (unsubExit) unsubExit();
          unsubStream = window.api.on('job:stream', (d) => {
            if (d.id !== job) return;
            const el = h('div', { class: d.err ? 't-err' : '' }, String(d.data).trimEnd());
            out.appendChild(el);
            out.scrollTop = out.scrollHeight;
          });
          unsubExit = window.api.on('job:exit', (d) => {
            if (d.id === job) out.appendChild(h('div', { class: 't-dim' }, `—— 退出码 ${d.code} ——`));
          });
        } catch (e) { toast(e.message, 'error'); }
      }
      async function add() {
        const name = await promptBox({ title: '添加命令', label: '名称：', placeholder: '如：查看IP' });
        if (!name) return;
        const cmd = await promptBox({ title: '添加命令', label: '命令内容：', placeholder: 'ipconfig /all' });
        if (!cmd) return;
        const shell = await new Promise((resolve) => {
          const b1 = btn('CMD', 'btn-secondary', () => { md.close(); resolve('cmd'); });
          const b2 = btn('PowerShell', 'btn-secondary', () => { md.close(); resolve('ps'); });
          const md = window.ui.modal({ title: '选择执行环境', body: (b) => b.appendChild(div('form-row', b1, b2)), foot: [] });
        });
        const items = await invoke('store:get', 'commands', []);
        items.push({ id: 'cmd' + Date.now(), name, cmd, shell });
        await invoke('store:set', 'commands', items);
        toast('已收藏', 'success');
        load();
      }
      page.appendChild(div('card', div('card-title', '我的命令', btn('➕ 收藏命令', 'btn-primary', add, 'plus'))));
      page.appendChild(div('card', list));
      page.appendChild(div('card', div('card-title', '输出'), out));
      load();
    }
  });
})();
