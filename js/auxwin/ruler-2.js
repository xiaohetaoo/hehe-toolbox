    const params = new URLSearchParams(location.search);
    let dir = params.get('dir') === 'v' ? 'v' : 'h';
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
      const major = 100, mid = 50, minor = 10;
      if (dir === 'h') {
        ctx.beginPath(); ctx.moveTo(0, h - 6); ctx.lineTo(w, h - 6); ctx.stroke();
        for (let x = 0; x <= w; x += minor) {
          const len = x % major === 0 ? 14 : x % mid === 0 ? 9 : 5;
          ctx.beginPath(); ctx.moveTo(x, h - 6); ctx.lineTo(x, h - 6 - len); ctx.stroke();
          if (x % major === 0 && x > 0) ctx.fillText(String(x), x + 2, h - 22);
        }
      } else {
        ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(6, h); ctx.stroke();
        for (let y = 0; y <= h; y += minor) {
          const len = y % major === 0 ? 14 : y % mid === 0 ? 9 : 5;
          ctx.beginPath(); ctx.moveTo(6, y); ctx.lineTo(6 + len, y); ctx.stroke();
          if (y % major === 0 && y > 0) {
            ctx.save(); ctx.translate(16, y - 2); ctx.rotate(-Math.PI / 2);
            ctx.fillText(String(y), 0, 8); ctx.restore();
          }
        }
      }
      window.__drawn = true;
    }

    // 整个标尺都是拖动区，而 Electron 的 -webkit-app-region: drag 会吞掉鼠标事件，
    // 所以这里用 IPC 手动拖动，mousemove / dblclick 才能正常工作
    let dragging = false, grabDX = 0, grabDY = 0, pendingMove = null, moveRaf = 0;
    function pushMove() {
      if (moveRaf || !pendingMove || !window.hehe) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        if (pendingMove && window.hehe) hehe.invoke('win:ruler:move', pendingMove[0], pendingMove[1]).catch(() => {});
      });
    }
    window.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && e.target.closest('#ctrl')) return;
      dragging = true;
      grabDX = e.screenX - window.screenX;
      grabDY = e.screenY - window.screenY;
    });
    window.addEventListener('mousemove', (e) => {
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
    window.addEventListener('mouseup', () => { dragging = false; pendingMove = null; });
    // 指针甩出窗口/失焦时复位，避免拖拽状态卡死
    document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) { tip.style.display = 'none'; dragging = false; pendingMove = null; } });
    window.addEventListener('blur', () => { dragging = false; pendingMove = null; });
    window.addEventListener('mouseleave', () => { tip.style.display = 'none'; });

    function closeRuler() {
      try { if (window.hehe) hehe.invoke('win:ruler:close').catch(() => {}); } catch (e) {}
      try { window.close(); } catch (e) {}
    }
    document.getElementById('close').addEventListener('click', closeRuler);
    document.getElementById('bar').addEventListener('dblclick', closeRuler);
    document.getElementById('toggle').addEventListener('click', async () => {
      try {
        if (window.hehe) { await hehe.invoke('win:ruler', dir === 'h' ? 'v' : 'h'); return; }
      } catch (e) {}
      closeRuler();
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRuler(); });

    window.addEventListener('resize', draw);
    draw();
  
