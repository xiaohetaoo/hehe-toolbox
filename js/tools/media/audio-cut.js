/* 模块：多媒体处理 —— audio-cut（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, filePicker, fmtBytes } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';

register({
    id: 'audio-cut', name: '音频剪辑', nameEn: 'Audio Trim', module: MOD, icon: 'scissors',
    desc: '截取音频片段、淡入淡出、音量增益（ffmpeg）', descEn: 'Cut audio segments, fade in / out, and adjust gain (ffmpeg)',
    keywords: ['音频', '剪辑', '截取', '淡入', '淡出', '音量'],
    render(page) {
      let running = false; // 防重入标志：处理中禁止重复点击
      const picker = filePicker({
        text: '拖入或选择音频文件（可多选则取第一个）',
        single: true,
        emptyText: '还没有选择音频',
        filters: [{ name: '音频', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'] }]
      });
      const ssIn = h('input', { class: 'input input-sm mono', placeholder: '00:00', style: { width: '70px' } });
      const toIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '秒数', style: { width: '70px' }, title: '从起点开始截取的时长' });
      const fadeInIn = h('input', { type: 'number', class: 'input input-sm', value: '0', min: '0', max: '30', style: { width: '56px' }, title: '淡入秒数（0=关闭）' });
      const fadeOutIn = h('input', { type: 'number', class: 'input input-sm', value: '0', min: '0', max: '30', style: { width: '56px' }, title: '淡出秒数（0=关闭）' });
      const gainIn = h('input', { type: 'number', class: 'input input-sm', value: '0', step: '0.5', style: { width: '60px' }, title: '音量增益（dB，0=不变，负值降低）' });
      const fmtSel = h('select', { class: 'select input-sm' }, h('option', { value: 'keep' }, '保持原格式'), h('option', { value: 'mp3' }, 'MP3'), h('option', { value: 'm4a' }, 'M4A'), h('option', { value: 'wav' }, 'WAV'));
      const status = h('div', { class: 'field-hint' }, '');
      const goBtn = btn('开始剪辑', 'btn-primary', run, 'scissors');
      async function run() {
        if (running) return; // 防重入
        running = true;
        if (!picker.count) { running = false; return toast('请先选择音频', 'warn'); }
        const st = await invoke(Channels.CHANNELS.FFMPEG.STATUS).catch(() => ({ ffmpeg: null }));
        if (!st.ffmpeg) { running = false; toast('未安装 FFmpeg', 'warn'); window.App.openTool('ffmpeg-setup'); return; }
        const src = picker.paths[0];
        const dur = Math.max(0, +toIn.value || 0);
        const fi = Math.max(0, +fadeInIn.value || 0), fo = Math.max(0, +fadeOutIn.value || 0), gain = +gainIn.value || 0;
        let fmt = fmtSel.value;
        if (fmt === 'keep') { const e = src.split('.').pop().toLowerCase(); fmt = ['mp3', 'm4a', 'wav', 'flac'].includes(e) ? e : 'mp3'; }
        // 固定 _cut 名会让「反复调参数试听剪辑」每次都覆盖上一次的成果
        // （ffmpeg 带 -y 直接改写）。用 fs:unique-path 生成不重名的目标。
        const out = await invoke(Channels.CHANNELS.FS.UNIQUE_PATH, src.replace(/\.\w+$/, '_cut.' + fmt));
        goBtn.disabled = true; status.textContent = '处理中…';
        try {
          const r = await invoke(Channels.CHANNELS.FFMPEG.AUDIO_CUT, {
            input: src, out, ss: ssIn.value.trim(), dur, fadeIn: fi, fadeOut: fo, gain, format: fmt
          });
          status.textContent = `✓ 已输出：${out}（${fmtBytes(r.size)}）`;
          toast('剪辑完成', 'success');
        } catch (e) { status.textContent = '✗ ' + e.message; toast(e.message, 'error'); }
        finally { goBtn.disabled = false; running = false; }
      }
      page.appendChild(div('card', div('card-title', '音频'), picker.el));
      page.appendChild(div('card', div('card-title', '剪辑参数'),
        div('form-row', h('span', { class: 'form-label' }, '起点'), ssIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '时长（秒）'), toIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '淡入'), fadeInIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '淡出'), fadeOutIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '增益dB'), gainIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '格式'), fmtSel),
        div('form-row', goBtn, status)));
    }
  })
})();
