/* 应用外壳：导航、标签页、搜索、首页、状态栏、设置 */
(function () {
  const { div, icon, iconLg, toast, confirmBox, switchEl, fmtBytes, btn } = window.ui;
  const { invoke, on, isDesktop } = window.api;
  const R = window.Registry;
  /* 取词：外壳文案统一走 i18n，工具正文保持中文。
     用简写 T 是为了让下面几百处调用不至于被 `window.i18n.t(...)` 撑得太长。 */
  const T = (k, v) => (window.i18n ? window.i18n.t(k, v) : k);
  const MN = (m) => (R.modName ? R.modName(m) : (m && m.name) || '');
  let lang = 'zh';

  const state = {
    favorites: [], recents: [],
    tabs: [],            // 打开的工具 id 列表
    view: { type: 'home' },
    collapsed: false
  };

  /* ============ 高危功能 ============
     dangerousCaps: 已开启的高危能力 id 列表（来自主进程）
     toolDanger:    工具 id → { caps, enabled }，用于把高危工具卡片标红 */
  let dangerousCaps = [];
  let toolDanger = {};
  async function loadDangerousState() {
    if (!isDesktop) return;
    try {
      const r = await invoke('dangerous:list');
      dangerousCaps = r.enabled || [];
      toolDanger = await invoke('dangerous:tool-caps');
    } catch (e) { dangerousCaps = []; toolDanger = {}; }
  }
  function isDangerTool(toolId) { return !!toolDanger[toolId]; }
  function isDangerEnabled(toolId) {
    const d = toolDanger[toolId];
    return !!(d && d.enabled);
  }

  /* ============ 主题 ============ */
  /* 两个正交维度：
     明暗 data-theme  = light | dark（由系统偏好或用户选择决定）
     配色 data-accent = 极地白/雾霭蓝/苔原/紫罗兰/樱粉/鎏金/青碧/暖砂/纯黑白
     配色只写 data-accent，明暗只写 data-theme，CSS 变量层负责组合。 */
  const ACCENTS = [
    { id: 'polar', name: '极地白', desc: '经典商务蓝，清爽专业' },
    { id: 'mist', name: '雾霭蓝', desc: '冷调低饱和，安静专注' },
    { id: 'jade', name: '苔原绿', desc: '低饱和绿，久看不累' },
    { id: 'violet', name: '紫罗兰', desc: '科技感，适合开发调试' },
    { id: 'rose', name: '樱花粉', desc: '柔和轻盈' },
    { id: 'gold', name: '鎏金', desc: '暖调沉稳，商务质感' },
    { id: 'teal', name: '青碧', desc: '清新冷静' },
    { id: 'sand', name: '暖砂', desc: '暖调复古，纸质感' },
    { id: 'mono', name: '纯黑白', desc: '无彩极简，高对比' }
  ];
  let currentAccent = 'polar';
  let themeListeners = [];
  /* buildShell 注册的 document 级监听的退订函数（见 applyLangLabels） */
  let shellCleanup = null;
  /* matchMedia 的 change 监听只挂一次。
   * applyTheme 会在每次整壳重建（切语言）后重新调用，无守卫就会累积：
   * 切三次语言就有三份监听，每份都会去 store:get 一次。 */
  let schemeListenerBound = false;
  function applyTheme() {
    invoke('store:get', 'settings.theme', 'system').then(mode => {
      setThemeAttr(mode);
    });
    invoke('store:get', 'settings.accent', 'polar').then(accent => {
      setAccent(accent || 'polar');
    });
    if (!schemeListenerBound) {
      schemeListenerBound = true;
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
        const mode = await invoke('store:get', 'settings.theme', 'system');
        if (mode === 'system') setThemeAttr('system');
      });
    }
    // 主进程 nativeTheme 变化时同步（settings.theme-changed 携带 shouldUseDarkColors）
    themeListeners.push(on('settings.theme-changed', (isDark) => {
      invoke('store:get', 'settings.theme', 'system').then(m => {
        if (m === 'system') setThemeAttr('system');
      });
    }));
  }
  function setAccent(accent) {
    const id = ACCENTS.some(a => a.id === accent) ? accent : 'polar';
    currentAccent = id;
    document.documentElement.dataset.accent = id;
    // 通知主进程广播给辅助窗口（标尺/贴图/截图标注），让它们同步换色
    if (isDesktop) invoke('app:set-accent', id).catch(() => {});
  }
  function setThemeAttr(mode) {
    let dark = false;
    if (mode === 'dark') dark = true;
    else if (mode === 'light') dark = false;
    else dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    // 主题按钮图标跟随当前模式（span 容器 + 替换子节点，避免 SVG 嵌套）
    if (themeIconEl) {
      themeIconEl.replaceChildren(icon(dark ? 'sun' : 'moon', 'icon-lg'));
    }
  }
  /* 切换主题；origin = {x, y} 时以该点为圆心做扩散揭示动画 */
  async function changeTheme(mode, origin) {
    const apply = async () => {
      try {
        await invoke('store:set', 'settings.theme', mode);
        if (isDesktop) {
          try {
            const isDark = await invoke('app:set-theme', mode);
            setThemeAttr(typeof isDark === 'boolean' ? (isDark ? 'dark' : 'light') : mode);
          } catch (e) { setThemeAttr(mode); }
        } else {
          setThemeAttr(mode);
        }
      } catch (e) {
        toast('主题切换失败：' + e.message, 'error');
      }
    };
    const supportsVT = typeof document.startViewTransition === 'function' && origin;
    if (!supportsVT) { await apply(); return; }
    try {
      const vt = document.startViewTransition(apply);
      await vt.ready.then(() => {
        const x = origin.x, y = origin.y;
        const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          { duration: 420, easing: 'ease-in-out', pseudoElement: '::view-transition-new(root)' }
        );
      }).catch(() => {});
    } catch (e) { await apply(); }
  }

  /* ============ 收藏 / 最近使用 ============ */
  async function loadUserData() {
    state.favorites = await invoke('store:get', 'favorites', []);
    state.recents = await invoke('store:get', 'recents', []);
  }
  async function toggleFavorite(toolId) {
    const i = state.favorites.indexOf(toolId);
    if (i >= 0) state.favorites.splice(i, 1); else state.favorites.unshift(toolId);
    await invoke('store:set', 'favorites', state.favorites);
    toast(i >= 0 ? '已取消收藏' : '已收藏', 'success', 1000);
    // 原地更新星标：不重建工具页，避免清空用户未保存的输入/结果
    const starBtn = document.querySelector('.tool-header .th-star');
    if (starBtn && state.view.type === 'tool' && state.view.toolId === toolId) {
      const on = state.favorites.includes(toolId);
      starBtn.replaceChildren(icon('star'), on ? T('tool.favorited') : T('tool.favorite'));
    }
    if (state.view.type === 'fav') render(); // 收藏页需刷新列表
    else renderNav();
  }
  async function pushRecent(toolId) {
    state.recents = [toolId, ...state.recents.filter(x => x !== toolId)].slice(0, 12);
    await invoke('store:set', 'recents', state.recents);
  }

  /* ============ 工具检索 ============
     首页与标题栏共用同一套「结果行」渲染，避免两处搜索长得不一样。
     命中词要标出来：用户打了「合并」，结果里就得看见「合并」两个字在哪，
     否则一屏十几行看过去分不清为什么这条被搜出来。 */
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function highlightHit(text, q) {
    const safe = window.ui.escapeHtml(text == null ? '' : text);
    const tokens = String(q || '').trim().split(/\s+/).filter(Boolean)
      .map(t => escapeRe(window.ui.escapeHtml(t)));
    if (!tokens.length) return safe;
    // 长词优先，否则「合并」可能被更短的「合」抢先切碎，标红范围会变碎
    tokens.sort((a, b) => b.length - a.length);
    return safe.replace(new RegExp('(' + tokens.join('|') + ')', 'gi'), '<mark class="sr-hit">$1</mark>');
  }
  function searchResultRow(t, q) {
    const mod = R.MODULES.find(m => m.id === t.module);
    const row = div('search-result');
    // 左栏（图标 + 名称 + 标记）与右栏（说明）分开：首页列表里十几个结果并排看，
    // 说明文字右对齐会被推到大老远，中间空出一大段，视觉上跟名称断开。
    // 拆成两栏后说明固定从同一 x 起排，像一张表，扫读快得多。
    const main = div('sr-main');
    main.appendChild(icon(t.icon));
    main.appendChild(h('span', { class: 'sr-name', html: highlightHit(t.name, q) }));
    if (isDangerTool(t.id)) main.appendChild(h('span', { class: 'sr-danger' }, isDangerEnabled(t.id) ? '高危' : '未启用'));
    main.appendChild(h('span', { class: 'sr-module' }, mod ? MN(mod) : ''));
    row.appendChild(main);
    row.appendChild(h('span', { class: 'sr-desc', title: t.desc || '' }, t.desc || ''));
    return row;
  }
  /* Ctrl+K 的去向：在首页就聚焦首页那个大搜索框，在别的页面聚焦标题栏的。
     首页时标题栏搜索是隐藏的，不这么分流的话 Ctrl+K 会聚焦到一个 display:none 的输入框，
     光标看不见、打字没反应，用户只会以为快捷键坏了。 */
  function focusSearch() {
    if (state.view.type === 'home') {
      const inp = contentEl && contentEl.querySelector('.hs-input');
      if (inp) { inp.focus(); inp.select(); return; }
    }
    if (searchInput) { searchInput.focus(); searchInput.select(); }
  }

  /* ============ 布局 ============ */
  let sidebarEl, contentEl, tabbarEl, breadcrumbEl, searchInput, searchDrop, searchWrapEl, statusText, cpuEl, memEl, maxBtn, themeIconEl;

  function buildShell() {
    /* 侧边栏 */
    sidebarEl = div('sidebar');
    const logo = div('logo');
    logo.appendChild(h('img', { src: 'assets/icon.png', alt: '' }));
    logo.appendChild(h('span', { class: 'logo-name' }, T('app.name')));
    sidebarEl.appendChild(logo);

    const navScroll = div('nav-scroll');
    const navHome = div('nav-item', icon('home', 'icon-lg'), h('span', null, T('nav.home')));
    navHome.dataset.nav = 'home';
    navScroll.appendChild(navHome);
    navScroll.appendChild(div('nav-section-title', T('nav.modules')));
    for (const m of R.MODULES) {
      const nm = MN(m);
      const item = div('nav-item', icon(m.icon, 'icon-lg'), h('span', null, nm));
      item.dataset.nav = 'module:' + m.id;
      item.title = nm;
      navScroll.appendChild(item);
    }
    sidebarEl.appendChild(navScroll);

    const bottom = div('nav-bottom');
    const favItem = div('nav-item', icon('star', 'icon-lg'), h('span', null, T('nav.favorites')));
    favItem.dataset.nav = 'fav';
    const setCItem = div('nav-item', icon('settings', 'icon-lg'), h('span', null, T('nav.settings')));
    setCItem.dataset.nav = 'settings';
    // 「关于」不再是侧栏一级入口：它只是版本号、运行环境、检查更新这几行信息，
    // 单开一页占一个导航位不划算，合并进设置的「关于」分区即可。
    const collapseBtn = div('collapse-btn', icon('chev-left'), h('span', null, T('nav.collapse')));
    collapseBtn.addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      sidebarEl.classList.toggle('collapsed', state.collapsed);
      collapseBtn.innerHTML = ''; collapseBtn.appendChild(icon(state.collapsed ? 'chev-right' : 'chev-left'));
      if (!state.collapsed) collapseBtn.appendChild(h('span', null, T('nav.collapse')));
    });
    bottom.appendChild(favItem); bottom.appendChild(setCItem); bottom.appendChild(collapseBtn);
    sidebarEl.appendChild(bottom);

    sidebarEl.addEventListener('click', (e) => {
      const item = e.target.closest('.nav-item');
      if (!item || !item.dataset.nav) return;
      const nav = item.dataset.nav;
      if (nav === 'home') showView({ type: 'home' });
      else if (nav === 'fav') showView({ type: 'fav' });
      else if (nav === 'settings') showView({ type: 'settings' });
      else if (nav.startsWith('module:')) showView({ type: 'module', moduleId: nav.slice(7) });
    });

    /* 主区域 */
    const main = div('main');
    const titlebar = div('titlebar');
    breadcrumbEl = div('breadcrumb');
    const searchWrap = div('search-wrap');
    searchWrapEl = searchWrap;
    searchWrap.appendChild(Object.assign(div('', icon('search', 'icon')), { className: 'search-icon' }));
    searchInput = h('input', { class: 'search-input', placeholder: T('search.titlebar') });
    searchDrop = div('search-dropdown');
    searchWrap.appendChild(searchInput); searchWrap.appendChild(searchDrop);
    const tbRight = div('tb-right');
    const themeBtn = h('button', { class: 'tb-btn', title: T('common.theme') });
    themeIconEl = h('span', { style: { display: 'inline-flex' } });
    themeIconEl.appendChild(icon('moon', 'icon-lg'));
    themeBtn.appendChild(themeIconEl);
    themeBtn.addEventListener('click', async (e) => {
      const cur = document.documentElement.dataset.theme;
      await changeTheme(cur === 'dark' ? 'light' : 'dark', { x: e.clientX, y: e.clientY });
    });
    const minBtn = h('button', { class: 'tb-btn', title: T('common.minimize') }, icon('minus', 'icon-lg'));
    minBtn.addEventListener('click', () => invoke('win:minimize').catch(() => {}));
    maxBtn = h('button', { class: 'tb-btn', title: T('common.maximize') }, icon('square', 'icon-lg'));
    maxBtn.addEventListener('click', () => invoke('win:maximize').catch(() => {}));
    const closeBtn = h('button', { class: 'tb-btn close', title: T('common.close') }, icon('x', 'icon-lg'));
    closeBtn.addEventListener('click', () => invoke('win:close').catch(() => {}));
    tbRight.appendChild(themeBtn); tbRight.appendChild(minBtn); tbRight.appendChild(maxBtn); tbRight.appendChild(closeBtn);

    titlebar.appendChild(breadcrumbEl);
    titlebar.appendChild(searchWrap);
    titlebar.appendChild(tbRight);

    tabbarEl = div('tabbar');
    contentEl = div('content');

    const statusbar = div('statusbar');
    statusText = h('span', null, isDesktop ? T('status.ready') : T('status.browser'));
    const sbRight = div('sb-right');
    cpuEl = h('span', { class: 'sb-val' }, 'CPU --%');
    memEl = h('span', { class: 'sb-val' }, (lang === 'en' ? 'MEM ' : '内存 ') + '--%');
    sbRight.appendChild(cpuEl); sbRight.appendChild(memEl);
    statusbar.appendChild(statusText); statusbar.appendChild(sbRight);

    main.appendChild(titlebar); main.appendChild(tabbarEl); main.appendChild(contentEl); main.appendChild(statusbar);
    document.body.appendChild(sidebarEl);
    document.body.appendChild(main);

    /* 这一整组 IPC 订阅都在 buildShell 里注册，而切换界面语言会整壳重建。
     * 之前它们**从不退订**：切一次语言多一份，切 N 次就有 N 份。
     * 后果不是「只是多占点内存」——
     *   · 周期任务触发时弹 N 个系统通知 + N 个 toast；
     *   · 托盘「截图 OCR」一次会打开 N 个相同的工具页；
     *   · 每个 window.api.on 都要过主进程广播，监听器越多越慢。
     * 所以每个订阅的退订函数都收进 shellUnsubs，最后并入 shellCleanup，
     * 由 applyLangLabels 在重建前统一调用。 */
    const shellUnsubs = [];
    const sub = (ev, cb) => { const u = on(ev, cb); if (typeof u === 'function') shellUnsubs.push(u); return u; };

    sub('win:maximized', (v) => { maxBtn.innerHTML = ''; maxBtn.appendChild(icon(v ? 'copy' : 'square', 'icon-lg')); });

    /* 状态栏数据 */
    sub('sys:stats', (s) => {
      const cpu = s.cpu, mem = s.memPct;
      cpuEl.textContent = `CPU ${cpu.toFixed(0)}%`;
      memEl.textContent = (lang === 'en' ? 'MEM ' : '内存 ') + mem.toFixed(0) + '%';
      cpuEl.className = 'sb-val ' + (cpu >= 90 ? 'bad' : cpu >= 70 ? 'warn' : 'ok');
      memEl.className = 'sb-val ' + (mem >= 90 ? 'bad' : mem >= 80 ? 'warn' : 'ok');
    });
    sub('hotkey:pressed', () => toast('全局热键已唤起', 'info', 1000));

    /* 主进程事件路由：截图 OCR / 托盘直达工具 / 周期任务触发 / 区域截图结果 / 托盘错误 */
    sub('snip:ocr', (filePath) => {
      window.__ocrPendingPath = filePath;
      openTool('screenshot-ocr');
    });
    sub('app:open-tool', (id) => { if (R.get(id)) openTool(id); });
    /* 用户重复双击了图标：主实例已经把窗口提到前面，这里再说明一句，
       否则用户只会看到窗口「突然冒出来」，不明白刚才那次点击为什么没开新窗口。 */
    sub('app:already-running', () => toast('核核工具箱已经在运行，已切换到当前窗口', 'info', 2500));
    sub('sched:fire', (s) => {
      // 系统通知的正文来自用户填写的任务内容（不翻译），
      // 但标题与「没有内容时的兜底文案」是我们自己的，要走 i18n。
      try { new Notification(T('notify.schedTitle'), { body: s.message || T('notify.schedBody') }); } catch (e) {}
      toast('⏰ ' + (s.message || T('notify.schedBody')), 'info', 6000);
    });
    sub('snip:region', (rect) => { window.__recRegion = rect; });
    sub('tray:err', (msg) => toast(msg, 'warn'));

    /* 标题栏搜索：结果行复用 searchResultRow()，与首页结果列表同一套渲染 */
    let hlIndex = -1;
    function doSearch() {
      const q = searchInput.value;
      const results = R.search(q);
      searchDrop.innerHTML = '';
      hlIndex = -1;
      if (!q.trim() || !results.length) { searchDrop.classList.remove('show'); return; }
      const shown = results.slice(0, 10);
      shown.forEach((t, i) => {
        const item = searchResultRow(t, q);
        item.addEventListener('click', () => { openTool(t.id); hideSearch(); });
        item.dataset.idx = i;
        searchDrop.appendChild(item);
      });
      if (results.length > shown.length) {
        searchDrop.appendChild(div('sr-more', T('search.more', { n: results.length - shown.length })));
      }
      searchDrop.classList.add('show');
    }
    function hideSearch() { searchDrop.classList.remove('show'); searchInput.blur(); }
    searchInput.addEventListener('input', window.ui.debounce(doSearch, 120));
    searchInput.addEventListener('focus', doSearch);
    searchInput.addEventListener('keydown', (e) => {
      const items = [...searchDrop.querySelectorAll('.search-result')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        hlIndex = (hlIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('hl', i === hlIndex));
        items[hlIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        const target = items[hlIndex] || items[0];
        if (target) target.click();
      } else if (e.key === 'Escape') hideSearch();
    });
    const onDocClick = (e) => { if (!searchDrop.contains(e.target) && e.target !== searchInput) searchDrop.classList.remove('show'); };
    const onDocKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focusSearch();
      }
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKey);
    /* 这两个是 document 级监听，整壳重建时旧的不退掉就会累积：
     * 切一次语言多一份 Ctrl+K 处理、多一份点空白关闭搜索。
     * 把退订函数交给 applyLangLabels，重建前统一调用。
     * 同时把上面那 9 个 IPC 订阅的退订函数也一并收口 —— 它们同样是
     * 「重建一次就多一份」的类型（见 shellUnsubs 的注释）。 */
    shellCleanup = () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKey);
      for (const u of shellUnsubs.splice(0)) { try { u(); } catch (e) {} }
    };
  }

  /* ============ 路由与渲染 ============ */
  function showView(view) {
    state.view = view;
    render();
  }
  function openTool(toolId) {
    const t = R.get(toolId);
    if (!t) return;
    if (!state.tabs.includes(toolId)) state.tabs.push(toolId);
    pushRecent(toolId);
    showView({ type: 'tool', toolId });
  }
  function closeTab(toolId) {
    const idx = state.tabs.indexOf(toolId);
    state.tabs = state.tabs.filter(x => x !== toolId);
    if (state.view.type === 'tool' && state.view.toolId === toolId) {
      const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
      showView(next ? { type: 'tool', toolId: next } : { type: 'home' });
    } else renderTabs();
  }

  function render() {
    renderNav(); renderBreadcrumb(); renderTabs(); renderContent();
    // 首页已经有自己那个大搜索框了。标题栏再摆一个同样的输入框，
    // 页面上就有两个搜索：用户会不知道该往哪个里打字，Ctrl+K 的焦点也会打架。
    // 所以首页收起标题栏搜索，离开首页再显示。
    if (searchWrapEl) searchWrapEl.classList.toggle('hidden', state.view.type === 'home');
  }
  // 刷新：先同步高危能力状态，再重绘，保证卡片红/灰与实际开关一致
  async function refresh() {
    await loadDangerousState();
    render();
  }
  function renderNav() {
    const items = sidebarEl.querySelectorAll('.nav-item');
    items.forEach(el => el.classList.remove('active'));
    let sel = null;
    const v = state.view;
    if (v.type === 'home') sel = 'home';
    else if (v.type === 'fav') sel = 'fav';
    else if (v.type === 'settings') sel = 'settings';
    // 「关于」并进了设置页，导航高亮跟着落到「设置」上，
    // 否则用户从收藏/工具页跳进来会看到没有任何一项高亮。
    else if (v.type === 'about') sel = 'settings';
    else if (v.type === 'module') sel = 'module:' + v.moduleId;
    else if (v.type === 'tool') { const t = R.get(v.toolId); sel = t ? 'module:' + t.module : 'home'; }
    const el = sidebarEl.querySelector(`[data-nav="${sel}"]`);
    if (el) el.classList.add('active');
  }
  function renderBreadcrumb() {
    breadcrumbEl.innerHTML = '';
    const home = h('span', { style: { cursor: 'pointer' }, onclick: () => showView({ type: 'home' }) }, T('nav.home'));
    breadcrumbEl.appendChild(home);
    const v = state.view;
    const add = (text, cls, onclick) => {
      breadcrumbEl.appendChild(h('span', { class: 'bc-sep' }, '/'));
      breadcrumbEl.appendChild(h('span', { class: cls, style: onclick ? { cursor: 'pointer' } : null, onclick }, text));
    };
    if (v.type === 'module') { const m = R.MODULES.find(x => x.id === v.moduleId); add(m ? MN(m) : '', 'bc-current'); }
    else if (v.type === 'tool') {
      const t = R.get(v.toolId); const m = t && R.MODULES.find(x => x.id === t.module);
      add(m ? MN(m) : '', '', () => m && showView({ type: 'module', moduleId: m.id }));
      add(t ? t.name : '', 'bc-current');
    }
    else if (v.type === 'fav') add(T('nav.favorites'), 'bc-current');
    else if (v.type === 'settings') add(T('settings.title'), 'bc-current');
    // 兼容旧的路由值：'about' 已并入设置，面包屑跟着显示「设置 / 关于」
    else if (v.type === 'about') { add(T('settings.title'), '', () => showView({ type: 'settings' })); add(T('settings.about'), 'bc-current'); }
    else if (v.type !== 'home') add('', 'bc-current');
  }
  function renderTabs() {
    tabbarEl.innerHTML = '';
    if (!state.tabs.length) return;
    for (const id of state.tabs) {
      const t = R.get(id);
      if (!t) continue;
      const tab = div('tab' + (state.view.type === 'tool' && state.view.toolId === id ? ' active' : ''));
      tab.appendChild(icon(t.icon));
      tab.appendChild(h('span', null, t.name));
      const c = h('span', { class: 'tab-close' }, icon('x'));
      c.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
      tab.appendChild(c);
      tab.addEventListener('click', () => showView({ type: 'tool', toolId: id }));
      // 鼠标中键关闭标签页
      tab.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeTab(id); }
      });
      tabbarEl.appendChild(tab);
    }
  }
  /* 页面级清理：切换页面时清理上一个工具页注册的定时器/监听，防止资源泄漏 */
  let pageCleanupFns = [];
  /* 注册页面卸载清理函数。
   * 【幂等保护】同一个函数重复注册会被去重：某些流程（如「检查更新」失败后重试）
   * 可能在同一次页面生命周期里多次调用，不去重就会重复执行清理。 */
  function onCleanup(fn) {
    if (typeof fn !== 'function') return;
    if (pageCleanupFns.indexOf(fn) === -1) pageCleanupFns.push(fn);
  }
  function runPageCleanup() {
    pageCleanupFns.forEach(f => { try { f(); } catch (e) { console.warn('cleanup', e); } });
    pageCleanupFns = [];
  }
  /* 首帧入场：只在**整个进程的第一次**渲染时播放一次。
     每次切页面都重放会显得多余（用户点了下菜单，内容自己又淡入一遍），
     所以用模块级标记而不是列在 class 上就完事。 */
  let firstPaintDone = false;
  function renderContent() {
    runPageCleanup();
    contentEl.innerHTML = '';
    contentEl.scrollTop = 0;
    const page = div('page');
    if (!firstPaintDone) page.classList.add('page-enter');
    firstPaintDone = true;
    const v = state.view;
    try {
      if (v.type === 'home') renderHome(page);
      else if (v.type === 'fav') renderFavPage(page);
      else if (v.type === 'module') renderModulePage(page, v.moduleId);
      else if (v.type === 'tool') renderToolPage(page, v.toolId);
      else if (v.type === 'settings') renderSettings(page);
      // 旧的 'about' 路由仍可用（托盘/外部调起可能还带着它），统一转到设置的关于分区，
      // 保证任何时候都只有一个「关于」界面存在。
      else if (v.type === 'about') { settingsSection = 'about'; renderSettings(page); }
    } catch (e) {
      // 兜底：任一页面渲染异常都不能让内容区白屏，至少给出可读错误和返回入口
      console.error('页面渲染失败', v, e);
      page.innerHTML = '';
      page.appendChild(div('tool-header', div('th-icon', iconLg('alert')), div('', h('h2', null, T('tool.loadFail')), h('div', { class: 'th-desc' }, String(e && e.message || e)))));
      const back = btn(T('tool.backHome'), 'btn-secondary', () => showView({ type: 'home' }));
      page.appendChild(div('card', div('', back)));
    }
    contentEl.appendChild(page);
  }

  /* ============ 首页 ============ */
  function toolCard(t, { showStar = true } = {}) {
    const danger = isDangerTool(t.id);
    const dangerOn = isDangerEnabled(t.id);
    const card = div('tool-card' + (danger ? ' danger' : '') + (danger && !dangerOn ? ' closed' : ''));
    card.appendChild(div('tc-icon', iconLg(t.icon)));
    const info = div('');
    info.appendChild(div('tc-name', t.name));
    info.appendChild(div('tc-desc', t.desc || ''));
    // 高危标记：已开启显示「高危」，未开启显示「未启用」并加锁，提示需去设置里开启
    if (danger) {
      info.appendChild(div('tc-danger-tag', dangerOn ? '⚠ 高危' : '🔒 未启用'));
    }
    card.appendChild(info);
    if (danger && !dangerOn) {
      const lock = div('tc-lock', icon('lock'));
      card.appendChild(lock);
    } else if (showStar) {
      const on = state.favorites.includes(t.id);
      const star = div('tc-star' + (on ? ' on' : ''), icon('star'));
      star.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(t.id); });
      card.appendChild(star);
    }
    card.addEventListener('click', () => openTool(t.id));
    return card;
  }
  function renderHome(page) {
    /* 首页布局：搜索是主入口，模块卡片退居其后。
     *
     * 之前是「大标题 + 10 个分类卡片」，搜索框只在标题栏里占 440px。
     * 但 93 个工具摊在 10 个分类下，用户记住模块归属的成本远高于直接打两个字，
     * 实际路径是「搜索 → 直达」。所以把搜索提到视觉第一层，
     * 分类卡片保留（浏览/发现仍然需要它），但降为次要区块。
     */
    const hero = div('home-hero');
    const heroTop = div('home-hero-top');
    heroTop.appendChild(h('h1', null, T('app.name')));
    heroTop.appendChild(h('p', null, T('app.tagline', { n: (R.all ? R.all.length : 0) })));
    hero.appendChild(heroTop);

    const hs = div('home-search');
    hs.setAttribute('role', 'search');
    const inp = h('input', {
      class: 'hs-input',
      type: 'search',
      placeholder: T('search.placeholder'),
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': T('search.aria'),
      'aria-describedby': 'hs-hint'
    });
    hs.appendChild(h('span', { class: 'hs-icon' }, icon('search', 'icon-lg')));
    hs.appendChild(inp);
    hs.appendChild(h('span', { class: 'hs-kbd', id: 'hs-hint' }, 'Ctrl K'));
    hero.appendChild(hs);

    // 搜索结果区：有输入时占据整页（分类卡片让位），无输入时隐藏
    const results = div('home-results');
    hero.appendChild(results);
    page.appendChild(hero);

    const browse = div('home-browse');

    let hlIndex = -1;
    let current = [];
    /* 见 setHl 的注释：列表刚渲染时浏览器可能补发一次 mouseenter，
     * 那不是用户在移动鼠标。只有真的观察到 mousemove 之后，
     * 才认为后续的 mouseenter 是用户的意图。 */
    let pointerMoved = false;
    /* 保存「那个还没触发的 once 监听器」，重挂之前先摘掉旧的。
     *
     * 两处 addEventListener('mousemove', ..., { once:true }) 原来都是裸挂：
     * once 只保证命中后自动摘除，**没命中就一直挂着**。
     * 用户只打字不碰鼠标时，每次 renderResults 都会再挂一个，
     * 直到下次移动鼠标才一起触发、一起摘除。连打 50 个字符＝50 个监听器，
     * 触发时 50 次 markPointerMoved（结果没错，但多余的开销和解绑时机都不对）。
     * 现在任意时刻最多只留一个：挂之前先移除上一次没触发的那个。
     * 复用原来的 markPointerMoved 作为回调，只是多清一下自己的句柄。 */
    let pointerMovedListener = null;
    const markPointerMoved = () => { pointerMoved = true; pointerMovedListener = null; };
    function armPointerMoved() {
      if (pointerMovedListener) {
        window.removeEventListener('mousemove', pointerMovedListener);
      }
      pointerMovedListener = markPointerMoved;
      window.addEventListener('mousemove', markPointerMoved, { once: true, passive: true });
    }
    armPointerMoved();

    function renderResults() {
      const q = inp.value;
      results.innerHTML = '';
      hlIndex = -1;
      /* 列表重建：之前的 mouseenter 记录已经失效。
       * 重新开始计「指针是否动过」，这样新列表不会带着旧列表的鼠标状态。 */
      pointerMoved = false;
      armPointerMoved();
      current = q.trim() ? R.search(q) : [];
      if (!q.trim()) {
        results.classList.remove('show');
        browse.classList.remove('hidden');
        return;
      }
      results.classList.add('show');
      browse.classList.add('hidden');

      if (!current.length) {
        results.appendChild(div('hs-empty',
          h('span', { class: 'hs-empty-icon' }, iconLg('search')),
          div('',
            div('hs-empty-title', T('search.empty', { q: q.trim() })),
            div('hs-empty-tip', T('search.emptyTip')))));
        return;
      }
      const head = div('hs-head',
        h('span', null, T('search.results', { n: current.length })),
        h('span', { class: 'hs-head-tip' }, T('search.hint')));
      results.appendChild(head);
      current.forEach((t, i) => {
        const row = searchResultRow(t, q);
        row.classList.add('hs-row');
        row.addEventListener('click', () => openTool(t.id));
        /* 用 mouseenter 而不是 mousemove：mousemove 是像素级触发，
         * 每移动一像素就执行一次 querySelectorAll + scrollIntoView，
         * 结果多时会明显卡顿，还可能把列表抖得来回滚。
         * mouseenter 只在真正进入新行时触发一次。
         *
         * 但 mouseenter 有个坑：列表刚渲染出来时，如果光标恰好停在某一行上，
         * 浏览器也会派发一次 mouseenter（不是用户移动造成的）。那会把高亮
         * 预置到光标所在行，用户随后按 ↓ 就从他没选过的行开始跳。
         * 所以只在「指针确实动过」之后才让鼠标决定高亮。 */
        row.addEventListener('mouseenter', () => { if (pointerMoved) setHl(i, true); });
        results.appendChild(row);
      });
    }
    function setHl(i, fromMouse) {
      /* 鼠标进入某行时，如果已经有用键盘选中的行，就不要抢焦点：
       * 用户用 ↓ 选到第 5 行、鼠标恰好划过第 1 行，高亮会跳回去，
       * 再按 ↓ 又从第 1 行开始 —— 键盘与鼠标互相打架。
       * 索引没变也不必重做（省掉 querySelectorAll + scrollIntoView）。 */
      if (fromMouse && hlIndex >= 0) return;
      if (i === hlIndex && results.querySelectorAll('.hs-row.hl').length === 1) return;
      const rows = [...results.querySelectorAll('.hs-row')];
      hlIndex = i;
      rows.forEach((el, k) => el.classList.toggle('hl', k === i));
      if (rows[i]) rows[i].scrollIntoView({ block: 'nearest' });
    }
    function clearSearch() {
      inp.value = '';
      renderResults();
      inp.focus();
    }

    inp.addEventListener('input', window.ui.debounce(renderResults, 90));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!current.length) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setHl((hlIndex + step + current.length) % current.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const t = current[hlIndex >= 0 ? hlIndex : 0];
        if (t) openTool(t.id);
      } else if (e.key === 'Escape') {
        if (inp.value) { e.preventDefault(); clearSearch(); }
        else inp.blur();
      }
    });

    /* ---- 浏览区（无搜索时显示）：最近使用 + 分类 ---- */
    const recents = state.recents.map(id => R.get(id)).filter(Boolean);
    if (recents.length) {
      const card = div('card home-recent');
      card.appendChild(div('card-title', icon('clock'), T('home.recent')));
      card.appendChild(div('recent-row', ...recents.map(t => {
        const chip = div('recent-chip', icon(t.icon), h('span', null, t.name));
        chip.addEventListener('click', () => openTool(t.id));
        return chip;
      })));
      browse.appendChild(card);
    }

    // 分类卡片：保留，但改成紧凑条 —— 每行四列、只显示名称与数量，
    // 说明文字进 title，把纵向空间让给搜索。
    const sec = div('card');
    sec.appendChild(div('card-title', icon('grid'), T('home.categories')));
    sec.appendChild(div('home-cats', ...R.MODULES.map(m => {
      const count = R.byModule(m.id).length;
      const c = div('home-cat');
      c.title = m.desc || '';
      c.appendChild(h('span', { class: 'hc-icon' }, iconLg(m.icon)));
      c.appendChild(h('span', { class: 'hc-name' }, MN(m)));
      c.appendChild(h('span', { class: 'hc-count' }, String(count)));
      c.addEventListener('click', () => showView({ type: 'module', moduleId: m.id }));
      return c;
    })));
    browse.appendChild(sec);
    page.appendChild(browse);

    renderResults();
  }
  function renderFavPage(page) {
    page.appendChild(div('tool-header', div('th-icon', iconLg('star')), div('', h('h2', null, T('nav.favorites')), h('div', { class: 'th-desc' }, T('fav.desc')), )));
    const favs = state.favorites.map(id => R.get(id)).filter(Boolean);
    const card = div('card');
    if (favs.length) card.appendChild(div('tool-grid', ...favs.map(t => toolCard(t))));
    else card.appendChild(div('empty-tip', T('fav.empty')));
    page.appendChild(card);
  }
  function renderModulePage(page, moduleId) {
    const m = R.MODULES.find(x => x.id === moduleId);
    if (!m) return;
    page.appendChild(div('tool-header', div('th-icon', iconLg(m.icon)),
      div('', h('h2', null, MN(m)), h('div', { class: 'th-desc' }, m.desc))));
    const card = div('card');
    card.appendChild(div('tool-grid', ...R.byModule(moduleId).map(t => toolCard(t))));
    page.appendChild(card);
  }
  function renderToolPage(page, toolId) {
    const t = R.get(toolId);
    if (!t) { page.appendChild(div('empty-tip', T('tool.notFound'))); return; }
    const head = div('tool-header');
    head.appendChild(div('th-icon', iconLg(t.icon)));
    const info = div('');
    info.appendChild(h('h2', null, t.name));
    info.appendChild(h('div', { class: 'th-desc' }, t.desc || ''));
    head.appendChild(info);
    const starred = state.favorites.includes(toolId);
    const starBtn = btn(starred ? T('tool.favorited') : T('tool.favorite'), 'btn-secondary btn-sm th-star', () => toggleFavorite(toolId), 'star');
    head.appendChild(starBtn);
    page.appendChild(head);
    // 高危工具未启用时的处理。
    // 【不能整页锁死】local-notes / clipboard-history 只在「删除」时需要 file-delete，
    // 记笔记、看剪贴板历史本身是无害的读操作。原来这里一律换成说明卡，
    // 用户点进来看到「该工具默认未启用」，会直接以为功能坏了。
    // 现在：只有「整个工具的所有能力都是高危」才锁页；否则照常渲染，
    // 交由各操作自己在触发时弹门禁提示（IPC 层本来就有操作级门禁，双层覆盖）。
    if (isDangerTool(toolId) && !isDangerEnabled(toolId) && requiresWholeToolLock(toolId)) {
      page.appendChild(dangerLockedCard(toolId, t.name));
      return;
    }
    // 部分高危：渲染功能本体，但在页面顶部放一条提示，说明哪些操作需要开启
    if (isDangerTool(toolId) && !isDangerEnabled(toolId)) {
      page.appendChild(dangerNoticeCard(t.id));
    }
    try {
      t.render(page, { App: window.App, ui: window.ui, api: window.api });
    } catch (e) {
      console.error('工具渲染失败', toolId, e);
      page.appendChild(window.ui.placeholder('alert', T('tool.renderFail'), e.message));
    }
  }
  // 高危工具未启用时的占位卡
  function dangerLockedCard(toolId, toolName) {
    const card = div('card danger-locked');
    card.appendChild(div('danger-locked-title', icon('lock'), T('settings.notice.wholeToolLocked')));
    card.appendChild(div('danger-locked-text',
      T('settings.notice.wholeToolLockedText', { name: toolName })));
    card.appendChild(div('form-row', btn(T('settings.notice.goDanger'), 'btn-danger', () => showView({ type: 'settings' }))));
    return card;
  }
  /* 只有「删文件」这一项高危能力的工具（记事本、剪贴板历史）：
   * 浏览/编辑是安全的，锁整页会让用户以为功能坏了，所以只提示不封锁。 */
  const DELETE_ONLY_TOOLS = new Set(['local-notes', 'clipboard-history']);
  function requiresWholeToolLock(toolId) { return !DELETE_ONLY_TOOLS.has(toolId); }
  function dangerNoticeCard(toolId) {
    const card = div('card');
    card.style.border = '1px solid var(--warning)';
    card.style.background = 'color-mix(in srgb, var(--warning) 8%, transparent)';
    card.appendChild(div('', { style: { fontWeight: 600, marginBottom: '4px' } },
      T('settings.notice.deleteOnly')));
    card.appendChild(div('field-hint',
      T('settings.notice.deleteOnlyText')));
    card.appendChild(div('form-row', btn(T('settings.notice.goDanger'), 'btn-sm btn-secondary', () => showView({ type: 'settings' }))));
    return card;
  }

  /* ============ 设置 ============ */
  let drawToken = 0; // 模块级：drawBody 与闭包外的 drawGeneral/drawAppearance/drawData 共享
  // 当前设置分区必须是模块级状态：高危开关保存后会调 refresh() 全量重绘，
  // 若 current 只是 renderSettings 的局部变量，重绘时会被重置回「通用」，
  // 用户刚点的开关所在面板直接被换掉（连点多项就得每次重新点回分区）。
  let settingsSection = 'general';
  function renderSettings(page) {
    page.appendChild(div('tool-header', div('th-icon', iconLg('settings')), div('', h('h2', null, T('settings.title')), h('div', { class: 'th-desc' }, T('settings.subtitle')))));
    const wrap = div('settings-wrap');
    const nav = div('settings-nav');
    const body = div('settings-body');
    const sections = [
      { id: 'general', name: T('settings.general'), icon: 'settings' },
      { id: 'appearance', name: T('settings.appearance'), icon: 'sun' },
      { id: 'danger', name: T('settings.danger'), icon: 'alert' },
      { id: 'data', name: T('settings.data'), icon: 'shield' },
      { id: 'about', name: T('settings.about'), icon: 'info' }
    ];
    let current = sections.some(s => s.id === settingsSection) ? settingsSection : 'general';
    function drawBody() {
      const token = ++drawToken;
      body.innerHTML = '';
      nav.querySelectorAll('.settings-nav-item').forEach(el => el.classList.toggle('active', el.dataset.sid === current));
      if (current === 'general') drawGeneral(body, token);
      else if (current === 'appearance') drawAppearance(body, token);
      else if (current === 'danger') drawDanger(body, token);
      else if (current === 'about') drawAbout(body, token);
      else drawData(body, token);
    }
    for (const s of sections) {
      const item = div('settings-nav-item', icon(s.icon), ' ' + s.name);
      item.dataset.sid = s.id;
      item.addEventListener('click', () => { current = s.id; settingsSection = s.id; drawBody(); });
      nav.appendChild(item);
    }
    wrap.appendChild(nav); wrap.appendChild(body);
    page.appendChild(wrap);
    drawBody();
  }
  async function drawGeneral(body, token) {
    /* ---- 语言选择放在最上面：它是「整个界面长什么样」的开关，
         比开机自启、托盘这些具体行为更高一层，用户找它时预期在第一屏 ---- */
    const langRow = div('set-row', div('',
      div('set-label', T('settings.language')),
      div('set-desc', T('settings.languageDesc'))));
    const langSel = h('select', { class: 'select input-sm' },
      h('option', { value: 'zh' }, '简体中文'),
      h('option', { value: 'en' }, 'English'));
    let curLang = 'zh';
    try { curLang = (await invoke('store:get', 'settings.lang', null)) || (window.i18n ? window.i18n.detect() : 'zh'); }
    catch (e) { curLang = 'zh'; }
    langSel.value = window.i18n && window.i18n.normalize(curLang) ? curLang : 'zh';
    langSel.addEventListener('change', async () => {
      const v = langSel.value;
      try { await invoke('store:set', 'settings.lang', v); } catch (e) {}
      applyLang(v);
      /* toast 必须在 applyLangLabels() **之后**发：
       * 重建会换掉整个 body，先发的那条会挂在已被丢弃的容器上，用户看不到。
       * 文案按「切到哪个语言」来定，而不是按切换后的 lang —— 用户需要读懂
       * 「刚刚发生了什么」，用他原来的语言更自然。 */
      settingsSection = 'general';
      applyLangLabels();
      toast(T('settings.langSwitched.' + (v === 'en' ? 'en' : 'zh')), 'success', 1600);
    });
    langRow.appendChild(div('set-control', langSel));
    if (token !== undefined && token !== drawToken) return;
    body.appendChild(langRow);

    const row1 = div('set-row', div('', div('set-label', T('settings.autostart')), div('set-desc', T('settings.autostartDesc'))));
    try {
      const enabled = await invoke('app:get-autostart');
      const sw = switchEl(enabled, async (v) => { try { await invoke('app:set-autostart', v); toast(v ? T('settings.autostartOn') : T('settings.autostartOff'), 'success'); } catch (e) { toast(e.message, 'error'); sw.set(!v); } });
      row1.appendChild(div('set-control', sw));
    } catch (e) { row1.appendChild(div('set-control', h('span', { class: 'field-hint' }, T('settings.browserNA')))); }

    // 后两项的 await 也要各自兜底：任一 IPC 拒绝都会让整个「通用」面板空白，
    // 而且是以 unhandled rejection 形式静默失败。失败时降级成一行提示即可。
    let closeToTray = true;
    try { closeToTray = await invoke('store:get', 'settings.closeToTray', true); } catch (e) { console.error('读取托盘设置失败', e); }
    const row2 = div('set-row', div('', div('set-label', T('settings.tray')), div('set-desc', T('settings.trayDesc'))));
    row2.appendChild(div('set-control', switchEl(closeToTray, (v) => invoke('store:set', 'settings.closeToTray', v).catch((e) => toast(e.message, 'error')))));

    const row3 = div('set-row', div('', div('set-label', T('settings.hotkey')), div('set-desc', T('settings.hotkeyDesc'))));
    let hotkey = 'Alt+Shift+H';
    try { hotkey = await invoke('store:get', 'settings.hotkey', 'Alt+Shift+H'); } catch (e) { console.error('读取热键设置失败', e); }
    const hkInput = h('input', { class: 'input input-sm', value: hotkey, style: { width: '140px', textAlign: 'center' } });
    const hkBtn = btn(T('settings.apply'), 'btn-sm btn-primary', async () => {
      const v = hkInput.value.trim();
      try {
        const ok = await invoke('app:set-hotkey', v);
        if (ok) { await invoke('store:set', 'settings.hotkey', v); toast(T('settings.hotkeyOk'), 'success'); }
        else toast(T('settings.hotkeyFail'), 'error');
      } catch (e) { toast(e.message, 'error'); }
    });
    row3.appendChild(div('set-control', hkInput, ' ', hkBtn));

    if (token !== undefined && token !== drawToken) return; // 分区已切换，丢弃过期绘制
    body.appendChild(row1); body.appendChild(row2); body.appendChild(row3);
  }
  function drawAppearance(body) {
    /* ---- 第一块：明暗模式 ---- */
    const row = div('set-row', div('', div('set-label', T('settings.mode')), div('set-desc', T('settings.appearanceDesc'))));
    body.appendChild(row);

    /* Win11 风格主题卡片：迷你预览 + 点击即切换。
       预览色值全部走 CSS 变量（见下方 MODE_VARS），不再写死十六进制。 */
    const grid = div('theme-cards');
    const MODES = [
      { id: 'light', name: T('settings.mode.light') },
      { id: 'dark', name: T('settings.mode.dark') },
      { id: 'system', name: T('settings.mode.system') }
    ];
    let currentMode = null;
    const cards = [];
    /* 预览用 CSS 变量而不是写死色值：这样预览会跟着当前配色主题走，
       否则选了鎏金/樱粉，明暗预览里还是极地白的灰底，看着自相矛盾。 */
    const MODE_VARS = {
      light: { page: 'var(--l-page-bg)', card: 'var(--l-card-bg)', line: 'var(--l-border)', primary: 'var(--l-primary)' },
      dark: { page: 'var(--d-page-bg)', card: 'var(--d-card-bg)', line: 'var(--d-border)', primary: 'var(--d-primary)' }
    };
    function preview(m) {
      const pv = div('theme-preview');
      const isSystem = m.id === 'system';
      // 跟随系统：左浅右深拼接
      pv.style.background = isSystem
        ? 'linear-gradient(115deg, var(--l-page-bg) 49.5%, var(--d-page-bg) 50.5%)'
        : MODE_VARS[m.id].page;
      const v = MODE_VARS[isSystem ? 'light' : m.id];
      const v2 = MODE_VARS[isSystem ? 'dark' : m.id];
      const bar = div('tp-titlebar');
      bar.style.background = isSystem
        ? 'linear-gradient(115deg, var(--l-card-bg) 49.5%, var(--d-card-bg) 50.5%)'
        : v.card;
      const bodyEl = div('tp-body');
      const side = div('tp-side');
      side.style.background = isSystem
        ? 'linear-gradient(115deg, var(--l-card-bg) 49.5%, var(--d-card-bg) 50.5%)'
        : v.card;
      const content = div('tp-content');
      for (let i = 0; i < 3; i++) {
        const line = div('tp-line');
        if (i === 0) {
          // 第一根用主题主色，让预览体现当前配色
          line.style.background = isSystem
            ? 'linear-gradient(115deg, var(--l-primary) 49.5%, var(--d-primary) 50.5%)'
            : v.primary;
          line.style.height = '16px'; line.style.borderRadius = '4px'; line.style.width = '70%';
        } else {
          line.style.background = i === 1 ? v.line : v2.line;
        }
        content.appendChild(line);
      }
      bodyEl.appendChild(side); bodyEl.appendChild(content);
      pv.appendChild(bar); pv.appendChild(bodyEl);
      const check = div('tc-check', icon('check'));
      check.style.position = 'absolute';
      pv.style.position = 'relative';
      pv.appendChild(check);
      return pv;
    }
    function refreshSelected() {
      cards.forEach(c => c.el.classList.toggle('selected', c.mode === currentMode));
    }
    for (const m of MODES) {
      const card = div('theme-card');
      card.appendChild(preview(m));
      card.appendChild(div('tc-name2', MN(m) + (m.id === 'system' ? T('settings.mode.auto') : '')));
      card.addEventListener('click', async (e) => {
        const rect = card.getBoundingClientRect();
        await changeTheme(m.id, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        currentMode = m.id;
        refreshSelected();
      });
      cards.push({ el: card, mode: m.id });
      grid.appendChild(card);
    }
    invoke('store:get', 'settings.theme', 'system').then(m => { currentMode = m || 'system'; refreshSelected(); });
    // 主题卡片放在标题下方独立区域
    row.style.display = 'block';
    row.appendChild(grid);

    /* ---- 第二块：配色主题 ---- */
    const row2 = div('set-row', div('', div('set-label', T('settings.accent')), div('set-desc', T('settings.accentDesc'))));
    body.appendChild(row2);

    const accentGrid = div('accent-grid');
    const accentSwatches = [];
    function refreshAccent() {
      accentSwatches.forEach(sw => sw.el.classList.toggle('selected', sw.id === currentAccent));
    }
    for (const a of ACCENTS) {
      const card = div('accent-card');
      card.dataset.accent = a.id; // 预览块用 data-accent 取到该套主题的 CSS 变量
      const sw = div('accent-swatches');
      // 上下两个色点分别取该主题的浅色主色与深色主色
      const lightDot = div('accent-dot light');
      const darkDot = div('accent-dot dark');
      sw.appendChild(lightDot); sw.appendChild(darkDot);
      card.appendChild(sw);
      card.appendChild(div('tc-name2', a.name));
      card.appendChild(div('accent-desc', a.desc));
      card.addEventListener('click', async () => {
        try {
          await invoke('store:set', 'settings.accent', a.id);
        } catch (e) { /* browser mode */ }
        setAccent(a.id);
        refreshAccent();
        toast(T('settings.accentOk', { name: a.name }), 'success', 1200);
      });
      accentSwatches.push({ el: card, id: a.id });
      accentGrid.appendChild(card);
    }
    refreshAccent();
    row2.style.display = 'block';
    row2.appendChild(accentGrid);
    // 侧边栏收起已由侧栏底部按钮提供，此处不再重复放开关
  }
  /* 高危功能：默认全部关闭，逐项开启。开启任一项都会二次确认。 */
  async function drawDanger(body, token) {
    const banner = div('danger-banner');
    banner.appendChild(div('danger-banner-title', icon('alert'), T('danger.disabled')));
    banner.appendChild(div('danger-banner-text', T('danger.text')));
    body.appendChild(banner);

    let info;
    try { info = await invoke('dangerous:list'); }
    catch (e) {
      body.appendChild(div('field-err', T('danger.readFail', { err: e.message })));
      return;
    }
    if (token !== undefined && token !== drawToken) return;

    for (const c of info.caps) {
      const row = div('set-row danger-row');
      const left = div('');
      left.appendChild(div('set-label', c.name));
      left.appendChild(div('set-desc', c.desc));
      row.appendChild(left);
      const sw = switchEl(c.enabled, async (v) => {
        // 开启高危能力必须二次确认，且要复述具体是哪个能力
        if (v) {
          const ok = await confirmBox({
            title: T('danger.enableTitle'),
            message: T('danger.enableMsg', { name: c.name, desc: c.desc }),
            danger: true, okText: T('danger.enableOk')
          });
          if (!ok) { sw.set(false); return; }
        }
        try {
          await invoke('dangerous:set', c.id, v);
          await refresh(); // 重新读取高危状态并重绘，工具卡片的红/灰随之更新
          toast(v ? T('danger.enabled', { name: c.name }) : T('danger.disabledToast', { name: c.name }), v ? 'warn' : 'success');
        } catch (e) { sw.set(!v); toast(e.message, 'error'); }
      });
      row.appendChild(div('set-control', sw));
      body.appendChild(row);
    }

    const tip = div('field-hint', { style: { marginTop: '14px' } }, T('danger.tip'));
    body.appendChild(tip);
  }
  async function drawData(body, token) {
    let userData = T('settings.browserMode');
    if (isDesktop) { try { userData = (await invoke('app:get-info')).userData; } catch (e) {} }
    if (token !== undefined && token !== drawToken) return;
    body.appendChild(div('set-row', div('', div('set-label', T('data.dir')), div('set-desc', T('data.dirDesc')), div('set-desc mono', userData)), div('set-control', btn(T('data.openDir'), 'btn-sm btn-secondary', async () => {
      if (!isDesktop) return toast(T('settings.browserNA'), 'warn');
      try { await invoke('fs:open-path', userData); } catch (e) { toast(e.message, 'error'); }
    }))));
    body.appendChild(div('set-row', div('', div('set-label', T('data.clear')), div('set-desc', T('data.clearDesc'))), div('set-control', btn(T('data.clearBtn'), 'btn-sm btn-danger-plain', async () => {
      if (!(await confirmBox({ title: T('data.clear'), message: T('data.clearConfirm'), danger: true, okText: T('data.clearBtn') }))) return;
      await invoke('store:set', 'recents', []);
      await invoke('store:set', 'clipHistory', []);
      state.recents = [];
      toast(T('data.clearOk'), 'success');
      render();
    }))));
    body.appendChild(div('set-row', div('', div('set-label', T('data.privacy')), div('set-desc', T('data.privacyDesc')))));
  }

  /* ============ 关于（设置页的一个分区，不再是独立页面） ============
     原来「关于」是侧栏一级入口、独占一整页，但内容只有版本号、运行环境三行
     和「检查更新」，一页装这点东西太薄，还多占一个导航位。
     现在作为设置的第五个分区，复用同一套 set-row 排版。
     注意：它仍然是**唯一的版本/更新入口**，别处不要再放检查更新。 */
  async function drawAbout(body, token) {
    let info;
    try { info = await invoke('app:get-info'); }
    catch (e) {
      body.appendChild(div('field-hint', T('settings.readInfoFail', { err: (e && e.message || e) })));
      return;
    }
    if (token !== undefined && token !== drawToken) return;

    /* 本次「检查更新」的退订函数，存在这个页面的闭包里。
     * 之前是每次点击都 window.App.onCleanup(() => unsub…)，而 onCleanup 按
     * 函数引用去重，每次都是新闭包 → 去重必然失效，连点五次就积五个。
     * 改成页面级只登记一个清理：它读的是这段闭包里最新的 updUnsub。 */
    let updUnsub = null;
    const cleanupUpdate = () => {
      if (updUnsub) { try { updUnsub(); } catch (e) {} updUnsub = null; }
    };
    window.App.onCleanup(cleanupUpdate);

    const updLine = h('div', { class: 'field-hint', style: { padding: '8px 4px 0' } }, '');
    const updActions = div('', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', padding: '8px 4px 0' } });
    const checkBtn = btn(T('about.checkUpdate'), 'btn-sm btn-secondary', checkUpdate);

    // 顶部品牌行：图标 + 名称 + 版本号，右侧放「检查更新」
    const head = div('about-head');
    head.appendChild(h('img', { src: 'assets/icon.png', alt: '' }));
    head.appendChild(div('',
      div('about-name', T('about.brand')),
      div('set-desc', (lang === 'en' ? 'HeHe Toolbox' : 'HeHe Toolbox') + ' v' + info.appVersion)));
    // 第二个参数必须是类名字符串：div(cls, ...children) 只认字符串类名，
    // 传 { class: 'x' } 这种对象会被 h() 静默丢掉（h 只处理 {style} 对象），
    // 按钮就贴不到右边了。
    head.appendChild(div('about-head-btn', checkBtn));
    body.appendChild(head);

    body.appendChild(window.ui.kvGrid([
      [T('about.os'), `Electron ${info.electron} · Chromium ${info.chrome}`],
      [T('about.userShort'), info.username + '@' + info.hostname],
      [T('data.dir'), info.userData]
    ]));
    body.appendChild(updLine);
    body.appendChild(updActions);

    // 清理「已经应用过」的旧安装包（刚下载、还没装的新包会被主进程按版本号豁免）
    // 同时回收 exe 旁的历史 .bak：每次升级会留两套备份（.bak + .bak.<时间戳>），
    // 时间戳那套以前从不清理，升几次就在用户目录里堆几份 100MB。
    invoke('update:cleanup').then((r) => {
      if (r && r.removed) console.log('[update] 清理旧安装包', r.removed, '个', (r.bytes / 1048576).toFixed(1) + 'MB', '保留', r.kept || 0, '个');
      if (r && r.bakRemoved) console.log('[update] 回收历史备份', r.bakRemoved, '个', (r.bakBytes / 1048576).toFixed(1) + 'MB');
    }).catch(() => {});

    async function checkUpdate(ev) {
      const trigger = ev && (ev.currentTarget || ev.target);
      if (trigger && trigger.disabled) return;
      if (trigger) trigger.disabled = true;
      updLine.textContent = T('update.checking');
      updActions.innerHTML = '';
      /* 上一次点击可能还挂着订阅（下载未完成时离开页面），先退掉再开新的，
       * 否则连点几次就有几份 job:stream 监听同时更新同一个 updLine。 */
      if (updUnsub) { try { updUnsub(); } catch (e) {} updUnsub = null; }
      let unsub = null;
      try {
        const r = await invoke('update:check', { force: true });
        if (r.throttled) { updLine.textContent = T('update.throttled', { s: r.retryAfter, v: r.latest }); return; }
        if (!r.hasUpdate) { updLine.textContent = T('update.latest', { v: r.current }); return; }
        updLine.textContent = T('update.found', { latest: r.latest, current: r.current });
        if (!r.assetUrl) { updLine.textContent = T('update.manual', { latest: r.latest, url: r.htmlUrl }); return; }
        const out = info.userData + '/update/' + r.assetName;
        // job:stream 是全局通道：TTS/ffmpeg/卸载等任务也会广播 {done:true} 或 {pct}。
        // 不比对 id 就会把别人的退出事件当成下载失败（显示“✗ 下载失败：undefined”），
        // 进度数字也会被别的任务污染。先拿到 dl.id 再比对，拿到之前只缓冲不显示。
        let dlId = null;
        const pendingEvents = [];
        unsub = on('job:stream', (d) => {
          if (!dlId) { pendingEvents.push(d); return; }
          handleStream(d);
        });
        function handleStream(d) {
          if (!d || d.id !== dlId) return;
          try {
            const j = JSON.parse(d.data);
            if (j.pct != null) updLine.textContent = T('update.downloading', { latest: r.latest, pct: (j.pct || 0).toFixed(0), mb: (j.mb || 0).toFixed(1) });
            if (!j.done) return;
            if (unsub) { unsub(); unsub = null; }
            if (!j.ok) { updLine.textContent = T('update.downloadFail', { err: (j.error || '') }); return; }
            updLine.textContent = T('update.downloaded', { v: r.latest, path: out });
            toast(T('update.readyToast'), 'success');
            updActions.appendChild(btn('🚀 ' + T('update.confirmOk'), 'btn-sm btn-primary', async () => {
              if (!(await confirmBox({ title: T('update.confirmTitle'), message: T('update.confirmMsg', { v: r.latest }), okText: T('update.confirmOk') }))) return;
              try {
                const ap = await invoke('update:apply', { newExe: out, expectSha256: r.assetSha256 || null });
                updLine.textContent = T('update.applying');
                if (ap && ap.rollbackScript) updActions.appendChild(div('field-hint', T('update.rollbackScript', { path: ap.rollbackScript })));
              } catch (e) { updLine.textContent = T('update.applyFail', { err: e.message }); }
            }));
            updActions.appendChild(btn(T('update.openDir'), 'btn-sm btn-secondary', () => invoke('fs:show-item', out).catch(() => {})));
          } catch (e) {}
        }
        // 先把这份包登记为“待安装”，update:cleanup 见到它就不会删
        await invoke('update:mark-pending', r.assetName).catch(() => {});
        const dl = await invoke('net:download', { url: r.assetUrl, out });
        if (!dl || !dl.id) {
          if (unsub) { unsub(); unsub = null; }
          updLine.textContent = T('update.startFail');
          return;
        }
        dlId = dl.id;
        // 补发在拿到 id 之前就到达的事件（下载极快时 done 会比返回值更早到）
        const buffered = pendingEvents.splice(0);
        for (const d of buffered) handleStream(d);
      } catch (e) { updLine.textContent = T('update.applyFail', { err: e.message }); }
      finally {
        if (trigger) trigger.disabled = false;
        // 失败路径也要退订，否则监听器会一直挂在这个页面上
        if (!dlId || updLine.textContent.startsWith('✗')) { if (unsub) { unsub(); unsub = null; } }
        updUnsub = unsub;
      }
    }
  }

  /* ============ 状态 ============ */
  function setStatus(text) { statusText.textContent = text; }

  /* ============ 界面语言 ============   * 语言只影响外壳（导航/首页/设置/状态栏等）。工具页正文保持中文，
   * 这一点在设置页有明确说明，不让用户以为「切了英文但工具还是中文」是 bug。
   *
   * 切换后必须整壳重建：导航项、搜索框 placeholder、状态栏、面包屑
   * 都是在 buildShell / render 时一次性写入 DOM 的，不重建就会有旧语言残留。
   * rebuild 而不是局部改，是因为这类文案有几十处，遗漏一两处很难看出来。
   */
  function applyLang(v) {
    lang = (window.i18n && window.i18n.setLang(v)) || 'zh';
    // 同步缓存到 localStorage：下次启动时 DOMContentLoaded 能在**同步阶段**
    // 读到语言，不必等 store:get 的 IPC 往返（那段等待会让英文用户看到
    // 一帧中文界面再翻成英文）。localStorage 是同步 API，正好用在这里。
    try { window.localStorage.setItem('hehe-lang', lang); } catch (e) {}
    // 主进程侧还有托盘菜单与系统通知是自己画的（不跑 js/i18n.js），
    // 通过 IPC 告诉它当前语言，否则英文用户的托盘永远是中文。
    if (isDesktop) invoke('app:set-lang', lang).catch(() => {});
    return lang;
  }
  /* 启动时同步取语言：localStorage → 系统语言。
   * 不能用 store:get，那是异步的，等它回来时首帧已经画成中文了。 */
  function readLangSync() {
    try {
      const cached = window.localStorage.getItem('hehe-lang');
      if (cached) return cached;
    } catch (e) {}
    return window.i18n ? window.i18n.detect() : 'zh';
  }
  function applyLangLabels() {
    // 重建外壳：保留当前视图与标签页状态
    const keepView = state.view;
    const keepTabs = state.tabs.slice();
    // 整壳重建前先收口：把开着的弹窗按「取消」结束（否则它们的 promise
    // 会永远悬着），并丢弃 toast 容器引用让它挂到新 body 上。
    try { if (window.ui && window.ui.resetShellForRebuild) window.ui.resetShellForRebuild(); } catch (e) {}
    // themeListeners 里存的是「取消订阅」函数，重建前先全都退掉，
    // 否则每切一次语言就多一份 settings.theme-changed 监听。
    themeListeners.forEach((unsub) => { try { unsub && unsub(); } catch (e) {} });
    themeListeners = [];
    // buildShell 里挂的 document 级监听必须退掉，否则 Ctrl+K、
    // 点空白关闭搜索每切换一次语言就多一份。
    if (typeof shellCleanup === 'function') { try { shellCleanup(); } catch (e) {} shellCleanup = null; }
    document.body.innerHTML = '';
    buildShell();
    applyTheme();
    state.view = keepView;
    state.tabs = keepTabs;
    render();
  }

  /* ============ 启动 ============ */
  window.App = {
    openTool, showView, toggleFavorite, setStatus, state, refresh, onCleanup,
    applyLang,
    /* 跳到设置页的指定分区（如 'danger' 高危功能）。
     * 供其他工具在「被高危门禁拦住」时给出可点的引导，
     * 而不只是弹一句 toast 让用户自己去猜开关在哪。 */
    openSettings(section) {
      if (typeof section === 'string' && section) settingsSection = section;
      showView({ type: 'settings' });
    }
  };
  document.addEventListener('DOMContentLoaded', async () => {
    /* 语言必须在 buildShell 之前定好，否则第一帧是中文、随后整壳重绘成英文，
     * 英文用户每次启动都会看到一次闪。
     *
     * 但 store:get 是**异步 IPC**，等它回来时首帧早就画完了。所以分两步：
     *   1) 同步：从 localStorage 缓存（applyLang 每次都会写）取语言，
     *      立刻建壳 —— 这一步不 await 任何东西，不会有闪；
     *   2) 异步：再问主进程真相。若与缓存不一致（用户换过机器、
     *      清过浏览器数据、或从未切过语言），再纠正一次。
     * 正常情况下第 2 步是一致的，不触发重建。 */
    applyLang(readLangSync());
    buildShell();
    applyTheme();
    await loadUserData();
    await loadDangerousState();
    render();

    let savedLang = null;
    try { savedLang = await invoke('store:get', 'settings.lang', null); } catch (e) {}
    if (savedLang && savedLang !== lang && (window.i18n ? window.i18n.normalize(savedLang) : savedLang)) {
      applyLang(savedLang);
      applyLangLabels();
    }
  });
})();
