    const params = new URLSearchParams(location.search);
    const MODE = params.get('mode') === 'region' ? 'region' : 'annotate';
    const DX = +params.get('dx') || 0, DY = +params.get('dy') || 0, SCALE = +params.get('scale') || 1;
    const W = +params.get('w') || window.innerWidth, H = +params.get('h') || window.innerHeight;
    const canvas = document.getElementById('c');
    const bar = document.getElementById('bar');
    /* stage 是整块画布容器（框选/拖动/标注的三个 mousedown/mousemove/mouseup
     * 都挂在它上面）。以前这里没写这一行，靠「元素的 id 会自动成为 window
     * 上的同名属性」这条老机制才没报错 —— 但那是浏览器兼容行为，
     * 本文件里 canvas/bar/tip/textInput 全是显式 getElementById，
     * 只有它悬空，读代码时会以为 stage 是从别处传进来的。补齐。 */
    const stage = document.getElementById('stage');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    let sel = null;           // {x,y,w,h} 逻辑坐标（相对本窗口）
    let selecting = false, dragStart = null;
    let tool = 'rect', color = '#FF4D4F', size = 3;
    let shapes = [];          // {type, x1,y1,x2,y2, color, size, text, pts}
    let drawing = null;

    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    img.src = 'file:///' + encodeURI(params.get('src').replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');

    function render() {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.drawImage(img, 0, 0, window.innerWidth, window.innerHeight);
      if (!sel) { // 未选区：全屏压暗
        ctx.fillStyle = 'rgba(0,0,20,0.28)';
        ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
      } else {
        // 选区外压暗（四块）
        ctx.fillStyle = 'rgba(0,0,20,0.38)';
        ctx.fillRect(0, 0, window.innerWidth, sel.y);
        ctx.fillRect(0, sel.y, sel.x, sel.h);
        ctx.fillRect(sel.x + sel.w, sel.y, window.innerWidth - sel.x - sel.w, sel.h);
        ctx.fillRect(0, sel.y + sel.h, window.innerWidth, window.innerHeight - sel.y - sel.h);
        // 边框
        ctx.strokeStyle = accentPrimary(); ctx.lineWidth = 1.5;
        ctx.strokeRect(sel.x + .5, sel.y + .5, sel.w - 1, sel.h - 1);
        // 八个手柄
        ctx.fillStyle = '#fff';
        const hs = 6;
        for (const [hx, hy] of [[sel.x, sel.y], [sel.x + sel.w / 2, sel.y], [sel.x + sel.w, sel.y], [sel.x, sel.y + sel.h / 2], [sel.x + sel.w, sel.y + sel.h / 2], [sel.x, sel.y + sel.h], [sel.x + sel.w / 2, sel.y + sel.h], [sel.x + sel.w, sel.y + sel.h]])
          ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
        // 裁剪区绘制标注
        ctx.save();
        ctx.beginPath(); ctx.rect(sel.x, sel.y, sel.w, sel.h); ctx.clip();
        for (const s of shapes) drawShape(s);
        if (drawing) drawShape(drawing);
        ctx.restore();
      }
    }
    function drawShape(s) {
      ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.size;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (s.type === 'rect') ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
      else if (s.type === 'arrow') {
        const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        const head = Math.max(10, s.size * 3.5);
        ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s.x2, s.y2);
        ctx.lineTo(s.x2 - head * Math.cos(ang - Math.PI / 7), s.y2 - head * Math.sin(ang - Math.PI / 7));
        ctx.lineTo(s.x2 - head * Math.cos(ang + Math.PI / 7), s.y2 - head * Math.sin(ang + Math.PI / 7));
        ctx.closePath(); ctx.fill();
      } else if (s.type === 'pen' || s.type === 'mosaic') {
        if (s.type === 'pen') {
          ctx.beginPath();
          s.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
          ctx.stroke();
        } else {
          // 马赛克：沿路径以低分辨率取样再放大
          const px = Math.max(6, s.size * 3);
          for (const p of s.pts) {
            const sx = (p.x) * (img.naturalWidth / window.innerWidth);
            const sy = (p.y) * (img.naturalHeight / window.innerHeight);
            try {
              ctx.drawImage(img, sx, sy, px * (img.naturalWidth / window.innerWidth), px * (img.naturalHeight / window.innerHeight), p.x - px / 2, p.y - px / 2, px, px);
            } catch (e) {}
          }
        }
      } else if (s.type === 'text') {
        ctx.font = `${s.size * 7}px 'Microsoft YaHei', sans-serif`;
        ctx.textBaseline = 'top';
        const lines = String(s.text || '').split('\n');
        lines.forEach((ln, i) => ctx.fillText(ln, s.x1, s.y1 + i * s.size * 8));
      }
    }
    img.onload = render;
    window.addEventListener('resize', () => { render(); });

    /* ---------- 选区 ---------- */
    const tip = document.getElementById('tip'), sizeTip = document.getElementById('sizeTip');
    setTimeout(() => { tip.style.display = 'block'; setTimeout(() => tip.style.display = 'none', 3000); }, 400);
    stage.addEventListener('mousedown', (e) => {
      if (!sel) {
        if (e.button !== 0) return;
        selecting = true; dragStart = { x: e.clientX, y: e.clientY };
      } else if (drawingTool()) {
        const p = { x: e.clientX, y: e.clientY };
        if (tool === 'pen' || tool === 'mosaic') drawing = { type: tool, color, size, pts: [p] };
        else if (tool === 'text') openTextInput(p);
        else drawing = { type: tool, color, size, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      }
    });
    /* 哪些工具靠「按下—拖动—抬起」产生图形。
     *
     * text 必须在内：它的流程是「点一下弹出输入框、回车落字」，没有拖拽那一步，
     * 但**第一下也要走这个 mousedown 分支**才能调到 openTextInput。
     * 以前白名单只有 rect/arrow/pen/mosaic，于是 tool==='text' 时整段被跳过 ——
     * 工具条上明明有 T 按钮（见 TOOLS），点了却在画布上没反应，
     * openTextInput 永远不会被调用。 */
    function drawingTool() { return ['rect', 'arrow', 'pen', 'mosaic', 'text'].includes(tool); }
    stage.addEventListener('mousemove', (e) => {
      if (selecting) {
        sel = { x: Math.min(dragStart.x, e.clientX), y: Math.min(dragStart.y, e.clientY),
          w: Math.abs(e.clientX - dragStart.x), h: Math.abs(e.clientY - dragStart.y) };
        sizeTip.style.display = 'block';
        sizeTip.style.left = (sel.x + sel.w / 2 - 30) + 'px';
        sizeTip.style.top = Math.max(4, sel.y - 26) + 'px';
        sizeTip.textContent = `${sel.w} × ${sel.h}`;
        render();
      } else if (drawing) {
        const p = { x: e.clientX, y: e.clientY };
        if (drawing.pts) drawing.pts.push(p);
        else { drawing.x2 = p.x; drawing.y2 = p.y; }
        render();
      }
    });
    stage.addEventListener('mouseup', () => {
      if (selecting) {
        selecting = false;
        sizeTip.style.display = 'none';
        if (sel && sel.w > 8 && sel.h > 8) {
          if (MODE === 'region') { finish('region'); return; }
          showBar();
        } else { sel = null; render(); }
      } else if (drawing) {
        if (drawing.type !== 'text' && !drawing.pts || (drawing.pts && drawing.pts.length > 1) || (!drawing.pts && (Math.abs(drawing.x2 - drawing.x1) + Math.abs(drawing.y2 - drawing.y1) > 3))) shapes.push(drawing);
        else if (drawing.pts && drawing.pts.length === 1) shapes.push(drawing);
        drawing = null; render();
      }
    });

    /* ---------- 工具条 ---------- */
    const TOOLS = [['rect', '▭'], ['arrow', '➚'], ['pen', '✏️'], ['text', 'T'], ['mosaic', '▦']];
    const COLORS = ['#FF4D4F', '#FFC53D', '#165DFF', '#00B42A', '#FFFFFF', '#000000'];
    function showBar() {
      bar.innerHTML = '';
      for (const [id, ic] of TOOLS) {
        const b = document.createElement('button');
        b.className = 'tbtn' + (tool === id ? ' on' : '');
        b.textContent = ic; b.title = { rect: '矩形', arrow: '箭头', pen: '画笔', text: '文字', mosaic: '马赛克' }[id];
        b.onclick = () => { tool = id; showBar(); };
        bar.appendChild(b);
      }
      bar.appendChild(sep());
      for (const c of COLORS) {
        const s = document.createElement('div');
        s.className = 'sw' + (color === c ? ' on' : '');
        s.style.background = c;
        s.onclick = () => { color = c; showBar(); };
        bar.appendChild(s);
      }
      bar.appendChild(sep());
      const sz1 = mkBtn('细', 'tbtn' + (size === 2 ? ' on' : ''), () => { size = 2; showBar(); });
      const sz2 = mkBtn('中', 'tbtn' + (size === 3 ? ' on' : ''), () => { size = 3; showBar(); });
      const sz3 = mkBtn('粗', 'tbtn' + (size === 5 ? ' on' : ''), () => { size = 5; showBar(); });
      bar.appendChild(sz1); bar.appendChild(sz2); bar.appendChild(sz3);
      bar.appendChild(sep());
      bar.appendChild(mkBtn('↩ 撤销', 'tbtn', () => { shapes.pop(); render(); }));
      bar.appendChild(mkBtn('⟳ 重选', 'tbtn', () => { sel = null; shapes = []; bar.style.display = 'none'; render(); }));
      bar.appendChild(sep());
      bar.appendChild(mkBtn('复制', 'tbtn act', () => finish('copy')));
      bar.appendChild(mkBtn('保存', 'tbtn act', () => finish('save')));
      bar.appendChild(mkBtn('贴图', 'tbtn act', () => finish('pin')));
      bar.appendChild(mkBtn('OCR', 'tbtn act', () => finish('ocr')));
      bar.style.display = 'flex';
      // 工具条位置：选区下方优先，空间不足放上方/选区内
      requestAnimationFrame(() => {
        const bw = bar.offsetWidth, bh = bar.offsetHeight;
        let x = sel.x + sel.w - bw, y = sel.y + sel.h + 10;
        if (y + bh > window.innerHeight) y = sel.y - bh - 10;
        if (y < 0) y = sel.y + 10;
        x = Math.max(8, Math.min(x, window.innerWidth - bw - 8));
        bar.style.left = x + 'px'; bar.style.top = y + 'px';
      });
    }
    function mkBtn(t, cls, fn) { const b = document.createElement('button'); b.className = cls; b.textContent = t; b.onclick = fn; return b; }
    function sep() { const s = document.createElement('div'); s.className = 'sep'; return s; }

    /* ---------- 文字输入 ---------- */
    const textInput = document.getElementById('textInput');
    /* 文字输入的提交必须**只挂一次**。
     *
     * 这里原来每次 openTextInput 都执行一次 textInput.addEventListener('keydown', ...)，
     * 而提交后只 removeEventListener('blur', commit) —— keydown 那一个从不摘除。
     * 于是每加一处文字就多留一个闭包，闭包里封着**那一次的坐标 p**，
     * 而 commit 读的是输入框**当前**的值：下一次输入时，所有旧闭包都被同一个
     * Enter 唤醒，各按自己记住的坐标 push 一份当前文本。
     * 实测「A 点输入甲 → B 点输入乙 → C 点输入丙」会得到 6 份文字标注（而不是 3 份）。
     *
     * 修法：keydown 用 onkeydown 赋值（每次覆盖，天然只有一份），
     * blur 仍在 commit 里自行摘除 —— 两条提交路径（Enter / 失焦）都要收一次尾。
     * 另加 committed 闸：Enter 提交后输入框会隐藏并失焦，blur 会再进来一次，
     * 没有这个闸就会同一次输入 push 两份。 */
    function openTextInput(p) {
      textInput.value = '';
      textInput.style.left = p.x + 'px'; textInput.style.top = p.y + 'px';
      textInput.style.color = color;
      textInput.style.display = 'block';
      textInput.focus();
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        textInput.style.display = 'none';
        textInput.onkeydown = null;
        if (textInput.value.trim()) {
          shapes.push({ type: 'text', x1: p.x, y1: p.y, color, size, text: textInput.value });
          render();
        }
        textInput.removeEventListener('blur', commit);
      };
      textInput.onkeydown = (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { textInput.value = ''; commit(); }
      };
      textInput.addEventListener('blur', commit);
    }

    /* ---------- 输出 ---------- */
    function finish(action) {
      if (action !== 'cancel' && !sel) return;
      let payload = { action };
      if (action === 'region') {
        // 物理坐标（供区域录制等）
        payload.rect = { x: Math.round((sel.x + DX) * SCALE), y: Math.round((sel.y + DY) * SCALE), w: Math.round(sel.w * SCALE), h: Math.round(sel.h * SCALE) };
      } else if (action !== 'cancel') {
        const dpr = devicePixelRatio || 1;
        const out = document.createElement('canvas');
        out.width = sel.w * dpr; out.height = sel.h * dpr;
        const octx = out.getContext('2d');
        octx.scale(dpr, dpr);
        octx.drawImage(canvas, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
        payload.dataUrl = out.toDataURL('image/png');
      }
      try { hehe.invoke('snip:finish', payload).catch(() => {}); } catch (e) {}
      try { window.close(); } catch (e) {}
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') finish(sel ? 'cancel' : 'cancel');
      if (e.key === 'Enter' && sel && MODE !== 'region') finish('copy');
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { shapes.pop(); render(); }
    });
    window.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (sel) { shapes = []; sel = null; bar.style.display = 'none'; render(); } // 右键重选
    });
    render();

    /* E2E 测试钩子：只在开发/测试态挂出。
     *
     * 以前无条件 `window.__snipTest = {...}`，打包版里也一直躺着 —— 等于给生产
     * 包留了一个能直接改选区、塞 shape、触发 finish 的后门。js/tools/media.js
     * 里同类钩子都用 isDev 门控，这里跟它对齐。
     *
     * 辅助窗口没有渲染层的 window.api（那套只在主窗口的 js/api.js 里），
     * 但 preload.js 已经把 isDev 通过 contextBridge 暴露到 window.hehe，
     * 因此这里读 hehe.isDev 就够了，不需要另造注入机制。
     * scripts/test-snip-e2e.js 用未打包的 electron.exe 起窗口，此时
     * app.isPackaged 为 false → isDev 为 true，测试照常能拿到钩子。
     * 打包态若确实需要跑 E2E，设 HEHE_TEST_HOOKS=1 即可（见 preload.js）。 */
    if (window.hehe && window.hehe.isDev) {
      window.__snipTest = {
        select(x, y, w, h) { sel = { x, y, w, h }; if (MODE !== 'region') showBar(); render(); },
        setTool(t) { tool = t; },
        addShape(s) { shapes.push(s); render(); },
        finish,
        getSel: () => sel, getShapes: () => shapes
      };
    }
  
