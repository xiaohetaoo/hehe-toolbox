/* 模块：文本与编码 —— 乱码修复 / 编码识别 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, renderTable, filePicker } = window.ui;
  const { invoke } = window.api;
  const MOD = 'text';

  register({
    id: 'mojibake-fix',
    name: '乱码修复',
    module: MOD,
    icon: 'languages',
    desc: '粘贴乱码自动猜编码并给出可读结果，也能直接分析整个文件的真实编码',
    keywords: ['乱码', '编码', '锟斤拷', 'gbk', 'gb18030', 'big5', 'utf8', 'mojibake', 'charset'],
    render(page) {
      const state = { result: null, file: null };

      /* 【候选对象的两种形状，这里统一读法】
       * 文本模式：lib 直接产出 { from, to, text, score }（from/to 是编码名）。
       * 文件模式：主进程把 detectEncodings 的输出补成 { from:'原始字节', to:label, … }，
       *   但原始字段 encodings/label 也还在（外部有引用，不删）。
       * 早期渲染层只读 row.to，而文件模式当时透传的是 encodings/label ——
       * 于是显示「? → ?」，真正有用的编码名一个字都看不到。
       * 现在优先 to，退到 label / encodings，保证两种形状都能显示编码名。 */
      const labelOf = (c) => (c && (c.to || c.label || c.encodings)) || '?';
      const fromOf = (c) => (c && c.from) || '原始';

      page.appendChild(div('card',
        div('card-title', '为什么会出现乱码？'),
        div('field-hint',
          '同一段文字用 A 编码存、用 B 编码读，就会变成一堆认不出的字符。' +
          '中文环境下最常见的是这三类：'),
        div('field-hint', { style: { marginTop: '6px' } },
          '① 「锟斤拷」—— UTF-8 文本被按 GBK 读，再转回 UTF-8 时产生的替换字符链。' +
          '原始内容多半已经丢了，本工具只能恢复还能救回的部分。'),
        div('field-hint', { style: { marginTop: '4px' } },
          '② GBK / Big5 文本被当成 UTF-8 读 —— 表现为成片的问号、方块或怪字。' +
          '这类**通常能完整修复**，因为原始字节还在。'),
        div('field-hint', { style: { marginTop: '4px' } },
          '③ 「烫烫烫 / 屯屯屯」—— 那是程序 bug 留下的未初始化内存，不是编码问题，' +
          '没有任何办法还原。')));

      /* ---------------- 输入 ---------------- */
      const ta = h('textarea', {
        class: 'textarea mono',
        placeholder: '把乱码文本粘贴到这里…（也可以直接选一个文件，按真实字节分析，更准）',
        style: { width: '100%', height: '120px', resize: 'vertical' },
      });

      const picker = filePicker({
        text: '或者选择一个文件（按原始字节探测编码，比粘贴文本更准）',
        single: true,
        emptyText: '没有选择文件',
        onChange: (items) => { state.file = items.length ? items[0].path : null; },
      });

      const resultBox = div('');

      const analyzeBtn = btn('🔍 分析编码', 'btn-primary', async () => {
        const text = ta.value;
        const useFile = state.file && !text.trim();
        if (!useFile && !text.trim()) return toast('请粘贴乱码文本，或选择一个文件', 'warn');

        resultBox.innerHTML = '<div class="card"><div class="field-hint">分析中…</div></div>';
        try {
          const r = useFile
            ? await invoke('text:detect-encoding', state.file, { isFile: true })
            : await invoke('text:detect-encoding', text, {});
          state.result = r;
          render();
        } catch (e) {
          resultBox.innerHTML = '';
          resultBox.appendChild(div('card', div('card-title', '分析失败'),
            div('field-err', '✗ ' + e.message)));
        }
      });

      function render() {
        resultBox.innerHTML = '';
        const r = state.result;
        if (!r) return;

        /* ---- 锟斤拷提示：这类乱码要先把「为什么救不全」说清 ---- */
        if (r.kuen) {
          resultBox.appendChild(div('card',
            div('card-title', h('span', { class: 'tag tag-orange', style: { marginRight: '8px' } }, '锟斤拷')),
            div('field-hint', r.note || '')));
        }

        const cands = r.candidates || [];
        if (!cands.length) {
          resultBox.appendChild(div('card', div('card-title', '没有可用结果')));
          return;
        }

        /* ---- 最优结果：单独一块，大字号，可直接复制 ---- */
        const best = r.best || cands[0];
        const bestCard = div('card');
        bestCard.appendChild(div('card-title', '最可能的结果'));
        const conv = div('form-row', { style: { marginBottom: '6px' } });
        conv.appendChild(h('span', { class: 'tag tag-green' },
          fromOf(best) + ' → ' + labelOf(best)));
        bestCard.appendChild(conv);
        const bestBox = h('div', {
          class: 'mono',
          style: {
            padding: '10px', background: 'var(--fill-1)', borderRadius: '6px',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '220px',
            overflowY: 'auto', userSelect: 'text', fontSize: '13px',
          },
        }, best.text || '（空）');
        bestCard.appendChild(bestBox);
        const acts = div('form-row', { style: { marginTop: '8px' } });
        acts.appendChild(btn('复制结果', 'btn-sm btn-primary', () => copyText(best.text || '')));
        /* 「能不能无损转码」的判断：结果里若含替换字符，说明原始字节已丢，
         * 任何转码都救不回来 —— 提前告诉用户，比转完发现还是乱码好。
         * 【目标编码必须让用户选，不能写死 utf-8】
         * 早期这里恒传 'utf-8'，只要文本没有替换字符就必定回「可以转换」，
         * 这个按钮没有判断任何用户真正关心的事（我能不能存成 GBK）。
         * 现在给一个目标编码下拉：GBK / GB18030 / Big5 / UTF-8，
         * 结论由 text:can-reencode 按真实情况给（Node 没有 GBK 编码器，
         * 那类目标会如实回「需要借助系统工具完成」，而不是笼统的「可以」）。 */
        if (best.text && best.text.length > 0) {
          const encSel = h('select', { class: 'input input-sm', style: { width: '110px' } });
          for (const [v, t] of [['gbk', 'GBK'], ['gb18030', 'GB18030'], ['big5', 'Big5'], ['utf-8', 'UTF-8']]) {
            const o = h('option', { value: v }, t);
            encSel.appendChild(o);
          }
          /* 默认选「不是源编码」的那一个：用户点这个按钮通常是想换个编码存盘。
           * 源若是 UTF-8 就默认 GBK，反之默认 UTF-8。 */
          encSel.value = /utf-8/i.test(labelOf(best)) ? 'gbk' : 'utf-8';
          acts.appendChild(encSel);
          acts.appendChild(btn('检查能否无损转码', 'btn-sm btn-secondary', async () => {
            try {
              const info = await invoke('text:can-reencode', best.text, encSel.value);
              toast(info.note, info.lossy ? 'warn' : 'info', 3000);
            } catch (e) { toast(e.message, 'error'); }
          }));
        }
        acts.appendChild(btn('用这个结果重新分析', 'btn-sm btn-secondary', () => {
          ta.value = best.text || '';
          analyzeBtn.click();
        }));
        bestCard.appendChild(acts);
        resultBox.appendChild(bestCard);

        /* ---- 全部候选：让用户自己判断（有时最优解并非用户想要的那个） ---- */
        const others = cands.slice(0, 8);
        const listCard = div('card');
        listCard.appendChild(div('card-title', '所有候选（按合理性排序）'));
        listCard.appendChild(renderTable({
          columns: [
            {
              key: 'conv', title: '转换', width: '150px',
              render: (row) => h('span', { class: 'mono', style: { fontSize: '11px' } },
                fromOf(row) + ' → ' + labelOf(row)),
            },
            { key: 'score', title: '合理度', width: '80px', render: (row) => h('span', null, (row.score || 0).toFixed(0)) },
            {
              key: 'text', title: '解码结果（节选）',
              render: (row) => h('span', { style: { fontSize: '11px', wordBreak: 'break-all' }, title: row.text || '' },
                String(row.text || '').slice(0, 80) + (String(row.text || '').length > 80 ? '…' : '')),
            },
          ],
          rows: others,
          rowKey: (row) => fromOf(row) + labelOf(row),
          empty: '无候选',
          onRowClick: (row) => { ta.value = row.text || ''; toast('已填入输入框，可以重新分析或复制', 'info', 1600); },
        }));
        listCard.appendChild(div('field-hint', { style: { padding: '6px 4px' } },
          '「合理度」是综合评分：替换字符和控制字符越多分越低，汉字占比越高分越高。' +
          '点任意一行可以把它的结果填回输入框，方便再试一次。'));
        resultBox.appendChild(listCard);
      }

      page.appendChild(div('card',
        div('card-title', '输入'),
        ta,
        div('form-row', { style: { marginTop: '8px' } }, analyzeBtn,
          ' ', btn('清空', 'btn-sm btn-secondary', () => {
            ta.value = ''; state.result = null; resultBox.innerHTML = '';
          }))));

      page.appendChild(div('card', div('card-title', '或从文件分析'), picker.el));
      page.appendChild(resultBox);
    },
  });
})();
