/* 模块：多媒体处理 —— 图片批量处理 / 压缩 / 水印 / 拼接 / 占位 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, dropzone, fmtBytes, progressEl } = window.ui;
  const { invoke, on, isDesktop } = window.api;
  const MOD = 'media';

  function loadImg(path, blob) {
    return new Promise(async (resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      if (blob) img.src = URL.createObjectURL(blob);
      else {
        try { const r = await invoke('fs:read-file-b64', path); img.src = 'data:image;base64,' + r.b64; }
        catch (e) { reject(e); }
      }
    });
  }
  function pickPaths(multi = true) {
    return invoke('dialog:open', { properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }] });
  }

  /* ---------- 图片批量处理 ---------- */
  register({
    id: 'img-batch', name: '图片批量处理', module: MOD, icon: 'image',
    desc: '批量缩放、旋转、格式转换（JPG/PNG/WebP）、压缩',
    keywords: ['图片', '批量', '缩放', '转换', '压缩'],
    render(page) {
      const paths = [];
      const dz = dropzone({ text: '拖入或选择要处理的图片（可多选）', onFiles: (p) => { paths.push(...p); label.textContent = `已选 ${paths.length} 张图片`; } });
      const label = div('field-hint', '未选择');
      const scaleIn = h('input', { type: 'number', class: 'input input-sm', value: '100', style: { width: '80px' } });
      const widthIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '宽', style: { width: '80px' } });
      const heightIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '高', style: { width: '80px' } });
      const rotateSel = h('select', { class: 'select input-sm' }, h('option', { value: '0' }, '不旋转'), h('option', { value: '90' }, '90°'), h('option', { value: '180' }, '180°'), h('option', { value: '270' }, '270°'));
      const fmtSel = h('select', { class: 'select input-sm' }, h('option', { value: 'keep' }, '保持原格式'), h('option', { value: 'image/jpeg' }, 'JPG'), h('option', { value: 'image/png' }, 'PNG'), h('option', { value: 'image/webp' }, 'WebP'));
      const qualityIn = h('input', { type: 'number', class: 'input input-sm', value: '85', min: '10', max: '100', style: { width: '80px' } });
      const outDirIn = h('input', { class: 'input input-sm', placeholder: '输出目录（留空=覆盖式输出到 <原图>.processed）', style: { flex: '1' } });
      const pickOutBtn = btn('选择…', 'btn-sm btn-secondary', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) outDirIn.value = d[0];
      });
      const prog = progressEl(); prog.hide();
      const status = h('span', { class: 'field-hint' }, '');
      const preview = div('');
      async function run() {
        if (!paths.length) return toast('请先选择图片', 'warn');
        prog.show();
        let outDir = outDirIn.value.trim();
        if (!outDir) {
          const firstDir = paths[0].replace(/[\\/][^\\/]+$/, '');
          outDir = firstDir + '/hehe-processed';
          try { await invoke('fs:mkdir', outDir); } catch (e) { prog.hide(); return toast('创建输出目录失败：' + e.message, 'error'); }
        } else { try { await invoke('fs:mkdir', outDir); } catch (e) { prog.hide(); return toast('创建输出目录失败：' + e.message, 'error'); } }
        let ok = 0, fail = 0;
        preview.innerHTML = '';
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
            await invoke('fs:write-file-b64', outPath, dataUrl.split(',')[1]);
            ok++;
            const origSize = (await invoke('fs:stat', p)).size;
            const newSize = (await invoke('fs:stat', outPath)).size;
            preview.appendChild(div('form-row', h('span', { class: 'tag tag-green' }, '✓'), h('span', { style: { flex: '1', fontSize: '12px', wordBreak: 'break-all' } }, name),
              h('span', { class: 'field-hint' }, `${fmtBytes(origSize)} → ${fmtBytes(newSize)}（${newSize <= origSize ? '-' : '+'}${Math.abs((1 - newSize / origSize) * 100).toFixed(0)}%）`)));
          } catch (e) { fail++; preview.appendChild(div('form-row', h('span', { class: 'tag tag-red' }, '✗'), h('span', { style: { fontSize: '12px' } }, p), h('span', { class: 'field-err' }, e.message))); }
        }
        prog.hide();
        status.textContent = `完成：成功 ${ok}，失败 ${fail}，输出目录 ${outDir}`;
        toast(`处理完成（${ok} 成功 / ${fail} 失败）`, fail ? 'warn' : 'success');
      }
      page.appendChild(div('card', div('card-title', '选择图片'), dz, label));
      page.appendChild(div('card', div('card-title', '处理参数'),
        div('form-row', h('span', { class: 'form-label' }, '尺寸'), h('span', { class: 'field-hint' }, '缩放%'), scaleIn, ' 或 宽', widthIn, '×高', heightIn,
          h('span', { class: 'field-hint' }, '（等比：只填一个）')),
        div('form-row', h('span', { class: 'form-label' }, '旋转'), rotateSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '格式'), fmtSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '质量'), qualityIn),
        div('form-row', h('span', { class: 'form-label' }, '输出'), outDirIn, pickOutBtn),
        div('form-row', btn('🚀 开始处理', 'btn-primary', run), prog.el, status)));
      page.appendChild(div('card', div('card-title', '处理结果'), preview));
    }
  });

  /* ---------- 图片水印 ---------- */
  register({
    id: 'img-watermark', name: '图片水印', module: MOD, icon: 'wand',
    desc: '批量添加文字水印，支持位置、透明度、字号设置',
    keywords: ['水印', '图片'],
    render(page) {
      const paths = [];
      const dz = dropzone({ text: '拖入或选择要加水印的图片', onFiles: (p) => { paths.push(...p); label.textContent = `已选 ${paths.length} 张`; } });
      const label = div('field-hint', '未选择');
      const textIn = h('input', { class: 'input input-sm', value: '@核核工具箱', style: { flex: '1' } });
      const posSel = h('select', { class: 'select input-sm' },
        ...[['br', '右下'], ['bl', '左下'], ['tr', '右上'], ['tl', '左上'], ['center', '正中']].map(([v, n]) => h('option', { value: v }, n)));
      const sizeIn = h('input', { type: 'number', class: 'input input-sm', value: '28', style: { width: '80px' } });
      const opacityIn = h('input', { type: 'number', class: 'input input-sm', value: '50', min: '5', max: '100', style: { width: '80px' } });
      const preview = div('');
      const prog = progressEl(); prog.hide();
      async function run() {
        if (!paths.length) return toast('请先选择图片', 'warn');
        if (!textIn.value.trim()) return toast('请输入水印文字', 'warn');
        prog.show();
        const firstDir = paths[0].replace(/[\\/][^\\/]+$/, '');
        const outDir = firstDir + '/hehe-watermark';
        try { await invoke('fs:mkdir', outDir); } catch (e) { prog.hide(); return toast('创建输出目录失败：' + e.message, 'error'); }
        let ok = 0;
        for (let i = 0; i < paths.length; i++) {
          prog.set((i + 1) / paths.length * 100);
          try {
            const p = paths[i];
            const img = await loadImg(p);
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const fontSize = Math.max(12, Math.min(parseInt(sizeIn.value) || 28, canvas.width / 4));
            ctx.font = `${fontSize}px "Microsoft YaHei", sans-serif`;
            ctx.globalAlpha = (parseInt(opacityIn.value) || 50) / 100;
            ctx.fillStyle = '#FFFFFF';
            ctx.strokeStyle = 'rgba(0,0,0,0.5)';
            ctx.lineWidth = Math.max(1, fontSize / 14);
            const m = ctx.measureText(textIn.value);
            const pad = fontSize * 0.6;
            const pos = posSel.value;
            let x, y;
            if (pos === 'center') { x = (canvas.width - m.width) / 2; y = canvas.height / 2; }
            else {
              x = pos.includes('r') ? canvas.width - m.width - pad : pad;
              y = pos.includes('b') ? canvas.height - pad : pad + fontSize;
            }
            ctx.strokeText(textIn.value, x, y);
            ctx.fillText(textIn.value, x, y);
            const ext = p.split('.').pop().toLowerCase();
            const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
            const dataUrl = canvas.toDataURL(mime, 0.92);
            const name = p.split(/[\\/]/).pop();
            await invoke('fs:write-file-b64', outDir + '/' + name.replace(/\.(\w+)$/, '_wm.$1'), dataUrl.split(',')[1]);
            ok++;
            if (i === 0) {
              preview.innerHTML = '';
              preview.appendChild(h('img', { src: dataUrl, style: { maxWidth: '100%', maxHeight: '300px', borderRadius: '8px', border: '1px solid var(--border)' } }));
            }
          } catch (e) { console.error(e); }
        }
        prog.hide();
        toast(`完成，成功 ${ok} 张，输出：${outDir}`, 'success');
      }
      page.appendChild(div('card', div('card-title', '选择图片'), dz, label));
      page.appendChild(div('card', div('card-title', '水印设置'),
        div('form-row', h('span', { class: 'form-label' }, '文字'), textIn),
        div('form-row', h('span', { class: 'form-label' }, '位置'), posSel, ' 字号', sizeIn, ' 透明度%', opacityIn),
        div('form-row', btn('💧 添加水印', 'btn-primary', run), prog.el)));
      page.appendChild(div('card', div('card-title', '首图预览'), preview));
    }
  });

  /* ---------- 长截图拼接 ---------- */
  register({
    id: 'img-stitch', name: '长截图拼接', module: MOD, icon: 'merge',
    desc: '多张截图纵向/横向拼接为一张长图',
    keywords: ['拼接', '长图', '截图'],
    render(page) {
      let imgs = [];
      const listEl = div('');
      const canvasBox = div('');
      let direction = 'v';
      const dz = dropzone({
        text: '按顺序拖入多张截图（文件名排序）',
        onFiles: async (paths) => {
          for (const p of paths) {
            try { imgs.push({ path: p, img: await loadImg(p) }); } catch (e) { toast(p + ': ' + e.message, 'error'); }
          }
          imgs.sort((a, b) => a.path.localeCompare(b.path, 'zh', { numeric: true }));
          drawList();
        }
      });
      function drawList() {
        listEl.innerHTML = '';
        listEl.appendChild(div('field-hint', `已添加 ${imgs.length} 张（顺序即拼接顺序）`));
        imgs.forEach((it, i) => {
          listEl.appendChild(div('form-row',
            h('span', { class: 'tag tag-gray' }, String(i + 1)),
            h('img', { src: it.img.src, style: { height: '36px', borderRadius: '4px' } }),
            h('span', { style: { flex: '1', fontSize: '12px', wordBreak: 'break-all' } }, it.path.split(/[\\/]/).pop()),
            btn('上移', 'btn-sm btn-text', () => { if (i > 0) { [imgs[i - 1], imgs[i]] = [imgs[i], imgs[i - 1]]; drawList(); } }),
            btn('移除', 'btn-sm btn-text', () => { imgs.splice(i, 1); drawList(); })));
        });
      }
      async function stitch() {
        if (imgs.length < 2) return toast('至少需要两张图片', 'warn');
        const isV = direction === 'v';
        let size = imgs.reduce((s, it) => isV ? Math.max(s, it.img.naturalWidth) : s + it.img.naturalHeight, 0);
        const canvas = document.createElement('canvas');
        if (isV) {
          canvas.width = Math.max(...imgs.map(i => i.img.naturalWidth));
          canvas.height = imgs.reduce((s, i) => s + i.img.naturalHeight, 0);
        } else {
          canvas.width = imgs.reduce((s, i) => s + i.img.naturalWidth, 0);
          canvas.height = Math.max(...imgs.map(i => i.img.naturalHeight));
        }
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        let x = 0, y = 0;
        for (const it of imgs) {
          ctx.drawImage(it.img, x, y);
          if (isV) y += it.img.naturalHeight; else x += it.img.naturalWidth;
        }
        canvasBox.innerHTML = '';
        canvas.style.maxWidth = '100%';
        canvas.style.border = '1px solid var(--border)';
        canvas.style.borderRadius = '8px';
        canvasBox.appendChild(canvas);
        const b64 = canvas.toDataURL('image/png').split(',')[1];
        const outDefault = (imgs[0].path.replace(/[\\/][^\\/]+$/, '')) + (isV ? '/stitch-v.png' : '/stitch-h.png');
        const saveBtn = btn('💾 保存 PNG', 'btn-primary btn-sm', async () => {
          try {
            const p = await invoke('dialog:save', { defaultPath: outDefault });
            if (!p) return;
            await invoke('fs:write-file-b64', p, b64);
            toast('已保存：' + p, 'success');
          } catch (e) { toast(e.message || String(e), 'error'); }
        });
        canvasBox.appendChild(div('form-row', saveBtn, h('span', { class: 'field-hint' }, `${canvas.width}×${canvas.height}px`)));
      }
      page.appendChild(div('card', div('card-title', '添加图片'), dz, listEl));
      page.appendChild(div('card', div('card-title', '拼接'),
        div('form-row', btn('纵向拼接 ↓', 'btn-sm ' + (direction === 'v' ? 'btn-primary' : 'btn-secondary'), (e) => { direction = 'v'; stitch(); }),
          btn('横向拼接 →', 'btn-sm btn-secondary', () => { direction = 'h'; stitch(); })),
        canvasBox));
    }
  });

  /* ---------- EXIF 查看（基础） ---------- */
  register({
    id: 'exif-view', name: 'EXIF 信息查看', module: MOD, icon: 'eye',
    desc: '查看 JPEG 拍摄参数（时间/设备/GPS），支持一键清除',
    keywords: ['exif', '照片', '信息', '隐私'],
    render(page) {
      const result = div('');
      const dz = dropzone({
        text: '拖入 JPEG 照片查看 EXIF',
        multiple: false,
        onFiles: async (paths) => {
          result.innerHTML = '';
          try {
            const r = await invoke('fs:read-file-b64', paths[0]);
            const buf = Uint8Array.from(atob(r.b64), c => c.charCodeAt(0));
            const exif = parseExif(buf);
            if (!exif || !Object.keys(exif).length) { result.appendChild(div('empty-tip', '未找到 EXIF 信息（可能已被清除或不是照片）')); return; }
            const card = div('card');
            card.style.border = '1px solid var(--border)';
            card.appendChild(window.ui.kvGrid(Object.entries(exif)));
            result.appendChild(card);
            const cleanBtn = btn('🧹 清除 EXIF 并保存副本', 'btn-danger-plain', async () => {
              const out = paths[0].replace(/\.jpe?g$/i, '') + '-noexif.jpg';
              await invoke('fs:write-file-b64', out, stripExif(buf));
              toast('已保存无 EXIF 副本：' + out, 'success');
            });
            result.appendChild(div('form-row', cleanBtn));
          } catch (e) { result.innerHTML = `<div class="field-err">${escapeHtml(e.message)}</div>`; }
        }
      });
      function parseExif(buf) {
        try {
          let offset = 2;
          const dv = new DataView(buf.buffer);
          while (offset < buf.length) {
            if (buf[offset] !== 0xFF) { offset++; continue; }
            const marker = buf[offset + 1];
            const size = dv.getUint16(offset + 2);
            if (marker === 0xE1 && offset + 4 < buf.length) {
              // APP1 check Exif
              const head = String.fromCharCode(...buf.slice(offset + 4, offset + 10));
              if (head === 'Exif\u0000') return parseTiff(offset + 10);
            }
            if (marker === 0xDA) break; // SOS
            offset += 2 + size;
          }
          return null;
        } catch (e) { return null; }
      }
      function parseTiff(start) {
        // DataView 基于完整 buffer，配合 base 偏移读取
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const base = start;
        const little = dv.getUint16(base) === 0x4949;
        const g16 = (o) => dv.getUint16(base + o, little);
        const g32 = (o) => dv.getUint32(base + o, little);
        const ifd = g32(4);
        const TAGS = { 0x010F: '相机制造商', 0x0110: '相机型号', 0x0112: '方向', 0x0132: '拍摄时间', 0x8769: '_exifIFD', 0x8827: 'ISO', 0x829A: '曝光时间', 0x829D: '光圈值(F)', 0x920A: '焦距(mm)', 0xA002: '图像宽度', 0xA003: '图像高度', 0x9003: '原始时间', 0x0002: '' };
        const out = {};
        function readIFD(off) {
          const count = g16(off);
          for (let i = 0; i < count; i++) {
            const e = off + 2 + i * 12;
            const tag = g16(e), type = g16(e + 2), num = g32(e + 4);
            const name = TAGS[tag];
            if (!name || name.startsWith('_')) {
              if (tag === 0x8769) { const sub = g32(e + 8); readIFD(sub); }
              continue;
            }
            let val;
            if (type === 2) {
              const len = num;
              let s = '';
              const valOff = num <= 4 ? e + 8 : base + g32(e + 8);
              for (let j = 0; j < len - 1 && j < 64; j++) s += String.fromCharCode(dv.getUint8(valOff + j));
              val = s;
            } else if (type === 3) val = g16(e + 8);
            else if (type === 4) val = g32(e + 8);
            else if (type === 5) {
              const vOff = base + g32(e + 8);
              val = num > 0 ? (g32(e + 8) ? (dv.getUint32(vOff, little) / dv.getUint32(vOff + 4, little)).toFixed(2) : '-') : '-';
            } else val = g32(e + 8);
            if (val !== '' && val != null) out[name] = String(val);
          }
        }
        readIFD(ifd);
        return out;
      }
      function stripExif(b) {
        // remove APP1 segment
        const dv = new DataView(b.buffer);
        let offset = 2;
        while (offset < b.length) {
          if (b[offset] !== 0xFF) { offset++; continue; }
          const marker = b[offset + 1];
          const size = dv.getUint16(offset + 2);
          if (marker === 0xE1) {
            const out = new Uint8Array(b.length - (2 + size));
            out.set(b.subarray(0, offset), 0);
            out.set(b.subarray(offset + 2 + size), offset);
            let bin = '';
            for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
            return btoa(bin);
          }
          if (marker === 0xDA) break;
          offset += 2 + size;
        }
        return btoa(String.fromCharCode(...b));
      }
      page.appendChild(div('card', div('card-title', '照片'), dz, result));
    }
  });

  /* ---------- FFmpeg 环境 ---------- */
  register({
    id: 'ffmpeg-setup', name: 'FFmpeg 环境', module: MOD, icon: 'film',
    desc: '一键下载/导入 ffmpeg 与 ffprobe，为音视频功能提供引擎',
    keywords: ['ffmpeg', 'ffprobe', '环境', '引擎'],
    render(page) {
      const statusBox = div('');
      const prog = progressEl(); prog.hide();
      const status = h('div', { class: 'field-hint' }, '');
      async function refresh() {
        statusBox.innerHTML = '';
        statusBox.appendChild(window.ui.loadingBlock('检测 FFmpeg…'));
        try {
          const r = await invoke('ffmpeg:status');
          statusBox.innerHTML = '';
          const card = div('card');
          card.style.border = '1px solid var(--border)';
          if (r.ffmpeg) {
            card.appendChild(window.ui.kvGrid([
              ['状态', '✓ 已就绪'], ['ffmpeg', r.ffmpeg], ['ffprobe', r.ffprobe || '未找到（转换功能需要）'], ['版本', r.version || '-']
            ]));
            card.appendChild(div('form-row', btn('🗑 移除内置 FFmpeg', 'btn-sm btn-danger-plain', async () => {
              if (!(await confirmBox({ title: '移除 FFmpeg', message: '将删除内置下载的 ffmpeg/ffprobe，确定？', danger: true, okText: '移除' }))) return;
              await invoke('ffmpeg:remove');
              toast('已移除', 'success');
              refresh();
            })));
          } else {
            card.appendChild(div('', h('p', { class: 'field-hint', style: { textAlign: 'left', lineHeight: 1.8 } },
              '尚未检测到 FFmpeg。安装后即可使用「音视频信息查看」「音视频格式转换」工具；',
              '也可以从 ffmpeg.org 下载后手动导入。')));
          }
          statusBox.appendChild(card);
        } catch (e) { statusBox.innerHTML = `<div class="field-err">${escapeHtml(e.message)}</div>`; }
      }
      const srcSel = h('select', { class: 'select input-sm', style: { flex: '1' } },
        h('option', { value: 'npmmirror' }, 'npmmirror 国内镜像（推荐，约 59MB，含 ffprobe）'),
        h('option', { value: 'gyan' }, 'gyan.dev 官方整合包（约 114MB）'),
        h('option', { value: 'btbn' }, 'BtbN GitHub 构建（约 90MB）'));
      const dlBtn = btn('⬇ 一键下载安装', 'btn-primary', async () => {
        if (!isDesktop) return toast('桌面端可用', 'warn');
        dlBtn.disabled = true;
        prog.show(); status.textContent = '';
        let unsub = null;
        try {
          unsub = on('job:stream', (d) => {
            try {
              const j = JSON.parse(d.data);
              if (j.stage === 'extract') { status.textContent = '下载完成，正在解压…'; return; }
              if (j.totalMB) status.textContent = `下载中 ${j.mb.toFixed(1)} / ${j.totalMB.toFixed(1)} MB（${(j.pct || 0).toFixed(0)}%）`;
              prog.set(j.pct || 0);
            } catch (e) {}
          });
          const r = await invoke('ffmpeg:download', srcSel.value);
          toast('FFmpeg 安装完成', 'success');
          status.textContent = '✓ 安装完成：' + (r.ffmpeg || '');
        } catch (e) { status.innerHTML = `<span class="status-err">✗ ${escapeHtml(e.message)}</span>`; toast(e.message, 'error'); }
        finally { dlBtn.disabled = false; prog.hide(); if (unsub) unsub(); refresh(); }
      });
      const pickBtn = btn('📁 手动导入 ffmpeg.exe', 'btn-secondary', async () => {
        try {
          const r = await invoke('ffmpeg:pick');
          if (r.picked && r.picked.length) { toast('已导入：' + r.picked.join('、'), 'success'); refresh(); }
        } catch (e) { toast(e.message, 'error'); }
      });
      page.appendChild(div('card', div('card-title', '当前状态'), statusBox));
      page.appendChild(div('card', div('card-title', '安装 FFmpeg'),
        div('form-row', h('span', { class: 'form-label' }, '下载源'), srcSel),
        div('form-row', dlBtn, ' ', pickBtn),
        prog.el, status,
        div('field-hint', '安装位置：用户数据目录 bin 文件夹；也可手动导入。转 GIF / H.265 等完整功能由同一引擎提供。')));
      refresh();
    }
  });

  /* ---------- 音视频信息查看（ffprobe） ---------- */
  register({
    id: 'av-info', name: '音视频信息查看', module: MOD, icon: 'film',
    desc: '查看音视频编码、分辨率、码率、时长、声道等元数据（基于 ffprobe）',
    keywords: ['音视频', '信息', 'ffprobe', '元数据'],
    render(page) {
      const result = div('');
      function evalFps(fr) { try { const [a, b] = fr.split('/').map(Number); return b ? a / b : 0; } catch (e) { return 0; } }
      async function probe(p) {
        result.innerHTML = '';
        result.appendChild(window.ui.loadingBlock('读取媒体信息…'));
        try {
          const m = await invoke('ffmpeg:probe', p);
          result.innerHTML = '';
          const fmt = m.format || {};
          const card = div('card');
          card.style.border = '1px solid var(--border)';
          card.appendChild(div('card-title', '容器信息'));
          card.appendChild(window.ui.kvGrid([
            ['文件', (fmt.filename || '').split(/[\\/]/).pop()],
            ['大小', fmtBytes(Number(fmt.size) || 0)],
            ['时长', fmt.duration ? Number(fmt.duration).toFixed(2) + ' 秒' : '-'],
            ['总码率', fmt.bit_rate ? (Number(fmt.bit_rate) / 1000).toFixed(0) + ' kbps' : '-'],
            ['封装格式', fmt.format_long_name || '-']
          ]));
          result.appendChild(card);
          const streams = (m.streams || []).map((st, i) => ({
            i: i + 1,
            type: st.codec_type === 'video' ? '视频' : st.codec_type === 'audio' ? '音频' : st.codec_type,
            codec: (st.codec_name || '-') + (st.profile ? ' (' + st.profile + ')' : ''),
            spec: st.codec_type === 'video'
              ? (st.width && st.height ? `${st.width}×${st.height}` : '-') + (st.avg_frame_rate && st.avg_frame_rate !== '0/0' ? ' @ ' + evalFps(st.avg_frame_rate).toFixed(1) + 'fps' : '')
              : (st.sample_rate ? (st.sample_rate / 1000) + ' kHz' : '-') + (st.channels ? ' · ' + st.channels + ' 声道' : ''),
            bitrate: st.bit_rate ? (Number(st.bit_rate) / 1000).toFixed(0) + ' kbps' : '-'
          }));
          const sc = div('card');
          sc.style.border = '1px solid var(--border)';
          sc.appendChild(div('card-title', `流信息（${streams.length} 条）`));
          sc.appendChild(renderTable({
            columns: [
              { key: 'i', title: '#', width: '40px' },
              { key: 'type', title: '类型', width: '70px', render: r => h('span', { class: 'tag ' + (r.type === '视频' ? 'tag-blue' : 'tag-green') }, r.type) },
              { key: 'codec', title: '编码' },
              { key: 'spec', title: '规格' },
              { key: 'bitrate', title: '码率', width: '100px' }
            ],
            rows: streams
          }));
          result.appendChild(sc);
        } catch (e) {
          result.innerHTML = '';
          if (/ffprobe/.test(e.message)) {
            result.appendChild(window.ui.placeholder('film', '需要 FFmpeg 引擎', '音视频信息查看依赖 ffprobe。点击下方按钮前往安装（只需一次）。'));
            result.appendChild(div('form-row', btn('🛠 前往 FFmpeg 环境安装', 'btn-primary', () => window.App.openTool('ffmpeg-setup'))));
          } else result.innerHTML = `<div class="field-err">${escapeHtml(e.message)}</div>`;
        }
      }
      const dz = dropzone({ text: '拖入音视频文件查看信息', multiple: false, onFiles: (paths) => paths[0] && probe(paths[0]) });
      page.appendChild(div('card', dz, result));
      invoke('ffmpeg:status').then(r => { if (!r.ffmpeg) probe(''); }).catch(() => {});
    }
  });

  /* ---------- 音视频格式转换（ffmpeg） ---------- */
  register({
    id: 'av-convert', name: '音视频格式转换', module: MOD, icon: 'film',
    desc: '批量转换格式、压缩、提取音频、转 GIF（基于 ffmpeg，可配参数）',
    keywords: ['转换', 'ffmpeg', '压缩', '音频', 'gif'],
    render(page) {
      const files = [];
      const dz = dropzone({ text: '拖入或选择要转换的音视频文件（可多选）', onFiles: (p) => { files.push(...p); label.textContent = `已选 ${files.length} 个文件`; refreshList(); } });
      const label = div('field-hint', '未选择');
      const fmtSel = h('select', { class: 'select input-sm' },
        ...['mp4', 'mkv', 'webm', 'mp3', 'm4a', 'wav', 'flac', 'gif'].map(f => h('option', { value: f }, f.toUpperCase())));
      const vcodecSel = h('select', { class: 'select input-sm' },
        h('option', { value: '' }, 'H.264（兼容最好）'), h('option', { value: 'libx265' }, 'H.265（体积更小）'), h('option', { value: 'copy' }, '直接复制不重编码'));
      const crfIn = h('input', { type: 'number', class: 'input input-sm', value: '23', min: '14', max: '34', style: { width: '64px' }, title: '质量：越小越清晰、体积越大' });
      const scaleSel = h('select', { class: 'select input-sm' },
        h('option', { value: '' }, '保持原分辨率'), h('option', { value: '1920' }, '1080p'), h('option', { value: '1280' }, '720p'), h('option', { value: '854' }, '480p'));
      const fpsIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '帧率', style: { width: '64px' } });
      const muteChk = h('input', { type: 'checkbox', class: 'checkbox' });
      const ssIn = h('input', { class: 'input input-sm mono', placeholder: '00:00', style: { width: '70px' } });
      const toIn = h('input', { class: 'input input-sm mono', placeholder: '00:30', style: { width: '70px' } });
      const gifWIn = h('input', { type: 'number', class: 'input input-sm', value: '480', style: { width: '64px' } });
      const outDirIn = h('input', { class: 'input input-sm', placeholder: '输出目录（留空=源文件目录）', style: { flex: '1' } });
      const pickOutBtn = btn('选择…', 'btn-sm btn-secondary', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) outDirIn.value = d[0];
      });
      const listBox = div('');
      const status = h('div', { class: 'field-hint' }, '');
      let running = false;
      const startBtn = btn('🚀 开始转换', 'btn-primary', run);
      const cancelBtn = btn('■ 取消', 'btn-danger-plain', () => invoke('job:cancel-latest').catch(() => {}));
      cancelBtn.disabled = true;
      function refreshList() {
        listBox.innerHTML = '';
        files.forEach((f, i) => {
          const row = div('form-row');
          row.dataset.i = i;
          const tag = h('span', { class: 'tag tag-gray av-tag', style: { width: '64px', justifyContent: 'center' } }, '等待中');
          row.appendChild(tag);
          row.appendChild(h('span', { style: { flex: '1', fontSize: '12px', wordBreak: 'break-all' } }, f.split(/[\\/]/).pop()));
          row.appendChild(h('span', { class: 'field-hint' }, '→ ' + fmtSel.value.toUpperCase()));
          const bar = div('progress', { style: { width: '140px' } });
          bar.appendChild(div('progress-fill'));
          row.appendChild(bar);
          row.appendChild(h('span', { class: 'field-err av-err', style: { fontSize: '11px', maxWidth: '220px' } }, ''));
          listBox.appendChild(row);
        });
      }
      fmtSel.addEventListener('change', refreshList);
      async function run() {
        if (!files.length) return toast('请先选择文件', 'warn');
        if (running) return;
        const st = await invoke('ffmpeg:status').catch(() => ({ ffmpeg: null }));
        if (!st.ffmpeg) {
          toast('未安装 FFmpeg，请先前往「FFmpeg 环境」安装', 'warn');
          window.App.openTool('ffmpeg-setup');
          return;
        }
        running = true; startBtn.disabled = true; cancelBtn.disabled = false;
        status.textContent = '';
        const outDir = outDirIn.value.trim() || files[0].replace(/[\\/][^\\/]*$/, '');
        const unsub = on('job:stream', (d) => {
          try {
            const j = JSON.parse(d.data);
            const row = listBox.querySelector(`[data-i="${j.i}"]`);
            if (!row) return;
            const tag = row.querySelector('.av-tag');
            const bar = row.querySelector('.progress-fill');
            if (j.stage === 'start') { if (tag) { tag.textContent = '转换中'; tag.className = 'tag tag-orange'; } return; }
            if (j.pct != null && bar) bar.style.width = (j.pct || 0) + '%';
            if (j.done && tag) { tag.textContent = j.ok ? '✓ 完成' : '✗ 失败'; tag.className = 'tag ' + (j.ok ? 'tag-green' : 'tag-red'); }
          } catch (e) {}
        });
        if (window.App && App.onCleanup) App.onCleanup(unsub);
        try {
          const r = await invoke('ffmpeg:convert', {
            items: [...files], outDir,
            opts: {
              format: fmtSel.value, vcodec: vcodecSel.value, crf: parseInt(crfIn.value) || 23,
              scale: scaleSel.value, fps: fpsIn.value ? parseInt(fpsIn.value) : null,
              mute: muteChk.checked, ss: ssIn.value.trim(), to: toIn.value.trim(),
              gifWidth: parseInt(gifWIn.value) || 480
            }
          });
          r.results.forEach((res, i) => {
            const row = listBox.querySelector(`[data-i="${i}"]`);
            if (row && !res.ok) {
              const tag = row.querySelector('.av-tag');
              if (tag) { tag.textContent = '✗ 失败'; tag.className = 'tag tag-red'; }
              const errEl = row.querySelector('.av-err'); if (errEl) errEl.textContent = res.err;
            }
          });
          const okN = r.results.filter(x => x.ok).length;
          status.textContent = `完成：成功 ${okN} / 失败 ${r.results.length - okN}，输出目录 ${outDir}`;
          toast(`转换完成（${okN}/${r.results.length}）`, okN ? 'success' : 'error');
        } catch (e) {
          status.innerHTML = `<span class="status-err">✗ ${escapeHtml(e.message)}</span>`;
          toast(e.message, 'error');
        } finally { running = false; startBtn.disabled = false; cancelBtn.disabled = true; unsub(); }
      }
      page.appendChild(div('card', div('card-title', '选择文件'), dz, label, listBox));
      page.appendChild(div('card', div('card-title', '转换参数'),
        div('form-row', h('span', { class: 'form-label' }, '目标格式'), fmtSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '视频编码'), vcodecSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '质量CRF'), crfIn),
        div('form-row', h('span', { class: 'form-label' }, '分辨率'), scaleSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '帧率'), fpsIn,
          h('label', { class: 'field-hint' }, muteChk, ' 移除音频')),
        div('form-row', h('span', { class: 'form-label' }, '剪辑'), '从', ssIn, '持续(秒)', toIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, 'GIF宽度'), gifWIn),
        div('form-row', h('span', { class: 'form-label' }, '输出'), outDirIn, pickOutBtn),
        div('form-row', startBtn, ' ', cancelBtn, status)));
    }
  });

  /* ---------- 截图 OCR（tesseract.js 本地识别） ---------- */
  register({
    id: 'screenshot-ocr', name: '截图 OCR 文字识别', module: MOD, icon: 'eye',
    desc: '粘贴截图或选择图片，本地识别中英文文字（首次需下载语言包）',
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
      // 截图标注/托盘 OCR 直达：带图打开本工具
      if (window.__ocrPendingPath) {
        const p = window.__ocrPendingPath;
        window.__ocrPendingPath = null;
        setTimeout(() => handleFile(p).catch(() => {}), 200);
      }
      async function recognize() {
        if (!currentImg) return toast('请先提供图片', 'warn');
        if (!window.Tesseract) return toast('OCR 引擎未加载，请重启应用', 'error');
        result.value = ''; prog.show();
        status.textContent = '初始化 OCR 引擎（首次识别需下载语言包，请耐心等待）…';
        try {
          const r = await window.Tesseract.recognize(currentImg, langSel.value, {
            workerPath: 'node_modules/tesseract.js/dist/worker.min.js',
            corePath: 'node_modules/tesseract.js-core',
            logger: (m) => {
              if (m.progress != null) {
                status.textContent = (m.status || '处理中') + ' ' + (m.progress * 100).toFixed(0) + '%';
                prog.set(m.progress * 100);
              }
            }
          });
          result.value = (r.data.text || '').trim();
          status.textContent = `✓ 识别完成（置信度 ${(r.data.confidence || 0).toFixed(0)}%）`;
          prog.hide();
          toast('识别完成', 'success');
        } catch (e) {
          prog.hide();
          status.innerHTML = `<span class="status-err">✗ ${escapeHtml(e.message)}（语言包需联网下载一次，之后离线可用）</span>`;
          toast('识别失败：' + e.message, 'error');
        }
      }
      async function fromBlob(blob) {
        currentImg = blob;
        preview.innerHTML = '';
        preview.appendChild(h('img', { src: URL.createObjectURL(blob), style: { maxWidth: '100%', maxHeight: '240px', borderRadius: '8px' } }));
      }
      async function handleFile(pathArg, blob) {
        if (blob) return fromBlob(blob);
        const r = await invoke('fs:read-file-b64', pathArg);
        const bin = Uint8Array.from(atob(r.b64), c => c.charCodeAt(0));
        const type = pathArg.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        await fromBlob(new Blob([bin], { type }));
      }
      const dz = dropzone({
        text: '拖入或选择图片（PNG/JPG）',
        multiple: false,
        onFiles: (paths, blobs) => {
          if (blobs && blobs.length && !paths.length) handleFile(null, blobs[0]);
          else handleFile(paths[0]);
        }
      });
      page.addEventListener('paste', async (e) => {
        const items = [...((e.clipboardData || {}).items || [])];
        const imgItem = items.find(i => i.type.startsWith('image/'));
        if (imgItem) { await fromBlob(imgItem.getAsFile()); toast('已读取剪贴板截图', 'success', 1200); }
      });
      const pasteBtn = btn('📋 粘贴截图（Win+Shift+S 后点这里）', 'btn-secondary', async () => {
        try {
          const imgData = await invoke('clip:read-image');
          if (!imgData) return toast('剪贴板中没有图片', 'warn');
          const bin = Uint8Array.from(atob(imgData.split(',')[1]), c => c.charCodeAt(0));
          await fromBlob(new Blob([bin], { type: 'image/png' }));
        } catch (e) { toast(e.message, 'error'); }
      });
      page.appendChild(div('card', div('card-title', '图片'),
        div('form-row', pasteBtn, ' ', h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '语言'), langSel),
        dz, preview));
      page.appendChild(div('card', div('card-title', '识别'),
        div('form-row', btn('🔍 开始识别', 'btn-primary', recognize), prog.el, status),
        result,
        div('form-row', btn('复制结果', 'btn-sm btn-secondary', () => result.value && copyText(result.value)))));
    }
  });

  /* ---------- 图片压缩 ---------- */
  register({
    id: 'img-compress', name: '图片压缩', module: MOD, icon: 'image',
    desc: '智能压缩 / 指定质量 / 压到目标体积，JPG·WebP·PNG 输出与前后大小对比',
    keywords: ['压缩', '图片', '体积', 'webp', '缩小', '瘦身'],
    render(page) {
      const paths = [];
      const dz = dropzone({ text: '拖入或选择要压缩的图片（可多选）', onFiles: (p) => { paths.push(...p); label.textContent = `已选 ${paths.length} 张图片`; } });
      const label = div('field-hint', '未选择');
      const modeSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'smart' }, '智能压缩（推荐）'),
        h('option', { value: 'target' }, '压到目标体积'),
        h('option', { value: 'quality' }, '指定质量'));
      const qualityIn = h('input', { type: 'number', class: 'input input-sm', value: '80', min: '10', max: '100', style: { width: '70px' } });
      const targetIn = h('input', { type: 'number', class: 'input input-sm', value: '200', min: '5', style: { width: '80px' }, title: '每张压到不超过该体积（KB），质量逐级自动降低' });
      const maxWIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '不限', style: { width: '70px' }, title: '最大宽度（px），超出等比缩小' });
      const fmtSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'smart' }, '智能（透明→WebP，其余→JPG）'),
        h('option', { value: 'image/jpeg' }, 'JPG'),
        h('option', { value: 'image/webp' }, 'WebP'),
        h('option', { value: 'image/png' }, 'PNG'));
      const outDirIn = h('input', { class: 'input input-sm', placeholder: '输出目录（留空 = 原图目录/hehe-compressed）', style: { flex: '1' } });
      const pickOutBtn = btn('选择…', 'btn-sm btn-secondary', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) outDirIn.value = d[0];
      });
      const refreshMode = () => {
        qualityIn.disabled = modeSel.value !== 'quality';
        targetIn.disabled = modeSel.value !== 'target';
      };
      modeSel.addEventListener('change', refreshMode); refreshMode();
      const listBox = div('');
      const prog = progressEl(); prog.hide();
      const status = h('span', { class: 'field-hint' }, '');
      let running = false;
      const startBtn = btn('🚀 开始压缩', 'btn-primary', run);

      function hasAlpha(img) {
        const c = document.createElement('canvas');
        const w = c.width = Math.min(img.naturalWidth || 1, 64), hh = c.height = Math.min(img.naturalHeight || 1, 64);
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, w, hh);
        const d = ctx.getImageData(0, 0, w, hh).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
        return false;
      }
      function dataUrlBytes(du) { return Math.floor(du.length * 3 / 4); }
      function drawTo(img, mime, q, dimScale) {
        const mw = parseInt(maxWIn.value) || 0;
        let w = img.naturalWidth * (dimScale || 1), h2 = img.naturalHeight * (dimScale || 1);
        if (mw && w > mw) { h2 = h2 * mw / w; w = mw; }
        w = Math.max(1, Math.round(w)); h2 = Math.max(1, Math.round(h2));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h2;
        const ctx = canvas.getContext('2d');
        if (mime === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h2); }
        ctx.drawImage(img, 0, 0, w, h2);
        return canvas.toDataURL(mime, q);
      }
      function encodeTarget(img, mime, targetKB) {
        const target = Math.max(5, targetKB) * 1024;
        let dimScale = 1;
        for (let round = 0; round < 4; round++) {
          let lo = 5, hi = 95, best = null, bestSize = Infinity;
          while (lo <= hi) {
            const q = Math.round((lo + hi) / 2);
            const du = drawTo(img, mime, q / 100, dimScale);
            const size = dataUrlBytes(du);
            if (size <= target) { if (best === null || size > bestSize) { best = du; bestSize = size; } lo = q + 1; }
            else hi = q - 1;
          }
          if (best) return best;
          if (round === 3) return drawTo(img, mime, 0.05, dimScale);
          dimScale *= 0.7;
        }
      }
      async function run() {
        if (!paths.length) return toast('请先选择图片', 'warn');
        if (running) return;
        running = true; startBtn.disabled = true;
        prog.show(); status.textContent = ''; listBox.innerHTML = '';
        const outDir = outDirIn.value.trim() || (paths[0].replace(/[\\/][^\\/]+$/, '') + '/hehe-compressed');
        try { await invoke('fs:mkdir', outDir); } catch (e) {}
        let totalBefore = 0, totalAfter = 0, ok = 0, fail = 0;
        for (let i = 0; i < paths.length; i++) {
          prog.set((i + 1) / paths.length * 100);
          const p = paths[i];
          const name = p.split(/[\\/]/).pop();
          const row = div('form-row', h('span', { style: { flex: '1', fontSize: '12px', wordBreak: 'break-all' } }, name),
            h('span', { class: 'field-hint comp-size' }, '…'),
            h('span', { class: 'tag tag-gray', style: { minWidth: '64px', justifyContent: 'center' } }, '压缩中'));
          listBox.appendChild(row);
          try {
            const img = await loadImg(p);
            const orig = (await invoke('fs:stat', p)).size;
            let mime;
            if (fmtSel.value === 'smart') mime = hasAlpha(img) ? 'image/webp' : 'image/jpeg';
            else mime = fmtSel.value;
            let du;
            if (modeSel.value === 'target') {
              du = encodeTarget(img, mime, parseInt(targetIn.value) || 200);
            } else if (modeSel.value === 'smart') {
              const du80 = drawTo(img, mime, 0.8, 1);
              if (dataUrlBytes(du80) < orig * 0.92) du = du80;
              else {
                const du60 = drawTo(img, mime, 0.6, 1);
                du = dataUrlBytes(du60) < dataUrlBytes(du80) ? du60 : du80;
              }
            } else {
              du = drawTo(img, mime, Math.min(100, Math.max(10, parseInt(qualityIn.value) || 80)) / 100, 1);
            }
            const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png';
            // 同名不同扩展（a.png + a.jpg → 都是 a.jpg）时自动加序号，避免互相覆盖
            let outPath = outDir.replace(/[\\/]$/, '') + '/' + name.replace(/\.\w+$/, '') + ext;
            outPath = await invoke('fs:unique-path', outPath);
            await invoke('fs:write-file-b64', outPath, du.split(',')[1]);
            const newSize = (await invoke('fs:stat', outPath)).size;
            ok++; totalBefore += orig; totalAfter += newSize;
            const pct = Math.round((1 - newSize / orig) * 100);
            const sizeEl = row.querySelector('.comp-size'), tagEl = row.querySelector('.tag');
            sizeEl.textContent = `${fmtBytes(orig)} → ${fmtBytes(newSize)}`;
            tagEl.textContent = pct >= 0 ? `-${pct}%` : `+${-pct}%`;
            tagEl.className = 'tag ' + (pct >= 0 ? 'tag-green' : 'tag-orange');
          } catch (e) {
            fail++;
            const tagEl = row.querySelector('.tag'); tagEl.textContent = '✗'; tagEl.className = 'tag tag-red';
            row.appendChild(h('span', { class: 'field-err', style: { fontSize: '11px', maxWidth: '220px' } }, (e && e.message) || String(e)));
          }
        }
        prog.hide(); running = false; startBtn.disabled = false;
        status.textContent = totalBefore ? `完成：成功 ${ok}，失败 ${fail}，合计 ${fmtBytes(totalBefore)} → ${fmtBytes(totalAfter)}（节省 ${fmtBytes(Math.max(0, totalBefore - totalAfter))}），输出目录 ${outDir}` : '';
        toast(`压缩完成（${ok} 成功 / ${fail} 失败）`, fail ? 'warn' : 'success');
      }
      page.appendChild(div('card', div('card-title', '选择图片'), dz, label));
      page.appendChild(div('card', div('card-title', '压缩参数'),
        div('form-row', h('span', { class: 'form-label' }, '模式'), modeSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '质量'), qualityIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '目标体积'), targetIn, h('span', { class: 'field-hint' }, 'KB'),
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '最大宽'), maxWIn),
        div('form-row', h('span', { class: 'form-label' }, '输出格式'), fmtSel),
        div('form-row', h('span', { class: 'form-label' }, '输出'), outDirIn, pickOutBtn),
        div('form-row', startBtn, ' ', prog.el, status)));
      page.appendChild(div('card', div('card-title', '压缩结果'), listBox));
      // 测试钩子（无头 E2E 用；正常使用无副作用）
      (window.__heheTest = window.__heheTest || {}).imgCompress = {
        setPaths: (arr) => { paths.length = 0; paths.push(...arr); },
        setOpts: (o) => {
          if (o.mode) { modeSel.value = o.mode; modeSel.dispatchEvent(new Event('change')); }
          if (o.quality != null) qualityIn.value = o.quality;
          if (o.target != null) targetIn.value = o.target;
          if (o.maxW != null) maxWIn.value = o.maxW;
          if (o.fmt) fmtSel.value = o.fmt;
        },
        run: () => run()
      };
    }
  });

  /* ---------- 视频压制 ---------- */
  register({
    id: 'video-press', name: '视频压制', module: MOD, icon: 'film',
    desc: 'H.264/H.265 重编码瘦身：预设、CRF、分辨率、音频码率，压完看省了多少',
    keywords: ['压制', '视频', '压缩', 'h265', 'hevc', '瘦身', '体积'],
    render(page) {
      const files = [];
      const dz = dropzone({ text: '拖入或选择要压制的视频（可多选）', onFiles: (p) => { files.push(...p); label.textContent = `已选 ${files.length} 个文件`; refreshList(); } });
      const label = div('field-hint', '未选择');
      const presetSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'balanced' }, '均衡推荐（H.264 · CRF23 · 中速）'),
        h('option', { value: 'quality' }, '高画质（H.265 · CRF20 · 慢速）'),
        h('option', { value: 'strong' }, '极限瘦身（H.265 · CRF28 · 中速）'),
        h('option', { value: 'custom' }, '自定义'));
      const codecSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'libx264' }, 'H.264（兼容最好）'), h('option', { value: 'libx265' }, 'H.265（体积更小）'));
      const crfIn = h('input', { type: 'number', class: 'input input-sm', value: '23', min: '14', max: '36', style: { width: '64px' }, title: '质量：越小越清晰、体积越大' });
      const speedSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'veryfast' }, '中速'), h('option', { value: 'ultrafast' }, '快速（体积略大）'),
        h('option', { value: 'medium' }, '较慢（体积更小）'), h('option', { value: 'slow' }, '慢（体积最小）'));
      const scaleSel = h('select', { class: 'select input-sm' },
        h('option', { value: '' }, '保持原分辨率'), h('option', { value: '1920' }, '限 1080p'), h('option', { value: '1280' }, '限 720p'), h('option', { value: '854' }, '限 480p'));
      const fpsIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '帧率', style: { width: '64px' } });
      const audioSel = h('select', { class: 'select input-sm' },
        h('option', { value: '128k' }, '音频重编码 128k'), h('option', { value: '96k' }, '音频重编码 96k'),
        h('option', { value: 'copy' }, '音频直接复制'), h('option', { value: 'mute' }, '移除音频'));
      const stripChk = h('input', { type: 'checkbox', class: 'checkbox' }); stripChk.checked = true;
      const outDirIn = h('input', { class: 'input input-sm', placeholder: '输出目录（留空 = 源文件目录/hehe-pressed）', style: { flex: '1' } });
      const pickOutBtn = btn('选择…', 'btn-sm btn-secondary', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) outDirIn.value = d[0];
      });
      const listBox = div('');
      const status = h('span', { class: 'field-hint' }, '');
      let running = false;
      const startBtn = btn('🚀 开始压制', 'btn-primary', run);
      const cancelBtn = btn('■ 取消', 'btn-danger-plain', () => invoke('job:cancel-latest').catch(() => {}));
      cancelBtn.disabled = true;
      function applyPreset() {
        const v = presetSel.value;
        const custom = v === 'custom';
        codecSel.disabled = !custom; crfIn.disabled = !custom; speedSel.disabled = !custom;
        if (v === 'balanced') { codecSel.value = 'libx264'; crfIn.value = '23'; speedSel.value = 'veryfast'; }
        else if (v === 'quality') { codecSel.value = 'libx265'; crfIn.value = '20'; speedSel.value = 'slow'; }
        else if (v === 'strong') { codecSel.value = 'libx265'; crfIn.value = '28'; speedSel.value = 'medium'; }
      }
      presetSel.addEventListener('change', applyPreset); applyPreset();
      function refreshList() {
        listBox.innerHTML = '';
        files.forEach((f, i) => {
          const row = div('form-row');
          row.dataset.i = i;
          const tag = h('span', { class: 'tag tag-gray av-tag', style: { width: '64px', justifyContent: 'center' } }, '等待中');
          row.appendChild(tag);
          row.appendChild(h('span', { style: { flex: '1', fontSize: '12px', wordBreak: 'break-all' } }, f.split(/[\\/]/).pop()));
          row.appendChild(h('span', { class: 'field-hint vp-size', style: { fontSize: '11px' } }, ''));
          const bar = div('progress', { style: { width: '140px' } });
          bar.appendChild(div('progress-fill'));
          row.appendChild(bar);
          row.appendChild(h('span', { class: 'field-err av-err', style: { fontSize: '11px', maxWidth: '200px' } }, ''));
          listBox.appendChild(row);
        });
      }
      async function run() {
        if (!files.length) return toast('请先选择视频', 'warn');
        if (running) return;
        const st = await invoke('ffmpeg:status').catch(() => ({ ffmpeg: null }));
        if (!st.ffmpeg) {
          toast('未安装 FFmpeg，请先前往「FFmpeg 环境」安装', 'warn');
          window.App.openTool('ffmpeg-setup');
          return;
        }
        running = true; startBtn.disabled = true; cancelBtn.disabled = false;
        status.textContent = '';
        const outDir = outDirIn.value.trim() || (files[0].replace(/[\\/][^\\/]*$/, '') + '/hehe-pressed');
        const unsub = on('job:stream', (d) => {
          try {
            const j = JSON.parse(d.data);
            const row = listBox.querySelector(`[data-i="${j.i}"]`);
            if (!row) return;
            const tag = row.querySelector('.av-tag');
            const bar = row.querySelector('.progress-fill');
            if (j.stage === 'start') { if (tag) { tag.textContent = '压制中'; tag.className = 'tag tag-orange'; } return; }
            if (j.pct != null && bar && !j.done) bar.style.width = (j.pct || 0) + '%';
            if (j.done && tag) { tag.textContent = j.ok ? '✓ 完成' : '✗ 失败'; tag.className = 'tag ' + (j.ok ? 'tag-green' : 'tag-red'); }
          } catch (e) {}
        });
        if (window.App && App.onCleanup) App.onCleanup(unsub);
        try {
          const r = await invoke('ffmpeg:press', {
            items: [...files], outDir,
            opts: {
              vcodec: codecSel.value, crf: parseInt(crfIn.value) || 23, preset: speedSel.value,
              scale: scaleSel.value, fps: fpsIn.value ? parseInt(fpsIn.value) : null,
              audio: audioSel.value, stripMeta: stripChk.checked
            }
          });
          let okN = 0, saveB = 0;
          r.results.forEach((res, i) => {
            const row = listBox.querySelector(`[data-i="${i}"]`);
            if (!row) return;
            const tag = row.querySelector('.av-tag'), errEl = row.querySelector('.av-err'), sizeEl = row.querySelector('.vp-size');
            if (res.ok) {
              okN++;
              saveB += Math.max(0, (res.inSize || 0) - (res.outSize || 0));
              if (sizeEl && res.inSize) {
                const pct = Math.max(0, Math.round((1 - res.outSize / res.inSize) * 100));
                sizeEl.textContent = `${fmtBytes(res.inSize)} → ${fmtBytes(res.outSize)}（-${pct}%）`;
              }
            } else {
              if (tag) { tag.textContent = '✗ 失败'; tag.className = 'tag tag-red'; }
              if (errEl) errEl.textContent = res.err;
            }
          });
          status.textContent = `完成：成功 ${okN} / ${r.results.length}${r.canceled ? '（已取消）' : ''}，共节省 ${fmtBytes(saveB)}，输出目录 ${outDir}`;
          toast(`压制完成（${okN}/${r.results.length}）`, okN ? 'success' : 'error');
        } catch (e) {
          status.textContent = '✗ ' + e.message;
          toast(e.message, 'error');
        } finally { running = false; startBtn.disabled = false; cancelBtn.disabled = true; unsub(); }
      }
      page.appendChild(div('card', div('card-title', '选择视频'), dz, label, listBox));
      page.appendChild(div('card', div('card-title', '压制参数'),
        div('form-row', h('span', { class: 'form-label' }, '预设'), presetSel),
        div('form-row', h('span', { class: 'form-label' }, '编码'), codecSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '质量CRF'), crfIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '速度'), speedSel),
        div('form-row', h('span', { class: 'form-label' }, '分辨率'), scaleSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '帧率'), fpsIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '音频'), audioSel),
        div('form-row', h('label', { class: 'field-hint' }, stripChk, ' 清除元数据（减少体积）')),
        div('form-row', h('span', { class: 'form-label' }, '输出'), outDirIn, pickOutBtn),
        div('form-row', startBtn, ' ', cancelBtn, status)));
      // 测试钩子（无头 E2E 用；正常使用无副作用）
      (window.__heheTest = window.__heheTest || {}).videoPress = {
        setFiles: (arr) => { files.length = 0; files.push(...arr); refreshList(); },
        setOpts: (o) => {
          if (o.preset) { presetSel.value = o.preset; presetSel.dispatchEvent(new Event('change')); }
          if (o.codec) codecSel.value = o.codec;
          if (o.crf != null) crfIn.value = o.crf;
          if (o.speed) speedSel.value = o.speed;
          if (o.scale != null) scaleSel.value = o.scale;
          if (o.fps != null) fpsIn.value = o.fps;
          if (o.audio) audioSel.value = o.audio;
          if (o.outDir) outDirIn.value = o.outDir;
        },
        run: () => run()
      };
    }
  });

  /* ---------- 截图标注 ---------- */
  register({
    id: 'snip-tool', name: '截图标注', module: MOD, icon: 'crop',
    desc: '框选区域截图，箭头/矩形/文字/马赛克标注，一键复制/保存/贴图/OCR',
    keywords: ['截图', '标注', 'screenshot', 'snip', '截屏', '马赛克'],
    render(page) {
      const status = h('div', { class: 'field-hint' }, '');
      async function start() {
        try {
          status.textContent = '请在屏幕上拖动框选区域…（Esc 取消）';
          const r = await invoke('snip:start', 'annotate');
          if (r && r.ok) status.textContent = '截图窗口已打开';
        } catch (e) { status.textContent = '✗ ' + e.message; toast(e.message, 'error'); }
      }
      page.appendChild(div('card', div('card-title', '截图标注'),
        btn('✂️ 开始截图', 'btn-primary btn-lg', start),
        div('field-hint', '拖动框选 → 工具条标注（矩形/箭头/画笔/文字/马赛克，可撤销）→ 复制 / 保存 / 贴图 / OCR'),
        status,
        div('field-hint', '完整链路：截图 → 标注 → 贴图置顶（悬浮参考）→ OCR 识别文字；托盘右键也可直接截图')));
      page.appendChild(div('card', div('card-title', '快捷贴图'),
        div('form-row', btn('📌 贴剪贴板图片', 'btn-secondary', async () => {
          try { await invoke('snip:pin-clipboard'); toast('已贴图', 'success'); }
          catch (e) { toast(e.message, 'error'); }
        }), h('span', { class: 'field-hint' }, '把剪贴板里的图片变成置顶小窗（Snipaste 式）'))));
    }
  });

  /* ---------- 屏幕录制 ---------- */
  register({
    id: 'screen-rec', name: '屏幕录制', module: MOD, icon: 'film',
    desc: '录制全屏或框选区域为 MP4，可选麦克风与摄像头画中画、暂停恢复、直出 GIF',
    keywords: ['录制', '录屏', '屏幕', 'video', 'capture', '区域', '摄像头', '画中画', 'camera', 'webcam'],
    render(page) {
      const fpsSel = h('select', { class: 'select input-sm' },
        h('option', { value: '15' }, '15 帧（文件小）'), h('option', { value: '30', selected: true }, '30 帧（流畅）'), h('option', { value: '60' }, '60 帧（高帧率）'));
      const audioSel = h('select', { class: 'select input-sm', style: { maxWidth: '220px' } },
        h('option', { value: '' }, '不录声音'));
      const camSel = h('select', { class: 'select input-sm', style: { maxWidth: '220px' } },
        h('option', { value: '' }, '不录摄像头'));
      const camPosSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'rb', selected: true }, '右下角'), h('option', { value: 'lb' }, '左下角'),
        h('option', { value: 'rt' }, '右上角'), h('option', { value: 'lt' }, '左上角'));
      camPosSel.disabled = true;
      const camSizeSel = h('select', { class: 'select input-sm' },
        h('option', { value: '0.15' }, '小（15%）'), h('option', { value: '0.25', selected: true }, '中（25%）'), h('option', { value: '0.35' }, '大（35%）'));
      camSizeSel.disabled = true;
      const regionBtn = btn('▭ 选择区域', 'btn-sm btn-secondary', pickRegion);
      const clearRegionBtn = btn('✕ 全屏', 'btn-sm btn-text', () => { region = null; regionLabel.textContent = '全屏'; });
      const regionLabel = h('span', { class: 'field-hint' }, '全屏');
      const gifChk = h('input', { type: 'checkbox', class: 'checkbox' });
      const status = h('div', { class: 'field-hint' }, '支持区域录制、麦克风、摄像头画中画、暂停恢复；停止后自动封装');
      const startBtn = btn('⏺ 开始录制', 'btn-primary', start);
      const pauseBtn = btn('⏸ 暂停', 'btn-secondary', () => ctl('rec:pause'));
      const resumeBtn = btn('▶ 继续', 'btn-secondary', () => ctl('rec:resume'));
      const stopBtn = btn('⏹ 停止并保存', 'btn-danger-plain', stop);
      pauseBtn.disabled = resumeBtn.disabled = stopBtn.disabled = true;
      let recording = false, paused = false, region = null;
      const camOn = () => { const on = !!camSel.value; camPosSel.disabled = !on; camSizeSel.disabled = !on; };
      camSel.addEventListener('change', camOn);
      invoke('rec:audio-devices').then((r) => {
        for (const d of (r.devices || [])) audioSel.appendChild(h('option', { value: d }, '🎤 ' + d));
        // 兼容旧返回：新版本才有 video 字段
        for (const d of (r.video || [])) camSel.appendChild(h('option', { value: d }, '📷 ' + d));
      }).catch(() => {});
      async function pickRegion() {
        try {
          await invoke('snip:start', 'region');
          status.textContent = '请在屏幕上框选录制区域…';
          const rect = await new Promise((resolve) => {
            const t = setTimeout(() => { unsub(); resolve(null); }, 120000);
            const unsub = window.api.on('snip:region', (rr) => { clearTimeout(t); unsub(); resolve(rr); });
          });
          if (rect && rect.w >= 64 && rect.h >= 64) { region = rect; regionLabel.textContent = `${rect.w}×${rect.h}`; status.textContent = '已选择录制区域'; }
          else if (rect) toast('区域太小，请重新选择', 'warn');
          else status.textContent = '未选择区域（保持全屏）';
        } catch (e) { toast(e.message, 'error'); }
      }
      async function start() {
        const st = await invoke('ffmpeg:status').catch(() => ({ ffmpeg: null }));
        if (!st.ffmpeg) { toast('未安装 FFmpeg，请先前往「FFmpeg 环境」安装', 'warn'); window.App.openTool('ffmpeg-setup'); return; }
        const p = await invoke('dialog:save', { defaultPath: '录屏-' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.mp4', filters: [{ name: 'MP4', extensions: ['mp4'] }] });
        if (!p) return;
        try {
          await invoke('rec:start', { outPath: p, fps: +fpsSel.value, rect: region, audio: audioSel.value || null,
            camera: camSel.value || null, camPos: camPosSel.value, camScale: +camSizeSel.value });
          recording = true; paused = false;
          startBtn.disabled = true; pauseBtn.disabled = false; stopBtn.disabled = false;
          status.textContent = '🔴 录制中…' + (region ? `（${region.w}×${region.h}）` : '（全屏）') + (audioSel.value ? ' + 🎤' : '') + (camSel.value ? ' + 📷 画中画' : '');
        } catch (e) { toast(e.message, 'error'); }
      }
      async function ctl(ch) {
        try {
          if (ch === 'rec:pause') { await invoke('rec:pause'); paused = true; pauseBtn.disabled = true; resumeBtn.disabled = false; status.textContent = '⏸ 已暂停（分段保存，停止时自动拼接）'; }
          else { await invoke('rec:resume'); paused = false; pauseBtn.disabled = false; resumeBtn.disabled = true; status.textContent = '🔴 继续录制中…'; }
        } catch (e) { toast(e.message, 'error'); }
      }
      async function stop() {
        if (!recording) return;
        pauseBtn.disabled = resumeBtn.disabled = stopBtn.disabled = true;
        status.textContent = '正在封装' + (gifChk.checked ? '（并生成 GIF）' : '') + '…';
        try {
          const r = await invoke('rec:stop', gifChk.checked);
          recording = false; startBtn.disabled = false;
          status.textContent = `✓ 已保存：${r.outPath}（${fmtBytes(r.size || 0)}）` + (r.gif ? ` · GIF：${r.gif}` : '');
          toast('录制完成：' + fmtBytes(r.size || 0), 'success');
        } catch (e) { recording = false; startBtn.disabled = false; status.textContent = '✗ ' + e.message; }
      }
      window.App.onCleanup(() => { if (recording) invoke('rec:stop', false).catch(() => {}); });
      page.appendChild(div('card', div('card-title', '录制'),
        div('form-row', h('span', { class: 'form-label' }, '帧率'), fpsSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '区域'), regionBtn, clearRegionBtn, regionLabel),
        div('form-row', h('span', { class: 'form-label' }, '声音'), audioSel,
          h('label', { class: 'field-hint' }, gifChk, ' 停止时同时导出 GIF')),
        div('form-row', h('span', { class: 'form-label' }, '摄像头'), camSel, camPosSel, camSizeSel,
          h('span', { class: 'field-hint' }, '画面叠加在录屏角落；无需摄像头选「不录摄像头」')),
        div('form-row', startBtn, ' ', pauseBtn, resumeBtn, ' ', stopBtn, status)));
    }
  });

  /* ---------- 视频截帧 ---------- */
  register({
    id: 'video-frames', name: '视频截帧', module: MOD, icon: 'crop',
    desc: '从视频抽取单帧图片，或按间隔批量导出帧序列（ffmpeg）',
    keywords: ['截帧', '视频', '帧', '截图', 'frames'],
    render(page) {
      const files = [];
      const dz = dropzone({ text: '拖入或选择视频文件', onFiles: (p) => { files.length = 0; files.push(...p); label.textContent = files[0]; } });
      const label = div('field-hint', '未选择');
      const modeSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'single' }, '抽单帧（指定时间点）'),
        h('option', { value: 'seq' }, '按间隔批量导出帧序列'));
      const timeIn = h('input', { class: 'input input-sm mono', placeholder: '00:01:30', style: { width: '90px' }, title: '时:分:秒 或 秒数' });
      const everyIn = h('input', { type: 'number', class: 'input input-sm', value: '1', min: '1', style: { width: '64px' }, title: '每 N 秒导出一帧' });
      const countIn = h('input', { type: 'number', class: 'input input-sm', value: '20', min: '1', max: '500', style: { width: '64px' }, title: '最多导出帧数' });
      const wIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '原尺寸', style: { width: '80px' }, title: '限制宽度（px）' });
      const outLabel = h('div', { class: 'field-hint' }, '');
      const goBtn = btn('🚀 开始截帧', 'btn-primary', run);
      const refresh = () => { timeIn.disabled = modeSel.value !== 'single'; everyIn.disabled = countIn.disabled = modeSel.value !== 'seq'; };
      modeSel.addEventListener('change', refresh); refresh();
      async function run() {
        if (!files.length) return toast('请先选择视频', 'warn');
        const st = await invoke('ffmpeg:status').catch(() => ({ ffmpeg: null }));
        if (!st.ffmpeg) { toast('未安装 FFmpeg', 'warn'); window.App.openTool('ffmpeg-setup'); return; }
        const src = files[0];
        const base = src.split(/[\\/]/).pop().replace(/\.\w+$/, '');
        const outDir = src.replace(/[\\/][^\\/]+$/, '') + '/hehe-frames';
        try { await invoke('fs:mkdir', outDir); } catch (e) {}
        const r = await invoke('dialog:open', { properties: ['openDirectory'] }).catch(() => null);
        const finalDir = (r && r[0]) ? r[0] : outDir;
        goBtn.disabled = true; outLabel.textContent = '处理中…';
        try {
          const r = await invoke('ffmpeg:frames', {
            input: src, outDir: finalDir, mode: modeSel.value,
            ss: timeIn.value.trim(), every: Math.max(1, +everyIn.value || 1),
            count: Math.min(500, +countIn.value || 20), width: wIn.value || null
          });
          outLabel.textContent = modeSel.value === 'single'
            ? `✓ 已导出：${r.first}`
            : `✓ 帧序列 ${r.count} 张已导出到 ${r.outDir}`;
          toast('截帧完成', 'success');
        } catch (e) { outLabel.textContent = '✗ ' + e.message; toast(e.message, 'error'); }
        finally { goBtn.disabled = false; }
      }
      page.appendChild(div('card', div('card-title', '视频'), dz, label));
      page.appendChild(div('card', div('card-title', '参数'),
        div('form-row', h('span', { class: 'form-label' }, '模式'), modeSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '时间点'), timeIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '间隔(秒)'), everyIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '最多'), countIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '宽度'), wIn),
        div('form-row', goBtn, outLabel)));
    }
  });

  /* ---------- 批量图片 OCR ---------- */
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
        if (!out.value) return toast('暂无结果', 'warn');
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
          if (!imgs.length) { toast('该文件夹没有图片', 'warn'); return; }
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
        div('form-row', btn('🔍 开始批量识别', 'btn-primary', run), prog.el, status),
        out, div('form-row', saveBtn)));
    }
  });

  /* ---------- 音频剪辑 ---------- */
  register({
    id: 'audio-cut', name: '音频剪辑', module: MOD, icon: 'scissors',
    desc: '截取音频片段、淡入淡出、音量增益（ffmpeg）',
    keywords: ['音频', '剪辑', '截取', '淡入', '淡出', '音量'],
    render(page) {
      const files = [];
      const dz = dropzone({ text: '拖入或选择音频文件（mp3/m4a/wav/flac）', onFiles: (p) => { files.length = 0; files.push(...p); label.textContent = files[0]; } });
      const label = div('field-hint', '未选择');
      const ssIn = h('input', { class: 'input input-sm mono', placeholder: '00:00', style: { width: '70px' } });
      const toIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '秒数', style: { width: '70px' }, title: '从起点开始截取的时长' });
      const fadeInIn = h('input', { type: 'number', class: 'input input-sm', value: '0', min: '0', max: '30', style: { width: '56px' }, title: '淡入秒数（0=关闭）' });
      const fadeOutIn = h('input', { type: 'number', class: 'input input-sm', value: '0', min: '0', max: '30', style: { width: '56px' }, title: '淡出秒数（0=关闭）' });
      const gainIn = h('input', { type: 'number', class: 'input input-sm', value: '0', step: '0.5', style: { width: '60px' }, title: '音量增益（dB，0=不变，负值降低）' });
      const fmtSel = h('select', { class: 'select input-sm' }, h('option', { value: 'keep' }, '保持原格式'), h('option', { value: 'mp3' }, 'MP3'), h('option', { value: 'm4a' }, 'M4A'), h('option', { value: 'wav' }, 'WAV'));
      const status = h('div', { class: 'field-hint' }, '');
      const goBtn = btn('✂️ 开始剪辑', 'btn-primary', run);
      async function run() {
        if (!files.length) return toast('请先选择音频', 'warn');
        const st = await invoke('ffmpeg:status').catch(() => ({ ffmpeg: null }));
        if (!st.ffmpeg) { toast('未安装 FFmpeg', 'warn'); window.App.openTool('ffmpeg-setup'); return; }
        const src = files[0];
        const dur = Math.max(0, +toIn.value || 0);
        const fi = Math.max(0, +fadeInIn.value || 0), fo = Math.max(0, +fadeOutIn.value || 0), gain = +gainIn.value || 0;
        let fmt = fmtSel.value;
        if (fmt === 'keep') { const e = src.split('.').pop().toLowerCase(); fmt = ['mp3', 'm4a', 'wav', 'flac'].includes(e) ? e : 'mp3'; }
        const out = src.replace(/\.\w+$/, '_cut.' + fmt);
        goBtn.disabled = true; status.textContent = '处理中…';
        try {
          const r = await invoke('ffmpeg:audio-cut', {
            input: src, out, ss: ssIn.value.trim(), dur, fadeIn: fi, fadeOut: fo, gain, format: fmt
          });
          status.textContent = `✓ 已输出：${out}（${fmtBytes(r.size)}）`;
          toast('剪辑完成', 'success');
        } catch (e) { status.textContent = '✗ ' + e.message; toast(e.message, 'error'); }
        finally { goBtn.disabled = false; }
      }
      page.appendChild(div('card', div('card-title', '音频'), dz, label));
      page.appendChild(div('card', div('card-title', '剪辑参数'),
        div('form-row', h('span', { class: 'form-label' }, '起点'), ssIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '时长(秒)'), toIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '淡入'), fadeInIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '淡出'), fadeOutIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '增益dB'), gainIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '格式'), fmtSel),
        div('form-row', goBtn, status)));
    }
  });

  /* ---------- 相似图片查找 ---------- */
  register({
    id: 'img-dedup', name: '相似图片查找', module: MOD, icon: 'image',
    desc: '感知哈希（dHash）找出内容相近的图片：改过尺寸/压缩过的也能找出',
    keywords: ['相似', '图片', '重复', '去重', 'dhash'],
    render(page) {
      let dir = '';
      const dirLabel = h('span', { class: 'field-hint' }, '未选择');
      const pickBtn = btn('选择文件夹…', 'btn-secondary', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) { dir = d[0]; dirLabel.textContent = dir; }
      });
      const threshIn = h('input', { type: 'number', class: 'input input-sm', value: '6', min: '0', max: '20', style: { width: '60px' }, title: '汉明距离阈值，越小越严格' });
      const prog = progressEl(); prog.hide();
      const status = h('span', { class: 'field-hint' }, '');
      const listBox = div('');
      async function run() {
        if (!dir) return toast('请先选择文件夹', 'warn');
        prog.show(); listBox.innerHTML = ''; status.textContent = '读取图片…';
        try {
          const items = await invoke('fs:list', dir);
          const imgs = items.map(x => x.name || x).filter(n => /\.(png|jpe?g|bmp|webp)$/i.test(n));
          if (imgs.length < 2) { toast('图片不足 2 张', 'warn'); return; }
          const hashes = [];
          for (let i = 0; i < imgs.length; i++) {
            prog.set(i / imgs.length * 100);
            const p = dir.replace(/[\\/]+$/, '') + '/' + imgs[i];
            try {
              const img = await loadImg(p);
              // dHash：9x8 灰度，水平相邻比较 → 64 bit
              const c = document.createElement('canvas');
              c.width = 9; c.height = 8;
              const ctx = c.getContext('2d');
              ctx.drawImage(img, 0, 0, 9, 8);
              const d = ctx.getImageData(0, 0, 9, 8).data;
              let bits = '';
              for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
                const a = d[(y * 9 + x) * 4], b = d[(y * 9 + x + 1) * 4];
                bits += a > b ? '1' : '0';
              }
              hashes.push({ path: p, name: imgs[i], bits });
            } catch (e) { /* 跳过损坏图片 */ }
          }
          status.textContent = '比对中…';
          const thresh = Math.max(0, Math.min(20, +threshIn.value || 6));
          const groups = [];
          const used = new Array(hashes.length).fill(false);
          for (let i = 0; i < hashes.length; i++) {
            if (used[i]) continue;
            const grp = [hashes[i]];
            for (let j = i + 1; j < hashes.length; j++) {
              if (used[j]) continue;
              let dist = 0;
              for (let k = 0; k < 64; k++) if (hashes[i].bits[k] !== hashes[j].bits[k]) dist++;
              if (dist <= thresh) { grp.push(hashes[j]); used[j] = true; }
            }
            if (grp.length > 1) groups.push(grp);
            used[i] = true;
          }
          prog.hide();
          if (!groups.length) { status.textContent = `未发现相似图片（${hashes.length} 张，阈值 ${thresh}）`; return; }
          status.textContent = `发现 ${groups.length} 组相似（共 ${hashes.length} 张参与）`;
          groups.forEach((g, gi) => {
            const card = div('card');
            card.appendChild(div('card-title', `第 ${gi + 1} 组 · ${g.length} 张`));
            const grid = div('tool-grid');
            for (const it of g) {
              const cell = div('tc-item', { style: { cursor: 'pointer' } });
              cell.appendChild(div('tc-name', { style: { fontSize: '11px', wordBreak: 'break-all' } }, it.name));
              cell.addEventListener('click', () => invoke('fs:show-item', it.path));
              grid.appendChild(cell);
            }
            card.appendChild(grid);
            listBox.appendChild(card);
          });
          toast(`发现 ${groups.length} 组相似图片`, 'success');
        } catch (e) { status.textContent = '✗ ' + e.message; toast(e.message, 'error'); prog.hide(); }
        finally { prog.hide(); }
      }
      page.appendChild(div('card', div('card-title', '图片文件夹'),
        div('form-row', pickBtn, dirLabel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '相似阈值'), threshIn,
          btn('🔍 查找相似', 'btn-primary', run), prog.el, status)));
      page.appendChild(listBox);
    }
  });
})();
