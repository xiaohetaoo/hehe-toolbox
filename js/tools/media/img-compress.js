/* 模块：多媒体处理 —— img-compress（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, filePicker, fmtBytes, progressEl } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';
  const { isImgPath, IMG_FILTER, loadImg } = window.MediaShared;

register({
    id: 'img-compress', name: '图片压缩', nameEn: 'Image Compress', module: MOD, icon: 'image',
    desc: '智能压缩 / 指定质量 / 压到目标体积，JPG·WebP·PNG 输出与前后大小对比', descEn: 'Shrink images with a quality slider and a size target',
    keywords: ['压缩', '图片', '体积', 'webp', '缩小', '瘦身'],
    render(page) {
      /* 文件清单/删除由 filePicker 负责；压缩进度与前后体积直接写回列表行 */
      const modeSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'smart' }, '智能压缩（推荐）'),
        h('option', { value: 'target' }, '压到目标体积'),
        h('option', { value: 'quality' }, '指定质量'));
      /* 【默认质量可配置】设置 → 通用 → 图片压缩默认质量（10~100）。
       * 取不到时用规格默认值 80 —— Prefs.get 保证不会返回 undefined。 */
      const defQuality = (window.Prefs && window.Prefs.get('imgCompressQuality')) || 80;
      const qualityIn = h('input', { type: 'number', class: 'input input-sm', value: String(defQuality), min: '10', max: '100', style: { width: '70px' } });
      const targetIn = h('input', { type: 'number', class: 'input input-sm', value: '200', min: '5', style: { width: '80px' }, title: '每张压到不超过该体积（KB），质量逐级自动降低' });
      const maxWIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '不限', style: { width: '70px' }, title: '最大宽度（px），超出等比缩小' });
      const fmtSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'smart' }, '智能（透明→WebP，其余→JPG）'),
        h('option', { value: 'image/jpeg' }, 'JPG'),
        h('option', { value: 'image/webp' }, 'WebP'),
        h('option', { value: 'image/png' }, 'PNG'));
      const outDirIn = h('input', { class: 'input input-sm', placeholder: '输出目录（留空 = 原图目录/hehe-compressed）', style: { flex: '1' } });
      const pickOutBtn = btn('选择…', 'btn-sm btn-secondary', async () => {
        const d = await invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: ['openDirectory'] });
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
      let cancelFlag = false;
      /* 【per-run 序号 + 页面级清理】图片压缩原来是**唯一没有注册任何
       * onCleanup 的批量工具**：用户切页后循环继续跑，逐张读图、编码、
       * 写盘，而页面上既没有进度也没有停止入口。
       * 现在两点收口：
       *   ① cleanup 置 cancelFlag（循环每个文件开头检查它，见 run 的 for），
       *      所以"离开后不得再写新文件"；
       *   ② 递增序号让在飞的 run() 在下一个检查点退出（并在 finally
       *      只管自己那一代，不碰新界面的按钮）。 */
      let imgRunSeq = 0;
      let pageProg = null;
      function pageCleanup() {
        imgRunSeq++;
        cancelFlag = true;
        running = false;
        try {
          startBtn.disabled = false; stopBtn.disabled = true;
          picker.setLocked(false);
          if (pageProg) pageProg.hide();
          if (status.textContent && !/^完成/.test(status.textContent)) status.textContent = '已离开页面，压缩已停止';
        } catch (e) {}
      }
      window.App.onCleanup(pageCleanup);
      if (window.App.onEnter) {
        window.App.onEnter(() => {
          try { if (!running) { startBtn.disabled = false; stopBtn.disabled = true; } } catch (e) {}
        });
      }
      const startBtn = btn('开始压缩', 'btn-primary', run, 'send');
      const stopBtn = btn('停止', 'btn-danger-plain', () => { cancelFlag = true; stopBtn.disabled = true; }, 'square');
      stopBtn.disabled = true;

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
        const runToken = ++imgRunSeq;
        cancelFlag = false;
        running = true; startBtn.disabled = true;
        picker.setLocked(true);
        /* 【停止按钮必须真的可用】它初始 disabled（空闲时不该能点），
         * 但原实现只在页尾把它置回 true，从来没在这里解开：
         * 整批压缩（几十张、每张几秒）期间「停止」一直是灰的，
         * 而 cancelFlag 的整套停止/中途退出逻辑都以"用户能按到它"为前提。 */
        stopBtn.disabled = false;
        pageProg = prog;
        prog.show(); status.textContent = '';
        const paths = picker.paths.slice();
        const outDir = outDirIn.value.trim() || (window.PathText.dirname(paths[0]) + '/hehe-compressed');
        try { await invoke(Channels.CHANNELS.FS.MKDIR, outDir); } catch (e) {
          /* 建目录失败是整批的根因，不能吞掉后让每张图各自报错（R24-32）。 */
          if (runToken === imgRunSeq) {
            status.textContent = '✗ 输出目录不可写：' + ((e && e.message) || e);
            toast('输出目录不可写：' + ((e && e.message) || e), 'error');
            prog.hide(); running = false; startBtn.disabled = false; picker.setLocked(false);
            stopBtn.disabled = true;
            if (pageProg === prog) pageProg = null;
          }
          return;
        }
        let totalBefore = 0, totalAfter = 0, ok = 0, fail = 0, missCount = 0;
        for (let i = 0; i < paths.length; i++) {
          /* 【两个中断条件】
           *   · cancelFlag —— 用户点了停止，或页面已经离开（cleanup 置位）；
           *   · runToken  —— 这一趟已被新一代取代（重开压缩/复用回来后）
           * 任一成立就**不再写新文件**，这是"离开后不得继续落盘"的保证。 */
          if (cancelFlag || runToken !== imgRunSeq) break;
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
            const orig = (await invoke(Channels.CHANNELS.FS.STAT, p)).size;
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
              du = drawTo(img, mime, Math.min(100, Math.max(10, parseInt(qualityIn.value) || defQuality)) / 100, 1);
            }
            /* 【绝不能输出比原图更大的文件】
             * target 模式：源图本来就 ≤ 目标时，encodeTarget 会去找
             * 「≤目标的最大质量」—— 那可能比原图**大**（100KB 源 + 200KB 目标
             * 能得到 150~190KB）。smart 模式：q60 仍大于原图时也照样写盘。
             * 判据统一在 lib/img-pick.js（纯函数，可单测）。
             * 保留原图时直接读原文件字节 —— 不重新编码，做到逐字节等同。 */
            const candBytes = dataUrlBytes(du);
            const targetBytesAbs = modeSel.value === 'target' ? (parseInt(targetIn.value) || 200) * 1024 : undefined;
            const decision = (window.ImgPick || {}).decideOutcome
              ? window.ImgPick.decideOutcome({
                origBytes: orig,
                mode: modeSel.value,
                targetBytes: targetBytesAbs,
                candidate: { bytes: candBytes },
              })
              : { useOriginal: candBytes >= orig, alreadyFits: false, reason: '' };
            let outB64, outExt, alreadyFits = decision.alreadyFits;
            /* 【用户明确选了输出格式时，不能静默复制原格式】
             * 场景：target 模式 + 原图已达标（假设是个 80KB 的 PNG），
             * 而用户把「输出格式」选成了 WebP。原来直接复制 PNG 原文件，
             * 输出目录里躺着一个 .png —— 用户会以为自己选错了。
             * 规则：
             *   · 格式选「智能」 → 允许保留原格式（智能本来就是"看情况"）；
             *   · 格式显式指定（JPG/WebP/PNG）且与原图不同 → 必须转码，
             *     即便结果比原图大（用户要的是那个格式）；此时不再套用
             *     "绝不输出更大文件"的判据，但界面要如实标出体积变化。
             *   · 同格式或智能 → 保留原图的判据照旧生效。 */
            const origExt = '.' + (p.split('.').pop() || 'img').toLowerCase();
            const wantExt = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png';
            const fmtExpl = fmtSel.value !== 'smart';
            const fmtDiff = wantExt !== origExt && !(origExt === '.jpeg' && wantExt === '.jpg');
            const mustConvert = fmtExpl && fmtDiff;
            const useOrig = decision.useOriginal && !mustConvert;
            if (useOrig) {
              const raw = await invoke(Channels.CHANNELS.FS.READ_FILE_B64, p);
              outB64 = raw.b64;
              outExt = origExt;
            } else {
              outB64 = du.split(',')[1];
              outExt = wantExt;
              /* 强制转格式时不再是「已达标（保留原格式）」 */
              if (mustConvert) alreadyFits = false;
            }
            // 同名不同扩展（a.png + a.jpg → 都是 a.jpg）时自动加序号，避免互相覆盖
            /* 【离开/停止发生在编码期间：这一张不再落盘】循环开头只挡住"下一张"，
             * 编码本身可能耗时数秒；cleanup 的承诺是"离开后不写新文件"，
             * 所以写盘前再判一次。用户点「停止」时同样不再多写一张。 */
            if (cancelFlag || runToken !== imgRunSeq) break;
            let outPath = outDir.replace(/[\\/]$/, '') + '/' + name.replace(/\.\w+$/, '') + outExt;
            outPath = await invoke(Channels.CHANNELS.FS.UNIQUE_PATH, outPath);
            await invoke(Channels.CHANNELS.FS.WRITE_FILE_B64, outPath, outB64);
            const newSize = (await invoke(Channels.CHANNELS.FS.STAT, outPath)).size;
            /* 【兜底再验一次】上面判的是 dataUrl 的字节数，而写盘的是 base64 解码后的
             * 结果；两者理论上一致，但让写盘后实测的 newSize 再兜一次底更稳
             * （文件系统层面的大小才是最终事实）。万一仍然变大，删掉候选、如实报错。
             * 【强制转格式时例外】用户明确要 JPG/WebP，转出来变大也是他的选择 ——
             * 此时不删文件，但在界面上标出"体积变大"（橙色），不能报绿色成功。 */
            if (newSize > orig && !mustConvert) {
              try { await invoke(Channels.CHANNELS.FS.DELETE, outPath); } catch (e) {}
              throw new Error(`压缩结果（${fmtBytes(newSize)}）比原图（${fmtBytes(orig)}）更大，已放弃`);
            }
            /* 【target 模式未达目标：不能显示绿色成功】
             * encodeTarget 从 q95 往下找不到 ≤ 目标的档位时会返回"能压到的最小结果"，
             * 那个结果仍可能高于目标。界面原来只看有没有变小（pct >= 0 就绿），
             * 用户以为达标了，实际拿去上传仍然超限。 */
            const targetMissed = modeSel.value === 'target'
              && targetBytesAbs > 0 && newSize > targetBytesAbs;
            if (targetMissed) missCount++;
            ok++; totalBefore += orig; totalAfter += newSize;
            const pct = Math.round((1 - newSize / orig) * 100);
            const sizeEl = row && row.querySelector('.comp-size'), tagEl = row && row.querySelector('.tag');
            if (sizeEl) sizeEl.textContent = `${fmtBytes(orig)} → ${fmtBytes(newSize)}`;
            if (tagEl) {
              /* 【标签必须与真实结果一致】按优先级：
               *   1. 未达目标 → 橙色 + 实际体积（用户要知道没达成）
               *   2. 原图本来就达标 → 「已达标」（蓝色）
               *   3. 用户指定的格式导致变大 → 橙色 + 增幅
               *   4. **保留原图但并非"已达标"** → 「已保留原图」（灰/蓝）
               *   5. 正常压缩 → 绿色 -N%
               * 【第 4 条是本轮补的】smart/target 模式下候选不比原图小时会保留
               * 原图（decision.useOriginal），此时 newSize === orig，pct = 0。
               * 原来落到最后的 else 分支显示绿色 `-0%` —— 用户看到绿色以为
               * 压成功了一点点，实际是"原样输出、没有任何压缩"。 */
              const keptOriginalNotFits = useOrig && !alreadyFits && !targetMissed && !mustConvert;
              if (targetMissed) {
                /* 橙色 + 实际体积：用户必须知道没达成，以及实际是多少 */
                tagEl.textContent = '未达目标 ' + fmtBytes(newSize);
                tagEl.className = 'tag tag-orange';
                const errEl = row && row.querySelector('.comp-err');
                if (errEl) errEl.textContent = `目标 ${fmtBytes(targetBytesAbs)}，实际 ${fmtBytes(newSize)}（已降到最小可行质量仍超标）`;
              } else if (alreadyFits) { tagEl.textContent = '已达标'; tagEl.className = 'tag tag-blue'; }
              else if (mustConvert && newSize > orig) {
                /* 用户要的格式导致变大：如实标橙色，不能说成功 */
                tagEl.textContent = '转换后变大 +' + (-pct) + '%';
                tagEl.className = 'tag tag-orange';
              } else if (keptOriginalNotFits) {
                /* 候选压不更小 → 保留原图。用灰色"已保留原图"而不是绿色 -0%：
                 * 这不是"压缩成功"，而是"压不动所以没动"。 */
                tagEl.textContent = '已保留原图';
                tagEl.className = 'tag tag-gray';
                const errEl = row && row.querySelector('.comp-err');
                if (errEl) errEl.textContent = (decision.reason || '编码结果不比原图小') + '，已输出原文件';
              } else { tagEl.textContent = pct >= 0 ? `-${pct}%` : `+${-pct}%`; tagEl.className = 'tag ' + (pct >= 0 ? 'tag-green' : 'tag-orange'); }
            }
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
        /* 【只有当前这趟才改界面】过期（用户离开/重开）时界面属于别人，
         * 这里保持原样；pageProg 也要清掉，避免 cleanup 操作已过期的元素。 */
        if (runToken !== imgRunSeq) { if (pageProg === prog) pageProg = null; return; }
        /* 【用户点了停止就不能说"完成"】原来停止后循环 break，落到这里照样写
         * 「完成：成功 N…」并弹「压缩完成」—— 用户明明按了停止，却被告知完成，
         * 还会以为剩下那些是被跳过成功的。停了就说停了，并点名还剩几个没处理。 */
        const stopped = cancelFlag;
        cancelFlag = false;
        if (stopped) {
          for (let i = 0; i < paths.length; i++) {
            const row = picker.list.rowAt(i);
            const tagEl = row && row.querySelector('.tag');
            if (tagEl && /压缩中/.test(tagEl.textContent)) { tagEl.textContent = '未处理'; tagEl.className = 'tag tag-gray'; }
          }
        }
        prog.hide(); running = false; startBtn.disabled = false; picker.setLocked(false);
        stopBtn.disabled = true;
        if (pageProg === prog) pageProg = null;
        if (stopped) {
          const leftN = paths.length - ok - fail;
          status.textContent = `已停止：已压缩 ${ok} 个，失败 ${fail} 个，剩余 ${Math.max(0, leftN)} 个未处理；已输出的文件保留在 ${outDir}`;
          toast(`已停止（已压缩 ${ok} 个，剩余 ${Math.max(0, leftN)} 个未处理）`, 'warn');
          return;
        }
        /* 【汇总行不能笼统说"完成"】若有文件未达目标，用户只看到绿色总数
         * 会以为全部达标。这里把未达标数单独列出来。 */
        const missedNote = missCount ? `，其中 ${missCount} 个未达目标` : '';
        status.textContent = totalBefore ? `完成：成功 ${ok}，失败 ${fail}${missedNote}，合计 ${fmtBytes(totalBefore)} → ${fmtBytes(totalAfter)}（节省 ${fmtBytes(Math.max(0, totalBefore - totalAfter))}），输出目录 ${outDir}` : '';
        toast(`压缩完成（${ok} 成功 / ${fail} 失败${missedNote}）`, fail || missCount ? 'warn' : 'success');
      }
      page.appendChild(div('card', div('card-title', '选择图片'), picker.el));
      page.appendChild(div('card', div('card-title', '压缩参数'),
        div('form-row', h('span', { class: 'form-label' }, '模式'), modeSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '质量'), qualityIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '目标体积'), targetIn, h('span', { class: 'field-hint' }, 'KB'),
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '最大宽'), maxWIn),
        div('form-row', h('span', { class: 'form-label' }, '输出格式'), fmtSel),
        div('form-row', h('span', { class: 'form-label' }, '输出'), outDirIn, pickOutBtn),
        div('form-row', startBtn, ' ', stopBtn, prog.el, status)));
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
