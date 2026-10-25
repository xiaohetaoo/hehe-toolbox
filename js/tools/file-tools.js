/* 模块：文件处理 —— 批量重命名 / 批量改后缀 / 加密解密 / 分割合并 / 重复文件 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, confirmBox, dropzone, renderTable, fmtBytes, progressEl } = window.ui;
  const { invoke } = window.api;
  const MOD = 'file';

  /* ---------- 批量重命名 ---------- */
  register({
    id: 'batch-rename', name: '批量重命名', module: MOD, icon: 'pencil',
    desc: '前缀/后缀、序号、查找替换、正则替换、大小写，先预览后执行',
    keywords: ['重命名', '批量', 'rename', '正则'],
    render(page) {
      let files = [];
      const dz = dropzone({ text: '选择或拖入要重命名的文件（可多选）', onFiles: async (paths) => { files = paths; dirMode = false; buildPreview(); } });
      let dirMode = false;
      const dirInput = h('input', { class: 'input input-sm', placeholder: '或输入目录路径（重命名目录内所有文件）', style: { flex: '1' } });
      const loadDirBtn = btn('加载目录', 'btn-sm btn-secondary', async () => {
        const d = dirInput.value.trim();
        if (!d) return;
        try {
          const list = await invoke('fs:list', d);
          files = list.filter(x => !x.isDir).map(x => x.path);
          dirMode = true;
          buildPreview();
        } catch (e) { toast(e.message, 'error'); }
      });
      const pickDirBtn = btn('选择目录…', 'btn-sm btn-secondary', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) { dirInput.value = d[0]; loadDirBtn.click(); }
      });

      const prefixIn = h('input', { class: 'input input-sm', placeholder: '新前缀', style: { width: '110px' } });
      const suffixIn = h('input', { class: 'input input-sm', placeholder: '新后缀（文件名尾）', style: { width: '130px' } });
      const startNum = h('input', { class: 'input input-sm', type: 'number', value: '1', style: { width: '70px' } });
      const findIn = h('input', { class: 'input input-sm', placeholder: '查找（支持正则）', style: { width: '140px' } });
      const replIn = h('input', { class: 'input input-sm', placeholder: '替换为', style: { width: '140px' } });
      const useRegex = h('input', { type: 'checkbox', class: 'checkbox' });
      const caseSel = h('select', { class: 'select input-sm' }, h('option', { value: '' }, '大小写不变'), h('option', { value: 'lower' }, '转小写'), h('option', { value: 'upper' }, '转大写'));
      const extIn = h('input', { class: 'input input-sm', placeholder: '改扩展名（如 .jpg）', style: { width: '140px' } });
      const previewBox = div('');
      const prog = progressEl();
      prog.hide();

      function newName(path, idx) {
        const parts = path.split(/[\\/]/);
        const name = parts.pop();
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let nb = base;
        if (findIn.value) {
          try {
            nb = useRegex.checked ? nb.replace(new RegExp(findIn.value, 'g'), replIn.value) : nb.split(findIn.value).join(replIn.value);
          } catch (e) { /* invalid regex */ }
        }
        if (prefixIn.value) nb = prefixIn.value + nb;
        nb = nb + String(parseInt(startNum.value || '1') + idx);
        if (suffixIn.value) nb += suffixIn.value;
        if (caseSel.value === 'lower') nb = nb.toLowerCase();
        if (caseSel.value === 'upper') nb = nb.toUpperCase();
        let ne = ext;
        if (extIn.value) ne = extIn.value.startsWith('.') ? extIn.value : '.' + extIn.value;
        return [...parts, nb + ne].join('/');
      }
      function buildPreview() {
        previewBox.innerHTML = '';
        if (!files.length) { previewBox.appendChild(div('empty-tip', '请先添加文件')); return; }
        const table = renderTable({
          columns: [
            { key: 'old', title: '原文件名', render: r => div('mono', { style: { fontSize: '12px' } }, r.old.split(/[\\/]/).pop()) },
            { key: 'new', title: '新文件名', render: r => div('mono', { style: { fontSize: '12px', color: 'var(--primary)' } }, r.new.split(/[\\/]/).pop()) },
            { key: 'size', title: '大小', width: '90px', render: r => fmtBytes(r.size) },
            { key: 'conflict', title: '状态', width: '110px', render: r => r.conflict ? h('span', { class: 'tag tag-red' }, '名称冲突') : h('span', { class: 'tag tag-green' }, '就绪') }
          ],
          rows: files.map((p, i) => ({ old: p, new: newName(p, i) })),
          rowKey: 'old'
        });
        previewBox.appendChild(table);
        // conflict detect
        const names = new Map();
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach((tr, i) => {
          const nn = files[i] && newName(files[i], i);
          if (names.has(nn)) tr.querySelector('td:last-child').innerHTML = '<span class="tag tag-red">名称冲突</span>';
          names.set(nn, true);
        });
      }
      const applyBtn = btn('执行重命名', 'btn-primary', async () => {
        if (!files.length) return toast('请先添加文件', 'warn');
        if (!(await confirmBox({ title: '执行重命名', message: `将对 ${files.length} 个文件执行重命名，确定继续？` }))) return;
        let ok = 0, fail = 0;
        prog.show();
        for (let i = 0; i < files.length; i++) {
          const target = newName(files[i], i);
          prog.set((i + 1) / files.length * 100);
          try {
            if (files[i] !== target) await invoke('fs:rename', files[i], target);
            ok++;
          } catch (e) { fail++; console.error(e); }
        }
        prog.hide();
        toast(`完成：成功 ${ok}，失败 ${fail}`, fail ? 'warn' : 'success');
        if (dirMode && dirInput.value) loadDirBtn.click(); else { files = []; buildPreview(); }
      });

      page.appendChild(div('card', div('card-title', '选择文件'), dz,
        div('form-row', dirInput, pickDirBtn, loadDirBtn)));
      page.appendChild(div('card', div('card-title', '重命名规则（可组合）'),
        div('form-row', h('span', { class: 'form-label' }, '序号'), prefixIn, h('span', { class: 'field-hint' }, '+ 序号'), startNum, suffixIn),
        div('form-row', h('span', { class: 'form-label' }, '替换'), findIn, replIn, h('label', { class: 'field-hint' }, useRegex, ' 正则')),
        div('form-row', h('span', { class: 'form-label' }, '其他'), caseSel, extIn),
        div('form-row', btn('刷新预览', 'btn-secondary btn-sm', buildPreview), applyBtn, prog.el)));
      page.appendChild(div('card', div('card-title', '预览'), previewBox));
      buildPreview();
    }
  });

  /* ---------- 批量改后缀 ---------- */
  register({
    id: 'batch-ext', name: '批量改后缀', module: MOD, icon: 'file',
    desc: '批量修改指定目录下文件的扩展名，支持仅匹配特定后缀',
    keywords: ['后缀', '扩展名', '批量'],
    render(page) {
      const dirInput = h('input', { class: 'input', placeholder: '目录路径', style: { flex: '1' } });
      const pickBtn = btn('选择目录', 'btn-secondary btn-sm', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) { dirInput.value = d[0]; }
      });
      const fromIn = h('input', { class: 'input input-sm', placeholder: '原后缀，如 txt（留空=全部）', style: { width: '200px' } });
      const toIn = h('input', { class: 'input input-sm', placeholder: '新后缀，如 md', style: { width: '140px' } });
      const recursive = h('input', { type: 'checkbox', class: 'checkbox' });
      const previewBox = div('');
      let plan = [];
      const scanBtn = btn('扫描预览', 'btn-secondary', async () => {
        previewBox.innerHTML = '';
        plan = [];
        const dir = dirInput.value.trim(), to = toIn.value.trim().replace(/^\./, '');
        if (!dir || !to) return toast('请填写目录与新后缀', 'warn');
        const from = fromIn.value.trim().replace(/^\./, '').toLowerCase();
        async function walk(d) {
          const list = await invoke('fs:list', d);
          for (const item of list) {
            if (item.isDir) { if (recursive.checked) await walk(item.path); continue; }
            const ext = item.name.includes('.') ? item.name.split('.').pop().toLowerCase() : '';
            if (!from || ext === from) plan.push({ path: item.path, newPath: item.path.slice(0, item.path.length - ext.length) + to, size: item.size });
          }
        }
        try { await walk(dir); } catch (e) { return toast(e.message, 'error'); }
        if (!plan.length) { previewBox.appendChild(div('empty-tip', '没有匹配的文件')); return; }
        previewBox.appendChild(renderTable({
          columns: [
            { key: 'path', title: '文件', render: r => div('mono', { style: { fontSize: '12px' } }, r.path) },
            { key: 'newPath', title: '改为', render: r => div('mono', { style: { fontSize: '12px', color: 'var(--primary)' } }, r.newPath) }
          ],
          rows: plan.slice(0, 200)
        }));
        if (plan.length > 200) previewBox.appendChild(div('field-hint', `…共 ${plan.length} 个文件`));
      });
      const applyBtn = btn('执行修改', 'btn-primary', async () => {
        if (!plan.length) return toast('请先扫描', 'warn');
        if (!(await confirmBox({ title: '批量改后缀', message: `将修改 ${plan.length} 个文件的扩展名，确定继续？` }))) return;
        let ok = 0, fail = 0;
        for (const p of plan) {
          try { await invoke('fs:rename', p.path, p.newPath); ok++; } catch (e) { fail++; }
        }
        toast(`完成：成功 ${ok}，失败 ${fail}`, fail ? 'warn' : 'success');
        scanBtn.click();
      });
      page.appendChild(div('card', div('card-title', '目标目录'), div('form-row', dirInput, pickBtn),
        div('form-row', h('span', { class: 'form-label' }, '规则'), fromIn, h('span', null, '→'), toIn,
          h('label', { class: 'field-hint' }, recursive, ' 包含子目录')),
        div('form-row', scanBtn, applyBtn)));
      page.appendChild(div('card', div('card-title', '预览'), previewBox));
    }
  });

  /* ---------- 文件加密解密 ---------- */
  register({
    id: 'file-crypt', name: '文件加密解密', module: MOD, icon: 'lock',
    desc: 'AES-256-CBC 本地加密，密码经 scrypt 派生，离线安全',
    keywords: ['加密', '解密', 'aes', '密码'],
    render(page) {
      let mode = 'encrypt';
      let filePath = null;
      const dz = dropzone({
        text: '选择或拖入要加密/解密的文件', multiple: false,
        onFiles: (paths) => { filePath = paths[0]; fileLabel.textContent = filePath; }
      });
      const fileLabel = div('field-hint', '未选择文件');
      const pwdIn = h('input', { type: 'password', class: 'input', placeholder: '设置密码（加密）或输入密码（解密）', style: { flex: '1' } });
      const status = h('div', { class: 'field-hint' }, '');
      const prog = progressEl(); prog.hide();
      async function run() {
        if (!filePath) return toast('请先选择文件', 'warn');
        if (!pwdIn.value) return toast('请输入密码', 'warn');
        const outDefault = mode === 'encrypt' ? filePath + '.hehe' : filePath.replace(/\.hehe$/, '') + '.dec';
        const out = await invoke('dialog:save', { defaultPath: outDefault });
        if (!out) return;
        prog.show();
        const unsub = window.api.on('job:progress', (d) => { if (d.id === filePath) prog.set(d.done / d.total * 100); });
        try {
          const fn = mode === 'encrypt' ? 'fs:encrypt-file' : 'fs:decrypt-file';
          const r = await invoke(fn, filePath, out, pwdIn.value);
          status.innerHTML = `<span class="status-ok">✓ 完成</span> 输出：${escapeHtml(r.outPath)}（${fmtBytes(r.size)}）`;
          toast(mode === 'encrypt' ? '加密完成' : '解密完成', 'success');
        } catch (e) {
          status.innerHTML = `<span class="status-err">✗ ${escapeHtml(e.message)}</span>`;
          toast(e.message, 'error');
        } finally { prog.hide(); unsub(); }
      }
      const encBtn = btn('🔒 加密模式', 'btn-sm btn-primary', () => setMode('encrypt'));
      const decBtn = btn('🔓 解密模式', 'btn-sm btn-secondary', () => setMode('decrypt'));
      function setMode(m) {
        mode = m;
        encBtn.className = 'btn btn-sm ' + (m === 'encrypt' ? 'btn-primary' : 'btn-secondary');
        decBtn.className = 'btn btn-sm ' + (m === 'decrypt' ? 'btn-primary' : 'btn-secondary');
      }
      page.appendChild(div('card', div('card-title', '选择文件', encBtn, ' ', decBtn), dz, fileLabel));
      page.appendChild(div('card', div('card-title', '密码'),
        div('form-row', pwdIn, btn(mode === 'encrypt' ? '开始加密' : '开始解密', 'btn-primary', run)),
        prog.el, status));
    }
  });

  /* ---------- 文件分割与合并 ---------- */
  register({
    id: 'file-split', name: '文件分割合并', module: MOD, icon: 'scissors',
    desc: '大文件按大小拆分为分片，支持清单合并还原',
    keywords: ['分割', '合并', '分片', '拆分'],
    render(page) {
      let tab = 'split';
      const sp = div(''), mg = div('');
      const tabBtn1 = btn('分割文件', 'btn-sm btn-primary', () => switchT('split'));
      const tabBtn2 = btn('合并分片', 'btn-sm btn-secondary', () => switchT('merge'));
      function switchT(t) {
        tab = t;
        sp.style.display = t === 'split' ? '' : 'none';
        mg.style.display = t === 'merge' ? '' : 'none';
        tabBtn1.className = 'btn btn-sm ' + (t === 'split' ? 'btn-primary' : 'btn-secondary');
        tabBtn2.className = 'btn btn-sm ' + (t === 'merge' ? 'btn-primary' : 'btn-secondary');
      }

      /* split */
      let spFile = null;
      const dz1 = dropzone({ text: '选择要分割的文件', multiple: false, onFiles: (paths) => { spFile = paths[0]; spLabel.textContent = spFile; } });
      const spLabel = div('field-hint', '未选择文件');
      const sizeIn = h('input', { class: 'input input-sm', type: 'number', value: '10', style: { width: '90px' } });
      const spProg = progressEl(); spProg.hide();
      const spStatus = div('field-hint', '');
      page.appendChild(div('card', div('card-title', '模式', tabBtn1, ' ', tabBtn2)));
      sp.appendChild(div('card', div('card-title', '分割'), dz1, spLabel,
        div('form-row', h('span', { class: 'form-label' }, '每片大小'), sizeIn, h('span', { class: 'field-hint' }, 'MB'),
          btn('开始分割', 'btn-primary', async () => {
            if (!spFile) return toast('请选择文件', 'warn');
            const outDir = spFile + '.parts';
            spProg.show(); spStatus.textContent = '';
            const unsub = window.api.on('job:progress', (d) => { if (d.id === spFile) spProg.set(d.done / d.total * 100); });
            try {
              const r = await invoke('fs:split-file', spFile, parseInt(sizeIn.value) || 10, outDir);
              spStatus.innerHTML = `<span class="status-ok">✓ 分割完成</span>：${r.parts} 个分片，输出目录 ${escapeHtml(r.outDir)}`;
              toast('分割完成', 'success');
            } catch (e) { spStatus.innerHTML = `<span class="status-err">✗ ${escapeHtml(e.message)}</span>`; }
            finally { spProg.hide(); unsub(); }
          })),
        spProg.el, spStatus));
      page.appendChild(sp);

      /* merge */
      const dz2 = dropzone({ text: '选择任一分片（.part001）或清单文件（.manifest.hehe.json）', multiple: false, onFiles: (paths) => { mgFile = paths[0]; mgLabel.textContent = mgFile; } });
      let mgFile = null;
      const mgLabel = div('field-hint', '未选择文件');
      const mgProg = progressEl(); mgProg.hide();
      const mgStatus = div('field-hint', '');
      mg.appendChild(div('card', div('card-title', '合并'), dz2, mgLabel,
        div('form-row', btn('开始合并', 'btn-primary', async () => {
          if (!mgFile) return toast('请选择分片', 'warn');
          mgProg.show(); mgStatus.textContent = '';
          const unsub = window.api.on('job:progress', (d) => mgProg.set(d.total ? d.done / d.total * 100 : 0));
          try {
            const r = await invoke('fs:merge-parts', mgFile);
            mgStatus.innerHTML = `<span class="status-ok">✓ 合并完成</span>：${escapeHtml(r.outPath)}（${fmtBytes(r.size)}，${r.parts} 片）`;
            toast('合并完成', 'success');
          } catch (e) { mgStatus.innerHTML = `<span class="status-err">✗ ${escapeHtml(e.message)}</span>`; }
          finally { mgProg.hide(); unsub(); }
        })),
        mgProg.el, mgStatus));
      page.appendChild(mg);
    }
  });

  /* ---------- 重复文件查找 ---------- */
  register({
    id: 'dedupe', name: '重复文件查找', module: MOD, icon: 'copy',
    desc: '按内容 MD5 / 名称 / 大小扫描重复文件，支持批量删除',
    keywords: ['重复', '查重', 'dedupe', 'md5'],
    render(page) {
      const dirInput = h('input', { class: 'input', placeholder: '要扫描的目录', style: { flex: '1' } });
      const pickBtn = btn('选择目录', 'btn-secondary btn-sm', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) { dirInput.value = d[0]; }
      });
      const modeSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'content' }, '按内容（MD5，准确）'),
        h('option', { value: 'name' }, '按文件名（快速）'),
        h('option', { value: 'size' }, '按大小（快速）'));
      const status = div('field-hint', '');
      const resultBox = div('');
      let groups = [];
      const scanBtn = btn('开始扫描', 'btn-primary', async () => {
        const dir = dirInput.value.trim();
        if (!dir) return toast('请选择目录', 'warn');
        resultBox.innerHTML = ''; status.textContent = '扫描中…';
        const unsub = window.api.on('job:progress', (d) => { status.textContent = `扫描中… 已检查 ${d.files || 0} 个文件`; });
        try {
          const r = await invoke('fs:dedupe', dir, { mode: modeSel.value });
          groups = r.groups;
          status.innerHTML = groups.length
            ? `发现 <b>${groups.length}</b> 组重复文件，可释放 <b>${fmtBytes(r.totalWasted)}</b>`
            : '未发现重复文件 ✓';
          renderGroups();
        } catch (e) { status.textContent = '✗ ' + e.message; }
        finally { unsub(); }
      });
      function renderGroups() {
        resultBox.innerHTML = '';
        for (const [gi, g] of groups.entries()) {
          const card = div('card');
          card.style.padding = '14px';
          card.style.border = '1px solid var(--border)';
          card.appendChild(div('form-row',
            h('span', { class: 'tag tag-blue' }, `组 ${gi + 1}`),
            h('span', { class: 'field-hint' }, `${g.files.length} 个文件 · 每个 ${fmtBytes(g.size)} · 浪费 ${fmtBytes(g.size * (g.files.length - 1))}`),
            h('span', { style: { marginLeft: 'auto' } }, btn('保留第一个，删除其余', 'btn-sm btn-danger-plain', () => deleteIn(g, 0)))));
          const checks = [];
          g.files.forEach((f, fi) => {
            const cb = h('input', { type: 'checkbox', class: 'checkbox' });
            cb.checked = fi > 0;
            checks.push(cb);
            card.appendChild(div('form-row', cb,
              h('span', { class: 'mono', style: { flex: '1', fontSize: '12px', userSelect: 'text', wordBreak: 'break-all' } }, f),
              btn('打开位置', 'btn-sm btn-text', () => invoke('fs:show-item', f))));
          });
          card.appendChild(div('form-row', btn('删除勾选文件', 'btn-sm btn-danger', async () => {
            const selected = g.files.filter((_, i) => checks[i].checked);
            if (!selected.length) return toast('未勾选任何文件', 'warn');
            if (selected.length === g.files.length) return toast('至少保留一个文件', 'warn');
            if (!(await confirmBox({ title: '删除重复文件', message: `将永久删除 ${selected.length} 个文件（不进回收站），确定？`, danger: true, okText: '删除' }))) return;
            for (const f of selected) { try { await invoke('fs:delete', f); } catch (e) { toast(e.message, 'error'); } }
            toast('已删除', 'success');
            scanBtn.click();
          })));
          resultBox.appendChild(card);
        }
      }
      async function deleteIn(g, keepIdx) {
        const del = g.files.filter((_, i) => i !== keepIdx);
        if (!(await confirmBox({ title: '删除重复文件', message: `保留第一个，永久删除其余 ${del.length} 个文件，确定？`, danger: true, okText: '删除' }))) return;
        for (const f of del) { try { await invoke('fs:delete', f); } catch (e) { toast(e.message, 'error'); } }
        toast('已删除', 'success');
        scanBtn.click();
      }
      page.appendChild(div('card', div('card-title', '扫描设置'),
        div('form-row', dirInput, pickBtn),
        div('form-row', h('span', { class: 'form-label' }, '方式'), modeSel, scanBtn),
        status));
      page.appendChild(resultBox);
    }
  });

  /* ---------- 压缩解压（ZIP） ---------- */
  register({
    id: 'zip-tool', name: '压缩解压', module: MOD, icon: 'box',
    desc: 'ZIP 压缩与解压（7Z/RAR 需外部引擎，暂不支持密码）',
    keywords: ['压缩', '解压', 'zip'],
    render(page) {
      const cPaths = [];
      const dz1 = dropzone({ text: '选择或拖入要压缩的文件/文件夹', onFiles: (paths) => { cPaths.push(...paths); cLabel.textContent = `已选 ${cPaths.length} 项：` + cPaths.slice(0, 3).join('、') + (cPaths.length > 3 ? '…' : ''); } });
      const cLabel = div('field-hint', '未选择');
      const zipName = h('input', { class: 'input input-sm', placeholder: '输出 zip 路径（留空自动命名）', style: { flex: '1' } });
      const cBtn = btn('压缩', 'btn-primary', async () => {
        if (!cPaths.length) return toast('请选择文件', 'warn');
        try {
          let out = zipName.value.trim();
          if (!out) {
            const first = cPaths[0];
            const dir = first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : first.slice(0, first.lastIndexOf('\\'));
            out = await invoke('fs:unique-path', dir + '/archive.zip');
          } else {
            out = await invoke('fs:unique-path', out.endsWith('.zip') ? out : out + '.zip');
          }
          const r = await invoke('zip:compress', cPaths, out);
          toast('压缩完成：' + fmtBytes(r.size), 'success');
        } catch (e) { toast(e.message, 'error'); }
      });
      const dz2 = dropzone({ text: '选择或拖入 zip 文件解压', multiple: false, onFiles: async (paths) => {
        const zip = paths[0];
        const dir = zip.replace(/\.zip$/i, '') + '-extracted';
        try {
          await invoke('zip:extract', zip, dir);
          toast('解压完成：' + dir, 'success');
        } catch (e) { toast(e.message, 'error'); }
      } });
      page.appendChild(div('card', div('card-title', '压缩为 ZIP'), dz1, cLabel,
        div('form-row', zipName, cBtn)));
      page.appendChild(div('card', div('card-title', '解压 ZIP'), dz2, div('field-hint', '解压到同名文件夹')));
    }
  });

  /* ---------- 全局文件搜索（Everything 式） ---------- */
  register({
    id: 'global-search', name: '全局文件搜索', module: MOD, icon: 'search',
    desc: 'Everything 式全盘秒搜：NTFS 索引（管理员）/ es.exe / 快速扫描 三引擎',
    keywords: ['everything', '搜索', '文件', '全盘', '查找', '秒搜'],
    render(page) {
      const envLine = div('field-hint', '检测环境中…');
      const volRow = div('form-row', { style: { flexWrap: 'wrap' } });
      const hint = div('field-hint', '「建索引」按 Everything 原理读取 NTFS USN 日志（需以管理员身份运行核核工具箱），建好后全盘即输即搜；若安装了 Everything 且有 es.exe 会自动优先使用；无管理员权限可用「快速扫描」逐层遍历（较慢，结果实时流出）。');
      const inBox = h('input', { class: 'input', placeholder: '输入文件名关键词，即输即搜…', style: { flex: '1' } });
      const rootSel = h('select', { class: 'select input-sm', style: { width: '110px' } });
      const limitSel = h('select', { class: 'select input-sm' },
        h('option', { value: '100' }, '100 条'), h('option', { value: '300', selected: true }, '300 条'), h('option', { value: '1000' }, '1000 条'));
      const engTag = h('span', { class: 'tag tag-gray' }, '就绪');
      const statsLine = h('span', { class: 'field-hint' }, '');
      const listBox = div('');
      const quickBtn = btn('📂 快速扫描（无需管理员）', 'btn-secondary btn-sm', startQuick);
      let env = null, builtInfo = {}, searchTimer = 0, quickJob = null, quickUnsub = null, seq = 0;
      async function refreshEnv() {
        env = await invoke('search:env').catch(() => null);
        builtInfo = (await invoke('search:index-status').catch(() => ({}))) || {};
        envLine.innerHTML = '';
        if (!env) { envLine.appendChild(div('field-err', '环境检测失败')); return; }
        envLine.appendChild(h('span', { class: 'tag ' + (env.admin ? 'tag-green' : 'tag-orange') }, env.admin ? '管理员权限 ✓' : '无管理员权限'));
        envLine.appendChild(h('span', { class: 'tag ' + (env.es ? 'tag-green' : 'tag-gray') }, env.es ? 'es.exe ✓（优先使用）' : 'es.exe 未检测到'));
        const idxCount = Object.keys(builtInfo).length;
        envLine.appendChild(h('span', { class: 'tag ' + (idxCount ? 'tag-blue' : 'tag-gray') }, idxCount ? `已建索引 ${idxCount} 个分区` : '未建索引'));
        rootSel.innerHTML = '';
        (env.volumes || []).forEach((v, i) => rootSel.appendChild(h('option', { value: v.drive + '\\', selected: i === 0 }, v.drive)));
        renderVols();
      }
      function renderVols() {
        volRow.innerHTML = '';
        if (!env) return;
        for (const v of (env.volumes || [])) {
          const info = builtInfo[v.drive];
          const gb = v.size ? (v.size / 1073741824).toFixed(0) + 'GB' : '';
          const label = (info ? '↻ 重建 ' : '⬢ 建索引 ') + v.drive + (gb ? `（${gb}）` : '') + (info ? ` · ${info.count.toLocaleString()} 项` : '');
          volRow.appendChild(btn(label, 'btn-sm ' + (info ? 'btn-secondary' : 'btn-primary'), () => buildIndex(v.drive)));
        }
        if (Object.keys(builtInfo).length) volRow.appendChild(btn('清空索引', 'btn-sm btn-text', async () => {
          try { await invoke('search:free'); builtInfo = {}; await refreshEnv(); toast('已释放索引内存', 'success'); } catch (e) { toast(e.message, 'error'); }
        }));
      }
      async function buildIndex(drive) {
        engTag.textContent = '构建索引中…'; engTag.className = 'tag tag-orange';
        statsLine.textContent = '正在读取 NTFS 索引…';
        try {
          const r = await invoke('search:build', drive);
          toast(`索引完成：${r.count.toLocaleString()} 项`, 'success');
        } catch (e) { statsLine.textContent = '✗ ' + e.message; toast(e.message, 'error'); }
        engTag.textContent = '就绪'; engTag.className = 'tag tag-gray';
        await refreshEnv();
        doSearch();
      }
      function schedule() { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 200); }
      function stopQuick() {
        clearTimeout(searchTimer);
        if (quickJob) { invoke('job:kill', quickJob).catch(() => {}); quickJob = null; }
        if (quickUnsub) { quickUnsub(); quickUnsub = null; }
      }
      async function doSearch() {
        const mySeq = ++seq;
        stopQuick();
        listBox.innerHTML = '';
        statsLine.textContent = '';
        const q = inBox.value.trim();
        if (!q) { engTag.textContent = '就绪'; engTag.className = 'tag tag-gray'; return; }
        const engine = env && env.es ? 'es' : (Object.keys(builtInfo).length ? 'mft' : null);
        if (!engine) {
          engTag.textContent = '无可用引擎'; engTag.className = 'tag tag-orange';
          listBox.appendChild(div('empty-tip', '没有可用搜索引擎：请点击上方「建索引」（需管理员），安装 Everything（es.exe），或使用下方「快速扫描」'));
          return;
        }
        engTag.textContent = engine === 'es' ? '引擎：Everything(es.exe)' : '引擎：NTFS 索引';
        engTag.className = 'tag tag-blue';
        try {
          const r = engine === 'es' ? await invoke('search:es', { q, limit: +limitSel.value })
            : await invoke('search:query', { q, limit: +limitSel.value, stat: true });
          if (mySeq !== seq) return;
          renderRows(r.rows, false);
          statsLine.textContent = `${r.rows.length} 条 · ${r.ms}ms`;
        } catch (e) {
          if (mySeq !== seq) return;
          engTag.textContent = '出错'; engTag.className = 'tag tag-red';
          listBox.appendChild(div('field-err', '✗ ' + e.message));
        }
      }
      function renderRows(rows, append) {
        if (!rows.length && !append) { listBox.appendChild(div('empty-tip', '没有匹配的文件')); return; }
        listBox.appendChild(renderTable({
          columns: [
            { key: 'name', title: '文件名', render: r => h('span', { class: 'mono', style: { wordBreak: 'break-all' } }, r.name + (r.dir ? ' 📁' : '')) },
            { key: 'size', title: '大小', width: '90px', render: r => r.dir ? '📁' : (r.size != null ? fmtBytes(r.size) : '-') },
            { key: 'path', title: '完整路径', render: r => h('span', { class: 'field-hint', style: { wordBreak: 'break-all', fontSize: '11px' } }, r.path) },
            { key: 'act', title: '操作', width: '180px', render: (r, td) => {
              td.appendChild(btn('打开', 'btn-sm btn-text', () => invoke('fs:open-path', r.path).catch(e2 => toast(e2.message, 'error'))));
              td.appendChild(btn('位置', 'btn-sm btn-text', () => invoke('fs:show-item', r.path)));
              td.appendChild(btn('复制路径', 'btn-sm btn-text', () => copyText(r.path)));
            } }
          ],
          rows
        }));
      }
      function startQuick() {
        const q = inBox.value.trim();
        if (!q) return toast('请先输入关键词', 'warn');
        const root = rootSel.value || (env && env.volumes && env.volumes[0] ? env.volumes[0].drive + '\\' : '');
        if (!root) return toast('未找到可扫描的分区', 'warn');
        clearTimeout(searchTimer); seq++;
        stopQuick();
        listBox.innerHTML = ''; statsLine.textContent = '正在扫描…';
        engTag.textContent = '快速扫描中'; engTag.className = 'tag tag-orange';
        let rowCount = 0;
        quickUnsub = window.api.on('job:stream', (d) => {
          try {
            const j = JSON.parse(d.data);
            if (j.rows && j.rows.length) { rowCount += j.rows.length; renderRows(j.rows, true); statsLine.textContent = `已找到 ${rowCount} 条（扫描中…）`; }
            else if (j.scanned != null && !j.done) statsLine.textContent = `已扫描 ${j.scanned.toLocaleString()} 项…`;
            if (j.done) {
              engTag.textContent = '就绪'; engTag.className = 'tag tag-gray';
              statsLine.textContent = j.error ? ('✗ ' + j.error) : `完成：找到 ${j.matched} 条 · 扫描 ${(j.scanned || 0).toLocaleString()} 项 · ${j.ms}ms${j.canceled ? '（已停止）' : ''}`;
              quickJob = null;
            }
          } catch (e) {}
        });
        invoke('search:quick', { root, q, limit: +limitSel.value }).then((r) => { quickJob = r.id; }).catch((e) => { toast(e.message, 'error'); engTag.textContent = '就绪'; engTag.className = 'tag tag-gray'; });
      }
      inBox.addEventListener('input', schedule);
      window.App.onCleanup(stopQuick);
      refreshEnv();
      page.appendChild(div('card', div('card-title', '搜索引擎'), envLine, volRow, hint));
      page.appendChild(div('card', div('card-title', '搜索'),
        div('form-row', inBox, limitSel),
        div('form-row', engTag, ' ', statsLine),
        div('form-row', quickBtn, h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '扫描范围'), rootSel),
        listBox));
      setTimeout(() => { try { inBox.focus(); } catch (e) {} }, 100);
    }
  });
})();
