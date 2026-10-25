/* 模块：开发调试 —— 二维码生成与识别 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, dropzone } = window.ui;
  const { invoke } = window.api;
  const MOD = 'dev';

  register({
    id: 'qr-generate', name: '二维码生成', module: MOD, icon: 'qr',
    desc: '文本/链接/名片生成二维码，支持保存 PNG',
    keywords: ['二维码', 'qr', '生成'],
    render(page) {
      const ta = h('textarea', { class: 'pane-ta', placeholder: '输入文本、网址、WiFi 信息等…', style: { minHeight: '100px' } });
      const sizeSel = h('select', { class: 'select input-sm' }, h('option', { value: '320' }, '320px'), h('option', { value: '640' }, '640px（高清）'));
      const levelSel = h('select', { class: 'select input-sm' }, h('option', { value: 'L' }, '容错 L'), h('option', { value: 'M', selected: true }, '容错 M'), h('option', { value: 'Q' }, '容错 Q'), h('option', { value: 'H' }, '容错 H'));
      const imgBox = div('');
      imgBox.style.cssText = 'display:flex;justify-content:center;padding:20px;min-height:240px;align-items:center';
      let lastB64 = null;
      async function gen() {
        if (!ta.value.trim()) { imgBox.innerHTML = '<span class="field-hint">输入内容后自动生成</span>'; return; }
        try {
          const r = await invoke('qr:generate', ta.value, { size: parseInt(sizeSel.value), level: levelSel.value });
          lastB64 = r.b64;
          imgBox.innerHTML = '';
          imgBox.appendChild(h('img', { src: 'data:image/png;base64,' + r.b64, style: { maxWidth: '320px', borderRadius: '8px', border: '1px solid var(--border)' } }));
        } catch (e) { imgBox.innerHTML = `<span class="field-err">${e.message}</span>`; }
      }
      const saveBtn = btn('保存 PNG', 'btn-secondary btn-sm', async () => {
        if (!lastB64) return toast('请先生成二维码', 'warn');
        const p = await invoke('dialog:save', { defaultPath: 'qrcode.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
        if (!p) return;
        await invoke('fs:write-file-b64', p, lastB64);
        toast('已保存：' + p, 'success');
      });
      ta.addEventListener('input', window.ui.debounce(gen, 400));
      [sizeSel, levelSel].forEach(el => el.addEventListener('change', gen));
      page.appendChild(div('card', div('card-title', '内容'),
        div('form-row', h('span', { class: 'form-label' }, '尺寸'), sizeSel, h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '容错'), levelSel),
        ta, div('form-row', saveBtn)));
      page.appendChild(div('card', div('card-title', '二维码'), imgBox));
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
      const result = h('textarea', { class: 'pane-ta readonly mono', readonly: true, placeholder: '识别结果…', style: { minHeight: '80px' } });
      async function decodeImage(img) {
        const canvas = h('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR ? window.jsQR(data.data, canvas.width, canvas.height) : null;
        if (code && code.data) {
          result.value = code.data;
          toast('识别成功', 'success');
        } else {
          result.value = '';
          toast('未识别到二维码，请确保图片清晰完整', 'warn');
        }
      }
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
      const dz = dropzone({
        text: '拖入或选择二维码图片',
        multiple: false,
        onFiles: (paths, files) => {
          if (files && files.length && !paths.length) handleFile(null, files[0]);
          else handleFile(paths[0]);
        }
      });
      const pasteBtn = btn('📋 从剪贴板识别', 'btn-secondary', async () => {
        try {
          const imgData = await invoke('clip:read-image');
          if (!imgData) return toast('剪贴板中没有图片', 'warn');
          preview.innerHTML = '';
          const img = h('img', { src: imgData, style: { maxWidth: '100%' } });
          preview.appendChild(img);
          img.addEventListener('load', () => decodeImage(img));
        } catch (e) { toast(e.message, 'error'); }
      });
      page.appendChild(div('card', div('card-title', '选择图片'), dz, pasteBtn, preview));
      page.appendChild(div('card', div('card-title', '识别结果'),
        result, div('form-row', btn('复制', 'btn-sm btn-secondary', () => result.value && copyText(result.value)),
          btn('打开链接', 'btn-sm btn-secondary', () => { if (/^https?:\/\//.test(result.value)) invoke('shell:open-url', result.value); }))));
    }
  });
})();
