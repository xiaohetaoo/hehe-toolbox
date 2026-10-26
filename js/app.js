/* 应用外壳：导航、标签页、搜索、首页、状态栏、设置 */
(function () {
  const { div, icon, iconLg, toast, confirmBox, switchEl, fmtBytes, btn } = window.ui;
  const { invoke, on, isDesktop } = window.api;
  const R = window.Registry;

  const state = {
    favorites: [], recents: [],
    tabs: [],            // 打开的工具 id 列表
    view: { type: 'home' },
    collapsed: false
  };

  /* ============ 主题 ============ */
  let themeListeners = [];
  function applyTheme() {
    invoke('store:get', 'settings.theme', 'system').then(mode => {
      setThemeAttr(mode);
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
      const mode = await invoke('store:get', 'settings.theme', 'system');
      if (mode === 'system') setThemeAttr('system');
    });
    // 主进程 nativeTheme 变化时同步（settings.theme-changed 携带 shouldUseDarkColors）
    themeListeners.push(on('settings.theme-changed', (isDark) => {
      invoke('store:get', 'settings.theme', 'system').then(m => {
        if (m === 'system') setThemeAttr('system');
      });
    }));
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
      starBtn.replaceChildren(icon('star'), on ? '已收藏' : '收藏');
    }
    if (state.view.type === 'fav') render(); // 收藏页需刷新列表
    else renderNav();
  }
  async function pushRecent(toolId) {
    state.recents = [toolId, ...state.recents.filter(x => x !== toolId)].slice(0, 12);
    await invoke('store:set', 'recents', state.recents);
  }

  /* ============ 布局 ============ */
  let sidebarEl, contentEl, tabbarEl, breadcrumbEl, searchInput, searchDrop, statusText, cpuEl, memEl, maxBtn, themeIconEl;

  function buildShell() {
    /* 侧边栏 */
    sidebarEl = div('sidebar');
    const logo = div('logo');
    logo.appendChild(h('img', { src: 'assets/icon.png', alt: '' }));
    logo.appendChild(h('span', { class: 'logo-name' }, '核核工具箱'));
    sidebarEl.appendChild(logo);

    const navScroll = div('nav-scroll');
    const navHome = div('nav-item', icon('home', 'icon-lg'), h('span', null, '首页'));
    navHome.dataset.nav = 'home';
    navScroll.appendChild(navHome);
    navScroll.appendChild(div('nav-section-title', '功能模块'));
    for (const m of R.MODULES) {
      const item = div('nav-item', icon(m.icon, 'icon-lg'), h('span', null, m.name));
      item.dataset.nav = 'module:' + m.id;
      item.title = m.name;
      navScroll.appendChild(item);
    }
    sidebarEl.appendChild(navScroll);

    const bottom = div('nav-bottom');
    const favItem = div('nav-item', icon('star', 'icon-lg'), h('span', null, '我的收藏'));
    favItem.dataset.nav = 'fav';
    const setCItem = div('nav-item', icon('settings', 'icon-lg'), h('span', null, '设置'));
    setCItem.dataset.nav = 'settings';
    const aboutItem = div('nav-item', icon('info', 'icon-lg'), h('span', null, '关于'));
    aboutItem.dataset.nav = 'about';
    const collapseBtn = div('collapse-btn', icon('chev-left'), h('span', null, '收起'));
    collapseBtn.addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      sidebarEl.classList.toggle('collapsed', state.collapsed);
      collapseBtn.innerHTML = ''; collapseBtn.appendChild(icon(state.collapsed ? 'chev-right' : 'chev-left'));
      if (!state.collapsed) collapseBtn.appendChild(h('span', null, '收起'));
    });
    bottom.appendChild(favItem); bottom.appendChild(setCItem); bottom.appendChild(aboutItem); bottom.appendChild(collapseBtn);
    sidebarEl.appendChild(bottom);

    sidebarEl.addEventListener('click', (e) => {
      const item = e.target.closest('.nav-item');
      if (!item || !item.dataset.nav) return;
      const nav = item.dataset.nav;
      if (nav === 'home') showView({ type: 'home' });
      else if (nav === 'fav') showView({ type: 'fav' });
      else if (nav === 'settings') showView({ type: 'settings' });
      else if (nav === 'about') showView({ type: 'about' });
      else if (nav.startsWith('module:')) showView({ type: 'module', moduleId: nav.slice(7) });
    });

    /* 主区域 */
    const main = div('main');
    const titlebar = div('titlebar');
    breadcrumbEl = div('breadcrumb');
    const searchWrap = div('search-wrap');
    searchWrap.appendChild(Object.assign(div('', icon('search', 'icon')), { className: 'search-icon' }));
    searchInput = h('input', { class: 'search-input', placeholder: '搜索工具，Ctrl+K 快速聚焦…' });
    searchDrop = div('search-dropdown');
    searchWrap.appendChild(searchInput); searchWrap.appendChild(searchDrop);
    const tbRight = div('tb-right');
    const themeBtn = h('button', { class: 'tb-btn', title: '切换深浅色' });
    themeIconEl = h('span', { style: { display: 'inline-flex' } });
    themeIconEl.appendChild(icon('moon', 'icon-lg'));
    themeBtn.appendChild(themeIconEl);
    themeBtn.addEventListener('click', async (e) => {
      const cur = document.documentElement.dataset.theme;
      await changeTheme(cur === 'dark' ? 'light' : 'dark', { x: e.clientX, y: e.clientY });
    });
    const minBtn = h('button', { class: 'tb-btn', title: '最小化' }, icon('minus', 'icon-lg'));
    minBtn.addEventListener('click', () => invoke('win:minimize'));
    maxBtn = h('button', { class: 'tb-btn', title: '最大化' }, icon('square', 'icon-lg'));
    maxBtn.addEventListener('click', () => invoke('win:maximize'));
    const closeBtn = h('button', { class: 'tb-btn close', title: '关闭' }, icon('x', 'icon-lg'));
    closeBtn.addEventListener('click', () => invoke('win:close'));
    tbRight.appendChild(themeBtn); tbRight.appendChild(minBtn); tbRight.appendChild(maxBtn); tbRight.appendChild(closeBtn);

    titlebar.appendChild(breadcrumbEl);
    titlebar.appendChild(searchWrap);
    titlebar.appendChild(tbRight);

    tabbarEl = div('tabbar');
    contentEl = div('content');

    const statusbar = div('statusbar');
    statusText = h('span', null, isDesktop ? '就绪' : '浏览器演示模式（部分功能不可用）');
    const sbRight = div('sb-right');
    cpuEl = h('span', { class: 'sb-val' }, 'CPU --%');
    memEl = h('span', { class: 'sb-val' }, '内存 --%');
    sbRight.appendChild(cpuEl); sbRight.appendChild(memEl);
    statusbar.appendChild(statusText); statusbar.appendChild(sbRight);

    main.appendChild(titlebar); main.appendChild(tabbarEl); main.appendChild(contentEl); main.appendChild(statusbar);
    document.body.appendChild(sidebarEl);
    document.body.appendChild(main);

    on('win:maximized', (v) => { maxBtn.innerHTML = ''; maxBtn.appendChild(icon(v ? 'copy' : 'square', 'icon-lg')); });

    /* 状态栏数据 */
    on('sys:stats', (s) => {
      const cpu = s.cpu, mem = s.memPct;
      cpuEl.textContent = `CPU ${cpu.toFixed(0)}%`;
      memEl.textContent = `内存 ${mem.toFixed(0)}%`;
      cpuEl.className = 'sb-val ' + (cpu >= 90 ? 'bad' : cpu >= 70 ? 'warn' : 'ok');
      memEl.className = 'sb-val ' + (mem >= 90 ? 'bad' : mem >= 80 ? 'warn' : 'ok');
    });
    on('hotkey:pressed', () => toast('全局热键已唤起', 'info', 1000));

    /* 主进程事件路由：截图 OCR / 托盘直达工具 / 周期任务触发 / 区域截图结果 / 托盘错误 */
    on('snip:ocr', (filePath) => {
      window.__ocrPendingPath = filePath;
      openTool('screenshot-ocr');
    });
    on('app:open-tool', (id) => { if (R.get(id)) openTool(id); });
    on('sched:fire', (s) => {
      try { new Notification('核核工具箱 · 定时任务', { body: s.message || '任务触发' }); } catch (e) {}
      toast('⏰ ' + (s.message || '周期任务触发'), 'info', 6000);
    });
    on('snip:region', (rect) => { window.__recRegion = rect; });
    on('tray:err', (msg) => toast(msg, 'warn'));

    /* 搜索 */
    let hlIndex = -1;
    function doSearch() {
      const q = searchInput.value;
      const results = R.search(q).slice(0, 12);
      searchDrop.innerHTML = '';
      hlIndex = -1;
      if (!q.trim() || !results.length) { searchDrop.classList.remove('show'); return; }
      for (const t of results) {
        const mod = R.MODULES.find(m => m.id === t.module);
        const item = div('search-result', icon(t.icon), h('span', { class: 'sr-name' }, t.name),
          h('span', { class: 'sr-module' }, mod ? mod.name : ''), h('span', { class: 'sr-desc' }, t.desc || ''));
        item.addEventListener('click', () => { openTool(t.id); hideSearch(); });
        item.dataset.idx = searchDrop.children.length;
        searchDrop.appendChild(item);
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
    document.addEventListener('click', (e) => { if (!searchDrop.contains(e.target) && e.target !== searchInput) searchDrop.classList.remove('show'); });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchInput.focus(); searchInput.select(); }
    });
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
  }
  function renderNav() {
    const items = sidebarEl.querySelectorAll('.nav-item');
    items.forEach(el => el.classList.remove('active'));
    let sel = null;
    const v = state.view;
    if (v.type === 'home') sel = 'home';
    else if (v.type === 'fav') sel = 'fav';
    else if (v.type === 'settings') sel = 'settings';
    else if (v.type === 'about') sel = 'about';
    else if (v.type === 'module') sel = 'module:' + v.moduleId;
    else if (v.type === 'tool') { const t = R.get(v.toolId); sel = t ? 'module:' + t.module : 'home'; }
    const el = sidebarEl.querySelector(`[data-nav="${sel}"]`);
    if (el) el.classList.add('active');
  }
  function renderBreadcrumb() {
    breadcrumbEl.innerHTML = '';
    const home = h('span', { style: { cursor: 'pointer' }, onclick: () => showView({ type: 'home' }) }, '首页');
    breadcrumbEl.appendChild(home);
    const v = state.view;
    const add = (text, cls, onclick) => {
      breadcrumbEl.appendChild(h('span', { class: 'bc-sep' }, '/'));
      breadcrumbEl.appendChild(h('span', { class: cls, style: onclick ? { cursor: 'pointer' } : null, onclick }, text));
    };
    if (v.type === 'module') { const m = R.MODULES.find(x => x.id === v.moduleId); add(m ? m.name : '', 'bc-current'); }
    else if (v.type === 'tool') {
      const t = R.get(v.toolId); const m = t && R.MODULES.find(x => x.id === t.module);
      add(m ? m.name : '', '', () => m && showView({ type: 'module', moduleId: m.id }));
      add(t ? t.name : '', 'bc-current');
    }
    else if (v.type === 'fav') add('我的收藏', 'bc-current');
    else if (v.type === 'settings') add('设置', 'bc-current');
    else if (v.type === 'about') add('关于', 'bc-current');
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
  function onCleanup(fn) { pageCleanupFns.push(fn); }
  function runPageCleanup() {
    pageCleanupFns.forEach(f => { try { f(); } catch (e) { console.warn('cleanup', e); } });
    pageCleanupFns = [];
  }
  function renderContent() {
    runPageCleanup();
    contentEl.innerHTML = '';
    contentEl.scrollTop = 0;
    const page = div('page');
    const v = state.view;
    if (v.type === 'home') renderHome(page);
    else if (v.type === 'fav') renderFavPage(page);
    else if (v.type === 'module') renderModulePage(page, v.moduleId);
    else if (v.type === 'tool') renderToolPage(page, v.toolId);
    else if (v.type === 'settings') renderSettings(page);
    else if (v.type === 'about') renderAbout(page);
    contentEl.appendChild(page);
  }

  /* ============ 首页 ============ */
  function toolCard(t, { showStar = true } = {}) {
    const card = div('tool-card');
    card.appendChild(div('tc-icon', iconLg(t.icon)));
    const info = div('');
    info.appendChild(div('tc-name', t.name));
    info.appendChild(div('tc-desc', t.desc || ''));
    card.appendChild(info);
    if (showStar) {
      const on = state.favorites.includes(t.id);
      const star = div('tc-star' + (on ? ' on' : ''), icon('star'));
      star.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(t.id); });
      card.appendChild(star);
    }
    card.addEventListener('click', () => openTool(t.id));
    return card;
  }
  function renderHome(page) {
    const hero = div('home-hero');
    hero.appendChild(h('h1', null, '核核工具箱'));
    hero.appendChild(h('p', null, '92 个工具，本地运行，不联网也能用'));
    const hs = div('home-search');
    const inp = h('input', { placeholder: '搜索全部工具，回车直达…' });
    const heroIcon = icon('search', 'icon');
    heroIcon.style.cssText = 'position:absolute;left:12px;top:12px;color:var(--text-3)';
    hs.appendChild(heroIcon);
    hs.appendChild(inp);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const r = R.search(inp.value)[0];
        if (r) openTool(r.id); else toast('未找到相关工具', 'warn');
      }
    });
    inp.addEventListener('input', window.ui.debounce(() => {
      const r = R.search(inp.value);
      if (inp.value && r.length === 1) { openTool(r[0].id); inp.value = ''; }
    }, 400));
    hero.appendChild(hs);
    page.appendChild(hero);

    // 最近使用：仅在有记录时显示（新用户不必看一张空卡片占位）
    const recents = state.recents.map(id => R.get(id)).filter(Boolean);
    if (recents.length) {
      const sec2 = div('card');
      sec2.appendChild(div('card-title', icon('clock'), '最近使用'));
      sec2.appendChild(div('recent-row', ...recents.map(t => {
        const chip = div('recent-chip', icon(t.icon), h('span', null, t.name));
        chip.addEventListener('click', () => openTool(t.id));
        return chip;
      })));
      page.appendChild(sec2);
    }

    // 分类卡片只留名称与数量；模块说明在进入该模块后由页头呈现，不在此重复
    const sec3 = div('card');
    sec3.appendChild(div('card-title', icon('grid'), '全部分类'));
    sec3.appendChild(div('tool-grid cols-4', ...R.MODULES.map(m => {
      const count = R.byModule(m.id).length;
      const card = div('tool-card');
      card.appendChild(div('tc-icon', iconLg(m.icon)));
      const info = div('');
      info.appendChild(div('tc-name', m.name));
      info.appendChild(div('tc-desc', `${count} 个工具`));
      card.appendChild(info);
      card.addEventListener('click', () => showView({ type: 'module', moduleId: m.id }));
      return card;
    })));
    page.appendChild(sec3);
  }
  function renderFavPage(page) {
    page.appendChild(div('tool-header', div('th-icon', iconLg('star')), div('', h('h2', null, '我的收藏'), h('div', { class: 'th-desc' }, '高频工具快速访问'), )));
    const favs = state.favorites.map(id => R.get(id)).filter(Boolean);
    const card = div('card');
    if (favs.length) card.appendChild(div('tool-grid', ...favs.map(t => toolCard(t))));
    else card.appendChild(div('empty-tip', '还没有收藏工具，在工具页面点击 ★ 收藏'));
    page.appendChild(card);
  }
  function renderModulePage(page, moduleId) {
    const m = R.MODULES.find(x => x.id === moduleId);
    if (!m) return;
    page.appendChild(div('tool-header', div('th-icon', iconLg(m.icon)),
      div('', h('h2', null, m.name), h('div', { class: 'th-desc' }, m.desc))));
    const card = div('card');
    card.appendChild(div('tool-grid', ...R.byModule(moduleId).map(t => toolCard(t))));
    page.appendChild(card);
  }
  function renderToolPage(page, toolId) {
    const t = R.get(toolId);
    if (!t) { page.appendChild(div('empty-tip', '工具不存在')); return; }
    const head = div('tool-header');
    head.appendChild(div('th-icon', iconLg(t.icon)));
    const info = div('');
    info.appendChild(h('h2', null, t.name));
    info.appendChild(h('div', { class: 'th-desc' }, t.desc || ''));
    head.appendChild(info);
    const starred = state.favorites.includes(toolId);
    const starBtn = btn(starred ? '已收藏' : '收藏', 'btn-secondary btn-sm th-star', () => toggleFavorite(toolId), 'star');
    head.appendChild(starBtn);
    page.appendChild(head);
    try {
      t.render(page, { App: window.App, ui: window.ui, api: window.api });
    } catch (e) {
      console.error('工具渲染失败', toolId, e);
      page.appendChild(window.ui.placeholder('alert', '工具加载失败', e.message));
    }
  }

  /* ============ 设置 ============ */
  let drawToken = 0; // 模块级：drawBody 与闭包外的 drawGeneral/drawAppearance/drawData 共享
  function renderSettings(page) {
    page.appendChild(div('tool-header', div('th-icon', iconLg('settings')), div('', h('h2', null, '设置'), h('div', { class: 'th-desc' }, '个性化你的核核工具箱'))));
    const wrap = div('settings-wrap');
    const nav = div('settings-nav');
    const body = div('settings-body');
    const sections = [
      { id: 'general', name: '通用', icon: 'settings' },
      { id: 'appearance', name: '外观', icon: 'sun' },
      { id: 'data', name: '数据与隐私', icon: 'shield' }
    ];
    let current = 'general';
    function drawBody() {
      const token = ++drawToken;
      body.innerHTML = '';
      nav.querySelectorAll('.settings-nav-item').forEach(el => el.classList.toggle('active', el.dataset.sid === current));
      if (current === 'general') drawGeneral(body, token);
      else if (current === 'appearance') drawAppearance(body, token);
      else drawData(body, token);
    }
    for (const s of sections) {
      const item = div('settings-nav-item', icon(s.icon), ' ' + s.name);
      item.dataset.sid = s.id;
      item.addEventListener('click', () => { current = s.id; drawBody(); });
      nav.appendChild(item);
    }
    wrap.appendChild(nav); wrap.appendChild(body);
    page.appendChild(wrap);
    drawBody();
  }
  async function drawGeneral(body, token) {
    const row1 = div('set-row', div('', div('set-label', '开机自动启动'), div('set-desc', '登录 Windows 后自动运行核核工具箱')));
    try {
      const enabled = await invoke('app:get-autostart');
      const sw = switchEl(enabled, async (v) => { try { await invoke('app:set-autostart', v); toast(v ? '已开启开机自启' : '已关闭开机自启', 'success'); } catch (e) { toast(e.message, 'error'); sw.set(!v); } });
      row1.appendChild(div('set-control', sw));
    } catch (e) { row1.appendChild(div('set-control', h('span', { class: 'field-hint' }, '浏览器模式不可用'))); }

    const closeToTray = await invoke('store:get', 'settings.closeToTray', true);
    const row2 = div('set-row', div('', div('set-label', '关闭时最小化到托盘'), div('set-desc', '点击关闭按钮时隐藏窗口而不是退出')));
    row2.appendChild(div('set-control', switchEl(closeToTray, (v) => invoke('store:set', 'settings.closeToTray', v))));

    const row3 = div('set-row', div('', div('set-label', '全局唤起热键'), div('set-desc', '任意界面一键调出主窗口')));
    const hotkey = await invoke('store:get', 'settings.hotkey', 'Alt+Shift+H');
    const hkInput = h('input', { class: 'input input-sm', value: hotkey, style: { width: '140px', textAlign: 'center' } });
    const hkBtn = btn('应用', 'btn-sm btn-primary', async () => {
      const v = hkInput.value.trim();
      try {
        const ok = await invoke('app:set-hotkey', v);
        if (ok) { await invoke('store:set', 'settings.hotkey', v); toast('热键已生效', 'success'); }
        else toast('热键注册失败，可能被其他程序占用', 'error');
      } catch (e) { toast(e.message, 'error'); }
    });
    row3.appendChild(div('set-control', hkInput, ' ', hkBtn));

    if (token !== undefined && token !== drawToken) return; // 分区已切换，丢弃过期绘制
    body.appendChild(row1); body.appendChild(row2); body.appendChild(row3);
  }
  function drawAppearance(body) {
    const row = div('set-row', div('', div('set-label', '主题模式'), div('set-desc', '选择应用的整体色彩模式，深色模式主色为亮蓝 #4080FF')));
    body.appendChild(row);

    /* Win11 风格主题卡片：迷你预览 + 点击即切换 */
    const grid = div('theme-cards');
    const MODES = [
      { id: 'light', name: '浅色', page: '#F2F3F5', card: '#FFFFFF', line: '#E5E6EB', text: '#1D2129' },
      { id: 'dark', name: '深色', page: '#202020', card: '#2B2B2D', line: '#38383B', text: '#F2F3F5' },
      { id: 'system', name: '跟随系统', page: 'linear-gradient(115deg, #F2F3F5 49.5%, #202020 50.5%)', card: '#FFFFFF', line: '#E5E6EB', text: '#1D2129' }
    ];
    let currentMode = null;
    const cards = [];
    function preview(m) {
      const pv = div('theme-preview');
      pv.style.background = m.page;
      const bar = div('tp-titlebar'); bar.style.background = m.id === 'dark' ? '#1B1B1D' : '#FFFFFF';
      const bodyEl = div('tp-body');
      const side = div('tp-side'); side.style.background = m.id === 'dark' ? '#1B1B1D' : '#FFFFFF';
      const content = div('tp-content');
      for (let i = 0; i < 3; i++) {
        const line = div('tp-line');
        line.style.background = i === 0 ? m.card : m.line;
        if (i === 0) { line.style.height = '16px'; line.style.borderRadius = '4px'; line.style.width = '70%'; }
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
      card.appendChild(div('tc-name2', m.name + (m.id === 'system' ? '（自动切换）' : '')));
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
    // 侧边栏收起已由侧栏底部按钮提供，此处不再重复放开关
  }
  async function drawData(body, token) {
    let userData = '(浏览器演示模式)';
    if (isDesktop) { try { userData = (await invoke('app:get-info')).userData; } catch (e) {} }
    if (token !== undefined && token !== drawToken) return;
    body.appendChild(div('set-row', div('', div('set-label', '数据目录'), div('set-desc', '配置、收藏、剪贴板历史等全部保存在本机，不上传云端'), div('set-desc mono', userData)), div('set-control', btn('打开目录', 'btn-sm btn-secondary', async () => {
      if (!isDesktop) return toast('浏览器模式不可用', 'warn');
      try { await invoke('fs:open-path', userData); } catch (e) { toast(e.message, 'error'); }
    }))));
    body.appendChild(div('set-row', div('', div('set-label', '清除使用记录'), div('set-desc', '清空最近使用与剪贴板历史（不影响收藏）')), div('set-control', btn('清除', 'btn-sm btn-danger-plain', async () => {
      if (!(await confirmBox({ title: '清除使用记录', message: '将清空最近使用记录与剪贴板历史，确定继续？', danger: true, okText: '清除' }))) return;
      await invoke('store:set', 'recents', []);
      await invoke('store:set', 'clipHistory', []);
      state.recents = [];
      toast('已清除', 'success');
      render();
    }))));
    body.appendChild(div('set-row', div('', div('set-label', '隐私承诺'), div('set-desc', '核核工具箱不收集任何操作日志与个人信息；联网功能仅在主动触发时执行；所有本地数据仅存于用户电脑'))));
  }

  /* ============ 关于页（唯一的版本/更新入口） ============ */
  async function renderAbout(page) {
    const info = await invoke('app:get-info');
    page.appendChild(div('tool-header', div('th-icon', iconLg('info')), div('', h('h2', null, '关于'), h('div', { class: 'th-desc' }, '版本信息与更新'))));

    const updLine = h('div', { class: 'field-hint', style: { padding: '8px 4px 0' } }, '');
    const updActions = div('', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', padding: '8px 4px 0' } });
    const checkBtn = btn('检查更新', 'btn-sm btn-secondary', checkUpdate);

    const card = div('card');
    const head = div('', { style: { display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '16px' } });
    head.appendChild(h('img', { src: 'assets/icon.png', style: { width: '56px', height: '56px', borderRadius: '12px' } }));
    head.appendChild(div('', h('div', { style: { fontWeight: 600, fontSize: '18px' } }, '核核工具箱'), h('div', { class: 'set-desc' }, 'HeHe Toolbox v' + info.appVersion)));
    head.appendChild(div('', { style: { marginLeft: 'auto' } }, checkBtn));
    card.appendChild(head);
    card.appendChild(window.ui.kvGrid([
      ['运行环境', `Electron ${info.electron} · Chromium ${info.chrome}`],
      ['当前用户', info.username + '@' + info.hostname],
      ['数据目录', info.userData]
    ]));
    card.appendChild(updLine);
    card.appendChild(updActions);
    page.appendChild(card);

    // 升级后清理残留下载包（每次升级都会留一份 90MB+，进本页时顺手清掉）
    invoke('update:cleanup').then((r) => {
      if (r && r.removed) console.log('[update] 清理旧安装包', r.removed, '个', (r.bytes / 1048576).toFixed(1) + 'MB');
    }).catch(() => {});

    async function checkUpdate(ev) {
      const trigger = ev && (ev.currentTarget || ev.target);
      if (trigger && trigger.disabled) return;
      if (trigger) trigger.disabled = true;
      updLine.textContent = '正在检查更新…';
      updActions.innerHTML = '';
      try {
        const r = await invoke('update:check', { force: true });
        if (r.throttled) { updLine.textContent = `检查太频繁，${r.retryAfter} 秒后可再试（当前最新 v${r.latest}）`; return; }
        if (!r.hasUpdate) { updLine.textContent = `✓ 已是最新版本（v${r.current}）`; return; }
        updLine.textContent = `发现新版本 v${r.latest}（当前 v${r.current}），正在下载…`;
        if (!r.assetUrl) { updLine.textContent = `发现新版本 v${r.latest}，请到 GitHub Releases 下载：${r.htmlUrl}`; return; }
        const out = info.userData + '/update/' + r.assetName;
        const unsub = on('job:stream', (d) => {
          try {
            const j = JSON.parse(d.data);
            if (j.pct != null) updLine.textContent = `下载新版本 v${r.latest}：${(j.pct || 0).toFixed(0)}%（${(j.mb || 0).toFixed(1)}MB）`;
            if (!j.done) return;
            unsub();
            if (!j.ok) { updLine.textContent = '✗ 下载失败：' + (j.error || ''); return; }
            updLine.textContent = `✓ v${r.latest} 已下载完成：${out}`;
            toast('新版本已下载', 'success');
            updActions.appendChild(btn('🚀 重启并替换', 'btn-sm btn-primary', async () => {
              if (!(await confirmBox({ title: '重启并替换', message: `将退出当前版本，用 v${r.latest} 覆盖程序文件并自动重启。

旧版本会自动备份为 .bak，若新版无法启动可运行「回滚」脚本退回。
配置文件与数据不受影响。`, okText: '重启并替换' }))) return;
              try {
                const ap = await invoke('update:apply', { newExe: out });
                updLine.textContent = '正在退出并替换，稍候会自动重启…';
                if (ap && ap.rollbackScript) updActions.appendChild(div('field-hint', '回滚脚本：' + ap.rollbackScript));
              } catch (e) { updLine.textContent = '✗ 替换失败：' + e.message; }
            }));
            updActions.appendChild(btn('打开所在目录', 'btn-sm btn-secondary', () => invoke('fs:show-item', out).catch(() => {})));
          } catch (e) {}
        });
        const dl = await invoke('net:download', { url: r.assetUrl, out });
        if (!dl || !dl.id) { unsub(); updLine.textContent = '✗ 下载启动失败'; }
      } catch (e) { updLine.textContent = '✗ ' + e.message; }
      finally { if (trigger) trigger.disabled = false; }
    }
  }

  /* ============ 状态 ============ */
  function setStatus(text) { statusText.textContent = text; }

  /* ============ 启动 ============ */
  window.App = { openTool, showView, toggleFavorite, setStatus, state, refresh: render, onCleanup };
  document.addEventListener('DOMContentLoaded', async () => {
    buildShell();
    applyTheme();
    await loadUserData();
    render();
  });
})();
