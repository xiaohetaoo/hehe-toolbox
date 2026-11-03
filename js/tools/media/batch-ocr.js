/* 模块：多媒体处理 —— batch-ocr（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, progressEl } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';

register({
    id: 'batch-ocr', name: '批量图片 OCR', module: MOD, icon: 'eye',
    desc: '整个文件夹的图片逐张识别文字，汇总导出为文本（本地引擎）',
    keywords: ['批量', 'ocr', '识别', '文件夹'],
    render(page) {
      let dir = '';
      const langSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'chi_sim+eng' }, '中文+英文'), h('option', { value: 'chi_sim' }, '仅中文'), h('option', { value: 'eng' }, '仅英文'));
      const dirLabel = h('span', { class: 'field-hint' }, '未选择');
      const pickBtn = btn('选择文件夹…', 'btn-secondary', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) { dir = d[0]; dirLabel.textContent = dir; }
      });
      const prog = progressEl(); prog.hide();
      const status = h('span', { class: 'field-hint' }, '');
      const out = h('textarea', { class: 'pane-ta', placeholder: '识别结果（文件名 + 内容）…', style: { minHeight: '220px' } });
      const saveBtn = btn('导出 TXT', 'btn-sm btn-secondary', async () => {
        if (!out.value) return toast('还没有识别结果，请先点「开始批量识别」', 'warn');
        const p = await invoke('dialog:save', { defaultPath: 'ocr-result.txt' });
        if (!p) return;
        await invoke('fs:write-text', p, out.value);
        toast('已导出：' + p, 'success');
      });
      let running = false;
      async function run() {
        if (!dir) return toast('请先选择文件夹', 'warn');
        if (!window.Tesseract) return toast('OCR 引擎未加载，请重启应用', 'error');
        if (running) return;
        running = true; prog.show(); out.value = '';
        try {
          const items = await invoke('fs:list', dir);
          const imgs = items.filter(x => /\.(png|jpe?g|bmp|webp)$/i.test(x.name || x));
          if (!imgs.length) { running = false; toast('该文件夹没有图片', 'warn'); return; }
          let done = 0;
          for (const it of imgs) {
            const name = it.name || it;
            const p = (dir.replace(/[\\/]+$/, '')) + '/' + name;
            status.textContent = `识别中 ${done + 1}/${imgs.length}：` + name;
            try {
              const r = await invoke('fs:read-file-b64', p);
              const res = await window.Tesseract.recognize('data:image;base64,' + r.b64, langSel.value, {
                workerPath: 'node_modules/tesseract.js/dist/worker.min.js', corePath: 'node_modules/tesseract.js-core'
              });
              out.value += `===== ${name} =====\n${(res.data.text || '').trim()}\n\n`;
            } catch (e) { out.value += `===== ${name} =====\n（识别失败：${e.message}）\n\n`; }
            done++; prog.set(done / imgs.length * 100);
          }
          status.textContent = `完成：${imgs.length} 张`;
          toast('批量识别完成', 'success');
        } catch (e) { status.textContent = '✗ ' + e.message; toast(e.message, 'error'); }
        finally { running = false; prog.hide(); }
      }
      page.appendChild(div('card', div('card-title', '图片文件夹'), div('form-row', pickBtn, dirLabel, langSel)));
      page.appendChild(div('card', div('card-title', '识别'),
        div('form-row', btn('开始批量识别', 'btn-primary', run, 'search'), prog.el, status),
        out, div('form-row', saveBtn)));
    }
  })
})();
