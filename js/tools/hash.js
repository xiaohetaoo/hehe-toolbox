/* 模块：文件处理 —— 文件哈希校验 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, dropzone, fmtBytes, renderTable } = window.ui;
  const { on } = window.api;

  register({
    id: 'hash-tool', name: '哈希校验', module: 'file', icon: 'hash',
    desc: 'MD5 / SHA1 / SHA256 / SHA512，支持文件拖拽与文本计算',
    keywords: ['hash', 'md5', 'sha256', '校验', '哈希'],
    render(page) {
      let tab = 'file';
      const tabFile = btn('文件校验', 'btn-sm btn-primary', () => switchTab('file'));
      const tabText = btn('文本校验', 'btn-sm btn-secondary', () => switchTab('file' === tab ? 'text' : 'file'));
      function switchTab(t) {
        tab = t;
        fileCard.style.display = t === 'file' ? '' : 'none';
        textCard.style.display = t === 'text' ? '' : 'none';
        tabFile.className = 'btn btn-sm ' + (t === 'file' ? 'btn-primary' : 'btn-secondary');
        tabText.className = 'btn btn-sm ' + (t === 'text' ? 'btn-primary' : 'btn-secondary');
      }

      /* 文件模式 */
      let currentFile = null;
      const fileInfo = div('field-hint', '');
      const dz = dropzone({
        text: '拖入文件进行校验，或点击选择',
        multiple: true,
        onFiles: async (paths) => {
          for (const p of paths) await hashFile(p);
        }
      });
      const resultTable = div('');
      async function hashFile(p) {
        const name = p.split(/[\\/]/).pop();
        let size = 0;
        try { size = (await window.api.invoke('fs:stat', p)).size; } catch (e) {}
        const row = div('');
        row.style.margin = '10px 0';
        row.appendChild(div('', h('span', { style: { fontWeight: 500 } }, name), h('span', { class: 'field-hint', style: { marginLeft: '8px' } }, fmtBytes(size))));
        const progress = div('progress', div('progress-fill'));
        progress.style.margin = '6px 0';
        row.appendChild(progress);
        resultTable.prepend(row);
        const unsub = on('job:progress', (d) => {
          if (d.kind === 'hash' && d.id === p) progress.firstChild.style.width = (d.done / d.total * 100) + '%';
        });
        const algos = ['md5', 'sha1', 'sha256', 'sha512'];
        for (const algo of algos) {
          try {
            const r = await window.api.invoke('fs:hash-file', p, algo);
            const line = div('form-row', h('span', { class: 'form-label', style: { minWidth: '70px', textTransform: 'uppercase' } }, algo),
              h('span', { class: 'mono', style: { flex: '1', userSelect: 'text', wordBreak: 'break-all', fontSize: '12px' } }, r.hex),
              btn('复制', 'btn-sm btn-text', () => copyText(r.hex)));
            row.appendChild(line);
          } catch (e) { row.appendChild(div('field-err', algo + ' 失败: ' + e.message)); }
        }
        progress.remove();
        unsub();
      }
      const fileCard = div('card', div('card-title', '文件校验'), dz, fileInfo, resultTable);

      /* 文本模式 */
      const ta = h('textarea', { class: 'pane-ta', placeholder: '输入文本…', style: { minHeight: '100px' } });
      const textOut = div('');
      async function hashText() {
        textOut.innerHTML = '';
        if (!ta.value) return;
        // 一次 IPC 拿回多个算法，避免 3 次往返
        let res;
        try { res = await window.api.invoke('fs:hash-text-multi', ta.value, ['md5', 'sha1', 'sha256']); }
        catch (e) { return; } // browser mode
        for (const algo of ['md5', 'sha1', 'sha256']) {
          const hex = res && res[algo];
          if (!hex) continue;
          textOut.appendChild(div('form-row', h('span', { class: 'form-label', style: { minWidth: '70px', textTransform: 'uppercase' } }, algo),
            h('span', { class: 'mono', style: { flex: '1', userSelect: 'text', wordBreak: 'break-all', fontSize: '12px' } }, hex),
            btn('复制', 'btn-sm btn-text', () => copyText(hex))));
        }
      }
      const textCard = div('card', div('card-title', '文本校验'), ta, textOut);
      textCard.style.display = 'none';
      ta.addEventListener('input', window.ui.debounce(hashText, 400));

      page.appendChild(div('card', div('card-title', '模式', tabFile, ' ', tabText)));
      page.appendChild(fileCard);
      page.appendChild(textCard);
    }
  });
})();
