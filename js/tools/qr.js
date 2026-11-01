/* 模块：开发调试 —— 二维码生成与识别
 *
 * 【文案已迁到双语（任务 4 的样板之一）】
 * 所有用户可见文字都走 TT('qr', '中文原文')，英文表在 js/tools/i18n.js。
 * 取词方向是反的（以中文原文作键），理由见该文件顶部说明：
 * 中文模式直接返回字面量、不做查表，所以「中文下零行为改动」是结构上保证的。
 * 仍未迁移的工具保持纯中文，边界在设置页与 README 里写明了。
 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, filePicker } = window.ui;
  const { invoke } = window.api;
  const MOD = 'dev';
  const T = (zh, vars) => TT('qr', zh, vars);

  register({
    id: 'qr-generate', name: '二维码生成', module: MOD, icon: 'qr',
    desc: '文本/链接/名片生成二维码，支持保存 PNG',
    keywords: ['二维码', 'qr', '生成'],
    render(page) {
      const ta = h('textarea', { class: 'pane-ta', placeholder: T('输入文本、网址、WiFi 信息等…'), style: { minHeight: '100px' } });
      const sizeSel = h('select', { class: 'select input-sm' }, h('option', { value: '320' }, '320px'), h('option', { value: '640' }, T('640px（高清）')));
      const levelSel = h('select', { class: 'select input-sm' }, h('option', { value: 'L' }, T('容错 L')), h('option', { value: 'M', selected: true }, T('容错 M')), h('option', { value: 'Q' }, T('容错 Q')), h('option', { value: 'H' }, T('容错 H')));
      const imgBox = div('');
      imgBox.style.cssText = 'display:flex;justify-content:center;padding:20px;min-height:240px;align-items:center';
      let lastB64 = null, genSeq = 0;
      async function gen() {
        if (!ta.value.trim()) { imgBox.innerHTML = '<span class="field-hint">' + T('输入内容后自动生成') + '</span>'; return; }
        const t = ++genSeq;
        try {
          const r = await invoke('qr:generate', ta.value, { size: parseInt(sizeSel.value), level: levelSel.value });
          if (t !== genSeq) return; // 旧请求不覆盖新结果
          lastB64 = r.b64;
          imgBox.innerHTML = '';
          imgBox.appendChild(h('img', { src: 'data:image/png;base64,' + r.b64, style: { maxWidth: '320px', borderRadius: '8px', border: '1px solid var(--border)' } }));
        } catch (e) { if (t === genSeq) { imgBox.innerHTML = ''; imgBox.appendChild(div('field-err', '✗ ' + (e && e.message ? e.message : e))); } }
      }
      const saveBtn = btn(T('保存 PNG'), 'btn-secondary btn-sm', async () => {
        if (!lastB64) return toast(T('请先生成二维码'), 'warn');
        try {
          const p = await invoke('dialog:save', { defaultPath: 'qrcode.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
          if (!p) return;
          await invoke('fs:write-file-b64', p, lastB64);
          toast(T('已保存：{p}', { p }), 'success');
        } catch (e) { toast(e.message || String(e), 'error'); }
      });
      ta.addEventListener('input', window.ui.debounce(gen, 400));
      [sizeSel, levelSel].forEach(el => el.addEventListener('change', gen));
      page.appendChild(div('card', div('card-title', T('内容')),
        div('form-row', h('span', { class: 'form-label' }, T('尺寸')), sizeSel, h('span', { class: 'form-label', style: { minWidth: 'auto' } }, T('容错')), levelSel),
        ta, div('form-row', saveBtn)));
      page.appendChild(div('card', div('card-title', T('二维码')), imgBox));
      ta.value = 'https://hehe.toolbox';
      gen();
    }
  });

  register({
    id: 'qr-scan', name: '二维码识别', module: MOD, icon: 'qr',
    desc: '从本地图片 / 粘贴截图识别二维码内容',
    keywords: ['二维码', '识别', '解码', 'qr'],
    render(page) {
      const preview = h('div', { style: { minHeight: '120px', display: 'flex', justifyContent: 'center' } });
      const result = h('textarea', { class: 'pane-ta readonly mono', readonly: true, placeholder: T('识别结果…'), style: { minHeight: '80px' } });
      async function decodeImage(img) {
        const canvas = h('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR ? window.jsQR(data.data, canvas.width, canvas.height) : null;
        if (code && code.data) {
          result.value = code.data;
          toast(T('识别成功'), 'success');
        } else {
          result.value = '';
          toast(T('未识别到二维码，请确保图片清晰完整'), 'warn');
        }
      }
      let selfUpdating = false;
      async function handleFile(path, blob) {
        preview.innerHTML = '';
        let img;
        if (blob) {
          const url = URL.createObjectURL(blob);
          img = h('img', { src: url });
        } else {
          const r = await invoke('fs:read-file-b64', path);
          img = h('img', { src: 'data:image/png;base64,' + r.b64 });
        }
        preview.appendChild(img);
        img.addEventListener('load', () => decodeImage(img));
      }
      const picker = filePicker({
        text: T('拖入或选择二维码图片'),
        single: true,
        emptyText: T('还没有选择图片'),
        filters: [{ name: T('图片'), extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'] }],
        onBlob: (file) => handleFile(null, file),
        onChange: (items) => {
          /* selfUpdating = 「这次列表变化是我自己登记的」（剪贴板图片）。
           * 那一步已经自己设好 preview 了，若还往下走会执行 items.length 分支
           * 把刚画好的预览清空 —— 粘贴完就白屏。 */
          if (selfUpdating) return;
          if (!items.length) { preview.innerHTML = ''; return; }
          if (!items[0].virtual) handleFile(items[0].path).catch((e) => toast(e.message, 'error'));
        }
      });
      const pasteBtn = btn(T('📋 从剪贴板识别'), 'btn-secondary', async () => {
        try {
          const imgData = await invoke('clip:read-image');
          if (!imgData) return toast(T('剪贴板中没有图片'), 'warn');
          preview.innerHTML = '';
          const img = h('img', { src: imgData, style: { maxWidth: '100%' } });
          preview.appendChild(img);
          img.addEventListener('load', () => decodeImage(img));
          // 剪贴板来源也登记一行（虚拟条目：没有磁盘路径，只作展示）
          selfUpdating = true;
          try { picker.clear(); picker.list.add([{ path: T('剪贴板图片'), name: T('剪贴板图片'), virtual: true }]); }
          finally { selfUpdating = false; }
        } catch (e) { toast(e.message, 'error'); }
      });
      page.appendChild(div('card', div('card-title', T('选择图片')), pasteBtn, picker.el, preview));
      page.appendChild(div('card', div('card-title', T('识别结果')),
        result, div('form-row', btn(T('复制'), 'btn-sm btn-secondary', () => result.value && copyText(result.value)),
          btn(T('打开链接'), 'btn-sm btn-secondary', () => { if (/^https?:\/\//.test(result.value)) invoke('shell:open-url', result.value); }))));
    }
  });
})();
