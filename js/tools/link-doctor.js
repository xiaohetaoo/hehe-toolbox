/* 模块：文件处理 —— 链接体检（目录联接 / 符号链接） */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, confirmBox, renderTable } = window.ui;
  const { invoke } = window.api;
  const MOD = 'file';

  /* 四类结论的展示顺序与配色。和后端的 LINK_KINDS 对应。 */
  const KIND_META = {
    dead: { title: '僵尸链接', cls: 'tag-red', hint: '目标已不存在，可以清理', cleanable: true },
    loop: { title: '循环 / 自指', cls: 'tag-red', hint: '链接指向自身或形成环，需人工检查', cleanable: false },
    system: { title: '指向系统目录', cls: 'tag-orange', hint: '目标在系统关键目录内，不建议改动', cleanable: false },
    crossvol: { title: '目标盘暂不可用', cls: 'tag-orange', hint: '目标在别的盘，该盘当前未接入或被卸载 —— 无法判断是否还有效，不可清理', cleanable: false },
    ok: { title: '正常', cls: 'tag-green', hint: '目标存在且可访问', cleanable: false },
  };
  const ORDER = ['dead', 'loop', 'system', 'crossvol', 'ok'];

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
          '会扫描该目录及所有子目录里的**链接**（目录联接 junction 与符号链接 symlink），' +
          '逐个判断目标是否还在。这个操作只读，不会修改任何东西。'),
        div('field-hint', { style: { marginTop: '6px' } },
          '清理只针对「僵尸链接」（目标已不存在）。循环、指向系统目录、跨卷不可用的' +
          '只做提示 —— 删错这些的后果比留着严重得多。')));

      const dirInput = h('input', {
        class: 'input', placeholder: '目录路径，例如 D:\\Projects',
        style: { flex: '1' },
      });
      const scanBtn = btn('🔍 开始体检', 'btn-primary', doScan);
      const browseBtn = btn('浏览…', 'btn-sm btn-secondary', async () => {
        try {
          const r = await invoke('dialog:open', { properties: ['openDirectory'] });
          if (r && r[0]) { dirInput.value = r[0]; doScan(); }
        } catch (e) { toast(e.message, 'error'); }
      });

      const resultBox = div('');

      async function doScan() {
        const root = dirInput.value.trim();
        if (!root) return toast('请先填写或选择目录', 'warn');
        resultBox.innerHTML = '<div class="card"><div class="field-hint">扫描中…</div></div>';
        try {
          const r = await invoke('link:scan', root);
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
              const res = await invoke('link:remove', deads.map((x) => x.path));
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
