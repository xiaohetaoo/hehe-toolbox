/* 模块：文件处理 —— 文件哈希校验 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, filePicker, fmtBytes, renderTable } = window.ui;
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
      /* 一个文件一行，摘要算完直接填进该行下方，不再另建结果区。
       * 加入列表即自动计算；已算过的路径不重复算（删掉再拖回来会重算，符合直觉）。 */
      const hashed = new Set();
      const picker = filePicker({
        text: '拖入文件进行校验，或点击选择',
        emptyText: '还没有添加文件',
        onChange: (items) => {
          const present = new Set(items.map((x) => x.path));
          // 移出列表的路径从「已算过」集合里摘掉，重新加入时才会重算
          for (const k of [...hashed]) if (!present.has(k)) hashed.delete(k);
          for (const it of items) {
            if (hashed.has(it.path)) continue;
            hashed.add(it.path);
            hashFile(it.path);
          }
        }
      });
      async function hashFile(p) {
        const idx = picker.paths.indexOf(p);
        const row = idx >= 0 ? picker.list.rowAt(idx) : null;
        if (!row) return; // 还没算完就被移出列表
        // 每行只保留一份摘要块：重复计算同一文件时先清掉旧的
        const old = row.querySelector('.hash-result');
        if (old) old.remove();
        const box = h('div', { class: 'hash-result', style: { flexBasis: '100%', marginTop: '2px' } });
        const progress = div('progress', div('progress-fill'));
        progress.style.margin = '6px 0';
        box.appendChild(progress);
        const unsub = on('job:progress', (d) => {
          if (d.kind === 'hash' && d.id === p && progress.firstChild) progress.firstChild.style.width = (d.done / d.total * 100) + '%';
        });
        const algos = ['md5', 'sha1', 'sha256', 'sha512'];
        /* 【一次读盘】原来对同一个文件连续调用 4 次 fs:hash-file，
         * 每次主进程都要完整读一遍盘 —— 校验 1GB 文件要读 4GB。
         * 改用 fs:hash-file-multi 一次流式读取同时算 4 个摘要，IO 降到 1/4。 */
        try {
          const r = await window.api.invoke('fs:hash-file-multi', p, algos);
          for (const algo of algos) {
            const hex = r.hex[algo];
            const line = div('form-row', h('span', { class: 'form-label', style: { minWidth: '70px', textTransform: 'uppercase' } }, algo),
              h('span', { class: 'mono', style: { flex: '1', userSelect: 'text', wordBreak: 'break-all', fontSize: '12px' } }, hex),
              btn('复制', 'btn-sm btn-text', () => copyText(hex)));
            box.appendChild(line);
          }
        } catch (e) {
          box.appendChild(div('field-err', '计算失败: ' + ((e && e.message) || String(e))));
        }
        progress.remove();
        // 摘要块追加到该文件行尾（列表行是 flex，用 flexBasis 让它独占下一行）
        row.appendChild(box);
        unsub();
      }
      const fileCard = div('card', div('card-title', '文件校验'), picker.el);

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
