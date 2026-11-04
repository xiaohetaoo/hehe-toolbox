/* 模块：多媒体处理 —— img-scramble（图片混淆 / 解混淆）
 *
 * 【这个工具做什么，以及它不是什么】
 * 把图片的像素按一个可逆的置换打乱，让图看起来是一团噪声；
 * 用同样的密钥可以还原。用途是"不想让人随手看到"，例如：
 *   · 截图里有工号/聊天内容，发给别人前先糊掉
 *   · 给孩子看的作业答案图
 *
 * 【必须在界面上说清：视觉混淆 ≠ 加密】
 * 这不是加密。密钥只决定置换顺序，图片的**像素统计特征仍然保留**
 * （直方图几乎不变），有心的攻击者可以用统计方法恢复大致轮廓，
 * 更不用说知道算法的人直接穷举短密钥。
 * 真需要保密请用「文件加密解密」（AES-256）把整个文件加密。
 * 这条说明必须显眼，否则用户会误以为这是安全功能 —— 那是危险的产品设计。
 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, filePicker, progressEl } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';
  const { isImgPath, IMG_FILTER, loadImg } = window.MediaShared;

  /* 由密钥派生一个确定的伪随机序列（mulberry32）。
   * 【为什么不用 Math.random】它无法复现 —— 混淆后没法还原等于毁图。
   * 【为什么不用加密级 PRNG】这里的目的不是抗攻击（见文件头的说明），
   * 而是"打乱得足够均匀且可复现"。用短小可读的实现反而便于审查。 */
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* 把密钥字符串折成一个 32 位种子。空密钥直接拒绝（否则"没密码也能还原"）。 */
  function seedOf(key) {
    let h = 2166136261 >>> 0;
    const s = String(key || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* 对像素做可逆置换。
   * 做法：把总像素数 n 当作序列，用 Fisher-Yates 洗出一张置换表，
   * 混淆时按表搬运；解混淆时反向搬运。
   *
   * 【为什么要整份置换表而不是"每次算下一个位置"】
   * Fisher-Yates 是顺序依赖的（第 i 步依赖前面所有交换），
   * 正向和反向必须用同一张表才能对上。存表会占 4n 字节，
   * 对 4000×3000 的图约 48MB —— 可以接受，而且比"重新生成时必须
   * 严格回放同样的随机序列"更不容易出错。
   *
   * 【大图保护】超过 MAX_PIXELS 直接拒绝，避免浏览器标签直接崩掉。 */
  const MAX_PIXELS = 16 * 1024 * 1024; // 1600 万像素（约 4000×4000）

  function buildPermutation(n, seed) {
    const rng = makeRng(seed);
    const perm = new Uint32Array(n);
    for (let i = 0; i < n; i++) perm[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
    }
    return perm;
  }

  /* 混淆：dst[i] = src[perm[i]]
   * 解混淆：dst[perm[i]] = src[i]（同样一张表，反过来放） */
  function permute(imageData, perm, inverse) {
    const src = imageData.data;
    const n = perm.length;
    const dst = new Uint8ClampedArray(src.length);
    for (let i = 0; i < n; i++) {
      const si = i * 4;
      const di = (inverse ? perm[i] : i) * 4;
      if (inverse) {
        dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
      } else {
        const s = perm[i] * 4;
        dst[si] = src[s]; dst[si + 1] = src[s + 1]; dst[si + 2] = src[s + 2]; dst[si + 3] = src[s + 3];
      }
    }
    imageData.data.set(dst);
    return imageData;
  }

  register({
    id: 'img-scramble', name: '图片混淆', module: MOD, icon: 'crop',
    desc: '用密钥把图片像素打乱/还原，防止随手查看（注意：视觉混淆不是加密）',
    keywords: ['混淆', '还原', '打乱', '图片', 'scramble', '遮挡'],
    render(page) {
      const picker = filePicker({
        text: '拖入或选择要处理的图片（可多选）',
        filters: [IMG_FILTER],
        filter: (p) => isImgPath(p),
        multiple: true,
      });

      const keyIn = h('input', { class: 'input input-sm', placeholder: '密钥（还原时必须一模一样）', style: { width: '260px' } });
      const modeSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'scramble' }, '混淆（打乱）'),
        h('option', { value: 'restore' }, '还原'));
      const prog = progressEl();
      prog.hide();
      const preview = div('');
      preview.style.marginTop = '10px';

      /* 显眼的风险说明。用 warn 色而不是普通提示：
       * 这个工具最危险的误用是"以为它是加密"。 */
      const warning = div('danger-banner');
      warning.style.marginTop = '12px';
      warning.appendChild(div('danger-banner-title', '⚠ 视觉混淆不是加密'));
      warning.appendChild(div('danger-banner-text',
        '混淆只打乱像素位置，图片的统计特征仍在，有意的攻击者可以恢复大致轮廓。'
        + '真需要保密请用「文件加密解密」（AES-256）把整个文件加密。'));

      const runBtn = btn('开始处理', 'btn-primary', run, 'crop');

      async function processOne(path, perm, inverse, outDir) {
        const img = await loadImg(path);
        const w = img.naturalWidth, h0 = img.naturalHeight;
        if (w * h0 > MAX_PIXELS) throw new Error('图片过大（超过 ' + (MAX_PIXELS / 1048576) + ' 百万像素），请先压缩');
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h0;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const id = ctx.getImageData(0, 0, w, h0);
        permute(id, perm, inverse);
        ctx.putImageData(id, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');

        const rawName = path.split(/[\\/]/).pop();
        const dot = rawName.lastIndexOf('.');
        const stem = dot > 0 ? rawName.slice(0, dot) : rawName;
        const outName = stem + (inverse ? '_restored' : '_scrambled') + '.png';
        const outPath = await invoke('fs:unique-path', outDir.replace(/[\\/]$/, '') + '/' + outName);
        await invoke('fs:write-file-b64', outPath, dataUrl.split(',')[1]);
        return dataUrl;
      }

      async function run() {
        const files = picker.files();
        if (!files.length) return toast('请先添加图片', 'warn');
        const key = keyIn.value;
        if (!key) return toast('请填写密钥', 'warn');
        const inverse = modeSel.value === 'restore';
        const outDir = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (!outDir || !outDir[0]) return;
        prog.show();
        let ok = 0;
        const errs = [];
        try {
          for (let i = 0; i < files.length; i++) {
            prog.set((i + 1) / files.length * 100);
            try {
              const img = await loadImg(files[i]);
              const n = img.naturalWidth * img.naturalHeight;
              if (n > MAX_PIXELS) throw new Error('图片过大');
              // 每张图都重建置换表：同一密钥 + 同一尺寸 → 表相同，可还原
              const perm = buildPermutation(n, seedOf(key));
              const dataUrl = await processOne(files[i], perm, inverse, outDir[0]);
              ok++;
              if (i === 0) {
                preview.innerHTML = '';
                preview.appendChild(h('img', { src: dataUrl, style: { maxWidth: '100%', maxHeight: '240px', borderRadius: '8px', border: '1px solid var(--border)' } }));
              }
            } catch (e) { errs.push(files[i].split(/[\\/]/).pop() + '：' + e.message); }
          }
          if (ok) toast('完成 ' + ok + ' 张，输出：' + outDir[0], 'success');
          if (errs.length) toast('失败 ' + errs.length + ' 张：' + errs.slice(0, 3).join('；'), 'error', 6000);
        } finally {
          prog.hide();
        }
      }

      page.appendChild(div('card',
        div('card-title', '选择图片'),
        picker.el));
      page.appendChild(div('card',
        div('card-title', '处理选项'),
        div('form-row', h('span', { class: 'form-label' }, '模式'), modeSel),
        div('form-row', h('span', { class: 'form-label' }, '密钥'), keyIn,
          h('span', { class: 'field-hint' }, '同一张图必须用同一密钥才能还原')),
        warning,
        div('form-row', runBtn, prog.el)));
      page.appendChild(div('card', div('card-title', '预览'), preview));
    }
  });
})();
