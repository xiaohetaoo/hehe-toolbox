/* UI 组件与工具函数库 */
(function () {
  const { invoke, on, isDesktop } = window.api;

  /* ---------- DOM 构建 ---------- */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k in el && k !== 'type' && k !== 'value') { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
        else el.setAttribute(k, v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      if (typeof c === 'string' || typeof c === 'number') { el.appendChild(document.createTextNode(String(c))); continue; }
      if (c instanceof Node) { el.appendChild(c); continue; }
      if (typeof c === 'object' && c.style) { Object.assign(el.style, c.style); continue; } // 兼容 div(cls, {style}, text) 写法
    }
    return el;
  }
  const div = (cls, ...ch) => h('div', { class: cls }, ...ch);
  const icon = (name, cls) => { const t = h('span'); t.innerHTML = window.iconSvg(name, cls); return t.firstChild; };
  const iconLg = (name, cls) => { const t = h('span'); t.innerHTML = window.iconSvgLg(name, cls); return t.firstChild; };

  /* ---------- 格式化 ---------- */
  function fmtBytes(n, digits = 1) {
    if (n == null || isNaN(n)) return '-';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1; let v = n;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return v.toFixed(v >= 100 ? 0 : digits) + ' ' + units[i];
  }
  function fmtNum(n) { return (n || 0).toLocaleString('zh-CN'); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
    return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
  }
  function fmtDate(ts, withTime = true) {
    const d = new Date(ts);
    const base = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return withTime ? `${base} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` : base;
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- Toast ---------- */
  let toastBox = null;
  function toast(msg, type = 'info', ms = 2000) {
    if (!toastBox) { toastBox = div('toast-container'); document.body.appendChild(toastBox); }
    const iconName = type === 'success' ? 'check' : type === 'error' ? 'x' : type === 'warn' ? 'alert' : 'info';
    const t = div(`toast toast-${type}`, icon(iconName), h('span', null, msg));
    toastBox.appendChild(t);
    setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 260); }, ms);
  }

  /* ---------- 弹窗 ---------- */
  function modal({ title, body, foot, danger, width, onClose }) {
    const mask = div('modal-mask');
    const m = div('modal');
    if (width) m.style.width = typeof width === 'number' ? width + 'px' : width;
    const bodyEl = div('modal-body');
    if (typeof body === 'function') body(bodyEl, m); else if (body) bodyEl.appendChild(body);
    const head = div('modal-head', h('span', null, title), div('modal-close', icon('x')));
    const close = () => { mask.remove(); onClose && onClose(); };
    head.querySelector('.modal-close').addEventListener('click', close);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    m.appendChild(head); m.appendChild(bodyEl);
    if (foot && foot.length) {
      const f = div('modal-foot');
      for (const b of foot) f.appendChild(b);
      m.appendChild(f);
      if (danger) {
        // 主按钮标红由调用方构造
      }
    }
    m.tabIndex = -1;
    mask.appendChild(m);
    document.body.appendChild(mask);
    const firstBtn = m.querySelector('button, input, textarea');
    if (firstBtn) firstBtn.focus();
    return { close, el: m, body: bodyEl };
  }
  function confirmBox({ title = '确认操作', message, danger = false, okText = '确定', cancelText = '取消' }) {
    return new Promise((resolve) => {
      let done = false;
      const okBtn = h('button', { class: danger ? 'btn btn-danger' : 'btn btn-primary', onclick: () => { done = true; md.close(); resolve(true); } }, okText);
      const cancelBtn = h('button', { class: 'btn btn-secondary', onclick: () => { done = true; md.close(); resolve(false); } }, cancelText);
      const md = modal({
        title, onClose: () => { if (!done) resolve(false); },
        // pre-wrap：message 里的 \n 要能真正换行，否则多行提示会被压成一长段
        body: (b) => { b.appendChild(h('div', { style: { userSelect: 'text', whiteSpace: 'pre-wrap' } }, message)); },
        foot: [cancelBtn, okBtn]
      });
    });
  }
  function alertBox(message, title = '提示') {
    return modal({ title, body: (b) => b.appendChild(h('div', null, message)), foot: [h('button', { class: 'btn btn-primary', onclick: function () { this.closest('.modal-mask').remove(); } }, '知道了')] });
  }
  function promptBox({ title, label = '', value = '', placeholder = '', okText = '确定' }) {
    return new Promise((resolve) => {
      let result = null;
      const input = h('input', { class: 'input', value, placeholder, style: { width: '100%' } });
      const ok = h('button', { class: 'btn btn-primary', onclick: () => { result = input.value; md.close(); } }, okText);
      const md = modal({
        title, onClose: () => resolve(result),
        body: (b) => { if (label) b.appendChild(h('div', { style: { marginBottom: '8px' } }, label)); b.appendChild(input); },
        foot: [h('button', { class: 'btn btn-secondary', onclick: () => md.close() }, '取消'), ok]
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
    });
  }

  /* ---------- 剪贴板 ---------- */
  async function copyText(text) {
    try {
      if (isDesktop) await invoke('clip:write-text', text);
      else await navigator.clipboard.writeText(text);
      toast('已复制', 'success', 1200);
      return true;
    } catch (e) { toast('复制失败：' + e.message, 'error'); return false; }
  }

  /* ---------- 表格 ---------- */
  function renderTable({ columns, rows, rowKey, onRowClick, empty = '暂无数据' }) {
    // columns: {key, title, width?, render?(row), sortable?, sortVal?(row)}
    const wrap = div('table-scroll');
    const table = h('table', { class: 'table' });
    const thead = h('thead');
    const trh = h('tr');
    let sort = { key: null, dir: 1 };
    const tbody = h('tbody');
    function drawHead() {
      trh.innerHTML = '';
      for (const c of columns) {
        const th = h('th', { class: c.sortable ? 'sortable' : '', style: c.width ? { width: c.width } : null }, c.title);
        if (c.sortable) {
          if (sort.key === c.key) th.appendChild(h('span', { class: 'sort-arrow' }, sort.dir > 0 ? '▲' : '▼'));
          th.addEventListener('click', () => {
            if (sort.key === c.key) sort.dir *= -1; else sort = { key: c.key, dir: 1 };
            drawBody();
            drawHead();
          });
        }
        trh.appendChild(th);
      }
    }
    function drawBody() {
      tbody.innerHTML = '';
      let data = [...rows];
      if (sort.key) {
        const c = columns.find(x => x.key === sort.key);
        const val = c.sortVal || ((r) => r[c.key]);
        data.sort((a, b) => { const va = val(a), vb = val(b); return (va > vb ? 1 : va < vb ? -1 : 0) * sort.dir; });
      }
      if (!data.length) {
        tbody.appendChild(h('tr', null, h('td', { colspan: columns.length, style: { textAlign: 'center', color: 'var(--text-3)', padding: '24px' } }, empty)));
      }
      for (const r of data) {
        const tr = h('tr', { dataset: rowKey ? { key: r[rowKey] } : null });
        if (onRowClick) tr.addEventListener('click', (e) => onRowClick(r, tr, e));
        for (const c of columns) {
          const td = h('td');
          const v = c.render ? c.render(r, td) : r[c.key];
          if (v != null && !(v instanceof Node)) td.appendChild(document.createTextNode(String(v)));
          else if (v instanceof Node) td.appendChild(v);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }
    drawHead(); drawBody();
    table.appendChild(thead); table.appendChild(tbody);
    wrap.appendChild(table);
    wrap.refresh = () => { drawBody(); };
    return wrap;
  }

  /* ---------- 开关 ---------- */
  function switchEl(checked, onChange) {
    const s = div('switch' + (checked ? ' on' : ''));
    s.addEventListener('click', () => { s.classList.toggle('on'); onChange && onChange(s.classList.contains('on')); });
    s.set = (v) => s.classList.toggle('on', !!v);
    return s;
  }

  /* ---------- 拖拽区 ---------- */
  function dropzone({ text = '点击选择或拖拽文件到此处', sub = '', multiple = true, accept, onFiles, pickProps, directory = false }) {
    const dz = div('dropzone');
    dz.appendChild(div('dz-icon', iconLg('upload')));
    dz.appendChild(div('dz-main', text));
    if (sub) dz.appendChild(div('dz-sub', sub));
    const getFiles = async () => {
      try {
        const props = directory ? ['openDirectory'] : (multiple ? ['openFile', 'multiSelections'] : ['openFile']);
        const paths = await invoke('dialog:open', { properties: props });
        if (paths && paths.length) onFiles(paths);
      } catch (e) { toast(e.message, 'error'); }
    };
    dz.addEventListener('click', getFiles);
    dz.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover');
      const files = [...e.dataTransfer.files];
      if (!files.length) return;
      const paths = files.map(f => api.getPathForFile(f)).filter(Boolean);
      if (paths.length) onFiles(paths);
      else onFiles([], files);
    });
    return dz;
  }

  /* ---------- 迷你折线图 ---------- */
  function lineChart(canvas, { max = 100, fill = true, color } = {}) {
    const ctx = canvas.getContext('2d');
    function draw(data, opts = {}) {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, hh = canvas.clientHeight;
      if (!w || !hh) return;
      canvas.width = w * dpr; canvas.height = hh * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hh);
      const cs = getComputedStyle(document.documentElement);
      const c = color || cs.getPropertyValue('--primary').trim() || '#165DFF';
      const border = cs.getPropertyValue('--border').trim() || '#E5E6EB';
      const textC = cs.getPropertyValue('--text-3').trim() || '#86909C';
      // grid
      ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.font = '10px sans-serif'; ctx.fillStyle = textC;
      const yMax = opts.max != null ? opts.max : max;
      for (let i = 0; i <= 4; i++) {
        const y = (hh - 18) * (i / 4) + 2;
        ctx.beginPath(); ctx.moveTo(28, y); ctx.lineTo(w - 4, y); ctx.stroke();
        ctx.fillText(String(Math.round(yMax * (1 - i / 4))), 2, y + 3);
      }
      if (!data || data.length < 2) return;
      const step = (w - 36) / (data.length - 1);
      const py = (v) => 2 + (hh - 18) * (1 - Math.min(v, yMax) / yMax);
      ctx.beginPath();
      data.forEach((v, i) => { const x = 30 + i * step; i === 0 ? ctx.moveTo(x, py(v)) : ctx.lineTo(x, py(v)); });
      ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      if (fill) {
        ctx.lineTo(30 + (data.length - 1) * step, hh - 16); ctx.lineTo(30, hh - 16); ctx.closePath();
        ctx.fillStyle = c + '22'; ctx.fill();
      }
    }
    return { draw };
  }

  /* ---------- 通用小部件 ---------- */
  function progressEl() {
    const p = div('progress', div('progress-fill'));
    p.style.width = '160px';
    return {
      el: p,
      set(pct) { p.firstChild.style.width = Math.max(0, Math.min(100, pct)) + '%'; },
      hide() { p.style.display = 'none'; },
      show() { p.style.display = ''; }
    };
  }
  function loadingBlock(text = '加载中…') { return div('loading-block', h('span', { class: 'spinner' }), text); }
  function fieldRow(label, control, hint) {
    const row = div('form-row');
    if (label) row.appendChild(h('label', { class: 'form-label' }, label));
    row.appendChild(control);
    if (hint) row.appendChild(h('span', { class: 'field-hint' }, hint));
    return row;
  }
  function btn(text, cls, onClick, iconName) {
    const b = h('button', { class: 'btn ' + (cls || 'btn-primary'), onclick: onClick }, iconName ? icon(iconName) : null, text);
    return b;
  }
  /* 双栏转换布局 */
  function convertLayout({ inputLabel = '输入内容', outputLabel = '转换结果', btnText = '转换', btnIcon = 'arrow-right', realtime = false, onConvert, height }) {
    const root = div('');
    const leftHead = div('pane-head', h('span', null, inputLabel), h('span', { class: 'pane-count' }, ''));
    const clearBtn = h('button', { class: 'btn btn-text btn-sm', onclick: () => { ta.value = ''; update(); fire(); } }, '清空');
    leftHead.appendChild(div('pane-actions', clearBtn));
    const ta = h('textarea', { class: 'pane-ta', placeholder: '请输入内容…' });
    if (height) ta.style.minHeight = height + 'px';
    const rightHead = div('pane-head', h('span', null, outputLabel));
    const copyBtn = h('button', { class: 'btn btn-text btn-sm', onclick: () => out.value && copyText(out.value) }, '复制');
    rightHead.appendChild(div('pane-actions', copyBtn));
    const out = h('textarea', { class: 'pane-ta readonly', readonly: true, placeholder: '结果将显示在这里…' });
    if (height) out.style.minHeight = height + 'px';
    const mid = div('split-mid');
    if (!realtime) {
      mid.appendChild(btn(btnText, 'btn-primary btn-lg', () => fire(), btnIcon));
    }
    const leftWrap = div('', leftHead, ta);
    const rightWrap = div('', rightHead, out);
    const pane = realtime
      ? div('split-pane no-btn', leftWrap, rightWrap)
      : div('split-pane', leftWrap, mid, rightWrap);
    root.appendChild(pane);
    const errTip = div('field-err', '');
    errTip.style.display = 'none';
    root.appendChild(errTip);
    function update() { leftHead.querySelector('.pane-count').textContent = ta.value ? `${ta.value.length} 字符` : ''; }
    function fire() {
      errTip.style.display = 'none';
      try {
        const r = onConvert(ta.value);
        out.value = r == null ? '' : String(r);
      } catch (e) {
        out.value = '';
        errTip.textContent = '⚠ ' + e.message;
        errTip.style.display = 'block';
      }
    }
    ta.addEventListener('input', () => { update(); if (realtime) fire(); });
    update();
    return { el: root, input: ta, output: out, fire, setInput(v) { ta.value = v; update(); fire(); } };
  }
  function kvGrid(pairs) {
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '12px' } });
    for (const [k, v] of pairs) {
      const val = v == null || v === '' ? '-' : (v instanceof Node ? v : String(v));
      grid.appendChild(div('',
        h('div', { style: { fontSize: '12px', color: 'var(--text-3)' } }, k),
        h('div', { style: { fontSize: '14px', color: 'var(--text-1)', marginTop: '2px', wordBreak: 'break-all', userSelect: 'text' } }, val)));
    }
    return grid;
  }
  function placeholder(iconName, title, desc) {
    return div('placeholder-box', iconSvgBox(iconName, 44), h('h3', null, title), h('p', null, desc));
  }
  function iconSvgBox(name, size) {
    const t = h('div');
    t.innerHTML = window.iconSvg(name).replace('class="icon "', `class="icon" style="width:${size}px;height:${size}px"`);
    return t.firstChild || t;
  }

  /* 生成不重复的本地 id。
   * 【为什么不用纯 Date.now()】同一毫秒内连续添加两条会得到相同 id：
   * 快捷启动「删除」按 id 查找，撞号就会删错项；命令收藏同理。
   * 时间戳 + 进程内自增序号即可彻底避免（无需引入 uuid 依赖）。 */
  let _idSeq = 0;
  function nextId(prefix) {
    return String(prefix || '') + Date.now() + '-' + (++_idSeq);
  }

  window.h = h; // 全局 DOM 构建函数，供所有工具直接使用
  // 全局兜底：工具文件即使遗漏解构也能直接使用这些助手
  Object.assign(window, { h, div, icon, iconLg, btn, toast, copyText, fmtBytes, fmtNum, fmtTime, fmtDate, pad2, debounce, escapeHtml, renderTable, switchEl, dropzone, lineChart, progressEl, loadingBlock, fieldRow, convertLayout, kvGrid, placeholder, modal, confirmBox, alertBox, promptBox, nextId });
  window.ui = { h, div, icon, iconLg, fmtBytes, fmtNum, fmtTime, fmtDate, pad2, debounce, escapeHtml, toast, modal, confirmBox, alertBox, promptBox, copyText, renderTable, switchEl, dropzone, lineChart, progressEl, loadingBlock, fieldRow, btn, convertLayout, kvGrid, placeholder, nextId };
})();
