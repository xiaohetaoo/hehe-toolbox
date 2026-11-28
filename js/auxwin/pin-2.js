    const params = new URLSearchParams(location.search);
    const winId = params.get('id');
    const src = params.get('src');
    const img = document.getElementById('pic');
    const hint = document.getElementById('hint');
    function applyHintLang() {
      hint.textContent = document.documentElement.lang === 'en'
        ? 'Drag to move · Scroll to zoom · Double-click / Esc to close'
        : '拖动移动 · 滚轮缩放 · 双击 / Esc 关闭';
    }
    applyHintLang();
    /* 贴图窗可能一直开着；主窗切语言后只改 <html lang> 不够，提示文字也要跟着换。 */
    window.addEventListener('hehe-lang', applyHintLang);
    img.src = 'file:///' + encodeURI(src.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
    img.onload = () => { hint.classList.add('show'); setTimeout(() => hint.classList.remove('show'), 2600); };

    // 手动拖动（与标尺一致：app-region 会吞事件，改走 IPC）
    let dragging = false, grabDX = 0, grabDY = 0, pending = null, raf = 0;
    function push() {
      if (raf || !pending || !window.hehe) return;
      raf = requestAnimationFrame(() => { raf = 0; if (pending && window.hehe) hehe.invoke(window.Channels.CHANNELS.WIN.PIN_MOVE, winId, pending[0], pending[1]).catch(() => {}); });
    }
    window.addEventListener('mousedown', (e) => { dragging = true; grabDX = e.screenX - window.screenX; grabDY = e.screenY - window.screenY; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      pending = [e.screenX - grabDX, e.screenY - grabDY];
      push();
    });
    window.addEventListener('mouseup', () => { dragging = false; pending = null; });
    document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) { dragging = false; pending = null; } });
    window.addEventListener('blur', () => { dragging = false; pending = null; });

    // 滚轮缩放：改窗口尺寸，图片自适应
    window.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const w = Math.max(80, Math.round(window.innerWidth * dir));
      const h = Math.max(60, Math.round(window.innerHeight * dir));
      if (window.hehe) hehe.invoke(window.Channels.CHANNELS.WIN.PIN_RESIZE, winId, w, h).catch(() => {});
    }, { passive: false });

    function closePin() { try { if (window.hehe) hehe.invoke(window.Channels.CHANNELS.WIN.PIN_CLOSE, winId).catch(() => {}); } catch (e) {} try { window.close(); } catch (e) {} }
    window.addEventListener('dblclick', closePin);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePin(); });
  
