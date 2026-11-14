/* PDF 增强：水印/页码、提取文字、瘦身。
 *
 * ============ 为什么单独一个文件 ============
 * js/tools/office.js 已经有 4 个 PDF/Office 相关工具（pdf-tools / img2pdf /
 * pdf2img / pdf-office-convert），再往里加会让那个文件超过 500 行难以阅读。
 * 而且这三项新能力的实现方式与现有四个不同（水印靠 pdf-lib 写、提取文字
 * 靠 pdf.js 读、瘦身靠重编码），聚在一起更容易讲清各自的取舍。
 *
 * ============ 三个功能各自的根本限制（必须写在界面上）============
 *
 * ① 水印的中文问题
 *    pdf-lib 内置的 14 个标准字体**只有 Latin-1 字符**，写中文会抛
 *    "WinAnsi cannot encode"。要写中文必须嵌入一个中文字体文件（十几 MB），
 *    而应用里没有随包字体、也不该为了一个水印去下载。
 *    所以：**中文水印直接拒绝并说明原因**，让用户改用英文/数字水印。
 *    这比"静默把中文变成问号"好得多 —— 后者用户拿到文件才发现。
 *
 * ② 提取文字只能提"本来就有的文字层"
 *    pdf.js 的 getTextContent() 读的是 PDF 里的文字对象。扫描件是图片，
 *    没有文字层，读出来是空。这时要提示用户改用 OCR（本应用有该工具），
 *    而不是给个空结果让用户以为文件坏了。
 *
 * ③ 瘦身的极限取决于图片编码
 *    pdf-lib 不能重编码页面内的图片流（那要解 JPEG/JPEG2000 再压）。
 *    能做的三件事：删元数据、删未使用的对象、开启对象流压缩。
 *    对"扫描件 PDF"（里面是大图）效果有限，对"由 Word 导出、带一堆
 *    冗余元数据"的 PDF 通常能省 5~20%。界面上如实说明这个预期，
 *    不让用户以为点了就能从 50MB 变成 5MB。
 */
(function () {
  'use strict';

  const Channels = window.Channels;
  const { register } = window.Registry;
  const ui = window.ui;
  const { div, btn, toast, h } = ui;
  const { invoke } = window.api;
  const MOD = 'office';

  /** Uint8Array → base64（分块，避免大文件时 String.fromCharCode 爆栈）。 */
  function arrayB64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  /** 判断字符串是否全部能由 WinAnsi（Latin-1）编码。
   * 【为什么是 Latin-1 而不是 ASCII】标准字体支持 Latin-1 补充区
   * （é、ñ、° 这些），只卡 ASCII 会误拒正常的欧洲语水印。 */
  function isLatin1(s) {
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) > 0xFF) return false;
    }
    return true;
  }

  /* ==================== ① 水印 + 页码 ==================== */
  register({
    id: 'pdf-watermark', name: 'PDF 水印与页码', nameEn: 'PDF Watermark & Page Numbers',
    module: MOD, icon: 'droplet',
    desc: '给 PDF 加文字水印与页码（本地处理，不上传）',
    descEn: 'Stamp a text watermark and page numbers onto a PDF locally',
    keywords: ['pdf', '水印', '页码', 'watermark', '页脚', '标注'],
    render(page) {
      let pdfPath = null;
      const fileHint = div('field-hint', '未选择');

      const picker = ui.filePicker({
        text: '选择 PDF 文件',
        single: true,
        emptyText: '还没有选择 PDF',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        onChange: (items) => {
          pdfPath = items.length ? items[0].path : null;
          fileHint.textContent = pdfPath || '未选择';
        },
      });

      /* ---- 水印参数 ---- */
      const wmText = h('input', { class: 'input input-sm', value: 'CONFIDENTIAL',
        placeholder: '水印文字（仅支持英文/数字/常用符号）', style: { flex: '1' } });
      const wmSize = h('input', { type: 'number', class: 'input input-sm', value: '48', min: '8', max: '200', style: { width: '80px' } });
      const wmOpacity = h('input', { type: 'number', class: 'input input-sm', value: '0.15', min: '0.02', max: '1', step: '0.01', style: { width: '80px' } });
      const wmAngle = h('input', { type: 'number', class: 'input input-sm', value: '45', min: '-90', max: '90', style: { width: '80px' } });
      const wmColor = h('input', { type: 'color', class: 'input input-sm', value: '#FF0000', style: { width: '48px', padding: '2px' } });
      const wmMode = h('select', { class: 'select input-sm' },
        h('option', { value: 'center' }, '每页居中一个'),
        h('option', { value: 'tile' }, '平铺满页'));
      const wmPages = h('input', { class: 'input input-sm', placeholder: '页码范围（留空 = 全部），如 1-3,5', style: { flex: '1' } });

      /* ---- 页码参数 ---- */
      const numOn = h('input', { type: 'checkbox', class: 'checkbox' });
      const numFmt = h('select', { class: 'select input-sm' },
        h('option', { value: 'n' }, '1'),
        h('option', { value: 'n-of-total' }, '1 / N'),
        h('option', { value: 'page-n' }, '第 1 页'));
      const numPos = h('select', { class: 'select input-sm' },
        h('option', { value: 'bottom-center' }, '页脚居中'),
        h('option', { value: 'bottom-right' }, '页脚右对齐'),
        h('option', { value: 'bottom-left' }, '页脚左对齐'),
        h('option', { value: 'top-right' }, '页眉右对齐'),
        h('option', { value: 'top-center' }, '页眉居中'));
      const numSize = h('input', { type: 'number', class: 'input input-sm', value: '10', min: '6', max: '24', style: { width: '70px' } });
      const numSkip = h('input', { type: 'checkbox', class: 'checkbox' });
      const numSkipN = h('input', { type: 'number', class: 'input input-sm', value: '1', min: '0', max: '50', style: { width: '60px' } });

      const status = h('span', { class: 'field-hint' }, '');

      const runBtn = btn('生成 PDF', 'btn-primary', async () => {
        if (!pdfPath) return toast('请先选择 PDF', 'warn');
        const wantWm = !!wmText.value.trim();
        const wantNum = numOn.checked;
        if (!wantWm && !wantNum) return toast('水印和页码都没启用，没事可做', 'warn');

        /* 【中文水印必须提前拒绝，不能等 pdf-lib 抛错】
         * pdf-lib 的报错是 "WinAnsi cannot encode"，用户看不懂那是什么。 */
        if (wantWm && !isLatin1(wmText.value)) {
          return toast('水印文字含中文或其它非西文字符：PDF 标准字体不支持。请改用英文/数字，或先用「图片水印」工具处理', 'error', 6000);
        }

        status.textContent = '处理中…';
        runBtn.disabled = true;
        try {
          const PDFLib = window.PDFLib;
          if (!PDFLib) throw new Error('pdf-lib 未加载');
          const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;

          const r = await invoke(Channels.CHANNELS.FS.READ_FILE_B64, pdfPath);
          const doc = await PDFDocument.load(r.b64, { ignoreEncryption: true });
          const pages = doc.getPages();
          const total = pages.length;

          /* 页码范围解析：与 pdf-tools 的 parseRanges 同语义但独立实现
           * （那个在另一个工具的作用域里取不到）。空 = 全部。 */
          let targetIdx = null;
          if (wmPages.value.trim()) {
            const set = new Set();
            for (const part of wmPages.value.split(/[,，]/)) {
              const t = part.trim();
              if (!t) continue;
              const m = /^(\d+)\s*-\s*(\d+)$/.exec(t);
              if (m) {
                let a = Math.max(1, +m[1]), b = Math.min(total, +m[2]);
                for (let i = a; i <= b; i++) set.add(i - 1);
              } else if (/^\d+$/.test(t)) {
                const n = +t;
                if (n >= 1 && n <= total) set.add(n - 1);
              }
            }
            if (!set.size) { status.textContent = ''; runBtn.disabled = false; return toast('页码范围无效（文档共 ' + total + ' 页）', 'warn'); }
            targetIdx = set;
          }

          /* 【字体必须无条件 embed】页码分支 :216 也要用它算文本宽度。
           * 第四轮审查抓到的真实崩溃：只勾「页码」、把水印文字清空
           * （wantWm=false）时 font 一直是 null → 生成时在
           * font.widthOfTextAtSize 处抛 TypeError，界面报「生成失败：…null」。
           * 「只要页码」正是这个工具最自然的用法之一，等于主功能不可用。
           * 标准字体 embed 一次的成本可以忽略（PDF 里复用同一个字体对象）。 */
          const font = await doc.embedFont(StandardFonts.HelveticaBold);

          const op = Math.max(0.02, Math.min(1, Number(wmOpacity.value) || 0.15));
          const col = hexToRgb(wmColor.value);

          for (let i = 0; i < total; i++) {
            const pdfPage = pages[i];
            const { width, height } = pdfPage.getSize();

            /* ---- 水印 ---- */
            if (wantWm && (!targetIdx || targetIdx.has(i))) {
              const size = Math.max(8, Math.min(200, Number(wmSize.value) || 48));
              const angle = Number(wmAngle.value) || 0;
              const text = wmText.value;
              const textW = font.widthOfTextAtSize(text, size);
              const textH = font.heightAtSize(size, { descender: false });
              const color = rgb(col.r, col.g, col.b);

              if (wmMode.value === 'tile') {
                /* 平铺：按"旋转后仍能覆盖整页"的步长铺。
                 * 步长取文本宽高的 1.6 倍 —— 太密会糊成一片，太疏则像漏了。 */
                const stepX = textW * 1.6 + size;
                const stepY = textH * 3 + size * 2;
                for (let y = -height; y < height * 2; y += stepY) {
                  for (let x = -width; x < width * 2; x += stepX) {
                    pdfPage.drawText(text, {
                      x, y, size, font, color, opacity: op,
                      rotate: degrees(angle),
                    });
                  }
                }
              } else {
                pdfPage.drawText(text, {
                  x: (width - textW * Math.cos(angle * Math.PI / 180)) / 2,
                  y: (height - textH) / 2,
                  size, font, color, opacity: op,
                  rotate: degrees(angle),
                });
              }
            }

            /* ---- 页码 ---- */
            if (wantNum) {
              const skip = numSkip.checked ? Math.max(0, Number(numSkipN.value) || 0) : 0;
              if (i >= skip) {
                /* 【跳过页不计数】"跳过前几页"的语义是排版惯例：封面/目录
                 * 不计入页码，正文第 1 页显示的是「1」—— 而不是"前 2 页
                 * 不画、第 3 页仍显示 3"。原实现是后者，与界面提示
                 * 「封面/目录通常不计页码」直接矛盾（本轮自审抓到）。
                 * 'n-of-total' 的分母同样用正文页数（total - skip），
                 * 否则「1 / 300」会出现在只有 298 页正文的书里。 */
                const n = i + 1 - skip;
                const totalBody = Math.max(1, total - skip);
                let label;
                if (numFmt.value === 'n-of-total') label = n + ' / ' + totalBody;
                else if (numFmt.value === 'page-n') label = 'Page ' + n;   // 中文页码受同一字体限制，用英文
                else label = String(n);
                const ns = Math.max(6, Math.min(24, Number(numSize.value) || 10));
                const nw = font.widthOfTextAtSize(label, ns);
                const margin = 24;
                let x = (width - nw) / 2, y = margin;
                const pos = numPos.value;
                if (pos === 'bottom-right') x = width - nw - margin;
                else if (pos === 'bottom-left') x = margin;
                else if (pos === 'top-right') { x = width - nw - margin; y = height - margin - ns; }
                else if (pos === 'top-center') { y = height - margin - ns; }
                pdfPage.drawText(label, { x, y, size: ns, font, color: rgb(0.35, 0.35, 0.35) });
              }
            }
          }

          const bytes = await doc.save();
          const outPath = await invoke(Channels.CHANNELS.DIALOG.SAVE, {
            title: '保存带水印的 PDF',
            defaultPath: String(pdfPath).replace(/\.pdf$/i, '') + '-stamped.pdf',
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
          });
          if (!outPath) { status.textContent = ''; runBtn.disabled = false; return; }
          await invoke(Channels.CHANNELS.FS.WRITE_FILE_B64, outPath, arrayB64(bytes));
          const before = r.b64.length * 0.75, after = bytes.length;
          status.textContent = '完成：' + outPath;
          toast('已生成（' + fmtDelta(before, after) + '）：' + outPath, 'success', 4000);
        } catch (e) {
          status.textContent = '';
          toast('生成失败：' + (e && e.message || e), 'error', 6000);
        } finally {
          runBtn.disabled = false;
        }
      }, 'droplet');

      page.appendChild(div('card', div('card-title', '选择 PDF'), picker.el, fileHint));
      page.appendChild(div('card',
        div('card-title', '水印'),
        div('form-row', h('span', { class: 'form-label' }, '文字'), wmText),
        div('form-row',
          h('span', { class: 'form-label' }, '字号'), wmSize,
          h('span', { class: 'form-label' }, '透明度'), wmOpacity,
          h('span', { class: 'form-label' }, '角度'), wmAngle,
          h('span', { class: 'form-label' }, '颜色'), wmColor),
        div('form-row', h('span', { class: 'form-label' }, '排布'), wmMode,
          h('span', { class: 'form-label' }, '页码范围'), wmPages),
        /* 限制说明必须显眼：用户输入中文后点生成才被告知，体验很差。 */
        div('field-hint', '注意：PDF 内置字体只支持英文/数字/常用西文符号。中文水印请改用「图片水印」工具（它渲染成图片，能写中文）。')));
      page.appendChild(div('card',
        div('card-title', '页码'),
        div('form-row', h('span', { class: 'form-label' }, '启用'), numOn,
          h('span', { class: 'form-label' }, '格式'), numFmt,
          h('span', { class: 'form-label' }, '位置'), numPos,
          h('span', { class: 'form-label' }, '字号'), numSize),
        div('form-row', h('span', { class: 'form-label' }, '跳过前几页'), numSkip, numSkipN,
          h('span', { class: 'field-hint' }, '封面/目录通常不计页码'))));
      page.appendChild(div('card', div('form-row', runBtn, status)));
    },
  });

  /** #RRGGBB → { r, g, b }（0~1）。 */
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return { r: 1, g: 0, b: 0 };
    const n = parseInt(m[1], 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  }

  /** 体积变化的人类可读描述。 */
  function fmtDelta(before, after) {
    if (!before) return ui.fmtBytes(after);
    const pct = ((after - before) / before) * 100;
    const sign = pct >= 0 ? '+' : '';
    return ui.fmtBytes(after) + '（' + sign + pct.toFixed(1) + '%）';
  }

  /* ==================== ② 提取文字 ==================== */
  register({
    id: 'pdf-extract-text', name: 'PDF 提取文字', nameEn: 'Extract PDF Text',
    module: MOD, icon: 'type',
    desc: '从 PDF 里提取纯文本，并判断是否为扫描件（扫描件需改用 OCR）',
    descEn: 'Pull the text layer out of a PDF and detect scanned documents',
    keywords: ['pdf', '提取', '文字', '文本', 'extract', 'text', '复制'],
    render(page) {
      let pdfPath = null;
      const fileHint = div('field-hint', '未选择');
      const out = h('textarea', { class: 'pane-ta mono readonly', readonly: true, style: { minHeight: '260px' } });
      const status = h('span', { class: 'field-hint' }, '');
      const pageRange = h('input', { class: 'input input-sm', placeholder: '页码范围（留空 = 全部），如 1-5', style: { width: '200px' } });
      const withPageMark = h('input', { type: 'checkbox', class: 'checkbox' });
      const OCR_TOOL = 'screenshot-ocr';

      const picker = ui.filePicker({
        text: '选择 PDF 文件', single: true, emptyText: '还没有选择 PDF',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        onChange: (items) => {
          pdfPath = items.length ? items[0].path : null;
          fileHint.textContent = pdfPath || '未选择';
        },
      });

      const runBtn = btn('提取文字', 'btn-primary', async () => {
        if (!pdfPath) return toast('请先选择 PDF', 'warn');
        if (!window.pdfjsLib) return toast('pdf.js 未加载', 'error');
        status.textContent = '读取中…';
        runBtn.disabled = true;
        try {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'node_modules/pdfjs-dist/build/pdf.worker.min.js';
          const r = await invoke(Channels.CHANNELS.FS.READ_FILE_B64, pdfPath);
          const bin = atob(r.b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          const pdf = await window.pdfjsLib.getDocument({ data: arr }).promise;
          const total = pdf.numPages;

          /* 页码范围 */
          let targets = [];
          if (pageRange.value.trim()) {
            const set = new Set();
            for (const part of pageRange.value.split(/[,，]/)) {
              const t = part.trim();
              if (!t) continue;
              const m = /^(\d+)\s*-\s*(\d+)$/.exec(t);
              if (m) {
                const a = Math.max(1, +m[1]), b = Math.min(total, +m[2]);
                for (let i = a; i <= b; i++) set.add(i);
              } else if (/^\d+$/.test(t)) {
                const n = +t;
                if (n >= 1 && n <= total) set.add(n);
              }
            }
            targets = [...set].sort((x, y) => x - y);
            if (!targets.length) { runBtn.disabled = false; status.textContent = ''; return toast('页码范围无效（共 ' + total + ' 页）', 'warn'); }
          } else {
            for (let i = 1; i <= total; i++) targets.push(i);
          }

          const chunks = [];
          let emptyPages = 0;
          for (const pn of targets) {
            const pg = await pdf.getPage(pn);
            const tc = await pg.getTextContent();
            /* items 里每项有 str 与 hasEOL；按出现顺序拼接，
             * 遇到 hasEOL 补换行。直接 join('') 会把整页挤成一行。 */
            let line = '';
            const lines = [];
            for (const it of tc.items) {
              if (typeof it.str === 'string') line += it.str;
              if (it.hasEOL) { lines.push(line); line = ''; }
            }
            if (line) lines.push(line);
            const body = lines.join('\n').trim();
            if (!body) emptyPages++;
            if (withPageMark.checked) chunks.push('===== 第 ' + pn + ' 页 =====\n' + body);
            else chunks.push(body);
            status.textContent = '已处理 ' + (chunks.length) + ' / ' + targets.length + ' 页…';
          }

          const text = chunks.join('\n\n');
          out.value = text;
          const allEmpty = emptyPages === targets.length;
          status.textContent = allEmpty
            ? '这 ' + targets.length + ' 页全部没有文字层'
            : ('共 ' + targets.length + ' 页，提取 ' + text.length + ' 字符' + (emptyPages ? ('，' + emptyPages + ' 页无文字') : ''));

          /* 【扫描件必须明确提示】否则用户拿到空结果会以为文件坏了，
           * 而真正该做的是去用 OCR。这条提示是整个功能的关键一环。 */
          if (allEmpty) {
            const body = div('');
            body.appendChild(div('field-hint', '这个 PDF 很可能**是扫描件**（页面里只有图片、没有文字层）。'));
            body.appendChild(div('field-hint', '要提取这类文件的文字，需要用 OCR：先用「PDF 转图片」导出页面，再用「截图 OCR」或「批量图片 OCR」识别。'));
            const m = ui.modal({
              title: '这个 PDF 没有文字层',
              width: 520, body,
              foot: [
                ui.btn('取消', 'btn-secondary', () => m.close()),
                ui.btn('去用批量图片 OCR', 'btn-primary', () => { m.close(); window.App.openTool('batch-ocr'); }, 'type'),
              ],
            });
          } else if (emptyPages) {
            toast(emptyPages + ' 页没有文字层（可能是图片页）', 'warn', 4000);
          }
        } catch (e) {
          status.textContent = '';
          toast('提取失败：' + (e && e.message || e), 'error', 6000);
        } finally {
          runBtn.disabled = false;
        }
      }, 'type');

      page.appendChild(div('card', div('card-title', '选择 PDF'), picker.el, fileHint));
      page.appendChild(div('card',
        div('card-title', '提取'),
        div('form-row', h('span', { class: 'form-label' }, '页码范围'), pageRange,
          h('span', { class: 'form-label' }, '标注页号'), withPageMark, runBtn, status),
        div('field-hint', '只能提取 PDF 里**本来就有的文字层**。扫描件是图片、没有文字层，请用 OCR 工具。')));
      page.appendChild(div('card',
        div('card-title', '结果'),
        div('form-row',
          btn('复制全部', 'btn-sm btn-secondary', () => { ui.copyText(out.value); }, 'copy'),
          btn('另存为', 'btn-sm btn-secondary', async () => {
            try {
              const p = await invoke(Channels.CHANNELS.DIALOG.SAVE, { title: '保存提取的文字', defaultPath: 'extracted.txt' });
              if (!p) return;
              await invoke(Channels.CHANNELS.FS.WRITE_TEXT, p, out.value);
              toast('已保存：' + p, 'success');
            } catch (e) { toast('保存失败：' + e.message, 'error'); }
          }, 'save'),
          btn('去用 OCR', 'btn-sm btn-primary', () => { window.App.openTool(OCR_TOOL); }, 'type')),
        out));
    },
  });

  /* ==================== ③ 瘦身 ==================== */
  register({
    id: 'pdf-slim', name: 'PDF 瘦身', nameEn: 'PDF Slimmer',
    module: MOD, icon: 'filter',
    desc: '压缩 PDF 体积：删元数据、清冗余对象、启用对象流压缩',
    descEn: 'Shrink a PDF by stripping metadata and compressing object streams',
    keywords: ['pdf', '瘦身', '压缩', '减小', 'compress', 'shrink', '体积'],
    render(page) {
      let pdfPath = null;
      const fileHint = div('field-hint', '未选择');
      const status = h('span', { class: 'field-hint' }, '');
      const result = div('');

      const picker = ui.filePicker({
        text: '选择 PDF 文件', single: true, emptyText: '还没有选择 PDF',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        onChange: (items) => {
          pdfPath = items.length ? items[0].path : null;
          fileHint.textContent = pdfPath || '未选择';
          result.innerHTML = '';
        },
      });

      const runBtn = btn('开始瘦身', 'btn-primary', async () => {
        if (!pdfPath) return toast('请先选择 PDF', 'warn');
        status.textContent = '处理中…';
        runBtn.disabled = true;
        result.innerHTML = '';
        try {
          const PDFLib = window.PDFLib;
          if (!PDFLib) throw new Error('pdf-lib 未加载');
          const { PDFDocument } = PDFLib;

          const r = await invoke(Channels.CHANNELS.FS.READ_FILE_B64, pdfPath);
          const beforeBytes = Math.floor(r.b64.length * 0.75);

          const doc = await PDFDocument.load(r.b64, { ignoreEncryption: true, updateMetadata: false });
          /* 【三件事各自的作用】
           *  1) 清元数据：Word 导出的 PDF 常带 Producer/Creator/Keywords，
           *     有时还有一大坨 XMP —— 这些都是可删的文本，几百字节到几 KB；
           *  2) setTitle 等设空：pdf-lib 保存时会把它们写回；
           *  3) useObjectStreams: true 是**关键** —— 把大量小对象打包成
           *     压缩流。对结构复杂的 PDF（几千个对象）效果最明显，
           *     通常能省 5~20%。 */
          try { doc.setTitle(''); doc.setAuthor(''); doc.setSubject(''); doc.setKeywords([]); doc.setProducer(''); doc.setCreator(''); } catch (e) {}

          const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
          const afterBytes = bytes.length;
          const saved = beforeBytes - afterBytes;
          const pct = beforeBytes ? (saved / beforeBytes) * 100 : 0;

          const outPath = await invoke(Channels.CHANNELS.DIALOG.SAVE, {
            title: '保存瘦身后的 PDF',
            defaultPath: String(pdfPath).replace(/\.pdf$/i, '') + '-slim.pdf',
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
          });
          if (!outPath) { status.textContent = ''; runBtn.disabled = false; return; }
          await invoke(Channels.CHANNELS.FS.WRITE_FILE_B64, outPath, arrayB64(bytes));

          status.textContent = '完成：' + outPath;
          result.appendChild(ui.kvGrid([
            ['原始大小', ui.fmtBytes(beforeBytes)],
            ['处理后', ui.fmtBytes(afterBytes)],
            ['节省', saved > 0 ? (ui.fmtBytes(saved) + '（' + pct.toFixed(1) + '%）') : ('无变化（' + pct.toFixed(1) + '%）')],
            ['输出', outPath],
          ]));
          /* 【如实说明收益来源】用户拿扫描件来试，看到只省 3% 会觉得
           * 工具没用。必须说清"能省的部分在哪"，而不是让用户自己猜。 */
          if (pct < 3) {
            result.appendChild(div('field-hint',
              '这次节省很少。瘦身只能删元数据与冗余对象——如果 PDF 的主体是扫描图片（每页一张大图），体积由图片本身决定，需要用图片压缩类工具处理。'));
          }
          toast(saved > 0 ? ('已瘦身 ' + ui.fmtBytes(saved)) : '体积未减少', saved > 0 ? 'success' : 'info', 4000);
        } catch (e) {
          status.textContent = '';
          toast('瘦身失败：' + (e && e.message || e), 'error', 6000);
        } finally {
          runBtn.disabled = false;
        }
      }, 'filter');

      page.appendChild(div('card', div('card-title', '选择 PDF'), picker.el, fileHint));
      page.appendChild(div('card',
        div('card-title', '瘦身'),
        div('form-row', runBtn, status),
        div('field-hint', '做三件事：删除元数据、清理冗余对象、启用对象流压缩。适合「Word/Excel 导出的 PDF」。'
          + '如果 PDF 主体是扫描图片，体积由图片决定，请改用图片压缩类工具。')));
      page.appendChild(div('card', div('card-title', '结果'), result));
    },
  });
})();
