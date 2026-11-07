    const params = new URLSearchParams(location.search);
    let dir = params.get('dir') === 'v' ? 'v' : 'h';
    /* 方向挂到 <html> 上，让 CSS 决定把手该贴在哪两条边（见 ruler.html 的 .rz）。 */
    document.documentElement.dataset.dir = dir;
    const canvas = document.getElementById('c');
    const tip = document.getElementById('tip');

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth, h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // translucent track
      ctx.fillStyle = 'rgba(15,23,42,0.82)';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '10px Consolas, monospace';
      ctx.lineWidth = 1;
      /* 【刻度必须按**物理像素**推进，不能按 CSS 像素】
       * 这个标尺是拿来量屏幕的，用户读到的数字必须等于屏幕实际像素。
       * 187.5% 缩放下 dpr=1.875：窗口 CSS 宽 602，但 canvas 实际是 1128 物理像素。
       * 旧实现 `for (x = 0; x <= w; x += minor)` 按 CSS 像素走，
       * 画出来的「100」只跨 100 CSS px = 187.5 物理像素 —— 量什么都偏小，
       * 而且越往右偏得越多。
       * 现在：phys 直接按物理像素递增，坐标再除以 dpr 换回 CSS 供绘制。 */
      const PHYS_MAJOR = 100, PHYS_MID = 50, PHYS_MINOR = 10;
      if (dir === 'h') {
        ctx.beginPath(); ctx.moveTo(0, h - 6); ctx.lineTo(w, h - 6); ctx.stroke();
        for (let phys = 0; phys <= Math.ceil(w * dpr); phys += PHYS_MINOR) {
          const x = phys / dpr;
          const len = phys % PHYS_MAJOR === 0 ? 14 : phys % PHYS_MID === 0 ? 9 : 5;
          ctx.beginPath(); ctx.moveTo(x, h - 6); ctx.lineTo(x, h - 6 - len); ctx.stroke();
          if (phys % PHYS_MAJOR === 0 && phys > 0) ctx.fillText(String(phys), x + 2, h - 22);
        }
      } else {
        ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(6, h); ctx.stroke();
        for (let phys = 0; phys <= Math.ceil(h * dpr); phys += PHYS_MINOR) {
          const y = phys / dpr;
          const len = phys % PHYS_MAJOR === 0 ? 14 : phys % PHYS_MID === 0 ? 9 : 5;
          ctx.beginPath(); ctx.moveTo(6, y); ctx.lineTo(6 + len, y); ctx.stroke();
          if (phys % PHYS_MAJOR === 0 && phys > 0) {
            ctx.save(); ctx.translate(16, y - 2); ctx.rotate(-Math.PI / 2);
            ctx.fillText(String(phys), 0, 8); ctx.restore();
          }
        }
      }
      /* 只在开发/测试态挂出，与 snip-2.js 的 __snipTest 同一口径：
       * 生产包里不该留一个「标尺已经画完」的调试标记。
       * 辅助窗口的 isDev 来自 preload.js 的 contextBridge（window.hehe.isDev）。 */
      if (window.hehe && window.hehe.isDev) window.__drawn = true;
    }

    // 整个标尺都是拖动区，而 Electron 的 -webkit-app-region: drag 会吞掉鼠标事件，
    // 所以这里用 IPC 手动拖动，mousemove / dblclick 才能正常工作
    let dragging = false, grabDX = 0, grabDY = 0, pendingMove = null, moveRaf = 0;
    /* 拉伸状态：edge 是 'start'（左上那条边）或 'end'（右下那条边）。
     * w0/h0 记录按下那一刻的尺寸，sx0/sy0 记录按下那一刻的指针屏幕坐标。
     * 之后每一次都相对**按下时**算增量 —— 用「每帧在上一次结果上累加」
     * 会因为 setBounds 的取整而慢慢漂移。 */
    let resizing = null, pendingResize = null, resizeRaf = 0;
    function pushResize(len, edge) {
      pendingResize = [len, edge];
      if (resizeRaf || !window.hehe) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        if (!pendingResize || !window.hehe) return;
        const [l, eg] = pendingResize;
        const w = dir === 'h' ? l : window.innerWidth;
        const h = dir === 'h' ? window.innerHeight : l;
        hehe.invoke(window.Channels.CHANNELS.WIN.RULER_RESIZE, Math.round(w), Math.round(h), eg).catch(() => {});
      });
    }
    function pushMove() {
      if (moveRaf || !pendingMove || !window.hehe) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        if (pendingMove && window.hehe) hehe.invoke(window.Channels.CHANNELS.WIN.RULER_MOVE, pendingMove[0], pendingMove[1]).catch(() => {});
      });
    }
    window.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && e.target.closest('#ctrl')) return;
      /* 【把手优先于拖动窗口】
       * 两条 6px 的边压在 #bar 上面，mousedown 会冒泡到这里。
       * 不先拦下来，拖边缘就变成了「移动整个标尺」—— 那正好是
       * 用户反馈「不能伸长缩短」的观感来源。 */
      const rz = e.target && e.target.closest && e.target.closest('.rz');
      if (rz) {
        resizing = {
          edge: rz.id === 'rzStart' ? 'start' : 'end',
          w0: window.innerWidth, h0: window.innerHeight,
          sx0: e.screenX, sy0: e.screenY
        };
        return;
      }
      dragging = true;
      grabDX = e.screenX - window.screenX;
      grabDY = e.screenY - window.screenY;
    });
    window.addEventListener('mousemove', (e) => {
      if (resizing) {
        /* 【必须用「相对按下时」的增量，不能每帧读当前尺寸】
         * clientX/screenX 在窗口被 setBounds 改变之后会跟着跳，
         * 拿它做增量会让一次拖拽自己加速（实测表现为"越拖越快、一下拉到底"）。
         * 所以从按下那一刻的指针位置与尺寸算总位移。 */
        const d = dir === 'h' ? (e.screenX - resizing.sx0) : (e.screenY - resizing.sy0);
        const len = resizing.edge === 'end'
          ? (dir === 'h' ? resizing.w0 + d : resizing.h0 + d)
          : (dir === 'h' ? resizing.w0 - d : resizing.h0 - d);
        pushResize(len, resizing.edge);
        tip.style.display = 'block';
        tip.style.left = (e.clientX + 12) + 'px';
        tip.style.top = Math.max(2, e.clientY - 22) + 'px';
        tip.textContent = Math.round(Math.max(len, 0)) + ' px';
        return;
      }
      if (dragging) {
        pendingMove = [e.screenX - grabDX, e.screenY - grabDY];
        pushMove();
      }
      const v = dir === 'h' ? e.screenX - window.screenX : e.screenY - window.screenY;
      tip.style.display = 'block';
      tip.style.left = (e.clientX + 12) + 'px';
      tip.style.top = Math.max(2, e.clientY - 22) + 'px';
      tip.textContent = v + ' px';
    });
    window.addEventListener('mouseup', () => { dragging = false; resizing = null; pendingMove = null; pendingResize = null; });
    // 指针甩出窗口/失焦时复位，避免拖拽状态卡死
    document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) { tip.style.display = 'none'; dragging = false; resizing = null; pendingMove = null; pendingResize = null; } });
    window.addEventListener('blur', () => { dragging = false; resizing = null; pendingMove = null; pendingResize = null; });
    window.addEventListener('mouseleave', () => { tip.style.display = 'none'; });

    function closeRuler() {
      try { if (window.hehe) hehe.invoke(window.Channels.CHANNELS.WIN.RULER_CLOSE).catch(() => {}); } catch (e) {}
      try { window.close(); } catch (e) {}
    }
    document.getElementById('close').addEventListener('click', closeRuler);
    document.getElementById('bar').addEventListener('dblclick', closeRuler);
    document.getElementById('toggle').addEventListener('click', async () => {
      try {
        if (window.hehe) { await hehe.invoke(window.Channels.CHANNELS.WIN.RULER, dir === 'h' ? 'v' : 'h'); return; }
      } catch (e) {}
      closeRuler();
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRuler(); });

    window.addEventListener('resize', draw);
    draw();
  
