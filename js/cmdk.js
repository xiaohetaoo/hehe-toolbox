/* 模块：全局命令面板（Ctrl+K）
 *
 * 【为什么单独做一个面板，而不是把首页搜索框搬过来】
 * 首页搜索只在首页可用；标题栏搜索只搜工具名，且不显示所属模块与快捷键。
 * 106 个工具的工具箱里，「输入两个字直达」是最高频的操作 ——
 * 它值得一个不依赖当前页面的浮层：无论在看哪个工具，Ctrl+K 都能唤起。
 *
 * 【搜索逻辑一行都不重写】
 * 排序/拼音/英文名/精确加成全在 Registry.search 里（那是 v0.5 起逐步
 * 调出来的，含大量实测注释）。这里只负责「把结果画出来 + 键盘导航」，
 * 排序规则只有一份 —— 两份会让两处搜索给出不同顺序，用户会以为坏了。
 *
 * 【命令不只是工具】
 * 面板里还能执行「返回首页」「打开设置」「切换主题」「切换语言」这类动作。
 * 它们与工具有同一个形状（id/name/desc/run），所以能共用一套搜索与渲染；
 * 关键词里塞了同义词（"设置" / "settings" / "偏好"），否则用户按英文搜不到。
 */
(function () {
  const { h, icon } = window.ui;
  /* 【不依赖 App 的本地化包装，直接用 Registry 的三个底层函数】
   * app.js 里的 TN/TD/MN 是它自己的闭包（`const TN = (t) => R.toolName(t)`），
   * 没有导出 —— 而它们本来就只是 Registry.toolName/toolDesc/modName 的薄包装。
   * 面板直接调底层，既不用改 app.js 的导出面，也不会因为壳重建而失效。 */
  const toolLabel = (t) => (window.Registry.toolName ? window.Registry.toolName(t) : (t && t.name) || '');
  const toolDesc = (t) => (window.Registry.toolDesc ? window.Registry.toolDesc(t) : (t && (t.desc || t.descEn)) || '');
  const modLabel = (m) => (window.Registry.modName ? window.Registry.modName(m) : m || '');

  /* 「动作」类命令：与工具同形状，但 run 直接执行 */
  const ACTIONS = [
    {
      id: '@home', name: '返回首页', nameEn: 'Go Home', icon: 'home',
      keywords: ['首页', 'home', '主页', '开始'],
      run: () => window.App.showView({ type: 'home' }),
    },
    {
      id: '@settings', name: '打开设置', nameEn: 'Open Settings', icon: 'settings',
      keywords: ['设置', 'settings', '偏好', 'preferences', '选项', '配置'],
      run: () => window.App.openSettings(),
    },
    {
      id: '@fav', name: '我的收藏', nameEn: 'Favorites', icon: 'star',
      keywords: ['收藏', 'favorites', 'star', '书签'],
      run: () => window.App.showView({ type: 'fav' }),
    },
    {
      id: '@theme', name: '切换深色 / 浅色主题', nameEn: 'Toggle Theme', icon: 'moon',
      keywords: ['主题', 'theme', '深色', '暗色', 'dark', '浅色', 'light', '外观'],
      run: () => window.App.toggleTheme && window.App.toggleTheme(),
    },
    {
      id: '@lang', name: '切换界面语言', nameEn: 'Switch Language', icon: 'globe',
      keywords: ['语言', 'language', '中文', 'english', '英文', 'i18n'],
      run: () => window.App.toggleLang && window.App.toggleLang(),
    },
  ];

  /* 面板状态。做成模块级单例 —— 面板是「除了正在编辑的输入框，
   * 全局只有一个」的 UI，不需要每个页面一份。 */
  let mask = null;      // 遮罩层（含面板本体）
  let inputEl = null;
  let listEl = null;
  let items = [];       // 当前结果对应的命令对象
  let hlIndex = 0;      // 键盘高亮的下标

  /* 把命令统一成「有 name/nameEn/keywords」的形状去匹配。
   * 工具对象本来就有这些字段（Registry 的元数据），动作对象是我们自己写的。 */
  function haystack(cmd) {
    const parts = [cmd.name || '', cmd.nameEn || '', cmd.desc || '', cmd.descEn || ''];
    if (Array.isArray(cmd.keywords)) parts.push(cmd.keywords.join(' '));
    return parts.join(' ').toLowerCase();
  }

  /* 本地化名称：动作用固定中文；工具走 Registry 的本地化包装（英文界面显示英文名） */
  function label(cmd) {
    return cmd.id && cmd.id.startsWith('@') ? (cmd.name || '') : toolLabel(cmd);
  }
  function subLabel(cmd) {
    if (cmd.id && cmd.id.startsWith('@')) return cmd.nameEn || '';
    /* 【cmd.module 是字符串 id，modName 要的是模块对象】直接传 id 进去，
     * modName 读 m.name/m.nameEn 全是 undefined —— 模块名静默丢失，
     * 副标题只剩描述。先按 id 查出模块对象再取本地化名。 */
    const modObj = cmd.module ? window.Registry.MODULES.find((m) => m.id === cmd.module) : null;
    const mod = modObj ? modLabel(modObj) : '';
    const d = toolDesc(cmd);
    return mod && d ? mod + ' · ' + d : (mod || d);
  }

  /* 【匹配策略】先用 Registry.search 拿工具（它含拼音与精确加成），
   * 再按关键词过滤动作。两者按「精确名命中优先」合并排序：
   * 用户敲 "设置" 时应该先看到「打开设置」而不是名字里含"设置"的工具。 */
  function query(raw) {
    const q = String(raw || '').trim();
    const actionHits = q
      ? ACTIONS.filter((a) => haystack(a).includes(q.toLowerCase()))
      : ACTIONS.slice(0, 3);
    const toolHits = q ? window.Registry.search(q) : window.Registry.all.slice(0, 7);

    /* 精确名（中文名或英文名完全等于输入）的动作提到最前 */
    const ql = q.toLowerCase();
    actionHits.sort((a, b) => {
      const ea = (a.name === q || (a.nameEn || '').toLowerCase() === ql) ? 0 : 1;
      const eb = (b.name === q || (b.nameEn || '').toLowerCase() === ql) ? 0 : 1;
      return ea - eb;
    });
    return actionHits.concat(toolHits).slice(0, 12);
  }

  function paint(raw) {
    items = query(raw);
    hlIndex = 0;
    listEl.innerHTML = '';
    if (!items.length) {
      listEl.appendChild(h('div', { class: 'cmdk-empty' }, '没有匹配的工具或命令'));
      return;
    }
    items.forEach((cmd, i) => {
      const isAction = cmd.id && cmd.id.startsWith('@');
      const row = h('div', { class: 'cmdk-row' + (i === 0 ? ' hl' : '') });
      /* 图标：工具用自己的 icon，动作用内置名。
       * 图标缺失时不报错 —— icon() 对未知名返回空 SVG，比中断渲染好。 */
      try { row.appendChild(icon(cmd.icon || 'tool')); } catch (e) { /* 图标是装饰 */ }
      const main = h('div', { class: 'cmdk-main' });
      main.appendChild(h('div', { class: 'cmdk-name' }, label(cmd)));
      const sub = subLabel(cmd);
      if (sub) main.appendChild(h('div', { class: 'cmdk-sub' }, sub));
      row.appendChild(main);
      if (isAction) row.appendChild(h('span', { class: 'cmdk-tag' }, '命令'));
      /* 行是 div：必须自己处理键盘可达性，否则 Tab 走不到（与搜索结果行同一问题） */
      window.ui.makeButtonLike(row, label(cmd));
      row.addEventListener('click', () => run(cmd));
      row.addEventListener('mouseenter', () => {
        hlIndex = i;
        [...listEl.children].forEach((el, k) => el.classList.toggle('hl', k === i));
      });
      listEl.appendChild(row);
    });
  }

  function run(cmd) {
    close();
    try {
      if (cmd.id && cmd.id.startsWith('@')) cmd.run();
      else window.App.openTool(cmd.id);
    } catch (e) {
      /* 命令失败不能让面板卡死：先关面板再报错，用户能继续操作 */
      window.ui.toast(e.message || String(e), 'error');
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      hlIndex = (hlIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      [...listEl.children].forEach((el, i) => el.classList.toggle('hl', i === hlIndex));
      const el = listEl.children[hlIndex];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const target = items[hlIndex] || items[0];
      if (target) run(target);
    }
  }

  function close() {
    if (!mask) return;
    /* 按键监听挂在 document 上，关闭时必须摘掉，否则面板关了还在劫持 Esc。 */
    try { document.removeEventListener('keydown', onKey); } catch (e) {}
    const m = mask;
    mask = null; inputEl = null; listEl = null; items = [];
    m.classList.remove('show');
    /* 动画结束后再摘 DOM：立刻 remove 会让关闭没有过渡 */
    setTimeout(() => { try { m.remove(); } catch (e) {} }, 160);
  }

  function open() {
    if (mask) { if (inputEl) inputEl.focus(); return; }
    mask = h('div', { class: 'cmdk-mask' });
    const panel = h('div', { class: 'cmdk-panel' });
    const head = h('div', { class: 'cmdk-head' });
    inputEl = h('input', {
      class: 'cmdk-input', type: 'text', spellcheck: 'false', autocomplete: 'off',
      placeholder: '搜索工具或命令（输入即搜，↑↓ 选择，回车直达）',
    });
    inputEl.setAttribute('aria-label', '搜索工具或命令');
    head.appendChild(icon('search'));
    head.appendChild(inputEl);
    head.appendChild(h('span', { class: 'cmdk-esc' }, 'Esc'));
    panel.appendChild(head);
    listEl = h('div', { class: 'cmdk-list' });
    panel.appendChild(listEl);
    panel.appendChild(h('div', { class: 'cmdk-foot' },
      h('span', null, '↑↓ 选择'), h('span', null, '↵ 打开'), h('span', null, 'Esc 关闭')));
    mask.appendChild(panel);
    /* 点遮罩空白处关闭（与搜索下拉同一交互）：点在面板上不关 */
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
    inputEl.addEventListener('input', () => paint(inputEl.value));
    /* 【按键必须挂在 document，不能只挂输入框】
     * 第四轮审查：结果行是 div + makeButtonLike（带 tabindex=0），按 Tab
     * 就能把焦点移出行；此时 input 的 keydown 收不到事件 → Esc 关不掉、
     * ↑↓ 不移动，用户只能再按一次 Ctrl+K 或点遮罩。鼠标点击列表空白处
     * （焦点回到 body）同样会死。
     * 挪到 document 上后，无论焦点在输入框、某一行还是 body 都生效；
     * 关闭时同步摘掉（见 close）。 */
    document.addEventListener('keydown', onKey);
    document.body.appendChild(mask);
    /* 下一帧再加 show：同帧加类，transition 不会触发，面板是"闪现"出来的 */
    requestAnimationFrame(() => { if (mask) mask.classList.add('show'); });
    paint('');
    inputEl.focus();
  }

  function toggle() {
    if (mask) close(); else open();
  }

  window.CmdPalette = { open, close, toggle, isOpen: () => !!mask };
})();
