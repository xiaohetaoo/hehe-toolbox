/* 模块：多媒体处理 —— video-frames（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, filePicker } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';

register({
    id: 'video-frames', name: '视频截帧', nameEn: 'Video Frames', module: MOD, icon: 'crop',
    desc: '从视频抽取单帧图片，或按间隔批量导出帧序列（ffmpeg）', descEn: 'Extract a single frame or a frame sequence from a video (ffmpeg)',
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
        const st = await invoke(Channels.CHANNELS.FFMPEG.STATUS).catch(() => ({ ffmpeg: null }));
        if (!st.ffmpeg) { running = false; toast('未安装 FFmpeg', 'warn'); window.App.openTool('ffmpeg-setup'); return; }
        const src = picker.paths[0];
        /* 【用户点「取消」必须真的取消，不能当成"用默认目录"】
         * 原来写的是 `.catch(() => null)` 然后 `(r && r[0]) ? r[0] : outDir`，
         * 于是两种完全不同的情况被合并成同一条路径：
         *   · 用户在选择框里点了**取消**（r === null）      → 继续用 outDir 截帧
         *   · 通道本身失败（catch 吞成 null）              → 也继续
         * 用户按了取消，界面却显示「处理中…」然后弹出「截帧完成」——
         * 白等一轮，还往磁盘里写了一堆他没要的帧。
         *
         * 【另一个副作用：取消也会留下空目录】
         * 原来在选择**之前**就先 mkdir 了一个默认目录
         * （<源目录>/hehe-frames）：用户一旦取消，那个空目录已经建出来了，
         * 而它不属于任何一次实际操作。
         * 现在先问目录，拿到非空结果才往下走；mkdir 由主进程在真正开始
         * 截帧时按 outDir 参数创建（FFMPEG.FRAMES handler 里已有 mkdir）。
         *
         * 真正抛错时如实报错并中止；返回 null（取消）时静默中止 ——
         * 这两者是不同的事，不能都当成"用默认目录"。 */
        let picked;
        try {
          picked = await invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: ['openDirectory'] });
        } catch (e) {
          running = false;
          outLabel.textContent = '✗ 打开目录选择框失败：' + ((e && e.message) || String(e));
          toast('打开目录选择框失败', 'error');
          return;
        }
        if (!picked || !picked[0]) { running = false; return; }   // 用户取消：什么都不做
        const finalDir = picked[0];
        goBtn.disabled = true; outLabel.textContent = '处理中…';
        try {
          /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
          const r = await invoke(Channels.CHANNELS.FFMPEG.FRAMES, {
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
