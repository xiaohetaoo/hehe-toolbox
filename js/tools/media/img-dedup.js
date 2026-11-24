/* 模块：多媒体处理 —— img-dedup（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, progressEl } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';
  const { loadImg } = window.MediaShared;

register({
    id: 'img-dedup', name: '相似图片查找', nameEn: 'Similar Images', module: MOD, icon: 'image',
    desc: '感知哈希（dHash）找出内容相近的图片：改过尺寸/压缩过的也能找出', descEn: 'Find visually similar images with a perceptual hash (dHash)',
    keywords: ['相似', '图片', '重复', '去重', 'dhash'],
    render(page) {
      let running = false; // 防重入标志：处理中禁止重复点击
      /* 停止标志：停止按钮与离开页面共用。原来整文件夹逐张读图没有任何停止入口，
       * 切页后也照跑（几千张照片的目录要跑好几分钟）。 */
      let cancelFlag = false;
      const stopBtn = btn('停止', 'btn-danger-plain', () => { cancelFlag = true; stopBtn.disabled = true; }, 'square');
      stopBtn.disabled = true;
      let dir = '';
      const dirLabel = h('span', { class: 'field-hint' }, '未选择');
      const pickBtn = btn('选择文件夹…', 'btn-secondary', async () => {
        const d = await invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: ['openDirectory'] });
        if (d && d[0]) { dir = d[0]; dirLabel.textContent = dir; }
      });
      const threshIn = h('input', { type: 'number', class: 'input input-sm', value: '6', min: '0', max: '20', style: { width: '60px' }, title: '汉明距离阈值，越小越严格' });
      const prog = progressEl(); prog.hide();
      const status = h('span', { class: 'field-hint' }, '');
      const listBox = div('');
      async function run() {
        if (running) return; // 防重入：重复扫描会叠加两次哈希计算
        running = true;
        if (!dir) { running = false; return toast('请先选择文件夹', 'warn'); }
        cancelFlag = false; stopBtn.disabled = false;
        prog.show(); listBox.innerHTML = ''; status.textContent = '读取图片…';
        try {
          const items = await invoke(Channels.CHANNELS.FS.LIST, dir);
          const imgs = items.map(x => x.name || x).filter(n => /\.(png|jpe?g|bmp|webp)$/i.test(n));
          if (imgs.length < 2) { toast('图片不足 2 张', 'warn'); return; }
          const hashes = [];
          for (let i = 0; i < imgs.length; i++) {
            if (cancelFlag) break;   // 用户点了停止，或已离开页面
            prog.set(i / imgs.length * 100);
            status.textContent = `计算指纹 ${i + 1}/${imgs.length}`;
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
              /* 【结果里必须有缩略图】原来结果格子只放文件名（而注释说的是
               * "每张缩略图点一下"）：用户看到一排纯文字，根本认不出哪张是哪张，
               * 这个工具的核心价值（"看一眼就知道是不是同一张"）就没了。
               * 图片此刻已经解码在内存里，顺手缩一张 160px 以内的小图；
               * PNG 等带透明通道的先铺白底，否则转 JPEG 后透明处是黑的。 */
              let thumb = '';
              try {
                const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
                const s = Math.min(1, 160 / Math.max(iw, ih));
                const tc = document.createElement('canvas');
                tc.width = Math.max(1, Math.round(iw * s)); tc.height = Math.max(1, Math.round(ih * s));
                const tctx = tc.getContext('2d');
                tctx.fillStyle = '#ffffff'; tctx.fillRect(0, 0, tc.width, tc.height);
                tctx.drawImage(img, 0, 0, tc.width, tc.height);
                thumb = tc.toDataURL('image/jpeg', 0.6);
              } catch (e2) {}
              hashes.push({ path: p, name: imgs[i], bits, thumb });
            } catch (e) { /* 跳过损坏图片 */ }
          }
          const scanned = hashes.length, total = imgs.length;
          const wasStopped = cancelFlag;
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
          /* 【中途停止要说明结果不完整】只比对了前一部分图片，后面的没参与 */
          const stoppedNote = wasStopped ? `（已停止：只处理了前 ${scanned} / ${total} 张，结果可能不完整）` : '';
          if (!groups.length) {
            status.textContent = `未发现相似图片（${scanned} 张，阈值 ${thresh}）${stoppedNote}`;
            if (wasStopped) toast('已停止', 'warn');
            return;
          }
          status.textContent = `发现 ${groups.length} 组相似（共 ${scanned} 张参与）${stoppedNote}`;
          if (wasStopped) toast('已停止，结果基于已处理的部分', 'warn');
          groups.forEach((g, gi) => {
            const card = div('card');
            card.appendChild(div('card-title', `第 ${gi + 1} 组 · ${g.length} 张`));
            const grid = div('sim-grid');
            for (const it of g) {
              const cell = div('sim-cell', { style: { cursor: 'pointer' } });
              cell.appendChild(h('img', { src: it.thumb, alt: it.name, loading: 'lazy', title: '点击在资源管理器中定位' }));
              cell.appendChild(div('sim-name', it.name));
              /* 相似图片分组里，每张缩略图点一下能在资源管理器里定位。
               * 键盘用户原本完全用不了这个功能（div 进不了 tab 序列）。 */
              if (window.ui.makeButtonLike) window.ui.makeButtonLike(cell, it.name);
              cell.addEventListener('click', () => invoke(Channels.CHANNELS.FS.SHOW_ITEM, it.path));
              grid.appendChild(cell);
            }
            card.appendChild(grid);
            listBox.appendChild(card);
          });
          toast(`发现 ${groups.length} 组相似图片`, wasStopped ? 'warn' : 'success');
        } catch (e) { status.textContent = '✗ ' + e.message; toast(e.message, 'error'); prog.hide(); }
        finally { prog.hide(); running = false; stopBtn.disabled = true; }
      }
      window.App.onCleanup(() => {
        cancelFlag = true;
        try { stopBtn.disabled = true; prog.hide(); } catch (e) {}
      });
      page.appendChild(div('card', div('card-title', '图片文件夹'),
        div('form-row', pickBtn, dirLabel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '相似阈值'), threshIn,
          btn('查找相似', 'btn-primary', run, 'search'), ' ', stopBtn, prog.el, status)));
      page.appendChild(listBox);
    }
  })
})();
