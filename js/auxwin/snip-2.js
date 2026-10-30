    const params = new URLSearchParams(location.search);
    const MODE = params.get('mode') === 'region' ? 'region' : 'annotate';
    const DX = +params.get('dx') || 0, DY = +params.get('dy') || 0, SCALE = +params.get('scale') || 1;
    const W = +params.get('w') || window.innerWidth, H = +params.get('h') || window.innerHeight;
    const canvas = document.getElementById('c');
    const bar = document.getElementById('bar');
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
    function drawingTool() { return ['rect', 'arrow', 'pen', 'mosaic'].includes(tool); }
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
    function openTextInput(p) {
      textInput.value = '';
      textInput.style.left = p.x + 'px'; textInput.style.top = p.y + 'px';
      textInput.style.color = color;
      textInput.style.display = 'block';
      textInput.focus();
      const commit = () => {
        textInput.style.display = 'none';
        if (textInput.value.trim()) {
          shapes.push({ type: 'text', x1: p.x, y1: p.y, color, size, text: textInput.value });
          render();
        }
        textInput.removeEventListener('blur', commit);
      };
      textInput.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { textInput.value = ''; commit(); }
      });
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

    // E2E 测试钩子
    window.__snipTest = {
      select(x, y, w, h) { sel = { x, y, w, h }; if (MODE !== 'region') showBar(); render(); },
      setTool(t) { tool = t; },
      addShape(s) { shapes.push(s); render(); },
      finish,
      getSel: () => sel, getShapes: () => shapes
    };
  
