/* 全局拖拽：把文件拖到窗口任意位置，自动路由到能处理它的工具。
 *
 * ============ 为什么单独一个文件 ============
 * app.js 已经 3000 多行，而这个功能有完整的生命周期（拖拽遮罩、路由计算、
 * 选择面板、防抖与清理），塞进 app.js 会让那个文件更难读。
 *
 * ============ 与工具内 dropzone 的关系 ============
 * 工具页自己的 dropzone（ui.js 的 dropzone()）**优先级更高**：
 * 用户已经在「图片压缩」页里，往里拖图显然是要压缩，不该弹面板问。
 * 所以本模块的监听器挂在 document 上，但遇到「拖拽发生在 dropzone 内」
 * 时直接放行 —— 靠 stopPropagation 判断：dropzone 的 drop 处理器
 * 第一行就 stopPropagation，事件不会冒泡到这里。
 * 而 dragover 阶段两个都会收到，所以遮罩要检查 e.defaultPrevented。
 *
 * ============ 歧义策略（用户明确要求）============
 * 候选工具 ≥ 2 个时**一律弹选择面板**，不猜。
 * 猜错的代价是「打开错工具 → 还得退回来重来」，比让用户点一下更差。
 * 候选只有 1 个时直接打开，省掉那一次点击。
 */
(function () {
  'use strict';

  let dragDepth = 0;      // dragenter/dragleave 计数（子元素会反复触发）
  let overlay = null;     // 拖拽时的全屏提示层
  let busy = false;       // 正在处理上一批，忽略新的

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'drop-overlay';
    overlay.innerHTML = '<div class="drop-overlay-inner">'
      + '<div class="drop-overlay-icon"></div>'
      + '<div class="drop-overlay-title">松开以打开</div>'
      + '<div class="drop-overlay-sub"></div>'
      + '</div>';
    document.body.appendChild(overlay);
    return overlay;
  }

  function showOverlay(text, sub) {
    const o = ensureOverlay();
    const t = o.querySelector('.drop-overlay-title');
    const s = o.querySelector('.drop-overlay-sub');
    if (t) t.textContent = text || '松开以打开';
    if (s) s.textContent = sub || '';
    o.classList.add('on');
  }

  function hideOverlay() {
    if (overlay) overlay.classList.remove('on');
    dragDepth = 0;
  }

  /* 从 dataTransfer 里数出「有多少个条目」，用于拖拽时的即时提示。
   * 【不能读文件内容】dragover 阶段只能读元数据，读内容会被浏览器拒绝。 */
  function countItems(dt) {
    try {
      const items = dt && dt.items;
      if (items && items.length) return items.length;
      const files = dt && dt.files;
      return files ? files.length : 0;
    } catch (e) { return 0; }
  }

  /* dragover 阶段能不能给出预判文案？
   * 可以：dataTransfer.items 的 type 是 MIME，而我们要的是扩展名，拿不到。
   * 所以 dragover 只显示「松开以打开」，真正的路由在 drop 时算。 */

  function bind() {
    /* 【幂等保护】切换界面语言会整壳重建，app.js 会再次调 bind()。
     * document 级监听器挂一次就要一份：不加这个标记，切 N 次语言后
     * 一次拖拽会触发 N 次路由 —— 弹出 N 个选择面板。
     * （clip-actions.js 的 bind 有同样的标记，两处必须一致。） */
    if (window.__dropOpenBound) return;
    window.__dropOpenBound = true;
    /* 【dragover 必须 preventDefault，否则 drop 根本不触发】
     * 这是 HTML5 拖放的既定行为：不阻止默认动作的 dragover 会让元素
     * 变成"不接受拖放"，drop 事件永远不会来。 */
    document.addEventListener('dragover', (e) => {
      /* 工具页自己的 dropzone 已经处理了（它 stopPropagation 过的不回冒泡，
       * 但 dragover 阶段两个监听器都会跑，靠 defaultPrevented 区分） */
      if (e.defaultPrevented) return;
      if (!e.dataTransfer) return;
      /* 只接文件，不接页面内拖的文本/链接 —— 后者是文本选择，
       * 全屏遮罩会很烦人。判据：types 里有 Files。 */
      const types = e.dataTransfer.types || [];
      const hasFiles = Array.prototype.indexOf.call(types, 'Files') >= 0;
      if (!hasFiles) return;
      e.preventDefault();
      const n = countItems(e.dataTransfer);
      showOverlay('松开以打开', n > 0 ? (n + ' 个项目') : '');
    }, false);

    document.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer) return;
      const types = e.dataTransfer.types || [];
      if (Array.prototype.indexOf.call(types, 'Files') < 0) return;
      dragDepth++;
    }, false);

    document.addEventListener('dragleave', (e) => {
      if (!e.dataTransfer) return;
      dragDepth--;
      /* 【dragleave 会为每个子元素触发】
       * 用深度计数而不是"一离开就隐藏"：鼠标从 body 移到某个 div 上时
       * 会先触发 body 的 leave、再触发 div 的 enter，一离开就隐藏会让
       * 遮罩疯狂闪烁。计数归零才真的隐藏。 */
      if (dragDepth <= 0) hideOverlay();
    }, false);

    document.addEventListener('drop', async (e) => {
      if (e.defaultPrevented) return;
      if (!e.dataTransfer) return;
      const types = e.dataTransfer.types || [];
      if (Array.prototype.indexOf.call(types, 'Files') < 0) return;
      e.preventDefault();
      hideOverlay();

      if (busy) return;
      const files = [...e.dataTransfer.files];
      if (!files.length) return;

      busy = true;
      try {
        await handleFiles(files);
      } catch (err) {
        if (window.ui && window.ui.toast) window.ui.toast('打开失败：' + (err && err.message || err), 'error');
      } finally {
        busy = false;
      }
    }, false);

    /* 拖拽到窗口外时（比如拖出浏览器窗口再松手）不会收到 drop，
     * 但也不会收到配对的 dragleave，遮罩会卡住。窗口失焦时兜底隐藏。 */
    window.addEventListener('blur', hideOverlay);
    window.addEventListener('dragend', hideOverlay);
  }

  /* 展开目录 + 路由 + 打开。 */
  async function handleFiles(files) {
    const api = window.api;
    if (!api || typeof api.getPathForFile !== 'function') return;
    const ui = window.ui;
    const paths = files.map((f) => { try { return api.getPathForFile(f); } catch (e) { return null; } }).filter(Boolean);
    if (!paths.length) {
      if (ui) ui.toast('无法获取文件路径（可能是从网络拖入的）', 'error');
      return;
    }

    /* 展开目录：拖一个文件夹进来时，路由要按里面的文件算。
     * 用 ui 里已有的实现（它自己处理上限与提示）。 */
    let expanded;
    try {
      expanded = await ui.expandDroppedPaths(paths);
    } catch (e) {
      expanded = { files: paths, dirs: 0 };
    }
    const real = (expanded && expanded.files && expanded.files.length) ? expanded.files : paths;
    if (expanded && expanded.dirs) {
      /* 【不传上限，让 expandNotice 自己读】
       * 原来这里写 (expanded, 0, 0) —— 把上限硬编码成 0，
       * 用户拖超大文件夹触顶时看到「已达到 **0** 个文件的上限」。
       * expandNotice 现在缺省自取 Prefs 里的真实值（与工具页内 dropzone
       * 走同一份配置），所以这里不再需要知道上限是多少。 */
      const notice = ui.expandNotice ? ui.expandNotice(expanded) : '';
      if (notice) ui.toast(notice, 'warn', 5000);
      else ui.toast('已从 ' + expanded.dirs + ' 个文件夹展开 ' + real.length + ' 个文件', 'info', 2500);
    }

    const Route = window.DropRoute;
    if (!Route) return;
    const r = Route.route(real);

    if (!r.candidates.length) {
      const exts = r.exts.length ? r.exts.join('、') : '（无扩展名）';
      ui.toast('没有工具能处理这个类型：' + exts, 'warn', 4000);
      return;
    }

    /* ① 唯一候选 → 直接打开，并把这批文件交过去 */
    if (r.candidates.length === 1) {
      openWithTool(r.candidates[0], real, r);
      return;
    }

    /* ② 多候选 → 弹选择面板（用户明确要求：歧义直接给面板，不猜） */
    showPicker(real, r);
  }

  /* 把文件交给工具页。
   *
   * 【交接方式：全局待处理队列 + 打开工具页】
   * 工具页是同步 render 的，此时文件还没到它手里。所以：
   *   · 把路径放进 window.__pendingDrop（工具页 render 时自取）；
   *   · 打开工具页；
   *   · 工具页消费后自动清空，不会串到下一次。
   * 之所以不做成「事件广播」：工具页注册监听的时机不确定（render 前后都可能），
   * 广播会漏掉还没注册的页面。队列是"只放一次、谁要谁取"，天然免疫时序问题。
   *
   * 已经打开的标签页会被重新 render（openTool 走 showView），
   * 所以不需要额外处理"这个工具已经开着"的情况。 */
  function openWithTool(toolId, paths, routeInfo) {
    /* 【入队时记下目标工具】取用侧要按它过滤，见 takePending 的说明。 */
    window.__pendingDrop = {
      toolId,
      paths: paths.slice(),
      exts: (routeInfo && routeInfo.exts) || [],
      at: Date.now(),
    };
    try {
      window.App.openTool(toolId);
    } catch (e) {
      const ui = window.ui;
      if (ui) ui.toast('打开工具失败：' + (e && e.message || e), 'error');
    }
  }

  /* 歧义选择面板：列出所有候选工具，第一个预选中、回车直达。 */
  function showPicker(paths, r) {
    const ui = window.ui;
    const R = window.Registry;
    if (!ui || !R) return;

    const exts = r.exts.join('、');
    const body = document.createElement('div');

    body.appendChild(ui.div('field-hint',
      '共 ' + paths.length + ' 个文件（' + exts + '），有以下工具可以处理。选择要打开的那个：'));

    const listWrap = ui.div('drop-pick-list');
    /* 【按扩展名分组展示候选】用户拖了混合类型时（比如 png + pdf），
     * 一个扁平列表会让人搞不清哪个工具能处理哪部分。
     * 分组后一眼能看出「这些图归图片工具、这个 PDF 归 PDF 工具」。 */
    if (r.exts.length > 1) {
      for (const ext of r.exts) {
        const cands = r.byExt[ext] || [];
        if (!cands.length) continue;
        listWrap.appendChild(ui.div('drop-pick-group', '扩展名 .' + ext));
        for (const id of cands) {
          listWrap.appendChild(makeRow(id, paths, r));
        }
      }
    } else {
      /* 单一扩展名：按 route() 排好的顺序，最可能的排第一 */
      for (const id of r.candidates) {
        listWrap.appendChild(makeRow(id, paths, r));
      }
      /* 同一批文件里还有别的扩展名能处理（比如普通 png 之外挂了个 exe），
       * 那些工具也要列出来，否则用户没法用它们处理那一个文件 */
      const listed = new Set(r.candidates);
      for (const ext of r.exts) {
        for (const id of (r.byExt[ext] || [])) {
          if (!listed.has(id)) { listed.add(id); listWrap.appendChild(makeRow(id, paths, r)); }
        }
      }
    }
    body.appendChild(listWrap);

    /* 【默认选中第一个】
     * 多数量场景下第一个就是对的，用户直接回车即可，
     * 不需要读完整列表。 */
    let selected = r.candidates[0];
    function refreshSel() {
      for (const row of listWrap.querySelectorAll('.drop-pick-row')) {
        row.classList.toggle('on', row.dataset.toolId === selected);
      }
    }
    body.addEventListener('click', (e) => {
      const row = e.target.closest && e.target.closest('.drop-pick-row');
      if (row) { selected = row.dataset.toolId; refreshSel(); }
    });
    body.addEventListener('dblclick', (e) => {
      const row = e.target.closest && e.target.closest('.drop-pick-row');
      if (row) { selected = row.dataset.toolId; confirm(); }
    });
    /* 方向键上下切换，回车确认 —— 不用鼠标即可完成 */
    body.addEventListener('keydown', (e) => {
      const ids = r.candidates.concat(
        [...listWrap.querySelectorAll('.drop-pick-row')].map((x) => x.dataset.toolId)
      ).filter((v, i, a) => a.indexOf(v) === i);
      const at = ids.indexOf(selected);
      if (e.key === 'ArrowDown') { e.preventDefault(); selected = ids[(at + 1) % ids.length]; refreshSel(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); selected = ids[(at - 1 + ids.length) % ids.length]; refreshSel(); }
      else if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    });

    function confirm() {
      m.close();
      openWithTool(selected, paths, r);
    }

    const m = ui.modal({
      title: '用什么工具打开？',
      width: 460,
      body: body,
      foot: [
        ui.btn('取消', 'btn-secondary', () => m.close()),
        ui.btn('打开', 'btn-primary', confirm, 'external'),
      ],
    });
    refreshSel();
    /* 焦点给面板本身，方向键与回车才生效 */
    setTimeout(() => { try { body.setAttribute('tabindex', '0'); body.focus(); } catch (e) {} }, 0);
    return m;
  }

  function makeRow(toolId, paths, r) {
    const ui = window.ui;
    const R = window.Registry;
    const t = R.get(toolId);
    const row = ui.div('drop-pick-row');
    row.dataset.toolId = toolId;
    row.appendChild(ui.div('drop-pick-row-icon', ui.icon(t && t.icon || 'file')));
    const info = ui.div('drop-pick-row-info');
    info.appendChild(ui.div('drop-pick-row-name', (R.toolName ? R.toolName(t) : (t && t.name)) || toolId));
    /* 说明这个工具能处理这批文件里的哪几种扩展名 —— 混合拖拽时这是
     * 用户判断"该选哪个"的主要依据。 */
    const handled = r.exts.filter((e) => (r.byExt[e] || []).indexOf(toolId) >= 0);
    info.appendChild(ui.div('drop-pick-row-desc',
      (handled.length ? '可处理 .' + handled.join('、.') + '　' : '')
      + ((t && (R.toolDesc ? R.toolDesc(t) : t.desc)) || '')));
    row.appendChild(info);
    if (ui.makeButtonLike) ui.makeButtonLike(row, '用「' + ((t && t.name) || toolId) + '」打开');
    return row;
  }

  /* 工具页取待处理文件（由工具页在 render 里调用）。
   *
   * @param {string} toolId 工具 id —— 只有发起方是它时才返回，避免串页
   * @param {number} [maxAge] 超过这个毫秒数就当作过期（防止很久以后
   *   用户打开同一个工具时突然冒出上次拖的文件）
   * @returns {{paths:string[], exts:string[]}|null}
   */
  /* 取出待处理的拖拽文件。
   *
   * 【必须按 toolId 过滤，否则"避免串页"只是注释里的承诺】
   * 原来的实现从头到尾没读过 toolId —— 任何工具调用都会取走全局队，
   * 注释却写着「只有发起方是它时才返回」。于是出现这种串页：
   * 拖文件给工具 A，A 的 picker 还没消费，用户先切到工具 B，
   * B 的 filePicker 就把本该属于 A 的文件取走了。
   *
   * 【为什么"取完即清空 + 30 秒过期"不足以替代过滤】
   * 那两条只解决"陈旧队列被反复读取"和"半小时前的拖拽突然生效"，
   * 解决不了"另一个工具先到"。两个工具在同一个 tick 里争抢时，
   * 后缀条件完全不起作用。所以按 id 过滤是必要的，不是冗余。
   *
   * 【队列不因不匹配而清空】只返回 null、保留队列 ——
   * 用户切到 B 之后很可能再切回 A，A 的文件还在等着。 */
  function takePending(toolId, maxAge) {
    const p = window.__pendingDrop;
    if (!p) return null;
    const age = Date.now() - (p.at || 0);
    /* 过期就整条丢掉（与过滤无关：老队列对谁都没用） */
    if (age > (maxAge || 30000)) { window.__pendingDrop = null; return null; }
    /* 【只有入队时有 toolId 才过滤】面板送图片的路径（app.js 里
     * window.__pendingDrop = { paths: [], exts: [], dataUrl, at })
     * 不带 toolId —— 那种是"谁先看到谁用"，保持原行为。
     * 有 toolId 时严格比对，不匹配就不取、也不清空。 */
    if (p.toolId && toolId && p.toolId !== toolId) return null;
    window.__pendingDrop = null;
    return { paths: p.paths || [], exts: p.exts || [] };
  }

  const API = { bind, takePending, showPicker, openWithTool };
  /* 只挂 window：js/** 是纯浏览器环境（eslint 的 browser globals 里没有
   * module），UMD 尾部会被判 no-undef。可单测的部分在 lib/drop-route.js。 */
  if (typeof window !== 'undefined') window.DropOpen = API;
})();
