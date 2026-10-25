/* 模块：文本与编码 —— 编解码转换系列 */
(function () {
  const { register } = window.Registry;
  const { convertLayout, copyText, toast } = window.ui;
  const MOD = 'text';

  function utf8ToBytes(str) { return new TextEncoder().encode(str); }
  function bytesToUtf8(bytes) { return new TextDecoder().decode(bytes); }

  register({
    id: 'base64', name: 'Base64 编解码', module: MOD, icon: 'box',
    desc: 'Base64 与文本实时互转，支持中文与文件安全字符集',
    keywords: ['base64', '编码', '解码', 'encode'],
    render(page) {
      const box = convertLayout({
        inputLabel: '原文', outputLabel: 'Base64', realtime: true,
        onConvert(text) {
          const bytes = utf8ToBytes(text);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return btoa(bin);
        }
      });
      let decodeMode = false;
      const swapBtn = window.ui.btn('⇄ 解码模式', 'btn-secondary btn-sm', () => {
        decodeMode = !decodeMode;
        swapBtn.textContent = decodeMode ? '⇄ 编码模式' : '⇄ 解码模式';
        box.el.querySelector('.pane-head span').textContent = decodeMode ? 'Base64' : '原文';
        box.el.querySelectorAll('.pane-head span')[1] && null;
        const heads = box.el.querySelectorAll('.pane-head');
        heads[0].firstChild.textContent = decodeMode ? 'Base64 输入' : '原文';
        heads[1].firstChild.textContent = decodeMode ? '解码结果' : 'Base64';
        run(); // 用双向转换逻辑刷新，box.fire() 只会单向编码
      });
      const origConvert = box.fire;
      const opts = div('form-row', swapBtn);
      page.appendChild(opts);
      page.appendChild(box.el);
      // 重写转换逻辑支持双向
      const ta = box.input, out = box.output;
      const run = () => {
        try {
          if (decodeMode) {
            const b64 = ta.value.trim().replace(/-/g, '+').replace(/_/g, '/');
            const bin = atob(b64);
            out.value = bytesToUtf8(Uint8Array.from(bin, c => c.charCodeAt(0)));
          } else {
            const bytes = utf8ToBytes(ta.value);
            let bin = '';
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); // 分块避免参数上限
            out.value = btoa(bin);
          }
          box.el.parentElement && null;
        } catch (e) { out.value = ''; }
      };
      ta.addEventListener('input', run);
      run();
    }
  });

  register({
    id: 'url-codec', name: 'URL 编解码', module: MOD, icon: 'link',
    desc: 'URL 百分号编码与解码，支持 encodeURIComponent / 全量编码',
    keywords: ['url', 'encode', 'decode', 'uri', '百分号'],
    render(page) {
      let full = false;
      const box = convertLayout({
        inputLabel: '原文', outputLabel: 'URL 编码', realtime: true,
        onConvert: (t) => full ? [...utf8ToBytes(t)].map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('') : encodeURIComponent(t)
      });
      const chk = h('label', { class: 'field-hint' }, h('input', { type: 'checkbox', class: 'checkbox' }), ' 全量编码（含 : / ? 等保留字符）');
      chk.querySelector('input').addEventListener('change', (e) => { full = e.target.checked; fire2(); });
      page.appendChild(div('form-row', chk));
      page.appendChild(box.el);
      const ta = box.input, out = box.output;
      function fire2() {
        try {
          if (mode()) {
            // decode: try decodeURIComponent
            out.value = decodeURIComponent(ta.value.replace(/\+/g, ' '));
          } else {
            out.value = full ? [...utf8ToBytes(ta.value)].map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('') : encodeURIComponent(ta.value);
          }
        } catch (e) { out.value = ''; }
      }
      function mode() { return swapDecode; }
      let swapDecode = false;
      const swapBtn = window.ui.btn('⇄ 解码', 'btn-secondary btn-sm', () => {
        swapDecode = !swapDecode;
        swapBtn.textContent = swapDecode ? '⇄ 编码' : '⇄ 解码';
        const heads = box.el.querySelectorAll('.pane-head');
        heads[0].firstChild.textContent = swapDecode ? 'URL 编码' : '原文';
        heads[1].firstChild.textContent = swapDecode ? '解码结果' : 'URL 编码';
        fire2();
      });
      page.querySelector('.form-row').prepend(swapBtn);
      ta.addEventListener('input', fire2);
      fire2();
    }
  });

  register({
    id: 'unicode-convert', name: 'Unicode 转换', module: MOD, icon: 'languages',
    desc: '文本与 \\uXXXX 转义序列互转，支持中文转 Unicode',
    keywords: ['unicode', 'uXXXX', '转义', 'escape'],
    render(page) {
      const box = convertLayout({
        inputLabel: '原文', outputLabel: 'Unicode 转义', realtime: true,
        onConvert: (t) => [...t].map(c => c.charCodeAt(0) > 127 || /[\u0000-\u001f]/.test(c)
          ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c).join('')
      });
      page.appendChild(box.el);
      const ta = box.input, out = box.output;
      let decode = false;
      const swapBtn = window.ui.btn('⇄ 解码', 'btn-secondary btn-sm', () => {
        decode = !decode;
        swapBtn.textContent = decode ? '⇄ 编码' : '⇄ 解码';
        const heads = box.el.querySelectorAll('.pane-head');
        heads[0].firstChild.textContent = decode ? 'Unicode 转义' : '原文';
        heads[1].firstChild.textContent = decode ? '解码结果' : 'Unicode 转义';
        fire();
      });
      page.insertBefore(div('form-row', swapBtn), box.el);
      function fire() {
        try {
          if (decode) {
            out.value = ta.value.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
          } else {
            out.value = [...ta.value].map(c => c.charCodeAt(0) > 127 ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c).join('');
          }
        } catch (e) { out.value = ''; }
      }
      ta.addEventListener('input', fire);
      fire();
    }
  });

  register({
    id: 'html-entity', name: 'HTML 实体转义', module: MOD, icon: 'code',
    desc: 'HTML 特殊字符转义与还原，防止 XSS',
    keywords: ['html', 'escape', '转义', '实体', 'xss'],
    render(page) {
      const box = convertLayout({
        inputLabel: '原文', outputLabel: 'HTML 转义', realtime: true,
        onConvert: (t) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
      });
      page.appendChild(box.el);
      const ta = box.input, out = box.output;
      let decode = false;
      const swapBtn = window.ui.btn('⇄ 还原', 'btn-secondary btn-sm', () => {
        decode = !decode;
        swapBtn.textContent = decode ? '⇄ 转义' : '⇄ 还原';
        const heads = box.el.querySelectorAll('.pane-head');
        heads[0].firstChild.textContent = decode ? 'HTML 转义' : '原文';
        heads[1].firstChild.textContent = decode ? '还原结果' : 'HTML 转义';
        fire();
      });
      page.insertBefore(div('form-row', swapBtn), box.el);
      function fire() {
        if (decode) {
          const d = h('textarea'); d.innerHTML = ta.value;
          out.value = d.value;
        } else {
          out.value = ta.value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }
      }
      ta.addEventListener('input', fire);
      fire();
    }
  });

  register({
    id: 'hex-ascii', name: 'Hex / ASCII 互转', module: MOD, icon: 'hash',
    desc: '文本与十六进制字节互转，支持自定义分隔符',
    keywords: ['hex', 'ascii', '十六进制', '字节'],
    render(page) {
      let sep = ' ';
      const box = convertLayout({
        inputLabel: '文本', outputLabel: '十六进制', realtime: true,
        onConvert: (t) => [...utf8ToBytes(t)].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(sep)
      });
      const sel = h('select', { class: 'select input-sm' },
        h('option', { value: ' ' }, '空格分隔'), h('option', { value: '' }, '无分隔'), h('option', { value: ',' }, '逗号分隔'), h('option', { value: '\\x' }, '\\x 前缀'));
      sel.addEventListener('change', () => { sep = sel.value === '\\x' ? '' : sel.value; fire2(); });
      page.appendChild(div('form-row', h('span', { class: 'form-label' }, '格式'), sel));
      page.appendChild(box.el);
      const ta = box.input, out = box.output;
      let decode = false;
      const swapBtn = window.ui.btn('⇄ 解码', 'btn-secondary btn-sm', () => {
        decode = !decode;
        swapBtn.textContent = decode ? '⇄ 编码' : '⇄ 解码';
        const heads = box.el.querySelectorAll('.pane-head');
        heads[0].firstChild.textContent = decode ? '十六进制' : '文本';
        heads[1].firstChild.textContent = decode ? '解码结果' : '十六进制';
        fire2();
      });
      page.querySelector('.form-row').appendChild(swapBtn);
      function fire2() {
        try {
          if (decode) {
            const clean = ta.value.replace(/0x/gi, '').replace(/\\x/g, '').replace(/[\s,]/g, '');
            if (!clean) { out.value = ''; return; }
            if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) throw new Error('无效的十六进制输入');
            const bytes = new Uint8Array(clean.match(/.{2}/g).map(x => parseInt(x, 16)));
            out.value = bytesToUtf8(bytes);
          } else {
            const arr = [...utf8ToBytes(ta.value)];
            out.value = sep === '' && sel.value === '\\x'
              ? arr.map(b => '\\x' + b.toString(16).padStart(2, '0')).join('')
              : arr.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(sep);
          }
        } catch (e) { out.value = '⚠ ' + e.message; }
      }
      ta.addEventListener('input', fire2);
      fire2();
    }
  });
})();
