/* 模块：多媒体处理 —— snip-tool（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';
  /* 文案取词（与 qr / hash / exif-view 同一套约定）：以中文原文作键，
   * 中文模式下 TT 直接返回调用点字面量、不查表，所以中文界面零行为改动。
   * 英文表在 js/tools/i18n.js 的 snip 域。 */
  const T = (zh, vars) => TT('snip', zh, vars);

register({
    id: 'snip-tool', name: '截图标注', nameEn: 'Snip & Annotate', module: MOD, icon: 'crop', i18n: true,
    desc: '框选区域截图，箭头/矩形/文字/马赛克标注，一键复制/保存/贴图/OCR', descEn: 'Select a region, annotate with arrows, boxes, text and blur, then copy, save or pin',
    keywords: ['截图', '标注', 'screenshot', 'snip', '截屏', '马赛克'],
    render(page) {
      const status = h('div', { class: 'field-hint' }, '');
      async function start() {
        try {
          status.textContent = T('请在屏幕上拖动框选区域…（Esc 取消）');
          const r = await invoke(Channels.CHANNELS.SNIP.START, 'annotate');
          if (r && r.ok) status.textContent = T('截图窗口已打开');
        } catch (e) { status.textContent = '✗ ' + e.message; toast(e.message, 'error'); }
      }
      page.appendChild(div('card', div('card-title', T('截图标注')),
        btn(T('开始截图'), 'btn-primary btn-lg', start, 'scissors'),
        div('field-hint', T('拖动框选 → 工具条标注（矩形/箭头/画笔/文字/马赛克，可撤销）→ 复制 / 保存 / 贴图 / OCR')),
        status,
        div('field-hint', T('完整链路：截图 → 标注 → 贴图置顶（悬浮参考）→ OCR 识别文字；托盘右键也可直接截图'))));
      page.appendChild(div('card', div('card-title', T('快捷贴图')),
        div('form-row', btn(T('贴剪贴板图片'), 'btn-secondary', async () => {
          try { await invoke(Channels.CHANNELS.SNIP.PIN_CLIPBOARD); toast(T('已贴图'), 'success'); }
          catch (e) { toast(e.message, 'error'); }
        }, 'pin'), h('span', { class: 'field-hint' }, T('把剪贴板里的图片变成置顶小窗（Snipaste 式）')))));
    }
  })
})();
