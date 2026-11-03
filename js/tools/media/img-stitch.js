/* 模块：多媒体处理 —— img-stitch（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, filePicker } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';
  const { isImgPath, IMG_FILTER, loadImg } = window.MediaShared;

register({
    id: 'img-stitch', name: '长截图拼接', module: MOD, icon: 'merge',
    desc: '多张截图纵向/横向拼接为一张长图',
    keywords: ['拼接', '长图', '截图'],
    render(page) {
      const thumbs = new Map(); // path -> 缩略图 dataURL，供列表行显示
      /* 用 let 而不是 const：onChange 里需要引用 picker 自身来调 sortBy，
       * 而 filePicker 构造期间就会触发一次 onChange，
       * const 声明在那一刻处于暂时性死区，直接引用会抛 ReferenceError。 */
      let picker = null;
      picker = filePicker({
        text: '按顺序拖入多张截图（可多选）',
        filters: [IMG_FILTER],
        filter: isImgPath,
        onReject: (n) => toast(`已忽略 ${n} 个非图片文件`, 'warn'),
        onChange: (items) => {
          /* 顺序即拼接顺序。新加入的按文件名自然序排好，之后用户可以手动上移/下移。
           * 【必须用 sortBy】onChange 收到的是 items.slice() 拷贝，
           * 直接 items.sort() 排的是这个拷贝，真实列表顺序纹丝不动 ——
           * 注释写着「按文件名排好」，实际什么都没做（死代码）。 */
          if (picker && items.length > 1) {
            picker.sortBy((a, b) => a.path.localeCompare(b.path, 'zh', { numeric: true }));
          }
        },
        rowStart: (item, i, row) => {
          row.appendChild(h('img', {
            class: 'fl-thumb',
            src: thumbs.get(item.path) || '',
            style: { width: '48px', height: '36px', objectFit: 'cover', borderRadius: '4px', background: 'var(--border-light)' }
          }));
          row.appendChild(h('span', { class: 'fl-name', style: { flex: '1' }, title: item.path }, item.name));
          const up = h('button', {
            class: 'btn btn-text btn-sm', title: '上移', onclick: (e) => { e.stopPropagation(); if (!picker.move(i, -1)) {} }
          }, '↑');
          up.disabled = i === 0;
          row.appendChild(up);
          const down = h('button', {
            class: 'btn btn-text btn-sm', title: '下移', onclick: (e) => { e.stopPropagation(); picker.move(i, 1); }
          }, '↓');
          down.disabled = i === picker.count - 1;
          row.appendChild(down);
          // 缩略图是异步加载的：行已渲染完再回填，加载失败就不显示图（不打断列表）
          if (!thumbs.has(item.path)) {
            loadImg(item.path).then((img) => {
              thumbs.set(item.path, img.src);
              const box = row.querySelector('.fl-thumb');
              if (box && box.isConnected) box.src = img.src;
            }).catch(() => {});
          }
        }
      });
      const canvasBox = div('');
      let direction = 'v';
      async function stitch() {
        if (picker.count < 2) return toast('至少需要两张图片', 'warn');
        const isV = direction === 'v';

        /* 【画布上限】Chrome 的单边上限约 32767px，总面积上限约 2.68 亿像素
         * （16384×16384 这个量级）。超限时 drawImage/toDataURL **不会报错**，
         * 而是静默产出空白图 —— 用户以为拼接成功，打开一看是白板。
         * 所以这里先算总量，超限就明确拒绝并给出该怎么做（而不是静默失败）。 */
        const MAX_SIDE = 32767;
        const MAX_AREA = 268435456;

        let cw, ch;
        /* 顺序即拼接顺序，且顺序可以被用户改 —— 每次拼接都现取列表里的顺序，
         * 不能沿用「加进来时按文件名排好」的旧快照。 */
        let loaded;
        try {
          loaded = await Promise.all(picker.paths.map((p) => loadImg(p).then((img) => ({ path: p, img }))));
        } catch (e) { return toast('有图片无法解码：' + (e && e.message ? e.message : e), 'error'); }
        if (isV) {
          /* 不用 Math.max(...arr)：图片数量可以很大（批量转 PDF 能选几百张），
           * 而「展开传参」有栈上限（实测约 12-13 万个参数会 RangeError）。
           * 这里改用 reduce，语义相同且没有上限。 */
          cw = loaded.reduce((m, i) => Math.max(m, i.img.naturalWidth), 0);
          ch = loaded.reduce((s, i) => s + i.img.naturalHeight, 0);
        } else {
          cw = loaded.reduce((s, i) => s + i.img.naturalWidth, 0);
          ch = loaded.reduce((m, i) => Math.max(m, i.img.naturalHeight), 0);
        }

        if (cw > MAX_SIDE || ch > MAX_SIDE || cw * ch > MAX_AREA) {
          const areaMB = ((cw * ch) / 1e6).toFixed(1);
          window.ui.alertBox(
            `拼接后的画布 ${cw}×${ch}（${areaMB} 百万像素）超出浏览器上限。\n\n` +
            `上限：单边 ${MAX_SIDE}px，总面积约 ${(MAX_AREA / 1e6).toFixed(0)} 百万像素。\n\n` +
            `可以这样做：\n` +
            `• 先分批拼接：每 5~10 张拼成一张，再把结果继续拼\n` +
            `• 或者先用「图片批量处理」把每张缩小一半再拼\n` +
            `• 竖向拼接时，检查是否有某张图特别高（它决定整体高度）`,
            '无法拼接：画布超出上限'
          );
          return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        let x = 0, y = 0;
        for (const it of loaded) {
          ctx.drawImage(it.img, x, y);
          if (isV) y += it.img.naturalHeight; else x += it.img.naturalWidth;
        }
        canvasBox.innerHTML = '';
        canvas.style.maxWidth = '100%';
        canvas.style.border = '1px solid var(--border)';
        canvas.style.borderRadius = '8px';
        canvasBox.appendChild(canvas);
        const b64 = canvas.toDataURL('image/png').split(',')[1];
        const outDefault = (loaded[0].path.replace(/[\\/][^\\/]+$/, '')) + (isV ? '/stitch-v.png' : '/stitch-h.png');
        const saveBtn = btn('保存 PNG', 'btn-primary btn-sm', async () => {
          try {
            const p = await invoke('dialog:save', { defaultPath: outDefault });
            if (!p) return;
            await invoke('fs:write-file-b64', p, b64);
            toast('已保存：' + p, 'success');
          } catch (e) { toast(e.message || String(e), 'error'); }
        }, 'save');
        canvasBox.appendChild(div('form-row', saveBtn, h('span', { class: 'field-hint' }, `${canvas.width}×${canvas.height}px`)));
      }
      page.appendChild(div('card', div('card-title', '添加图片'), picker.el));
      page.appendChild(div('card', div('card-title', '拼接'),
        div('form-row', btn('纵向拼接 ↓', 'btn-sm ' + (direction === 'v' ? 'btn-primary' : 'btn-secondary'), (e) => { direction = 'v'; stitch(); }),
          btn('横向拼接 →', 'btn-sm btn-secondary', () => { direction = 'h'; stitch(); })),
        canvasBox));
    }
  })
})();
