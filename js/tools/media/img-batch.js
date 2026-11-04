/* 模块：多媒体处理 —— img-batch（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, filePicker, fmtBytes, progressEl } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';
  const { isImgPath, IMG_FILTER, loadImg } = window.MediaShared;

register({
    id: 'img-batch', name: '图片批量处理', nameEn: 'Batch Images', module: MOD, icon: 'image',
    desc: '批量缩放、旋转、格式转换（JPG/PNG/WebP）、压缩', descEn: 'Process a whole folder of images at once: resize, convert, rename',
    keywords: ['图片', '批量', '缩放', '转换', '压缩'],
    render(page) {
      let running = false; // 防重入标志：处理中禁止重复点击
      const picker = filePicker({
        text: '拖入或选择要处理的图片（可多选）',
        filters: [IMG_FILTER],
        filter: isImgPath,
        onReject: (n) => toast(`已忽略 ${n} 个非图片文件`, 'warn')
      });
      const scaleIn = h('input', { type: 'number', class: 'input input-sm', value: '100', style: { width: '80px' } });
      const widthIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '宽', style: { width: '80px' } });
      const heightIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '高', style: { width: '80px' } });
      const rotateSel = h('select', { class: 'select input-sm' }, h('option', { value: '0' }, '不旋转'), h('option', { value: '90' }, '90°'), h('option', { value: '180' }, '180°'), h('option', { value: '270' }, '270°'));
      const fmtSel = h('select', { class: 'select input-sm' }, h('option', { value: 'keep' }, '保持原格式'), h('option', { value: 'image/jpeg' }, 'JPG'), h('option', { value: 'image/png' }, 'PNG'), h('option', { value: 'image/webp' }, 'WebP'));
      const qualityIn = h('input', { type: 'number', class: 'input input-sm', value: '85', min: '10', max: '100', style: { width: '80px' } });
      const outDirIn = h('input', { class: 'input input-sm', placeholder: '输出目录（留空=覆盖式输出到 <原图>.processed）', style: { flex: '1' } });
      const pickOutBtn = btn('选择…', 'btn-sm btn-secondary', async () => {
        const d = await invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: ['openDirectory'] });
        if (d && d[0]) outDirIn.value = d[0];
      });
      const prog = progressEl(); prog.hide();
      const status = h('span', { class: 'field-hint' }, '');
      const preview = div('');
      async function run() {
        if (running) return; // 防重入：双击「开始」会并发跑两遍
        if (!picker.count) return toast('请先选择图片', 'warn');
        running = true;
        prog.show();
        picker.setLocked(true);
        let outDir = outDirIn.value.trim();
        const paths = picker.paths.slice();
        if (!outDir) {
          const firstDir = paths[0].replace(/[\\/][^\\/]+$/, '');
          outDir = firstDir + '/hehe-processed';
          try { await invoke(Channels.CHANNELS.FS.MKDIR, outDir); } catch (e) { running = false; prog.hide(); picker.setLocked(false); return toast('创建输出目录失败：' + e.message, 'error'); }
        } else { try { await invoke(Channels.CHANNELS.FS.MKDIR, outDir); } catch (e) { running = false; prog.hide(); picker.setLocked(false); return toast('创建输出目录失败：' + e.message, 'error'); } }
        let ok = 0, fail = 0;
        preview.innerHTML = '';
        try {
        for (let i = 0; i < paths.length; i++) {
          prog.set((i + 1) / paths.length * 100);
          const p = paths[i];
          try {
            const img = await loadImg(p);
            const canvas = document.createElement('canvas');
            let w = img.naturalWidth, h2 = img.naturalHeight;
            const scale = parseInt(scaleIn.value) || 100;
            if (widthIn.value || heightIn.value) {
              if (widthIn.value && heightIn.value) { w = +widthIn.value; h2 = +heightIn.value; }
              else if (widthIn.value) { w = +widthIn.value; h2 = Math.round(w * img.naturalHeight / img.naturalWidth); }
              else { h2 = +heightIn.value; w = Math.round(h2 * img.naturalWidth / img.naturalHeight); }
            } else if (scale !== 100) { w = Math.round(w * scale / 100); h2 = Math.round(h2 * scale / 100); }
            const rot = parseInt(rotateSel.value) || 0;
            if (rot === 90 || rot === 270) { canvas.width = h2; canvas.height = w; }
            else { canvas.width = w; canvas.height = h2; }
            const ctx = canvas.getContext('2d');
            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.rotate(rot * Math.PI / 180);
            ctx.drawImage(img, -w / 2, -h2 / 2, w, h2);
            let mime = fmtSel.value;
            if (mime === 'keep') {
              const ext = p.split('.').pop().toLowerCase();
              mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
            }
            const q = Math.min(100, Math.max(10, parseInt(qualityIn.value) || 85)) / 100;
            const dataUrl = canvas.toDataURL(mime, q);
            const name = p.split(/[\\/]/).pop().replace(/\.\w+$/, mime === 'image/jpeg' ? '.jpg' : mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.' + (p.split('.').pop()));
            const outPath = outDir.replace(/[\\/]$/, '') + '/' + name;
            // 输出路径必须唯一：既要防止盖掉**输入原图**（输出目录选成原目录、
            // 格式不变时输出名与原名相同），也要防止盖掉**目录里已有的同名文件**
            // （例如 a.png 转 jpg 时会盖掉原本就存在的 a.jpg，
            //  或上一轮的输出 a.jpg 被这一轮冲掉）。
            // fs:unique-path 在目标不存在时原样返回，所以无损。
            const finalPath = await invoke(Channels.CHANNELS.FS.UNIQUE_PATH, outPath);
            await invoke(Channels.CHANNELS.FS.WRITE_FILE_B64, finalPath, dataUrl.split(',')[1]);
            ok++;
            const origSize = (await invoke(Channels.CHANNELS.FS.STAT, p)).size;
            const newSize = (await invoke(Channels.CHANNELS.FS.STAT, finalPath)).size;
            preview.appendChild(div('form-row', h('span', { class: 'tag tag-green' }, '✓'), h('span', { style: { flex: '1', fontSize: '12px', wordBreak: 'break-all' } }, name),
              h('span', { class: 'field-hint' }, `${fmtBytes(origSize)} → ${fmtBytes(newSize)}（${newSize <= origSize ? '-' : '+'}${Math.abs((1 - newSize / origSize) * 100).toFixed(0)}%）`)));
          } catch (e) { fail++; preview.appendChild(div('form-row', h('span', { class: 'tag tag-red' }, '✗'), h('span', { style: { fontSize: '12px' } }, p), h('span', { class: 'field-err' }, e.message))); }
        }
        status.textContent = `完成：成功 ${ok}，失败 ${fail}，输出目录 ${outDir}`;
        toast(`处理完成（${ok} 成功 / ${fail} 失败）`, fail ? 'warn' : 'success');
        } finally {
          // 无论成功、失败还是抛异常，都必须解锁列表并复位按钮状态，
          // 否则一次异常就让整个工具页永久不可用。
          running = false; prog.hide(); picker.setLocked(false);
        }
      }
      page.appendChild(div('card', div('card-title', '选择图片'), picker.el));
      page.appendChild(div('card', div('card-title', '处理参数'),
        div('form-row', h('span', { class: 'form-label' }, '尺寸'), h('span', { class: 'field-hint' }, '缩放%'), scaleIn, ' 或 宽', widthIn, '×高', heightIn,
          h('span', { class: 'field-hint' }, '（等比：只填一个）')),
        div('form-row', h('span', { class: 'form-label' }, '旋转'), rotateSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '格式'), fmtSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '质量'), qualityIn),
        div('form-row', h('span', { class: 'form-label' }, '输出'), outDirIn, pickOutBtn),
        div('form-row', btn('开始处理', 'btn-primary', run, 'send'), prog.el, status)));
      page.appendChild(div('card', div('card-title', '处理结果'), preview));
    }
  })
})();
