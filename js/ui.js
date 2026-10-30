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
  function dropzone({ text = '点击选择或拖拽文件到此处', sub = '', multiple = true, accept, onFiles, pickProps, directory = false, filters }) {
    const dz = div('dropzone');
    dz.appendChild(div('dz-icon', iconLg('upload')));
    const mainEl = div('dz-main', text);
    dz.appendChild(mainEl);
    if (sub) dz.appendChild(div('dz-sub', sub));
    // 供 picker 在「已有内容」时把提示文案换成「继续添加」
    dz.setMain = (t) => { mainEl.textContent = t; };
    const getFiles = async () => {
      try {
        const props = pickProps || (directory ? ['openDirectory'] : (multiple ? ['openFile', 'multiSelections'] : ['openFile']));
        const paths = await invoke('dialog:open', filters ? { properties: props, filters } : { properties: props });
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

  /* ---------- 待处理文件列表 ----------
   * 统一的「已加入的文件」清单：可见、可单删、可清空。
   *
   * 之前每个工具都是把文件名拼成一句 `已选 N 项：a、b、c…` 塞进一行
   * field-hint —— 超过 3 个就用省略号截断，用户既看不到到底选了哪几个，
   * 也没法把选错的那一个去掉，只能清空重选。这里把这件事抽成公共组件。
   *
   * 参数：
   *   onChange    条目变化后回调（增/删/清空都会触发）
   *   beforeRemove(item, index) 返回 false 或 Promise<false> 可拦截删除
   *               （例如任务运行中不允许改输入）
   *   rowStart    行首插槽 (item, i, row)：在「序号」之后、文件名之前插入
   *               自定义元素（缩略图这类）。默认的行内容照常渲染。
   *   rowEnd      行尾插槽 (item, i, row)：在文件名/体积之后、删除按钮之前
   *               追加自定义元素（状态标签、进度条、上下移按钮）。
   *   emptyText   空列表文案
   *   single      单文件模式：add() 用新文件替换旧的（而不是追加）
   *
   * 【为什么拆成 rowStart/rowEnd 而不是一个 rowRender】
   * 早期的 rowRender 是「整行交给你画」，结果凡是用了它的工具
   * （哈希、PDF、压缩包、音视频）都**丢掉了文件名列**，列表里只剩一个序号和 ×，
   * 用户根本看不出选的是哪些文件 —— 这正是这个组件本来要解决的问题。
   * 现在默认内容（序号 / 文件名 / 路径 / 体积 / ×）永远渲染，
   * 扩展只能往两头插，谁也不会不小心把文件名挤掉。
   */
  function fileList({ onChange, beforeRemove, rowStart, rowEnd, emptyText = '还没有添加文件', single = false } = {}) {
    const items = [];
    const el = div('file-list');
    const head = h('div', { class: 'fl-head' });
    const body = h('div', { class: 'fl-body' });
    const emptyEl = div('fl-empty', emptyText);
    let locked = false;
    el.appendChild(head); el.appendChild(emptyEl); el.appendChild(body);

    const normKey = (p) => String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
    function baseName(p) {
      const s = String(p || '').replace(/[\\/]+$/, '');
      const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
      return i >= 0 ? s.slice(i + 1) : s;
    }
    function dirName(p) {
      const s = String(p || '');
      const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
      return i > 0 ? s.slice(0, i) : '';
    }
    /* 上级目录只显示「最后两级」。完整路径在 title 里，
     * 因为 C:\Users\xxx\AppData\Local\Temp\... 这种长前缀每行都重复一遍，
     * 会把文件名挤成很小一截，同一目录下的文件还完全看不出差别。 */
    function shortDir(p) {
      const d = dirName(p);
      if (!d) return '';
      const parts = d.replace(/\\/g, '/').split('/').filter(Boolean);
      // 盘符（C:）永远算第一段
      if (parts.length <= 3) return d.replace(/\//g, '\\');
      return '…\\' + parts.slice(-2).join('\\');
    }

    function renderHead() {
      head.innerHTML = '';
      if (!items.length) return;
      let total = 0, unknown = 0;
      for (const it of items) { if (typeof it.size === 'number') total += it.size; else unknown++; }
      head.appendChild(h('span', { class: 'fl-count' },
        `共 ${items.length} 项` + (unknown ? '' : `，合计 ${fmtBytes(total)}`)));
      if (!locked) {
        head.appendChild(h('button', {
          class: 'btn btn-text btn-sm', onclick: (e) => { e.stopPropagation(); clearAll(); }
        }, '清空'));
      }
    }

    function fillSize(item, sizeEl) {
      // 虚拟条目（剪贴板图片等没有磁盘路径）：不 stat，直接显示来源
      if (item.virtual) { sizeEl.textContent = item.sizeLabel || '剪贴板'; return; }
      // 异步补体积：目录与不存在的路径都按「—」收场，绝不抛异常打断列表渲染
      invoke('fs:stat', item.path).then((st) => {
        item.size = st.size;
        item.isDir = !!st.isDir;
        if (!items.includes(item)) return; // 期间被删掉了
        sizeEl.textContent = st.isDir ? '文件夹' : fmtBytes(st.size);
        renderHead();
      }).catch(() => { sizeEl.textContent = '—'; });
    }

    function makeRow(item, i) {
      const row = h('div', { class: 'fl-row' });
      row.dataset.i = String(i);
      row.dataset.path = item.path;
      row.appendChild(h('span', { class: 'fl-idx' }, String(i + 1)));
      // 行首插槽（缩略图等）：在序号之后、文件名之前
      if (rowStart) { try { rowStart(item, i, row); } catch (e) {} }
      // 默认内容永远渲染：文件名 + 上级目录 + 体积
      const main = h('div', { class: 'fl-main' });
      main.appendChild(h('span', { class: 'fl-name', title: item.path }, item.name));
      const d = shortDir(item.path);
      if (d) main.appendChild(h('span', { class: 'fl-path', title: item.path }, d));
      row.appendChild(main);
      const sizeEl = h('span', { class: 'fl-size' }, item.virtual ? (item.sizeLabel || '剪贴板') : '…');
      row.appendChild(sizeEl);
      if (item.virtual) { /* 虚拟条目没有磁盘路径，不 stat */ }
      else fillSize(item, sizeEl);
      // 行尾插槽（状态标签、进度条、上下移按钮）
      if (rowEnd) { try { rowEnd(item, i, row); } catch (e) {} }
      const del = h('button', {
        class: 'fl-del', title: '从列表移除', 'aria-label': '移除 ' + item.name,
        onclick: (e) => { e.stopPropagation(); removeAt(i); }
      }, '×');
      del.disabled = locked;
      row.appendChild(del);
      return row;
    }

    function refresh() {
      body.innerHTML = '';
      items.forEach((it, i) => body.appendChild(makeRow(it, i)));
      emptyEl.style.display = items.length ? 'none' : '';
      el.classList.toggle('has-items', !!items.length);
      renderHead();
    }

    function notify() { refresh(); if (onChange) onChange(items.slice()); }

    async function removeAt(i) {
      const item = items[i];
      if (!item) return false;
      if (locked) { toast('任务进行中，无法修改文件列表', 'warn'); return false; }
      if (beforeRemove) {
        let ok;
        try { ok = await beforeRemove(item, i); } catch (e) { ok = true; }
        if (ok === false) return false;
      }
      items.splice(i, 1);
      notify();
      return true;
    }

    async function clearAll() {
      if (locked) { toast('任务进行中，无法修改文件列表', 'warn'); return false; }
      if (beforeRemove) {
        for (const [i, it] of items.entries()) {
          let ok;
          try { ok = await beforeRemove(it, i); } catch (e) { ok = true; }
          if (ok === false) return false;
        }
      }
      items.length = 0;
      notify();
      return true;
    }

    /* 返回 { added, dup }：dup 是被去重挡下的数量（同一路径选两次不会出现两行）
     * 接受字符串路径，也接受 { path, name?, size?, virtual? } 对象 ——
     * 剪贴板/贴图这类没有磁盘路径的输入也要能在列表里占一行。 */
    function add(paths) {
      const raw = Array.isArray(paths) ? paths : [paths];
      const list = raw.map((x) => (typeof x === 'string' ? { path: x } : x))
        .filter((x) => x && typeof x.path === 'string' && x.path);
      let added = 0, dup = 0;
      if (single && list.length) {
        items.length = 0;
        const src = list[list.length - 1];
        items.push({ path: src.path, name: src.name || baseName(src.path), size: src.size, isDir: false, virtual: !!src.virtual });
        added = 1;
        if (list.length > 1) dup = list.length - 1;
      } else {
        const seen = new Set(items.map((x) => normKey(x.path)));
        for (const src of list) {
          const k = normKey(src.path);
          if (seen.has(k)) { dup++; continue; }
          seen.add(k);
          items.push({ path: src.path, name: src.name || baseName(src.path), size: src.size, isDir: false, virtual: !!src.virtual });
          added++;
        }
      }
      if (added) notify(); else if (dup) refresh();
      return { added, dup };
    }

    function remove(path) {
      const i = items.findIndex((x) => normKey(x.path) === normKey(path));
      return i >= 0 ? removeAt(i) : Promise.resolve(false);
    }

    /* 顺序对拼接、合并、图片转 PDF 这类工具是有意义的输入，所以列表要能调序 */
    function move(i, delta) {
      const j = i + delta;
      if (i < 0 || j < 0 || i >= items.length || j >= items.length) return false;
      if (locked) return false;
      const [it] = items.splice(i, 1);
      items.splice(j, 0, it);
      notify();
      return true;
    }
    function sortBy(fn) {
      if (locked) return;
      /* 只重排、只重绘，**不触发 onChange**。
       * 顺序类工具是在 onChange 里调用 sortBy 的，
       * 若这里再调 notify() 就会 onChange → sortBy → onChange 无限递归。 */
      items.sort(fn);
      refresh();
    }

    function setLocked(v) {
      locked = !!v;
      // 运行中禁止增删：删掉正在处理的文件会让进度与结果对不上
      el.classList.toggle('locked', locked);
      /* 【不能 refresh()】refresh 会重建所有行，把各工具已经写进行里的
       * 进度、状态标签、体积对比全部清掉 —— 一锁一定就把「已完成」变回「待处理」。
       * 这里只把已有的删除按钮禁用/启用，并重画表头（表头里有「清空」按钮）。 */
      for (const btn of el.querySelectorAll('.fl-del')) btn.disabled = locked;
      renderHead();
    }

    refresh();
    const api = {
      el, add, remove, clear: clearAll, refresh, setLocked, move, sortBy, rowAt: (i) => body.children[i] || null,
      get items() { return items; },
      get count() { return items.length; },
      get locked() { return locked; }
    };
    // 挂到 DOM 上：E2E 测试要能驱动真实组件（也给调试时在 DevTools 里手动操纵留个入口）
    el.__fl = api;
    return api;
  }

  /* ---------- 拖拽区 + 待处理列表 ----------
   * 把「拖拽区」和「文件列表」打包成一个整体，所有需要用户先攒一批文件
   * 再点开始的功能都用它，避免每个工具各写一套。
   *
   * 用法：
   *   const picker = filePicker({ text: '拖入或选择图片（可多选）', filters: imgFilters });
   *   picker.add(paths); picker.paths; picker.setLocked(true); picker.el
   *
   * 参数：
   *   text / textMore   空列表 / 已有内容时的拖拽区文案
   *   filter(p)         返回 false 的路径会被挡下并累计到 rejected（如只收图片）
   *   onReject(n, list) 被挡下时的提示（不给就静默）
   *   single            true = 单文件槽位（新文件顶替旧的）
   *   其余参数透传给 fileList
   */
  function filePicker(opts = {}) {
    const {
      text = '点击选择或拖拽文件到此处', textMore, sub = '', multiple = true,
      directory = false, filters, filter, onReject, onChange, single = false,
      beforeRemove, rowStart, rowEnd, emptyText, onBlob
    } = opts;
    const fl = fileList({
      single, beforeRemove, rowStart, rowEnd, emptyText: emptyText || '还没有添加文件',
      onChange: (items) => {
        // 有内容时把拖拽区收成一条窄横条：省下的纵向空间留给列表
        dz.classList.toggle('compact', items.length > 0 && !single);
        if (dz.setMain) dz.setMain(items.length ? (textMore || '继续添加文件（可多选）') : text);
        if (onChange) onChange(items);
      }
    });
    const dz = dropzone({
      text, sub, multiple: multiple && !single, directory, filters,
      onFiles: (paths, files) => {
        const list = (paths || []).filter((p) => typeof p === 'string' && p);
        // 拖拽时拿不到真实路径（如从浏览器拖来的图片）：交给调用方走 blob 分支
        if (!list.length && files && files.length && onBlob) { onBlob(files[0]); return; }
        let ok = list, rejected = 0;
        if (filter) {
          ok = list.filter((p) => { try { return filter(p); } catch (e) { return false; } });
          rejected = list.length - ok.length;
        }
        const r = fl.add(ok);
        if (rejected && onReject) onReject(rejected, list.filter((p) => !ok.includes(p)));
        else if (rejected) toast(`已忽略 ${rejected} 个不支持的文件`, 'warn');
        // 重复项给个轻提示：用户拖了同一个文件两次，列表里却没多出来，不说明会以为是 bug
        if (r.dup) toast(`跳过 ${r.dup} 个重复项`, 'info', 1200);
        return r;
      }
    });
    const el = h('div', { class: 'picker' });
    el.appendChild(dz); el.appendChild(fl.el);
    const api = {
      el, dz, list: fl,
      get paths() { return fl.items.map((x) => x.path); },
      get count() { return fl.count; },
      add: (p) => fl.add(p),
      clear: () => fl.clear(),
      setLocked: (v) => fl.setLocked(v),
      move: (i, d) => fl.move(i, d),
      sortBy: (fn) => fl.sortBy(fn),
      setMainText: (t) => dz.setMain && dz.setMain(t)
    };
    el.__picker = api;
    return api;
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
  Object.assign(window, { h, div, icon, iconLg, btn, toast, copyText, fmtBytes, fmtNum, fmtTime, fmtDate, pad2, debounce, escapeHtml, renderTable, switchEl, dropzone, fileList, filePicker, lineChart, progressEl, loadingBlock, fieldRow, convertLayout, kvGrid, placeholder, modal, confirmBox, alertBox, promptBox, nextId });
  window.ui = { h, div, icon, iconLg, fmtBytes, fmtNum, fmtTime, fmtDate, pad2, debounce, escapeHtml, toast, modal, confirmBox, alertBox, promptBox, copyText, renderTable, switchEl, dropzone, fileList, filePicker, lineChart, progressEl, loadingBlock, fieldRow, btn, convertLayout, kvGrid, placeholder, nextId };
})();
