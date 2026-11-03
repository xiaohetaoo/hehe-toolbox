/* 模块：多媒体处理 —— img-dedup（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, progressEl } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';
  const { loadImg } = window.MediaShared;

register({
    id: 'img-dedup', name: '相似图片查找', module: MOD, icon: 'image',
    desc: '感知哈希（dHash）找出内容相近的图片：改过尺寸/压缩过的也能找出',
    keywords: ['相似', '图片', '重复', '去重', 'dhash'],
    render(page) {
      let running = false; // 防重入标志：处理中禁止重复点击
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
        if (running) return; // 防重入：重复扫描会叠加两次哈希计算
        running = true;
        if (!dir) { running = false; return toast('请先选择文件夹', 'warn'); }
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
        finally { prog.hide(); running = false; }
      }
      page.appendChild(div('card', div('card-title', '图片文件夹'),
        div('form-row', pickBtn, dirLabel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '相似阈值'), threshIn,
          btn('查找相似', 'btn-primary', run, 'search'), prog.el, status)));
      page.appendChild(listBox);
    }
  })
})();
