/* 模块：多媒体处理 —— ffmpeg-setup（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, progressEl, confirmBox } = window.ui;
  const { invoke, isDesktop } = window.api;
  const MOD = 'media';

register({
    id: 'ffmpeg-setup', name: 'FFmpeg 环境', nameEn: 'FFmpeg Setup', module: MOD, icon: 'film',
    desc: '一键下载/导入 ffmpeg 与 ffprobe，为音视频功能提供引擎', descEn: 'Download or import ffmpeg and ffprobe to power the media tools',
    keywords: ['ffmpeg', 'ffprobe', '环境', '引擎'],
    render(page) {
      /* 【切页要能收回下载订阅】
       * 下载那段的 unsub 只在 try/finally 里退订 —— 用户中途切页时
       * finally 还不会执行（await 还没回来），订阅就留在了原地，
       * 之后每个后台任务的 pct 都会去改一个已经不在页面上的进度条。
       * 这里在 render 的同步阶段登记一次清理，把句柄交给它。 */
      let dlUnsub = null;
      if (window.App && App.onCleanup) {
        App.onCleanup(() => { if (dlUnsub) { try { dlUnsub(); } catch (e) {} dlUnsub = null; } });
      }
      const statusBox = div('');
      const prog = progressEl(); prog.hide();
      const status = h('div', { class: 'field-hint' }, '');
      async function refresh() {
        statusBox.innerHTML = '';
        statusBox.appendChild(window.ui.loadingBlock('检测 FFmpeg…'));
        try {
          const r = await invoke(Channels.CHANNELS.FFMPEG.STATUS);
          statusBox.innerHTML = '';
          const card = div('card');
          card.style.border = '1px solid var(--border)';
          if (r.ffmpeg) {
            card.appendChild(window.ui.kvGrid([
              ['状态', '✓ 已就绪'], ['ffmpeg', r.ffmpeg], ['ffprobe', r.ffprobe || '未找到（转换功能需要）'], ['版本', r.version || '-']
            ]));
            card.appendChild(div('form-row', btn('移除内置 FFmpeg', 'btn-sm btn-danger-plain', async () => {
              if (!(await confirmBox({ title: '移除 FFmpeg', message: '将删除内置下载的 ffmpeg/ffprobe，确定？', danger: true, okText: '移除' }))) return;
              await invoke(Channels.CHANNELS.FFMPEG.REMOVE);
              toast('已移除', 'success');
              refresh();
            }, 'trash')));
          } else {
            card.appendChild(div('', h('p', { class: 'field-hint', style: { textAlign: 'left', lineHeight: 1.8 } },
              '尚未检测到 FFmpeg。安装后即可使用「音视频信息查看」「音视频格式转换」工具；',
              '也可以从 ffmpeg.org 下载后手动导入。')));
          }
          statusBox.appendChild(card);
        } catch (e) { statusBox.innerHTML = `<div class="field-err">${escapeHtml(e.message)}</div>`; }
      }
      const srcSel = h('select', { class: 'select input-sm', style: { flex: '1' } },
        h('option', { value: 'npmmirror' }, 'npmmirror 国内镜像（推荐，约 59MB，含 ffprobe）'),
        h('option', { value: 'gyan' }, 'gyan.dev 官方整合包（约 114MB）'),
        h('option', { value: 'btbn' }, 'BtbN GitHub 构建（约 90MB）'));
      const dlBtn = btn('一键下载安装', 'btn-primary', async () => {
        if (!isDesktop) return toast('桌面端可用', 'warn');
        dlBtn.disabled = true;
        prog.show(); status.textContent = '';
        try {
          dlUnsub = window.JobPrefix.subscribe('dl', (d) => {
          /* 【必须按 id 过滤】ffmpeg 下载任务 id 形如 dl<数字>（通用下载器现在叫 dlg）。
           * 不过滤的话，任何后台任务的 pct 都会被画进 FFmpeg 下载进度条 ——
           * 用户看着进度条走到 100% 却发现没装上。
           * 复用 JobPrefix.subscribe：'dl' 与 'dlg' 在表里是两个不同前缀，
           * belongsTo 的「前缀+纯数字」判定天然不会把 dlg123 认成 dl 的任务。 */
            try {
              const j = JSON.parse(d.data);
              if (j.stage === 'extract') { status.textContent = '下载完成，正在解压…'; return; }
              if (j.totalMB) status.textContent = `下载中 ${j.mb.toFixed(1)} / ${j.totalMB.toFixed(1)} MB（${(j.pct || 0).toFixed(0)}%）`;
              prog.set(j.pct || 0);
            } catch (e) {}
          });
          const r = await invoke(Channels.CHANNELS.FFMPEG.DOWNLOAD, srcSel.value);
          toast('FFmpeg 安装完成', 'success');
          status.textContent = '✓ 安装完成：' + (r.ffmpeg || '');
        } catch (e) { status.innerHTML = `<span class="status-err">✗ ${escapeHtml(e.message)}</span>`; toast(e.message, 'error'); }
        finally { dlBtn.disabled = false; prog.hide(); if (dlUnsub) { try { dlUnsub(); } catch (e) {} dlUnsub = null; } refresh(); }
      }, 'download');
      const pickBtn = btn('手动导入 ffmpeg.exe', 'btn-secondary', async () => {
        try {
          const r = await invoke(Channels.CHANNELS.FFMPEG.PICK);
          if (r.picked && r.picked.length) { toast('已导入：' + r.picked.join('、'), 'success'); refresh(); }
        } catch (e) { toast(e.message, 'error'); }
      }, 'folder');
      page.appendChild(div('card', div('card-title', '当前状态'), statusBox));
      page.appendChild(div('card', div('card-title', '安装 FFmpeg'),
        div('form-row', h('span', { class: 'form-label' }, '下载源'), srcSel),
        div('form-row', dlBtn, ' ', pickBtn),
        prog.el, status,
        div('field-hint', '安装位置：用户数据目录 bin 文件夹；也可手动导入。转 GIF / H.265 等完整功能由同一引擎提供。')));
      refresh();
    }
  })
})();
