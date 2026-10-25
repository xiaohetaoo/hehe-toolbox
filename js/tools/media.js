/* 模块：多媒体处理 —— 图片批量处理 / 压缩 / 水印 / 拼接 / 占位 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, dropzone, fmtBytes, progressEl } = window.ui;
  const { invoke, isDesktop } = window.api;
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
          await invoke('fs:mkdir', outDir);
        } else await invoke('fs:mkdir', outDir);
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
        await invoke('fs:mkdir', outDir);
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
          const p = await invoke('dialog:save', { defaultPath: outDefault });
          if (!p) return;
          await invoke('fs:write-file-b64', p, b64);
          toast('已保存：' + p, 'success');
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
          } catch (e) { result.innerHTML = `<div class="field-err">${e.message}</div>`; }
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
        const dv = new DataView(buf2.buffer);
        const buf2 = buf2View();
        function buf2View() { return { buffer: buf.buffer, byteOffset: start, byteLength: buf.length - start }; }
        // simpler: read via DataView on whole buffer with base offset
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
        } catch (e) { statusBox.innerHTML = `<div class="field-err">${e.message}</div>`; }
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
        } catch (e) { status.innerHTML = `<span class="status-err">✗ ${e.message}</span>`; toast(e.message, 'error'); }
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
          } else result.innerHTML = `<div class="field-err">${e.message}</div>`;
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
          status.innerHTML = `<span class="status-err">✗ ${e.message}</span>`;
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
          status.innerHTML = `<span class="status-err">✗ ${e.message}（语言包需联网下载一次，之后离线可用）</span>`;
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
})();
