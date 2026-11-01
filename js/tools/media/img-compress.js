/* 模块：多媒体处理 —— img-compress（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, filePicker, fmtBytes, progressEl } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';
  const { isImgPath, IMG_FILTER, loadImg } = window.MediaShared;

register({
    id: 'img-compress', name: '图片压缩', module: MOD, icon: 'image',
    desc: '智能压缩 / 指定质量 / 压到目标体积，JPG·WebP·PNG 输出与前后大小对比',
    keywords: ['压缩', '图片', '体积', 'webp', '缩小', '瘦身'],
    render(page) {
      /* 文件清单/删除由 filePicker 负责；压缩进度与前后体积直接写回列表行 */
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
      const picker = filePicker({
        text: '拖入或选择要压缩的图片（可多选）',
        filters: [IMG_FILTER],
        filter: isImgPath,
        onReject: (n) => toast(`已忽略 ${n} 个非图片文件`, 'warn'),
        beforeRemove: () => {
          if (running) { toast('压缩进行中，请先等待完成再修改文件列表', 'warn'); return false; }
          return true;
        },
        rowEnd: (item, i, row) => {
          row.appendChild(h('span', { class: 'comp-size field-hint', style: { fontSize: '11px' } }, '…'));
          row.appendChild(h('span', { class: 'tag tag-gray', style: { minWidth: '64px', justifyContent: 'center' } }, '待压缩'));
          row.appendChild(h('span', { class: 'field-err comp-err', style: { fontSize: '11px', maxWidth: '200px' } }, ''));
        }
      });
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

        /* PNG 是无损格式：canvas.toDataURL('image/png', q) 的 quality 参数**会被忽略**，
         * 所有 q 值产出的字节数完全相同。原来的二分调质量对 PNG 完全无效，
         * 结果就是「无论怎么调都超目标，一路降到底」。
         * 所以 PNG 走**尺寸逼近**：按体积与像素数的平方关系估算缩放比，再微调几轮。 */
        if (mime === 'image/png') {
          return encodeTargetBySize(img, mime, target);
        }

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

      /* 按尺寸逼近体积：体积近似正比于像素数（无损格式下尤其成立）。
       * 先算理论缩放，再二分微调，最多 6 轮。 */
      function encodeTargetBySize(img, mime, target) {
        const w0 = img.naturalWidth || img.width;
        const h0 = img.naturalHeight || img.height;
        let scale = 1;
        let best = null, bestSize = Infinity;

        for (let round = 0; round < 6; round++) {
          const w = Math.max(1, Math.round(w0 * scale));
          const h = Math.max(1, Math.round(h0 * scale));
          const du = drawTo(img, mime, 1, scale);
          const size = dataUrlBytes(du);
          if (size <= target) {
            // 达标：记录当前结果，然后尝试**放大**一点以更贴近上限（画质更好）
            if (size > bestSize || best === null) { best = du; bestSize = size; }
            scale *= 1.15;
            if (scale > 1) scale = 1;
            else if (best && bestSize >= target * 0.95) break;
          } else {
            // 超了：按体积比反推缩放（面积∝体积）
            const ratio = Math.sqrt(target / size);
            scale = Math.max(0.05, scale * Math.max(0.5, Math.min(1.1, ratio * 0.95)));
          }
          if (w < 8 || h < 8) break;
        }
        if (best) return best;
        // 实在压不下去：给一个明显降尺寸的结果，界面会显示实际体积
        return drawTo(img, mime, 1, 0.05);
      }
      async function run() {
        if (!picker.count) return toast('请先选择图片', 'warn');
        if (running) return;
        running = true; startBtn.disabled = true;
        picker.setLocked(true);
        prog.show(); status.textContent = '';
        const paths = picker.paths.slice();
        const outDir = outDirIn.value.trim() || (paths[0].replace(/[\\/][^\\/]+$/, '') + '/hehe-compressed');
        try { await invoke('fs:mkdir', outDir); } catch (e) {}
        let totalBefore = 0, totalAfter = 0, ok = 0, fail = 0;
        for (let i = 0; i < paths.length; i++) {
          prog.set((i + 1) / paths.length * 100);
          const p = paths[i];
          const name = p.split(/[\\/]/).pop();
          const row = picker.list.rowAt(i);
          if (row) {
            const t0 = row.querySelector('.tag');
            if (t0) { t0.textContent = '压缩中'; t0.className = 'tag tag-orange'; }
          }
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
            const sizeEl = row && row.querySelector('.comp-size'), tagEl = row && row.querySelector('.tag');
            if (sizeEl) sizeEl.textContent = `${fmtBytes(orig)} → ${fmtBytes(newSize)}`;
            if (tagEl) { tagEl.textContent = pct >= 0 ? `-${pct}%` : `+${-pct}%`; tagEl.className = 'tag ' + (pct >= 0 ? 'tag-green' : 'tag-orange'); }
          } catch (e) {
            fail++;
            if (row) {
              const tagEl2 = row.querySelector('.tag');
              if (tagEl2) { tagEl2.textContent = '✗'; tagEl2.className = 'tag tag-red'; }
              const errEl = row.querySelector('.comp-err');
              if (errEl) errEl.textContent = (e && e.message) || String(e);
            }
          }
        }
        prog.hide(); running = false; startBtn.disabled = false; picker.setLocked(false);
        status.textContent = totalBefore ? `完成：成功 ${ok}，失败 ${fail}，合计 ${fmtBytes(totalBefore)} → ${fmtBytes(totalAfter)}（节省 ${fmtBytes(Math.max(0, totalBefore - totalAfter))}），输出目录 ${outDir}` : '';
        toast(`压缩完成（${ok} 成功 / ${fail} 失败）`, fail ? 'warn' : 'success');
      }
      page.appendChild(div('card', div('card-title', '选择图片'), picker.el));
      page.appendChild(div('card', div('card-title', '压缩参数'),
        div('form-row', h('span', { class: 'form-label' }, '模式'), modeSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '质量'), qualityIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '目标体积'), targetIn, h('span', { class: 'field-hint' }, 'KB'),
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '最大宽'), maxWIn),
        div('form-row', h('span', { class: 'form-label' }, '输出格式'), fmtSel),
        div('form-row', h('span', { class: 'form-label' }, '输出'), outDirIn, pickOutBtn),
        div('form-row', startBtn, ' ', prog.el, status)));
      // 测试钩子：**只在开发态挂载**（打包版默认不挂，避免留下可注入的调试后门）。
      // 打包态跑 E2E 时用环境变量 HEHE_TEST_HOOKS=1 临时开启。
      if (window.api.isDev) (window.__heheTest = window.__heheTest || {}).imgCompress = {
        setPaths: (arr) => { picker.clear(); picker.add(arr); },
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
  })
})();
