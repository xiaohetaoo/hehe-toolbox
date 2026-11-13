/* 模块：多媒体处理 —— av-info（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { escapeHtml, div, btn, filePicker, fmtBytes, renderTable } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';

register({
    id: 'av-info', name: '音视频信息查看', nameEn: 'Media Info', module: MOD, icon: 'film',
    desc: '查看音视频编码、分辨率、码率、时长、声道等详细参数', descEn: 'Inspect codec, resolution, bitrate, duration and channel details of media files',
    keywords: ['音视频', '信息', 'ffprobe', '元数据'],
    render(page) {
      const result = div('');
      function evalFps(fr) { try { const [a, b] = fr.split('/').map(Number); return b ? a / b : 0; } catch (e) { return 0; } }
      async function probe(p) {
        result.innerHTML = '';
        result.appendChild(window.ui.loadingBlock('读取媒体信息…'));
        try {
          const m = await invoke(Channels.CHANNELS.FFMPEG.PROBE, p);
          result.innerHTML = '';
          const fmt = m.format || {};
          const card = div('card');
          card.style.border = '1px solid var(--border)';
          card.appendChild(div('card-title', '容器信息'));
          card.appendChild(window.ui.kvGrid([
            ['文件', (fmt.filename || '').split(/[\\/]/).pop()],
            ['大小', fmtBytes(Number(fmt.size) || 0)],
            ['时长', fmt.duration ? Number(fmt.duration).toFixed(2) + ' 秒' : '-'],
            ['总码率', fmt.bit_rate ? (Number(fmt.bit_rate) / 1000).toFixed(0) + ' kbps' : '-'],
            ['封装格式', fmt.format_long_name || '-']
          ]));
          result.appendChild(card);
          const streams = (m.streams || []).map((st, i) => ({
            i: i + 1,
            type: st.codec_type === 'video' ? '视频' : st.codec_type === 'audio' ? '音频' : st.codec_type,
            codec: (st.codec_name || '-') + (st.profile ? ' (' + st.profile + ')' : ''),
            spec: st.codec_type === 'video'
              ? (st.width && st.height ? `${st.width}×${st.height}` : '-') + (st.avg_frame_rate && st.avg_frame_rate !== '0/0' ? ' @ ' + evalFps(st.avg_frame_rate).toFixed(1) + 'fps' : '')
              : (st.sample_rate ? (st.sample_rate / 1000) + ' kHz' : '-') + (st.channels ? ' · ' + st.channels + ' 声道' : ''),
            bitrate: st.bit_rate ? (Number(st.bit_rate) / 1000).toFixed(0) + ' kbps' : '-'
          }));
          const sc = div('card');
          sc.style.border = '1px solid var(--border)';
          sc.appendChild(div('card-title', `流信息（${streams.length} 条）`));
          sc.appendChild(renderTable({
            columns: [
              { key: 'i', title: '#', width: '40px' },
              { key: 'type', title: '类型', width: '70px', render: r => h('span', { class: 'tag ' + (r.type === '视频' ? 'tag-blue' : 'tag-green') }, r.type) },
              { key: 'codec', title: '编码' },
              { key: 'spec', title: '规格' },
              { key: 'bitrate', title: '码率', width: '100px' }
            ],
            rows: streams
          }));
          result.appendChild(sc);
        } catch (e) {
          result.innerHTML = '';
          if (/ffprobe/.test(e.message)) {
            result.appendChild(window.ui.placeholder('film', '需要 FFmpeg 引擎', '音视频信息查看依赖 ffprobe。点击下方按钮前往安装（只需一次）。'));
            result.appendChild(div('form-row', btn('前往 FFmpeg 环境安装', 'btn-primary', () => window.App.openTool('ffmpeg-setup'), 'settings')));
          } else result.innerHTML = `<div class="field-err">${escapeHtml(e.message)}</div>`;
        }
      }
      const picker = filePicker({
        text: '拖入音视频文件查看信息',
        single: true,
        emptyText: '还没有选择文件',
        onChange: (items) => { if (items.length) probe(items[0].path); }
      });
      page.appendChild(div('card', picker.el, result));
      invoke(Channels.CHANNELS.FFMPEG.STATUS).then(r => { if (!r.ffmpeg) probe(''); }).catch(() => {});
    }
  })
})();
