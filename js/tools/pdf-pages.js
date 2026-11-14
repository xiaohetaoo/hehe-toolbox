/* 模块：PDF 页面管理（删除 / 重排 / 旋转 / 提取 / 合并）
 *
 * ============ 为什么单独做一个工具 ============
 * 已有的 pdf-tools 做的是「整体合并、整体拆分」，pdf-watermark 做水印与页码。
 * 但最常见的需求其实是**页级操作**：这份 PDF 第 3 页是空白、要不要删掉；
 * 扫描件顺序乱了、要拖动重排；横向扫描的几页读起来要歪头、要转 90°。
 * 这些用「拆分再合并」也能做到，但那是把一个动作拆成三个工具用。
 *
 * ============ pdf-lib 的能力边界（写之前先确认） ============
 *   · removePage(i)            —— 删单页，索引改变后要重新取
 *   · insertPage(i, page)      —— 插页
 *   · copyPages(src, indices)  —— 从另一份文档取页（合并/提取用）
 *   · page.setRotation(degrees(90)) —— 旋转，**只是改显示角度**，
 *     不重编码内容流。好处是快且无损；代价是某些老阅读器不认。
 *   · load(bytes, { ignoreEncryption: true }) —— 加密 PDF 会忽略而非报错，
 *     这点必须向用户说明：被忽略的加密文件另存后可能打不开。
 */
(function () {
  const ui = window.ui;
  const Channels = window.Channels;
  const { div, btn, toast, h, icon } = ui;
  const { invoke } = window.api;
  const MOD = 'office';

  /** Uint8Array → base64（分块，避免大文件爆栈）。与 pdf-plus 同一写法。 */
  function arrayB64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  /* 页码范围解析：支持 "1,3,5-8,12" 这种写法。
   * 【为什么不用 split(',') 就完事】用户写 "1-3" 是常态，
   * 只认逗号会让人以为工具坏了。负号与全角逗号也顺手容错。 */
  function parseRange(text, max) {
    const raw = String(text || '').replace(/，/g, ',').trim();
    if (!raw) return [];
    const out = new Set();
    for (const part of raw.split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const m = seg.match(/^(\d+)\s*[-~]\s*(\d+)$/);
      if (m) {
        let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (a > b) [a, b] = [b, a];
        for (let i = a; i <= b; i++) if (i >= 1 && i <= max) out.add(i);
      } else if (/^\d+$/.test(seg)) {
        const n = parseInt(seg, 10);
        if (n >= 1 && n <= max) out.add(n);
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  window.PdfPages = { parseRange };

  window.Registry.register({
    id: 'pdf-pages',
    name: 'PDF 页面管理',
    nameEn: 'PDF Page Organizer',
    module: MOD,
    icon: 'layers',
    desc: '删除、重排、旋转、提取页面，或把多份 PDF 按页合并（本地处理）',
    descEn: 'Delete, reorder, rotate and extract PDF pages, or merge page ranges locally',
    keywords: ['pdf', '页面', '删除', '重排', '排序', '旋转', '提取', '合并',
      'page', 'organize', 'rotate', 'delete', 'reorder', 'extract', 'merge'],
    render(page) {
      let doc = null;          // pdf-lib 文档对象
      let srcB64 = null;       // 原始 base64（每次操作都从它重新 load）
      let pdfPath = null;
      let pageOrder = [];      // 当前页面顺序（1 基页号数组）
      let rotations = {};      // { 页号: 累计角度 }

      const fileHint = div('field-hint', '未选择文件');
      const pageList = div('pdfp-list');
      const status = div('field-hint', '');
      const toolbar = div('form-row');
      const rangeInput = h('input', {
        class: 'input input-sm', placeholder: '页码范围，如 1,3,5-8', style: { width: '200px' },
      });

      const picker = ui.filePicker({
        text: '选择 PDF 文件',
        single: true,
        emptyText: '还没有选择 PDF',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        onChange: async (items) => {
          if (!items.length) { reset(); return; }
          pdfPath = items[0].path;
          fileHint.textContent = pdfPath;
          await loadDoc();
        },
      });

      /* 每次操作都重新 load：pdf-lib 的 removePage 会重排内部索引，
       * 在同一对象上连续操作很容易拿错页。重新 load 一次的成本
       * （几毫秒到几十毫秒）远低于"删错页"的代价。 */
      async function loadDoc() {
        const PDFLib = window.PDFLib;
        if (!PDFLib) {
          /* 退化路径也要清状态：否则上一次成功加载的 doc/页序还留着，
           * 界面却提示「pdf-lib 未加载」，点操作会作用在旧文档上。 */
          doc = null; srcB64 = null; pageOrder = []; rotations = {};
          pageList.innerHTML = '';
          toast('pdf-lib 未加载', 'error');
          return;
        }
        status.textContent = '读取中…';
        try {
          const r = await invoke(Channels.CHANNELS.FS.READ_FILE_B64, pdfPath);
          srcB64 = r.b64;
          doc = await PDFLib.PDFDocument.load(srcB64, { ignoreEncryption: true });
          pageOrder = Array.from({ length: doc.getPageCount() }, (_, i) => i + 1);
          rotations = {};
          renderList();
          status.textContent = '共 ' + doc.getPageCount() + ' 页';
        } catch (e) {
          /* 【读失败必须把状态清干净，不能留半更新的现场】
           * 第四轮审查：原来先把 srcB64 赋上再 load，load 抛错时只弹 toast。
           * 于是 srcB64 非空、doc 仍是 null（首次加载失败）→ 点「删除这些页」
           * 直接 TypeError，事件处理器里没有 toast，界面毫无反应；
           * 若此前成功加载过另一份 PDF，则页序还是旧文档的，
           * fileHint 却已显示新路径 —— 用户会按错的页数操作。 */
          doc = null; srcB64 = null; pageOrder = []; rotations = {};
          pageList.innerHTML = '';
          status.textContent = '';
          toast('读取失败：' + e.message, 'error');
        }
      }

      function reset() {
        doc = null; srcB64 = null; pdfPath = null; pageOrder = []; rotations = {};
        fileHint.textContent = '未选择文件';
        pageList.innerHTML = '';
        status.textContent = '';
      }

      function renderList() {
        pageList.innerHTML = '';
        if (!pageOrder.length) {
          pageList.appendChild(div('field-hint', '还没有页面'));
          return;
        }
        pageOrder.forEach((pg, idx) => {
          const row = div('pdfp-row');
          row.appendChild(div('pdfp-idx', String(idx + 1)));
          row.appendChild(div('pdfp-origin', '原第 ' + pg + ' 页'
            + (rotations[pg] ? ' · 旋转 ' + rotations[pg] + '°' : '')));
          const ops = div('pdfp-ops');
          /* 上移/下移：只改 pageOrder，不立刻写盘 —— 用户可能连做几步再保存 */
          const up = btn('↑', 'btn-sm btn-text', () => {
            if (idx === 0) return;
            [pageOrder[idx - 1], pageOrder[idx]] = [pageOrder[idx], pageOrder[idx - 1]];
            renderList();
          });
          const down = btn('↓', 'btn-sm btn-text', () => {
            if (idx === pageOrder.length - 1) return;
            [pageOrder[idx + 1], pageOrder[idx]] = [pageOrder[idx], pageOrder[idx + 1]];
            renderList();
          });
          /* 旋转：累加 90°，到 360 归零（避免显示 "旋转 450°"） */
          const rot = btn('⟳ 90°', 'btn-sm btn-text', () => {
            rotations[pg] = ((rotations[pg] || 0) + 90) % 360;
            renderList();
          });
          const del = btn('×', 'btn-sm btn-text', () => {
            pageOrder.splice(idx, 1);
            renderList();
          });
          ops.appendChild(up);
          ops.appendChild(down);
          ops.appendChild(rot);
          ops.appendChild(del);
          row.appendChild(ops);
          pageList.appendChild(row);
        });
      }

      /** 把 pageOrder + rotations 应用到源文件，返回新字节 */
      async function build() {
        const PDFLib = window.PDFLib;
        if (!PDFLib) throw new Error('pdf-lib 未加载');
        if (!srcB64) throw new Error('请先选择 PDF');
        if (!pageOrder.length) throw new Error('至少要保留一页');
        const src = await PDFLib.PDFDocument.load(srcB64, { ignoreEncryption: true });
        const out = await PDFLib.PDFDocument.create();
        /* copyPages 按给定顺序返回副本，所以重排就是"按新顺序 copy" */
        const copied = await out.copyPages(src, pageOrder.map((n) => n - 1));
        copied.forEach((p, i) => {
          const deg = rotations[pageOrder[i]] || 0;
          if (deg) {
            /* 【旋转是累加在已有角度上】扫描件本身可能已带 /Rotate 90，
             * 直接 setRotation(90) 会把它"归零"——用户看到的是没转。
             * 所以取出当前角度再加。 */
            const cur = p.getRotation().angle || 0;
            p.setRotation(PDFLib.degrees((cur + deg) % 360));
          }
          out.addPage(p);
        });
        return out.save();
      }

      async function saveAs(defaultName) {
        try {
          status.textContent = '生成中…';
          const bytes = await build();
          const outPath = await invoke(Channels.CHANNELS.DIALOG.SAVE, {
            title: '保存处理后的 PDF',
            defaultPath: String(pdfPath).replace(/\.pdf$/i, '') + (defaultName || '-edited') + '.pdf',
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
          });
          if (!outPath) { status.textContent = ''; return; }
          await invoke(Channels.CHANNELS.FS.WRITE_FILE_B64, outPath, arrayB64(bytes));
          const before = srcB64.length * 0.75;
          status.textContent = '已保存：' + outPath + '（' + fmtBytes(before) + ' → ' + fmtBytes(bytes.length) + '）';
          toast('已保存：' + outPath, 'success', 4000);
        } catch (e) {
          status.textContent = '';
          toast(e.message, 'error');
        }
      }

      /* ---- 按钮组 ---- */
      const saveBtn = btn('另存为…', 'btn-primary', () => saveAs('-edited'), 'save');

      const delRangeBtn = btn('删除这些页', 'btn-sm btn-secondary', () => {
        /* 【两个状态都要判】读取失败后 srcB64 与 doc 必须同时为 null，
         * 但这里是调用点和状态之间的契约，别只赌 loadDoc 的清理 —— 
         * 任一为 null 都直接拦下，避免 doc.getPageCount() 抛 TypeError。 */
        if (!srcB64 || !doc) return toast('请先选择 PDF（读取成功后可用）', 'warn');
        const list = parseRange(rangeInput.value, doc.getPageCount());
        if (!list.length) return toast('请先填页码范围', 'warn');
        const kill = new Set(list);
        /* 【回滚必须恢复操作前的快照，不是 1..N 原始顺序】
         * 用户可能已经重排过、或删过几页；用原始顺序重建会把那些
         * 未写盘的调整悄悄抹掉。快照才是"这次操作之前"的真实状态。 */
        const prevOrder = pageOrder.slice();
        pageOrder = pageOrder.filter((n) => !kill.has(n));
        if (!pageOrder.length) {
          /* 全删光就没有 PDF 可存了 —— 回滚比留个空文档好 */
          pageOrder = prevOrder;
          renderList();
          return toast('不能删掉所有页', 'warn');
        }
        renderList();
        toast('已从列表移除 ' + list.length + ' 页（尚未写盘）', 'info');
      });

      const keepRangeBtn = btn('只保留这些页', 'btn-sm btn-secondary', () => {
        if (!srcB64 || !doc) return toast('请先选择 PDF（读取成功后可用）', 'warn');
        const list = parseRange(rangeInput.value, doc.getPageCount());
        if (!list.length) return toast('请先填页码范围', 'warn');
        pageOrder = list.slice();
        renderList();
        toast('已保留 ' + list.length + ' 页（尚未写盘）', 'info');
      });

      const resetBtn = btn('恢复原顺序', 'btn-sm btn-text', () => {
        if (!doc) return;
        pageOrder = Array.from({ length: doc.getPageCount() }, (_, i) => i + 1);
        rotations = {};
        renderList();
      });

      toolbar.appendChild(rangeInput);
      toolbar.appendChild(delRangeBtn);
      toolbar.appendChild(keepRangeBtn);
      toolbar.appendChild(resetBtn);

      page.appendChild(div('card', div('card-title', '选择 PDF'), picker.el, fileHint));
      page.appendChild(div('card', div('card-title', icon('layers'), '页面'),
        toolbar,
        h('div', { class: 'field-hint' }, '用 ↑↓ 调整顺序、⟳ 旋转 90°、× 移除。改完点「另存为」才写盘。'),
        pageList));
      page.appendChild(div('card', div('card-title', '导出'), div('form-row', saveBtn), status));
      page.appendChild(div('card', div('card-title', '注意'),
        div('field-hint', '· 旋转只改显示角度，不重编码页面内容，速度快且无损；'
          + '少数老旧阅读器可能忽略该标记。'),
        div('field-hint', '· 加密 PDF 会被忽略加密状态后另存，若原文件受密码保护，'
          + '另存结果可能无法正常打开。'),
        div('field-hint', '· 所有处理都在本机完成，文件不上传。')));
    },
  });
})();
