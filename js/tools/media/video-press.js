/* 模块：多媒体处理 —— video-press（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, filePicker, fmtBytes } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';

register({
    id: 'video-press', name: '视频压制', module: MOD, icon: 'film',
    desc: 'H.264/H.265 重编码瘦身：预设、CRF、分辨率、音频码率，压完看省了多少',
    keywords: ['压制', '视频', '压缩', 'h265', 'hevc', '瘦身', '体积'],
    render(page) {
      /* 文件清单/删除由 filePicker 负责；压制进度与节省体积写回列表行 */
      const presetSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'balanced' }, '均衡推荐（H.264 · CRF23 · 中速）'),
        h('option', { value: 'quality' }, '高画质（H.265 · CRF20 · 慢速）'),
        h('option', { value: 'strong' }, '极限瘦身（H.265 · CRF28 · 中速）'),
        h('option', { value: 'custom' }, '自定义'));
      const codecSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'libx264' }, 'H.264（兼容最好）'), h('option', { value: 'libx265' }, 'H.265（体积更小）'));
      const crfIn = h('input', { type: 'number', class: 'input input-sm', value: '23', min: '14', max: '36', style: { width: '64px' }, title: '质量：越小越清晰、体积越大' });
      const speedSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'veryfast' }, '中速'), h('option', { value: 'ultrafast' }, '快速（体积略大）'),
        h('option', { value: 'medium' }, '较慢（体积更小）'), h('option', { value: 'slow' }, '慢（体积最小）'));
      const scaleSel = h('select', { class: 'select input-sm' },
        h('option', { value: '' }, '保持原分辨率'), h('option', { value: '1920' }, '限 1080p'), h('option', { value: '1280' }, '限 720p'), h('option', { value: '854' }, '限 480p'));
      const fpsIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '帧率', style: { width: '64px' } });
      const audioSel = h('select', { class: 'select input-sm' },
        h('option', { value: '128k' }, '音频重编码 128k'), h('option', { value: '96k' }, '音频重编码 96k'),
        h('option', { value: 'copy' }, '音频直接复制'), h('option', { value: 'mute' }, '移除音频'));
      const stripChk = h('input', { type: 'checkbox', class: 'checkbox' }); stripChk.checked = true;
      const outDirIn = h('input', { class: 'input input-sm', placeholder: '输出目录（留空 = 源文件目录/hehe-pressed）', style: { flex: '1' } });
      const pickOutBtn = btn('选择…', 'btn-sm btn-secondary', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) outDirIn.value = d[0];
      });
      const picker = filePicker({
        text: '拖入或选择要压制的视频（可多选）',
        emptyText: '还没有添加视频',
        beforeRemove: () => {
          if (running) { toast('压制进行中，请先点「取消」再修改文件列表', 'warn'); return false; }
          return true;
        },
        rowEnd: (item, i, row) => {
          row.appendChild(h('span', { class: 'tag tag-gray av-tag', style: { width: '64px', justifyContent: 'center' } }, '等待中'));
          row.appendChild(h('span', { class: 'vp-size field-hint', style: { fontSize: '11px' } }, ''));
          const bar = div('progress', { style: { width: '120px' } });
          bar.appendChild(div('progress-fill'));
          row.appendChild(bar);
          row.appendChild(h('span', { class: 'field-err av-err', style: { fontSize: '11px', maxWidth: '200px' } }, ''));
        }
      });
      const status = h('span', { class: 'field-hint' }, '');
      let running = false;
      let runJobId = null; // 本页任务的 job id：按 id 精确取消，避免 cancel-latest 取消到别的任务
      const startBtn = btn('开始压制', 'btn-primary', run, 'send');
      const cancelBtn = btn('取消', 'btn-danger-plain', () => { if (runJobId) invoke('job:kill', runJobId).catch(() => {}); }, 'square');
      cancelBtn.disabled = true;
      function applyPreset() {
        const v = presetSel.value;
        const custom = v === 'custom';
        codecSel.disabled = !custom; crfIn.disabled = !custom; speedSel.disabled = !custom;
        if (v === 'balanced') { codecSel.value = 'libx264'; crfIn.value = '23'; speedSel.value = 'veryfast'; }
        else if (v === 'quality') { codecSel.value = 'libx265'; crfIn.value = '20'; speedSel.value = 'slow'; }
        else if (v === 'strong') { codecSel.value = 'libx265'; crfIn.value = '28'; speedSel.value = 'medium'; }
      }
      presetSel.addEventListener('change', applyPreset); applyPreset();
      async function run() {
        if (!picker.count) return toast('请先选择视频', 'warn');
        if (running) return;
        const st = await invoke('ffmpeg:status').catch(() => ({ ffmpeg: null }));
        if (!st.ffmpeg) {
          toast('未安装 FFmpeg，请先前往「FFmpeg 环境」安装', 'warn');
          window.App.openTool('ffmpeg-setup');
          return;
        }
        running = true; startBtn.disabled = true; cancelBtn.disabled = false;
        picker.setLocked(true);
        status.textContent = '';
        runJobId = null;
        const outDir = outDirIn.value.trim() || (picker.paths[0].replace(/[\\/][^\\/]*$/, '') + '/hehe-pressed');
        // job id 从流事件里取：invoke 要等全部压制结束才返回，那时已经来不及取消了
        // 【必须按前缀认领】本任务 id 形如 prs<数字>。原因同 av-convert：
        // 不校验归属会抓到别的标签页的任务 id，点「取消」杀错任务。
        const unsub = window.JobPrefix.subscribe('prs', (d) => {
          const jid = String(d.id || '');
            /* 前缀认领已由 subscribe 完成；这里只同步 runJobId（job:kill 要传它）。
             * runJobId 是业务状态（取消按钮用），与 subscribe 内部的 claimedId 用途不同，
             * 两边都要维护。 */
            if (!runJobId) runJobId = jid; else if (jid !== runJobId) return;
          try {
            const j = JSON.parse(d.data);
            const row = picker.list.rowAt(j.i);
            if (!row) return;
            const tag = row.querySelector('.av-tag');
            const bar = row.querySelector('.progress-fill');
            if (j.stage === 'start') { if (tag) { tag.textContent = '压制中'; tag.className = 'tag tag-orange'; } return; }
            if (j.pct != null && bar && !j.done) bar.style.width = (j.pct || 0) + '%';
            if (j.done && tag) { tag.textContent = j.ok ? '✓ 完成' : '✗ 失败'; tag.className = 'tag ' + (j.ok ? 'tag-green' : 'tag-red'); }
          } catch (e) {}
        });
        if (window.App && App.onCleanup) App.onCleanup(unsub);
        try {
          const r = await invoke('ffmpeg:press', {
            items: picker.paths, outDir,
            opts: {
              vcodec: codecSel.value, crf: parseInt(crfIn.value) || 23, preset: speedSel.value,
              scale: scaleSel.value, fps: fpsIn.value ? parseInt(fpsIn.value) : null,
              audio: audioSel.value, stripMeta: stripChk.checked
            }
          });
          let okN = 0, saveB = 0;
          r.results.forEach((res, i) => {
            const row = picker.list.rowAt(i);
            if (!row) return;
            const tag = row.querySelector('.av-tag'), errEl = row.querySelector('.av-err'), sizeEl = row.querySelector('.vp-size');
            if (res.ok) {
              okN++;
              saveB += Math.max(0, (res.inSize || 0) - (res.outSize || 0));
              if (sizeEl && res.inSize) {
                const pct = Math.max(0, Math.round((1 - res.outSize / res.inSize) * 100));
                sizeEl.textContent = `${fmtBytes(res.inSize)} → ${fmtBytes(res.outSize)}（-${pct}%）`;
              }
            } else {
              if (tag) { tag.textContent = '✗ 失败'; tag.className = 'tag tag-red'; }
              if (errEl) errEl.textContent = res.err;
            }
          });
          status.textContent = `完成：成功 ${okN} / ${r.results.length}${r.canceled ? '（已取消）' : ''}，共节省 ${fmtBytes(saveB)}，输出目录 ${outDir}`;
          toast(`压制完成（${okN}/${r.results.length}）`, okN ? 'success' : 'error');
        } catch (e) {
          status.textContent = '✗ ' + e.message;
          toast(e.message, 'error');
        } finally { running = false; startBtn.disabled = false; cancelBtn.disabled = true; picker.setLocked(false); unsub(); }
      }
      page.appendChild(div('card', div('card-title', '选择视频'), picker.el));
      page.appendChild(div('card', div('card-title', '压制参数'),
        div('form-row', h('span', { class: 'form-label' }, '预设'), presetSel),
        div('form-row', h('span', { class: 'form-label' }, '编码'), codecSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '质量CRF'), crfIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '速度'), speedSel),
        div('form-row', h('span', { class: 'form-label' }, '分辨率'), scaleSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '帧率'), fpsIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '音频'), audioSel),
        div('form-row', h('label', { class: 'field-hint' }, stripChk, ' 清除元数据（减少体积）')),
        div('form-row', h('span', { class: 'form-label' }, '输出'), outDirIn, pickOutBtn),
        div('form-row', startBtn, ' ', cancelBtn, status)));
      // 测试钩子：只在开发态挂载（同上）
      if (window.api.isDev) (window.__heheTest = window.__heheTest || {}).videoPress = {
        setFiles: (arr) => { picker.clear(); picker.add(arr); },
        setOpts: (o) => {
          if (o.preset) { presetSel.value = o.preset; presetSel.dispatchEvent(new Event('change')); }
          if (o.codec) codecSel.value = o.codec;
          if (o.crf != null) crfIn.value = o.crf;
          if (o.speed) speedSel.value = o.speed;
          if (o.scale != null) scaleSel.value = o.scale;
          if (o.fps != null) fpsIn.value = o.fps;
          if (o.audio) audioSel.value = o.audio;
          if (o.outDir) outDirIn.value = o.outDir;
        },
        run: () => run()
      };
    }
  })
})();
