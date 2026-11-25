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
      /* 【per-run 序号】理由同 img-batch：cleanup 放开 running 后用户可能立刻再点，
       * 新一轮会把 cancelFlag 置回 false，上一轮醒来后就会继续写盘 → 两轮并发。
       * 序号让旧轮在检查点退出，且 finally 只复位自己那一代。 */
      let wmRunSeq = 0;
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
      let cancelFlag = false;
      const wmRunBtn = btn('添加水印', 'btn-primary', run, 'droplet');
      const wmStopBtn = btn('停止', 'btn-danger-plain', () => { cancelFlag = true; wmStopBtn.disabled = true; }, 'square');
      wmStopBtn.disabled = true;
      async function run() {
        if (running) return; // 防重入：双击「开始」会并发跑两遍
        if (!picker.count) return toast('请先选择图片', 'warn');
        if (!textIn.value.trim()) return toast('请输入水印文字', 'warn');
        cancelFlag = false;
        running = true;
        const wmToken = ++wmRunSeq;
        prog.show();
        /* 【停止按钮必须真的可用】它初始化是 disabled（没有任务不该能点），
         * 但原实现从头到尾没有把它解开：整批处理期间「停止」一直是灰的，
         * 而 cleanup/停止标志的整套机制都以"用户能按到它"为前提 ——
         * 等于这一个页面的停止功能完全不存在。 */
        wmStopBtn.disabled = false;
        picker.setLocked(true);
        const paths = picker.paths.slice();
        const firstDir = window.PathText.dirname(paths[0]);
        const outDir = firstDir + '/hehe-watermark';
        try { await invoke(Channels.CHANNELS.FS.MKDIR, outDir); } catch (e) { running = false; prog.hide(); picker.setLocked(false); return toast('创建输出目录失败：' + e.message, 'error'); }
        let ok = 0;
        let fail = 0;
        const errs = [];
        try {
        for (let i = 0; i < paths.length; i++) {
          if (cancelFlag || wmToken !== wmRunSeq) break;   // 用户点了停止，或页面已离开
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
            /* 【编码完再判一次停止】同 img-batch：一张图解码+编码可能数秒，
             * 用户在这期间点停止/切页时，不该再多写一张。 */
            if (cancelFlag || wmToken !== wmRunSeq) break;
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
        /* 【点了停止就不能说"完成"】原来 break 之后照样弹「完成，成功 N 张」——
         * 停在第 3 张也报完成。停了就说停了，并点名还剩几个没处理。 */
        if (cancelFlag) {
          const leftN = paths.length - ok - fail;
          toast(`已停止：已处理 ${ok} 张${fail ? '，失败 ' + fail + ' 张' : ''}，剩余 ${leftN} 张未处理；已输出的文件在 ${outDir}`, 'warn');
        } else {
          toast(`完成，成功 ${ok} 张${fail ? '，失败 ' + fail + ' 张' : ''}，输出：${outDir}`,
            fail ? 'warn' : 'success');
        }
        if (fail) toast('失败明细：' + errs.join('；') + (fail > errs.length ? ' …' : ''), 'error', 6000);
        } finally {
          // 异常也必须解锁，否则一次失败就让本页永久不可用
          if (wmToken === wmRunSeq) {
            running = false; prog.hide(); picker.setLocked(false); wmStopBtn.disabled = true;
          }
        }
      }
      /* 【离开页面 = 停止】原来没有任何 cleanup：切页后整批图片继续逐张写盘，
       * 而页面上没有任何停止入口。停止按钮与切页走同一个标志。 */
      window.App.onCleanup(() => {
        cancelFlag = true;
        wmRunSeq++;
        try {
          wmStopBtn.disabled = true; prog.hide();
          /* 【离开页面必须把整页状态复位】原来只置停止标志，running 仍是 true、
           * picker 仍是 locked。保活复用回到本页时，用户看到的是
           * 「加不了文件、删不掉列表、点开始也没反应（被 running 挡住）」
           * 的一个彻底卡死的页面，只能去别的工具页绕一圈再回来。 */
          running = false;
          picker.setLocked(false);
        } catch (e) {}
      });
      page.appendChild(div('card', div('card-title', '选择图片'), picker.el));
      page.appendChild(div('card', div('card-title', '水印设置'),
        div('form-row', h('span', { class: 'form-label' }, '文字'), textIn),
        div('form-row', h('span', { class: 'form-label' }, '位置'), posSel, ' 字号', sizeIn, ' 透明度%', opacityIn),
        div('form-row', wmRunBtn, wmStopBtn, prog.el)));
      page.appendChild(div('card', div('card-title', '首图预览'), preview));
    }
  })
})();
