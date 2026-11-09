/* 模块：多媒体处理 —— img-watermark（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, filePicker, progressEl } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';
  const { isImgPath, IMG_FILTER, loadImg } = window.MediaShared;

register({
    id: 'img-watermark', name: '图片水印', nameEn: 'Image Watermark', module: MOD, icon: 'wand',
    desc: '批量添加文字水印，支持位置、透明度、字号设置', descEn: 'Add text watermarks in bulk with position, opacity and size control',
    keywords: ['水印', '图片'],
    render(page) {
      let running = false; // 防重入标志：处理中禁止重复点击
      const picker = filePicker({
        text: '拖入或选择要加水印的图片（可多选）',
        filters: [IMG_FILTER],
        filter: isImgPath,
        onReject: (n) => toast(`已忽略 ${n} 个非图片文件`, 'warn')
      });
      const textIn = h('input', { class: 'input input-sm', value: '@核核工具箱', style: { flex: '1' } });
      const posSel = h('select', { class: 'select input-sm' },
        ...[['br', '右下'], ['bl', '左下'], ['tr', '右上'], ['tl', '左上'], ['center', '正中']].map(([v, n]) => h('option', { value: v }, n)));
      const sizeIn = h('input', { type: 'number', class: 'input input-sm', value: '28', style: { width: '80px' } });
      const opacityIn = h('input', { type: 'number', class: 'input input-sm', value: '50', min: '5', max: '100', style: { width: '80px' } });
      const preview = div('');
      const prog = progressEl(); prog.hide();
      async function run() {
        if (running) return; // 防重入：双击「开始」会并发跑两遍
        if (!picker.count) return toast('请先选择图片', 'warn');
        if (!textIn.value.trim()) return toast('请输入水印文字', 'warn');
        running = true;
        prog.show();
        picker.setLocked(true);
        const paths = picker.paths.slice();
        const firstDir = paths[0].replace(/[\\/][^\\/]+$/, '');
        const outDir = firstDir + '/hehe-watermark';
        try { await invoke(Channels.CHANNELS.FS.MKDIR, outDir); } catch (e) { running = false; prog.hide(); picker.setLocked(false); return toast('创建输出目录失败：' + e.message, 'error'); }
        let ok = 0;
        let fail = 0;
        const errs = [];
        try {
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
            /* 【扩展名必须跟着真实编码走，不能照抄原扩展名】
             * 原来只分 png / 其它两种情况（其它一律按 JPEG 编码），
             * 但输出名却照抄原扩展名。WebP 输入于是得到：
             *   · 内容是 JPEG（toDataURL('image/jpeg')）
             *   · 文件名是 xxx_wm.webp
             * 这是一个**扩展名说谎**的文件：资源管理器按 .webp 显示缩略图、
             * 部分程序按扩展名选解码器，都会打不开或显示错误。
             * 而本工具的图片白名单里就包含 webp/bmp/gif（见 shared.js），
             * 所以这条路径不是理论上的边角。
             *
             * 现在：能原样保持的只有 png / jpg / jpeg / webp 四种（canvas 都支持编码）；
             * 其余（bmp / gif）统一按 JPEG 输出，扩展名同步改成 .jpg ——
             * 宁可改扩展名，也不让文件内容与名字对不上。 */
            const ENCODABLE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
            const mime = ENCODABLE[ext] || 'image/jpeg';
            const dataUrl = canvas.toDataURL(mime, 0.92);
            const rawName = p.split(/[\\/]/).pop();
            // 原来用 name.replace(/\.(\w+)$/, '_wm.$1')：文件名**没有扩展名**时
            // replace 不匹配，输出名就等于原名 -> 输出到原目录时把原图盖掉。
            // 改成显式拆出扩展名再拼，没有扩展名时补一个默认的。
            const dot = rawName.lastIndexOf('.');
            const hasExt = dot > 0; // 0 表示以点开头（隐藏文件），负数表示无扩展名
            const stem = hasExt ? rawName.slice(0, dot) : rawName;
            const extPart = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
            const outName = stem + '_wm.' + extPart;
            // 一律取唯一名：既防覆盖原图，也防覆盖目录里已存在的同名输出
            const outPath = await invoke(Channels.CHANNELS.FS.UNIQUE_PATH, outDir.replace(/[\\/]$/, '') + '/' + outName);
            await invoke(Channels.CHANNELS.FS.WRITE_FILE_B64, outPath, dataUrl.split(',')[1]);
            ok++;
            if (i === 0) {
              preview.innerHTML = '';
              preview.appendChild(h('img', { src: dataUrl, style: { maxWidth: '100%', maxHeight: '300px', borderRadius: '8px', border: '1px solid var(--border)' } }));
            }
          } catch (e) {
            /* 【单张失败必须计数并说出来】
             * 原来只有一句 console.error(e) —— 而打包后的 exe 没有控制台，
             * 等于什么都不留。用户看到的是「完成，成功 N 张」，
             * 而队列里其实有几张是失败的：他只会以为工具少处理了。
             * 收集起来在末尾如实报出（与 img-batch / target-size 同一口径）。 */
            fail++;
            if (errs.length < 5) {
              /* 【这里不能用 p】p 是 try 块内的 const，catch 里已经在作用域外，
               * 写 String(p) 会抛 `ReferenceError: p is not defined` ——
               * 而这句本身就在错误处理里，于是"报失败"变成了"报失败时又崩一次"，
               * 整轮处理中断（test-img-watermark 直接抓到 reject: p is not defined）。
               * 用循环外的 paths[i] 取同一个值，它在整个 for 体内都可见。 */
              const nm = String(paths[i]).split(/[\\/]/).pop() || String(paths[i]);
              errs.push(nm + '：' + ((e && e.message) || String(e)));
            }
          }
        }
        toast(`完成，成功 ${ok} 张${fail ? '，失败 ' + fail + ' 张' : ''}，输出：${outDir}`,
          fail ? 'warn' : 'success');
        if (fail) toast('失败明细：' + errs.join('；') + (fail > errs.length ? ' …' : ''), 'error', 6000);
        } finally {
          // 异常也必须解锁，否则一次失败就让本页永久不可用
          running = false; prog.hide(); picker.setLocked(false);
        }
      }
      page.appendChild(div('card', div('card-title', '选择图片'), picker.el));
      page.appendChild(div('card', div('card-title', '水印设置'),
        div('form-row', h('span', { class: 'form-label' }, '文字'), textIn),
        div('form-row', h('span', { class: 'form-label' }, '位置'), posSel, ' 字号', sizeIn, ' 透明度%', opacityIn),
        div('form-row', btn('添加水印', 'btn-primary', run, 'droplet'), prog.el)));
      page.appendChild(div('card', div('card-title', '首图预览'), preview));
    }
  })
})();
