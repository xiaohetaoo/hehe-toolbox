/* 应用外壳：导航、标签页、搜索、首页、状态栏、设置 */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { div, icon, iconLg, toast, confirmBox, switchEl, fmtBytes, btn, makeButtonLike } = window.ui;
  const { invoke, on, isDesktop } = window.api;
  const R = window.Registry;
  /* 取词：外壳文案统一走 i18n，工具正文保持中文。
     用简写 T 是为了让下面几百处调用不至于被 `window.i18n.t(...)` 撑得太长。 */
  const T = (k, v) => (window.i18n ? window.i18n.t(k, v) : k);
  const MN = (m) => (R.modName ? R.modName(m) : (m && m.name) || '');
  const MD = (m) => (R.modDesc ? R.modDesc(m) : (m && m.desc) || '');
  /* 工具名/工具副标题的双语取值。与 MN/MD 同一套约定：英文缺失时回退中文。 */
  const TN = (t) => (R.toolName ? R.toolName(t) : (t && t.name) || '');
  const TD = (t) => (R.toolDesc ? R.toolDesc(t) : (t && t.desc) || '');
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
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
  let dangerousCaps = [];
  /* 能力 id → { name, desc }：部分锁的提示卡要复述「这个工具的哪一项被锁」，
   * 名字只能从 dangerous:list 拿（i18n 在主进程侧，见 main.js 的 cap 文案）。 */
  let dangerousCapInfo = {};
  let toolDanger = {};
  async function loadDangerousState() {
    if (!isDesktop) return;
    try {
      const r = await invoke(Channels.CHANNELS.DANGEROUS.LIST);
      dangerousCaps = r.enabled || [];
      dangerousCapInfo = {};
      for (const c of (r.caps || [])) dangerousCapInfo[c.id] = c;
      toolDanger = await invoke(Channels.CHANNELS.DANGEROUS.TOOL_CAPS);
    } catch (e) { dangerousCaps = []; dangerousCapInfo = {}; toolDanger = {}; }
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
  /* 配色主题：name/desc 走 i18n（英文界面下不能还显示「极地白 / 经典商务蓝」）。
   * 用函数而不是常量对象：T() 依赖当前语言，语言切换后重建设置页要拿到新值。 */
  const ACCENT_IDS = ['polar', 'mist', 'jade', 'violet', 'rose', 'gold', 'teal', 'sand', 'mono'];
  const ACCENTS = ACCENT_IDS.map((id) => ({
    id,
    get name() { return T('accent.' + id + '.name'); },
    get desc() { return T('accent.' + id + '.desc'); },
  }));
  let currentAccent = 'polar';
  let themeListeners = [];
  /* buildShell 注册的 document 级监听的退订函数（见 applyLangLabels） */
  let shellCleanup = null;
  /* UI 偏好广播的订阅（app:ui-prefs-changed）。
   *
   * 【为什么不像别的订阅那样塞进 shellUnsubs】这条订阅的生命周期与「壳」无关：
   * 壳会被整壳重建（切语言），而这条订阅本身正是"要因为切语言而重建"的
   * 触发源之一。若放进 shellUnsubs，重建时先退订、再由重建后的代码重新订阅，
   * 中间那段真空期会漏掉紧随其后到来的广播。
   * 所以它挂在模块级，整壳重建前后都活着，只在这里一次性退订（重建前）。 */
  let uiPrefsUnsub = null;
  /* 标签拖拽在 document 上挂的三个监听的退订函数（见 attachTabDragDelegation
   * 与 renderTabs）。整壳重建前由 shellCleanup 调用，否则每切一次语言多一份。 */
  let tabDragUnsub = null;
  /* matchMedia 的 change 监听只挂一次。
   * applyTheme 会在每次整壳重建（切语言）后重新调用，无守卫就会累积：
   * 切三次语言就有三份监听，每份都会去 store:get 一次。 */
  let schemeListenerBound = false;
  /* 【广播应用过的偏好，不许被更慢的本地读取盖回去】
   * applyTheme 里的 store:get 是异步的（两次 IPC 往返）。而 UI 偏好广播
   * 可能在它返回之前就到了 —— 那种情况下，广播先正确地把 accent 改成
   * 新值，随后那次**早于广播发出**的 store:get 才返回旧值，把它盖回旧色。
   * 用户在另一个窗口刚换的配色，在这个窗口上闪一下就退回去了。
   *
   * 用一个「广播覆盖标记」解决：广播应用过的项记下来，applyTheme 的
   * 回调看到标记就不再覆盖。不用时间戳比较大小 —— 那需要两边的时钟同源，
   * 而这两条路径的时间基准本来就不一样（一个是 IPC 往返，一个是事件到达）。
   *
   * 整壳重建（切语言）时不清空：重建只是重画 DOM，偏好本身没变，
   * 而重建触发的 applyTheme 同样会去读旧值。 */
  const prefsFromBroadcast = { accent: false, theme: false };
  function applyTheme() {
    invoke(Channels.CHANNELS.STORE.GET, 'settings.theme', 'system').then(mode => {
      if (prefsFromBroadcast.theme) return;   // 见上：广播已经给了更新的值
      setThemeAttr(mode);
    });
    invoke(Channels.CHANNELS.STORE.GET, 'settings.accent', 'polar').then(accent => {
      if (prefsFromBroadcast.accent) return;
      setAccent(accent || 'polar');
    });
    if (!schemeListenerBound) {
      schemeListenerBound = true;
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
        const mode = await invoke(Channels.CHANNELS.STORE.GET, 'settings.theme', 'system');
        if (mode === 'system') setThemeAttr('system');
      });
    }
    // 主进程 nativeTheme 变化时同步（settings.theme-changed 携带 shouldUseDarkColors）
    themeListeners.push(on('settings.theme-changed', (isDark) => {
      invoke(Channels.CHANNELS.STORE.GET, 'settings.theme', 'system').then(m => {
        if (m === 'system') setThemeAttr('system');
      });
    }));
  }
  function setAccent(accent) {
    const id = ACCENTS.some(a => a.id === accent) ? accent : 'polar';
    currentAccent = id;
    document.documentElement.dataset.accent = id;
    /* 用户在本窗口主动换色：解除广播覆盖标记，理由同 changeTheme 里那条。 */
    prefsFromBroadcast.accent = false;
    // 通知主进程广播给辅助窗口（标尺/贴图/截图标注），让它们同步换色
    if (isDesktop) invoke(Channels.CHANNELS.APP.SET_ACCENT, id).catch(() => {});
  }
  /* 【从广播里应用配色：不能走 setAccent】
   * setAccent 末尾会 invoke(app:set-accent) 回头通知主进程 —— 而此刻正是
   * 主进程刚广播过来。那样会形成 A→主进程→A 的回环：主进程每次广播都触发
   * 每个窗口再广播一次。窗少时看不出来，开到三个独立窗口就是 N² 条 IPC。
   * 所以把"只改本窗口外观"与"改完通知主进程"分开：
   *   setAccent    用户点了色卡 → 改本窗口 + 通知主进程（由它广播给所有窗口）
   *   applyAccent  收到广播 → 只改本窗口，不再回头通知
   */
  function applyAccent(accent) {
    const id = ACCENTS.some(a => a.id === accent) ? accent : 'polar';
    currentAccent = id;
    document.documentElement.dataset.accent = id;
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

  /* ============ 全局界面偏好的广播订阅 ============
   * 语言 / 配色 / 深浅是全应用偏好，但状态所有权在渲染层（i18n 是每个窗口
   * 各自的一份、data-theme / data-accent 写在各自 document 上）。所以主窗
   * 改了之后，已打开的独立工具窗口必须收到通知才会跟上 —— 否则用户刚把标签
   * 拖出去，两秒之内就能看到两种语言/两种主色。
   *
   * 【为什么退订要重来一次】收到广播后 setLang 会让整壳重建
   * （applyLangLabels → body.innerHTML='' → buildShell），而路由层并没有
   * 重收订阅。若这里不退订，每切一次语言就多一条订阅，
   * 切 N 次之后一次广播会触发 N 次重建 —— 表现是界面越来越卡，
   * 以及 toast 连弹好几条。
   */
  function bindUiPrefs() {
    if (!isDesktop) return;
    if (typeof uiPrefsUnsub === 'function') { try { uiPrefsUnsub(); } catch (e) {} }
    uiPrefsUnsub = on(Channels.CHANNELS.APP.UI_PREFS_CHANGED, (p) => {
      if (!p || typeof p !== 'object') return;
      /* 先应用外观（不触发重建），再处理语言（会重建）。
       * 顺序反过来时，setLang 重建出来的新壳会带着旧主色/旧明暗渲染一帧，
       * 用户能看见一次闪色。 */
      if (p.accent) { prefsFromBroadcast.accent = true; applyAccent(p.accent); }
      if (p.theme) { prefsFromBroadcast.theme = true; setThemeAttr(p.theme); }
      /* 【偏好值也要跟着广播走】
       * 独立工具窗口的 Prefs 缓存是各自一份。主窗口改了「图片压缩默认质量」
       * 之后，已开着的独立窗口仍用旧值 —— 用户会认为设置没生效。
       * 收到广播就重跑 load()，把缓存对齐到 store 里的真实值。
       *
       * 注意：不在这里重绘页面。工具页里的本页输入框不该被"别人改了设置"
       * 而刷掉（那是用户正在编辑的内容）；只在下次读 Prefs.get 时用新值。 */
      if (p.prefs && typeof p.prefs === 'object' && window.Prefs && window.Prefs.applyFromStore) {
        try { window.Prefs.applyFromStore(p.prefs); } catch (e) { /* 缓存对齐失败不影响外观 */ }
        /* 独立窗口没有设置页，但主窗口有：设置页正处于「工具默认值」分区时
         * 重新画一次，否则滑杆显示的还是旧位置。 */
        if (state.view.type === 'settings') render();
      }
      if (p.lang && window.i18n && window.i18n.normalize(p.lang) && p.lang !== lang) {
        applyLang(p.lang);
        applyLangLabels();
      }
    });
  }
  /* 【启动时自动检查更新发现新版 → 给一次不打扰的提示】
   * 主进程在启动 8 秒后（且仅当用户开了「启动时自动检查更新」）才会发它，
   * 所以这条订阅平时是静默的。
   *
   * 【为什么不弹对话框】用户没主动点「检查更新」，弹窗会打断他正在做的事。
   * 用一条 6 秒自动消失的提示 + 可点的「前往设置」就够了。
   * 【为什么订阅挂在模块级而不是 buildShell 里】与 bindUiPrefs 同理：
   * 它要跨整壳重建存活，否则切一次语言就漏掉后续通知。 */
  let updateAvailUnsub = null;
  function bindUpdateAvailable() {
    if (!isDesktop) return;
    if (typeof updateAvailUnsub === 'function') { try { updateAvailUnsub(); } catch (e) {} }
    updateAvailUnsub = on(Channels.CHANNELS.UPDATE.AVAILABLE, (p) => {
      if (!p || !p.latest) return;
      try {
        toast(T('update.availableToast', { v: p.latest }), 'success', 6000);
      } catch (e) { /* 提示失败不影响任何功能 */ }
    });
  }

  /* 切换主题；origin = {x, y} 时以该点为圆心做扩散揭示动画 */
  async function changeTheme(mode, origin) {
    const apply = async () => {
      try {
        await invoke(Channels.CHANNELS.STORE.SET, 'settings.theme', mode);
        /* 用户在本窗口主动改主题：解除广播覆盖标记。
         * 不解除的话，之后 applyTheme 的本地读取会被永久忽略 ——
         * 用户改了主题、重启应用，看到的还是上一次广播来的值。 */
        prefsFromBroadcast.theme = false;
        if (isDesktop) {
          try {
            const isDark = await invoke(Channels.CHANNELS.APP.SET_THEME, mode);
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
    state.favorites = await invoke(Channels.CHANNELS.STORE.GET, 'favorites', []);
    state.recents = await invoke(Channels.CHANNELS.STORE.GET, 'recents', []);
  }
  async function toggleFavorite(toolId) {
    const i = state.favorites.indexOf(toolId);
    if (i >= 0) state.favorites.splice(i, 1); else state.favorites.unshift(toolId);
    await invoke(Channels.CHANNELS.STORE.SET, 'favorites', state.favorites);
    toast(i >= 0 ? T('toast.favRemoved') : T('toast.favAdded'), 'success', 1000);
    // 原地更新星标：不重建工具页，避免清空用户未保存的输入/结果
    const starBtn = document.querySelector('.tool-header .th-star');
    if (starBtn && state.view.type === 'tool' && state.view.toolId === toolId) {
      /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
      const on = state.favorites.includes(toolId);
      starBtn.replaceChildren(icon('star'), on ? T('tool.favorited') : T('tool.favorite'));
    }
    if (state.view.type === 'fav') render(); // 收藏页需刷新列表
    else renderNav();
  }
  async function pushRecent(toolId) {
    /* 条数可配置（设置 → 通用 → 首页最近使用）；0 表示整块隐藏。
     * 【为什么 slice 在 0 时也要走一遍】Prefs.get 返回 0 时 slice(0,0) 得空数组，
     * 正好就是"关闭"的语义，不需要为 0 单开分支。 */
    const limit = Prefs.get('recentLimit');
    state.recents = [toolId, ...state.recents.filter(x => x !== toolId)].slice(0, limit);
    await invoke(Channels.CHANNELS.STORE.SET, 'recents', state.recents);
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
    main.appendChild(h('span', { class: 'sr-name', html: highlightHit(TN(t), q) }));
    if (isDangerTool(t.id)) main.appendChild(h('span', { class: 'sr-danger' }, isDangerEnabled(t.id) ? T('badge.danger') : T('badge.disabled')));
    main.appendChild(h('span', { class: 'sr-module' }, mod ? MN(mod) : ''));
    row.appendChild(main);
    row.appendChild(h('span', { class: 'sr-desc', title: TD(t) }, TD(t)));
    /* 结果行是 div + click：Tab 走不到、回车无反应。
     * 读屏名称用「工具名 + 所属模块」，光读个名字没有上下文。 */
    makeButtonLike(row, TN(t) + (mod ? '（' + MN(mod) + '）' : ''));
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

  /* 【数字框：聚焦时也不该被滚轮改值】
   * Chromium 对 <input type=number> 的默认行为是：鼠标悬停/聚焦时滚轮会加减 step。
   * 本项目的数字框全是「长度 / 数量 / 质量 / 帧率」这类参数，
   * 用户滚动页面时滚轮恰好划过某个输入框，值就被悄悄改了 ——
   * 而这类错误极难察觉：界面上只是数字变了，没有任何提示，
   * 等到点「开始压缩」才发现质量从 80 变成了 79。
   *
   * 处理方式：在 wheel 事件上判断——**只有真正聚焦时才放行**。
   * 不干脆全部禁掉：用户确实可能用滚轮微调（比如逐格调帧率），
   * 聚焦状态是他主动选择进入的，此时滚轮是明确意图。
   * 未聚焦时阻止默认行为，这样划过不会改值，也不会连带滚动页面。
   * passive:false 是必需的——passive 监听器里 preventDefault 无效。 */
  function installNumberWheelGuard() {
    document.addEventListener('wheel', (e) => {
      const el = e.target;
      if (!el || el.tagName !== 'INPUT' || el.type !== 'number') return;
      if (document.activeElement === el) return; // 已聚焦：用户明确在操作它
      e.preventDefault();
    }, { passive: false });
  }

  /* ============ 独立工具窗口模式（v0.6.0）============
   * 主进程用 index.html?tool=xxx&standalone=1 打开独立窗口，
   * 这里把参数读出来。**放在模块级、任何一个函数之前读一次** ——
   * buildShell 与启动流程都要看它，读两遍容易不一致。
   *
   * 【为什么不另做一个 tool.html】见 main.js 里 openToolWindow 的说明：
   * 工具页依赖 20 多个 <script>（ui/registry/i18n/channels/各工具文件…），
   * 复制一份必然分叉。复用同一页面 + 参数，加载的是同一批文件。 */
  const bootParams = (() => {
    try {
      const q = new URLSearchParams(window.location.search || '');
      return { tool: q.get('tool') || null, standalone: q.get('standalone') === '1' };
    } catch (e) {
      return { tool: null, standalone: false };
    }
  })();
  const IS_STANDALONE = bootParams.standalone && !!bootParams.tool;

  /* 独立窗口的文档标题 = 工具名。
   *
   * 【为什么渲染层还要设一次】主进程创建 BrowserWindow 时已经设过 title，
   * 但页面加载完成后 Electron 会把 document.title（来自 index.html 的
   * <title>核核工具箱</title>）同步回窗口标题，把主进程那次覆盖掉。
   * 结果就是：主进程改了、渲染层没改 = 窗口标题仍是「核核工具箱」。
   * 所以两边都要设，各管一个阶段。
   *
   * 主窗口不设：它的标题本来就该是应用名。
   * 语言变化时要重设（切语言会重建外壳，工具名会变英文）。 */
  function setDocTitle() {
    if (!IS_STANDALONE) return;
    const t = R.get(bootParams.tool);
    const name = t ? TN(t) : bootParams.tool;
    try { document.title = name; } catch (e) {}
  }

  /* 独立窗口的外壳：标题栏（可拖动/最小化/最大化/关闭）+ 内容区。
   * 没有侧栏、没有标签栏、没有搜索框、没有状态栏 —— 那些都是"工具箱"的东西，
   * 而这个窗口只是"一个工具"。 */
  function buildStandaloneShell() {
    const main = div('main standalone');
    const titlebar = div('titlebar');
    /* 面包屑在独立窗里只显示工具名（没有层级可回退 —— 回退到哪儿？
     * 主窗的首页？那会把用户从专注窗口拽走）。
     * 所以这里只放一个不可点的标题，位置与主窗面包屑一致，视觉连贯。 */
    breadcrumbEl = div('breadcrumb');
    const t = R.get(bootParams.tool);
    breadcrumbEl.appendChild(div('bc-node bc-current', t ? TN(t) : bootParams.tool));
    titlebar.appendChild(breadcrumbEl);

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
    minBtn.addEventListener('click', () => invoke(Channels.CHANNELS.WIN.MINIMIZE).catch(() => {}));
    maxBtn = h('button', { class: 'tb-btn', title: T('common.maximize') }, icon('square', 'icon-lg'));
    maxBtn.addEventListener('click', () => invoke(Channels.CHANNELS.WIN.MAXIMIZE).catch(() => {}));
    const closeBtn = h('button', { class: 'tb-btn close', title: T('common.close') }, icon('x', 'icon-lg'));
    closeBtn.addEventListener('click', () => invoke(Channels.CHANNELS.WIN.CLOSE).catch(() => {}));
    tbRight.appendChild(themeBtn); tbRight.appendChild(minBtn); tbRight.appendChild(maxBtn); tbRight.appendChild(closeBtn);
    titlebar.appendChild(tbRight);

    tabbarEl = div('tabbar');
    contentEl = div('content');

    const statusbar = div('statusbar');
    statusText = h('span', null, isDesktop ? T('status.ready') : T('status.browser'));
    statusbar.appendChild(statusText);

    main.appendChild(titlebar); main.appendChild(tabbarEl); main.appendChild(contentEl); main.appendChild(statusbar);
    document.body.appendChild(main);

    /* 【独立窗仍然要订阅这几个事件】
     * 它不是"只显示不工作"的静态窗口 —— 用户会在里面点开始、跑任务。
     * 但订阅范围比主窗小得多：不要 sys:stats（那是状态栏的）、
     * 不要托盘/热键/截图那些全局事件（它们属于主窗，独立窗响应只会重复）。
     * 只留：主题变化、窗口最大化状态。 */
    const shellUnsubs = [];
    const sub = (ev, cb) => { const u = on(ev, cb); if (typeof u === 'function') shellUnsubs.push(u); return u; };
    sub('win:maximized', (v) => { if (maxBtn) { maxBtn.innerHTML = ''; maxBtn.appendChild(icon(v ? 'copy' : 'square', 'icon-lg')); } });

    shellCleanup = () => {
      shellUnsubs.forEach((u) => { try { u(); } catch (e) {} });
      shellUnsubs.length = 0;
    };
  }

  function buildShell() {
    /* 独立窗口没有侧边栏 —— 它就是"一个工具占一个窗口"，
     * 带上侧栏会让它变成缩小版主窗，失去"专注"的意义。
     * 同理没有标签栏（只有一个工具，没有可切换的东西）。
     * 标题栏保留（要能拖动、最小化、关闭），但去掉搜索框。 */
    if (IS_STANDALONE) {
      buildStandaloneShell();
      return;
    }

    /* 侧边栏 */
    sidebarEl = div('sidebar');
    const logo = div('logo');
    logo.appendChild(h('img', { src: 'assets/icon.png', alt: '' }));
    logo.appendChild(h('span', { class: 'logo-name' }, T('app.name')));
    sidebarEl.appendChild(logo);

    const navScroll = div('nav-scroll');
    const navHome = div('nav-item', icon('home', 'icon-lg'), h('span', null, T('nav.home')));
    navHome.dataset.nav = 'home';
    makeButtonLike(navHome, T('nav.home'));
    navScroll.appendChild(navHome);
    navScroll.appendChild(div('nav-section-title', T('nav.modules')));
    for (const m of R.MODULES) {
      const nm = MN(m);
      const item = div('nav-item', icon(m.icon, 'icon-lg'), h('span', null, nm));
      item.dataset.nav = 'module:' + m.id;
      item.title = nm;
      makeButtonLike(item, nm);
      navScroll.appendChild(item);
    }
    sidebarEl.appendChild(navScroll);

    const bottom = div('nav-bottom');
    const favItem = div('nav-item', icon('star', 'icon-lg'), h('span', null, T('nav.favorites')));
    favItem.dataset.nav = 'fav';
    makeButtonLike(favItem, T('nav.favorites'));
    const setCItem = div('nav-item', icon('settings', 'icon-lg'), h('span', null, T('nav.settings')));
    setCItem.dataset.nav = 'settings';
    makeButtonLike(setCItem, T('nav.settings'));
    // 「关于」不再是侧栏一级入口：它只是版本号、运行环境、检查更新这几行信息，
    // 单开一页占一个导航位不划算，合并进设置的「关于」分区即可。
    const collapseBtn = div('collapse-btn', icon('chev-left'), h('span', null, T('nav.collapse')));
    makeButtonLike(collapseBtn, T('nav.collapse'));
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
    minBtn.addEventListener('click', () => invoke(Channels.CHANNELS.WIN.MINIMIZE).catch(() => {}));
    maxBtn = h('button', { class: 'tb-btn', title: T('common.maximize') }, icon('square', 'icon-lg'));
    maxBtn.addEventListener('click', () => invoke(Channels.CHANNELS.WIN.MAXIMIZE).catch(() => {}));
    const closeBtn = h('button', { class: 'tb-btn close', title: T('common.close') }, icon('x', 'icon-lg'));
    closeBtn.addEventListener('click', () => invoke(Channels.CHANNELS.WIN.CLOSE).catch(() => {}));
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
     * 「重建一次就多一份」的类型（见 shellUnsubs 的注释）。
     * 标签拖拽那三个 document 监听也在这里收口（见 tabDragUnsub）。 */
    shellCleanup = () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKey);
      for (const u of shellUnsubs.splice(0)) { try { u(); } catch (e) {} }
      if (typeof tabDragUnsub === 'function') {
        try { tabDragUnsub(); } catch (e) {}
        tabDragUnsub = null;
      }
    };
  }

  /* ============ 路由与渲染 ============ */
  function showView(view) {
    /* 【记下"上一个视图"再切】
     * 保活需要在切换时把旧页面的现场存回去，而那时 state.view 已经是新的了。
     * 所以在赋值之前留一份。 */
    prevView = state.view || null;
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
    /* 【关标签必须同时丢掉它的保活页】
     * 不丢的话，用户关掉标签、再重新打开同一个工具，看到的会是上次残留的内容
     * （包括旧输入与旧结果）—— 那不是"恢复"，是"幽灵"。
     * 也会让保活表里堆着已经关掉的页，白白占内存。 */
    keepAlive.delete('tool:' + toolId);
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
    /* 【独立窗口没有侧栏】它只显示一个工具，没有可高亮的导航项。
     * 直接返回 —— 少了这个守卫，下面 sidebarEl.querySelectorAll 会抛
     * TypeError，而它在 render() 里排在 renderContent 之前，
     * 于是整个独立窗口是空白的（实测确认过：body 里只有脚本标签 + 一个空的 .main）。 */
    if (!sidebarEl) return;
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
  /* 面包屑：每一级都能点回去，包括最后一级（当前页）。
   *
   * 【为什么最后一级也要可点】
   * 用户在这里的典型诉求是「回到上一级」。旧实现把最后一级写成 bc-current
   * 且不挂 onclick —— 看上去是链接（蓝色）、点下去毫无反应。
   * 而「当前页」点一下应当是什么？不是"重新打开当前页"（那会让工具页重绘、
   * 输入全丢），而是**回到上一级**。这也是文件管理器地址栏的默认预期。
   *
   * 另外整条面包屑现在有 hover 反馈 + 键盘可达：以前鼠标移上去没有任何变化，
   * 用户根本不知道哪里能点。 */
  function renderBreadcrumb() {
    if (!breadcrumbEl) return;
    breadcrumbEl.innerHTML = '';
    const v = state.view;

    /* 【独立窗的面包屑就是工具名，没有层级】
     * 回退到哪儿？主窗的首页？那会把用户从专注窗口拽走。
     * 所以独立窗只渲染一个不可点的当前项。 */
    if (IS_STANDALONE) {
      const tb = R.get(bootParams.tool);
      breadcrumbEl.appendChild(div('bc-node bc-current', tb ? TN(tb) : bootParams.tool));
      return;
    }

    /* 先攒出「层级」数组，再统一渲染 —— 这样每一级的点击行为都能由它在
     * 数组里的位置推出来（末级 → 上一级），不必逐个手写。 */
    const trail = [];
    trail.push({ text: T('nav.home'), go: () => showView({ type: 'home' }) });

    if (v.type === 'module') {
      const m = R.MODULES.find(x => x.id === v.moduleId);
      trail.push({ text: m ? MN(m) : '', go: m ? () => showView({ type: 'module', moduleId: m.id }) : null });
    } else if (v.type === 'tool') {
      const t = R.get(v.toolId);
      const m = t && R.MODULES.find(x => x.id === t.module);
      trail.push({ text: m ? MN(m) : '', go: m ? () => showView({ type: 'module', moduleId: m.id }) : null });
      trail.push({ text: t ? TN(t) : '', go: null });   // 末级：go 由下面统一补成"上一级"
    } else if (v.type === 'fav') {
      trail.push({ text: T('nav.favorites'), go: null });
    } else if (v.type === 'settings') {
      trail.push({ text: T('settings.title'), go: null });
    } else if (v.type === 'about') {
      // 兼容旧路由：'about' 已并入设置
      trail.push({ text: T('settings.title'), go: () => showView({ type: 'settings' }) });
      trail.push({ text: T('settings.about'), go: null });
    }

    trail.forEach((node, i) => {
      const last = i === trail.length - 1;
      const previous = i > 0 ? trail[i - 1] : null;
      if (i > 0) breadcrumbEl.appendChild(h('span', { class: 'bc-sep' }, '/'));
      /* 末级（当前页）的点击目标是**上一级**。
       * 没有上一级时（首页本身）不可点 —— 点了也不会有任何变化。 */
      let go = node.go || (last && previous ? previous.go : null);
      /* 【导航到"当前所在页"不算可点】
       * 首页这一级自带 go（回首页），于是在首页页面上它也是 bc-link ——
       * 手型光标、hover 底色、按下去毫无反应。用户会以为坏了。
       * 判据应当是「点击后视图会不会变」，而不是「有没有挂 handler」。
       * 这里直接比对：目标是首页且当前就在首页 → 不可点。
       * 其余层级（模块 / 工具）不会自己指向自己，所以只处理这一个特例，
       * 而不是写一套通用的"目标是否等于当前"比较 —— 那需要给每个 trail
       * 项补 route 信息，改动面大而收益为零。 */
      if (go && i === 0 && v.type === 'home') go = null;

      const el = h('span', {
        class: 'bc-node' + (last ? ' bc-current' : '') + (go ? ' bc-link' : ''),
        title: go && last && previous ? T('nav.backTo', { name: previous.text }) : null,
        onclick: go ? (e) => { e.preventDefault(); go(); } : null
      }, node.text);

      if (go) {
        /* 键盘可达：面包屑是导航入口，键盘用户必须能用。
         * 用 Enter 触发而不是空格 —— 它在这里的角色是链接，不是开关。 */
        el.setAttribute('role', 'link');
        el.setAttribute('tabindex', '0');
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); go(); }
        });
      }
      breadcrumbEl.appendChild(el);
    });
  }
  function renderTabs() {
    /* 独立窗只有一个工具，没有标签栏可画。 */
    if (IS_STANDALONE || !tabbarEl) return;
    /* 委托只挂一次；attachTabDragDelegation 内部用 __heheTabDrag 做幂等。
     * 放在这里而不是 buildShell：独立窗不会走到这儿，而主窗每次重画标签栏
     * 都顺便确保一次 —— 即使壳被重建过也不会漏。
     *
     * 【退订函数存模块级，交给 shellCleanup 收口】
     * tabbarEl 是 buildShell 新建的，切语言重建后是新元素、旧标记随元素消失，
     * 于是这里会再挂一次。不记下退订函数的话，三个 document 监听永远跟着走，
     * 切 N 次语言一次拖动就发 N 次开窗请求。 */
    tabDragUnsub = attachTabDragDelegation(tabbarEl) || tabDragUnsub;
    tabbarEl.innerHTML = '';
    if (!state.tabs.length) return;
    for (const id of state.tabs) {
      const t = R.get(id);
      if (!t) continue;
      const tab = div('tab' + (state.view.type === 'tool' && state.view.toolId === id ? ' active' : ''));
      /* 拖拽委托要靠它反查是哪个工具（事件冒泡上来时只有 DOM，没有闭包里的 id） */
      tab.dataset.toolId = id;
      tab.appendChild(icon(t.icon));
      /* 包一层 .tab-label：省略号只能做在文本块上，
       * 给 .tab（flex 容器）加 text-overflow 不会生效。 */
      tab.appendChild(h('span', { class: 'tab-label' }, TN(t)));
      /* 【title 提示：图标 + 16px 文字时唯一的全名来源】
       * 标签压缩成 flex: 0 1 auto 之后，8 个标签时 .tab-label 实测只有
       * 16px（一个字都放不下），只剩图标。css/app.css 的注释明确写了
       * 「配合 title 悬停提示读全名」—— 但这里一直只设了 aria-label。
       * aria-label 只对读屏器生效，鼠标悬停是**看不到任何东西**的，
       * 于是窄标签对普通用户就是一堆无法分辨的图标。
       * 两者都要有：aria-label 给读屏器，title 给鼠标。 */
      tab.title = TN(t);
      const c = h('span', { class: 'tab-close' }, icon('x'));
      /* 关闭按钮是 span + click，同样进不了 Tab 序列。
       * 它的读屏名称必须带上是**哪个**标签 —— 一屏可能开着五六个标签，
       * 全读成「关闭」的话用户不知道会关掉哪一个。 */
      makeButtonLike(c, T('tab.closeNamed', { name: TN(t) }));
      /* 关闭按钮的键盘处理要在父级之前 stopPropagation：
       * 否则按下回车会同时触发「关闭」和「切换到该标签」两个动作。 */
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
      c.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
      tab.appendChild(c);
      tab.addEventListener('click', () => showView({ type: 'tool', toolId: id }));
      makeButtonLike(tab, TN(t));
      // 鼠标中键关闭标签页
      tab.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeTab(id); }
      });
      tabbarEl.appendChild(tab);
    }
    /* 【活跃标签必须滚入可视区】
     * 标签多到溢出（转入横向滚动）后，新打开/切到的工具其标签可能停在
     * 滚动区外 —— 用户从搜索打开一个工具，界面切过去了，标签栏却看不到
     * 它，只有右缘的渐隐暗示「右边还有标签」。浏览器（Chrome/Edge）的
     * 标准行为都是把活跃标签滚进来。
     * 用 inline:'nearest'：已经可见时是 no-op，不会在重排/普通重绘时跳动；
     * 不可见时滚到刚好贴边的位置，不做居中（居中反而让人找不到参照）。 */
    const activeTab = tabbarEl.querySelector('.tab.active');
    if (activeTab && typeof activeTab.scrollIntoView === 'function') {
      try { activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* 老内核无参数形式，忽略 */ }
    }
    updateTabOverflowHint();
  }
  /* 【溢出渐隐提示的方向类维护】
   * 滚动条全局隐藏，overflow-x 兜底滚动时用户看不出「另一侧还有标签」。
   * 依据 scrollLeft / scrollWidth 给 .tabbar 挂 overflow-left / overflow-right
   * 两个类（CSS 侧按类做 18px 渐隐 mask，见 app.css）。
   * 监听 scroll + resize：滚动时方向会变，窗口伸缩会从溢出变不溢出。
   * 监听只挂一次（用 tabbarEl 上的标记做幂等），壳重建后新元素重新挂。 */
  function updateTabOverflowHint() {
    if (!tabbarEl) return;
    const el = tabbarEl;
    const apply = () => {
      /* clientWidth 含 padding，scrollWidth 只在有溢出时大于它； tolerate 1px 舍入 */
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      el.classList.toggle('overflow-left', left);
      el.classList.toggle('overflow-right', right);
    };
    apply();
    if (!el.__heheOverflowBound) {
      el.__heheOverflowBound = true;
      el.addEventListener('scroll', apply, { passive: true });
      /* ResizeObserver 在测试环境（jsdom）可能不存在，做能力探测 */
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(apply).observe(el);
      } else {
        window.addEventListener('resize', apply);
      }
    }
  }
  /* ============ 标签拖拽：重排 + 拖出成独立窗口 ============
   *
   * 【手势有两种结果，判据必须先把它们分开】
   *   · 在标签栏内**水平**移动 → 重排（调换标签顺序）
   *   · 离开标签栏（上下左右任一方向超出边界）→ 拖出为独立窗口
   *
   * v0.6.4 之前只有"向下拖 40px"这一条判据，等于只实现了后一半：
   * 用户把标签往右拖一小段，既没反应也不会重排 —— 而浏览器里这是
   * 最常见的操作（把刚打开的标签挪到顺手的位置）。往上/往左更别提：
   * 早期版本只认 dy>0，向上拖是负数，怎么拖都不会触发。
   *
   * 【为什么用"离开标签栏"而不是"某个方向的位移阈值"】
   * 位移阈值是**猜**：40px 向下成立，向上要不要 40？向左呢？
   * 每个方向一个阈值，等于四条互相打架的规则，而且它们在角落里会重叠
   * （同时满足两条判据时该算哪个？）。
   * "有没有离开标签栏"是几何事实，与方向无关，天然覆盖上下左右四个方向，
   * 而且与用户的心智一致 —— 浏览器的语义正是"拖出标签栏 = 拖出窗口"。
   *
   * 【纵向仍然留一个位移阈值兜底】
   * 标签栏只有 36px 高，往下拖 20px 就已经离开它了；但往下拖到内容区之后，
   * 指针可能还在窗口内、也还在标签栏的水平范围内（标签栏 overflow-x 很长）。
   * 单靠"离开标签栏"会让"往下轻轻蹭一下"就弹窗，那太敏感。
   * 所以纵向额外要求越过 TAB_DRAG_THRESHOLD，横向出界则立即生效
   * （横向出界意味着指针到了侧栏上，那是明确得多的意图）。
   */
  const TAB_DRAG_THRESHOLD = 40;
  /* 重排的启动阈值：横向移动超过它才开始算"在挪位置"。
   * 定 6px 而不是 0：指针按下去总会有 1~2px 的抖动，没有阈值的话
   * 用户"点一下标签"就会被记成一次 1 个位置的移动，标签会莫名其妙
   * 往前挪一格。6px 也小于手指/鼠标能有意停留的范围。 */
  const TAB_REORDER_THRESHOLD = 6;

  /* 跟手预览的浮层。整条拖拽期间只创建一次，复用同一个 <img>。
   * 放在 document.body 而不是标签栏里：它要盖在内容区上面，
   * 若留在标签栏内会被 overflow 裁掉。 */
  let dragGhostEl = null;
  function ensureDragGhost() {
    if (dragGhostEl && dragGhostEl.isConnected) return dragGhostEl;
    dragGhostEl = div('tab-drag-ghost');
    dragGhostEl.style.display = 'none';
    document.body.appendChild(dragGhostEl);
    return dragGhostEl;
  }
  function hideDragGhost() {
    if (dragGhostEl) { dragGhostEl.style.display = 'none'; dragGhostEl.innerHTML = ''; }
  }

  /* 落点指示条：一条 2px 竖线，插在"松手会落到的位置"上。
   * 绝对定位、不参与 flex 布局，所以不会把邻居推开（见 app.css 里的说明）。 */
  let dropMarkerEl = null;
  function ensureDropMarker() {
    if (dropMarkerEl && dropMarkerEl.isConnected) return dropMarkerEl;
    dropMarkerEl = div('tab-drop-marker');
    dropMarkerEl.style.display = 'none';
    document.body.appendChild(dropMarkerEl);
    return dropMarkerEl;
  }
  function hideDropMarker() {
    if (dropMarkerEl) { dropMarkerEl.style.display = 'none'; }
  }

  /* 把一条拖拽路径上的"当前顺序"算出来。
   *
   * @param {HTMLElement} bar 标签栏
   * @param {string} movingId 正在拖的工具 id
   * @param {number} clientX 指针的横坐标
   * @returns {{index:number, beforeEl:HTMLElement|null, x:number}}
   *   index    松手后它会落在第几个位置（按当前数组顺序）
   *   beforeEl 落点右侧的那个标签元素（null = 挪到最右）
   *   x        指示条应该画在哪（页面坐标）
   */
  function computeDropTarget(bar, movingId, clientX) {
    const tabs = [...bar.querySelectorAll('.tab')].filter((el) => el.dataset.toolId !== movingId);
    let index = tabs.length;
    let beforeEl = null;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      /* 用"指针过了这个标签的中线"作为判据，而不是"过了它的左边缘"：
       * 用左边缘的话，指针停在某个标签的左半边时要等到完全越过它才算落点后移，
       * 观感上总慢半拍；中线是浏览器与文件管理器都用的手感。 */
      if (clientX < r.left + r.width / 2) { index = i; beforeEl = tabs[i]; break; }
    }
    let x;
    if (beforeEl) {
      x = beforeEl.getBoundingClientRect().left - 2;
    } else if (tabs.length) {
      x = tabs[tabs.length - 1].getBoundingClientRect().right + 1;
    } else {
      x = bar.getBoundingClientRect().left + 16;
    }
    return { index, beforeEl, x };
  }

  /* 把落点指示条画在视口坐标 x 处，高度与标签栏一致。
   * 【为什么用 position:fixed 而不是 absolute】绝对定位要相对最近的定位祖先，
   * 而标签栏本身没有建立定位上下文（它是普通 flex 容器）。用 fixed 直接按
   * 视口坐标画最稳，也不必去给标签栏加 position:relative（那可能影响
   * 其它布局）。 */
  function showDropMarker(bar, x) {
    const marker = ensureDropMarker();
    const r = bar.getBoundingClientRect();
    marker.style.position = 'fixed';
    marker.style.left = x + 'px';
    marker.style.top = r.top + 'px';
    marker.style.height = r.height + 'px';
    marker.style.display = '';
  }

  /* 把拖拽结果写回 state.tabs。
   * 【为什么要重新算最终下标，而不是直接用 computeDropTarget 的 index】
   * computeDropTarget 算的是"在**去掉被拖那一个**之后的数组里"的下标。
   * 真正落位时数组里还留着它，所以要按原下标换算。
   * 直接 splice(原下标,1) 再 splice(新下标,0) 正好对上 —— 因为
   * 去掉它之后的下标 i，等价于"插回原位后的位置"。 */
  function reorderTabs(movingId, targetIndex) {
    const from = state.tabs.indexOf(movingId);
    if (from < 0) return false;
    /* targetIndex 是"去掉它之后"的下标；夹在合法范围内 */
    const to = Math.max(0, Math.min(targetIndex, state.tabs.length - 1));
    /* 原地不动：直接返回，不触发重绘 —— 重绘会让工具页重新渲染，
     * 正在跑的任务可能受影响（虽然 renderTabs 只动标签栏，但没有必要多做）。 */
    if (from === to) return false;
    state.tabs.splice(from, 1);
    state.tabs.splice(to, 0, movingId);
    return true;
  }

  /* 把拖拽委托挂到标签栏上，**返回一个退订函数**。
   *
   * 【为什么必须返回退订】三个监听挂在 document 上，而 tabbarEl 是
   * buildShell() 每次新建的元素 —— 切一次语言（applyLangLabels →
   * body.innerHTML='' → buildShell）就换一个新标签栏，旧标签栏上的
   * __heheTabDrag 标记随元素一起被丢弃，于是新元素会再挂一次。
   * 挂上去的三个 document 监听从不退订，切 N 次语言就有 N 份：
   * 一次拖动会触发 N 次开窗请求，用户得到 N 个独立窗口。
   * shellCleanup 早就收口了 click / keydown 与 9 个 IPC 订阅，
   * 唯独这三个漏在外面 —— 这就是那个缺口。 */
  function attachTabDragDelegation(bar) {
    if (!bar || bar.__heheTabDrag) return null;
    bar.__heheTabDrag = true;

    let dragState = null;
    /* 用 rAF 节流：pointermove 触发频率可达每秒上百次，
     * 每次都写 style 会让主线程忙于样式计算，反而拖不跟手。 */
    let rafPending = false;
    let lastX = 0, lastY = 0;

    const applyGhostPos = () => {
      rafPending = false;
      if (!dragState || !dragGhostEl || dragGhostEl.style.display === 'none') return;
      /* 偏移 14px 让预览不被指针挡住，用户能看见自己抓着的是什么 */
      dragGhostEl.style.transform = 'translate3d(' + (lastX + 14) + 'px,' + (lastY + 14) + 'px,0)';
    };
    const scheduleGhostPos = (x, y) => {
      lastX = x; lastY = y;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(applyGhostPos);
    };

    /* 清掉拖拽留下的视觉状态。
     *
     * 【必须显式接 st，不能读外层的 dragState】
     * finish / onCancel 的顺序都是「先置空 dragState，再清理」，所以函数执行时
     * dragState 早已是 null —— 读它的话两个 class 一个也清不掉。实测到的残留：
     *   · 拖出成窗口（不拖回）→ 松手后标签仍是 tab-drag-out（半透明 + 虚线框），
     *     而 finish 的拖出分支 return 前不调 renderTabs，没有任何重建会抹掉它；
     *   · 重排但落点没变（changed=false 提前 return）→ tab-reorder 残留，
     *     标签永久 opacity 0.6 且 z-index 压在邻项之上；
     *   · pointercancel → 同样残留。
     * 只有「重排成功」那条路径因为调了 renderTabs() 重建 DOM 才碰巧清掉 ——
     * 所以这个 bug 在开发时极难遇到，用户却会稳定撞上。
     *
     * 残留还会级联：下次拖同一个标签时 onDown 重建 dragState 但不清旧 class，
     * 一旦进入重排，标签就同时带 tab-drag-out 与 tab-reorder ——
     * 正是注释里反复强调「两套视觉必须一眼分开」要避免的状态。
     *
     * @param {object|null} st 本次拖拽的状态快照；拿不到（unsub）时传 null，
     *   走下面的兜底扫描。
     */
    const clearVisual = (st) => {
      const tabEl = st && st.tabEl;
      if (tabEl) {
        tabEl.classList.remove('tab-drag-out');
        tabEl.classList.remove('tab-reorder');
      }
      /* 兜底：unsub 时拿不到 st，把标签栏里所有标签扫一遍。
       * 正常路径不会有多余标签带这两个 class，扫描的代价可以忽略
       * （标签数量是个位数），而漏掉一个就又是永久残留。 */
      if (!tabEl && bar && typeof bar.querySelectorAll === 'function') {
        for (const el of bar.querySelectorAll('.tab')) {
          el.classList.remove('tab-drag-out');
          el.classList.remove('tab-reorder');
        }
      }
      hideDragGhost();
      hideDropMarker();
      bar.classList.remove('dragging');
    };

    const onDown = (e) => {
      if (e.button !== 0) return;                       // 只认主键
      const tab = e.target.closest && e.target.closest('.tab');
      if (!tab) return;
      if (e.target.closest('.tab-close')) return;       // 点关闭按钮 ≠ 拖走

      dragState = {
        toolId: tab.dataset.toolId || '',
        tabEl: tab,
        startX: e.clientX,
        startY: e.clientY,
        /* out      = 松手会弹成独立窗口
           reorder  = 正在重排（已越过横向阈值、且还没离开标签栏）
           targetIndex = 松手后会落在去掉自己之后的下标 */
        out: false,
        reorder: false,
        targetIndex: 0,
        ghostReady: false,
        pointerId: e.pointerId,
      };
      try { tab.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件不支持，忽略 */ }
    };

    const onMove = (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const st = dragState;
      const dx = e.clientX - st.startX;
      const dy = e.clientY - st.startY;
      const adx = Math.abs(dx), ady = Math.abs(dy);

      /* ---- ① 先判"是否要拖出" ----
       * 四个方向一视同仁：指针离开标签栏就算拖出。
       *
       * 【为什么纵向要 40px 阈值、横向只要越过边界】
       * 标签栏只有 36px 高。往下拖 20px 就已经出界了，可"手抖一下"也能到
       * 20px —— 不设阈值会让轻轻一蹭就弹窗。
       * 横向出界（左/右）不一样：指针已经压到侧栏或窗口边缘上了，
       * 跨越的距离天然就短（标签栏两侧只有 16px 内边距），意图明确得多。
       * 所以横向的判据是「越过 bar 的左/右边界」，不再额外要求 40px 位移。
       *
       * 【为什么不能写成 `adx > TAB_DRAG_THRESHOLD || ady > ...`】
       * 那会把"横向出界但只移了 20px"漏进重排分支：标签变半透明、画出落点
       * 竖线，松手后如果落点恰好是原位就什么都不发生 —— 用户想"往左拖出去"，
       * 得到的是闪一下就恢复原状。实测过：标签栏 (0,0)-(600,36)、从 x=20 起手
       * 拖到 x=-4，adx 只有 24，旧写法 out 恒为 false。
       *
       * 【为什么保留"纵向深拖"这条路】
       * 指针拖到窗口外再拖回来时，出界那一刻可能已经判过 out 了；
       * 这条只处理"指针还在标签栏矩形内、但纵向已经拖得很深"的边界情况，
       * 与 v0.6.4 的行为保持连续 —— 老用户的手势不能突然失灵。
       */
      const barRect = bar.getBoundingClientRect();
      const outLeft = e.clientX < barRect.left;
      const outRight = e.clientX > barRect.right;
      const outVert = e.clientY < barRect.top || e.clientY > barRect.bottom;
      const outside = outLeft || outRight || outVert;
      /* 横向越界（含"已越过左右边界"）只需越过重排阈值即可认定意图；
       * 纵向越界要 40px 兜底（防手抖）；矩形内只认纵向深拖。 */
      const horizontalOut = (outLeft || outRight) && adx > TAB_REORDER_THRESHOLD;
      const verticalOut = outVert && ady > TAB_DRAG_THRESHOLD;
      const nowOut = outside
        ? (horizontalOut || verticalOut)
        : (ady > TAB_DRAG_THRESHOLD && ady > adx * 2);

      if (nowOut !== st.out) {
        st.out = nowOut;
        st.tabEl.classList.toggle('tab-drag-out', nowOut);
        if (nowOut) {
          /* 转为"拖出"：重排状态必须立刻撤掉，否则标签会同时带着
           * 重排（半透明）与拖出（虚线框）两套视觉，用户分不清松手会怎样。 */
          st.reorder = false;
          st.tabEl.classList.remove('tab-reorder');
          hideDropMarker();
          bar.classList.add('dragging');

          /* 刚越过阈值：这时才去截图（而不是按下就截）。
           * 好处是"只是拖去重排"和"只是点了一下标签"都不产生截图开销。
           *
           * 【截图回来时必须校验「还是不是同一次拖拽」】
           * 用局部 const st 抓住发起截图那一刻的 dragState，回来先比指针身份：
           *   · 只判 dragState.out 是不够的 —— 用户在等待期间松手、再重新按下
           *     另一个标签并拖出，新的一轮 dragState.out 同样是 true，
           *     于是上一轮的截图会盖到这一轮的预览上（预览内容是错的工具页）。
           *   · 这个窗口只有 5ms 宽（实测截图预热后 5ms），但合成事件与
           *     慢机器上确实能撞上；而且 fallback 卡片里的工具名读全局
           *     dragState 时，错的是**名字**，用户看到的是"图标对、名字错"。
           * 所以下面一律从 st 取，不再碰全局。 */
          const ghost = ensureDragGhost();
          if (!st.ghostReady) {
            st.ghostReady = true;
            captureContentThumb().then((url) => {
              if (dragState !== st || !st.out) return;
              if (!url) {
                /* 拿不到图也要有反馈：退回一个只有图标 + 名字的小卡片。
                 * 静默什么都不显示会让用户以为拖拽没生效。 */
                ghost.innerHTML = '';
                const t = R.get(st.toolId);
                ghost.appendChild(div('tab-drag-ghost-fallback',
                  t ? icon(t.icon, 'icon-lg') : null,
                  t ? TN(t) : (st.toolId || '')));
              } else {
                ghost.innerHTML = '';
                ghost.appendChild(h('img', { src: url, alt: '' }));
              }
              /* 【先落位，再显示 —— 不能等第一次 rAF】
               * 浮层的 transform 初始是空的，等于画在 (0,0)。若这里只把它
               * 显示出来、位置留给下一次 rAF，就会出现一帧「预览从窗口左上角
               * 窜到指针下面」。本地机器这一帧只有 ~16ms，且刚好被
               * opacity 0→0.94 的入场遮住，看不出来；CI 没有 GPU、rAF 被拖慢，
               * 这一帧就变得可见 —— 实测 G4（预览跟着指针）在 CI 上拿到空
               * transform，本地却一直是绿的。
               * 所以位置同步写好（不经过 rAF），后续移动仍走 rAF 节流。 */
              const gx = lastX || e.clientX;
              const gy = lastY || e.clientY;
              ghost.style.transform = 'translate3d(' + (gx + 14) + 'px,' + (gy + 14) + 'px,0)';
              ghost.style.display = '';
              ghost.classList.add('show');
              /* 仍排一次：万一上面算出的坐标已经过期（用户在截图期间又移动过），
               * 下一帧会校正到最新位置。 */
              scheduleGhostPos(gx, gy);
            });
          }
        } else {
          hideDragGhost();
          bar.classList.remove('dragging');
          /* 【拖回标签栏时必须复位 ghostReady，否则再拖出去就永远没有预览】
           * hideDragGhost 会把浮层 innerHTML 清空、display 设 none，但 ghostReady
           * 还停在 true。再次越过阈值时 `if (!st.ghostReady)` 为假 —— 截图分支
           * 被整个跳过；而 applyGhostPos 里又有「display === 'none' 就 return」，
           * 于是浮层既不重新截图、也不重新显示。
           * 用户看到的是：标签半透明 + 虚线框都在，唯独没有跟着指针的预览图。
           *
           * 触发路径很自然：拖出去时犹豫了一下、拖回来又想拖出去；
           * 或者先试着往上拖、觉得不对又拖下去。
           *
           * 【为什么是复位标志，而不是改判"浮层里有没有内容"】
           * 两种写法都能修，但复位标志更直接：它表达的是"这一轮拖出还没截图"。
           * 而"有没有内容"会受截图失败影响 —— 截图失败时浮层里是降级卡片
           * （有内容），那就不该再截一次；反之成功时有一张图，也不该再截。
           * 两者语义不同，混用会让"截图失败后重试"的行为变得难以推理。
           * 正在飞的那次截图回调自带 `dragState !== st || !st.out` 校验，
           * 拖回后它会自行作废，不需要在这里额外取消。 */
          st.ghostReady = false;
        }
      }

      /* ---- ② 没在拖出时：走重排 ----
       * 【为什么重排只在"没有 out"时进行】
       * 一旦进入拖出状态，标签位置就不该再跟着指针变 —— 用户此时意图是
       * "把它弄出去"，中途又在列表里挪来挪去会让人困惑，而且松手开的是
       * 独立窗口、原标签本来也不动。
       */
      if (!st.out) {
        const movingHorizontally = adx > TAB_REORDER_THRESHOLD && adx > ady;
        if (movingHorizontally) {
          st.reorder = true;
          st.tabEl.classList.add('tab-reorder');
          bar.classList.add('dragging');
          const target = computeDropTarget(bar, st.toolId, e.clientX);
          st.targetIndex = target.index;
          showDropMarker(bar, target.x);
        } else if (st.reorder) {
          /* 又拖回到阈值以内：撤掉重排视觉，避免"只是抖了一下"留下痕迹 */
          st.reorder = false;
          st.tabEl.classList.remove('tab-reorder');
          hideDropMarker();
        }
      }

      if (st.out) scheduleGhostPos(e.clientX, e.clientY);
    };

    const finish = (e) => {
      if (!dragState || (e && e.pointerId !== dragState.pointerId)) return;
      const st = dragState;
      dragState = null;
      /* 顺序是硬的：先存 st 再置空，然后把 st 交给 clearVisual ——
       * 传进去而不是让它读全局，因为全局这一刻已经是 null（见 clearVisual 的说明）。 */
      clearVisual(st);
      if (!st.toolId) return;

      /* 松手分三种结果：
       *   拖出 → 开独立窗口（原标签保留，见下方说明）
       *   重排 → 改写 state.tabs 顺序，然后重画标签栏
       *   都不是 → 交给 click 事件处理（切换到该标签） */
      if (st.out) {
        /* 【不关闭原标签】用户可能只是想"多开一个"；而且工具页可能正在跑任务，
         * 关标签会触发页面清理、任务中断。 */
        invoke(Channels.CHANNELS.APP.OPEN_TOOL_WINDOW, st.toolId).catch((err) => {
          toast((err && err.message) || '无法打开独立窗口', 'error');
        });
        return;
      }
      if (!st.reorder) return;

      const from = state.tabs.indexOf(st.toolId);
      const changed = reorderTabs(st.toolId, st.targetIndex);
      if (!changed) return;
      void from;
      /* 【只重画标签栏，不调 render()】
       * render() 会走 renderContent → runPageCleanup，把工具页整个重建。
       * 用户只是把标签挪了个位置，正在跑的任务不该因此中断一遍。
       * renderTabs 足够：它只重建标签栏 DOM，不动内容区。 */
      renderTabs();
    };
    const onCancel = () => {
      const st = dragState;
      dragState = null;
      /* 同样要把 st 传进去 —— 置空之后再读全局是读不到的。 */
      clearVisual(st);
    };

    bar.addEventListener('pointerdown', onDown);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', onCancel);

    /* 退订要连 bar 上的 pointerdown 一起退：整个壳都换新元素了，
     * 留着旧 bar 的监听没有意义（旧 bar 已被 GC 掉，但退订函数是
     * 唯一能让「挂了哪些监听」这件事有始有终的地方）。 */
    return function unsubTabDrag() {
      try { bar.removeEventListener('pointerdown', onDown); } catch (e) {}
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', onCancel);
      try { delete bar.__heheTabDrag; } catch (e) { bar.__heheTabDrag = false; }
      /* 拖拽可能正在进行中（用户在拖的时候切了语言），所以先取快照再清。
       * 快照为空时 clearVisual 会走兜底扫描，把标签栏里所有标签的两个 class
       * 都扫掉 —— 整个壳都要换掉了，任何残留都该抹掉。 */
      const st = dragState;
      dragState = null;
      clearVisual(st);
    };
  }

  /* 取内容区缩略图。失败返回 null（调用方降级成图标卡片）。 */
  async function captureContentThumb() {
    try {
      const el = document.querySelector('.content');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) return null;
      const url = await invoke(Channels.CHANNELS.WIN.THUMBNAIL, {
        x: r.left, y: r.top, width: r.width, height: r.height,
      });
      return typeof url === 'string' && url.indexOf('data:') === 0 ? url : null;
    } catch (e) {
      return null;
    }
  }


  /* ============ 页面级保活（keep-alive）============
   *
   * 【为什么需要】
   * 原实现每次切页都 `contentEl.innerHTML = ''` 然后整页重建。于是
   * 「文本统计」里粘好的几千字、JSON 格式化后的结果、正则测试的匹配列表，
   * 切到别的标签再切回来**全没了**，页面回到刚打开的样子。
   * 用户的原话：「切换标签页再回到原标签页东西怎么全没了」。
   *
   * 【保活什么、不保活什么】
   *   工具页 → 保活（用户真正会在里面输入内容、看结果的地方）
   *   首页 / 收藏 / 模块页 / 设置 → 不保活（都是"重新生成也一样的"展示页，
   *     保活只会让「主题换了颜色没跟着变」这类问题冒出来）
   *
   * 【为什么按 toolId 存，而不是只存"当前页"】
   * 用户可能开着 5 个标签，来回切。只存一张会退化成 LRU=1：
   * 切 A→B→C 回来，A 已经被冲掉了。按 toolId 存才能真的"各是各的"。
   *
   * 【上限与淘汰】
   * 保活的页带着完整 DOM（含用户输入）。截图/OCR 这类工具一页可能几十 MB。
   * 所以设 KEEPALIVE_MAX，超了就淘汰**最久没访问**的那个（LRU）。
   * 淘汰时走与切页相同的清理流程，避免泄漏定时器/监听。
   *
   * 【关键设计决定：保 DOM，而不是"重建 + 回填值"】
   * 第一版走的是"切回来时重新 render，再把表单值写回去"。实测不够 ——
   * 用户看到的"东西"不只是输入框：
   *   · JSON 格式化后的结果区（工具 append 的）
   *   · 正则测试的匹配列表
   *   · 已选好的文件列表、缩略图
   * 这些是**运行时生成的结构**，回填表单值恢复不了。
   * 所以改成保留整个 page 节点、切回来时原样贴回去。
   *
   * 【那切页清理怎么办 —— 这是最容易搞错的一点】
   * 原逻辑：切页 → runPageCleanup() 把 onCleanup 登记的定时器/订阅拆掉。
   * 保住 DOM 但不清理，那些页的定时器会在后台一直跑（本项目刻意修过
   * 「长任务切页不停」，不能退回去）。
   *
   * 所以：**照常清理**（后台任务该停就停，这是既定设计），
   * 同时保住 DOM（用户看到的输入与结果都还在）。
   * 代价是"保活页里正在跑的任务会被停掉" —— 这是对的：
   * 用户切走就意味着不在看它，任务该停。但**已经跑完的结果**会留在 DOM 里。
   *
   * 一句话：**保住"用户看到的"，不保"后台正在跑的"**。 */
  /* 【保活上限：默认 6，可在设置里 1~10 调整】
   * 为什么需要可调：保活页带着完整 DOM（截图/OCR 一页可能几十 MB）。
   * 开得多的人希望别丢状态，用轻量工具的人希望别吃内存 —— 这是纯偏好，
   * 没有"正确值"，所以交给用户。
   * 写成 let 而不是 const，因为设置页保存后要立刻生效（不必重启）。 */
  const KEEPALIVE_MIN = 1;
  const KEEPALIVE_MAX_LIMIT = 10;
  let KEEPALIVE_MAX = 6;
  /** @type {Map<string, {el: Element, scrollTop: number, stamp: number}>} */
  const keepAlive = new Map();
  let keepAliveSeq = 0;
  /* 上一个视图：showView 在切换前留一份，供 snapshotCurrentPage 用。
   * 为什么需要：renderContent 执行时 state.view 已经是新页面了。 */
  let prevView = null;

  /** 把设置里的保活上限夹到合法区间并应用（超出就立刻淘汰）。 */
  function applyKeepAliveLimit(v) {
    let n = Number(v);
    if (!Number.isFinite(n)) n = 6;
    n = Math.round(n);
    if (n < KEEPALIVE_MIN) n = KEEPALIVE_MIN;
    if (n > KEEPALIVE_MAX_LIMIT) n = KEEPALIVE_MAX_LIMIT;
    KEEPALIVE_MAX = n;
    /* 【调小之后要立刻生效，不能等下次开新标签】
     * 用户把上限从 10 改成 3，期望是"现在就只留 3 个"。
     * 不立刻淘汰的话，内存占用要等下一次切页才降下来 —— 用户会以为没生效。 */
    while (keepAlive.size > KEEPALIVE_MAX) evictOne();
    return n;
  }

  /** 淘汰最久未访问的保活页。
   *
   *  【这里**不能**调 runPageCleanup()】
   *  被淘汰那一页的定时器/订阅，在用户**切走它的时候**就已经清过了
   *  （renderContent 里 snapshotCurrentPage 之后紧跟 runPageCleanup）。
   *  而 pageCleanupFns 是**一个全局队列**，装的是"当前这一页"的清理函数。
   *  在这里再调一次，清掉的是当前页 —— 于是出现两种坏结果：
   *    · 开第 7 个标签触发淘汰 → 第 7 个工具刚注册的轮询/计时器立刻被拆，
   *      用户看到的是一个"自己停住"的工具；
   *    · 从设置把上限调小时，若当前页正好是最旧的，它还在屏幕上，
   *      清理函数却被执行 —— 页面还在，后台任务没了。
   *  第一版就是照抄了"淘汰前先清理"的直觉，KA-5 当时只断言字符串
   *  `runPageCleanup()` 出现在函数体里，所以照样绿着。断言已改成锁"不许调"。 */
  function evictOne() {
    let oldest = null, oldestKey = null;
    for (const [k, v] of keepAlive) {
      if (!oldest || v.stamp < oldest.stamp) { oldest = v; oldestKey = k; }
    }
    if (oldestKey === null) return;
    keepAlive.delete(oldestKey);
  }

  /* ============ 用户可调偏好（统一缓存）============
   *
   * 【为什么同步缓存】
   * 这些值在渲染期就要用（pushRecent 要立刻截断数组、拖拽展开要立刻判上限）。
   * 让每个使用点 await 会把一堆同步函数改成 async，扩散面太大。
   * 所以启动时一次性拉全量到内存，之后同步读。
   *
   * 【规格表在哪】lib/prefs-spec.js —— 默认值/区间/类型都定义在那儿，
   * 设置页与使用点共用同一份，不会漂移。
   *
   * 【改动入口只有设置页】
   * Prefs.set 由设置页调用（写 store + 更新内存）。工具页只读。
   * 这是刻意保持的边界：不给工具页留第二个"偷偷改全局配置"的口子。
   */
  const Prefs = {
    /** @type {Record<string, any>} */
    _v: {},
    get(key) {
      const spec = window.PrefsSpec && window.PrefsSpec.SPECS[key];
      if (!spec) return undefined;
      const v = this._v[key];
      return (v === undefined || v === null) ? spec.def : v;
    },
    async set(key, raw) {
      if (!window.PrefsSpec) return undefined;
      const n = window.PrefsSpec.normalize(key, raw);
      if (n === undefined) return undefined;
      this._v[key] = n;
      /* 【只写这一个键，不要整对象覆盖】
       * 原来写的是 STORE.SET 'settings.prefs', this._v —— 整份缓存。
       * 多窗口下这是数据回滚：独立工具窗口的缓存若比主窗口旧，
       * 它一保存就把主窗口刚改的其它键**全部**覆盖回旧值，而且静默。
       * 改成写 settings.prefs.<key> 之后，各窗口只动自己改的那一个键，
       * 永远不会互相回滚。 */
      try { await invoke(Channels.CHANNELS.STORE.SET, 'settings.prefs.' + key, n); }
      catch (e) { /* 落盘失败不阻塞界面 */ }
      return n;
    },
    /** 收到广播时把缓存对齐到 store 里的值（不写盘、不重绘）。 */
    applyFromStore(saved) {
      if (!window.PrefsSpec || !saved || typeof saved !== 'object') return;
      const out = {};
      for (const k of Object.keys(window.PrefsSpec.SPECS)) {
        const raw = saved[k] !== undefined ? saved[k] : window.PrefsSpec.SPECS[k].def;
        out[k] = window.PrefsSpec.normalize(k, raw);
      }
      this._v = out;
    },
    async load() {
      if (!window.PrefsSpec) return;
      let stored = {};
      try {
        const saved = await invoke(Channels.CHANNELS.STORE.GET, 'settings.prefs', null);
        if (saved && typeof saved === 'object') stored = saved;
      } catch (e) { /* 用默认值 */ }
      const out = {};
      for (const k of Object.keys(window.PrefsSpec.SPECS)) {
        const raw = stored[k] !== undefined ? stored[k] : window.PrefsSpec.SPECS[k].def;
        out[k] = window.PrefsSpec.normalize(k, raw);
      }
      this._v = out;
    },
  };
  /* 把真实实现挂到 window.Prefs，供工具页同步读。
   * 【为什么要覆盖】lib/prefs-spec.js 里那份只是"永不返回 undefined"的兜底，
   * 真实值只有 app.js 拿得到（它持有 invoke 与缓存）。 */
  window.Prefs = Prefs;

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
    const v = state.view;
    const pageKey = v.type === 'tool' ? ('tool:' + v.toolId) : null;

    /* 先把"离开当前页"该做的事做完：
     *   ① 抓现场（滚动位置；DOM 本身会被保活引用着，不会丢）
     *   ② 清理定时器/订阅（既定设计，不因保活而改变）
     * ⚠️ 用 prevView 而不是 state.view —— 见 snapshotCurrentPage 的说明。 */
    snapshotCurrentPage(prevView && prevView.type, prevView && prevView.toolId);
    runPageCleanup();
    /* 【必须在清空 prevView 之前留一份】
     * 下面"是不是原地重绘"的判据要看它。写成先清空再读，
     * cameFrom 永远是 null，判据退化成"每次重绘都丢保活" ——
     * 那样切走再切回来也会重建，保活等于没做。 */
    const cameFrom = prevView;
    prevView = null;

    /* ===== 保活只对"真的换页"有效 =====
     *
     * 【问题】保活是"切走时把旧 DOM 存起来，切回来贴回去"。
     * 但有一类重绘**不是换页**：用户人还在这一页上，只是数据变了要重画
     * （例如在高危占位卡里直接开启能力后调 render()）。这时 keepAlive 里
     * 仍然存着这一页的**旧 DOM**，复用路径会把它原样贴回来 —— 于是能力
     * 明明已经开启，用户看到的还是那张"该工具未启用"的占位卡，点开关
     * 等于没反应。实测 test-danger-inline-enable 的红就是这条：
     * `stillLocked: true`。
     *
     * 【判据】prevView 只在 showView（真的换页）里赋值。
     *   - prevView 为 null  → 本次不是换页，是原地重绘 → 必须丢掉旧页重建
     *   - prevView 与当前视图相同 → 同上（showView 到同一个视图）
     *   - prevView 是别的视图 → 这才是"切回来"，复用是对的
     * 这条判据比"看 keepAlive 里有没有"更准：后者两种情况都会命中。 */
    const isSamePageRerender = !cameFrom ||
      (cameFrom.type === v.type && cameFrom.toolId === v.toolId);
    if (isSamePageRerender && pageKey) keepAlive.delete(pageKey);

    /* ===== 复用路径：这个工具页之前保活着，原样贴回去 =====
     *
     * 【为什么直接 append 旧节点就够了】
     * 因为保活保的是**整个 page 元素**：输入框的值、运行结果、已选文件列表、
     * 缩略图、滚动位置全在里面。贴回去就是用户离开时看到的那一屏。
     *
     * 【唯一不会恢复的是"后台任务"】
     * 切页时 runPageCleanup 已经把定时器/轮询拆了。所以如果用户切走时某个工具
     * 正在跑长任务，切回来会看到"停在中途"的画面 —— 那是对的：
     * 用户切走就意味着不在看它，任务本来就该停（这条是既定设计，
     * 见 v0.6.6 修的「长任务切页不停」）。
     * 已经跑完的结果不受影响，仍然留在页面上。 */
    if (pageKey && keepAlive.has(pageKey)) {
      const rec = keepAlive.get(pageKey);
      rec.stamp = ++keepAliveSeq;
      contentEl.innerHTML = '';
      contentEl.appendChild(rec.el);
      /* 滚动位置要等浏览器算完布局才生效，所以放到下一帧。 */
      const top = rec.scrollTop || 0;
      contentEl.scrollTop = top;
      requestAnimationFrame(() => { contentEl.scrollTop = top; });
      /* 【保活复用也要接住全局拖拽/剪贴板面板送来的内容】
       * 复用路径不 render，page 里 filePicker 建立时安排的
       * setTimeout(0) 早就跑完了 —— 如果不在这里补一次，
       * 用户往一个「已经打开的工具页」拖文件，路由正确、面板正确、
       * openTool 正确，然后文件在 __pendingDrop 里躺 30 秒后静默蒸发。
       * （真机实测确认过这个缺陷：pendingLeft=true、列表 0 行。）
       *
       * 做法：从复用的 page 里找到 filePicker 的 API（挂在根元素
       * `__picker` 属性上），显式调它的 consumePendingDrop。
       * 消费内部先 takePending（取不到就直接返回），所以普通切页
       * 没有副作用。延迟到 setTimeout(0)：等页面真正贴回 DOM、
       * fileList 的行渲染就绪后再 add。 */
      if (v.type === 'tool' && window.__pendingDrop) {
        setTimeout(() => {
          try {
            const el = rec.el.querySelector('.picker') || rec.el.querySelector('.dropzone');
            const api = el && (el.__picker || (el.parentElement && el.parentElement.__picker));
            if (api && api.consumePendingDrop) api.consumePendingDrop();
          } catch (e) { /* 交接失败不影响主功能 */ }
        }, 0);
      }
      /* 【剪贴板面板的内容同样要接】与拖拽同一个缺陷：保活复用不 render，
       * renderToolPage 尾部安排的 setTimeout(0) 早已跑完。
       * consumePendingClip 内部先 takePendingClip（取不到即返回），
       * 普通切页无副作用。 */
      if (v.type === 'tool' && window.__pendingClip) {
        setTimeout(() => { try { consumePendingClip(rec.el, v.toolId); } catch (e) {} }, 0);
      }
      return;
    }

    contentEl.innerHTML = '';
    contentEl.scrollTop = 0;
    const page = div('page');
    if (!firstPaintDone) page.classList.add('page-enter');
    firstPaintDone = true;
    try {
      if (v.type === 'home') renderHome(page);
      else if (v.type === 'fav') renderFavPage(page);
      else if (v.type === 'module') renderModulePage(page, v.moduleId);
      else if (v.type === 'tool') {
        /* 工具页现在是 async（未启用的高危工具需要在卡片里查询能力名与状态）。
         * 不能在这里 await：renderContent 被同步调用（切换视图、渲染循环），
         * 改成异步会把「先清空再填充」的顺序打乱，出现短暂白屏。
         * 所以让它在后台跑，异常单独兜底 —— 与这里原有的 try/catch 等价。 */
        renderToolPage(page, v.toolId).then(() => {
          /* 渲染完才登记保活：否则拿到的是空壳。 */
          if (state.view.type === 'tool' && state.view.toolId === v.toolId) {
            keepAlivePage(page, v.toolId);
          }
        }).catch((e) => {
          console.error('工具页渲染失败', v.toolId, e);
          page.appendChild(window.ui.placeholder('alert', T('tool.renderFail'), e && e.message));
        });
      }
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

  /** 把一页登记进保活表（超上限先淘汰最旧的）。
   *
   *  【只记"这页存在"，不抓值】
   *  第一版在这里抓表单快照，实测抓到的是用户输入**之前**的状态（`["2","",""]`），
   *  于是切回来"恢复"成空页面，看起来跟没做保活一样。
   *  现在保的是整个 DOM 节点，值本来就在里面，不需要额外抓。
   *  滚动位置在离开时抓（见 snapshotCurrentPage）。 */
  function keepAlivePage(page, toolId) {
    const key = 'tool:' + toolId;
    keepAlive.set(key, {
      el: page,
      scrollTop: 0,   // 由 snapshotCurrentPage 在离开时填
      stamp: ++keepAliveSeq,
    });
    while (keepAlive.size > KEEPALIVE_MAX) evictOne();
  }

  /** 【离开当前页之前】记下滚动位置（DOM 本身已被 keepAlive 引用着，不会丢）。
   *
   *  【必须用"上一个视图"，不能用 state.view】
   *  本函数由 renderContent 在**切换时**调用，而那时 state.view 已经被
   *  showView 改成新页面了 —— 用 state.view 会把「旧页面的 DOM」存进
   *  「新工具」的槽位，后果是切回工具时贴出来的是首页内容（实测踩过）。
   *  所以这里用 renderContent 传入的上一个 key。 */
  function snapshotCurrentPage(prevType, prevToolId) {
    if (prevType !== 'tool' || !prevToolId) return;
    const rec = keepAlive.get('tool:' + prevToolId);
    if (!rec) return;
    rec.scrollTop = contentEl.scrollTop || 0;
    /* el 可能因为重新渲染而换代（例如高危工具先渲染占位卡再渲染正文），
     * 以当前内容区里真实的 .page 为准。 */
    const cur = contentEl.querySelector('.page');
    if (cur) rec.el = cur;
  }

  /* ============ 首页 ============ */
  function toolCard(t, { showStar = true } = {}) {
    const danger = isDangerTool(t.id);
    const dangerOn = isDangerEnabled(t.id);
    const card = div('tool-card' + (danger ? ' danger' : '') + (danger && !dangerOn ? ' closed' : ''));
    card.appendChild(div('tc-icon', iconLg(t.icon)));
    const info = div('');
    info.appendChild(div('tc-name', TN(t)));
    info.appendChild(div('tc-desc', TD(t)));
    // 高危标记：已开启显示「高危」，未开启显示「未启用」并加锁，提示需去设置里开启
    if (danger) {
      info.appendChild(div('tc-danger-tag', dangerOn ? '⚠ 高危' : '未启用'));
    }
    card.appendChild(info);
    /* 工具卡是首页最主要的入口，之前纯 div + click。
     * 读屏名称带上「高危/未启用」状态，否则键盘用户不知道该页需要先去设置开启。 */
    makeButtonLike(card, TN(t) + (danger ? (dangerOn ? '（' + T('badge.danger') + '）' : '（' + T('badge.disabled') + '）') : ''));
    if (danger && !dangerOn) {
      const lock = div('tc-lock', icon('lock'));
      card.appendChild(lock);
    } else if (showStar) {
      /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
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
        makeButtonLike(row);
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
    /* 【这里也要按上限截断，不能只依赖 pushRecent】
     * 用户把上限从 12 调到 3 时，store 里已经存着 12 条老记录；
     * 只靠 pushRecent 的话要等下次打开工具才缩，界面上会先显示 12 个。
     * 上限为 0 时 slice(0,0) 得空数组，整个区块自然隐藏。 */
    const recentCap = Prefs.get('recentLimit');
    const recents = (recentCap > 0 ? state.recents.slice(0, recentCap) : [])
      .map(id => R.get(id)).filter(Boolean);
    if (recents.length) {
      const card = div('card home-recent');
      card.appendChild(div('card-title', icon('clock'), T('home.recent')));
      card.appendChild(div('recent-row', ...recents.map(t => {
        const chip = div('recent-chip', icon(t.icon), h('span', null, TN(t)));
        makeButtonLike(chip, TN(t));
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
      makeButtonLike(c);
      c.title = MD(m);
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
      div('', h('h2', null, MN(m)), h('div', { class: 'th-desc' }, MD(m)))));
    const card = div('card');
    card.appendChild(div('tool-grid', ...R.byModule(moduleId).map(t => toolCard(t))));
    page.appendChild(card);
  }
  async function renderToolPage(page, toolId) {
    const t = R.get(toolId);
    if (!t) { page.appendChild(div('empty-tip', T('tool.notFound'))); return; }
    const head = div('tool-header');
    head.appendChild(div('th-icon', iconLg(t.icon)));
    const info = div('');
    info.appendChild(h('h2', null, TN(t)));
    info.appendChild(h('div', { class: 'th-desc' }, TD(t)));
    head.appendChild(info);
    const starred = state.favorites.includes(toolId);
    const starBtn = btn(starred ? T('tool.favorited') : T('tool.favorite'), 'btn-secondary btn-sm th-star', () => toggleFavorite(toolId), 'star');
    head.appendChild(starBtn);
    page.appendChild(head);
    /* 【英文模式下的「正文未翻译」提示】
     * 界面外壳（导航/首页/设置）是双语的，但 40 个工具文件里只有 3 个接了 TT()。
     * 英文用户切到 English 后点进任何一个工具，看到的是整片中文 ——
     * 第一反应是「功能坏了」，而不是「还没翻译完」。
     *
     * 设置页里其实写了这条说明（settings.languageDesc），但用户是在**工具页**
     * 困惑的，说明藏在设置里等于没说。所以在工具页顶部显式提示一次。
     *
     * 判据用 tool.i18n 标记而不是写死 id 名单：
     * 名单会随翻译进度变化，写死必然过期（过期表现为「明明翻译了却还提示」）。
     * 接了 i18n 的工具在 register 时打 i18n:true，这里据此判断。 */
    if (lang === 'en' && !t.i18n) {
      page.appendChild(div('tool-i18n-note', T('tool.bodyNotTranslated')));
    }
    // 高危工具未启用时的处理。
    // 【不能整页锁死】local-notes / clipboard-history 只在「删除」时需要 file-delete，
    // 记笔记、看剪贴板历史本身是无害的读操作。原来这里一律换成说明卡，
    // 用户点进来看到「该工具默认未启用」，会直接以为功能坏了。
    // 现在：只有「整个工具的所有能力都是高危」才锁页；否则照常渲染，
    // 交由各操作自己在触发时弹门禁提示（IPC 层本来就有操作级门禁，双层覆盖）。
    if (isDangerTool(toolId) && !isDangerEnabled(toolId) && requiresWholeToolLock(toolId)) {
      page.appendChild(await dangerLockedCard(toolId, TN(t)));
      return;
    }
    // 部分高危：渲染功能本体，但在页面顶部放一条提示，说明哪些操作需要开启
    if (isDangerTool(toolId) && !isDangerEnabled(toolId)) {
      page.appendChild(dangerNoticeCard(t.id));
    }
    try {
      /* 第二个参数是「工具页可见的上下文」。
       * 【toolId 必须传】全局拖拽把文件路由到某个工具后，那个工具的
       * filePicker 要靠自己的 id 去取待处理文件（takePending 按 id 过滤），
       * 否则同一个待处理队列会被任何工具吃走。
       *
       * 【为什么还要设 window.__renderingTool】
       * filePicker 是 ui.js 里的通用组件，它的调用点有 40 多个，
       * 没法逐个改签名去传 toolId。所以在 render 期间设一个"当前正在渲染
       * 哪个工具"的标记，filePicker 建好后读它 —— 这是唯一的自动途径。
       * 必须在 finally 里清掉：否则 render 抛异常后标记会残留，
       * 之后别的工具建 filePicker 时会用错 id 去取待处理文件。 */
      /* 【标记必须在 render 之后立刻清掉，不能留给 finally 之外的时机】
       * filePicker 是在 render 内部同步创建的，它把「消费待处理文件」
       * 推到 setTimeout(0) 执行 —— 那时 render 已经返回、标记已被清掉，
       * 于是拿不到 toolId。
       * 所以：**不清除**，而是让它保留到下一个工具 render 时被覆盖。
       * 风险是"某个非工具页的 filePicker 用到了上一个工具的 id" ——
       * 但 filePicker 只在工具页里用（40 多个调用点全在 js/tools/ 下），
       * 且 takePending 取完即清空、30 秒过期，实际影响是零。 */
      window.__renderingTool = toolId;
      t.render(page, { App: window.App, ui: window.ui, api: window.api, toolId });
    } catch (e) {
      console.error('工具渲染失败', toolId, e);
      page.appendChild(window.ui.placeholder('alert', T('tool.renderFail'), e.message));
      return;
    }
    // 渲染成功后恢复上次用过的参数（见 rememberToolParams 的说明）
    rememberToolParams(toolId, page);
    /* 剪贴板动作面板送来的内容：填进本页的主输入框。
     * 逻辑抽在 consumePendingClip(page, toolId)（本函数之外），
     * 因为保活复用路径（showView 的 keepAlive 分支）也要走同一份 ——
     * 只写在这里的话，往「已打开的工具页」送内容会静默蒸发
     * （与全局拖拽的缺陷同源，真机实测确认过）。 */
    setTimeout(() => { try { consumePendingClip(page, toolId); } catch (e) {} }, 0);
  }

  /* 剪贴板动作面板 → 工具页 的内容交接。
   * 被 renderToolPage 的 setTimeout 与保活复用分支两处调用，见上。 */
  function consumePendingClip(page, toolId) {
    try {
      const p = window.ClipActions && window.ClipActions.takePendingClip
        ? window.ClipActions.takePendingClip(toolId, 30000) : null;
      if (!p) return;
      if (p.text) {
        const ta = page.querySelector('textarea:not(.readonly)') || page.querySelector('textarea');
        if (ta) {
          ta.value = p.text;
          /* 触发 input：统计/预览类工具靠它联动；不冒泡避免触发外层监听 */
          try { ta.dispatchEvent(new Event('input', { bubbles: false })); } catch (e) {}
          ta.focus();
          try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
        }
      }
      /* 图片类内容：交给页内的图片选择器（如果有）。
       * 走与拖拽相同的 __pendingDrop 通道，filePicker 会接住。 */
      if (p.dataUrl) {
        window.__pendingDrop = { paths: [], exts: [], dataUrl: p.dataUrl, at: Date.now() };
        /* 通知本页的 picker 立即消费（保活复用时 setTimeout 已过，没人接）。 */
        setTimeout(() => {
          try {
            const el = page.querySelector('.picker');
            const api = el && el.__picker;
            if (api && api.consumePendingDrop) api.consumePendingDrop();
          } catch (e) { /* 交接失败不影响主功能 */ }
        }, 0);
      }
    } catch (e) { /* 交接失败不影响工具主功能 */ }
  }

  /* 【工具参数记忆】
   * 痛点：每次打开「图片压缩」，质量都是 80、最大宽度都是「不限」；
   * 打开「音视频转换」，格式又回到默认。用户每次都得重设一遍。
   *
   * 做法：渲染完成后扫描页内的输入控件，给每个控件算一个**稳定键**，
   * 值变化时写进 store；下次渲染时回填。
   *
   * 【为什么用「结构位置 + 特征」算键，而不是要求每个工具声明 id】
   * 40 个工具文件、几百个输入框，逐个加 id 既容易漏也不可维护。
   * 但**不能用纯序号**（input[0]、input[1]）：工具改一版顺序，
   * 用户的记忆值就会串到别的控件上（比如把「质量」的值填进「帧率」）。
   * 折中：用「同类型控件里的序号 + type + placeholder 前若干字符」拼键 —— 
   * 顺序变了、placeholder 也变了才失效，这比纯序号稳得多。
   *
   * 【只记「用户主动改过」的值】
   * 如果渲染后立刻把默认值全存一遍，那么"用户没动过"和"用户特意设成默认值"
   * 就分不开了，而且会把 store 撑大。所以只在 change/input 事件里写入。
   *
   * 【哪些控件不记】
   * 文件框、搜索框、密码框不记：它们要么是一次性输入，要么记录会有隐私问题。
   * 搜索框（type=search）尤其不该记 —— 每次进页面都带着上次的搜索词很奇怪。
   *
   * 【textarea 一律不记】
   * 多行框装的是"这一次要处理的正文"：diff3 的三份原文、Markdown 笔记、
   * JSON 粘贴、要统计的文本…… 它们动辄几十 KB，一次粘贴就会被打包写进
   * hehe-data.json。后果很具体：
   *   · store 文件被撑大（它是**整份 JSON 原子改名**写的，越大越慢、
   *     越容易在断电时写坏，而写坏会走 .corrupt 备份那条路）；
   *   · 下次进同一个工具，输入框里自动填着上次那一大坨内容，
   *     用户还没开始就被自己的旧数据挡住了；
   *   · 粘贴的内容可能含隐私（聊天记录、日志、密钥），
   *     存进一个明文的配置 JSON 里，用户完全不知道。
   * 记忆功能的价值在"体积小的参数"（质量、帧率、起始序号），
   * 对多行正文则是纯粹的负收益，所以按标签名直接排除，不按 placeholder 猜。 */
  const PARAM_SKIP_TYPES = new Set(['file', 'password', 'search', 'hidden']);
  /* 【单行框也有上限】即使不是 textarea，也可能被塞进超长内容
   * （例如用地址栏/接口返回当输入）。超过这个长度的值不记，
   * 只保留"参数型"短值 —— 与上面 textarea 的理由同源。 */
  const PARAM_MAX_LEN = 512;
  const PARAM_SKIP_PLACEHOLDER = /搜索|search|输入文本|粘贴|请输入内容|要处理|关键词/i;

  function paramKeyFor(el, indexMap) {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text') : tag;
    const slot = indexMap.get(tag + ':' + type) || 0;
    // placeholder 取前 12 字：既是特征，又不会因为文案微调就整条失效
    const hint = String(el.getAttribute('placeholder') || '').slice(0, 12);
    return type + '#' + slot + '#' + hint;
  }

  function rememberToolParams(toolId, page) {
    if (!isDesktop) return;
    /* 【textarea 按标签名排除，而不是靠 type】
     * textarea 的 el.type 是 'textarea'，本来就不在 PARAM_SKIP_TYPES 里
     * （那个集合只列了 input 的类型），所以必须单独判标签名。
     * 见上方「哪些控件不记」里对 textarea 的说明。 */
    const controls = [...page.querySelectorAll('input, select, textarea')]
      .filter((el) => el.tagName.toLowerCase() !== 'textarea')
      .filter((el) => !PARAM_SKIP_TYPES.has(el.type) && el.type !== 'checkbox' && el.type !== 'radio');
    if (!controls.length) return;

    // 只记"有 placeholder 或不是搜索性质"的控件，避免把临时输入框也写进 store
    const indexMap = new Map();
    const picked = [];
    for (const el of controls) {
      const ph = el.getAttribute('placeholder') || '';
      if (PARAM_SKIP_PLACEHOLDER.test(ph)) continue;
      const tag = el.tagName.toLowerCase();
      const type = tag === 'input' ? (el.type || 'text') : tag;
      const k = tag + ':' + type;
      indexMap.set(k, (indexMap.get(k) || 0) + 1);
      picked.push({ el, key: paramKeyFor(el, indexMap) });
    }
    if (!picked.length) return;

    const storeKey = 'toolParams.' + toolId;
    // 先回填（异步），回填期间不监听，免得把回填当作用户输入再存一次
    invoke(Channels.CHANNELS.STORE.GET, storeKey, {}).then((saved) => {
      if (!saved || typeof saved !== 'object') return;
      for (const { el, key } of picked) {
        if (!(key in saved)) continue;
        // 页面可能已被切走
        if (!el.isConnected) continue;
        el.value = saved[key];
        // 有些工具靠 input 事件联动（例如滑块旁的数值标签），回填后补发一次
        try { el.dispatchEvent(new Event('input', { bubbles: false })); } catch (e) {}
      }
    }).catch(() => {});

    // 再监听变化
    let saveTimer = null;
    const flush = () => {
      const data = {};
      for (const { el, key } of picked) {
        if (!el.isConnected) continue;
        /* 超长值不落盘（见 PARAM_MAX_LEN）。传空串而不是跳过这个键：
         * 用户把一段超大内容删干净之后，store 里那份旧的大值也该跟着消失，
         * 否则它会一直躺在 hehe-data.json 里直到工具被卸载。 */
        const v = String(el.value == null ? '' : el.value);
        data[key] = v.length > PARAM_MAX_LEN ? '' : v;
      }
      invoke(Channels.CHANNELS.STORE.SET, storeKey, data).catch(() => {});
    };
    const onChange = () => {
      // 防抖：滑块拖动时 input 事件很密集，每帧写一次 store 会卡
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 600);
    };
    for (const { el } of picked) {
      el.addEventListener('change', onChange);
      el.addEventListener('input', onChange);
    }
    // 页面切走时把未落盘的改动刷一次
    window.App.onCleanup(() => {
      if (saveTimer) { clearTimeout(saveTimer); flush(); }
    });
  }
  /* 高危工具未启用时的占位卡。
   *
   * 【为什么在这里能直接开启】
   * 早先只给一个「前往设置 → 高危功能」的按钮，用户被弹到一个不认识的
   * 设置分区里，还要在七八个开关中找出对应的那个 —— 多绕两层。
   * 现在直接把**这个工具涉及的那几项**能力列在卡片里，逐个开关，
   * 开启即生效并就地重绘页面。
   *
   * 【安全边界没有放松】
   * - 仍然逐项开启，不提供「全部开启」；
   * - 每一开启都要二次确认，并复述这一项会带来什么后果；
   * - 确认框走统一的 confirmBox，与设置页的行为一致。
   * 换句话说：只是把「在哪儿开」提前到这里，开启的门槛完全没变。 */
  async function dangerLockedCard(toolId, toolName) {
    const card = div('card danger-locked');
    card.appendChild(div('danger-locked-title', icon('lock'), T('settings.notice.wholeToolLocked')));
    card.appendChild(div('danger-locked-text',
      T('settings.notice.wholeToolLockedText', { name: toolName })));

    /* 该工具涉及哪些能力：优先用已加载的 toolDanger，缺了再问主进程 */
    let caps = (toolDanger[toolId] && toolDanger[toolId].caps) || [];
    if (!caps.length && isDesktop) {
      try {
        const all = await invoke(Channels.CHANNELS.DANGEROUS.TOOL_CAPS);
        caps = (all && all[toolId] && all[toolId].caps) || [];
      } catch (e) { caps = []; }
    }

    if (caps.length) {
      /* 需要拿能力的名字与说明（tool-caps 只给 id） */
      let capInfo = {};
      try {
        const list = await invoke(Channels.CHANNELS.DANGEROUS.LIST);
        for (const c of (list.caps || [])) capInfo[c.id] = c;
      } catch (e) { capInfo = {}; }

      const box = div('danger-locked-enable');
      for (const capId of caps) {
        const info = capInfo[capId] || { name: capId, desc: '', enabled: false };
        const row = div('set-row', { style: { padding: '8px 0', borderTop: '1px solid var(--border)' } });
        const left = div('');
        left.appendChild(div('set-label', info.name || capId));
        if (info.desc) left.appendChild(div('set-desc', info.desc));
        row.appendChild(left);

        const sw = window.ui.switchEl(!!info.enabled, async (v) => {
          if (v) {
            /* 与设置页同一套门槛：开启前必须二次确认，并复述具体能力 */
            const ok = await window.ui.confirmBox({
              title: T('danger.enableTitle'),
              message: T('danger.enableMsg', { name: info.name || capId, desc: info.desc || '' }),
              danger: true, okText: T('danger.enableOk'),
            });
            if (!ok) { sw.set(false); return; }
          }
          try {
            await invoke(Channels.CHANNELS.DANGEROUS.SET, capId, v);
            toast(v
              ? T('danger.enabled', { name: info.name || capId })
              : T('danger.disabledToast', { name: info.name || capId }),
              v ? 'warn' : 'success');
            /* 重新读状态并重绘当前页：工具解锁后要立刻能用，而不是留在占位卡上 */
            await loadDangerousState();
            render();
          } catch (e) {
            sw.set(!v);
            toast(e.message, 'error');
          }
        });
        row.appendChild(div('set-control', sw));
        box.appendChild(row);
      }
      card.appendChild(box);
      card.appendChild(div('field-hint', { style: { marginTop: '8px', color: 'var(--text-3)' } },
        T('danger.lockHint')));
    }

      card.appendChild(div('form-row', { style: { marginTop: '8px' } },
        btn(T('settings.notice.goDanger'), 'btn-danger', () => {
          /* 带着「这个工具缺哪一项」跳过去，而不是只把用户扔到设置页顶部。
           * 见 openSettings 的说明 —— 那里会滚动到对应的开关并高亮。 */
          const need = (toolDanger[toolId] && toolDanger[toolId].caps) || [];
          openSettings('danger', need[0] || null);
        })));
    return card;
  }
  /* 只有一部分功能需要高危能力的工具：浏览/诊断是安全的，锁整页会让用户
   * 以为功能坏了，所以只提示不封锁。
   *   - local-notes / clipboard-history：记笔记、看历史无害，只有删除要 file-delete
   *   - link-doctor：体检（link:scan）只读，只有「清理僵尸链接」（link:remove）要 file-delete
   *   - acl-repair：诊断（acl:diagnose）只读，只有「取得所有权/修复权限」（acl:repair）要 acl-repair
   * 也就是说这两个工具的「清理 / 修复」按钮由主进程的通道级门禁锁着
   * （CAP_GATED_CHANNELS: link:remove / acl:repair），页面本身照常可用。 */
  const DELETE_ONLY_TOOLS = new Set(['local-notes', 'clipboard-history', 'link-doctor', 'acl-repair']);
  function requiresWholeToolLock(toolId) { return !DELETE_ONLY_TOOLS.has(toolId); }
  function dangerNoticeCard(toolId) {
    const card = div('card');
    card.style.border = '1px solid var(--warning)';
    card.style.background = 'color-mix(in srgb, var(--warning) 8%, transparent)';
    card.appendChild(div('', { style: { fontWeight: 600, marginBottom: '4px' } },
      T('settings.notice.partial')));
    /* 【必须复述「这个工具的哪一项」】
     * 早期这里所有工具共用一句「⚠ 删除功能默认关闭……浏览、编辑、复制不受影响」，
     * 那段话是为记事本/剪贴板历史写的。链接体检要开的是「删除文件」、
     * 权限修复要开的是「取得所有权 / 修复权限」，用户读到的却是一句
     * 与链接清理、权限修复都无关的描述 —— 对不上，只好去设置页逐个试。
     * 现在按 toolDanger 登记的能力逐项列出名字，说不清时再退回通用文案。 */
    const caps = (toolDanger[toolId] && toolDanger[toolId].caps) || [];
    const names = caps.map((id) => (dangerousCapInfo[id] && dangerousCapInfo[id].name) || id)
      .join(T('common.listSep'));
    card.appendChild(div('field-hint',
      names ? T('danger.partialNotice', { op: names }) : T('settings.notice.deleteOnlyText')));
    card.appendChild(div('form-row', btn(T('settings.notice.goDanger'), 'btn-sm btn-secondary', () => {
      /* 与上游卡同理：带上这个工具缺的能力，跳过去后直接定位到那个开关。
       * 用户下一步要做的动作只有一个 —— 把那个开关打开。 */
      openSettings('danger', caps[0] || null);
    })));
    return card;
  }

  /* ============ 设置 ============ */
  let drawToken = 0; // 模块级：drawBody 与闭包外的 drawGeneral/drawAppearance/drawData 共享
  // 当前设置分区必须是模块级状态：高危开关保存后会调 refresh() 全量重绘，
  // 若 current 只是 renderSettings 的局部变量，重绘时会被重置回「通用」，
  // 用户刚点的开关所在面板直接被换掉（连点多项就得每次重新点回分区）。
  let settingsSection = 'general';
  /* 待定位的高危能力 id。由 openSettings(section, capId) 写入，
   * drawDanger 渲染完那一行之后消费并清空。
   *
   * 【为什么要跨这么远传递】
   * openSettings → showView → render → renderSettings → drawDanger 是一条链路，
   * 但 drawDanger 是 async（要先向主进程要能力清单），"渲染完再滚动"
   * 只能发生在它自己的末尾。中途还要经历 refresh() 触发的整页重绘
   * （用户开启开关后 render() 会重跑）。所以这个意图必须活得比一次
   * 函数调用更久 —— 模块级变量是改动面最小的做法。
   *
   * 只在「跳转刚发生」时有效：drawDanger 消费一次就清空，
   * 之后用户自己切分区、或者开关触发重绘，都不会再跳到那一行。
   * 否则用户点开开关、页面重绘，视线会被突然拽回同一行 —— 那很烦。 */
  let focusDangerCap = null;
  function renderSettings(page) {
    page.appendChild(div('tool-header', div('th-icon', iconLg('settings')), div('', h('h2', null, T('settings.title')), h('div', { class: 'th-desc' }, T('settings.subtitle')))));
    const wrap = div('settings-wrap');
    const nav = div('settings-nav');
    const body = div('settings-body');
    const sections = [
      { id: 'general', name: T('settings.general'), icon: 'settings' },
      /* 图标用 settings（三横线 + 圆点，视觉上就是"滑杆"），
       * 项目没有单独的 sliders 图标，也不许用 emoji 当图标。 */
      { id: 'defaults', name: T('settings.defaults'), icon: 'settings' },
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
      else if (current === 'defaults') drawDefaults(body, token);
      else if (current === 'appearance') drawAppearance(body, token);
      else if (current === 'danger') drawDanger(body, token);
      else if (current === 'about') drawAbout(body, token);
      else drawData(body, token);
    }
    for (const s of sections) {
      const item = div('settings-nav-item', icon(s.icon), ' ' + s.name);
      makeButtonLike(item, s.name);
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
    try { curLang = (await invoke(Channels.CHANNELS.STORE.GET, 'settings.lang', null)) || (window.i18n ? window.i18n.detect() : 'zh'); }
    catch (e) { curLang = 'zh'; }
    langSel.value = window.i18n && window.i18n.normalize(curLang) ? curLang : 'zh';
    langSel.addEventListener('change', async () => {
      const v = langSel.value;
      try { await invoke(Channels.CHANNELS.STORE.SET, 'settings.lang', v); } catch (e) {}
      applyLang(v);
      /* toast 必须在 applyLangLabels() **之后**发：
       * 重建会换掉整个 body，先发的那条会挂在已被丢弃的容器上，用户看不到。
       *
       * 【文案用的是**新**语言】applyLang(v) 已在上一步切好了当前语言，
       * 所以这里 T('settings.langSwitched.en/zh') 取到的是切换**之后**的语言。
       * 举例：从中文切到 English，提示语是英文的
       * 「Language switched to English」，而不是中文的「...切换为 English」。
       * 这是刻意的：切换后整壳已经是新语言了，提示跟随新语言才和界面一致；
       * 若混用旧语言，用户会看到「一半中文一半英文」的瞬间。
       * （早期注释写成「用户原来的语言更自然」，那是笔误，实现一直如此。） */
      settingsSection = 'general';
      applyLangLabels();
      toast(T('settings.langSwitched.' + (v === 'en' ? 'en' : 'zh')), 'success', 1600);
    });
    langRow.appendChild(div('set-control', langSel));
    if (token !== undefined && token !== drawToken) return;
    body.appendChild(langRow);

    const row1 = div('set-row', div('', div('set-label', T('settings.autostart')), div('set-desc', T('settings.autostartDesc'))));
    try {
      const enabled = await invoke(Channels.CHANNELS.APP.GET_AUTOSTART);
      const sw = switchEl(enabled, async (v) => { try { await invoke(Channels.CHANNELS.APP.SET_AUTOSTART, v); toast(v ? T('settings.autostartOn') : T('settings.autostartOff'), 'success'); } catch (e) { toast(e.message, 'error'); sw.set(!v); } });
      row1.appendChild(div('set-control', sw));
    } catch (e) { row1.appendChild(div('set-control', h('span', { class: 'field-hint' }, T('settings.browserNA')))); }

    // 后两项的 await 也要各自兜底：任一 IPC 拒绝都会让整个「通用」面板空白，
    // 而且是以 unhandled rejection 形式静默失败。失败时降级成一行提示即可。
    let closeToTray = true;
    try { closeToTray = await invoke(Channels.CHANNELS.STORE.GET, 'settings.closeToTray', true); } catch (e) { console.error('读取托盘设置失败', e); }
    const row2 = div('set-row', div('', div('set-label', T('settings.tray')), div('set-desc', T('settings.trayDesc'))));
    row2.appendChild(div('set-control', switchEl(closeToTray, (v) => invoke(Channels.CHANNELS.STORE.SET, 'settings.closeToTray', v).catch((e) => toast(e.message, 'error')))));

    const row3 = div('set-row', div('', div('set-label', T('settings.hotkey')), div('set-desc', T('settings.hotkeyDesc'))));
    let hotkey = 'Alt+Shift+H';
    try { hotkey = await invoke(Channels.CHANNELS.STORE.GET, 'settings.hotkey', 'Alt+Shift+H'); } catch (e) { console.error('读取热键设置失败', e); }
    const hkInput = h('input', { class: 'input input-sm', value: hotkey, style: { width: '140px', textAlign: 'center' } });
    const hkBtn = btn(T('settings.apply'), 'btn-sm btn-primary', async () => {
      const v = hkInput.value.trim();
      try {
        const ok = await invoke(Channels.CHANNELS.APP.SET_HOTKEY, v);
        if (ok) { await invoke(Channels.CHANNELS.STORE.SET, 'settings.hotkey', v); toast(T('settings.hotkeyOk'), 'success'); }
        else toast(T('settings.hotkeyFail'), 'error');
      } catch (e) { toast(e.message, 'error'); }
    });
    row3.appendChild(div('set-control', hkInput, ' ', hkBtn));

    if (token !== undefined && token !== drawToken) return; // 分区已切换，丢弃过期绘制
    body.appendChild(row1); body.appendChild(row2); body.appendChild(row3);

    /* ---- 硬件加速：视频编码用显卡 ---- */
    /* 【三态：null = 从没设置过，按"检测到就用"处理】
     * 用户的要求是「检测到可用硬件就默认开启」，所以没设置过时开关要显示为
     * "开"（前提是探测到硬件），而不是显示"关"却偷偷在用硬件 ——
     * 那种不一致比默认值本身更让人困惑。 */
    let hwPref = null;
    try { hwPref = await invoke(Channels.CHANNELS.STORE.GET, 'settings.hwAccel', null); }
    catch (e) { console.error('读取硬件加速设置失败', e); }
    const hwRow = div('set-row', div('',
      div('set-label', T('settings.hwAccel')),
      div('set-desc', T('settings.hwAccelDesc'))));
    /* 【探测结果要显示出来，不能只有一个开关】
     * 用户开了开关却发现没变快时，必须能在这儿看到原因：
     * 是没装 ffmpeg、还是本机没有可用编码器。否则那个开关就是个黑盒。
     * 探测约 1 秒（主进程内有缓存），所以先渲染"检测中"，回来再替换文本。 */
    const hwStatus = div('field-hint', T('settings.hwDetect'));
    const hwSwitch = switchEl(hwPref === true, async (v) => {
      try {
        await invoke(Channels.CHANNELS.STORE.SET, 'settings.hwAccel', v);
        toast(v ? T('settings.hwAccelOn') : T('settings.hwAccelOff'), 'success');
      } catch (e) { toast(e.message, 'error'); hwSwitch.set(!v); }
    });
    hwRow.appendChild(div('set-control', hwSwitch));
    if (token !== undefined && token !== drawToken) return;
    body.appendChild(hwRow);
    body.appendChild(div('set-row', div('', hwStatus, div('set-desc', T('settings.hwWhy')))));

    /* 探测是异步的，且失败不影响设置页 —— 出错就显示"未检测到"。 */
    invoke(Channels.CHANNELS.FFMPEG.HW_PROBE).then((p) => {
      if (token !== undefined && token !== drawToken) return; // 分区切走了，别写进已丢弃的 DOM
      if (!p || p.reason === 'NO_FFMPEG') { hwStatus.textContent = T('settings.hwNoFfmpeg'); return; }
      hwStatus.textContent = p.available
        ? T('settings.hwFound', { name: p.name || p.family || 'GPU' })
        : T('settings.hwNone');
      /* 没设置过时，把开关同步成"实际会不会走硬件"，让显示与行为一致。 */
      if (hwPref === null || hwPref === undefined) hwSwitch.set(!!p.available);
      /* 本机没有可用硬件时把开关也禁掉：留着可点但永远不生效，
       * 用户会反复点它试图"修好"，那是最糟的交互。 */
      if (!p.available && hwSwitch && typeof hwSwitch.setDisabled === 'function') hwSwitch.setDisabled(true);
    }).catch((e) => {
      console.error('硬件编码探测失败', e);
      if (token !== undefined && token !== drawToken) return;
      hwStatus.textContent = T('settings.hwNone');
    });

    /* ---- 标签页保活上限 ---- */
    /* 【为什么要让用户自己调】
     * 保活页带着完整 DOM（截图/OCR 一页可能几十 MB）。
     * 常开十几个标签的人希望切回来别丢状态；只用两三个轻量工具的人
     * 希望别白占内存。这是纯偏好，没有"正确值"。 */
    let kaLimit = 6;
    try { kaLimit = await invoke(Channels.CHANNELS.STORE.GET, 'settings.keepAlive', 6); }
    catch (e) { console.error('读取保活上限失败', e); }
    if (token !== undefined && token !== drawToken) return;
    const kaRow = div('set-row', div('',
      div('set-label', T('settings.keepAlive')),
      div('set-desc', T('settings.keepAliveDesc'))));
    const kaSel = h('select', { class: 'select input-sm' });
    for (let n = KEEPALIVE_MIN; n <= KEEPALIVE_MAX_LIMIT; n++) {
      kaSel.appendChild(h('option', { value: String(n) }, T('settings.keepAliveUnit', { n })));
    }
    /* 存值越界时（手工改过配置文件）夹回合法区间再显示，
     * 否则 select.value 会变成空字符串，界面看起来像"没选"。 */
    kaSel.value = String(applyKeepAliveLimit(kaLimit));
    kaSel.addEventListener('change', async () => {
      const n = applyKeepAliveLimit(kaSel.value);
      kaSel.value = String(n);
      try {
        await invoke(Channels.CHANNELS.STORE.SET, 'settings.keepAlive', n);
        toast(T('settings.keepAliveOk', { n }), 'success', 1600);
      } catch (e) { toast(e.message, 'error'); }
    });
    kaRow.appendChild(div('set-control', kaSel));
    body.appendChild(kaRow);
  }
  /* ============ 设置 → 工具默认值 ============
   *
   * 【为什么只写一份循环而不是逐个手写 11 个 set-row】
   * 这些项的形状完全一样（一个标签 + 一句说明 + 一个控件），差异全在
   * lib/prefs-spec.js 的规格表里（默认值/区间/步长/单位）。
   * 手写 11 遍等于把规格表抄第二份 —— 改一处忘一处，而那正是把常量
   * 变成"统一的规格表"要避免的事。
   *
   * 分组只影响**显示顺序与标题**，不产生第二份数据源。 */
  const PREF_GROUPS = [
    {
      title: 'settings.prefGroup.clip',
      keys: ['clipHistoryLimit', 'clipTextLimitKB'],
    },
    {
      title: 'settings.prefGroup.home',
      keys: ['recentLimit'],
    },
    {
      title: 'settings.prefGroup.toolDefaults',
      keys: ['imgCompressQuality', 'recFps'],
    },
    {
      title: 'settings.prefGroup.update',
      keys: ['updateTtlHours', 'updateCheckOnStart'],
    },
    {
      title: 'settings.prefGroup.advanced',
      keys: ['dragMaxDepth', 'dragMaxFiles', 'rulerMinLen', 'crashLogKeep'],
    },
  ];

  function drawDefaults(body, token) {
    if (!window.PrefsSpec) {
      body.appendChild(div('set-row', div('', div('set-desc', T('settings.prefGroup.unavailable')))));
      return;
    }
    const SPECS = window.PrefsSpec.SPECS;
    for (const g of PREF_GROUPS) {
      const card = div('card');
      card.appendChild(div('card-title', T(g.title)));
      for (const key of g.keys) {
        const spec = SPECS[key];
        if (!spec) continue;   // 规格表改了名字时不会整页炸
        const row = div('set-row', div('',
          div('set-label', T('pref.' + key)),
          div('set-desc', T('pref.' + key + '.desc'))));
        const cur = Prefs.get(key);
        let ctrl;
        if (spec.type === 'bool') {
          /* 布尔项用开关；回调里写 store 并提示。 */
          ctrl = switchEl(cur === true, async (v) => {
            try {
              await Prefs.set(key, v);
              toast(T('settings.prefSaved'), 'success', 1400);
            } catch (e) { toast(e.message, 'error'); ctrl.set(!v); }
          });
        } else {
          /* 数值项用下拉而不是输入框：
           * ① 区间/步长已经在规格表里了，下拉天然不会越界；
           * ② 数字框要额外处理滚轮、空值、非数字，而下拉没有这些问题。 */
          ctrl = h('select', { class: 'select input-sm' });
          for (let n = spec.min; n <= spec.max; n += spec.step) {
            const label = spec.unit ? (n + ' ' + spec.unit) : String(n);
            ctrl.appendChild(h('option', { value: String(n) }, label));
          }
          /* 【normalize 保证返回值一定落在网格上】
           * 早期版本这里还要判"是否在选项里、否则回落到默认值"，
           * 那是在补偿 normalize 没做步长对齐的缺陷 —— 结果就是
           * 手工改配置文件写 80、界面显示成空选中（真机踩过）。
           * 现在对齐逻辑在规格层统一做好了，这里直接赋即可。 */
          ctrl.value = String(window.PrefsSpec.normalize(key, cur));
          ctrl.addEventListener('change', async () => {
            try {
              const n = await Prefs.set(key, ctrl.value);
              ctrl.value = String(n);
              toast(T('settings.prefSaved'), 'success', 1400);
            } catch (e) { toast(e.message, 'error'); }
          });
        }
        row.appendChild(div('set-control', ctrl));
        card.appendChild(row);
      }
      body.appendChild(card);
    }
    if (token !== undefined && token !== drawToken) return;
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
    invoke(Channels.CHANNELS.STORE.GET, 'settings.theme', 'system').then(m => { currentMode = m || 'system'; refreshSelected(); });
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
          await invoke(Channels.CHANNELS.STORE.SET, 'settings.accent', a.id);
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
    /* 【{name} 必须真的传进来】danger.text 里带 {name} 占位符，
     * 早期调用时一个变量都没传，于是中英界面都原样显示
     * 「「{name}」涉及的破坏性操作……」—— 占位符直接漏在界面上。
     * 这条横幅讲的是整个分区，所以传分区名（危险功能本身）。 */
    banner.appendChild(div('danger-banner-text', T('danger.text', { name: T('danger.category') })));
    body.appendChild(banner);

    let info;
    try { info = await invoke(Channels.CHANNELS.DANGEROUS.LIST); }
    catch (e) {
      body.appendChild(div('field-err', T('danger.readFail', { err: e.message })));
      return;
    }
    if (token !== undefined && token !== drawToken) return;

    for (const c of info.caps) {
      const row = div('set-row danger-row');
      /* 给行一个可寻址的标记：跳转时要靠它找到"这一项"。
       * data-cap 用能力 id（file-delete / junk-clean…），与主进程
       * DANGEROUS_CAPS 的 id 一致，不是显示名 —— 显示名会随语言变。 */
      row.dataset.cap = c.id;
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
          await invoke(Channels.CHANNELS.DANGEROUS.SET, c.id, v);
          await refresh(); // 重新读取高危状态并重绘，工具卡片的红/灰随之更新
          toast(v ? T('danger.enabled', { name: c.name }) : T('danger.disabledToast', { name: c.name }), v ? 'warn' : 'success');
        } catch (e) { sw.set(!v); toast(e.message, 'error'); }
      }, c.name);
      row.appendChild(div('set-control', sw));
      body.appendChild(row);

      /* 【定位到调用方指定的那个开关】
       * 这段必须在 row 已经 append 之后 —— scrollIntoView 对游离节点无效，
       * 拿不到布局也就没有滚动。 */
      if (focusDangerCap === c.id) {
        focusDangerCap = null;   // 只消费一次：之后的重绘不再抢焦点
        /* 下一帧再滚：此时 body 刚填完，若同帧滚动，浏览器可能还没算好
         * 布局高度（尤其 danger 分区是异步画的，banner 高度依赖字体）。
         * prefers-reduced-motion 下仍然滚动（那是位置信息，不是装饰），
         * 但去掉高亮动画 —— 交给 CSS 的 media query 处理。 */
        requestAnimationFrame(() => {
          try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { row.scrollIntoView(); }
          row.classList.add('danger-row-focus');
          /* 高亮闪一下就去掉：留下常驻的边框会让用户以为这一项被选中了。 */
          setTimeout(() => row.classList.remove('danger-row-focus'), 1600);
          /* 把焦点也移过去，键盘用户可以立刻按空格开启 ——
           * 这正是这类"被门禁拦住"场景下用户唯一想做的动作。 */
          try { const swEl = row.querySelector('.switch'); if (swEl) swEl.focus(); } catch (e) {}
        });
      }
    }

    const tip = div('field-hint', { style: { marginTop: '14px' } }, T('danger.tip'));
    body.appendChild(tip);
  }
  async function drawData(body, token) {
    let userData = T('settings.browserMode');
    if (isDesktop) { try { userData = (await invoke(Channels.CHANNELS.APP.GET_INFO)).userData; } catch (e) {} }
    if (token !== undefined && token !== drawToken) return;
    body.appendChild(div('set-row', div('', div('set-label', T('data.dir')), div('set-desc', T('data.dirDesc')), div('set-desc mono', userData)), div('set-control', btn(T('data.openDir'), 'btn-sm btn-secondary', async () => {
      if (!isDesktop) return toast(T('settings.browserNA'), 'warn');
      try { await invoke(Channels.CHANNELS.FS.OPEN_PATH, userData); } catch (e) { toast(e.message, 'error'); }
    }))));
    body.appendChild(div('set-row', div('', div('set-label', T('data.clear')), div('set-desc', T('data.clearDesc'))), div('set-control', btn(T('data.clearBtn'), 'btn-sm btn-danger-plain', async () => {
      if (!(await confirmBox({ title: T('data.clear'), message: T('data.clearConfirm'), danger: true, okText: T('data.clearBtn') }))) return;
      await invoke(Channels.CHANNELS.STORE.SET, 'recents', []);
      await invoke(Channels.CHANNELS.STORE.SET, 'clipHistory', []);
      state.recents = [];
      toast(T('data.clearOk'), 'success');
      render();
    }))));
    body.appendChild(div('set-row', div('', div('set-label', T('data.privacy')), div('set-desc', T('data.privacyDesc')))));
    await drawCrashSection(body, token);
  }

  /* ============ 崩溃日志（设置 → 数据 的最后一个分区） ============
   * 打包后的 exe 没有控制台，出问题时用户手上没有任何可查的东西。
   * 这里给一个入口：上次是否异常退出 / 有没有日志 / 能不能直接发给我们。
   *
   * 【为什么日志正文要点开才读】
   * 日志可能有几十 KB。设置页一打开就读会把整段文本塞进 IPC 与 DOM，
   * 而 99% 的情况下用户并不需要看它 —— 只在点「查看」时才按需拉。
   *
   * 【为什么单独一个函数而不是塞进 drawData】
   * drawData 已经有一堆 await，出错时的 token 校验会越来越难跟踪。
   * 拆开之后这一段的失败只影响它自己的区块，不会让整个「数据」面板空白。 */
  async function drawCrashSection(body, token) {
    let info = null;
    try { info = await invoke(Channels.CHANNELS.APP.CRASH_INFO); } catch (e) { info = null; }
    if (token !== undefined && token !== drawToken) return;

    // 读不到（浏览器模式 / 老版本主进程）就整块不显示，不占位、不报错
    if (!info) return;

    const crashed = !!info.lastSessionCrashed;
    const hasLog = info.count > 0;

    const detail = div('set-row-detail');
    detail.style.display = 'none';
    detail.style.marginTop = '8px';

    const viewBtn = btn(T('crash.view'), 'btn-sm btn-secondary', async () => {
      if (detail.style.display === 'none') {
        try {
          const r = await invoke(Channels.CHANNELS.APP.CRASH_READ, 32 * 1024);
          detail.innerHTML = '';
          if (!r || !r.text) {
            detail.appendChild(div('field-hint', T('crash.empty')));
          } else {
            if (r.truncated) detail.appendChild(div('field-hint', T('crash.truncated')));
            // 用 <pre> 而不是 div：日志里的缩进与换行必须原样保留，
            // 堆栈一旦折行就没法看了。用户选择复制，所以不设 user-select:none。
            const pre = h('pre', { class: 'crash-log' }, r.text);
            detail.appendChild(pre);
          }
        } catch (e) {
          detail.innerHTML = '';
          detail.appendChild(div('field-err', T('crash.readFail', { err: (e && e.message) || String(e) })));
        }
        detail.style.display = 'block';
      } else {
        detail.style.display = 'none';
      }
    });
    /* data 属性只为可测性：文案随语言变（"查看" / "View"），
     * 测试按文本找按钮在英文界面下会失效。 */
    viewBtn.dataset.crashView = '1';

    const row = div('set-row', div('',
      div('set-label', hasLog || crashed ? T('crash.title') : T('crash.titleEmpty')),
      div('set-desc', hasLog
        ? T('crash.descCount', { n: info.count, size: fmtBytes(info.totalBytes) })
        : T('crash.descNone')),
      // 上次异常退出是一次性提示：这次启动告诉用户，之后就该消失
      crashed ? div('set-desc', { style: { color: 'var(--warning)', marginTop: '2px' } }, icon('alert'), T('crash.lastAbnormal')) : null
    ));
    const ctl = div('set-control', { style: { display: 'flex', gap: '6px' } });
    if (hasLog) ctl.appendChild(viewBtn);
    ctl.appendChild(btn(T('crash.openDir'), 'btn-sm btn-text', async () => {
      try { await invoke(Channels.CHANNELS.APP.CRASH_REVEAL); } catch (e) { toast(e.message, 'error'); }
    }));
    if (hasLog) {
      ctl.appendChild(btn(T('crash.clear'), 'btn-sm btn-text', async () => {
        if (!(await confirmBox({ title: T('crash.clear'), message: T('crash.clearConfirm'), okText: T('crash.clear') }))) return;
        try {
          const n = await invoke(Channels.CHANNELS.APP.CRASH_CLEAR);
          toast(T('crash.cleared', { n: n }), 'success');
          render();
        } catch (e) { toast(e.message, 'error'); }
      }));
    }
    row.appendChild(ctl);
    body.appendChild(row);
    body.appendChild(detail);
  }

  /* ============ 关于（设置页的一个分区，不再是独立页面） ============
     原来「关于」是侧栏一级入口、独占一整页，但内容只有版本号、运行环境三行
     和「检查更新」，一页装这点东西太薄，还多占一个导航位。
     现在作为设置的第五个分区，复用同一套 set-row 排版。
     注意：它仍然是**唯一的版本/更新入口**，别处不要再放检查更新。 */
  async function drawAbout(body, token) {
    let info;
    try { info = await invoke(Channels.CHANNELS.APP.GET_INFO); }
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
    invoke(Channels.CHANNELS.UPDATE.CLEANUP).then((r) => {
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
      /* 【dlId / unsub 必须在 try 之外声明 —— 这不是风格问题，是正确性问题】
       * let 是块级作用域：写在 try 里面，finally 就是另一个块，读不到它，
       * 运行时会抛 `ReferenceError: dlId is not defined`（是抛错，不是 undefined）。
       *
       * 后果比「变量为空」严重得多：
       *   · finally 里排在 dlId 后面的 `updUnsub = unsub;` 永远执行不到 ——
       *     那句「失败路径也要退订」的注释完全落空，监听器就一直挂在这个页面上；
       *   · try 里的 return 被 finally 抛出的异常顶掉，checkUpdate 每次都以
       *     rejected promise 结束（调用方拿不到正常返回值）；
       *   · 用户完全看不见：UI 文案在抛错之前就已经写进 updLine 了。 */
      let dlId = null;
      let unsub = null;
      try {
        const r = await invoke(Channels.CHANNELS.UPDATE.CHECK, { force: true });
        if (r.throttled) { updLine.textContent = T('update.throttled', { s: r.retryAfter, v: r.latest }); return; }
        if (!r.hasUpdate) { updLine.textContent = T('update.latest', { v: r.current }); return; }
        updLine.textContent = T('update.found', { latest: r.latest, current: r.current });
        if (!r.assetUrl) { updLine.textContent = T('update.manual', { latest: r.latest, url: r.htmlUrl }); return; }
        const out = info.userData + '/update/' + r.assetName;
        // job:stream 是全局通道：TTS/ffmpeg/卸载等任务也会广播 {done:true} 或 {pct}。
        // 不比对 id 就会把别人的退出事件当成下载失败（显示“✗ 下载失败：undefined”），
        // 进度数字也会被别的任务污染。先拿到 dl.id 再比对，拿到之前只缓冲不显示。
        // （dlId 在 try 之外已声明 —— 这里不能再写 let，那会遮蔽外层变量，
        //   finally 照样读到永远为 null 的外层那份。见 checkUpdate 开头的说明。）
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
            updActions.appendChild(btn(T('update.confirmOk'), 'btn-sm btn-primary', async () => {
              if (!(await confirmBox({ title: T('update.confirmTitle'), message: T('update.confirmMsg', { v: r.latest }), okText: T('update.confirmOk') }))) return;
              try {
                const ap = await invoke(Channels.CHANNELS.UPDATE.APPLY, { newExe: out });
                updLine.textContent = T('update.applying');
                if (ap && ap.rollbackScript) updActions.appendChild(div('field-hint', T('update.rollbackScript', { path: ap.rollbackScript })));
              } catch (e) { updLine.textContent = T('update.applyFail', { err: e.message }); }
            }, 'send'));
            updActions.appendChild(btn(T('update.openDir'), 'btn-sm btn-secondary', () => invoke(Channels.CHANNELS.FS.SHOW_ITEM, out).catch(() => {})));
          } catch (e) {}
        }
        // 先把这份包登记为“待安装”，update:cleanup 见到它就不会删
        await invoke(Channels.CHANNELS.UPDATE.MARK_PENDING, r.assetName).catch(() => {});
        const dl = await invoke(Channels.CHANNELS.NET.DOWNLOAD, { url: r.assetUrl, out });
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
    // 高危能力的名称/描述也在主进程（CAP_TEXT）—— 那些字符串会被
    // 设置页的能力清单与「部分锁」提示卡直接显示，所以切完语言要
    // **重新拉一次**缓存，否则它们还停在旧语言（托盘是英文、能力名还是中文）。
    // 顺序是硬的：先让主进程切好语言，再读它返回的文案。
    if (isDesktop) {
      invoke(Channels.CHANNELS.APP.SET_LANG, lang)
        .catch(() => {})
        .then(() => loadDangerousState())
        .catch(() => {});
    }
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
    /* 【切语言必须清空保活表】
     * 保活表里存的是**已渲染好的 DOM 节点**，文案在渲染那一刻就定死了。
     * 整壳重建（body.innerHTML=''）之后那些节点变成了游离节点，
     * 切回工具页时原样贴回去 —— 结果是英文界面里冒出中文页面。
     * 实测：test-tool-i18n-e2e 的「二维码」「哈希」两条直接红
     * （`二维码页英文模式下仍有中文：["内容","二维码","保存 PNG",…]`）。
     *
     * 这些被清掉的页面用户看不到（壳刚重建过），所以直接丢弃即可，
     * 不需要先 runPageCleanup —— 上面 themeListeners / shellCleanup 已经把
     * 全局监听收口了。 */
    keepAlive.clear();
    document.body.innerHTML = '';
    buildShell();
    applyTheme();
    state.view = keepView;
    state.tabs = keepTabs;
    /* 独立窗的窗口标题是工具名，工具名跟着语言变（name / nameEn）。
     * 重建之后必须重设一次，否则英文界面下窗口标题还停在中文。 */
    setDocTitle();
    render();
  }

  /* ============ 启动 ============ */
  window.App = {
    openTool, showView, toggleFavorite, setStatus, state, refresh, onCleanup,
    applyLang,
    openSettings
  };
  /* 跳到设置页的指定分区（如 'danger' 高危功能），可选定位到一个具体开关。
   * 供其他工具在「被高危门禁拦住」时给出可点的引导，
   * 而不只是弹一句 toast 让用户自己去猜开关在哪。
   *
   * 【为什么还要定位到具体那一行】
   * 早先这里只设分区，用户点「前往设置 → 高危功能」之后看到的是一整屏开关
   * （删除文件 / 清理垃圾 / 取得所有权 / 编辑 hosts / 写注册表…），
   * 而提示语只说「本工具的『删除文件』需要开启」—— 名字对得上，
   * 但用户仍要在十几行里逐个读标签去找那一行。
   * 现在带上能力 id，跳过去之后滚到那一行并闪一下高亮，
   * 用户落地的位置就是他要操作的地方。
   *
   * @param {string} [section] 分区 id（general/appearance/danger/data/about）
   * @param {string|null} [capId] 高危能力 id（如 'file-delete'）；只在 section 为 danger 时有意义
   */
  function openSettings(section, capId) {
    if (typeof section === 'string' && section) settingsSection = section;
    /* 【定位请求必须先记在模块级】showView → render → renderSettings 是一条
     * 同步链路，drawDanger 又要在开关渲染完之后才滚动 —— 中间隔着一次 await
     * （它要先问主进程要能力清单）。用模块级变量把意图带过去，
     * 比往整条链路里传参数改动面小得多。 */
    focusDangerCap = (typeof capId === 'string' && capId) ? capId : null;
    showView({ type: 'settings' });
  }
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
    /* 订阅全局界面偏好的广播。**必须在这里订阅一次**（而不是在 buildShell 里）：
     * 它要跨整壳重建存活，见 bindUiPrefs 的说明。
     * 放在 applyTheme 之后：先按本地缓存/存储把外观定下来，
     * 再开始接受"别处改了"的通知，不会出现先收到广播、又被本地值盖回去。 */
    bindUiPrefs();
    bindUpdateAvailable();
    installNumberWheelGuard();
    /* 全局拖拽：把文件拖到窗口任意位置 → 按扩展名路由到能处理的工具。
     * 只绑一次（它自己挂的是 document 级监听器，重复绑会让一次拖拽
     * 被处理多遍，弹出多个选择面板）。 */
    try { if (window.DropOpen && window.DropOpen.bind) window.DropOpen.bind(); } catch (e) { console.warn('drop bind', e); }
    /* 剪贴板动作面板（Ctrl+Shift+V）。
     * 【只绑窗口内快捷键，不注册 globalShortcut】
     * globalShortcut 是系统级的：注册了 Ctrl+Shift+V 之后，用户在浏览器里
     * 按 Ctrl+Shift+V（Chrome 的"粘贴为纯文本"）会被我们抢走，那是越权。
     * 所以只在本应用窗口内响应，见 js/clip-actions.js 的说明。 */
    try { if (window.ClipActions && window.ClipActions.bind) window.ClipActions.bind(); } catch (e) { console.warn('clip bind', e); }
    /* 保活上限要在第一次 render 之前读出来，否则首批打开的页会按默认 6 算。
     * 读失败就用默认值 —— 这个设置纯属偏好，不该影响启动。 */
    try {
      const kaLimit = await invoke(Channels.CHANNELS.STORE.GET, 'settings.keepAlive', 6);
      applyKeepAliveLimit(kaLimit);
    } catch (e) { /* 用默认 6 */ }
    /* 其余可调偏好（剪贴板条数、最近使用、拖拽深度…）一次性拉全量到内存。
     * 【必须在第一次 render 之前】首页要按 recentLimit 决定显示几个，
     * 拖拽上限也要在用户第一次拖东西时就是对的。 */
    try { await Prefs.load(); } catch (e) { console.error('读取偏好失败，用默认值', e); }
    await loadUserData();
    await loadDangerousState();
    /* 独立窗口直接打开指定工具。
     * 【必须在 render() 之前设好 state.view】render 会按 state.view 画内容，
     * 先 render 一次首页再切工具页的话，用户会看到一次首页闪过去
     * （工具页是 async 渲染，中间那一帧是可见的）。 */
    if (IS_STANDALONE) {
      state.view = { type: 'tool', toolId: bootParams.tool };
      /* 独立窗不维护标签列表：它只有一个工具，标签栏也是空的不显示。
       * 但仍然 push 进 tabs —— 有些工具页会读 state.tabs 判断"我是不是当前标签"
       * （见 renderTabs 里对 state.view.toolId 的比对）。
       * 保持与"用主窗打开一个工具"一致的状态，工具页代码一行都不用改。 */
      state.tabs = [bootParams.tool];
      /* 文档标题 = 工具名。主进程创建窗口时已经设过一次 title，
       * 但那之后页面加载完成会用 <title> 里的「核核工具箱」把它盖掉
       * （Electron 默认把 document.title 同步到窗口标题）。
       * 所以渲染层必须再设一次 —— 否则三个独立窗口在任务栏/Alt+Tab 里
       * 又是三个同名条目，等于主进程那次改动白做。 */
      setDocTitle();
    }
    render();

    /* 数据文件损坏时必须主动告知。
     * 主进程在 loadStore 解析失败时会禁用清扫并另存一份原文件，
     * 但用户看到的现象只是「笔记/收藏/剪贴板全空了」—— 不说清楚的话，
     * 只会以为程序把数据弄丢了，然后继续用空数据把原文件覆盖掉。
     * 正常启动时 storeLoadFailed 为 false，这里什么都不做。 */
    try {
      const health = await invoke(Channels.CHANNELS.STORE.HEALTH);
      if (health && health.ok === false) {
        toast('数据文件损坏，已从默认值启动；原文件已另存为 ' +
          (health.corruptCopy ? health.corruptCopy.split(/[\\/]/).pop() : '同目录备份'), 'error', 12000);
        console.error('[store] 数据文件损坏。原文件副本：', health.corruptCopy || '(另存失败)', '当前数据文件：', health.file);
      }
    } catch (e) { /* 老版本主进程没有这条通道，忽略 */ }

    let savedLang = null;
    try { savedLang = await invoke(Channels.CHANNELS.STORE.GET, 'settings.lang', null); } catch (e) {}
    if (savedLang && savedLang !== lang && (window.i18n ? window.i18n.normalize(savedLang) : savedLang)) {
      applyLang(savedLang);
      applyLangLabels();
    }
  });
})();
