/* 剪贴板动作面板（Ctrl+Shift+V）。
 *
 * ============ 它解决什么 ============
 * 用户复制了一张图，想标注 —— 只能先保存成文件、再打开截图工具。
 * 复制了一段 JSON，想格式化 —— 得打开工具、再粘贴一次。
 * 复制了一个网址，想 ping —— 同上。
 * 这类"我手里有这个，对它做点什么"的动作每天几十次，而路径却是
 * 「先想清楚这属于哪个工具，再去翻 103 个」。这个面板把顺序倒过来：
 * **先看内容，再给动作**。
 *
 * ============ 为什么是独立窗口而不是页面内浮层 ============
 *   · 用户可能在任何工具页里按这个键，浮层要能被任何页面复用；
 *   · 面板需要"读剪贴板 → 分析 → 显示"三步，独立窗可以不打断当前工作；
 *   · 但**打开独立窗口比页面内浮层重得多**（一个新 BrowserWindow 约
 *     200ms + 一次 IPC 往返）。所以这里用**页面内浮层**（ui.modal），
 *     只有在主窗口不可见时才退回"先显示主窗再弹浮层"。
 *
 * ============ 快捷键为什么不用 globalShortcut ============
 * globalShortcut 是**系统级**的：注册了 Ctrl+Shift+V 之后，
 * 用户在浏览器里按 Ctrl+Shift+V（Chrome 的"粘贴为纯文本"）会被我们抢走 ——
 * 那是明确的越权。所以只在这个应用窗口内响应。
 */
(function () {
  'use strict';

  let modalEl = null;

  /** 取剪贴板内容：先试文本，再试图片。 */
  async function readClipboard() {
    const api = window.api;
    const Ch = window.Channels && window.Channels.CHANNELS;
    if (!api || !Ch || !Ch.CLIP) return null;
    // 文本优先：用户在文本框里复制的多数是文本
    try {
      const text = await api.invoke(Ch.CLIP.READ_TEXT);
      if (text && String(text).trim()) return { text: String(text), isImage: false };
    } catch (e) { /* 继续试图片 */ }
    try {
      const img = await api.invoke(Ch.CLIP.READ_IMAGE);
      if (img) {
        /* 图片尺寸：剪贴板通道只给 dataURL，用 Image 解出宽高。
         * 拿不到就不显示尺寸（不影响动作）。 */
        const size = await new Promise((resolve) => {
          try {
            const im = new Image();
            im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
            im.onerror = () => resolve(null);
            im.src = img;
          } catch (e) { resolve(null); }
        });
        return { text: '', isImage: true, imageSize: size, dataUrl: img };
      }
    } catch (e) { /* 空剪贴板 */ }
    return null;
  }

  /** 执行一个动作。 */
  async function runAction(actionId, clip, analysis) {
    const A = window.ClipAnalyze && window.ClipAnalyze.ACTIONS;
    const act = A && A[actionId];
    if (!act) return;
    const api = window.api;
    const Ch = window.Channels && window.Channels.CHANNELS;
    const App = window.App;
    const ui = window.ui;

    /* ---- 面板自己处理的动作（不需要打开工具页） ---- */
    if (!act.tool) {
      try {
        if (actionId === 'urlOpen') {
          await api.invoke(Ch.SHELL.OPEN_URL, analysis.raw.url);
          close();
          return;
        }
        if (actionId === 'pathReveal') {
          await api.invoke(Ch.FS.SHOW_ITEM, analysis.raw.path);
          close();
          return;
        }
        if (actionId === 'pathProps') {
          /* 属性面板没有专门的通道，用现有的 fs:stat 拼一屏基本信息 */
          await showPathProps(analysis.raw.path);
          return;
        }
        if (actionId === 'imgPin') {
          /* 贴图走 snip:pin-clipboard（主进程直接读剪贴板图片并开贴图窗），
           * 不需要先把 dataURL 传过去 —— 那样多绕一次序列化。 */
          await api.invoke(Ch.SNIP.PIN_CLIPBOARD);
          close();
          return;
        }
        if (actionId === 'imgSave') {
          const out = await api.invoke(Ch.DIALOG.SAVE, { title: '保存剪贴板图片', defaultPath: 'clipboard.png' });
          if (!out) return;
          const du = clip.dataUrl || (analysis.kind === 'base64image' ? normalizeDataUrl(clip.text) : '');
          if (!du) { ui.toast('没有可保存的图片', 'error'); return; }
          const b64 = String(du).split(',')[1] || '';
          await api.invoke(Ch.FS.WRITE_FILE_B64, out, b64);
          ui.toast('已保存：' + out, 'success');
          close();
          return;
        }
        if (actionId === 'hashNone') {
          /* 剪贴板里本来就是哈希值，用户多半是想拿它比对某个文件。
           * 这里给一句说明而不是假装能做什么 —— 误导比不提供更糟。 */
          ui.toast('剪贴板里是 ' + (analysis.raw && analysis.raw.algo) + ' 值。用它比对文件请打开「哈希校验」工具', 'info', 4000);
          close();
          return;
        }
      } catch (e) {
        ui.toast('操作失败：' + (e && e.message || e), 'error');
        return;
      }
    }

    /* ---- 交给工具页 ---- */
    if (act.tool) {
      /* 【把内容送进工具页】
       * 与拖拽共用同一个交接队列（window.__pendingDrop 的兄弟）：
       * 工具页不知道面板从哪来，它只关心"有没有待处理内容"。 */
      window.__pendingClip = {
        kind: analysis.kind,
        text: clip.isImage ? '' : String(clip.text || ''),
        dataUrl: clip.dataUrl || (analysis.kind === 'base64image' ? normalizeDataUrl(clip.text) : ''),
        raw: analysis.raw || null,
        at: Date.now(),
      };
      close();
      try { App.openTool(act.tool); } catch (e) { /* 工具 id 不存在时静默 */ }
    }
  }

  /** "abc" 这种裸 base64 补成 data URL，才能交给图片通道。 */
  function normalizeDataUrl(text) {
    const t = String(text || '').trim();
    if (/^data:image\//i.test(t)) return t;
    if (!t) return '';
    /* 按魔数猜 mime，猜不到就按 png 处理（图片通道接受 png 最稳）。
     * 渲染层只有 atob，没有 Buffer —— 这个文件是纯浏览器脚本，
     * 不是 lib/ 那种双环境模块。 */
    try {
      const bin = atob(t.replace(/\s/g, ''));
      const b0 = bin.charCodeAt(0), b1 = bin.charCodeAt(1), b2 = bin.charCodeAt(2);
      if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return 'data:image/jpeg;base64,' + t;
      if (bin.slice(0, 4) === 'GIF8') return 'data:image/gif;base64,' + t;
      if (bin.slice(0, 4) === 'RIFF') return 'data:image/webp;base64,' + t;
    } catch (e) { /* 忽略 */ }
    return 'data:image/png;base64,' + t;
  }

  /** 路径属性：没有专门的通道，用现有的 stat + 目录列表拼一屏。 */
  async function showPathProps(p) {
    const api = window.api;
    const Ch = window.Channels && window.Channels.CHANNELS;
    const ui = window.ui;
    let st = null;
    try { st = await api.invoke(Ch.FS.STAT, p); } catch (e) { st = null; }
    const rows = [];
    rows.push(['路径', p]);
    if (st) {
      rows.push(['类型', st.isDir ? '文件夹' : '文件']);
      if (!st.isDir && st.size != null) rows.push(['大小', ui.fmtBytes(st.size)]);
      if (st.mtime) rows.push(['修改时间', ui.fmtDate(st.mtime)]);
    } else {
      rows.push(['说明', '路径不存在或无法访问']);
    }
    const body = document.createElement('div');
    body.appendChild(ui.kvGrid(rows));
    if (modalEl) { modalEl.close(); modalEl = null; }
    modalEl = ui.modal({
      title: '路径属性',
      width: 520,
      body,
      foot: [ui.btn('在资源管理器打开', 'btn-secondary', async () => {
        try { await api.invoke(Ch.FS.SHOW_ITEM, p); } catch (e) {}
      }, 'folder'), ui.btn('关闭', 'btn-primary', () => { if (modalEl) modalEl.close(); })],
    });
  }

  function close() {
    if (modalEl) { try { modalEl.close(); } catch (e) {} modalEl = null; }
  }

  /** 显示面板。 */
  async function show() {
    const ui = window.ui;
    const C = window.ClipAnalyze;
    if (!ui || !C) return;
    if (modalEl) { close(); return; }   // 再按一次就收起（开关式）

    const clip = await readClipboard();
    const analysis = C.analyze(clip || { text: '' });

    const body = document.createElement('div');

    /* ---- 内容预览卡 ---- */
    const head = ui.div('clip-act-head');
    head.appendChild(ui.div('clip-act-kind', analysis.label));
    head.appendChild(ui.div('clip-act-detail', analysis.detail || ''));
    body.appendChild(head);

    if (clip && clip.isImage && clip.dataUrl) {
      const im = document.createElement('img');
      im.src = clip.dataUrl;
      im.className = 'clip-act-thumb';
      body.appendChild(im);
    } else if (analysis.kind === 'text' || analysis.kind === 'json' || analysis.kind === 'mojibake') {
      const pre = ui.div('clip-act-preview mono');
      pre.textContent = (clip && clip.text ? clip.text : '').slice(0, 600);
      body.appendChild(pre);
    } else if (analysis.kind === 'color') {
      /* 颜色值给个色块，比一行 #RRGGBB 直观 */
      const box = ui.div('clip-act-color');
      box.style.background = String((clip && clip.text) || '').trim();
      body.appendChild(box);
    }

    if (analysis.kind === 'empty') {
      body.appendChild(ui.div('empty-tip', '剪贴板里没有可用内容。先复制点什么再按 Ctrl+Shift+V。'));
      modalEl = ui.modal({
        title: '剪贴板动作', width: 520, body,
        foot: [ui.btn('关闭', 'btn-primary', () => close())],
      });
      return;
    }

    /* ---- 动作按钮 ---- */
    const list = ui.div('clip-act-list');
    let firstBtn = null;
    for (const id of analysis.actions) {
      const act = C.ACTIONS[id];
      if (!act) continue;
      const b = ui.btn(act.label, 'btn-secondary clip-act-btn', async () => {
        await runAction(id, clip || {}, analysis);
      }, act.icon);
      /* 第一个是"最推荐"的，用主色强调 */
      if (!firstBtn) { b.className = 'btn btn-primary clip-act-btn'; firstBtn = b; }
      list.appendChild(b);
    }
    body.appendChild(ui.div('clip-act-hint', '按数字键 1-9 直接执行，Esc 关闭'));
    body.appendChild(list);

    /* ---- 数字键快捷执行 ---- */
    body.addEventListener('keydown', (e) => {
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && analysis.actions[n - 1]) {
        e.preventDefault();
        runAction(analysis.actions[n - 1], clip || {}, analysis);
      }
    });

    modalEl = ui.modal({
      title: '剪贴板动作',
      width: 560,
      body,
      onClose: () => { modalEl = null; },
      foot: [ui.btn('关闭', 'btn-secondary', () => close())],
    });
    setTimeout(() => { try { body.setAttribute('tabindex', '0'); body.focus(); } catch (e) {} }, 0);
  }

  /* ---- 快捷键绑定（窗口内，不是系统级）---- */
  function bind() {
    if (window.__clipActionsBound) return;
    window.__clipActionsBound = true;
    document.addEventListener('keydown', (e) => {
      /* Ctrl+Shift+V。
       * 【为什么不用 e.key === 'V'】大小写与输入法状态下 key 可能不同，
       * 统一的判据是 e.code === 'KeyV'。 */
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === 'KeyV' || e.key === 'V' || e.key === 'v')) {
        e.preventDefault();
        e.stopPropagation();
        show();
      }
    }, true);
  }

  /** 工具页取待处理内容（与拖拽的 takePending 同构）。 */
  function takePendingClip(toolId, maxAge) {
    const p = window.__pendingClip;
    if (!p) return null;
    if (Date.now() - (p.at || 0) > (maxAge || 30000)) { window.__pendingClip = null; return null; }
    window.__pendingClip = null;
    return p;
  }

  const API = { show, bind, takePendingClip };
  /* 只挂 window：js/** 是纯浏览器环境（eslint 的 browser globals 里
   * 没有 module），写 UMD 尾部会被 lint 判 no-undef。
   * 需要单测的部分都在 lib/ 里（lib/clip-analyze.js、lib/sensitive.js）。 */
  if (typeof window !== 'undefined') window.ClipActions = API;
})();
