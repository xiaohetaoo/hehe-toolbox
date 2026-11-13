/* 模块：多媒体处理 —— screenshot-ocr（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, copyText, filePicker, progressEl } = window.ui;
  const { invoke } = window.api;
  /* OCR 的超时与失败归因（lib/ocr-guard.js，UMD 挂到 window） */
  const OcrGuard = window.OcrGuard;
  const MOD = 'media';

register({
    id: 'screenshot-ocr', name: '截图 OCR 文字识别', nameEn: 'Screenshot OCR', module: MOD, icon: 'eye',
    desc: '粘贴截图或选择图片，本地识别中英文文字（首次需下载语言包）', descEn: 'Paste a screenshot or pick an image and read the text locally',
    keywords: ['ocr', '识别', '截图', '文字'],
    render(page) {
      const langSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'chi_sim+eng' }, '中文（简体）+ 英文'),
        h('option', { value: 'chi_sim' }, '仅中文（简体）'),
        h('option', { value: 'eng' }, '仅英文'));
      const preview = h('div', { style: { minHeight: '100px', display: 'flex', justifyContent: 'center' } });
      const status = h('div', { class: 'field-hint' }, '');
      const prog = progressEl(); prog.hide();
      const result = h('textarea', { class: 'pane-ta', placeholder: '识别结果将显示在这里，可直接编辑…', style: { minHeight: '180px' } });
      let currentImg = null;
      /* 两条来源要分清，否则会无限递归：
       *   ① 用户拖入/选择文件 -> picker.onChange -> handleFile 加载图片
       *   ② 剪贴板/贴图/OCR 直达 -> fromBlob -> showInList 只登记条目
       * selfUpdating 标记「这次列表变化是我自己登记的」，不再触发加载。 */
      let selfUpdating = false;
      function showInList(pathOrName, virtual) {
        selfUpdating = true;
        try {
          picker.clear();
          picker.list.add([{ path: pathOrName, name: pathOrName, virtual: !!virtual }]);
        } finally { selfUpdating = false; }
      }
      // 截图标注/托盘 OCR 直达：带图打开本工具
      if (window.__ocrPendingPath) {
        const p = window.__ocrPendingPath;
        window.__ocrPendingPath = null;
        setTimeout(() => handleFile(p).catch(() => {}), 200);
      }
      /* 【OCR 必须带超时 —— 否则失败时界面永久停在"初始化…"】
       * tesseract.js 的 recognize 返回的 promise 在某些失败路径上**永不 settle**：
       *   · wasm 编译被 CSP 拒绝（抛出发生在 blob worker 内部，不一定回传）
       *   · 语言包下载被网络/安全软件拦在半路
       * 实测：CSP 不允许 wasm 时，recognize 20 秒内既不 resolve 也不 reject，
       * 进度条不动、状态行停在「初始化 OCR 引擎…」，用户只能干等 ——
       * 他看到的是"很慢"，不是"坏了"，所以不会想到去报告。
       * 超时逻辑与归因文案在 lib/ocr-guard.js（两个 OCR 工具共用一份）。 */
      const OCR_TIMEOUT_MS = OcrGuard.DEFAULT_TIMEOUT_MS;
      async function recognize() {
        if (!currentImg) return toast('请先提供图片', 'warn');
        if (!window.Tesseract) return toast('OCR 引擎未加载，请重启应用', 'error');
        result.value = ''; prog.show();
        status.textContent = '初始化 OCR 引擎（首次识别需下载语言包，请耐心等待）…';
        try {
          const r = await OcrGuard.withTimeout(
            window.Tesseract.recognize(currentImg, langSel.value, {
              workerPath: 'node_modules/tesseract.js/dist/worker.min.js',
              corePath: 'node_modules/tesseract.js-core',
              logger: (m) => {
                if (m.progress != null) {
                  status.textContent = (m.status || '处理中') + ' ' + (m.progress * 100).toFixed(0) + '%';
                  prog.set(m.progress * 100);
                }
              }
            }),
            OCR_TIMEOUT_MS
          );
          result.value = (r.data.text || '').trim();
          status.textContent = `✓ 识别完成（置信度 ${(r.data.confidence || 0).toFixed(0)}%）`;
          prog.hide();
          toast('识别完成', 'success');
        } catch (e) {
          prog.hide();
          /* 按错误类型给可操作的说明，而不是把原始报错甩给用户：
           * 最常见的是引擎起不来（wasm/语言包），那时"再试一次"没用，
           * 得告诉他是哪一环断的。 */
          const reason = OcrGuard.failReason(e);
          status.innerHTML = `<span class="status-err">✗ ${escapeHtml(reason)}</span>`;
          toast('识别失败：' + reason, 'error');
        }
      }
      /* objectURL 收口：img 挂的是 URL，blob 几 MB 时（全屏截图）
       * 不释放就是持续占用。进函数先释放上一次的。 */
      let lastObjUrl = null;
      const dropLastUrl = () => { if (lastObjUrl) { URL.revokeObjectURL(lastObjUrl); lastObjUrl = null; } };
      async function fromBlob(blob, label) {
        currentImg = blob;
        preview.innerHTML = '';
        dropLastUrl();
        lastObjUrl = URL.createObjectURL(blob);
        preview.appendChild(h('img', { src: lastObjUrl, style: { maxWidth: '100%', maxHeight: '240px', borderRadius: '8px' } }));
        showInList(label || '剪贴板图片', true);
      }
      async function handleFile(pathArg, blob) {
        if (blob) return fromBlob(blob);
        const r = await invoke(Channels.CHANNELS.FS.READ_FILE_B64, pathArg);
        const bin = Uint8Array.from(atob(r.b64), c => c.charCodeAt(0));
        const type = pathArg.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        await fromBlob(new Blob([bin], { type }), pathArg);
      }
      const picker = filePicker({
        text: '拖入或选择图片（PNG/JPG）',
        single: true,
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }],
        onBlob: (file) => fromBlob(file),
        onChange: (items) => {
          // 单文件槽位：列表里最多一项，换图时 preview 跟着换
          if (selfUpdating) return; // 自己登记的条目（剪贴板/贴图），图片已经加载好了
          if (!items.length) { currentImg = null; preview.innerHTML = ''; dropLastUrl(); return; }
          const it = items[0];
          if (it.virtual) return; // 虚拟条目没有磁盘路径，图片也已就位
          handleFile(it.path).catch((e) => toast(e.message, 'error'));
        }
      });
      /* 把当前图片登记到列表里：磁盘文件按真实路径登记，剪贴板图片登记成虚拟条目， */
      /* 让两种来源在界面上看起来完全一样，也都能点「×」移除。 */
      page.addEventListener('paste', async (e) => {
        const items = [...((e.clipboardData || {}).items || [])];
        const imgItem = items.find(i => i.type.startsWith('image/'));
        if (imgItem) { await fromBlob(imgItem.getAsFile(), '剪贴板图片'); toast('已读取剪贴板截图', 'success', 1200); }
      });
      const pasteBtn = btn('粘贴截图（Win+Shift+S 后点这里）', 'btn-secondary', async () => {
        try {
          const imgData = await invoke(Channels.CHANNELS.CLIP.READ_IMAGE);
          if (!imgData) return toast('剪贴板中没有图片', 'warn');
          const bin = Uint8Array.from(atob(imgData.split(',')[1]), c => c.charCodeAt(0));
          await fromBlob(new Blob([bin], { type: 'image/png' }), '剪贴板图片');
        } catch (e) { toast(e.message, 'error'); }
      }, 'clipboard');
      page.appendChild(div('card', div('card-title', '图片'),
        div('form-row', pasteBtn, ' ', h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '语言'), langSel),
        picker.el, preview));
      page.appendChild(div('card', div('card-title', '识别'),
        div('form-row', btn('开始识别', 'btn-primary', recognize, 'search'), prog.el, status),
        result,
        div('form-row', btn('复制结果', 'btn-sm btn-secondary', () => result.value && copyText(result.value)))));
    }
  })
})();
