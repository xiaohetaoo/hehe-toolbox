/* 模块：文件处理 —— 批量重命名 / 批量改后缀 / 加密解密 / 分割合并 / 重复文件 */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, guard, toast, copyText, confirmBox, alertBox, filePicker, renderTable, fmtBytes, progressEl } = window.ui;
  const { invoke } = window.api;
  /* EXIF 解析搬到了 lib/exif.js（纯函数，可单测，也被 exif-view 复用）。
   * 【为什么用 require 而不是 window.xxx】
   * 渲染层是 contextIsolation + sandbox:false，项目里已有先例
   * （lib/fail-text.js 由 index.html 用 <script> 引入、挂到 window）。
   * 但 file-tools.js 里已经有 require 的用法吗？没有 —— 这里改用
   * index.html 引入 + window.ExifLib，与 fail-text 保持同一种形态。 */
  const exifLib = window.ExifLib;
  const MOD = 'file';

  /* 拼「批量操作失败明细」的文本 —— 实现在 lib/fail-text.js（任务 2）。
   *
   * 【为什么从这里搬走】
   * 这段逻辑原来内联在两次 alertBox 调用里，于是测试只能去匹配源码形态
   * （`/alertBox\({[\s\S]{0,200}部分文件未能重命名/`），而那条断言锁住的
   * 恰恰是**缺陷本身**：alertBox 的签名是 (message, title)，传配置对象进去
   * 会被 h() 当普通对象丢掉，弹出来是标题「提示」+ 正文全空白。
   * 修好功能之后断言反而红了 —— 典型的「测试比代码更坚持错误」。
   *
   * 搬进 lib/ 之后主代码与测试调用**同一份实现**（不会出现「测试测副本」
   * 造成的假绿），测试断言的是返回值内容，不再依赖任何源码版面。
   * 渲染层通过 index.html 的 <script src="lib/fail-text.js"> 拿到
   * window.FailText，Node 侧 require 拿到的就是同一个函数。
   */
  const buildFailText = window.FailText.buildFailText;

  /* ---------- 批量重命名 ---------- */
  register({
    id: 'batch-rename', name: '批量重命名', nameEn: 'Batch Rename', module: MOD, icon: 'pencil',
    desc: '前缀/后缀、序号、查找替换、正则替换、大小写，先预览后执行', descEn: 'Rename many files with prefixes, numbering or EXIF shot time, with a live preview',
    keywords: ['重命名', '批量', 'rename', '正则'],
    render(page) {
      let files = [];
      let dirMode = false;
      // 目录加载是「批量灌入」，要跳过 onChange 的 dirMode 重置
      let selfLoad = false;
      const picker = filePicker({
        text: '选择或拖入要重命名的文件（可多选）',
        onChange: (items) => {
          files = items.map((x) => x.path);
          if (!selfLoad) { dirMode = false; safePreview(); }
        }
      });
      const dirInput = h('input', { class: 'input input-sm', placeholder: '或输入目录路径（重命名目录内所有文件）', style: { flex: '1' } });
      const loadDirBtn = btn('加载目录', 'btn-sm btn-secondary', async () => {
        const d = dirInput.value.trim();
        if (!d) return;
        try {
          const list = await invoke(Channels.CHANNELS.FS.LIST, d);
          const found = list.filter(x => !x.isDir).map(x => x.path);
          selfLoad = true;
          try {
            picker.clear();
            picker.add(found);
            files = picker.paths;
            dirMode = true;
          } finally { selfLoad = false; }
          safePreview();
        } catch (e) { toast(e.message, 'error'); }
      });
      const pickDirBtn = btn('选择目录…', 'btn-sm btn-secondary', async () => {
        const d = await invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: ['openDirectory'] });
        if (d && d[0]) { dirInput.value = d[0]; loadDirBtn.click(); }
      });

      const prefixIn = h('input', { class: 'input input-sm', placeholder: '新前缀', style: { width: '110px' } });
      const suffixIn = h('input', { class: 'input input-sm', placeholder: '新后缀（文件名尾）', style: { width: '130px' } });
      const startNum = h('input', { class: 'input input-sm', type: 'number', value: '1', style: { width: '70px' } });
      const findIn = h('input', { class: 'input input-sm', placeholder: '查找（支持正则）', style: { width: '140px' } });
      const replIn = h('input', { class: 'input input-sm', placeholder: '替换为', style: { width: '140px' } });
      const useRegex = h('input', { type: 'checkbox', class: 'checkbox' });
      /* 按 EXIF 拍摄时间重命名。
       * 用途：手机/相机导出的照片名是 IMG_20241103_143022.jpg 这类无语义名字，
       * 而真正的拍摄时间在 EXIF 里。整理照片时想改成 2024-11-03_143022.jpg。
       * EXIF 读不到（截图、被清除过的图、非 JPEG）时退回文件修改时间，
       * 否则用户会看到一堆文件名原样不变、又不知道为什么。 */
      const useExif = h('input', { type: 'checkbox', class: 'checkbox' });
      /* name → Date 的缓存。buildPreview 会被反复调用（每次改输入框都重建预览），
       * 没有缓存的话每改一个字都要把几百张图全读一遍。 */
      const exifTimeCache = new Map();
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
        if (useExif.checked) {
          const t = exifTimeCache.get(path);
          // 用 EXIF 时间整体替换文件名主干；后面的前缀/序号仍然生效
          if (t) {
            const p2 = (n) => String(n).padStart(2, '0');
            nb = t.getFullYear() + '-' + p2(t.getMonth() + 1) + '-' + p2(t.getDate()) +
                 '_' + p2(t.getHours()) + p2(t.getMinutes()) + p2(t.getSeconds());
          }
        }
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
      /* 预取 EXIF 时间。只读文件头 64KB —— EXIF 一定在 JPEG 开头，
       * 整份读进来再解析纯属浪费（一张 5MB 的照片 × 500 张 = 2.5GB IO）。
       *
       * 【这里曾经整条路径都是死的，务必别改回去】
       * fs:read-file-b64 返回的是 { b64, size } 对象，不是 base64 字符串。
       * 原代码 `const b64 = await invoke(...); atob(b64)` 把对象直接喂给 atob，
       * 每次都抛 InvalidCharacterError，被下面的 catch 吞成 t = null，
       * 于是**每一张照片都退到文件修改时间** —— 用户拿到的永远是下载/复制那一刻，
       * 而界面写着「按 EXIF 拍摄时间命名」。功能宣称与实际完全不符，且不报错。
       * 这条路径的错误全都会被 catch 吃掉，所以只能靠 e2e 断言去验
       * （见 scripts/test-exif-rename-e2e.js：真实 JPEG 字节 → 真实 IPC → 文件名）。
       *
       * 第二个参数 maxBytes 以前也是假的：handler 签名只有 (e, p)，
       * 第三参被 IPC 静默丢弃，现在真的只读前 64KB（见 ipc/fs-ops.js）。 */
      async function ensureExifTimes() {
        if (!useExif.checked) return;
        const todo = files.filter((p) => !exifTimeCache.has(p));
        for (const p of todo) {
          let t = null;
          try {
            const r = await invoke(Channels.CHANNELS.FS.READ_FILE_B64, p, 65536);
            if (r && r.b64) {
              const bin = atob(r.b64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              t = exifLib.pickShotTime(exifLib.parseExif(bytes));
            }
          } catch (e) { t = null; }
          if (!t) {
            // 退路：用文件修改时间。不这么做的话用户看到文件名纹丝不动
            try { const st = await invoke(Channels.CHANNELS.FS.STAT, p); if (st && st.mtime) t = new Date(st.mtime); } catch (e) {}
          }
          exifTimeCache.set(p, t);
        }
      }

      /* buildPreview 现在是 async（EXIF 要读文件）。所有调用点都是
       * fire-and-forget 形态，未 catch 的 rejection 会变成静默失败 ——
       * 用户点了"刷新预览"什么都没发生，控制台也没有。统一走这个包装。 */
      function safePreview() {
        return buildPreview().catch((e) => { try { toast('预览失败：' + (e && e.message || e), 'error'); } catch (x) {} });
      }

      /* 把预览表导出成 CSV。
       * 用途：几百个文件的重命名计划，用户想先在 Excel 里核对一遍再执行，
       * 或者留个"我改过什么"的记录。
       *
       * 【必须加 BOM】Excel 读无 BOM 的 UTF-8 CSV 会把中文显示成乱码，
       * 而中文文件名是这个工具的主要使用场景。﻿ 就是 Excel 认的标记。
       *
       * 【必须转义】文件名里可能出现逗号、引号、换行 —— 不按 RFC4180
       * 加引号会把一行拆成两列，导出的表直接错位。 */
      /* 把预览表导出成 CSV。
       * 用途：几百个文件的重命名计划，用户想先在 Excel 里核对一遍再执行。
       *
       * 【必须加 BOM】Excel 读无 BOM 的 UTF-8 CSV 会把中文显示成乱码，
       * 而中文文件名正是这个工具的主要使用场景。
       *
       * 【必须转义】文件名里可能出现逗号、引号、换行——不按 RFC4180
       * 加引号会把一行拆成两列，导出的表直接错位。
       *
       * 【为什么不导出大小】预览表本身也没有大小列（重命名只关心名字），
       * 为了 CSV 一列去额外 stat 几百个文件是白花 IO。
       * 真要看大小，用户可以用「磁盘空间分析」或资源管理器。 */
      async function exportCsv() {
        if (!files.length) return toast('请先添加文件', 'warn');
        if (useExif.checked) { await ensureExifTimes(); }
        const esc = (v) => {
          const t = String(v == null ? '' : v);
          // 含逗号/引号/换行的字段要整体加引号，内部引号翻倍（RFC4180）
          const needQuote = t.indexOf(',') >= 0 || t.indexOf('"') >= 0
            || t.indexOf(String.fromCharCode(10)) >= 0 || t.indexOf(String.fromCharCode(13)) >= 0;
          return needQuote ? '"' + t.split('"').join('""') + '"' : t;
        };
        const rows = [['原文件名', '新文件名', '完整路径']];
        for (let i = 0; i < files.length; i++) {
          const p = files[i];
          const nn = newName(p, i);
          const base = (x) => x.split(/[\\/]/).pop();
          rows.push([base(p), base(nn), p]);
        }
        const body = rows.map((r) => r.map(esc).join(',')).join(String.fromCharCode(13, 10));
        const csv = String.fromCharCode(0xFEFF) + body + String.fromCharCode(13, 10);
        try {
          const out = await invoke(Channels.CHANNELS.DIALOG.SAVE, {
            defaultPath: 'rename-preview.csv',
            filters: [{ name: 'CSV', extensions: ['csv'] }]
          });
          if (!out) return;
          await invoke(Channels.CHANNELS.FS.WRITE_TEXT, out, csv);
          toast('已导出：' + out, 'success');
        } catch (e) { toast('导出失败：' + e.message, 'error'); }
      }

      async function buildPreview() {
        previewBox.innerHTML = '';
        if (!files.length) { previewBox.appendChild(div('empty-tip', '请先添加文件')); return; }
        if (useExif.checked) {
          previewBox.appendChild(div('field-hint', { style: { padding: '4px 2px' } }, '正在读取拍摄时间…'));
          await ensureExifTimes();
          previewBox.innerHTML = '';
        }
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
        if (useExif.checked) await ensureExifTimes();
        if (!(await confirmBox({ title: '执行重命名', message: `将对 ${files.length} 个文件执行重命名，确定继续？` }))) return;
        let ok = 0;
        const failures = [];
        prog.show();
        for (let i = 0; i < files.length; i++) {
          const target = newName(files[i], i);
          prog.set((i + 1) / files.length * 100);
          try {
            if (files[i] !== target) await invoke(Channels.CHANNELS.FS.RENAME, files[i], target);
            ok++;
          } catch (e) { failures.push({ from: files[i], to: target, err: e.message }); }
        }
        prog.hide();
        // 失败原因必须可见（原来只进 console.error），否则用户只看到「失败 1」，
        // 不知道是哪个文件、为什么，也无法判断批量操作后的半成功状态。
        if (failures.length) {
          /* 【alertBox 的签名是 alertBox(message, title)，不是配置对象】
           * 原来这里写成 alertBox({ title, message }) —— 对象当作 message 传进
           * h('div', null, message)，而 h 的子节点只认字符串/数字/Node/带 style 的对象，
           * 普通对象被直接丢弃。于是弹出来的是标题「提示」+ 正文完全空白，
           * 比原来只打 console.error 还糟：注释写着"失败原因必须可见"，实际全丢了。 */
          await alertBox(buildFailText(ok, failures), '部分文件未能重命名').catch(() => {});
        } else {
          toast(`完成：成功 ${ok} 个`, 'success');
        }
        if (dirMode && dirInput.value) loadDirBtn.click(); else { picker.clear(); files = []; safePreview(); }
      });

      page.appendChild(div('card', div('card-title', '选择文件'), picker.el,
        div('form-row', dirInput, pickDirBtn, loadDirBtn)));
      page.appendChild(div('card', div('card-title', '重命名规则（可组合）'),
        div('form-row', h('span', { class: 'form-label' }, '序号'), prefixIn, h('span', { class: 'field-hint' }, '+ 序号'), startNum, suffixIn),
        div('form-row', h('span', { class: 'form-label' }, '替换'), findIn, replIn, h('label', { class: 'field-hint' }, useRegex, ' 正则')),
        div('form-row', h('span', { class: 'form-label' }, '时间'), h('label', { class: 'field-hint' }, useExif, ' 按 EXIF 拍摄时间命名（读不到时用文件修改时间）')),
        /* 捕获组说明：功能本身一直可用（JS 的 String.replace 原生支持 $1），
         * 但界面上没有任何提示，用户不知道能这么用 —— 等于没有。
         * 写清替换串里可用的三种写法，比让用户去猜或查文档有用。 */
        /* 【提示里的正则要写两个反斜杠】
         * 这是单引号字符串，'\d' 在 JS 里是未识别的转义 → 求值成 'd'，
         * 界面上就显示成 IMG_(d+)_(.*)。用户照着抄，得到的正则匹配不到任何东西，
         * 而工具本身工作正常 —— 这种「文档写错」最难被发现：没人会怀疑提示。
         * 源码里必须写 \\d，运行时才是 \d。 */
        div('form-row', h('span', { class: 'form-label' }), h('span', { class: 'field-hint' },
          '正则替换支持捕获组：用 $1 $2 引用第 1、2 个括号。例：IMG_(\\d+)_(.*) → $2-$1')),
        div('form-row', h('span', { class: 'form-label' }, '其他'), caseSel, extIn),
        div('form-row', btn('刷新预览', 'btn-secondary btn-sm', safePreview),
          btn('导出预览 CSV', 'btn-secondary btn-sm', exportCsv, 'download'), applyBtn, prog.el)));
      page.appendChild(div('card', div('card-title', '预览'), previewBox));
      buildPreview();
    }
  });

  /* ---------- 批量改后缀 ---------- */
  register({
    id: 'batch-ext', name: '批量改后缀', nameEn: 'Batch Rename Extension', module: MOD, icon: 'file',
    desc: '批量修改指定目录下文件的扩展名，支持仅匹配特定后缀', descEn: 'Change the extension of a whole folder of files at once',
    keywords: ['后缀', '扩展名', '批量'],
    render(page) {
      const dirInput = h('input', { class: 'input', placeholder: '目录路径', style: { flex: '1' } });
      const pickBtn = btn('选择目录', 'btn-secondary btn-sm', async () => {
        const d = await invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: ['openDirectory'] });
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
        // 新后缀必须是纯扩展名：允许含 . / : 等会让目标路径指向别的目录甚至别的盘
        if (/[\\/:*?"<>|]/.test(to) || /\s/.test(to)) {
          return toast('新后缀不能包含 \\ / : * ? " < > | 或空格', 'warn');
        }
        const from = fromIn.value.trim().replace(/^\./, '').toLowerCase();
        async function walk(d) {
          const list = await invoke(Channels.CHANNELS.FS.LIST, d);
          for (const item of list) {
            if (item.isDir) { if (recursive.checked) await walk(item.path); continue; }
            // 用 lastIndexOf 判断是否真有扩展名（"a.b.txt" 的扩展名是 txt；"README" 没有扩展名）
            const dot = item.name.lastIndexOf('.');
            const hasExt = dot > 0;
            const ext = hasExt ? item.name.slice(dot + 1).toLowerCase() : '';
            // 原来「无扩展名」时 ext=''，slice(0, len-0) 是整条路径，
            // 结果把新后缀直接拼到文件名尾（README -> READMEmd），不是换扩展名。
            // 现在：无扩展名的文件只有在「原后缀留空」时才处理，且是「追加」语义。
            if (from && ext !== from) continue;
            const base = hasExt ? item.path.slice(0, item.path.length - ext.length - 1) : item.path;
            plan.push({ path: item.path, newPath: base + '.' + to, size: item.size, noExt: !hasExt });
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
        let ok = 0;
        const failures = [];
        for (const p of plan) {
          try { await invoke(Channels.CHANNELS.FS.RENAME, p.path, p.newPath); ok++; }
          catch (e) { failures.push({ from: p.path, to: p.newPath, err: e.message }); }
        }
        // 失败明细必须列出来：只报「失败 1」用户不知道是哪个文件、为什么失败，
        // 而且批量操作半成功半失败的状态无从判断，后续手工整理极易出错。
        if (failures.length) {
          /* 同上：alertBox(message, title)。对象形式会弹出一个空白框。 */
          await alertBox(buildFailText(ok, failures), '部分文件未能修改').catch(() => {});
        } else {
          toast(`完成：成功 ${ok} 个`, 'success');
        }
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
    id: 'file-crypt', name: '文件加密解密', nameEn: 'Encrypt / Decrypt', module: MOD, icon: 'lock',
    desc: 'AES-256-CBC 本地加密，密码经 scrypt 派生，离线安全', descEn: 'Encrypt files with a password using AES, and decrypt them back',
    keywords: ['加密', '解密', 'aes', '密码'],
    render(page) {
      let mode = 'encrypt';
      let filePath = null;
      const picker = filePicker({
        text: '选择或拖入要加密/解密的文件',
        single: true,
        emptyText: '还没有选择文件',
        onChange: (items) => { filePath = items.length ? items[0].path : null; }
      });
      const pwdIn = h('input', { type: 'password', class: 'input', placeholder: '设置密码（加密）或输入密码（解密）', style: { flex: '1' } });
      const status = h('div', { class: 'field-hint' }, '');
      const prog = progressEl(); prog.hide();
      async function run() {
        if (!filePath) return toast('请先选择文件', 'warn');
        if (!pwdIn.value) return toast('请输入密码', 'warn');
        const outDefault = mode === 'encrypt' ? filePath + '.hehe' : filePath.replace(/\.hehe$/, '') + '.dec';
        const out = await invoke(Channels.CHANNELS.DIALOG.SAVE, { defaultPath: outDefault });
        if (!out) return;
        prog.show();
        const unsub = window.api.on('job:progress', (d) => { if (d.kind === 'crypt' && d.id === filePath) prog.set(d.done / d.total * 100); });
        try {
          /* 通道名不再以字符串形式过一遍变量：那样等于让通道名在渲染层
           * 多存在一份副本，改常量表时这里不会跟着变。 */
          const ch = mode === 'encrypt' ? Channels.CHANNELS.FS.ENCRYPT_FILE : Channels.CHANNELS.FS.DECRYPT_FILE;
          const r = await invoke(ch, filePath, out, pwdIn.value);
          status.innerHTML = `<span class="status-ok">✓ 完成</span> 输出：${escapeHtml(r.outPath)}（${fmtBytes(r.size)}）`;
          toast(mode === 'encrypt' ? '加密完成' : '解密完成', 'success');
        } catch (e) {
          status.innerHTML = `<span class="status-err">✗ ${escapeHtml(e.message)}</span>`;
          toast(e.message, 'error');
        } finally { prog.hide(); unsub(); }
      }
      /* 统一收口：防重入由 guard 自己管。
       * 以前手写 running 标志时，三条提前返回（没选文件 / 没填密码 /
       * 保存对话框点取消）全都忘了复位，按钮从此永久没反应。 */
      const runGuarded = guard(run);
      const encBtn = btn('加密模式', 'btn-sm btn-primary', () => setMode('encrypt'), 'lock');
      const decBtn = btn('解密模式', 'btn-sm btn-secondary', () => setMode('decrypt'), 'unlock');
      // 主按钮必须提升为变量：原来在 appendChild 里用 btn(...) 一次性渲染，
      // 文案被写死成「开始加密」，切到解密模式后按钮仍显示「开始加密」，
      // 实际执行的是解密 —— 文案与动作相反，属于危险的误导。
      const mainBtn = btn('开始加密', 'btn-primary', () => runGuarded());
      function setMode(m) {
        mode = m;
        encBtn.className = 'btn btn-sm ' + (m === 'encrypt' ? 'btn-primary' : 'btn-secondary');
        decBtn.className = 'btn btn-sm ' + (m === 'decrypt' ? 'btn-primary' : 'btn-secondary');
        mainBtn.textContent = m === 'encrypt' ? '开始加密' : '开始解密';
      }
      page.appendChild(div('card', div('card-title', '选择文件', encBtn, ' ', decBtn), picker.el));
      page.appendChild(div('card', div('card-title', '密码'),
        div('form-row', pwdIn, mainBtn),
        prog.el, status));
    }
  });

  /* ---------- 文件分割与合并 ---------- */
  register({
    id: 'file-split', name: '文件分割合并', nameEn: 'Split & Merge', module: MOD, icon: 'scissors',
    desc: '大文件按大小拆分为分片，支持清单合并还原', descEn: 'Split large files into parts and merge them back exactly',
    keywords: ['分割', '合并', '分片', '拆分'],
    render(page) {
      /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
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
      // 必须初始化一次：两个面板创建时都没设 display:none，只靠点击页签调用 switchT 的话，
      // 直接打开本工具时「分割」和「合并」两张卡片会同时铺在首屏。
      switchT('split');

      /* split */
      let spFile = null;
      const spPicker = filePicker({
        text: '选择要分割的文件',
        single: true,
        emptyText: '还没有选择文件',
        onChange: (items) => { spFile = items.length ? items[0].path : null; }
      });
      const sizeIn = h('input', { class: 'input input-sm', type: 'number', value: '10', style: { width: '90px' } });
      const spProg = progressEl(); spProg.hide();
      const spStatus = div('field-hint', '');
      page.appendChild(div('card', div('card-title', '模式', tabBtn1, ' ', tabBtn2)));
      sp.appendChild(div('card', div('card-title', '分割'), spPicker.el,
        div('form-row', h('span', { class: 'form-label' }, '每片大小'), sizeIn, h('span', { class: 'field-hint' }, 'MB'),
          btn('开始分割', 'btn-primary', async () => {
            if (!spFile) return toast('请选择文件', 'warn');
            const outDir = spFile + '.parts';
            spProg.show(); spStatus.textContent = '';
            const unsub = window.api.on('job:progress', (d) => { if (d.kind === 'split' && d.id === spFile) spProg.set(d.done / d.total * 100); });
            try {
              const r = await invoke(Channels.CHANNELS.FS.SPLIT_FILE, spFile, parseInt(sizeIn.value) || 10, outDir);
              spStatus.innerHTML = `<span class="status-ok">✓ 分割完成</span>：${r.parts} 个分片，输出目录 ${escapeHtml(r.outDir)}`;
              toast('分割完成', 'success');
            } catch (e) { spStatus.innerHTML = `<span class="status-err">✗ ${escapeHtml(e.message)}</span>`; }
            finally { spProg.hide(); unsub(); }
          })),
        spProg.el, spStatus));
      page.appendChild(sp);

      /* merge */
      let mgFile = null;
      const mgPicker = filePicker({
        text: '选择任一分片（.part001）或清单文件（.manifest.hehe.json）',
        single: true,
        emptyText: '还没有选择分片',
        onChange: (items) => { mgFile = items.length ? items[0].path : null; }
      });
      const mgProg = progressEl(); mgProg.hide();
      const mgStatus = div('field-hint', '');
      mg.appendChild(div('card', div('card-title', '合并'), mgPicker.el,
        div('form-row', btn('开始合并', 'btn-primary', async () => {
          if (!mgFile) return toast('请选择分片', 'warn');
          mgProg.show(); mgStatus.textContent = '';
          // 只认「合并」自己的进度事件：hash/split/加密共用 job:progress，不过滤会被别的任务串扰
          /* 只认本次合并的进度：主进程发的 merge 事件里 id 是 finalOut 路径。
           * 原来只判 kind 不判 id —— 同时跑两次合并（或别的合并残留）会互相串。
           * 这里在拿到结果前无法预知 finalOut，故先用「第一个 merge 事件的 id」锁定。 */
          let mergeId = null;
          const unsub = window.api.on('job:progress', (d) => {
            if (d.kind !== 'merge' || !d.id) return;
            if (!mergeId) mergeId = d.id;
            else if (d.id !== mergeId) return;
            mgProg.set(d.total ? d.done / d.total * 100 : 0);
          });
          try {
            const r = await invoke(Channels.CHANNELS.FS.MERGE_PARTS, mgFile);
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
    id: 'dedupe', name: '重复文件查找', nameEn: 'Duplicate Finder', module: MOD, icon: 'copy',
    desc: '按内容 MD5 / 名称 / 大小扫描重复文件，支持批量删除', descEn: 'Find duplicate files by hash and remove the extra copies safely',
    keywords: ['重复', '查重', 'dedupe', 'md5'],
    render(page) {
      const dirInput = h('input', { class: 'input', placeholder: '要扫描的目录', style: { flex: '1' } });
      const pickBtn = btn('选择目录', 'btn-secondary btn-sm', async () => {
        const d = await invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: ['openDirectory'] });
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
        const unsub = window.api.on('job:progress', (d) => { if (d.kind === 'dedupe') status.textContent = `扫描中… 已检查 ${d.files || 0} 个文件`; });
        try {
          const r = await invoke(Channels.CHANNELS.FS.DEDUPE, dir, { mode: modeSel.value });
          groups = r.groups;
          status.innerHTML = groups.length
            ? `发现 <b>${groups.length}</b> 组重复文件，可释放 <b>${fmtBytes(r.totalWasted)}</b>`
            : '未发现重复文件 ✓';
          renderGroups();
        } catch (e) { status.textContent = '✗ ' + e.message; }
        finally { unsub(); }
      });
      /* 按大小 / 按文件名 只是「疑似重复」，内容可能完全不同。
         这两种模式下绝不能给出「保留第一个，删除其余」这种一键删除，
         也不能把非首个文件默认勾选 —— 否则用户一路点下去就把
         内容不同的文件永久删掉了。 */
      const isWeakMode = () => modeSel.value === 'size' || modeSel.value === 'name';
      function renderGroups() {
        resultBox.innerHTML = '';
        if (isWeakMode()) {
          const warn = div('card');
          warn.style.padding = '12px';
          warn.style.border = '1px solid var(--warning)';
          warn.style.background = 'color-mix(in srgb, var(--warning) 8%, transparent)';
          warn.appendChild(div('', { style: { fontWeight: 600, marginBottom: '6px' } },
            '⚠ 当前是「按' + (modeSel.value === 'size' ? '大小' : '文件名') + '」匹配，内容可能不一样'));
          warn.appendChild(div('field-hint', null,
            '同大小或同名的文件很可能是完全不同的内容。请逐个确认后再手动勾选要删除的文件；' +
            '本模式下不会提供一键删除，也不会默认勾选任何文件。想准确定位重复文件请用「按内容（MD5）」。'));
          resultBox.appendChild(warn);
        }
        for (const [gi, g] of groups.entries()) {
          const card = div('card');
          card.style.padding = '14px';
          card.style.border = '1px solid var(--border)';
          const head = div('form-row',
            h('span', { class: 'tag tag-blue' }, `组 ${gi + 1}`),
            h('span', { class: 'field-hint' }, `${g.files.length} 个文件 · 浪费 ${fmtBytes(g.waste != null ? g.waste : g.size * (g.files.length - 1))}`));
          // 一键删只在「按内容」这种确定性匹配下提供
          if (!isWeakMode()) {
            head.appendChild(h('span', { style: { marginLeft: 'auto' } },
              btn('保留第一个，删除其余', 'btn-sm btn-danger-plain', () => deleteIn(g, 0))));
          }
          card.appendChild(head);
          const checks = [];
          g.files.forEach((f, fi) => {
            const cb = h('input', { type: 'checkbox', class: 'checkbox' });
            // 弱匹配模式下不默认勾选（用户必须自己确认）
            cb.checked = isWeakMode() ? false : fi > 0;
            checks.push(cb);
            card.appendChild(div('form-row', cb,
              h('span', { class: 'mono', style: { flex: '1', fontSize: '12px', userSelect: 'text', wordBreak: 'break-all' } }, f),
              btn('打开位置', 'btn-sm btn-text', () => invoke(Channels.CHANNELS.FS.SHOW_ITEM, f))));
          });
          card.appendChild(div('form-row', btn('删除勾选文件', 'btn-sm btn-danger', async () => {
            const selected = g.files.filter((_, i) => checks[i].checked);
            if (!selected.length) return toast('未勾选任何文件', 'warn');
            if (selected.length === g.files.length) return toast('至少保留一个文件', 'warn');
            const extra = isWeakMode()
              ? '\n\n注意：当前是「按' + (modeSel.value === 'size' ? '大小' : '文件名') + '」匹配，这些文件的内容可能并不相同，删除后无法恢复。'
              : '';
            if (!(await confirmBox({ title: '删除重复文件', message: `将永久删除 ${selected.length} 个文件（不进回收站），确定？${extra}`, danger: true, okText: '删除' }))) return;
            let ok = 0, failN = 0;
            for (const f of selected) { try { await invoke(Channels.CHANNELS.FS.DELETE, f); ok++; } catch (e) { failN++; toast(e.message, 'error'); } }
            toast(failN ? `已删除 ${ok} 个，失败 ${failN} 个` : `已删除 ${ok} 个`, failN ? 'warn' : 'success');
            scanBtn.click();
          })));
          resultBox.appendChild(card);
        }
      }
      async function deleteIn(g, keepIdx) {
        const del = g.files.filter((_, i) => i !== keepIdx);
        if (!(await confirmBox({ title: '删除重复文件', message: `保留第一个，永久删除其余 ${del.length} 个文件，确定？`, danger: true, okText: '删除' }))) return;
        let ok = 0, failN = 0;
        for (const f of del) { try { await invoke(Channels.CHANNELS.FS.DELETE, f); ok++; } catch (e) { failN++; toast(e.message, 'error'); } }
        toast(failN ? `已删除 ${ok} 个，失败 ${failN} 个` : `已删除 ${ok} 个`, failN ? 'warn' : 'success');
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
    id: 'zip-tool', name: '压缩解压', nameEn: 'Zip Tool', module: MOD, icon: 'box',
    desc: 'ZIP 压缩与解压（不支持密码与分卷；需要密码请用「7z 压缩包」工具）', descEn: 'Create and extract zip archives with a preview',
    keywords: ['压缩', '解压', 'zip'],
    render(page) {
      const zipPicker = filePicker({
        text: '选择或拖入要压缩的文件/文件夹',
        emptyText: '还没有添加文件或文件夹',
        // 允许把文件夹拖/选进来：压缩对象本来就可能是目录
        pickProps: ['openFile', 'openDirectory', 'multiSelections']
      });
      const zipName = h('input', { class: 'input input-sm', placeholder: '输出 zip 路径（留空自动命名）', style: { flex: '1' } });
      const cBtn = btn('压缩', 'btn-primary', async () => {
        const cPaths = zipPicker.paths;
        if (!cPaths.length) return toast('请选择文件', 'warn');
        try {
          let out = zipName.value.trim();
          if (!out) {
            const first = cPaths[0];
            const dir = first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : first.slice(0, first.lastIndexOf('\\'));
            out = await invoke(Channels.CHANNELS.FS.UNIQUE_PATH, dir + '/archive.zip');
          } else {
            out = await invoke(Channels.CHANNELS.FS.UNIQUE_PATH, out.endsWith('.zip') ? out : out + '.zip');
          }
          const r = await invoke(Channels.CHANNELS.ZIP.COMPRESS, cPaths, out);
          toast('压缩完成：' + fmtBytes(r.size), 'success');
        } catch (e) { toast(e.message, 'error'); }
      });
      const zipUnPicker = filePicker({
        text: '选择或拖入 zip 文件解压',
        single: true,
        emptyText: '还没有选择 zip',
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
        onChange: async (items) => {
          // 单文件槽位：选到就解压（保持原来的「拖进去立刻解压」交互）
          if (!items.length) return;
          const zip = items[0].path;
          const dir = zip.replace(/\.zip$/i, '') + '-extracted';
          try {
            await invoke(Channels.CHANNELS.ZIP.EXTRACT, zip, dir);
            toast('解压完成：' + dir, 'success');
          } catch (e) { toast(e.message, 'error'); }
        }
      });
      page.appendChild(div('card', div('card-title', '压缩为 ZIP'), zipPicker.el,
        div('form-row', zipName, cBtn)));
      page.appendChild(div('card', div('card-title', '解压 ZIP'), zipUnPicker.el));
    }
  });

  /* ---------- 全局文件搜索（Everything 式） ---------- */
  register({
    id: 'global-search', name: '全局文件搜索', nameEn: 'Global Search', module: MOD, icon: 'search',
    desc: 'Everything 式全盘秒搜：NTFS 索引（管理员）/ es.exe / 快速扫描 三引擎', descEn: 'Search files across the whole disk instantly, Everything style',
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
      const quickBtn = btn('快速扫描（无需管理员）', 'btn-secondary btn-sm', startQuick, 'folder');
      let env = null, builtInfo = {}, searchTimer = 0, quickJob = null, quickUnsub = null, seq = 0;
      async function refreshEnv() {
        env = await invoke(Channels.CHANNELS.SEARCH.ENV).catch(() => null);
        builtInfo = (await invoke(Channels.CHANNELS.SEARCH.INDEX_STATUS).catch(() => ({}))) || {};
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
          const label = (info ? '重建 ' : '建索引 ') + v.drive + (gb ? `（${gb}）` : '') + (info ? ` · ${info.count.toLocaleString()} 项` : '');
          volRow.appendChild(btn(label, 'btn-sm ' + (info ? 'btn-secondary' : 'btn-primary'), () => buildIndex(v.drive)));
        }
        if (Object.keys(builtInfo).length) volRow.appendChild(btn('清空索引', 'btn-sm btn-text', async () => {
          try { await invoke(Channels.CHANNELS.SEARCH.FREE); builtInfo = {}; await refreshEnv(); toast('已释放索引内存', 'success'); } catch (e) { toast(e.message, 'error'); }
        }));
      }
      let building = false; // 防止并发双建索引互相干扰
      async function buildIndex(drive) {
        if (building) return toast('正在构建索引，请稍候', 'warn');
        building = true;
        engTag.textContent = '构建索引中…'; engTag.className = 'tag tag-orange';
        statsLine.textContent = '正在读取 NTFS 索引…';
        try {
          const r = await invoke(Channels.CHANNELS.SEARCH.BUILD, drive);
          toast(`索引完成：${r.count.toLocaleString()} 项`, 'success');
        } catch (e) { statsLine.textContent = '✗ ' + e.message; toast(e.message, 'error'); }
        building = false;
        engTag.textContent = '就绪'; engTag.className = 'tag tag-gray';
        await refreshEnv();
        doSearch();
      }
      function schedule() { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 200); }
      function stopQuick() {
        clearTimeout(searchTimer);
        if (quickJob) { invoke(Channels.CHANNELS.JOB.KILL, quickJob).catch(() => {}); quickJob = null; }
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
          listBox.appendChild(div('empty-tip', '还没有可用的索引引擎，任选一种：点「建索引」（需管理员权限，最快）、安装 Everything 后用 es.exe，或直接用「快速扫描」（较慢但无需权限）'));
          return;
        }
        engTag.textContent = engine === 'es' ? '引擎：Everything(es.exe)' : '引擎：NTFS 索引';
        engTag.className = 'tag tag-blue';
        try {
          const r = engine === 'es' ? await invoke(Channels.CHANNELS.SEARCH.ES, { q, limit: +limitSel.value })
            : await invoke(Channels.CHANNELS.SEARCH.QUERY, { q, limit: +limitSel.value, stat: true });
          if (mySeq !== seq) return;
          renderRows(r.rows, false);
          statsLine.textContent = `${r.rows.length} 条 · ${r.ms}ms`;
        } catch (e) {
          if (mySeq !== seq) return;
          engTag.textContent = '出错'; engTag.className = 'tag tag-red';
          listBox.appendChild(div('field-err', '✗ ' + e.message));
        }
      }
      // 持久单表：流式批次只追加行，不重复表头
      let resTbody = null;
      const COLS = [
        { title: '文件名', render: (td, r) => td.appendChild(h('span', { class: 'mono', style: { wordBreak: 'break-all' } }, r.name + (r.dir ? ' /' : ''))) },
        { title: '大小', w: '90px', render: (td, r) => td.append(r.dir ? '目录' : (r.size != null ? fmtBytes(r.size) : '-')) },
        { title: '完整路径', render: (td, r) => td.appendChild(h('span', { class: 'field-hint', style: { wordBreak: 'break-all', fontSize: '11px' } }, r.path)) },
        { title: '操作', w: '180px', render: (td, r) => {
          td.appendChild(btn('打开', 'btn-sm btn-text', () => invoke(Channels.CHANNELS.FS.OPEN_PATH, r.path).catch(e2 => toast(e2.message, 'error'))));
          td.appendChild(btn('位置', 'btn-sm btn-text', () => invoke(Channels.CHANNELS.FS.SHOW_ITEM, r.path)));
          td.appendChild(btn('复制路径', 'btn-sm btn-text', () => copyText(r.path)));
        } }
      ];
      function renderRows(rows, append) {
        if (!append) { resTbody = null; }
        if (!rows.length && !append) { listBox.appendChild(div('empty-tip', '没有匹配的文件')); return; }
        if (!resTbody) {
          const table = h('table', { class: 'table' });
          const thead = h('thead', h('tr', null, ...COLS.map(c => h('th', { style: c.w ? { width: c.w } : null }, c.title))));
          resTbody = h('tbody');
          table.appendChild(thead); table.appendChild(resTbody);
          const wrap = div('table-scroll'); wrap.appendChild(table);
          listBox.appendChild(wrap);
        }
        for (const r of rows) {
          const tr = h('tr');
          for (const c of COLS) { const td = h('td'); c.render(td, r); tr.appendChild(td); }
          resTbody.appendChild(tr);
        }
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
        /* 【必须按 id 过滤】全局搜索的快扫任务 id 形如 qs<数字>。
         * 不过滤的话，别的标签页（哈希、下载、压缩…）每次发进度都会打到本页，
         * 把统计行刷成「已扫描 undefined 项」甚至误判 done 而提前结束扫描。
         * 这里改用 JobPrefix.subscribe：前缀与 lib/job-id.js 是同一份事实，
         * 不再手写 /^qs\d+$/ —— 否则主进程改前缀时这边不会跟着变。 */
        quickUnsub = window.JobPrefix.subscribe('qs', (d) => {
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
        invoke(Channels.CHANNELS.SEARCH.QUICK, { root, q, limit: +limitSel.value }).then((r) => {
          quickJob = r.id;
          if (pageDead && quickJob) invoke(Channels.CHANNELS.JOB.KILL, quickJob).catch(() => {});
        }).catch((e) => { toast(e.message, 'error'); engTag.textContent = '就绪'; engTag.className = 'tag tag-gray'; });
      }
      inBox.addEventListener('input', schedule);
      let pageDead = false; // 页面销毁后到达的 quick 任务 id 也要杀掉，避免孤儿扫描
      window.App.onCleanup(() => { pageDead = true; stopQuick(); });
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

  /* ---------- 文件内容搜索 ---------- */
  register({
    id: 'content-search', name: '文件内容搜索', nameEn: 'Content Search', module: MOD, icon: 'search',
    desc: '在目录里按文本/正则搜文件内容，逐行匹配实时流出（自动跳过二进制）', descEn: 'Search file contents recursively with pattern matching',
    keywords: ['内容', '搜索', 'grep', '正则', '文本'],
    render(page) {
      let root = '';
      const rootLabel = h('span', { class: 'field-hint' }, '未选择');
      const pickBtn = btn('选择目录…', 'btn-secondary', async () => {
        const d = await invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: ['openDirectory'] });
        if (d && d[0]) { root = d[0]; rootLabel.textContent = root; }
      });
      const inBox = h('input', { class: 'input', placeholder: '要搜索的内容…', style: { flex: '1' } });
      const regexChk = h('input', { type: 'checkbox', class: 'checkbox' });
      const ciChk = h('input', { type: 'checkbox', class: 'checkbox' }); ciChk.checked = true;
      const extIn = h('input', { class: 'input input-sm', placeholder: '扩展名过滤，如 js,txt,md（留空全部）', style: { width: '230px' } });
      const status = h('span', { class: 'field-hint' }, '');
      /* 【startBtn 必须等 start 定义之后再造】
       * start 是 `const start = guard(startImpl)`，位于 startImpl 之后；
       * 把 `btn('搜索', …, start)` 放在前面会踩 TDZ —— 打开这个工具页直接
       * 抛 `ReferenceError: Cannot access 'start' before initialization`，
       * 整个页面渲染失败（js/app.js 的渲染兜底只打印一行日志，
       * 用户看到的是「点了没反应」）。
       * 真实回归：上一轮把 start 从 function 声明改成 const guard(...) 时，
       * 按钮那一行留在了原处。function 声明会被提升，const 不会。
       *
       * 所以这里先占个位（用 h() 造一个空节点，不进 DOM），
       * 等 start 就绪后用 replaceChild 换成真按钮 —— 见下面 start 之后那段。
       * startImpl 内部对 startBtn.disabled 的读写都在点击之后才发生，
       * 那时占位早已替换成真按钮，不存在 null 解引用。 */
      let startBtn = h('span');
      const stopBtn = btn('停止', 'btn-danger-plain', () => { if (jobId) invoke(Channels.CHANNELS.JOB.KILL, jobId).catch(() => {}); }, 'square');
      stopBtn.disabled = true;
      const listBox = div('');
      let jobId = null, unsub = null, pageDead = false;
      window.App.onCleanup(() => {
        pageDead = true;
        if (unsub) try { unsub(); } catch (e) {}
        if (jobId) invoke(Channels.CHANNELS.JOB.KILL, jobId).catch(() => {});
      });
      // 持久单表流式追加
      let resTbody = null;
      const COLS = [
        { title: '文件', render: (td, r) => td.appendChild(h('span', { class: 'mono', style: { wordBreak: 'break-all', fontSize: '11px' } }, r.path)) },
        { title: '行', w: '56px', render: (td, r) => td.append(String(r.line)) },
        { title: '内容', render: (td, r) => td.appendChild(h('span', { class: 'field-hint', style: { wordBreak: 'break-all', fontSize: '11px' } }, r.text)) }
      ];
      function appendRows(rows) {
        if (!resTbody) {
          const table = h('table', { class: 'table' });
          const thead = h('thead');
          const trh = h('tr');
          for (const c of COLS) trh.appendChild(h('th', { style: c.w ? { width: c.w } : null }, c.title));
          thead.appendChild(trh);
          table.appendChild(thead);
          resTbody = h('tbody');
          table.appendChild(resTbody);
          const wrap = div('table-scroll'); wrap.appendChild(table);
          listBox.appendChild(wrap);
        }
        for (const r of rows) {
          const tr = h('tr');
          for (const c of COLS) { const td = h('td'); c.render(td, r); tr.appendChild(td); }
          resTbody.appendChild(tr);
        }
      }
      async function startImpl() {
        if (!root) return toast('请先选择目录', 'warn');
        const q = inBox.value.trim();
        if (!q) return toast('请输入搜索内容', 'warn');
        if (regexChk.checked) { try { new RegExp(q); } catch (e) { return toast('正则无效：' + e.message, 'error'); } }
        resTbody = null; listBox.innerHTML = ''; status.textContent = '搜索中…';
        startBtn.disabled = true; stopBtn.disabled = false;
        /* 上一轮如果还在（正常路径已经退订过，这里兜底），先退掉再挂新的，
         * 否则同时存在两个订阅、同一批行会被 appendRows 两次。 */
        try { if (unsub) { unsub(); unsub = null; } } catch (e) {}
        let n = 0;
        /* 【必须按 id 过滤】内容搜索任务 id 形如 cs<数字>。原因同快扫：
         * 不过滤会被其他任务的进度事件污染，导致命中数错乱、提前判定 done。
         * 复用 JobPrefix.subscribe（前缀表与主进程同一份）。 */
        unsub = window.JobPrefix.subscribe('cs', (d) => {
          try {
            const j = JSON.parse(d.data);
            if (j.rows) { n += j.rows.length; appendRows(j.rows); }
            if (j.scanned != null && !j.done) status.textContent = `已扫描 ${j.scanned.toLocaleString()} 个文件 · 命中 ${n} 行…`;
            if (j.done) {
              startBtn.disabled = false; stopBtn.disabled = true; jobId = null;
              status.textContent = j.error ? ('✗ ' + j.error) : `完成：命中 ${j.matched} 行 · 扫描 ${j.scanned.toLocaleString()} 文件 · ${j.ms}ms`;
            }
          } catch (e) {}
        });
        /* 【补兜底】原来是裸 `await invoke(Channels.CHANNELS.CONTENT.SEARCH, ...)`：
         * 失败时抛在这里，而 startBtn.disabled = true 已在前面生效，
         * 「搜索」按钮永久变灰；同时上面刚注册的 job:stream 监听器也没人取消
         * （unsub 只在成功路径里被调用），造成监听器泄漏。 */
        let r;
        try {
          r = await invoke(Channels.CHANNELS.CONTENT.SEARCH, { root, q, useRegex: regexChk.checked, ci: ciChk.checked, exts: extIn.value.trim(), limit: 1000 });
        } catch (e) {
          try { if (unsub) { unsub(); unsub = null; } } catch (e2) {}
          startBtn.disabled = false; stopBtn.disabled = true;
          jobId = null;
          status.textContent = '✗ ' + ((e && e.message) || String(e));
          toast((e && e.message) || String(e), 'error');
          return;
        }
        jobId = r.id;
        if (pageDead && jobId) invoke(Channels.CHANNELS.JOB.KILL, jobId).catch(() => {});
      }
      /* 【防重入走统一 guard，不手写 running 标志】
       * startBtn.disabled = true 只挡鼠标点击；inBox 的 keydown 直接调 start()，
       * 回车可以再进一次 —— 第二次会清空列表、覆盖 unsub 与 jobId，
       * 第一个任务变成谁也取消不掉的孤儿。
       * 这里用 window.ui.guard 而不是自己维护 running：项目里这类"手写标志
       * + 若干早退分支"已经出过 7 次漏复位的 bug（按钮永久卡死），
       * guard 在 finally 里复位，任何 return/throw 都覆盖到。
       * 注意 Enter 与按钮用的是**同一个** guarded 函数，所以两条入口都受保护。 */
      const start = guard(startImpl);
      /* 现在 start 已初始化，把占位节点换成真按钮（见上面的 TDZ 说明） */
      const realStartBtn = btn('搜索', 'btn-primary', start, 'search');
      if (startBtn.parentNode) startBtn.parentNode.replaceChild(realStartBtn, startBtn);
      startBtn = realStartBtn;
      inBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
      page.appendChild(div('card', div('card-title', '搜索范围'),
        div('form-row', pickBtn, rootLabel),
        div('form-row', inBox,
          h('label', { class: 'field-hint' }, regexChk, ' 正则'),
          h('label', { class: 'field-hint' }, ciChk, ' 忽略大小写'), startBtn, ' ', stopBtn),
        div('form-row', extIn, status)));
      page.appendChild(listBox);
    }
  });

  /* ---------- 7z 压缩包 ---------- */
  register({
    id: 'archive-7z', name: '7z 压缩包', nameEn: '7-Zip Archive', module: MOD, icon: 'box',
    desc: '7z 格式压缩/解压，支持密码加密、分卷；检测到系统 7-Zip 时支持更多格式', descEn: 'Create and extract 7z / zip / tar archives, with password support',
    keywords: ['7z', '压缩', '解压', '密码', '分卷', 'rar'],
    render(page) {
      const engineLine = div('field-hint', '检测引擎…');
      /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
      let engines = null;
      invoke(Channels.CHANNELS.SEVEN.STATUS).then((s) => {
        engines = s;
        engineLine.innerHTML = '';
        engineLine.appendChild(h('span', { class: 'tag ' + (s.za ? 'tag-green' : 'tag-red') }, s.za ? '内置 7za ✓（7z/zip）' : '内置 7za 缺失'));
        engineLine.appendChild(h('span', { class: 'tag ' + (s.full ? 'tag-green' : 'tag-gray') }, s.full ? '系统 7-Zip ✓（含 rar 等全格式）' : '系统 7-Zip 未检测（装后可解 rar）'));
      }).catch(() => { engineLine.textContent = '引擎检测失败'; });
      /* 压缩 */
      const sevenPicker = filePicker({
        text: '拖入或选择要压缩的文件/文件夹（可多选）',
        emptyText: '还没有添加文件或文件夹',
        pickProps: ['openFile', 'openDirectory', 'multiSelections']
      });
      const zipName = h('input', { class: 'input input-sm', placeholder: '输出 .7z 路径（留空自动命名）', style: { flex: '1' } });
      const pwdIn = h('input', { class: 'input input-sm', placeholder: '密码（留空不加密）', style: { width: '140px' } });
      const volIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '分卷MB', style: { width: '90px' }, title: '分卷大小（MB，留空不分卷）' });
      const cBtn = btn('压缩', 'btn-primary', async () => {
        const cPaths = sevenPicker.paths;
        if (!cPaths.length) return toast('请选择文件', 'warn');
        try {
          let out = zipName.value.trim();
          if (!out) {
            const first = cPaths[0];
            const dir = first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : first.slice(0, first.lastIndexOf('\\'));
            out = await invoke(Channels.CHANNELS.FS.UNIQUE_PATH, dir + '/archive.7z');
          } else out = await invoke(Channels.CHANNELS.FS.UNIQUE_PATH, out.endsWith('.7z') ? out : out + '.7z');
          const r = await invoke(Channels.CHANNELS.SEVEN.COMPRESS, { files: cPaths, out, password: pwdIn.value || '', volumeMB: volIn.value ? +volIn.value : 0 });
          toast('压缩完成：' + fmtBytes(r.size), 'success');
        } catch (e) { toast(e.message, 'error'); }
      }, 'box');
      /* 解压 */
      const exPath = { p: null };
      const exPicker = filePicker({
        text: '拖入或选择压缩包（.7z / .zip）',
        single: true,
        emptyText: '还没有选择压缩包',
        filters: [{ name: '压缩包', extensions: ['7z', 'zip', 'tar', 'gz', 'rar'] }],
        onChange: (items) => { exPath.p = items.length ? items[0].path : null; }
      });
      const exPwd = h('input', { class: 'input input-sm', placeholder: '密码（如有）', style: { width: '140px' } });
      const exBtn = btn('解压', 'btn-primary', async () => {
        if (!exPath.p) return toast('请选择压缩包', 'warn');
        try {
          const outDir = exPath.p.replace(/\.\w+$/, '') + '_extracted';
          const r = await invoke(Channels.CHANNELS.SEVEN.EXTRACT, { archive: exPath.p, outDir, password: exPwd.value || '' });
          toast('已解压到：' + r.outDir, 'success');
        } catch (e) { toast(e.message, 'error'); }
      }, 'folder');
      page.appendChild(div('card', div('card-title', '引擎'), engineLine,
        div('field-hint', '内置 7za 支持 7z/zip/tar/gz 等并支持密码与分卷；RAR 等更多格式需系统安装 7-Zip 完整版。')));
      page.appendChild(div('card', div('card-title', '压缩为 7z'), sevenPicker.el,
        div('form-row', zipName),
        div('form-row', pwdIn, h('span', { class: 'field-hint' }, ' '), volIn, cBtn)));
      page.appendChild(div('card', div('card-title', '解压'), exPicker.el,
        div('form-row', exPwd, exBtn, h('span', { class: 'field-hint' }, '解压到压缩包旁的同名目录'))));
      /* 预览：不解压直接列出内容 */
      const pvPath = { p: null };
      const pvPicker = filePicker({
        text: '拖入压缩包预览内容（不解压）',
        single: true,
        emptyText: '还没有选择压缩包',
        filters: [{ name: '压缩包', extensions: ['7z', 'zip', 'tar', 'gz', 'rar'] }],
        onChange: (items) => {
          pvPath.p = items.length ? items[0].path : null;
          if (pvPath.p) listArchive(); else pvBox.innerHTML = '';
        }
      });
      const pvPwd = h('input', { class: 'input input-sm', placeholder: '密码（如有）', style: { width: '130px' } });
      const pvBox = div('');
      async function listArchive() {
        if (!pvPath.p) return;
        pvBox.innerHTML = '';
        pvBox.appendChild(window.ui.loadingBlock('读取压缩包…'));
        try {
          const r = await invoke(Channels.CHANNELS.SEVEN.LIST, { archive: pvPath.p, password: pvPwd.value || '' });
          pvBox.innerHTML = '';
          const rows = r.entries.slice(0, 300);
          pvBox.appendChild(div('field-hint', `共 ${r.total} 项${r.total > 300 ? '，显示前 300' : ''}`));
          pvBox.appendChild(renderTable({
            columns: [
              { key: 'attr', title: '类型', width: '56px', render: x => h('span', { class: 'tag ' + (String(x.attr).includes('D') ? 'tag-blue' : 'tag-gray') }, String(x.attr).includes('D') ? '目录' : '文件') },
              { key: 'size', title: '大小', width: '110px', render: x => x.attr.includes('D') ? '—' : fmtBytes(x.size) },
              { key: 'path', title: '路径', render: x => h('span', { class: 'mono', style: { wordBreak: 'break-all', fontSize: '11px' } }, x.path) }
            ],
            rows
          }));
        } catch (e) {
          pvBox.innerHTML = '';
          pvBox.appendChild(div('field-err', '✗ ' + (e && e.message ? e.message : e)));
        }
      }
      page.appendChild(div('card', div('card-title', '预览（不解压）'), pvPicker.el,
        div('form-row', pvPwd, btn('列出内容', 'btn-sm btn-secondary', listArchive, 'clipboard')), pvBox));
    }
  });
})();
