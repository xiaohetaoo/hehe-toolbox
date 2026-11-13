/* 模块：多媒体处理 —— batch-ocr（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, progressEl } = window.ui;
  const { invoke } = window.api;
  /* OCR 的超时与失败归因（lib/ocr-guard.js，UMD 挂到 window） */
  const OcrGuard = window.OcrGuard;
  const MOD = 'media';

register({
    id: 'batch-ocr', name: '批量图片 OCR', nameEn: 'Batch Image OCR', module: MOD, icon: 'eye',
    desc: '整个文件夹的图片逐张识别文字，汇总导出为文本（本地引擎）', descEn: 'Run OCR over every image in a folder and export the text in one file (local engine)',
    keywords: ['批量', 'ocr', '识别', '文件夹'],
    render(page) {
      let dir = '';
      const langSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'chi_sim+eng' }, '中文+英文'), h('option', { value: 'chi_sim' }, '仅中文'), h('option', { value: 'eng' }, '仅英文'));
      const dirLabel = h('span', { class: 'field-hint' }, '未选择');
      const pickBtn = btn('选择文件夹…', 'btn-secondary', async () => {
        const d = await invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: ['openDirectory'] });
        if (d && d[0]) { dir = d[0]; dirLabel.textContent = dir; }
      });
      const prog = progressEl(); prog.hide();
      const status = h('span', { class: 'field-hint' }, '');
      const out = h('textarea', { class: 'pane-ta', placeholder: '识别结果（文件名 + 内容）…', style: { minHeight: '220px' } });
      const saveBtn = btn('导出 TXT', 'btn-sm btn-secondary', async () => {
        if (!out.value) return toast('还没有识别结果，请先点「开始批量识别」', 'warn');
        const p = await invoke(Channels.CHANNELS.DIALOG.SAVE, { defaultPath: 'ocr-result.txt' });
        if (!p) return;
        await invoke(Channels.CHANNELS.FS.WRITE_TEXT, p, out.value);
        toast('已导出：' + p, 'success');
      });
      /* 【防重入，并且要说清楚「上一轮还活着」】
       * 原来是一个裸 `if (running) return;` —— 用户点了没反应、也没有任何提示，
       * 只能猜是不是卡了。
       * 更要紧的是：超时**不会**终止 tesseract 的 worker（该库没有中止接口），
       * 只是把控制权还给用户。于是每张超时的图都留下一个后台 worker，
       * 20 张全超时就是 20 个僵尸。允许并发再起一轮会让这个问题翻倍。
       * 所以这里挡下来，并明确告诉用户为什么 ——
       * 不能只说「已在运行中」，那看不出「上一次可能还在后台耗着」。 */
      let running = false;
      let cancelFlag = false;
      const ocrRunBtn = btn('开始批量识别', 'btn-primary', run, 'search');
      const ocrStopBtn = btn('停止', 'btn-danger-plain', () => { cancelFlag = true; ocrStopBtn.disabled = true; }, 'square');
      ocrStopBtn.disabled = true;
      async function run() {
        if (!dir) return toast('请先选择文件夹', 'warn');
        if (!window.Tesseract) return toast('OCR 引擎未加载，请重启应用', 'error');
        if (running) {
          status.textContent = '上一次识别仍在进行，请等它结束（或等单张超时）';
          toast('上一次识别仍在后台，请稍候', 'warn');
          return;
        }
        cancelFlag = false;
        running = true; prog.show(); out.value = '';
        try {
          const items = await invoke(Channels.CHANNELS.FS.LIST, dir);
          const imgs = items.filter(x => /\.(png|jpe?g|bmp|webp)$/i.test(x.name || x));
          if (!imgs.length) { running = false; toast('该文件夹没有图片', 'warn'); return; }
          let done = 0;
          for (const it of imgs) {
            if (cancelFlag) break;   // 用户点了停止
            const name = it.name || it;
            const p = (dir.replace(/[\\/]+$/, '')) + '/' + name;
            status.textContent = `识别中 ${done + 1}/${imgs.length}：` + name;
            try {
              const r = await invoke(Channels.CHANNELS.FS.READ_FILE_B64, p);
              /* 【单张也要超时】批量场景下"卡住"更致命：一张图永挂，
               * 整个循环停在它上面，用户看到的是"识别中 3/20"再也不动，
               * 而且没有任何错误提示。超时后按单张失败记，继续下一张 ——
               * 宁可跳过一张，不要让整批停死。
               * 超时值取单张的默认值：批量的慢是"张数多"，不是"单张慢"。 */
              const res = await OcrGuard.withTimeout(
                window.Tesseract.recognize('data:image;base64,' + r.b64, langSel.value, {
                  workerPath: 'node_modules/tesseract.js/dist/worker.min.js', corePath: 'node_modules/tesseract.js-core'
                }),
                OcrGuard.DEFAULT_TIMEOUT_MS
              );
              out.value += `===== ${name} =====\n${(res.data.text || '').trim()}\n\n`;
            } catch (e) {
              /* 失败原因走同一套归因，批量导出的文本里也要能看懂为什么失败。 */
              out.value += `===== ${name} =====\n（识别失败：${OcrGuard.failReason(e)}）\n\n`;
            }
            done++; prog.set(done / imgs.length * 100);
          }
          status.textContent = `完成：${imgs.length} 张`;
          toast('批量识别完成', 'success');
        } catch (e) { status.textContent = '✗ ' + e.message; toast(e.message, 'error'); }
        finally { running = false; prog.hide(); ocrStopBtn.disabled = true; }
      }
      page.appendChild(div('card', div('card-title', '图片文件夹'), div('form-row', pickBtn, dirLabel, langSel)));
      page.appendChild(div('card', div('card-title', '识别'),
        div('form-row', ocrRunBtn, ocrStopBtn, prog.el, status),
        out, div('form-row', saveBtn)));
    }
  })
})();
