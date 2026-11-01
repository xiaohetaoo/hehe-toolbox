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
       * 加入列表即自动计算；已算过的路径不重复算（删掉再拖回来会重算，符合直觉）。
       *
       * 【结果必须按路径存，不能挂在行元素上】
       * 早期 hashFile 里 `const row = picker.list.rowAt(idx)` 抓住行元素，
       * 算完 row.appendChild(box) —— 而 filePicker 的 refresh() 会
       * `body.innerHTML = ''` 重建所有行。于是只要用户在算的过程中或算完之后
       * 再添加/删除任何一个文件：
       *   · 之前那行成了游离节点，摘要被追加到看不见的地方；
       *   · hashed 这个 Set 仍记着该路径，onChange 里 `if (hashed.has(...)) continue`
       *     直接跳过 → 永远不会重算，只能把文件删掉重加。
       * 现在：结果存 results（path → {hex} 或 {err}），用 filePicker 的 rowEnd
       * 回调在**每次建行**时按路径重画。hashed 只负责「别重复算」，不负责回填。 */
      const hashed = new Set();
      const results = new Map();   // path → { hex: {md5,sha1,…} } 或 { err: '…' }
      const picker = filePicker({
        text: '拖入文件进行校验，或点击选择',
        emptyText: '还没有添加文件',
        rowEnd: (it, i, row) => paintResult(row, it.path),
        onChange: (items) => {
          const present = new Set(items.map((x) => x.path));
          // 移出列表的路径从「已算过」集合里摘掉，重新加入时才会重算
          for (const k of [...hashed]) if (!present.has(k)) { hashed.delete(k); results.delete(k); }
          for (const it of items) {
            if (hashed.has(it.path)) continue;
            hashed.add(it.path);
            hashFile(it.path);
          }
        }
      });
      /* 把某个路径的结果画到给定行上（行是新建的，所以每次都是全新画一遍）。
       * 没有结果就什么都不画（还在算或算失败且未记录）。 */
      function paintResult(row, p) {
        const old = row.querySelector('.hash-result');
        if (old) old.remove();
        const r = results.get(p);
        if (!r || !row) return;
        const box = h('div', { class: 'hash-result', style: { flexBasis: '100%', marginTop: '2px' } });
        if (r.err) box.appendChild(div('field-err', '计算失败: ' + r.err));
        else {
          for (const [algo, hex] of Object.entries(r.hex)) {
            box.appendChild(div('form-row',
              h('span', { class: 'form-label', style: { minWidth: '70px', textTransform: 'uppercase' } }, algo),
              h('span', { class: 'mono', style: { flex: '1', userSelect: 'text', wordBreak: 'break-all', fontSize: '12px' } }, hex),
              btn('复制', 'btn-sm btn-text', () => copyText(hex))));
          }
        }
        row.appendChild(box);
      }
      async function hashFile(p) {
        // 每行只保留一份摘要块：重复计算同一文件时先清掉旧的
        const idx = picker.paths.indexOf(p);
        const row = idx >= 0 ? picker.list.rowAt(idx) : null;
        const box = h('div', { class: 'hash-result', style: { flexBasis: '100%', marginTop: '2px' } });
        const progress = div('progress', div('progress-fill'));
        progress.style.margin = '6px 0';
        box.appendChild(progress);
        /* 进度条只画在「当前确实有这一行」的时候；算完时如果行已被重建，
         * 结果照样会存进 results，由 rowEnd 在下次建行时重画出来。 */
        if (row) {
          const old = row.querySelector('.hash-result');
          if (old) old.remove();
          row.appendChild(box);
        }
        const unsub = on('job:progress', (d) => {
          if (d.kind === 'hash' && d.id === p && progress.firstChild) progress.firstChild.style.width = (d.done / d.total * 100) + '%';
        });
        const algos = ['md5', 'sha1', 'sha256', 'sha512'];
        /* 【一次读盘】原来对同一个文件连续调用 4 次 fs:hash-file，
         * 每次主进程都要完整读一遍盘 —— 校验 1GB 文件要读 4GB。
         * 改用 fs:hash-file-multi 一次流式读取同时算 4 个摘要，IO 降到 1/4。 */
        try {
          const r = await window.api.invoke('fs:hash-file-multi', p, algos);
          const hex = {};
          for (const algo of algos) hex[algo] = r.hex[algo];
          results.set(p, { hex });
        } catch (e) {
          results.set(p, { err: (e && e.message) || String(e) });
        }
        progress.remove();
        /* 【结果按路径存好后，重画到"当前"的那一行】
         * 不能用一开始抓住的 row：算的过程中用户可能又加了文件，
         * refresh() 已经把那一行换掉了。重新按路径取当前行才可靠；
         * 即使此刻行不存在（文件被移出列表），结果也在 results 里，
         * 以后重新加入时 rowEnd 会画出来。 */
        const curIdx = picker.paths.indexOf(p);
        const curRow = curIdx >= 0 ? picker.list.rowAt(curIdx) : null;
        if (curRow && results.has(p)) paintResult(curRow, p);
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
