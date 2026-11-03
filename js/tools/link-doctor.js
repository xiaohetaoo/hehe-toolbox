/* 模块：文件处理 —— 链接体检（目录联接 / 符号链接） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量表（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, confirmBox, renderTable, guard } = window.ui;
  const { invoke } = window.api;
  const MOD = 'file';

  /* 五类结论的展示顺序与配色。和后端的 LINK_KINDS 对应。
   * 【新增一类时必须三处同步】后端 LINK_KINDS、main.js 的 groups、
   * 这里的 KIND_META/ORDER。漏在这里的话 counts[k] 有值而 meta 是
   * undefined —— 渲染时直接读 meta.cls 会抛异常，整页白掉。 */
  const KIND_META = {
    dead: { title: '僵尸链接', cls: 'tag-red', hint: '目标已不存在，可以清理', cleanable: true },
    loop: { title: '循环 / 自指', cls: 'tag-red', hint: '链接指向自身或形成环，需人工检查', cleanable: false },
    system: { title: '指向系统目录', cls: 'tag-orange', hint: '目标在系统关键目录内，不建议改动', cleanable: false },
    crossvol: { title: '目标盘暂不可用', cls: 'tag-orange', hint: '目标在别的盘，该盘当前未接入或被卸载 —— 无法判断是否还有效，不可清理', cleanable: false },
    /* 权限拒绝时「读不到」，不等于「没有了」。这类绝不能被当成僵尸清理。 */
    opaque: { title: '无法判断', cls: 'tag-orange', hint: '系统拒绝访问（权限不足），无法判断目标是否还在 —— 不可清理', cleanable: false },
    ok: { title: '正常', cls: 'tag-green', hint: '目标存在且可访问', cleanable: false },
  };
  const ORDER = ['dead', 'loop', 'system', 'crossvol', 'opaque', 'ok'];

  register({
    id: 'link-doctor',
    name: '链接体检',
    module: MOD,
    icon: 'link',
    desc: '扫描目录里的目录联接与符号链接，找出失效的、指向系统目录的、成环的',
    keywords: ['链接', '联接', 'junction', 'symlink', '软链接', '失效', '僵尸', 'link'],
    render(page) {
      const state = { root: '', result: null };

      page.appendChild(div('card',
        div('card-title', '选择要体检的目录'),
        div('field-hint',
          '会扫描该目录及所有子目录里的链接（目录联接 junction 与符号链接 symlink），' +
          '逐个判断目标是否还在。这个操作只读，不会修改任何东西。'),
        div('field-hint', { style: { marginTop: '6px' } },
          '清理只针对「僵尸链接」（目标已不存在）。循环、指向系统目录、跨卷不可用的' +
          '只做提示 —— 删错这些的后果比留着严重得多。')));

      const dirInput = h('input', {
        class: 'input', placeholder: '目录路径，例如 D:\\Projects',
        style: { flex: '1' },
      });
      const doScan = guard(doScanOnce);
      const scanBtn = btn('开始体检', 'btn-primary', doScan, 'search');
      const browseBtn = btn('浏览…', 'btn-sm btn-secondary', async () => {
        try {
          const r = await invoke('dialog:open', { properties: ['openDirectory'] });
          if (r && r[0]) { dirInput.value = r[0]; doScan(); }
        } catch (e) { toast(e.message, 'error'); }
      });

      const resultBox = div('');

      /* 【体检的防重入收口】
       * link:scan 是整个项目里最重的只读操作（递归全树 + 一次批量 PowerShell）。
       * 用户双击「开始体检」会同时发起两次全树扫描，磁盘被反复读、
       * 两次结果又互相覆盖。这里统一用 ui.guard()：并发直接挡掉，
       * 任何 return/throw 都复位（路径没填时的早退也不例外）。
       * 包装体用函数声明（doScanOnce 会被提升），所以 guard 那行能写在按钮前面。 */
      async function doScanOnce() {
        const root = dirInput.value.trim();
        if (!root) return toast('请先填写或选择目录', 'warn');
        resultBox.innerHTML = '<div class="card"><div class="field-hint">扫描中…</div></div>';
        try {
          const r = await invoke(Channels.CHANNELS.ACL_LINKS.LINK_SCAN, root);
          state.root = root;
          state.result = r;
          render();
        } catch (e) {
          resultBox.innerHTML = '';
          resultBox.appendChild(div('card', div('card-title', '扫描失败'),
            div('field-err', '✗ ' + e.message)));
        }
      }

      function render() {
        resultBox.innerHTML = '';
        const r = state.result;
        if (!r) return;

        /* ---- 概览 ---- */
        const overview = div('card');
        overview.appendChild(div('card-title',
          '扫了 ' + r.scanned + ' 个条目，找到 ' + r.total + ' 个链接'));
        const counts = r.counts || {};
        const chips = div('form-row');
        for (const k of ORDER) {
          const n = counts[k] || 0;
          if (!n) continue;
          const meta = KIND_META[k];
          const chip = div('', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } });
          chip.appendChild(h('span', { class: 'tag ' + meta.cls }, meta.title));
          chip.appendChild(h('span', { class: 'field-hint' }, String(n) + ' 个'));
          chips.appendChild(chip);
        }
        if (!r.total) {
          overview.appendChild(div('field-hint', '这个目录里没有找到任何链接。'));
        } else {
          overview.appendChild(chips);
        }
        if (r.truncated) {
          overview.appendChild(div('field-hint', { style: { marginTop: '6px' } },
            '⚠ 条目数超过上限，结果可能不完整。建议缩小扫描范围。'));
        }
        /* 【类型查不出来时要说】
         * 链接类型（junction / symlink）是展示字段，批量查询失败不影响判定结果，
         * 但『类型那列是空的』必须说清原因 —— 否则用户会以为这些链接没有类型。
         * 以前这条查询失败是全静默的（外层一个空 catch）。 */
        if (r.typeQueryError) {
          overview.appendChild(div('field-hint', { style: { marginTop: '6px', color: 'var(--warning)' } },
            '⚠ 链接类型查询失败：' + r.typeQueryError + '（判定结果不受影响，只是「类型」那列会是空的）'));
        }

        /* ---- 僵尸链接批量清理 ---- */
        const deads = (r.groups && r.groups.dead) || [];
        if (deads.length) {
          const bar = div('form-row', { style: { marginTop: '8px' } });
          bar.appendChild(btn('清理 ' + deads.length + ' 个僵尸链接', 'btn-sm btn-danger-plain', async () => {
            const ok = await confirmBox({
              title: '清理僵尸链接',
              message: '将删除 ' + deads.length + ' 个链接（目标已不存在）。\n\n' +
                '只会删除链接本身，不会进入或触碰任何目标数据。',
              danger: true, okText: '清理',
            });
            if (!ok) return;
            try {
              const res = await invoke(Channels.CHANNELS.ACL_LINKS.LINK_REMOVE, deads.map((x) => x.path));
              toast(res.advice || '已清理', 'success');
              doScan();
            } catch (e) { toast(e.message, 'error'); }
          }));
          overview.appendChild(bar);
        }
        resultBox.appendChild(overview);

        /* ---- 分组明细 ---- */
        for (const k of ORDER) {
          const items = (r.groups && r.groups[k]) || [];
          if (!items.length) continue;
          const meta = KIND_META[k];
          const card = div('card');
          card.appendChild(div('card-title',
            h('span', { class: 'tag ' + meta.cls, style: { marginRight: '8px' } }, meta.title),
            h('span', { class: 'field-hint' }, meta.hint)));

          /* 正常类项目太多时不铺满整页：只列前 20 个 */
          const shown = k === 'ok' ? items.slice(0, 20) : items;
          card.appendChild(renderTable({
            columns: [
              {
                key: 'path', title: '链接位置',
                render: (row) => h('span', {
                  style: { fontSize: '11px', wordBreak: 'break-all', userSelect: 'text' },
                  title: row.path,
                }, row.path),
              },
              {
                key: 'target', title: '指向目标',
                render: (row) => h('span', {
                  style: { fontSize: '11px', wordBreak: 'break-all', userSelect: 'text', color: row.kind === 'dead' ? 'var(--text-3)' : '' },
                  title: row.target || '',
                }, row.target || '（未知）'),
              },
              /* 【类型列】
               * 主进程一直在算 linkType（junction / SymbolicLink），但界面从来没有
               * 显示过它 —— 于是那条「类型那列会是空的」的提示就成了空话，
               * 而且用户没法从界面上区分自己遇到的是目录联接还是符号链接
               * （两者在跨机器拷贝、权限要求上完全不同）。
               * 查不到时显示「未知」，不猜。 */
              {
                key: 'linkType', title: '类型', width: '110px',
                render: (row) => h('span', { class: 'field-hint', style: { fontSize: '11px' } },
                  row.linkType || '未知'),
              },
              {
                key: 'reason', title: '判定',
                render: (row) => h('span', { style: { fontSize: '11px' } }, row.reason || ''),
              },
            ],
            rows: shown,
            rowKey: (row) => row.path,
            empty: '无',
          }));
          if (k === 'ok' && items.length > 20) {
            card.appendChild(div('field-hint', { style: { padding: '6px 4px' } },
              '仅显示前 20 项（共 ' + items.length + ' 项正常链接）'));
          }
          resultBox.appendChild(card);
        }
      }

      page.appendChild(div('card',
        div('card-title', '扫描范围'),
        div('form-row', dirInput, ' ', browseBtn, ' ', scanBtn)));
      page.appendChild(resultBox);
    },
  });
})();
