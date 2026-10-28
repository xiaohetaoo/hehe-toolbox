/* 模块：目标体积压缩 —— 按「压到指定大小」自动多轮逼近
 *
 * 与「图片压缩」「视频压制」的区别：
 *   那些工具的输入是「质量/CRF 参数」，用户要自己反复试才能命中某个体积；
 *   这个工具的输入是「目标大小上限」，内部自动迭代直到达标或确认做不到。
 *
 * 设计要点（借鉴 YourCatFileAssistant）：
 *   - 源文件本来就达标 → 直接另存，标「已符合上限」，不浪费画质
 *   - 最多 8 轮，每轮按实际结果收紧参数
 *   - 绝不截断时长、绝不删音轨凑体积
 *   - 进度最多 99%，提交成功才 100%
 *   - 处理中禁用导入与参数修改
 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, dropzone, fmtBytes, progressEl } = window.ui;
  const { invoke, on, isDesktop } = window.api;
  const MOD = 'media';

  const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp'];
  const AV_EXT = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv', 'wmv', 'ts', 'mp3', 'm4a', 'aac', 'wav', 'flac'];
  const extOf = (p) => String(p).split('.').pop().toLowerCase();
  const isImg = (p) => IMG_EXT.includes(extOf(p));
  const isAv = (p) => AV_EXT.includes(extOf(p));

  function loadImg(path) {
    return new Promise(async (resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      try {
        const r = await invoke('fs:read-file-b64', path);
        img.src = 'data:image;base64,' + r.b64;
      } catch (e) { reject(e); }
    });
  }

  register({
    id: 'target-size',
    name: '目标体积压缩',
    module: MOD,
    icon: 'target',
    desc: '压到指定大小：自动多轮逼近目标体积，图片与音视频通用',
    keywords: ['目标', '体积', '压缩', '大小', 'mb', '瘦身', '限制'],
    render(page) {
      let files = [];
      let running = false;
      let canceled = false;

      const dz = dropzone({
        text: '拖入图片或音视频（可多选）',
        onFiles: (p) => {
          if (running) return toast('正在处理中，请先等待完成或点停止', 'warn');
          const okList = p.filter(x => isImg(x) || isAv(x));
          const skipped = p.length - okList.length;
          files.push(...okList);
          label.textContent = `已选 ${files.length} 个文件` + (skipped ? `（已忽略 ${skipped} 个不支持的类型）` : '');
          refreshList();
        }
      });
      const label = div('field-hint', '未选择文件');

      /* ---- 目标体积：快捷档位 或 指定 MB ---- */
      const tierSel = h('select', { class: 'select' });
      for (const t of [
        { id: 'large', name: '大（原体积 80%）', v: 'ratio:0.8' },
        { id: 'medium', name: '中（原体积 50%）', v: 'ratio:0.5' },
        { id: 'small', name: '小（原体积 30%）', v: 'ratio:0.3' },
        { id: 'tiny', name: '超小（原体积 15%）', v: 'ratio:0.15' }
      ]) tierSel.appendChild(h('option', { value: t.v }, t.name));
      const mbIn = h('input', { class: 'input input-sm mono', type: 'number', min: '0.1', step: '0.1', value: '10', style: { width: '90px' } });
      const modeRadios = [
        { id: 'ratio', label: '按原体积比例' },
        { id: 'abs', label: '指定大小（MB）' }
      ];
      let mode = 'ratio';
      const modeBox = div('form-row');
      for (const m of modeRadios) {
        const r = h('input', { type: 'radio', name: 'tsmode', class: 'radio' });
        r.checked = m.id === mode;
        r.addEventListener('change', () => {
          mode = m.id;
          tierSel.disabled = m.id !== 'ratio';
          mbIn.disabled = m.id !== 'abs';
        });
        modeBox.appendChild(h('label', { class: 'field-hint' }, r, ' ' + m.label));
      }
      tierSel.disabled = false;
      mbIn.disabled = true;

      const outDirIn = h('input', { class: 'input mono input-sm', placeholder: '留空则输出到源文件旁的 hehe-target 目录', style: { flex: '1' } });
      const pickOut = btn('选择…', 'btn-sm btn-secondary', async () => {
        try {
          const r = await invoke('dialog:open', { properties: ['openDirectory'] });
          if (r && r[0]) outDirIn.value = r[0];
        } catch (e) { toast(e.message, 'error'); }
      });

      const listBox = div('');
      const prog = progressEl(); prog.hide();
      const status = div('field-hint', '');
      const startBtn = btn('🚀 开始压缩', 'btn-primary', run);
      const cancelBtn = btn('■ 停止', 'btn-danger-plain', () => {
        canceled = true;
        if (runJobId) invoke('job:kill', runJobId).catch(() => {});
      });
      cancelBtn.disabled = true;

      let runJobId = null;

      function refreshList() {
        listBox.innerHTML = '';
        files.forEach((f, i) => {
          const row = div('form-row');
          row.dataset.i = i;
          const tag = h('span', { class: 'tag tag-gray', style: { width: '64px', justifyContent: 'center' } }, '等待中');
          tag.classList.add('ts-tag');
          row.appendChild(tag);
          row.appendChild(h('span', { style: { flex: '1', fontSize: '12px', wordBreak: 'break-all' } }, f.split(/[\\/]/).pop()));
          row.appendChild(h('span', { class: 'field-hint' }, isImg(f) ? '图片' : '音视频'));
          const bar = div('progress', { style: { width: '120px' } });
          const fill = div('progress-fill'); fill.classList.add('ts-fill');
          bar.appendChild(fill);
          row.appendChild(bar);
          row.appendChild(h('span', { class: 'field-err', style: { fontSize: '11px', maxWidth: '200px' } }, ''));
          listBox.appendChild(row);
        });
      }

      function setRow(i, { tagText, tagClass, pct, rowText }) {
        const row = listBox.querySelector(`[data-i="${i}"]`);
        if (!row) return;
        const tag = row.querySelector('.ts-tag');
        const fill = row.querySelector('.ts-fill');
        const errEl = row.querySelector('.field-err');
        if (tagText && tag) { tag.textContent = tagText; tag.className = 'tag ts-tag ' + (tagClass || 'tag-gray'); }
        if (pct != null && fill) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
        if (rowText && errEl) errEl.textContent = rowText;
      }

      function targetOf(srcBytes) {
        if (mode === 'ratio') {
          const ratio = parseFloat(String(tierSel.value).split(':')[1]) || 0.5;
          return Math.max(1, Math.floor(srcBytes * ratio));
        }
        const mb = parseFloat(mbIn.value);
        if (!(mb > 0)) return 0;
        return Math.floor(mb * 1000000); // 与对方一致：1 MB = 1,000,000 字节
      }

      /* ---- 单张图片的多轮逼近（在渲染层用 canvas 完成） ---- */
      async function compressImage(path, targetBytes, outDir, rowIdx) {
        const img = await loadImg(path);
        const srcBytes = (await invoke('fs:stat', path)).size;
        const name = path.split(/[\\/]/).pop();
        const base = name.replace(/\.[^.]+$/, '');
        const ext = extOf(name);
        const outExt = (ext === 'png') ? 'png' : 'jpg'; // PNG 保留 alpha，其余转 JPG 更好压
        if (srcBytes <= targetBytes) {
          // 已达标：直接另存，不重编码
          const r = await invoke('fs:read-file-b64', path);
          const dst = await invoke('fs:unique-path', outDir + '/' + name);
          await invoke('fs:write-file-b64', dst, r.b64);
          return { ok: true, out: dst, srcSize: srcBytes, outSize: srcBytes, alreadyFits: true, rounds: 0 };
        }
        const tmpDir = outDir; // 候选也写同目录，最终成功后改名；这里直接按轮次生成不同文件名
        let lastBytes = 0, lastErr = '';
        for (let round = 0; round < 8; round++) {
          if (canceled) return { ok: false, err: '已取消' };
          const plan = await invoke('target:plan-image', { round });
          const scale = plan.scale || 1;
          const cw = Math.max(1, Math.round(img.naturalWidth * scale));
          const ch = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          const ctx = canvas.getContext('2d');
          if (outExt === 'jpg') { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, cw, ch); }
          ctx.drawImage(img, 0, 0, cw, ch);
          const mime = outExt === 'png' ? 'image/png' : 'image/jpeg';
          const dataUrl = canvas.toDataURL(mime, plan.quality);
          const b64 = String(dataUrl).split(',')[1] || '';
          if (!b64) { lastErr = 'canvas 编码失败'; break; }
          // 先写候选，量体积，再决定去留
          const cand = await invoke('fs:unique-path', tmpDir + '/' + base + `(ts${round}).${outExt}`);
          await invoke('fs:write-file-b64', cand, b64);
          const bytes = (await invoke('fs:stat', cand)).size;
          lastBytes = bytes;
          const verdict = await invoke('target:eval-image', { outBytes: bytes, targetBytes, round });
          if (verdict.ok) {
            // 达标：改成正式名
            const dst = await invoke('fs:unique-path', tmpDir + '/' + base + '.' + outExt);
            // rename 可能因跨卷/占用失败，此时文件还在候选名上——
            // 必须如实返回实际路径，否则界面给出一个不存在的输出文件
            let finalPath = dst;
            try { await invoke('fs:rename', cand, dst); }
            catch (e) { finalPath = cand; }
            return { ok: true, out: finalPath, srcSize: srcBytes, outSize: bytes, rounds: round + 1 };
          }
          try { await invoke('fs:delete', cand); } catch (e) {}
          setRow(rowIdx, { pct: ((round + 1) / 8) * 99 });
          if (verdict.done) { lastErr = verdict.reason || '未能压到目标体积'; break; }
        }
        return { ok: false, err: lastErr || `未能压到目标体积（最后 ${fmtBytes(lastBytes)}）` };
      }

      async function run() {
        if (running) return;
        if (!files.length) return toast('请先选择文件', 'warn');
        if (mode === 'abs' && !(parseFloat(mbIn.value) > 0)) return toast('请输入有效的目标大小（MB）', 'warn');

        running = true; canceled = false;
        startBtn.disabled = true; cancelBtn.disabled = false;
        dz.el.classList.add('busy');
        prog.show(); status.textContent = '准备中…';

        // 分组：图片走渲染层逐轮编码；音视频整体交给主进程
        const imgs = files.filter(isImg);
        const avs = files.filter(isAv);
        const outDirBase = outDirIn.value.trim() || (files[0].replace(/[\\/][^\\/]*$/, '') + '/hehe-target');
        try { await invoke('fs:mkdir', outDirBase); } catch (e) {
          running = false; startBtn.disabled = false; cancelBtn.disabled = true; prog.hide();
          return toast('创建输出目录失败：' + (window.api.errText ? window.api.errText(e) : e.message), 'error');
        }

        let okCount = 0, failCount = 0;
        const failures = [];

        try {
          /* ---- 图片：逐个多轮逼近 ---- */
          for (let k = 0; k < imgs.length; k++) {
            if (canceled) break;
            const idx = files.indexOf(imgs[k]);
            setRow(idx, { tagText: '压缩中', tagClass: 'tag-orange' });
            status.textContent = `处理中 ${k + 1}/${imgs.length}（图片）`;
            try {
              const srcSize = (await invoke('fs:stat', imgs[k])).size;
              const target = targetOf(srcSize);
              const r = await compressImage(imgs[k], target, outDirBase, idx);
              if (r.ok) {
                okCount++;
                setRow(idx, {
                  tagText: r.alreadyFits ? '已达标' : '✓ 完成',
                  tagClass: r.alreadyFits ? 'tag-blue' : 'tag-green',
                  pct: 100,
                  rowText: `${fmtBytes(r.srcSize)} → ${fmtBytes(r.outSize)}`
                });
              } else {
                failCount++; failures.push(`${imgs[k]}: ${r.err}`);
                setRow(idx, { tagText: '✗ 失败', tagClass: 'tag-red', rowText: r.err });
              }
            } catch (e) {
              failCount++; failures.push(`${imgs[k]}: ${e.message}`);
              setRow(idx, { tagText: '✗ 失败', tagClass: 'tag-red', rowText: e.message });
            }
          }

          /* ---- 音视频：主进程内部完成 8 轮逼近，这里只订阅进度 ---- */
          if (avs.length && !canceled) {
            let ratio = 0.5, targetBytes = 0;
            if (mode === 'ratio') ratio = parseFloat(String(tierSel.value).split(':')[1]) || 0.5;
            else targetBytes = Math.floor(parseFloat(mbIn.value) * 1000000);

            let seenId = null;
            const unsub = on('job:stream', (d) => {
              try {
                if (!d || !d.id) return;
                if (runJobId) { if (d.id !== runJobId) return; }
                else { if (!/^tgt/.test(String(d.id))) return; if (!seenId) seenId = d.id; else if (d.id !== seenId) return; }
                const j = JSON.parse(d.data);
                const idx = avs[j.i] ? files.indexOf(avs[j.i]) : -1;
                if (idx < 0) return;
                if (j.stage === 'probe') { setRow(idx, { tagText: '分析中', tagClass: 'tag-orange' }); return; }
                if (j.pct != null) setRow(idx, { pct: j.pct });
                if (j.done) {
                  if (j.ok) { okCount++; setRow(idx, { tagText: '✓ 完成', tagClass: 'tag-green', pct: 100 }); }
                  else { failCount++; setRow(idx, { tagText: '✗ 失败', tagClass: 'tag-red' }); }
                }
              } catch (e) {}
            });
            if (window.App && App.onCleanup) App.onCleanup(unsub);
            try {
              status.textContent = `处理中（音视频 ${avs.length} 个）…`;
              const r = await invoke('target:compress-av', {
                items: avs, outDir: outDirBase,
                targetBytes, mode, ratio
              });
              runJobId = r.id;
              for (const item of r.results || []) {
                const idx = files.indexOf(item.input);
                if (idx < 0) continue;
                if (item.ok) {
                  const already = item.alreadyFits;
                  setRow(idx, {
                    tagText: already ? '已达标' : '✓ 完成',
                    tagClass: already ? 'tag-blue' : 'tag-green', pct: 100,
                    rowText: `${fmtBytes(item.srcSize)} → ${fmtBytes(item.outSize)}（${item.rounds} 轮）`
                  });
                } else {
                  setRow(idx, { tagText: '✗ 失败', tagClass: 'tag-red', rowText: item.err || '' });
                  if (item.err) failures.push(`${item.input}: ${item.err}`);
                }
              }
              if (r.canceled) canceled = true;
            } catch (e) {
              toast('音视频压缩失败：' + (window.api.errText ? window.api.errText(e) : e.message), 'error');
              failCount += avs.length;
            } finally { try { unsub(); } catch (e) {} }
          }

          prog.set(100);
          if (canceled) status.textContent = `已停止：成功 ${okCount}，失败 ${failCount}`;
          else status.textContent = `完成：成功 ${okCount}，失败 ${failCount}，输出到 ${outDirBase}`;

          if (failCount === 0) toast(okCount ? `全部完成，共 ${okCount} 个` : '没有可处理的文件', 'success');
          else if (failures.length) window.ui.alertBox(failures.join('\n'), '部分文件未能压到目标体积');
        } finally {
          running = false;
          startBtn.disabled = false; cancelBtn.disabled = true;
          dz.el.classList.remove('busy');
          runJobId = null;
          setTimeout(() => prog.hide(), 800);
        }
      }

      /* ---- 页面组装 ---- */
      page.appendChild(div('card', div('card-title', '选择文件'), dz, label));
      const targetCard = div('card', div('card-title', '目标体积'),
        modeBox,
        div('form-row', h('span', { class: 'form-label' }, '比例'), tierSel, ' ',
          h('span', { class: 'form-label' }, '大小'), mbIn, h('span', { class: 'field-hint' }, 'MB')),
        div('field-hint', '「按比例」= 每个文件各自按原体积的比例计算上限；「指定大小」= 每个文件都不超过该 MB。两者都是单文件上限，不是整批总和。'));
      const outCard = div('card', div('card-title', '输出位置'), div('form-row', outDirIn, pickOut));
      const runCard = div('card', div('card-title', '执行'), div('form-row', startBtn, ' ', cancelBtn, prog.el), status, listBox);
      page.appendChild(targetCard);
      page.appendChild(outCard);
      page.appendChild(runCard);

      // 页面卸载时取消正在跑的任务，避免关闭页面后后台还在压
      if (window.App && App.onCleanup) {
        App.onCleanup(() => {
          if (runJobId) invoke('job:kill', runJobId).catch(() => {});
        });
      }
    }
  });
})();
