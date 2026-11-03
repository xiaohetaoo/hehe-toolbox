/* 模块：多媒体处理 —— video-frames（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, filePicker } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';

register({
    id: 'video-frames', name: '视频截帧', module: MOD, icon: 'crop',
    desc: '从视频抽取单帧图片，或按间隔批量导出帧序列（ffmpeg）',
    keywords: ['截帧', '视频', '帧', '截图', 'frames'],
    render(page) {
      let running = false; // 防重入标志：处理中禁止重复点击
      const picker = filePicker({
        text: '拖入或选择视频文件',
        single: true,
        emptyText: '还没有选择视频',
        filters: [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'ts'] }]
      });
      const modeSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'single' }, '抽单帧（指定时间点）'),
        h('option', { value: 'seq' }, '按间隔批量导出帧序列'));
      const timeIn = h('input', { class: 'input input-sm mono', placeholder: '00:01:30', style: { width: '90px' }, title: '时:分:秒 或 秒数' });
      const everyIn = h('input', { type: 'number', class: 'input input-sm', value: '1', min: '1', style: { width: '64px' }, title: '每 N 秒导出一帧' });
      const countIn = h('input', { type: 'number', class: 'input input-sm', value: '20', min: '1', max: '500', style: { width: '64px' }, title: '最多导出帧数' });
      const wIn = h('input', { type: 'number', class: 'input input-sm', placeholder: '原尺寸', style: { width: '80px' }, title: '限制宽度（px）' });
      const outLabel = h('div', { class: 'field-hint' }, '');
      const goBtn = btn('开始截帧', 'btn-primary', run, 'send');
      const refresh = () => { timeIn.disabled = modeSel.value !== 'single'; everyIn.disabled = countIn.disabled = modeSel.value !== 'seq'; };
      modeSel.addEventListener('change', refresh); refresh();
      async function run() {
        if (running) return; // 防重入：双击会起两个 ffmpeg 抢同一输出
        running = true;
        if (!picker.count) { running = false; return toast('请先选择视频', 'warn'); }
        const st = await invoke('ffmpeg:status').catch(() => ({ ffmpeg: null }));
        if (!st.ffmpeg) { running = false; toast('未安装 FFmpeg', 'warn'); window.App.openTool('ffmpeg-setup'); return; }
        const src = picker.paths[0];
        /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
        const base = src.split(/[\\/]/).pop().replace(/\.\w+$/, '');
        const outDir = src.replace(/[\\/][^\\/]+$/, '') + '/hehe-frames';
        try { await invoke('fs:mkdir', outDir); } catch (e) {}
        const r = await invoke('dialog:open', { properties: ['openDirectory'] }).catch(() => null);
        const finalDir = (r && r[0]) ? r[0] : outDir;
        goBtn.disabled = true; outLabel.textContent = '处理中…';
        try {
          /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
          const r = await invoke('ffmpeg:frames', {
            input: src, outDir: finalDir, mode: modeSel.value,
            ss: timeIn.value.trim(), every: Math.max(1, +everyIn.value || 1),
            count: Math.min(500, +countIn.value || 20), width: wIn.value || null
          });
          outLabel.textContent = modeSel.value === 'single'
            ? `✓ 已导出：${r.first}`
            : `✓ 帧序列 ${r.count} 张已导出到 ${r.outDir}` +
              /* 上次的帧被同名覆盖时必须说出来 —— 用户会以为那是「追加」，
                 实际旧的那几张已经没了。 */
              (r.overwritten ? `（另有 ${r.overwritten} 张上次导出的同名帧被覆盖）` : '');
          toast('截帧完成', 'success');
        } catch (e) { outLabel.textContent = '✗ ' + e.message; toast(e.message, 'error'); }
        finally { goBtn.disabled = false; running = false; }
      }
      page.appendChild(div('card', div('card-title', '视频'), picker.el));
      page.appendChild(div('card', div('card-title', '参数'),
        div('form-row', h('span', { class: 'form-label' }, '模式'), modeSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '时间点'), timeIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '间隔（秒）'), everyIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '最多'), countIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '宽度'), wIn),
        div('form-row', goBtn, outLabel)));
    }
  })
})();
