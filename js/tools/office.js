/* 模块：办公文档 —— PDF 处理 / 图片转PDF / PDF转图片 / 翻译 / 占位 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, dropzone, fmtBytes } = window.ui;
  const { invoke } = window.api;
  const MOD = 'office';

  /* ---------- PDF 基础处理 ---------- */
  register({
    id: 'pdf-tools', name: 'PDF 合并拆分', module: MOD, icon: 'file-text',
    desc: 'PDF 合并、拆分、提取页面、旋转页面（pdf-lib 本地处理）',
    keywords: ['pdf', '合并', '拆分', '旋转'],
    render(page) {
      const files = [];
      const dz = dropzone({ text: '拖入一个或多个 PDF 文件', accept: 'pdf', onFiles: (p) => { files.push(...p); label.textContent = `已选 ${files.length} 个 PDF：` + files.map(f => f.split(/[\\/]/).pop()).join('、'); } });
      const label = div('field-hint', '未选择');
      const status = h('span', { class: 'field-hint' }, '');

      const mergeBtn = btn('🔗 合并为一个 PDF', 'btn-primary', async () => {
        if (files.length < 2) return toast('合并至少需要 2 个 PDF', 'warn');
        try {
          const { PDFDocument } = window.PDFLib;
          const out = await PDFDocument.create();
          for (const f of files) {
            const r = await invoke('fs:read-file-b64', f);
            const src = await PDFDocument.load(r.b64, { ignoreEncryption: true });
            const pages = await out.copyPages(src, src.getPageIndices());
            pages.forEach(pg => out.addPage(pg));
          }
          const bytes = await out.save();
          const outPath = await invoke('dialog:save', { defaultPath: 'merged.pdf' });
          if (!outPath) return;
          await invoke('fs:write-file-b64', outPath, arrayB64(bytes));
          toast('合并完成：' + outPath, 'success');
        } catch (e) { toast('合并失败：' + e.message, 'error'); }
      });

      const pageIn = h('input', { class: 'input input-sm mono', placeholder: '页码范围，如 1-3,5', style: { width: '160px' } });
      const extractBtn = btn('📄 提取页面', 'btn-secondary', async () => {
        if (!files.length) return toast('请先选择 PDF', 'warn');
        const ranges = parseRanges(pageIn.value);
        if (!ranges.length) return toast('请输入页码范围', 'warn');
        try {
          const { PDFDocument } = window.PDFLib;
          const r = await invoke('fs:read-file-b64', files[0]);
          const src = await PDFDocument.load(r.b64, { ignoreEncryption: true });
          const out = await PDFDocument.create();
          const indices = ranges.filter(i => i < src.getPageCount());
          const pages = await out.copyPages(src, indices);
          pages.forEach(pg => out.addPage(pg));
          const bytes = await out.save();
          const outPath = await invoke('dialog:save', { defaultPath: 'extracted.pdf' });
          if (!outPath) return;
          await invoke('fs:write-file-b64', outPath, arrayB64(bytes));
          toast(`提取 ${indices.length} 页完成`, 'success');
        } catch (e) { toast('提取失败：' + e.message, 'error'); }
      });

      const splitEvery = h('input', { type: 'number', class: 'input input-sm', value: '1', min: '1', style: { width: '70px' } });
      const splitBtn = btn('✂ 拆分 PDF', 'btn-secondary', async () => {
        if (!files.length) return toast('请先选择 PDF', 'warn');
        try {
          const { PDFDocument } = window.PDFLib;
          const r = await invoke('fs:read-file-b64', files[0]);
          const src = await PDFDocument.load(r.b64, { ignoreEncryption: true });
          const n = src.getPageCount();
          const per = Math.max(1, parseInt(splitEvery.value) || 1);
          const dir = files[0].replace(/\.pdf$/i, '') + '-split';
          await invoke('fs:mkdir', dir);
          for (let i = 0; i < n; i += per) {
            const out = await PDFDocument.create();
            const idx = Array.from({ length: Math.min(per, n - i) }, (_, k) => i + k);
            const pages = await out.copyPages(src, idx);
            pages.forEach(pg => out.addPage(pg));
            const bytes = await out.save();
            await invoke('fs:write-file-b64', `${dir}/part-${String(i + 1).padStart(3, '0')}.pdf`, arrayB64(bytes));
          }
          toast(`已拆分为 ${Math.ceil(n / per)} 个文件：${dir}`, 'success');
        } catch (e) { toast('拆分失败：' + e.message, 'error'); }
      });

      const rotSel = h('select', { class: 'select input-sm' }, h('option', { value: '90' }, '90°'), h('option', { value: '180' }, '180°'), h('option', { value: '270' }, '270°'));
      const rotBtn = btn('🔄 旋转全部页面', 'btn-secondary', async () => {
        if (!files.length) return toast('请先选择 PDF', 'warn');
        try {
          const { PDFDocument, degrees } = window.PDFLib;
          const r = await invoke('fs:read-file-b64', files[0]);
          const doc = await PDFDocument.load(r.b64, { ignoreEncryption: true });
          const angle = parseInt(rotSel.value);
          doc.getPages().forEach(pg => pg.setRotation(degrees((pg.getRotation().angle + angle) % 360)));
          const bytes = await doc.save();
          const outPath = await invoke('dialog:save', { defaultPath: files[0].replace(/\.pdf$/i, '') + '-rotated.pdf' });
          if (!outPath) return;
          await invoke('fs:write-file-b64', outPath, arrayB64(bytes));
          toast('旋转完成', 'success');
        } catch (e) { toast('旋转失败：' + e.message, 'error'); }
      });

      function parseRanges(v) {
        const set = [];
        for (const part of (v || '').split(/[,，]/)) {
          const m = part.trim().match(/^(\d+)-(\d+)$/);
          if (m) { for (let i = +m[1]; i <= +m[2]; i++) set.push(i - 1); }
          else if (/^\d+$/.test(part.trim())) set.push(parseInt(part) - 1);
        }
        return set.filter(i => i >= 0);
      }
      function arrayB64(bytes) {
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
        return btoa(bin);
      }
      page.appendChild(div('card', div('card-title', '选择 PDF'), dz, label));
      page.appendChild(div('card', div('card-title', '操作'),
        div('form-row', mergeBtn),
        div('form-row', h('span', { class: 'form-label' }, '提取'), pageIn, extractBtn),
        div('form-row', h('span', { class: 'form-label' }, '拆分'), h('span', { class: 'field-hint' }, '每'), splitEvery, h('span', { class: 'field-hint' }, '页一个文件'), splitBtn),
        div('form-row', h('span', { class: 'form-label' }, '旋转'), rotSel, rotBtn),
        status));
    }
  });

  /* ---------- 图片转 PDF ---------- */
  register({
    id: 'img2pdf', name: '图片转 PDF', module: MOD, icon: 'image',
    desc: '多张图片合并为一个 PDF 文档',
    keywords: ['图片', 'pdf', '转换'],
    render(page) {
      const files = [];
      const dz = dropzone({ text: '按顺序拖入图片（JPG/PNG）', onFiles: (p) => { files.push(...p); label.textContent = `已选 ${files.length} 张`; } });
      const label = div('field-hint', '未选择');
      const btn2 = btn('📄 转换为 PDF', 'btn-primary', async () => {
        if (!files.length) return toast('请先选择图片', 'warn');
        try {
          const { PDFDocument } = window.PDFLib;
          const doc = await PDFDocument.create();
          for (const f of files) {
            const ext = f.split('.').pop().toLowerCase();
            const r = await invoke('fs:read-file-b64', f);
            const bytes = Uint8Array.from(atob(r.b64), c => c.charCodeAt(0));
            const img = ext === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
            const page = doc.addPage([img.width, img.height]);
            page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
          }
          const out = await doc.save();
          const outPath = await invoke('dialog:save', { defaultPath: 'images.pdf' });
          if (!outPath) return;
          let bin = ''; const chunk = 0x8000;
          for (let i = 0; i < out.length; i += chunk) bin += String.fromCharCode(...out.subarray(i, i + chunk));
          await invoke('fs:write-file-b64', outPath, btoa(bin));
          toast('已生成：' + outPath, 'success');
        } catch (e) { toast('转换失败：' + e.message, 'error'); }
      });
      page.appendChild(div('card', div('card-title', '选择图片'), dz, label, div('form-row', btn2)));
    }
  });

  /* ---------- PDF 转图片 ---------- */
  register({
    id: 'pdf2img', name: 'PDF 转图片', module: MOD, icon: 'image',
    desc: '将 PDF 页面渲染为 PNG 图片（pdf.js 本地渲染）',
    keywords: ['pdf', '图片', '转换', '渲染'],
    render(page) {
      let pdfPath = null;
      const info = div('field-hint', '未选择');
      const scaleIn = h('input', { type: 'number', class: 'input input-sm', value: '2', min: '1', max: '4', step: '0.5', style: { width: '80px' } });
      const list = div('');
      const status = h('span', { class: 'field-hint' }, '');
      const dz = dropzone({
        text: '选择 PDF 文件', multiple: false,
        onFiles: async (p) => {
          pdfPath = p[0];
          info.textContent = pdfPath;
          list.innerHTML = '';
        }
      });
      async function render() {
        if (!pdfPath) return toast('请先选择 PDF', 'warn');
        if (!window.pdfjsLib) return toast('pdf.js 未加载', 'error');
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'node_modules/pdfjs-dist/build/pdf.worker.min.js';
        status.textContent = '渲染中…';
        try {
          const r = await invoke('fs:read-file-b64', pdfPath);
          const bytes = Uint8Array.from(atob(r.b64), c => c.charCodeAt(0));
          const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
          const outDir = pdfPath.replace(/\.pdf$/i, '') + '-images';
          await invoke('fs:mkdir', outDir);
          const scale = parseFloat(scaleIn.value) || 2;
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width; canvas.height = viewport.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            const b64 = canvas.toDataURL('image/png').split(',')[1];
            await invoke('fs:write-file-b64', `${outDir}/page-${String(i).padStart(3, '0')}.png`, b64);
            status.textContent = `渲染中… ${i}/${pdf.numPages}`;
          }
          status.innerHTML = `<span class="status-ok">✓ 完成</span> 共 ${pdf.numPages} 页，输出目录 ${escapeHtml(outDir)}`;
          toast('PDF 转图片完成', 'success');
        } catch (e) { status.textContent = '✗ ' + e.message; }
      }
      page.appendChild(div('card', div('card-title', '选择 PDF'), dz, info,
        div('form-row', h('span', { class: 'form-label' }, '清晰度'), scaleIn, h('span', { class: 'field-hint' }, '倍渲染（2 = 约 192dpi）'),
          btn('🖼 开始转换', 'btn-primary', render), status)));
      page.appendChild(list);
    }
  });

  /* ---------- 文档预览 ---------- */
  register({
    id: 'doc-preview', name: '文档预览', module: MOD, icon: 'book',
    desc: 'PDF / TXT / Markdown 直接预览；Office 文档经 LibreOffice 转 PDF 后预览',
    keywords: ['预览', 'preview', 'pdf', 'word', 'excel', '查看'],
    render(page) {
      let filePath = '';
      const label = h('span', { class: 'field-hint' }, '未选择');
      const dz = dropzone({ text: '拖入或选择文档（pdf / txt / md / doc(x) / xls(x) / ppt(x)）', onFiles: (p) => { filePath = p[0]; label.textContent = filePath; } });
      const status = h('span', { class: 'field-hint' }, '');
      const view = div('doc-preview-box', { style: { maxHeight: '70vh', overflow: 'auto', padding: '8px', background: 'var(--bg-2)', borderRadius: '8px', marginTop: '8px' } });
      async function preview() {
        if (!filePath) return toast('请先选择文档', 'warn');
        view.innerHTML = '';
        const ext = filePath.split('.').pop().toLowerCase();
        try {
          if (ext === 'pdf') return await renderPdf(filePath);
          if (ext === 'txt' || ext === 'md' || ext === 'markdown') return await renderText(filePath, ext !== 'txt');
          if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf'].includes(ext)) {
            const st = await invoke('office:status');
            if (!st.soffice) {
              status.textContent = 'Office 文档预览需要 LibreOffice（PDF/TXT/MD 可直接预览）';
              toast('未检测到 LibreOffice，无法预览 Office 文档', 'warn');
              return;
            }
            status.textContent = '经 LibreOffice 转换中…（首次较慢）';
            const tmpDir = (await invoke('app:get-info')).userData + '/preview-tmp';
            const r = await invoke('office:convert', { files: [filePath], target: 'pdf', outDir: tmpDir });
            const res = r.results && r.results[0];
            if (!res || !res.ok) throw new Error('转换失败：' + ((res && res.err) || '未知'));
            status.textContent = '转换完成，渲染中…';
            return await renderPdf(res.out);
          }
          toast('不支持的格式：' + ext, 'warn');
        } catch (e) { status.textContent = '✗ ' + e.message; toast(e.message, 'error'); }
      }
      async function renderPdf(p) {
        if (!window.pdfjsLib) return toast('pdf.js 未加载', 'error');
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'node_modules/pdfjs-dist/build/pdf.worker.min.js';
        const r = await invoke('fs:read-file-b64', p);
        const bytes = Uint8Array.from(atob(r.b64), c => c.charCodeAt(0));
        const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
        const pages = Math.min(pdf.numPages, 20);
        for (let i = 1; i <= pages; i++) {
          const pg = await pdf.getPage(i);
          const vp = pg.getViewport({ scale: 1.4 });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width; canvas.height = vp.height;
          canvas.style.cssText = 'display:block;margin:0 auto 10px;box-shadow:0 1px 6px rgba(0,0,0,.25);background:#fff';
          await pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
          view.appendChild(canvas);
          status.textContent = `渲染 ${i}/${pages} 页`;
        }
        status.textContent = `✓ 共 ${pdf.numPages} 页${pdf.numPages > pages ? `（预览前 ${pages} 页）` : ''}`;
      }
      async function renderText(p, isMd) {
        const r = await invoke('fs:read-text', p);
        if (isMd && window.marked) {
          const box = div('md-view');
          box.innerHTML = window.DOMPurify ? DOMPurify.sanitize(window.marked.parse(r.content)) : window.marked.parse(r.content);
          box.style.cssText = 'max-width:800px;margin:0 auto;line-height:1.7';
          view.appendChild(box);
        } else {
          const pre = h('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '12px', margin: '0' } }, r.content);
          view.appendChild(pre);
        }
        status.textContent = `✓ ${(r.size / 1024).toFixed(1)} KB`;
      }
      page.appendChild(div('card', div('card-title', '文档'), dz, label,
        div('form-row', btn('👁 预览', 'btn-primary', preview), status)));
      page.appendChild(div('card', div('card-title', '预览'), view));
    }
  });

  /* ---------- 翻译工具 ---------- */
  register({
    id: 'translate', name: '翻译工具', module: MOD, icon: 'languages',
    desc: '整段互译（MyMemory 在线引擎，主动触发联网）',
    keywords: ['翻译', 'translate', '中英'],
    render(page) {
      const langs = [['zh', '中文'], ['en', '英语'], ['ja', '日语'], ['ko', '韩语'], ['fr', '法语'], ['de', '德语'], ['ru', '俄语'], ['es', '西班牙语']];
      const fromSel = h('select', { class: 'select input-sm' }, ...langs.map(([v, n]) => h('option', { value: v }, n)));
      const toSel = h('select', { class: 'select input-sm' }, ...langs.map(([v, n]) => h('option', { value: v, selected: v === 'en' }, n)));
      fromSel.value = 'zh';
      const ta = h('textarea', { class: 'pane-ta', placeholder: '输入要翻译的文本…', style: { minHeight: '140px' } });
      const out = h('textarea', { class: 'pane-ta readonly', readonly: true, style: { minHeight: '140px' } });
      async function go() {
        if (!ta.value.trim()) return;
        out.value = '翻译中…';
        try {
          const q = encodeURIComponent(ta.value.slice(0, 4500));
          const pair = `${fromSel.value}|${toSel.value}`;
          const resp = await fetch(`https://api.mymemory.translated.net/get?q=${q}&langpair=${pair}`);
          const j = await resp.json();
          if (j.responseData && j.responseData.translatedText) {
            out.value = j.responseData.translatedText.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
          } else out.value = '翻译失败：' + (j.responseDetails || '未知错误');
        } catch (e) { out.value = '翻译失败（需要联网）：' + e.message; }
      }
      page.appendChild(div('card', div('card-title', '原文'),
        div('form-row', h('span', { class: 'form-label' }, '语言'), fromSel, h('span', null, '→'), toSel,
          btn('🌐 翻译', 'btn-primary', go), h('span', { class: 'field-hint' }, '使用公共翻译引擎，点击时才联网')),
        ta));
      page.appendChild(div('card', div('card-title', '译文'), out, div('form-row', btn('复制', 'btn-sm btn-secondary', () => out.value && copyText(out.value)))));
    }
  });

  /* ---------- Word/Excel/PPT ↔ PDF（LibreOffice / Office COM 双引擎） ---------- */
  register({
    id: 'pdf-office-convert', name: 'Word/Excel ↔ PDF', module: MOD, icon: 'file-text',
    desc: 'Office 文档与 PDF 互转（LibreOffice 优先，未装则用 Microsoft Office）',
    keywords: ['word', 'excel', 'pdf', '转换', 'office'],
    render(page) {
      const files = [];
      const dz = dropzone({
        text: '拖入 Word / Excel / PPT / PDF 文件（可多选）',
        onFiles: (p) => {
          files.push(...p.filter(x => /\.(doc|docx|rtf|txt|xls|xlsx|csv|ppt|pptx|pdf)$/i.test(x)));
          label.textContent = `已选 ${files.length} 个文件`;
        }
      });
      const label = div('field-hint', '未选择');
      const targetSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'pdf' }, '转换为 PDF'),
        h('option', { value: 'docx' }, '转换为 DOCX（PDF→Word，需 Microsoft Word）'));
      const outDirIn = h('input', { class: 'input input-sm', placeholder: '输出目录（留空=源文件目录）', style: { flex: '1' } });
      const pickOutBtn = btn('选择…', 'btn-sm btn-secondary', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) outDirIn.value = d[0];
      });
      const engineEl = h('div', { class: 'field-hint' }, '');
      const listBox = div('');
      const status = h('div', { class: 'field-hint' }, '');
      invoke('office:status').then(r => {
        if (r.soffice) engineEl.innerHTML = '✓ 检测到 LibreOffice 引擎';
        else if (r.office) engineEl.innerHTML = '✓ 检测到 Microsoft Office 引擎（COM）';
        else engineEl.innerHTML = '<span class="status-warn">⚠ 未检测到 LibreOffice 或 Microsoft Office，请先安装其中之一</span>';
      }).catch(() => {});
      const startBtn = btn('🚀 开始转换', 'btn-primary', run);
      async function run() {
        if (!files.length) return toast('请先选择文件', 'warn');
        if (targetSel.value === 'docx' && files.some(f => !f.toLowerCase().endsWith('.pdf'))) return toast('转 DOCX 仅支持 PDF 来源（PDF→Word）', 'warn');
        startBtn.disabled = true; status.textContent = '转换中…';
        listBox.innerHTML = '';
        const outDir = outDirIn.value.trim() || files[0].replace(/[\\/][^\\/]*$/, '');
        try {
          const r = await invoke('office:convert', { files: [...files], target: targetSel.value, outDir });
          status.textContent = `完成（引擎：${r.engine}）：成功 ${r.results.filter(x => x.ok).length} / ${r.results.length}`;
          for (const res of r.results) {
            const row = div('form-row',
              h('span', { class: 'tag ' + (res.ok ? 'tag-green' : 'tag-red') }, res.ok ? '✓ 完成' : '✗ 失败'),
              h('span', { style: { flex: '1', fontSize: '12px', wordBreak: 'break-all' } }, res.input.split(/[\\/]/).pop()),
              h('span', { class: 'field-err', style: { fontSize: '11px', maxWidth: '260px' } }, res.err || ''),
              res.ok ? btn('打开', 'btn-sm btn-text', () => invoke('fs:show-item', res.out).catch(() => {})) : '');
            listBox.appendChild(row);
          }
          toast('转换完成', r.results.some(x => x.ok) ? 'success' : 'error');
        } catch (e) {
          status.innerHTML = `<span class="status-err">✗ ${escapeHtml(e.message)}</span>`;
          toast(e.message, 'error');
        } finally { startBtn.disabled = false; }
      }
      page.appendChild(div('card', div('card-title', '选择文件'), dz, label, engineEl));
      page.appendChild(div('card', div('card-title', '转换'),
        div('form-row', h('span', { class: 'form-label' }, '目标格式'), targetSel),
        div('form-row', h('span', { class: 'form-label' }, '输出'), outDirIn, pickOutBtn),
        div('form-row', startBtn, status),
        div('field-hint', '支持 doc/docx/rtf/xls/xlsx/csv/ppt/pptx → PDF；PDF → DOCX（需 Microsoft Word，Word 会自动解析 PDF 排版）。'),
        listBox));
    }
  });
})();
