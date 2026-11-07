/* 模块：多媒体处理 —— 视频裁剪（v0.5.0 新增）
 *
 * 【这个工具做什么，以及刻意不做什么】
 * 只做一件事：从一段视频里按时间截出一个片段，起点精确到帧。
 *
 * 不做转场、不做多段拼接、不做滤镜、不做时间线拖拽 —— 那些是剪辑软件的活。
 * 一个"什么都能做"的页面，第一次打开时用户要花几分钟找"我到底该点哪儿"；
 * 而这个工具的使用场景极其明确：录屏太长要截中间一段、视频前 30 秒是片头不要了。
 *
 * 【为什么要有预览播放器】
 * 这是本工具的核心判断：**裁剪的难点从来不是执行，而是决定切在哪**。
 * 只给两个数字输入框的话，用户得先用别的播放器看到 3:42，
 * 再回来手打 3:42 —— 而人眼估时间普遍差半秒到两秒，
 * 打错一个数字就得整段重来（重编码动辄几十秒）。
 * 有了播放器，切点可以是"拖到这儿、点一下"。
 *
 * （渲染层能不能播放 file:// 视频是实测过的：Electron 43 在本项目的
 *  CSP（media-src 'self' blob: file:）下可以加载并 seek，
 *  见 v0.5.0 的开发记录。不是假设。）
 */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, filePicker, fmtBytes, progressEl } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';

  /* 秒数 → mm:ss.mmm。播放器与输入框共用，保证两边永远同一个格式。 */
  function fmtClock(sec) {
    /* 【先取整到毫秒，再拆分「分:秒」】
     * 旧写法先按秒拆分、再对余数 toFixed(3)：
     *   fmtClock(59.9996)  → m=0, rest=59.9996 → toFixed(3)='60.000' → '00:60.000'
     *   fmtClock(119.9996) → '01:60.000'
     * 「秒 = 60」不是合法读数，用户会以为裁切点算错了。
     * toFixed 自己会四舍五入，但进位只发生在被格式化的那个片段里、
     * 没有传回分钟 —— 所以必须在拆分**之前**把总秒数归到毫秒精度。 */
    const raw = Math.max(0, Number(sec) || 0);
    const totalMs = Math.round(raw * 1000);
    const m = Math.floor(totalMs / 60000);
    const restMs = totalMs - m * 60000;
    const rest = restMs / 1000;
    const ss = rest.toFixed(3).padStart(6, '0');
    return String(m).padStart(2, '0') + ':' + ss;
  }
  /* "mm:ss.xxx" / "mm:ss" / "秒数" 三种写法都接受。
   * 【为什么要宽松】用户会在起点框里直接打 42（42 秒），
   * 也会从播放器复制 01:30.500。只认一种格式等于逼用户换算。 */
  function parseClock(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return NaN;
    if (s.indexOf(':') < 0) return Number(s);
    const parts = s.split(':');
    if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
    if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
    return NaN;
  }

  register({
    id: 'video-trim', name: '视频裁剪', nameEn: 'Video Trim', module: MOD, icon: 'scissors',
    desc: '按时间截取视频片段，带预览播放器、精确到帧（ffmpeg）',
    descEn: 'Cut a clip out of a video by time, with preview and frame-accurate start (ffmpeg)',
    keywords: ['视频', '裁剪', '截取', '剪辑', '切', 'trim', 'cut', '片段'],
    render(page) {
      let running = false;
      let runJobId = null;

      const picker = filePicker({
        text: '拖入或选择要裁剪的视频',
        single: true,
        emptyText: '还没有选择视频',
        filters: [{ name: '视频', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'm4v', 'ts'] }],
        onChange: (items) => { if (items.length) loadVideo(items[0].path); else clearVideo(); }
      });

      /* ---------- 预览区 ---------- */
      const video = h('video', {
        class: 'trim-video',
        controls: true,
        preload: 'metadata',
        style: { width: '100%', maxHeight: '340px', background: '#000', borderRadius: '6px', display: 'none' }
      });
      const videoInfo = div('field-hint', '选择视频后可以在这里预览并定位切点');
      const previewBox = div('');

      let meta = null;   // { duration, width, height, size }

      function clearVideo() {
        meta = null;
        video.removeAttribute('src');
        video.style.display = 'none';
        videoInfo.textContent = '选择视频后可以在这里预览并定位切点';
        previewBox.innerHTML = '';
        startIn.value = '00:00.000';
        durIn.value = '';
      }

      async function loadVideo(p) {
        previewBox.innerHTML = '';
        videoInfo.textContent = '正在读取视频信息…';
        meta = null;
        try {
          const m = await invoke(Channels.CHANNELS.FFMPEG.PROBE, p);
          const fmt = m.format || {};
          const vs = (m.streams || []).find((s) => s.codec_type === 'video');
          const hasAudio = (m.streams || []).some((s) => s.codec_type === 'audio');
          meta = {
            duration: Number(fmt.duration) || 0,
            size: Number(fmt.size) || 0,
            width: vs ? vs.width : 0,
            height: vs ? vs.height : 0,
            hasAudio
          };
          const bits = [
            fmtClock(meta.duration) + '（' + window.ui.fmtTime(meta.duration * 1000) + '）',
            meta.width && meta.height ? meta.width + '×' + meta.height : '分辨率未知',
            fmtBytes(meta.size),
            hasAudio ? '有音轨' : '无音轨'
          ];
          videoInfo.textContent = bits.join(' · ');
          /* 时长的默认值：整段。用户不从整段开始改，而是先看到"整段"
           * 再缩窄 —— 比空着让他自己算更符合直觉。 */
          startIn.value = '00:00.000';
          durIn.value = fmtClock(meta.duration);
          /* file:// 直接给 <video>。CSP 里 media-src 含 file:，
           * 实测 Electron 43 可以加载并 seek（见文件头说明）。 */
          video.src = 'file:///' + String(p).replace(/\\/g, '/');
          video.style.display = '';
          renderPreview();
        } catch (e) {
          videoInfo.textContent = '读取失败：' + e.message;
          video.style.display = 'none';
        }
      }

      /* ---------- 时间输入 ---------- */
      const startIn = h('input', { class: 'input input-sm mono', value: '00:00.000', placeholder: '00:00.000', style: { width: '110px' } });
      const durIn = h('input', { class: 'input input-sm mono', placeholder: 'mm:ss.mmm', style: { width: '110px' } });
      const endShow = h('span', { class: 'field-hint mono' }, '—');
      const modeSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'encode' }, '精确模式（重新编码，起点精确到帧，较慢）'),
        h('option', { value: 'copy' }, '快速模式（直接复制，几秒完成，起点可能提前）'));

      /* 把「起点 + 时长」换算成「结束时间」显示给用户。
       * 用户心里的模型通常是「从 A 到 B」，而 ffmpeg 要的是「从 A 起 N 秒」，
       * 中间这个换算是工具该做的事 —— 让人自己减一遍迟早会算错。 */
      function updateEnd() {
        const st = parseClock(startIn.value);
        const du = parseClock(durIn.value);
        if (!isFinite(st) || !isFinite(du) || st < 0 || du <= 0) { endShow.textContent = '—'; return; }
        endShow.textContent = fmtClock(st + du);
        /* 越界检查放在这里而不是点按钮时：用户改一个数字就立刻知道对不对。 */
        if (meta && meta.duration > 0) {
          if (st >= meta.duration) {
            endShow.textContent = '起点超过视频长度（' + fmtClock(meta.duration) + '）';
            endShow.style.color = 'var(--danger)';
            return;
          }
          if (st + du > meta.duration + 0.05) {
            endShow.textContent = fmtClock(st + du) + '（超出片尾，将截到视频结束）';
            endShow.style.color = 'var(--warning)';
            return;
          }
        }
        endShow.style.color = '';
      }
      startIn.addEventListener('input', updateEnd);
      durIn.addEventListener('input', updateEnd);

      /* 播放器时间 → 起点。这是这个工具最常用的一步：
       * 「拖到合适的位置，点一下『设为起点』」。 */
      const setStartBtn = btn('设为起点', 'btn-sm btn-secondary', () => {
        if (video.style.display === 'none') return toast('请先选择视频', 'warn');
        startIn.value = fmtClock(video.currentTime);
        updateEnd();
      }, 'clock');
      const setEndBtn = btn('设为终点', 'btn-sm btn-secondary', () => {
        if (video.style.display === 'none') return toast('请先选择视频', 'warn');
        const st = parseClock(startIn.value);
        if (!isFinite(st)) return toast('起点无效', 'warn');
        const end = video.currentTime;
        if (end <= st) return toast('终点必须晚于起点', 'warn');
        durIn.value = fmtClock(end - st);
        updateEnd();
      }, 'clock');
      const setFullBtn = btn('整段', 'btn-sm btn-text', () => {
        if (!meta) return toast('请先选择视频', 'warn');
        startIn.value = '00:00.000';
        durIn.value = fmtClock(meta.duration);
        updateEnd();
      });

      /* ---------- 输出预览（时长/片段大小估算） ---------- */
      function renderPreview() {
        previewBox.innerHTML = '';
        if (!meta) return;
        const st = parseClock(startIn.value);
        const du = parseClock(durIn.value);
        if (!isFinite(st) || !isFinite(du) || du <= 0) return;
        const card = div('card');
        card.style.border = '1px solid var(--border)';
        card.appendChild(div('card-title', '将要截取的片段'));
        card.appendChild(window.ui.kvGrid([
          ['起点', fmtClock(st)],
          ['终点', fmtClock(st + du)],
          ['时长', fmtClock(du)],
          /* 这里刻意不给"预计大小"：copy 模式大小与源文件成正比、可算，
           * 但 encode 模式完全取决于画面复杂度，估出来必然离谱。
           * 给一个错得离谱的数字比不给更糟 —— 用户会拿它做判断。 */
          ['原文件', fmtBytes(meta.size)]
        ]));
        previewBox.appendChild(card);
      }
      startIn.addEventListener('input', renderPreview);
      durIn.addEventListener('input', renderPreview);

      /* ---------- 执行 ---------- */
      const prog = progressEl();
      prog.hide();
      const status = div('field-hint', '');
      const goBtn = btn('开始裁剪', 'btn-primary', run, 'scissors');
      const cancelBtn = btn('取消', 'btn-danger-plain', () => {
        if (runJobId) invoke(Channels.CHANNELS.JOB.KILL, runJobId).catch(() => {});
      }, 'square');
      cancelBtn.disabled = true;

      async function run() {
        if (running) return;
        if (!picker.count) return toast('请先选择视频', 'warn');
        /* 【防重入标志必须在第一个 await 之前置位】
         * 本工具比另外两个媒体工具更危险：running=true 原来排在
         * FFMPEG.STATUS 与 FS.UNIQUE_PATH **两次** IPC 往返之后，
         * 加上参数校验，窗口期更长。连点会起两个 ffmpeg 进程写同一个输出目录，
         * 而模块级 runJobId 只留得下后一个 —— 取消只能杀掉一个，
         * 另一路继续跑完，用户看到"取消了但文件还在变大"。
         * 参数校验失败时也要复位，所以统一用 try/finally 收口。 */
        running = true; goBtn.disabled = true;
        let unsub = null;
        try {
          const st = await invoke(Channels.CHANNELS.FFMPEG.STATUS).catch(() => ({ ffmpeg: null }));
          if (!st.ffmpeg) {
          toast('未安装 FFmpeg，请先前往「FFmpeg 环境」安装', 'warn');
          window.App.openTool('ffmpeg-setup');
          return;
        }
          const src = picker.paths[0];
          const start = parseClock(startIn.value);
          const du = parseClock(durIn.value);
          if (!isFinite(start) || start < 0) return toast('起点无效，请用 mm:ss.mmm 或秒数', 'warn');
          if (!isFinite(du) || du <= 0) return toast('时长无效，请用 mm:ss.mmm 或秒数', 'warn');
          if (meta && meta.duration > 0 && start >= meta.duration) {
          return toast('起点超过了视频长度（' + fmtClock(meta.duration) + '）', 'warn');
        }

          /* 输出路径：源文件名 + _trim + 原扩展名，走 fs:unique-path 保证不覆盖。
           * 【为什么保留原扩展名】copy 模式下流复制不改容器格式，
           * 把 mkv 改成 mp4 会得到一个扩展名说谎的文件；
           * encode 模式下输出永远是 mp4 容器，所以那种情况才换扩展名。 */
          const mode = modeSel.value;
          const base = src.replace(/\.[^.\\/]+$/, '');
          const ext = mode === 'copy' ? (src.match(/\.[^.\\/]+$/) || ['.mp4'])[0] : '.mp4';
          const out = await invoke(Channels.CHANNELS.FS.UNIQUE_PATH, base + '_trim' + ext);

          cancelBtn.disabled = false;
          picker.setLocked(true); prog.show(); prog.set(0);
          status.textContent = '处理中…'; status.style.color = '';
          runJobId = null;
          unsub = window.JobPrefix.subscribe('vtr', (d) => {
          const jid = String(d.id || '');
          if (!runJobId) runJobId = jid; else if (jid !== runJobId) return;
          try {
            const j = JSON.parse(d.data);
            if (j.pct != null) prog.set(j.pct);
          } catch (e) {}
        });
          if (window.App && App.onCleanup) App.onCleanup(unsub);
        try {
          const r = await invoke(Channels.CHANNELS.FFMPEG.TRIM, {
            input: src, out, start, duration: du, mode
          });
          prog.set(100);
          /* 【必须显示"实际时长"而不是"请求时长"】
           * 快速模式会把起点吸附到关键帧，成品与实际要求可能差一两秒。
           * 实测：请求从 3.0s 切 2 秒，copy 模式下成品是 3.08 秒。
           * 界面若只回显用户填的 2.00 秒，他下次就不敢信这个工具了。 */
          const actual = r.duration ? fmtClock(r.duration) : fmtClock(du);
          const drift = r.duration ? Math.abs(r.duration - du) : 0;
          status.textContent = '完成：' + actual + '，' + fmtBytes(r.size) + ' → ' + r.out;
          if (drift > 0.15) {
            status.textContent += '（比请求的 ' + fmtClock(du) + ' 长了 ' + drift.toFixed(2) + ' 秒，' +
              '快速模式会把起点吸附到最近的关键帧）';
            status.style.color = 'var(--warning)';
          }
          toast('裁剪完成', 'success');
        } catch (e) {
          status.textContent = '失败：' + e.message;
          status.style.color = 'var(--danger)';
          toast(e.message, 'error');
        }
        } finally {
          /* 复位必须无条件执行 —— 包括"参数无效"这类早退路径，
           * 否则按钮会永久禁用、用户以为工具坏了。 */
          running = false; goBtn.disabled = false; cancelBtn.disabled = true;
          try { picker.setLocked(false); } catch (e) {}
          try { prog.hide(); } catch (e) {}
          if (unsub) { try { unsub(); } catch (e) {} }
        }
      }

      page.appendChild(div('card', div('card-title', '选择视频'), picker.el));
      page.appendChild(div('card', div('card-title', '预览与定位'),
        video, div('form-row', videoInfo), previewBox));

      const startRow = div('form-row',
        h('span', { class: 'form-label' }, '起点'), startIn, setStartBtn,
        h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '时长'), durIn, setEndBtn,
        h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '终点'), endShow,
        setFullBtn);
      page.appendChild(div('card', div('card-title', '裁剪范围'),
        startRow,
        div('form-row', h('span', { class: 'form-label' }, '模式'), modeSel),
        /* 把两种模式的代价写在界面上。用户选"快速"时应当知道自己在拿什么换速度，
         * 而不是切完之后发现画面从别处开始了才回来翻文档。 */
        div('form-row', h('span', { class: 'field-hint' },
          '精确模式会重新编码（画质有极小损失、耗时与片段长度成正比）；'
          + '快速模式不重新编码，但起点会吸附到最近的关键帧，实际可能比设定早几秒，'
          + '且不能用于需要精确起点的场合。')),
        div('form-row', goBtn, ' ', cancelBtn, status, prog.el)));

      page.appendChild(div('card', div('card-title', '说明'),
        div('field-hint', '输出为「原文件名_trim.扩展名」，保存在源文件所在目录；重复裁剪不会覆盖之前的成品。'),
        div('field-hint', '需要 FFmpeg。若提示未安装，请先到「FFmpeg 环境」页安装。')));

      /* 测试钩子（只在开发态挂载，与其它媒体工具一致）。
       * 有了它，e2e 才能在不选文件对话框的前提下跑到真实裁剪路径。 */
      if (window.api.isDev) {
        (window.__heheTest = window.__heheTest || {}).videoTrim = {
          setFile: (p) => { picker.clear(); picker.add(p); return loadVideo(p); },
          setRange: (s, d) => { startIn.value = s; durIn.value = d; updateEnd(); renderPreview(); },
          setMode: (m) => { modeSel.value = m; },
          run: () => run(),
          meta: () => meta
        };
      }
    }
  });
})();
