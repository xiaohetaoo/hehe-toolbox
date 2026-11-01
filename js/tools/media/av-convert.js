/* 模块：多媒体处理 —— av-convert（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, filePicker } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';

register({
    id: 'av-convert', name: '音视频格式转换', module: MOD, icon: 'film',
    desc: '批量转换格式、压缩、提取音频、转 GIF，参数可调',
    keywords: ['转换', 'ffmpeg', '压缩', '音频', 'gif'],
    render(page) {
      // 文件清单/删除/进度行统一由 filePicker 负责（见下方 picker）
      const fmtSel = h('select', { class: 'select input-sm' },
        ...['mp4', 'mkv', 'webm', 'mp3', 'm4a', 'wav', 'flac', 'gif'].map(f => h('option', { value: f }, f.toUpperCase())));
      const vcodecSel = h('select', { class: 'select input-sm' },
        h('option', { value: '' }, 'H.264（兼容最好）'), h('option', { value: 'libx265' }, 'H.265（体积更小）'), h('option', { value: 'copy' }, '直接复制不重编码'));
      const crfIn = h('input', { type: 'number', class: 'input input-sm', value: '23', min: '14', max: '34', style: { width: '64px' }, title: '质量：越小越清晰、体积越大' });
      const scaleSel = h('select', { class: 'select input-sm' },
        h('option', { value: '' }, '保持原分辨率'), h('option', { value: '1920' }, '1080p'), h('option', { value: '1280' }, '720p'), h('option', { value: '854' }, '480p'));
      const fpsIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '帧率', style: { width: '64px' } });
      const muteChk = h('input', { type: 'checkbox', class: 'checkbox' });
      const ssIn = h('input', { class: 'input input-sm mono', placeholder: '00:00', style: { width: '70px' } });
      const toIn = h('input', { class: 'input input-sm mono', placeholder: '00:30', style: { width: '70px' } });
      const gifWIn = h('input', { type: 'number', class: 'input input-sm', value: '480', style: { width: '64px' } });
      const outDirIn = h('input', { class: 'input input-sm', placeholder: '输出目录（留空=源文件目录）', style: { flex: '1' } });
      const pickOutBtn = btn('选择…', 'btn-sm btn-secondary', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) outDirIn.value = d[0];
      });
      const status = h('div', { class: 'field-hint' }, '');
      let running = false;
      let runJobId = null; // 本页任务的 job id：按 id 精确取消，避免 cancel-latest 取消到别的任务
      const picker = filePicker({
        text: '拖入或选择要转换的音视频文件（可多选）',
        emptyText: '还没有添加文件（支持 mp4 / mkv / webm / mp3 / m4a / wav / flac / gif）',
        // 转换中不允许增删：删掉正在转换的文件会让进度行与结果对不上
        beforeRemove: () => {
          if (running) { toast('转换进行中，请先点「取消」再修改文件列表', 'warn'); return false; }
          return true;
        },
        rowEnd: (item, i, row) => {
          row.appendChild(h('span', { class: 'tag tag-gray av-tag', style: { width: '64px', justifyContent: 'center' } }, '等待中'));
          row.appendChild(h('span', { class: 'av-to field-hint', style: { fontSize: '11px' } }, '→ ' + fmtSel.value.toUpperCase()));
          const bar = div('progress', { style: { width: '140px' } });
          bar.appendChild(div('progress-fill'));
          row.appendChild(bar);
          row.appendChild(h('span', { class: 'field-err av-err', style: { fontSize: '11px', maxWidth: '200px' } }, ''));
        }
      });
      const startBtn = btn('🚀 开始转换', 'btn-primary', run);
      const cancelBtn = btn('■ 取消', 'btn-danger-plain', () => { if (runJobId) invoke('job:kill', runJobId).catch(() => {}); });
      cancelBtn.disabled = true;
      // 目标格式变了只刷新行上的「→ XXX」标签，不重建列表（重建会丢掉进度状态）
      fmtSel.addEventListener('change', () => picker.list.refresh());
      async function run() {
        if (!picker.count) return toast('请先选择文件', 'warn');
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
        const outDir = outDirIn.value.trim() || picker.paths[0].replace(/[\\/][^\\/]*$/, '');
        // job id 从流事件里取：invoke 要等全部转码结束才返回，那时已经来不及取消了
        // 【必须按前缀认领】原来写的是 `if (!runJobId && d.id) runJobId = d.id`，
        // 会抓任意任务的第一个 id —— 别的标签页在跑哈希/下载时，
        // 本页拿到的 runJobId 其实是人家的任务，点「取消」杀错对象。
        // 本任务 id 形如 avc<数字>，只认这个前缀；认领之后只认那一个 id。
        const unsub = window.JobPrefix.subscribe('avc', (d) => {
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
            if (j.stage === 'start') { if (tag) { tag.textContent = '转换中'; tag.className = 'tag tag-orange'; } return; }
            if (j.pct != null && bar) bar.style.width = (j.pct || 0) + '%';
            if (j.done && tag) { tag.textContent = j.ok ? '✓ 完成' : '✗ 失败'; tag.className = 'tag ' + (j.ok ? 'tag-green' : 'tag-red'); }
          } catch (e) {}
        });
        if (window.App && App.onCleanup) App.onCleanup(unsub);
        try {
          const r = await invoke('ffmpeg:convert', {
            items: picker.paths, outDir,
            opts: {
              format: fmtSel.value, vcodec: vcodecSel.value, crf: parseInt(crfIn.value) || 23,
              scale: scaleSel.value, fps: fpsIn.value ? parseInt(fpsIn.value) : null,
              mute: muteChk.checked, ss: ssIn.value.trim(), to: toIn.value.trim(),
              gifWidth: parseInt(gifWIn.value) || 480
            }
          });
          r.results.forEach((res, i) => {
            const row = picker.list.rowAt(i);
            if (row && !res.ok) {
              const tag = row.querySelector('.av-tag');
              if (tag) { tag.textContent = '✗ 失败'; tag.className = 'tag tag-red'; }
              const errEl = row.querySelector('.av-err'); if (errEl) errEl.textContent = res.err;
            }
          });
          const okN = r.results.filter(x => x.ok).length;
          status.textContent = `完成：成功 ${okN} / 失败 ${r.results.length - okN}，输出目录 ${outDir}`;
          toast(`转换完成（${okN}/${r.results.length}）`, okN ? 'success' : 'error');
        } catch (e) {
          status.innerHTML = `<span class="status-err">✗ ${escapeHtml(e.message)}</span>`;
          toast(e.message, 'error');
        } finally { running = false; startBtn.disabled = false; cancelBtn.disabled = true; picker.setLocked(false); unsub(); }
      }
      page.appendChild(div('card', div('card-title', '选择文件'), picker.el));
      page.appendChild(div('card', div('card-title', '转换参数'),
        div('form-row', h('span', { class: 'form-label' }, '目标格式'), fmtSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '视频编码'), vcodecSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '质量CRF'), crfIn),
        div('form-row', h('span', { class: 'form-label' }, '分辨率'), scaleSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '帧率'), fpsIn,
          h('label', { class: 'field-hint' }, muteChk, ' 移除音频')),
        div('form-row', h('span', { class: 'form-label' }, '剪辑'), '从', ssIn, '持续（秒）', toIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, 'GIF宽度'), gifWIn),
        div('form-row', h('span', { class: 'form-label' }, '输出'), outDirIn, pickOutBtn),
        div('form-row', startBtn, ' ', cancelBtn, status)));
    }
  })
})();
