/* 模块：开发调试 —— 取色 / 坐标 / 随机生成 / HTTP / 本地服务器 / Markdown / 文档对比 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, fmtBytes, renderTable } = window.ui;
  const { invoke, isDesktop } = window.api;
  const MOD = 'dev';

  /* ---------- 颜色转换器 ---------- */
  register({
    id: 'color-convert', name: '颜色转换器', module: MOD, icon: 'droplet',
    desc: 'HEX / RGB / HSL / HSV 互转与预览，配套取色器使用',
    keywords: ['颜色', 'hex', 'rgb', 'hsl', 'hsv'],
    render(page) {
      const preview = h('div', { style: { width: '100%', height: '80px', borderRadius: '8px', border: '1px solid var(--border)' } });
      const inputs = {};
      const rows = {};
      let updating = false;
      function hexToRgb(hex) {
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = [...hex].map(c => c + c).join('');
        return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
      }
      function rgbToHex(r, g, b) { return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('').toUpperCase(); }
      function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s = 0; const l = (max + min) / 2;
        if (max !== min) {
          const d = max - min;
          s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
          h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
          h *= 60;
        }
        return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
      }
      function hslToRgb(h, s, l) {
        s /= 100; l /= 100;
        const k = n => (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
        return [f(0) * 255, f(8) * 255, f(4) * 255];
      }
      function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const d = max - min;
        let h = 0;
        if (d) { h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
        return [Math.round(h), Math.round(max ? d / max * 100 : 0), Math.round(max * 100)];
      }
      function hsvToRgb(h, s, v) {
        s /= 100; v /= 100;
        const k = n => (n + h / 60) % 6;
        const f = n => v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1));
        return [f(5) * 255, f(3) * 255, f(1) * 255];
      }
      function update(from, val) {
        if (updating) return;
        updating = true;
        try {
          let r, g, b;
          if (from === 'hex') { [r, g, b] = hexToRgb(val); }
          else if (from === 'rgb') { const m = val.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/); if (!m) throw 0; [r, g, b] = [+m[1], +m[2], +m[3]]; }
          else if (from === 'hsl') { const m = val.match(/(\d+)\D+(\d+)\D+(\d+)/); if (!m) throw 0; [r, g, b] = hslToRgb(+m[1], +m[2], +m[3]).map(Math.round); }
          else if (from === 'hsv') { const m = val.match(/(\d+)\D+(\d+)\D+(\d+)/); if (!m) throw 0; [r, g, b] = hsvToRgb(+m[1], +m[2], +m[3]).map(Math.round); }
          if ([r, g, b].some(x => isNaN(x) || x < 0 || x > 255)) throw 0;
          const hex = rgbToHex(r, g, b);
          preview.style.background = hex;
          const [hh, ss, ll] = rgbToHsl(r, g, b);
          const [hv, sv, vv] = rgbToHsv(r, g, b);
          if (from !== 'hex') inputs.hex.value = hex;
          if (from !== 'rgb') inputs.rgb.value = `${r}, ${g}, ${b}`;
          if (from !== 'hsl') inputs.hsl.value = `${hh}, ${ss}%, ${ll}%`;
          if (from !== 'hsv') inputs.hsv.value = `${hv}, ${sv}%, ${vv}%`;
          lumEl.textContent = `亮度参考文本 · 对比度自检`;
          lumEl.style.color = hex;
        } catch (e) { /* ignore */ }
        updating = false;
      }
      const lumEl = h('div', { style: { marginTop: '8px', fontSize: '14px', fontWeight: 500 } });
      const defs = [['hex', 'HEX', '#165DFF'], ['rgb', 'RGB', '22, 93, 255'], ['hsl', 'HSL', '217, 100%, 55%'], ['hsv', 'HSV', '218, 91%, 100%']];
      const card = div('card', div('card-title', '颜色'), preview, lumEl);
      for (const [key, label, def] of defs) {
        const inp = h('input', { class: 'input mono input-sm', value: def, style: { width: '200px' } });
        inputs[key] = inp;
        inp.addEventListener('input', () => update(key, inp.value));
        card.appendChild(div('form-row', h('span', { class: 'form-label' }, label), inp,
          btn('复制', 'btn-sm btn-text', () => copyText(inp.value))));
      }
      page.appendChild(card);
      update('hex', '#165DFF');
    }
  });

  /* ---------- 屏幕取色器 ---------- */
  register({
    id: 'color-picker', name: '屏幕取色器', module: MOD, icon: 'target',
    desc: '截取屏幕后放大取色，支持 HEX/RGB 复制',
    keywords: ['取色', '拾色', '截屏', '颜色'],
    render(page) {
      const preview = h('div', { style: { width: '120px', height: '120px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--page-bg)' } });
      const valEl = div('');
      valEl.style.marginTop = '10px';
      async function pick() {
        if (!isDesktop) return toast('桌面端可用（需要屏幕捕获）', 'warn');
        try {
          const cap = await invoke('screen:capture');
          const img = h('img', { src: cap.dataUrl, style: { position: 'fixed', left: '-9999px', top: '-9999px' } });
          document.body.appendChild(img);
          await new Promise(r => { img.onload = r; setTimeout(r, 800); });
          const canvas = h('canvas');
          canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
          canvas.getContext('2d').drawImage(img, 0, 0);
          img.remove();
          // 放大镜遮罩
          const mask = div('pick-overlay');
          const mag = h('canvas', { class: 'pick-magnifier' });
          mag.width = 160; mag.height = 160;
          const info = div('pick-info', '移动鼠标取色，点击确认，Esc 取消');
          document.body.appendChild(mask); document.body.appendChild(mag); document.body.appendChild(info);
          const ctx = mag.getContext('2d');
          const dpr = cap.display.scaleFactor;
          let cur = null;
          function onMove(e) {
            const px = Math.round((e.clientX - cap.display.bounds.x) * dpr);
            const py = Math.round((e.clientY - cap.display.bounds.y) * dpr);
            cur = { px, py, css: { x: e.clientX, y: e.clientY } };
            const size = 40, half = 20;
            ctx.imageSmoothingEnabled = false;
            ctx.clearRect(0, 0, 160, 160);
            try {
              ctx.drawImage(canvas, px - half, py - half, size, size, 0, 0, 160, 160);
              ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
              ctx.strokeRect(72, 72, 16, 16);
            } catch (err) {}
            mag.style.left = (e.clientX + 20) + 'px';
            mag.style.top = (e.clientY + 20) + 'px';
            info.style.left = (e.clientX + 20) + 'px';
            info.style.top = (e.clientY + 192) + 'px';
            try {
              const d = ctx.getImageData(80, 80, 1, 1).data;
              const hex = '#' + [d[0], d[1], d[2]].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
              info.textContent = `${hex}  rgb(${d[0]}, ${d[1]}, ${d[2]})`;
            } catch (err) {}
          }
          async function onClick() {
            if (!cur) return;
            try {
              const d = ctx.getImageData(80, 80, 1, 1).data;
              const hex = '#' + [d[0], d[1], d[2]].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
              preview.style.background = hex;
              valEl.innerHTML = `<span class="mono" style="user-select:text">${hex} · rgb(${d[0]}, ${d[1]}, ${d[2]})</span> `;
              valEl.appendChild(btn('复制 HEX', 'btn-sm btn-text', () => copyText(hex)));
            } catch (err) { toast('取色失败', 'error'); }
            cleanup();
          }
          function onKey(e) { if (e.key === 'Escape') cleanup(); }
          function cleanup() { mask.remove(); mag.remove(); info.remove(); document.removeEventListener('mousemove', onMove); document.removeEventListener('keydown', onKey); mask.removeEventListener('click', onClick); }
          if (window.App && App.onCleanup) App.onCleanup(cleanup); // 切页时清理取色覆盖层
          mask.addEventListener('mousemove', onMove);
          mask.addEventListener('click', onClick);
          document.addEventListener('keydown', onKey);
        } catch (e) { toast(e.message, 'error'); }
      }
      page.appendChild(div('card', div('card-title', '取色'),
        btn('🎨 开始取色', 'btn-primary btn-lg', pick, 'target'),
        div('form-row', preview, valEl),
        div('field-hint', '点击后截取当前屏幕，在放大镜中选取像素颜色，按 Esc 退出')));
    }
  });

  /* ---------- 屏幕坐标拾取 ---------- */
  register({
    id: 'coords-picker', name: '屏幕坐标拾取', module: MOD, icon: 'crosshair',
    desc: '实时获取鼠标屏幕坐标（DIP 与物理像素）',
    keywords: ['坐标', '鼠标', '屏幕'],
    render(page) {
      const xEl = h('div', { class: 'stat-num' }, '--');
      const yEl = h('div', { class: 'stat-num' }, '--');
      const pxEl = h('div', { class: 'stat-num' }, '--');
      const pyEl = h('div', { class: 'stat-num' }, '--');
      let timer = null;
      window.App.onCleanup(() => { if (timer) { clearInterval(timer); timer = null; } });
      const sw = window.ui.switchEl(false, (v) => {
        if (v) {
          if (!isDesktop) { sw.set(false); return toast('桌面端可用', 'warn'); }
          timer = setInterval(async () => {
            try {
              const r = await invoke('screen:cursor');
              xEl.textContent = r.x; yEl.textContent = r.y;
              pxEl.textContent = Math.round((r.x - r.display.bounds.x) * r.display.scaleFactor);
              pyEl.textContent = Math.round((r.y - r.display.bounds.y) * r.display.scaleFactor);
            } catch (e) {}
          }, 100);
        } else clearInterval(timer);
      });
      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' } });
      grid.appendChild(div('', h('div', { class: 'field-hint' }, 'X (DIP)'), xEl));
      grid.appendChild(div('', h('div', { class: 'field-hint' }, 'Y (DIP)'), yEl));
      grid.appendChild(div('', h('div', { class: 'field-hint' }, 'X (物理像素)'), pxEl));
      grid.appendChild(div('', h('div', { class: 'field-hint' }, 'Y (物理像素)'), pyEl));
      page.appendChild(div('card', div('card-title', '实时坐标'),
        div('form-row', h('span', { class: 'form-label' }, '开始'), sw, h('span', { class: 'field-hint' }, '开启后移动鼠标查看实时坐标')),
        grid));
    }
  });

  /* ---------- 随机生成器 ---------- */
  register({
    id: 'random-gen', name: '随机生成器', module: MOD, icon: 'dice',
    desc: 'UUID、随机数字、随机字符串、手机号测试数据',
    keywords: ['随机', 'uuid', '测试数据'],
    render(page) {
      const out = div('');
      function uuid() {
        if (crypto.randomUUID) return crypto.randomUUID();
        const b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
        const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      }
      const countIn = h('input', { type: 'number', class: 'input input-sm', value: '10', min: '1', max: '1000', style: { width: '80px' } });
      const rangeA = h('input', { type: 'number', class: 'input input-sm', value: '1', style: { width: '90px' } });
      const rangeB = h('input', { type: 'number', class: 'input input-sm', value: '100', style: { width: '90px' } });
      function gen(kind) {
        const n = Math.min(1000, Math.max(1, parseInt(countIn.value) || 10));
        const lines = [];
        for (let i = 0; i < n; i++) {
          if (kind === 'uuid') lines.push(uuid());
          else if (kind === 'num') {
            const a = parseInt(rangeA.value) || 0, b = parseInt(rangeB.value) || 100;
            lines.push(String(Math.floor(Math.random() * (b - a + 1)) + a));
          } else if (kind === 'str') {
            // crypto.getRandomValues 单次上限 65536 字节，超了抛 QuotaExceededError
            // （长度填 10 万会直接报错且 gen() 无 try/catch，用户看不到任何提示）。
            // 这里钳到 65536，并分块填充避免一次申请过大。
            const wantLen = parseInt(rangeA.value) || 12;
            const len = Math.max(1, Math.min(65536, wantLen));
            const cs = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            const arr = new Uint32Array(len);
            const CHUNK = 16384;
            for (let i = 0; i < len; i += CHUNK) {
              crypto.getRandomValues(arr.subarray(i, Math.min(i + CHUNK, len)));
            }
            if (wantLen > len) toast('长度上限 65536', 'warn');
            lines.push([...arr].map(x => cs[x % cs.length]).join(''));
          } else if (kind === 'phone') {
            const prefixes = ['130','131','132','133','135','136','137','138','139','150','151','152','155','157','158','159','170','176','177','178','180','181','182','185','186','187','188','189','191','198'];
            const p = prefixes[Math.floor(Math.random() * prefixes.length)];
            lines.push(p + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'));
          } else if (kind === 'name') {
            const surnames = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜';
            const given = '伟芳娜秀英敏静丽强磊军洋勇艳杰娟涛明超霞平刚桂华建文军鑫宇浩然子轩雨桐思远';
            lines.push(surnames[Math.floor(Math.random() * surnames.length)] + given[Math.floor(Math.random() * given.length)] + (Math.random() > 0.5 ? given[Math.floor(Math.random() * given.length)] : ''));
          }
        }
        out.innerHTML = '';
        const ta = h('textarea', { class: 'pane-ta readonly', readonly: true, style: { minHeight: '220px' } });
        ta.value = lines.join('\n');
        out.appendChild(div('form-row', btn('复制全部', 'btn-sm btn-secondary', () => copyText(ta.value)), h('span', { class: 'field-hint' }, `${lines.length} 条`)));
        out.appendChild(ta);
      }
      page.appendChild(div('card', div('card-title', '数量'), countIn));
      page.appendChild(div('card', div('card-title', '生成'),
        div('form-row', btn('UUID', 'btn-secondary', () => gen('uuid')),
          btn('随机数字', 'btn-secondary', () => gen('num')), rangeA, '~', rangeB),
        div('form-row', btn('随机字符串', 'btn-secondary', () => gen('str')), h('span', { class: 'field-hint' }, '长度'), rangeA),
        div('form-row', btn('随机手机号', 'btn-secondary', () => gen('phone')),
          btn('随机姓名', 'btn-secondary', () => gen('name')))));
      page.appendChild(div('card', div('card-title', '结果'), out));
      gen('uuid');
    }
  });

  /* ---------- 简易 HTTP 客户端 ---------- */
  register({
    id: 'http-client', name: 'HTTP 客户端', module: MOD, icon: 'send',
    desc: 'GET/POST/PUT/DELETE 请求，自定义 Header 与请求体',
    keywords: ['http', '请求', 'api', 'post', 'get'],
    render(page) {
      const methodSel = h('select', { class: 'select' }, ...['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'].map(m => h('option', { value: m }, m)));
      const urlIn = h('input', { class: 'input mono', placeholder: 'https://api.example.com/...', style: { flex: '1' } });
      const headersTa = h('textarea', { class: 'pane-ta', placeholder: '{"Content-Type": "application/json"}', style: { minHeight: '80px' } });
      const bodyTa = h('textarea', { class: 'pane-ta', placeholder: '请求体（JSON 或文本）…', style: { minHeight: '100px' } });
      const respStatus = h('span', { class: 'field-hint' }, '');
      const respTa = h('textarea', { class: 'pane-ta readonly mono', readonly: true, placeholder: '响应…', style: { minHeight: '260px' } });
      async function send() {
        const url = urlIn.value.trim();
        if (!url) return toast('请输入 URL', 'warn');
        respStatus.textContent = '请求中…';
        let headers = {};
        try { if (headersTa.value.trim()) headers = JSON.parse(headersTa.value); } catch (e) { return toast('Header JSON 无效', 'error'); }
        const method = methodSel.value;
        try {
          const r = await invoke('net:http', { method, url, headers, body: bodyTa.value, timeoutMs: 30000 });
          respStatus.innerHTML = `<span class="${r.status < 400 ? 'status-ok' : 'status-err'}">${r.status} ${escapeHtml(r.statusText)}</span> · ${r.ms}ms · ${fmtBytes(r.bytes)}`;
          let text = r.body;
          try { text = JSON.stringify(JSON.parse(r.body), null, 2); } catch (e) {}
          respTa.value = text;
        } catch (e) {
          respStatus.innerHTML = `<span class="status-err">✗ ${escapeHtml(e.message)}</span>`;
          respTa.value = '';
        }
      }
      page.appendChild(div('card', div('card-title', '请求'),
        div('form-row', methodSel, urlIn, btn('发送', 'btn-primary', send, 'send')),
        div('form-row', h('span', { class: 'form-label' }, 'Headers'), headersTa),
        div('form-row', h('span', { class: 'form-label' }, 'Body'), bodyTa)));
      page.appendChild(div('card', div('card-title', '响应', respStatus), respTa, div('form-row', btn('复制响应', 'btn-sm btn-secondary', () => copyText(respTa.value)))));
    }
  });

  /* ---------- 本地静态服务器 ---------- */
  register({
    id: 'static-server', name: '本地静态服务器', module: MOD, icon: 'server',
    desc: '一键将目录变为 HTTP 服务，用于前端页面预览',
    keywords: ['服务器', '静态', 'http', 'localhost'],
    render(page) {
      const dirIn = h('input', { class: 'input', placeholder: '要服务的目录', style: { flex: '1' } });
      const pickBtn = btn('选择目录', 'btn-secondary btn-sm', async () => {
        const d = await invoke('dialog:open', { properties: ['openDirectory'] });
        if (d && d[0]) dirIn.value = d[0];
      });
      const portIn = h('input', { class: 'input input-sm', type: 'number', value: '8128', style: { width: '100px' } });
      const statusEl = h('span', { class: 'field-hint' }, '未启动');
      const logEl = div('term', '');
      let running = false;
      const startBtn = btn('▶ 启动服务', 'btn-primary', start);
      const stopBtn = btn('■ 停止服务', 'btn-danger-plain', stop);
      stopBtn.disabled = true;
      async function start() {
        if (!dirIn.value.trim()) return toast('请选择目录', 'warn');
        try {
          const r = await invoke('server:start', dirIn.value.trim(), parseInt(portIn.value) || 8128);
          running = true;
          statusEl.innerHTML = `<span class="status-ok">● 运行中</span> <a href="#" id="srv-link" style="color:var(--primary)">${escapeHtml(r.url)}</a>`;
          statusEl.querySelector('#srv-link').addEventListener('click', (e) => { e.preventDefault(); invoke('shell:open-url', r.url); });
          startBtn.disabled = true; stopBtn.disabled = false;
        } catch (e) { toast(e.message, 'error'); }
      }
      async function stop() {
        try { await invoke('server:stop'); } catch (e) {}
        running = false;
        statusEl.textContent = '已停止';
        startBtn.disabled = false; stopBtn.disabled = true;
      }
      const logUnsub = window.api.on('server:log', (d) => {
        logEl.appendChild(h('div', null, `[${new Date(d.time).toLocaleTimeString('zh-CN', { hour12: false })}] ${d.text}`));
        logEl.scrollTop = logEl.scrollHeight;
        while (logEl.children.length > 200) logEl.firstChild.remove();
      });
      window.App.onCleanup(() => { try { logUnsub(); } catch (e) {} });
      page.appendChild(div('card', div('card-title', '服务配置'),
        div('form-row', dirIn, pickBtn),
        div('form-row', h('span', { class: 'form-label' }, '端口'), portIn, startBtn, ' ', stopBtn, statusEl)));
      page.appendChild(div('card', div('card-title', '访问日志'), logEl));
    }
  });

  /* ---------- Markdown 预览 ---------- */
  register({
    id: 'markdown-preview', name: 'Markdown 预览', module: 'office', icon: 'book',
    desc: 'Markdown 实时渲染预览，支持导出 HTML',
    keywords: ['markdown', 'md', '预览'],
    render(page) {
      const ta = h('textarea', { class: 'pane-ta', placeholder: '在这里输入 Markdown，右侧实时预览…', style: { minHeight: '380px' } });
      const view = h('div', {
        class: 'md-view', style: {
          minHeight: '380px', padding: '18px', border: '1px solid var(--border)', borderRadius: '6px',
          background: 'var(--input-bg)', userSelect: 'text', lineHeight: '1.7', overflow: 'auto', maxHeight: '70vh'
        }
      });
      const styleEl = h('style', null, `
        .md-view h1,.md-view h2,.md-view h3{border-bottom:1px solid var(--border);padding-bottom:6px;margin:16px 0 10px}
        .md-view code{background:var(--primary-light);color:var(--primary);padding:1px 5px;border-radius:3px;font-size:13px}
        .md-view pre{background:var(--code-bg);color:#7EE787;padding:12px;border-radius:6px;overflow:auto}
        .md-view pre code{background:none;color:inherit}
        .md-view blockquote{border-left:3px solid var(--primary);padding-left:12px;color:var(--text-2);margin:8px 0}
        .md-view table{border-collapse:collapse} .md-view th,.md-view td{border:1px solid var(--border);padding:6px 10px}
        .md-view th{background:var(--table-head)} .md-view img{max-width:100%}
        .md-view a{color:var(--primary)} .md-view hr{border:none;border-top:1px solid var(--border)}
      `);
      function renderMd() {
        if (!window.marked) { view.innerHTML = '<span class="field-err">marked 库未加载</span>'; return; }
        try { view.innerHTML = window.DOMPurify ? DOMPurify.sanitize(window.marked.parse(ta.value || '')) : window.marked.parse(ta.value || ''); }
        catch (e) { view.innerHTML = '<span class="field-err">' + escapeHtml(e.message) + '</span>'; }
      }
      async function exportHtml() {
        // 导出的 HTML 无 CSP 保护，必须净化防止存储型 XSS
        const safe = window.DOMPurify ? DOMPurify.sanitize(view.innerHTML) : view.innerHTML;
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Markdown</title></head><body style="max-width:800px;margin:40px auto;font-family:'Microsoft YaHei',sans-serif;line-height:1.7">${safe}</body></html>`;
        const p = await invoke('dialog:save', { defaultPath: 'document.html' });
        if (!p) return;
        await invoke('fs:write-text', p, html);
        toast('已导出：' + p, 'success');
      }
      async function openFile() {
        const p = await invoke('dialog:open', { properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }] });
        if (!p || !p[0]) return;
        const r = await invoke('fs:read-text', p[0]);
        ta.value = r.content;
        renderMd();
      }
      ta.addEventListener('input', window.ui.debounce(renderMd, 200));
      page.appendChild(div('card', div('card-title', 'Markdown 源文本',
        btn('打开文件', 'btn-sm btn-secondary', openFile), ' ',
        btn('导出 HTML', 'btn-sm btn-secondary', exportHtml)),
        ta));
      page.appendChild(div('card', div('card-title', '预览'), styleEl, view));
      ta.value = '# 核核工具箱\n\n**Markdown 实时预览**\n\n- 支持 `代码`\n- 支持表格\n\n| 工具 | 状态 |\n|---|---|\n| 预览 | ✅ |\n\n> 即开即用，无广告\n';
      renderMd();
    }
  });

  /* ---------- 文档对比 ---------- */
  register({
    id: 'diff-tool', name: '文档对比', module: 'office', icon: 'git-compare',
    desc: '两个文本/代码文件逐行差异对比，高亮增删',
    keywords: ['对比', 'diff', '差异'],
    render(page) {
      const ta1 = h('textarea', { class: 'pane-ta mono', placeholder: '原始文本（或打开文件）…', style: { minHeight: '140px' } });
      const ta2 = h('textarea', { class: 'pane-ta mono', placeholder: '修改后文本…', style: { minHeight: '140px' } });
      const result = div('');
      function openTo(ta) {
        return async () => {
          const p = await invoke('dialog:open', { properties: ['openFile'] });
          if (!p || !p[0]) return;
          const r = await invoke('fs:read-text', p[0]);
          ta.value = r.content;
        };
      }
      function diff(aLines, bLines) {
        // LCS diff（超过 4000x4000 时截断，避免 O(n*m) 内存爆炸）
        const CAP = 4000;
        if (aLines.length > CAP || bLines.length > CAP) {
          window.ui.toast('文件较大，仅对比前 ' + CAP + ' 行', 'warn');
          aLines = aLines.slice(0, CAP);
          bLines = bLines.slice(0, CAP);
        }
        const n = aLines.length, m = bLines.length;
        const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
        for (let i = n - 1; i >= 0; i--)
          for (let j = m - 1; j >= 0; j--)
            dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        const ops = [];
        let i = 0, j = 0;
        while (i < n && j < m) {
          if (aLines[i] === bLines[j]) { ops.push(['=', aLines[i]]); i++; j++; }
          else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', aLines[i]]); i++; }
          else { ops.push(['+', bLines[j]]); j++; }
        }
        while (i < n) ops.push(['-', aLines[i++]]);
        while (j < m) ops.push(['+', bLines[j++]]);
        return ops;
      }
      function run() {
        result.innerHTML = '';
        const ops = diff(ta1.value.split(/\r?\n/), ta2.value.split(/\r?\n/));
        const adds = ops.filter(o => o[0] === '+').length, dels = ops.filter(o => o[0] === '-').length;
        result.appendChild(div('form-row',
          h('span', { class: 'tag tag-green' }, `+ ${adds} 行新增`),
          h('span', { class: 'tag tag-red' }, `- ${dels} 行删除`),
          btn('复制结果', 'btn-sm btn-secondary', () => copyText(ops.map(([t, l]) => (t === '+' ? '+ ' : t === '-' ? '- ' : '  ') + l).join('\n')))));
        const box = div('term');
        box.style.maxHeight = '460px';
        for (const [type, line] of ops) {
          const lineEl = h('div');
          if (type === '+') { lineEl.style.background = 'rgba(0,180,42,0.15)'; lineEl.textContent = '+ ' + line; }
          else if (type === '-') { lineEl.style.background = 'rgba(245,63,63,0.15)'; lineEl.textContent = '- ' + line; }
          else { lineEl.style.color = '#8B949E'; lineEl.textContent = '  ' + line; }
          box.appendChild(lineEl);
        }
        result.appendChild(box);
      }
      page.appendChild(div('card', div('card-title', '文本 A', btn('打开文件', 'btn-sm btn-secondary', openTo(ta1))), ta1));
      page.appendChild(div('card', div('card-title', '文本 B', btn('打开文件', 'btn-sm btn-secondary', openTo(ta2))), ta2));
      page.appendChild(div('card', div('card-title', '差异对比'), div('form-row', btn('开始对比', 'btn-primary', run)), result));
    }
  });
})();
