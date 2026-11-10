/* UI 组件与工具函数库 */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
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
  /* 【把「长得像按钮的 div」变成真的可用键盘操作】
   *
   * 界面里大量可点击元素是 div（导航项、工具卡、首页分类、最近使用胶囊），
   * 它们只挂了 addEventListener('click')。后果很具体：
   *   · Tab 键走不到它们（div 默认不进 tab 序列）
   *   · 聚焦不到 → 回车/空格也不会有反应
   *   · 读屏软件读不出「这是个按钮」
   * 也就是说，100 个工具页对纯键盘用户是完全不可达的。
   *
   * 为什么不用 <button> 重新渲染：这些元素的内部结构（图标 + 多行文字 +
   * 右上角星标 + 绝对定位的角标）依赖当前 div 的 flex/绝对定位关系，
   * 换成 button 会继承浏览器默认的 button 样式与基线，需要重写一批 CSS，
   * 且极易碰坏现有排版。加 role + tabindex 是等效且风险低的做法。
   *
   * 【为什么不自己监听 keydown】
   * 原生 button 对 Enter / Space 的行为差异很细（Space 在 keyup 触发，
   * 且要防止页面滚动）。与其自己实现两份，不如把事件转成 click 交给
   * 已有的 handler —— 这样点击与键盘走的是**同一条代码路径**，
   * 不会出现「鼠标能用、键盘走另一条分支」的分叉。
   *
   * @param {HTMLElement} el    目标元素
   * @param {string} [label]    无障碍名称（读屏读的那句话）；缺省用元素的 title
   */
  function makeButtonLike(el, label) {
    if (!el || el.nodeType !== 1) return el;
    el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    const name = label || el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim();
    if (name) el.setAttribute('aria-label', name);
    el.addEventListener('keydown', (e) => {
      // 只处理从自身发出的按键；子元素里的输入框不该被这里拦
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        // 阻止 Space 的默认翻页行为，否则按下空格页面会跳一下
        e.preventDefault();
        el.click();
      }
    });
    return el;
  }
  /* 给一组元素补上可见的焦点环类名（具体样式在 app.css）。
   * 单独一个函数是为了让「哪些元素支持键盘」这件事在一处可查。 */
  function focusable(el) {
    if (el && el.nodeType === 1) el.classList.add('kb-focusable');
    return el;
  }
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
  /* ui.js 是最底层的组件库，加载早于 app.js，拿不到那边的 T()。
   * 这里自己包一层：i18n 还没加载时回退到传入的中文默认值，
   * 保证组件库单独被引用（或加载顺序异常）时也不会抛错、不显示空白。 */
  const TT = (key, fallback) => {
    try {
      if (window.i18n && window.i18n.t) {
        const v = window.i18n.t(key);
        // t() 找不到键时会原样返回键名，这时用 fallback 更可读
        return (v && v !== key) ? v : fallback;
      }
    } catch (e) {}
    return fallback;
  };

  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const U_SEC = TT('unit.sec', '秒');
    const U_MIN = TT('unit.min', '分');
    const U_HOUR = TT('unit.hour', '时');
    if (s < 60) return s + ' ' + U_SEC;
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' ' + U_MIN + ' ' + (s % 60) + ' ' + U_SEC;
    return Math.floor(m / 60) + ' ' + U_HOUR + ' ' + (m % 60) + ' ' + U_MIN;
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
    /* 容器可能已经不在文档里：切换界面语言时 applyLangLabels() 会
     * `document.body.innerHTML = ''` 整壳重建，而 toastBox 缓存在这里。
     * 重建后旧容器成了游离节点，之后 appendChild 进去界面上什么都看不到，
     * 控制台也不报错 —— 这正是「切语言后所有提示消失」的原因。
     * 所以每次用之前都要确认它仍然挂在文档上，不在就重挂一份。 */
    if (!toastBox || !toastBox.isConnected) {
      toastBox = div('toast-container');
      document.body.appendChild(toastBox);
    }
    const iconName = type === 'success' ? 'check' : type === 'error' ? 'x' : type === 'warn' ? 'alert' : 'info';
    const t = div(`toast toast-${type}`, icon(iconName), h('span', null, msg));
    toastBox.appendChild(t);
    setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 260); }, ms);
  }

  /* ---------- 弹窗 ---------- */
  /* 记录当前打开的遮罩层。
   * 切换界面语言会整壳重建（document.body.innerHTML = ''），
   * 那时如果正有确认弹窗开着，它的 promise 会永远悬着——
   * 调用方的 await 卡死，后续代码一行都不执行，且没有任何报错。
   * 所以重建前要主动把它们按「取消」收场。 */
  let openOverlays = new Set();

  /* 【堆叠顺序：openOverlays 是插入有序的 Set，最后进来的就是最上层】
   * Escape 只允许关掉最上面那一层。若所有层同时响应，用户按一次 Esc
   * 会把底下的弹窗一起关掉 —— 那些弹窗背后的操作可能还没完成。 */
  function topOverlay() {
    let last = null;
    for (const e of openOverlays) last = e;
    return last;
  }
  /* 【Escape 必须能关弹窗】
   * 原来 modal() 只注册了「点 ×」和「点遮罩」两种关闭方式。而项目里
   * 每个辅助窗口（pin / ruler / snip）和主搜索框都处理了 Escape，
   * 唯独弹窗没有 —— 破坏性操作的二次确认（删除文件、关机、目录搬家）
   * 只能靠鼠标取消，键盘用户按下 Esc 毫无反应。
   * 监听挂在 document 上：焦点可能在遮罩外的任意控件上。 */
  function onModalKeydown(e) {
    if (e.key !== 'Escape') return;
    const top = topOverlay();
    if (!top) return;
    e.preventDefault();
    e.stopPropagation();
    top.close();
  }
  let modalKeyBound = false;
  function bindModalKeys() {
    if (modalKeyBound) return;
    modalKeyBound = true;
    document.addEventListener('keydown', onModalKeydown, true);
  }

  /* 【danger 参数已移除】
   * 它曾经是个空分支（`if (danger) { // 主按钮标红由调用方构造 }`），
   * 什么都不做却让读者以为漏了实现。真正决定按钮样式的是 confirmBox
   * 自己（它给 ok 按钮加 btn-danger），modal 不需要知道危险与否。 */
  function modal({ title, body, foot, width, onClose }) {
    const mask = div('modal-mask');
    const m = div('modal');
    if (width) m.style.width = typeof width === 'number' ? width + 'px' : width;
    const bodyEl = div('modal-body');
    if (typeof body === 'function') body(bodyEl, m); else if (body) bodyEl.appendChild(body);
    const head = div('modal-head', h('span', null, title), div('modal-close', icon('x')));
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      openOverlays.delete(entry);
      mask.remove();
      onClose && onClose();
    };
    const entry = { close };
    openOverlays.add(entry);
    head.querySelector('.modal-close').addEventListener('click', close);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    m.appendChild(head); m.appendChild(bodyEl);
    if (foot && foot.length) {
      const f = div('modal-foot');
      for (const b of foot) f.appendChild(b);
      m.appendChild(f);
    }
    m.tabIndex = -1;
    mask.appendChild(m);
    document.body.appendChild(mask);
    bindModalKeys();
    const firstBtn = m.querySelector('button, input, textarea');
    if (firstBtn) firstBtn.focus();
    return { close, el: m, body: bodyEl };
  }
  function confirmBox({ title, message, danger = false, okText, cancelText }) {
    /* 默认文案必须在此处求值（不能写在参数默认值里）：参数默认值在**定义**
     * 时就绑定了，切语言后不会跟着变。 */
    const ttl = title != null ? title : TT('dialog.confirmTitle', '确认操作');
    const okT = okText != null ? okText : TT('dialog.ok', '确定');
    const cancelT = cancelText != null ? cancelText : TT('dialog.cancel', '取消');
    return new Promise((resolve) => {
      let done = false;
      const okBtn = h('button', { class: danger ? 'btn btn-danger' : 'btn btn-primary', onclick: () => { done = true; md.close(); resolve(true); } }, okT);
      const cancelBtn = h('button', { class: 'btn btn-secondary', onclick: () => { done = true; md.close(); resolve(false); } }, cancelT);
      const md = modal({
        title: ttl, onClose: () => { if (!done) resolve(false); },
        // pre-wrap：message 里的 \n 要能真正换行，否则多行提示会被压成一长段
        body: (b) => { b.appendChild(h('div', { style: { userSelect: 'text', whiteSpace: 'pre-wrap' } }, message)); },
        foot: [cancelBtn, okBtn]
      });
    });
  }
  function alertBox(message, title = '提示') {
    /* 【兼容误传对象，并且必须吵一声】
     * 真实缺陷：js/tools/file-tools.js 里曾两处把配置对象当第一个实参传进来
     * （形如 alertBox 后面跟一个左花括号，里面是 title 与 message 两个字段）。
     * 对象被当作 message 交给 h('div', null, message)，而 h 的子节点只认
     * 字符串/数字/Node/带 style 的对象，普通对象直接丢弃 —— 弹出来是
     * 标题「提示」+ 正文空白。讽刺的是那两处的注释正写着「失败原因必须可见」。
     *
     * 调用点已改对，但这里再挡一层：别人（或未来的我）按配置对象写也不会
     * 得到一个空白框，而且 console.warn 会把调用方点名出来 —— 空白框本身
     * 是无声的，没有任何线索能指回是哪次调用。
     * 注意：只认带 message 字段的对象，避免把真的想显示对象字面量的调用误改。 */
    if (message && typeof message === 'object' && !Array.isArray(message)
        && typeof message.message === 'string') {
      if (title === '提示' && typeof message.title === 'string' && message.title) title = message.title;
      const wrong = message;
      console.warn('alertBox 收到配置对象，已按 alertBox(message, title) 兼容处理：', wrong.title || '(无标题)');
      message = wrong.message;
    }
    /* pre-wrap：失败明细是多行的（每个文件一行的 原因：…），没有它整段会被
     * 压成一长条，横着读几十个文件根本对不上号。confirmBox 里同样的处理。 */
    /* 【关闭必须走 modal 给的 close()，不能 closest('.modal-mask').remove()】
     * 直接 remove 只把节点摘掉，openOverlays 里那条记录还留着 ——
     * 于是它成了"幽灵遮罩"：之后按 Escape 时 topOverlay() 取到的是它，
     * close() 里 mask.remove() 对已脱离文档的节点无害，但真正该关的
     * 下一层弹窗要按两次 Esc 才轮得到。
     * 用 foot 里注入的 md.close 保证两条路径收口到同一处。 */
    let mdRef = null;
    const box = modal({
      title,
      body: (b) => b.appendChild(h('div', { style: { userSelect: 'text', whiteSpace: 'pre-wrap' } }, message)),
      foot: [h('button', { class: 'btn btn-primary', onclick: () => mdRef.close() }, '知道了')]
    });
    mdRef = box;
    return box;
  }
  /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
  function promptBox({ title, label = '', value = '', placeholder = '', okText }) {
    // 同 confirmBox：默认文案必须运行时取，否则切语言后不跟随
    if (okText == null) okText = TT('dialog.ok', '确定');
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
      if (isDesktop) await invoke(Channels.CHANNELS.CLIP.WRITE_TEXT, text);
      else await navigator.clipboard.writeText(text);
      toast('已复制', 'success', 1200);
      return true;
    } catch (e) { toast('复制失败：' + e.message, 'error'); return false; }
  }

  /* ---------- 表格 ---------- */
  function renderTable({ columns, rows, rowKey, onRowClick, empty }) {
    // 空态文案也要跟随语言（表格在工具页很常见，但默认值是中文）
    if (empty == null) empty = TT('table.empty', '暂无数据');
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
  /* 【开关必须是键盘可达的】
   * 它是个 div + click 监听，默认：
   *   · Tab 走不到（div 不进 tab 序列）→ 键盘用户够不着任何开关
   *   · 读屏软件读不出「这是个开关、现在开着还是关着」
   * 而设置页所有行为开关（开机自启、关闭到托盘、高危功能那一整屏）都用它。
   *
   * 用 role="switch" + aria-checked 而不是 role="button"：
   * 读屏会念「开关，已开启」，比「按钮」准确。
   * 空格键切换是 role=switch 的约定行为；Enter 不作为切换键
   * （那是 button 的约定，混用会让用户按回车意外打开高危功能）。
   *
   * @param {boolean} checked 初始状态
   * @param {(v:boolean)=>void} onChange 切换回调
   * @param {string} [label] 无障碍名称；缺省时由调用方后续用 aria-label 补
   */
  function switchEl(checked, onChange, label) {
    const s = div('switch' + (checked ? ' on' : ''));
    s.setAttribute('role', 'switch');
    s.setAttribute('tabindex', '0');
    s.setAttribute('aria-checked', checked ? 'true' : 'false');
    if (label) s.setAttribute('aria-label', label);
    const toggle = () => {
      /* 被 setDisabled 禁用时，点击/空格都不该有任何反应。
       * 判据放在这里而不是摘监听器：反复禁用/启用后摘挂容易漏挂。 */
      if (s.__disabled) return;
      s.classList.toggle('on');
      const nowOn = s.classList.contains('on');
      /* 【aria-checked 必须跟着状态走】否则读屏软件的播报与实际状态
       * 永远停在初始值，用户会以为开关没响应。 */
      s.setAttribute('aria-checked', nowOn ? 'true' : 'false');
      onChange && onChange(nowOn);
    };
    s.addEventListener('click', toggle);
    s.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Spacebar') {
        /* 必须 preventDefault：空格默认会滚动页面，
         * 用户按一下开关、整个设置页往下跳一屏。 */
        e.preventDefault();
        toggle();
      }
    });
    s.set = (v) => {
      s.classList.toggle('on', !!v);
      s.setAttribute('aria-checked', v ? 'true' : 'false');
    };
    /* 【setDisabled：禁用而不是隐藏】
     * 用在「本机没有可用硬件编码器」这类场景：开关留着可见，用户能看出
     * 这个功能存在、也能看出当前不可用；直接隐藏会让人以为功能不存在。
     *
     * 三个动作缺一不可：
     *   · disabled 类（视觉变灰，CSS 里 pointer-events:none）
     *   · tabindex=-1（键盘不能再 Tab 到它，否则读屏用户会读到"不可用"却仍能按）
     *   · aria-disabled（读屏软件要能播报出禁用状态，只靠 disabled 类它读不到） */
    s.setDisabled = (v) => {
      const off = !!v;
      s.classList.toggle('disabled', off);
      s.setAttribute('tabindex', off ? '-1' : '0');
      s.setAttribute('aria-disabled', off ? 'true' : 'false');
      /* 事件监听不摘除，而是用标志位挡住：
       * 摘了再挂容易在反复禁用/启用后漏挂（本项目有过这类回归）。
       * toggle 里检查这个标志即可。 */
      s.__disabled = off;
    };
    return s;
  }

  /* ---------- 拖拽区 ---------- */

  /* 【拖入文件夹时必须递归展开】
   * 用户把「下载」文件夹拖到图片压缩上，期望是「处理里面所有图片」。
   * 但 dataTransfer.files 对目录只给出**目录本身**的路径，
   * 原样传给工具的话：fs:stat 拿到 isDir:true，然后按文件去读 → 报错。
   * 用户看到的是「压缩失败」，而不是「不支持文件夹」——像软件坏了。
   *
   * 这里的取舍：
   *   · 只展开一层还是全递归？→ **全递归**。用户拖目录的意图就是"里面的东西"，
   *     只展开一层会让「我拖了整个截图文件夹却只处理了顶层」更困惑。
   *   · 递归深度/数量设上限，避免误拖 C:\ 时把界面卡死。
   *   · 展开失败（权限不足等）静默跳过该子项，不中断整体。
   *
   * @param {string[]} paths 拖入的原始路径
   * @returns {Promise<{files:string[], dirs:number}>} 展开后的文件列表 + 展开的目录数
   */
  /* 【两个上限都可配置】设置 → 通用 → 拖拽递归深度 / 拖拽文件数上限。
   * 用函数而不是常量：用户在设置页改完就该立刻生效，不必重启。
   * 取不到时用规格默认值（8 层 / 3000 个）—— Prefs.get 保证不返回 undefined。 */
  function expandMaxFiles() {
    const v = window.Prefs && window.Prefs.get('dragMaxFiles');
    return (typeof v === 'number' && v > 0) ? v : 3000;
  }
  function expandMaxDepth() {
    const v = window.Prefs && window.Prefs.get('dragMaxDepth');
    return (typeof v === 'number' && v > 0) ? v : 8;
  }
  /* ============ 拖拽展开 ============
   * 【必须报告"被跳过多少"，不能静默截断】
   * 原来达到 MAX_FILES / MAX_DEPTH 就 `return`，调用方只拿到 { files, dirs }。
   * 用户拖一个几千文件的目录做批量压缩/重命名，工具处理的是一个**不完整的
   * 子集**并报「完成」—— 少掉的文件没有任何提示。
   *
   * 【深度语义改成「可进入的目录层数」】
   * 原判断 `if (depth >= MAX_DEPTH) return;` 在 FS.LIST **之前**，
   * 于是位于第 MAX_DEPTH 层的目录连它自己的一级子文件都不会被收进来 ——
   * 不是"少钻一层"，而是"整个目录贡献 0 个文件"。
   * 用户把深度设成 8，直觉是"往下 8 层"，实际是"第 8 层的目录整个消失"。
   * 现在把判断移到"要递归子目录"时：边界层目录里的**文件**照常收集。 */
  async function expandDroppedPaths(paths) {
    const out = [];
    let dirs = 0;
    let skippedFiles = 0;
    let hitFileCap = false;
    let hitDepth = false;
    const MAX_FILES = expandMaxFiles();
    const MAX_DEPTH = expandMaxDepth();
    async function walk(p, depth) {
      if (out.length >= MAX_FILES) { hitFileCap = true; return; }
      let st = null;
      try { st = await invoke(Channels.CHANNELS.FS.STAT, p); } catch (e) { return; }
      if (!st || !st.isDir) { out.push(p); return; }
      let items = [];
      try { items = await invoke(Channels.CHANNELS.FS.LIST, p); } catch (e) { return; }
      dirs++;
      for (const it of items || []) {
        if (out.length >= MAX_FILES) { hitFileCap = true; return; }
        if (!it || !it.path) continue;
        if (it.isDir) {
          /* 只在"还要继续钻进这个子目录"时判断深度上限 */
          if (depth + 1 >= MAX_DEPTH) { hitDepth = true; continue; }
          await walk(it.path, depth + 1);
        } else {
          out.push(it.path);
        }
      }
    }
    for (const p of paths || []) {
      // 顺序展开而不是并发：一次拖 20 个目录时并发会把主进程 IO 打满
      await walk(p, 0);
    }
    return { files: out, dirs, skippedFiles, hitFileCap, hitDepth };
  }

  /**
   * 把展开结果渲染成一句给用户看的提示（没有触顶时返回空串）。
   *
   * 【为什么不返回精确的"还有多少个"】
   * 那要求把剩余整棵树遍历完 —— 而触顶时立即停止正是为了避免那种代价。
   * 用"是否触顶"这类布尔量 + 已知的部分计数，已经足够让用户知道
   * "结果不完整、该去调大上限"。
   */
  /**
   * 问用户「要选文件还是选文件夹」，返回对应的 dialog properties；取消返回 null。
   *
   * ============ 为什么需要这一步 ============
   * Electron 在 Windows/Linux 上**不可能**给出一个同时能选文件和文件夹的对话框：
   * `properties: ['openFile','openDirectory']` 会被静默退化成纯目录选择器。
   * 依据是 electron.d.ts 里 showOpenDialog 的 properties 说明：
   *   > On Windows and Linux an open dialog can not be both a file selector
   *   > and a directory selector, so if you set `properties` to
   *   > ['openFile', 'openDirectory'] on these platforms,
   *   > a directory selector will be shown.
   * 实测确认：标题变成「选择文件夹」、列表里只有文件夹、没有「文件类型」下拉。
   *
   * 而项目里有三个工具确实需要"两者都能选"：
   *   · zip-tool / archive-7z —— 压缩对象可能是若干文件，也可能是一个目录
   *   · file-unlock          —— 删不掉的可能是文件，也可能是目录
   * 它们原来直接传那个组合，于是在 Windows 上永远只能选目录，
   * 属于"界面承诺了两者、实际只有一半能用"。
   *
   * 既然系统不给双模对话框，就在上层**先问类型、再开对应对话框**。
   * 这是唯一能在 Windows 上真正同时支持两者的做法。
   *
   * 【为什么用 modal 而不是系统菜单】
   * modal 的取消语义干净（点 × 或「取消」都 resolve(null)），
   * 且键盘可达、Esc 关闭已由 modal 统一处理。
   *
   * @param {boolean} multiple 是否允许多选
   * @returns {Promise<string[]|null>} 可直接用作 properties；取消为 null
   */
  function pickFileOrFolder(multiple) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; md.close(); resolve(v); };
      const fileBtn = h('button', { class: 'btn btn-primary', onclick: () => finish(multiple ? ['openFile', 'multiSelections'] : ['openFile']) }, '选择文件');
      const dirBtn = h('button', { class: 'btn btn-secondary', onclick: () => finish(multiple ? ['openDirectory', 'multiSelections'] : ['openDirectory']) }, '选择文件夹');
      const cancelBtn = h('button', { class: 'btn btn-text', onclick: () => finish(null) }, '取消');
      const md = modal({
        title: '选择文件还是文件夹？',
        /* 不 resolve 的话，用户点 × 或按 Esc 会让这个 Promise 永远挂着，
         * 于是「点击拖拽区」这条链路静默卡死。modal 的 onClose 覆盖了所有关闭方式。 */
        onClose: () => { if (!done) { done = true; resolve(null); } },
        body: (b) => {
          b.appendChild(div('field-hint',
            'Windows 的文件对话框不能同时选择文件和文件夹，请先指定一种。'));
        },
        foot: [cancelBtn, dirBtn, fileBtn],
      });
    });
  }

  /**
   * 展开拖入的目录后，把「触顶」这件事说清楚。
   *
   * 【为什么不返回精确的"还有多少个"】
   * 那要求把剩余整棵树遍历完 —— 而触顶时立即停止正是为了避免那种代价。
   * 用"是否触顶"这类布尔量 + 已知的部分计数，已经足够让用户知道
   * "结果不完整、该去调大上限"。
   */
  function expandNotice(r, maxFiles, maxDepth) {
    const parts = [];
    if (r && r.hitFileCap) {
      parts.push(`已达到 ${maxFiles} 个文件的上限，剩余文件未加入`);
    }
    if (r && r.hitDepth) {
      parts.push(`目录层级超过 ${maxDepth} 层，更深的内容未加入`);
    }
    if (!parts.length) return '';
    return parts.join('；') + '。可在「设置 → 工具默认值」里调大上限。';
  }

  function dropzone({ text = '点击选择或拖拽文件到此处', sub = '', multiple = true, accept, onFiles, pickProps, directory = false, filters }) {
    const dz = div('dropzone');
    dz.appendChild(div('dz-icon', iconLg('upload')));
    const mainEl = div('dz-main', text);
    /* 拖拽提示会临时改写这行文字，需要能还原。
     * 用变量记住"当前应有的文案"而不是硬编码回 text：
     * dz.setMain() 会被 fileList 更新成「继续添加文件（可多选）」，
     * 拖拽结束后该还原成那个，不是最初的 text。 */
    let baseMainText = text;
    const setMainText = (t) => { baseMainText = t; mainEl.textContent = t; };
    dz.appendChild(mainEl);
    if (sub) dz.appendChild(div('dz-sub', sub));
    // 供 picker 在「已有内容」时把提示文案换成「继续添加」
    dz.setMain = (t) => setMainText(t);
    const getFiles = async () => {
      try {
        let props = pickProps || (directory ? ['openDirectory'] : (multiple ? ['openFile', 'multiSelections'] : ['openFile']));
        /* 【Windows 上 openFile + openDirectory 不可能同时生效】
         * Electron 官方文档（electron.d.ts 里 dialog.showOpenDialog 的 properties 说明）写得很明确：
         *   > On Windows and Linux an open dialog can not be both a file selector
         *   > and a directory selector, so if you set `properties` to
         *   > `['openFile', 'openDirectory']` on these platforms,
         *   > a directory selector will be shown.
         * 也就是说这个组合**静默退化成纯目录选择器** —— 用户永远选不到文件。
         * 实测确认过：界面标题是「选择文件夹」，列表里只显示文件夹，没有「文件类型」下拉框。
         *
         * 受影响的是三个"要能选文件、也要能选文件夹"的工具：
         *   zip-tool / archive-7z（压缩对象可能是目录）、file-unlock（被占用的可能是文件）
         * 它们原来写的都是这个组合，于是「拖能用、点只能用一半」。
         *
         * 正确做法：**问一次，然后按选择打开对应的对话框**。
         * 这是唯一能在 Windows 上真正同时支持两者的方案 ——
         * 系统不给我们一个双模对话框，我们就在上层分两次问。
         * 用 modal 而不是原生对话框，是因为这一步不该阻塞主线程太久，
         * 而且用户点「取消」时应当直接结束、不再弹第二个框。 */
        const wantsBoth = props.includes('openFile') && props.includes('openDirectory');
        if (wantsBoth) {
          const pick = await pickFileOrFolder(multiple);
          if (!pick) return;                       // 用户取消：什么都不做
          props = pick;
        }
        const paths = await invoke(Channels.CHANNELS.DIALOG.OPEN, filters ? { properties: props, filters } : { properties: props });
        if (paths && paths.length) onFiles(paths);
      } catch (e) { toast(e.message, 'error'); }
    };
    dz.addEventListener('click', getFiles);
    /* 【拖入文件夹时要给不一样的反馈】
     * 原来 dragover 一律加同一个 .dragover 类。但用户拖文件夹时心里想的是
     * 「这一整个文件夹里的东西」，而拖单个文件是「就这一个」。
     * 两者的期望不同，界面却长得一样，用户无法确认「我拖对了吗」。
     *
     * 判据：dataTransfer.items 里若有 entry.isDirectory 就是目录。
     * dragover 事件里**不能**调 getAsFile()（会触发一次真实读取），
     * 但 webkitGetAsEntry() 在 dragover 阶段是安全的、只读元数据。
     * 注意这仍然只是"意图提示"——真正判定在 drop 时用 fs:stat 复核。 */
    dz.addEventListener('dragover', (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.add('dragover');
      let hasDir = false;
      try {
        const items = e.dataTransfer && e.dataTransfer.items;
        if (items) {
          for (const it of items) {
            const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
            if (entry && entry.isDirectory) { hasDir = true; break; }
          }
        }
      } catch (err) { /* 某些环境拿不到 entry，按普通文件处理 */ }
      dz.classList.toggle('dragover-dir', hasDir);
      if (hasDir) {
        mainEl.textContent = '松开即可导入整个文件夹';
        dz.classList.add('dragover-hint');
      }
    });
    dz.addEventListener('dragleave', () => {
      dz.classList.remove('dragover', 'dragover-dir');
      if (dz.classList.contains('dragover-hint')) {
        dz.classList.remove('dragover-hint');
        // 恢复原文案（展开逻辑在 drop 里也会改，这里只需还原）
        if (mainEl.textContent === '松开即可导入整个文件夹') mainEl.textContent = baseMainText;
      }
    });
    dz.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover');
      const files = [...e.dataTransfer.files];
      if (!files.length) return;
      const paths = files.map(f => api.getPathForFile(f)).filter(Boolean);
      if (!paths.length) { onFiles([], files); return; }
      /* 拖进来的是目录就递归展开（见 expandDroppedPaths 的说明）。
       * 展开期间给个视觉反馈：扫几千个文件可能要几秒，
       * 没有任何提示的话用户会以为拖拽没生效、再拖一次。
       *
       * 【不要用「路径里有没有点」来猜是不是目录】
       * `My Documents`、`2024 照片` 这类目录名没有扩展名，看图似的判断会误判，
       * 反而把正常文件名（如 `README`）当成目录去 stat。
       * 统一走 fs:stat 问系统，问一次的成本远低于误判的代价。 */
      let hasDir = false;
      for (const p of paths) {
        try { const st = await invoke(Channels.CHANNELS.FS.STAT, p); if (st && st.isDir) { hasDir = true; break; } } catch (err) {}
      }
      if (hasDir) {
        mainEl.textContent = '正在展开文件夹…';
        dz.style.pointerEvents = 'none';
      }
      let expanded;
      try {
        expanded = await expandDroppedPaths(paths);
      } finally {
        // 还原成"应该显示的文案"，而不是拖拽前那一刻的文字
        // （拖拽前可能正好停在提示语上）
        mainEl.textContent = baseMainText;
        dz.style.pointerEvents = '';
        dz.classList.remove('dragover-dir', 'dragover-hint');
      }
      if (expanded.dirs > 0 && expanded.files.length) {
        toast('已从 ' + expanded.dirs + ' 个文件夹展开 ' + expanded.files.length + ' 个文件', 'info', 2000);
      } else if (expanded.dirs > 0 && !expanded.files.length) {
        // 拖了个空文件夹：明确说一声，否则"什么都没发生"
        toast('文件夹里没有可处理的文件', 'warn');
        return;
      }
      /* 【触顶必须告知】否则用户以为整批都进来了，实际只处理了一部分。
       * 用 warn 级别的 toast 且停留更久 —— 这条信息比"展开了 N 个"重要得多。 */
      const notice = expandNotice(expanded, expandMaxFiles(), expandMaxDepth());
      if (notice) toast(notice, 'warn', 6000);
      onFiles(expanded.files);
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

    /* 体积查询改成「先登记、后批量」：
     * 原来每个非虚拟条目都单独 invoke(Channels.CHANNELS.FS.STAT)，500 个文件就是 500 次 IPC 往返，
     * 主进程排队处理，列表体积要等很久才逐个冒出来。
     * 现在 fillSize 只把 (item, sizeEl) 记进待查队列，等这一帧的行都建好后
     * 由 flushSizes() 按 50 个一批发 fs:stat-multi，一次拿回整批大小。 */
    let pendingSizes = [];
    const SIZE_BATCH = 50;

    function fillSize(item, sizeEl) {
      // 虚拟条目（剪贴板图片等没有磁盘路径）：不 stat，直接显示来源
      if (item.virtual) { sizeEl.textContent = item.sizeLabel || '剪贴板'; return; }
      // 已知体积（例如上次已经查到过）就直接用，不再问主进程
      if (item.size !== undefined && item.size !== null) {
        sizeEl.textContent = item.isDir ? '文件夹' : fmtBytes(item.size);
        return;
      }
      pendingSizes.push({ item, sizeEl });
    }

    async function flushSizes() {
      if (!pendingSizes.length) return;
      const queue = pendingSizes;
      pendingSizes = [];
      for (let off = 0; off < queue.length; off += SIZE_BATCH) {
        const slice = queue.slice(off, off + SIZE_BATCH);
        const paths = slice.map((q) => q.item.path);
        let stats;
        try { stats = await invoke(Channels.CHANNELS.FS.STAT_MULTI, paths); }
        catch (e) { stats = null; }
        slice.forEach((q, k) => {
          const st = stats && stats[k];
          if (!st) { q.sizeEl.textContent = '—'; return; } // 不存在/无权限
          q.item.size = st.size;
          q.item.isDir = !!st.isDir;
          if (!items.includes(q.item)) return; // 期间被删掉了
          q.sizeEl.textContent = st.isDir ? '文件夹' : fmtBytes(st.size);
        });
        renderHead(); // 每批更新一次合计，不必每项都刷
      }
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
      pendingSizes = [];
      /* 【refresh 会重建所有行 —— 调用方的结果必须能在重建后重画】
       * 这里不额外挂回调：makeRow 内部已经按 rowEnd(item, i, row) 调过一遍。
       * 真实缺陷见 js/tools/hash.js：早期它把摘要 appendChild 到行元素上，
       * 用户再添加/删除文件时 refresh 一重建，之前那行成了游离节点，
       * 摘要画到看不见的地方；而「已算过」集合仍然命中，于是永不重算。
       * 修法在工具侧：结果按路径存着，rowEnd 里按路径重画。
       * （这里保留注释，是为了让后来者知道问题出在「行会被重建」这个前提上。） */
      items.forEach((it, i) => body.appendChild(makeRow(it, i)));
      emptyEl.style.display = items.length ? 'none' : '';
      el.classList.toggle('has-items', !!items.length);
      renderHead();
      // 行都建好后再统一补体积，避免每行一次 IPC
      flushSizes();
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
      /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
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
      beforeRemove, rowStart, rowEnd, emptyText, onBlob,
      /* 【pickProps 必须解构出来再传下去 —— 曾经漏了，两个工具因此半坏】
       * dropzone() 里 props 的取法是
       *   pickProps || (directory ? ['openDirectory'] : (multiple ? [...] : ['openFile']))
       * 也就是说 pickProps 是"绕过默认组合"的唯一途径。
       * 而 filePicker 只是把 opts 里**自己列出的**字段转给 dropzone ——
       * 早期这一行的解构里没有 pickProps，下面 dropzone({...}) 也没传，
       * 于是调用方写的 pickProps 被**静默丢弃**，退回默认组合：
       *   · zip-tool     想要 openFile + openDirectory（要能选文件夹压缩），
       *                  实际拿到 ['openFile','multiSelections'] —— 选不到文件夹；
       *   · archive-7z   同理。
       *
       * 【但只修这一处还不够】那两个工具传的组合本身在 Windows 上就无效 ——
       * Electron 明确不支持双模对话框，会静默退化成纯目录选择器。
       * 所以 dropzone 里另有一层处理：检测到 openFile + openDirectory 同时出现时，
       * 先弹「选择文件 / 选择文件夹」二选一，再开对应的对话框。
       * 详见 pickFileOrFolder 的说明。 */
      pickProps
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
      /* pickProps 必须在这一行传下去，否则调用方写的它会被静默丢弃 ——
       * 见 filePicker 解构处那段说明（zip-tool / archive-7z 因此选不到文件夹）。 */
      text, sub, multiple: multiple && !single, directory, filters, pickProps,
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
  /* 进度条。
   * 【为什么 set() 要自己算时间而不是让调用方传】
   * 调用方只知道自己处理到第几项（set(37)），不知道总耗时——
   * 而「还要等多久」必须由进度条自己按速率推算：拿第一次 set 到现在的
   * 时间差 ÷ 已完成百分比 = 预估总时长。
   *
   * 【为什么要等一会儿才显示剩余时间】
   * 刚开始的几项耗时波动极大（第一张图可能因为解码预热慢 3 倍），
   * 此时推算出来的"还要 8 分钟"通常离谱，显示它只会误导。
   * 所以：进度 < 8% 或样本不足 3 个时不显示，宁可不显示也别瞎猜。
   *
   * 【保留旧接口】
   * 原先是 { el, set, hide, show }，40 多处调用只用了 set(pct)。
   * 这里全部保持兼容，只是多了一个可选的文字节点。 */
  function progressEl() {
    const p = div('progress', div('progress-fill'));
    p.style.width = '160px';
    const label = h('span', { class: 'progress-eta' }, '');
    label.style.display = 'none';
    /* 【把剩余时间塞进 el 自己里面，而不是要求 15 个调用点各改一行】
     * 那些调用点统一是 `div('form-row', startBtn, prog.el, status)`，
     * 只放了进度条本身。如果 etaEl 是独立节点，就得逐个改成 prog.el + prog.etaEl，
     * 15 处改动、漏一处就是"这个工具永远不显示剩余时间"。
     * 包进 el 内部则所有调用点自动获得这个能力，且不改变 el 的尺寸语义
     * （外面包一层 inline-flex，宽度仍由 inner 的 160px 决定）。 */
    const wrap = h('span', { class: 'progress-wrap' }, p, label);
    let startedAt = 0;
    let samples = 0;
    /* 【跨次运行必须复位，否则第二轮的「剩余时间」整轮偏大】
     * 原实现只在 startedAt 为 0 时记起点，而 startedAt 一旦写上就再没人清零。
     * 于是一个进度条被同一个工具复用两次时（点「开始」→ 完成 → 再点「开始」），
     * 第二轮 elapsed 里含着上一轮的全部耗时：
     *   真实这轮 10 秒跑到 50% → 理应「还剩约 10 秒」；
     *   实际 elapsed 是 120 秒 → 显示「还剩约 2 分钟」。
     * 进度越靠前偏得越狠，而用户完全无从判断它为什么这么慢。
     *
     * 判据取两条，任一成立即视为新一轮：
     *   · 上次已经到过 100%（正常跑完）
     *   · 这次的值比上次小（调用方手动把进度拨回去重新开始）
     * 两条都是"事件层面明确的新一段"，不需要调用方额外声明，
     * 所以 40 多个调用点一个都不用改 —— 这正是修在组件里的理由。 */
    let lastPct = -1;
    let finished = false;
    return {
      el: wrap,
      etaEl: label,
      set(pct) {
        const v = Math.max(0, Math.min(100, pct));
        p.firstChild.style.width = v + '%';
        if (finished || (lastPct >= 0 && v < lastPct)) {
          startedAt = 0; samples = 0; finished = false;
        }
        lastPct = v;
        // 首次调用记为起点；之后按速率推算
        if (!startedAt) { startedAt = Date.now(); samples = 1; return; }
        samples++;
        if (samples < 3 || v < 8 || v >= 100) {
          label.style.display = 'none';
          if (v >= 100) finished = true;
          return;
        }
        const elapsed = Date.now() - startedAt;
        const remainMs = elapsed / (v / 100) - elapsed;
        if (!isFinite(remainMs) || remainMs <= 0) { label.style.display = 'none'; return; }
        label.textContent = fmtDuration(remainMs);
        label.style.display = '';
      },
      hide() { wrap.style.display = 'none'; label.style.display = 'none'; },
      show() { wrap.style.display = ''; p.style.display = ''; }
    };
  }
  /* 把毫秒说成人话。刻意只保留一个量级：
   * 「约 1 分 30 秒」比「1 分 29.7 秒」更好读，也避免数字频繁跳动。 */
  function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 5) return '即将完成';
    if (s < 60) return '约 ' + s + ' 秒';
    const m = Math.round(s / 60);
    if (m < 60) return '约 ' + m + ' 分钟';
    const hh = Math.floor(m / 60);
    return '约 ' + hh + ' 小时 ' + (m % 60) + ' 分';
  }
  function loadingBlock(text = '加载中…') { return div('loading-block', h('span', { class: 'spinner' }), text); }
  function fieldRow(label, control, hint) {
    const row = div('form-row');
    if (label) row.appendChild(h('label', { class: 'form-label' }, label));
    row.appendChild(control);
    if (hint) row.appendChild(h('span', { class: 'field-hint' }, hint));
    return row;
  }
  /* 【按钮文本必须单独包一层 span】
   * 之前是 h('button', {...}, icon(iconName), text) —— 文本作为**裸文本节点**塞进去。
   * 于是想换文案的地方只能 `btn.textContent = '新文案'`，而那会清掉整个子节点列表，
   * 连左边那个 svg 图标一起干掉：图标闪烁一次就永久消失了。
   * 实际踩到的：文本编解码那 5 个「编码/解码」切换按钮，
   * 初始有图标，点一下变成纯文字。
   *
   * 包一层 .btn-label 之后，改文案写成 `b.querySelector('.btn-label').textContent = x`
   * 即可保住图标。不叫 span 是为了 querySelector 能稳定命中
   * （按钮里可能还有别的 span，比如 .icon 本身）。
   *
   * 注意：文本为空的按钮（纯图标按钮）不生成这个 span，
   * 否则 flex gap 会多出一个 0 宽的元素，把图标挤偏。 */
  function btn(text, cls, onClick, iconName) {
    const b = h('button', { class: 'btn ' + (cls || 'btn-primary'), onclick: onClick }, iconName ? icon(iconName) : null);
    const label = text == null ? '' : String(text);
    if (label) b.appendChild(h('span', { class: 'btn-label' }, label));
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

  /* 整壳重建（切换界面语言）前调用：
   * 1) 把还开着的弹窗按「取消」收场，避免它们的 promise 永远悬着；
   * 2) 丢弃 toast 容器引用，下次 toast() 会挂到新 body 上。
   * 幂等，重建前后都能安全调用。 */
  function resetShellForRebuild() {
    for (const entry of [...openOverlays]) {
      try { entry.close(); } catch (e) { console.warn('modal close', e); }
    }
    openOverlays = new Set();
    toastBox = null;
  }

  /* 防重入的**统一收口**。
   *
   * 【为什么要这个助手】
   * 工具页的异步按钮普遍是「先置 running = true，跑完在 finally 里复位」。
   * 但中间那些「提前 return」的校验分支（没选文件、没填密码、
   * 在保存对话框点取消、没装 FFmpeg……）如果忘了复位，
   * running 就永远停在 true —— 按钮彻底没反应，只有切页重建才恢复。
   * 这类 bug 一共出现过 7 次，全是逐处手写造成的差异。
   *
   * 用法：
   *   const start = guard(() => { flag = true; ...; flag = false; });
   * 或者帮它管标志本身：
   *   const start = guard(async () => { ...业务... }, {
   *     before: () => { goBtn.disabled = true; },
   *     after:  () => { goBtn.disabled = false; },
   *   });
   *
   * 无论中间怎么 return、抛异常，after 与状态复位都保证执行，
   * 而且并发的第二次点击会被直接挡掉（不用调用方自己写 if (running) return）。
   */
  function guard(fn, opts) {
    const o = opts || {};
    let busy = false;
    return async function guarded(...args) {
      if (busy) return;              // 防重入：真正并发时挡住第二次
      busy = true;
      try {
        if (typeof o.before === 'function') o.before();
        return await fn.apply(this, args);
      } finally {
        busy = false;                // 关键：任何 return / throw 都会走到这里
        try { if (typeof o.after === 'function') o.after(); } catch (e) { console.warn('guard after', e); }
      }
    };
  }

  window.h = h; // 全局 DOM 构建函数，供所有工具直接使用
  // 全局兜底：工具文件即使遗漏解构也能直接使用这些助手
  Object.assign(window, { h, div, icon, iconLg, btn, toast, copyText, fmtBytes, fmtNum, fmtTime, fmtDate, pad2, debounce, escapeHtml, renderTable, switchEl, dropzone, fileList, filePicker, lineChart, progressEl, loadingBlock, fieldRow, convertLayout, kvGrid, placeholder, modal, confirmBox, alertBox, promptBox, nextId, guard });
  window.ui = { h, div, icon, iconLg, makeButtonLike, focusable, expandDroppedPaths, expandNotice, fmtBytes, fmtNum, fmtTime, fmtDate, pad2, debounce, escapeHtml, toast, modal, confirmBox, alertBox, promptBox, copyText, renderTable, switchEl, dropzone, fileList, filePicker, lineChart, progressEl, loadingBlock, fieldRow, btn, convertLayout, kvGrid, placeholder, nextId, resetShellForRebuild, guard };
})();
