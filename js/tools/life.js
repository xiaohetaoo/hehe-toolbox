/* 模块：生活辅助 —— 番茄钟 / 日历农历 / 便签待办 / 屏幕标尺 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, confirmBox, promptBox, pad2, fmtDate } = window.ui;
  const { invoke, isDesktop } = window.api;
  const MOD = 'life';

  /* ---------- 番茄钟 / 倒计时 ---------- */
  register({
    id: 'pomodoro', name: '番茄钟 / 倒计时', module: MOD, icon: 'timer',
    desc: '专注计时、正计时、倒计时，完成自动提醒',
    keywords: ['番茄钟', '专注', '倒计时', '计时'],
    render(page) {
      let mode = 'pomodoro'; // pomodoro | countdown | stopwatch
      let total = 25 * 60, remain = 25 * 60, running = false, timer = null, startTs = 0;
      const display = h('div', { class: 'stat-num', style: { fontSize: '64px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' } }, '25:00');
      const statusText = h('div', { style: { textAlign: 'center', color: 'var(--text-3)', marginBottom: '10px' } }, '专注模式 · 25 分钟');
      const ring = h('div', { style: { display: 'flex', justifyContent: 'center', margin: '10px 0' } });
      const canvas = h('canvas', { width: 220, height: 220 });
      ring.appendChild(canvas);
      const workIn = h('input', { type: 'number', class: 'input input-sm', value: '25', min: '1', max: '120', style: { width: '70px' } });
      const restIn = h('input', { type: 'number', class: 'input input-sm', value: '5', min: '1', max: '60', style: { width: '70px' } });
      const countIn = h('input', { type: 'number', class: 'input input-sm', value: '4', min: '1', max: '20', style: { width: '70px' } });
      let pomodoros = 0, targetPomodoros = 4, phase = 'work';
      function fmt(sec) { sec = Math.max(0, Math.ceil(sec)); return `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`; }
      function drawRing(ratio, color) {
        const ctx = canvas.getContext('2d');
        const cs = getComputedStyle(document.documentElement);
        ctx.clearRect(0, 0, 220, 220);
        ctx.lineWidth = 10;
        ctx.strokeStyle = cs.getPropertyValue('--border').trim() || '#E5E6EB';
        ctx.beginPath(); ctx.arc(110, 110, 95, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = color || cs.getPropertyValue('--primary').trim() || '#165DFF';
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(110, 110, 95, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.001, ratio)); ctx.stroke();
      }
      function tick() {
        const elapsed = (Date.now() - startTs) / 1000;
        if (mode === 'stopwatch') {
          display.textContent = fmt(elapsed);
          display.style.fontSize = '48px';
          drawRing((elapsed % 60) / 60);
          return;
        }
        remain = total - elapsed;
        if (remain <= 0) {
          finishPhase();
          return;
        }
        display.textContent = fmt(remain);
        drawRing(remain / total);
      }
      async function finishPhase() {
        stop();
        if (mode === 'countdown') {
          display.textContent = '00:00';
          try { await invoke('clip:write-text', ''); } catch (e) {}
          toast('⏰ 倒计时结束！', 'success', 4000);
          new Notification('核核工具箱', { body: '倒计时结束！' });
          return;
        }
        if (phase === 'work') {
          pomodoros++;
          toast(`🍅 完成一个番茄！(${pomodoros}/${targetPomodoros})，休息一下`, 'success', 4000);
          new Notification('核核工具箱', { body: `完成第 ${pomodoros} 个番茄，休息 ${restIn.value} 分钟` });
          phase = 'rest';
          total = (parseInt(restIn.value) || 5) * 60;
          statusText.textContent = `休息中 · ${restIn.value} 分钟`;
        } else {
          toast('休息结束，开始新番茄 🍅', 'success', 3000);
          new Notification('核核工具箱', { body: '休息结束，开始新的专注！' });
          phase = 'work';
          total = (parseInt(workIn.value) || 25) * 60;
          statusText.textContent = `专注模式 · 第 ${pomodoros + 1} 个番茄`;
        }
        remain = total;
        resetDisplay();
        start();
      }
      function resetDisplay() {
        display.textContent = fmt(mode === 'stopwatch' ? 0 : total);
        drawRing(1);
      }
      function start() {
        if (running) return;
        running = true;
        startTs = Date.now() - (mode === 'stopwatch' ? 0 : (total - remain) * 1000);
        timer = setInterval(tick, 200);
      }
      function stop() { running = false; clearInterval(timer); }
      window.App.onCleanup(() => stop());
      function setMode(m) {
        stop();
        mode = m;
        phase = 'work';
        if (m === 'pomodoro') { total = (parseInt(workIn.value) || 25) * 60; statusText.textContent = `专注模式 · 第 ${pomodoros + 1} 个番茄`; display.style.fontSize = '64px'; }
        else if (m === 'countdown') { total = (parseInt(workIn.value) || 25) * 60; statusText.textContent = '倒计时模式'; display.style.fontSize = '64px'; }
        else { statusText.textContent = '正计时（秒表）'; display.style.fontSize = '48px'; }
        remain = total;
        resetDisplay();
      }
      const btns = {};
      for (const [m, label] of [['pomodoro', '🍅 番茄钟'], ['countdown', '⏳ 倒计时'], ['stopwatch', '⏱ 正计时']]) {
        btns[m] = btn(label, 'btn-sm btn-secondary', () => {
          setMode(m);
          Object.values(btns).forEach(b => b.className = 'btn btn-sm btn-secondary');
          btns[m].className = 'btn btn-sm btn-primary';
        });
      }
      const startBtn = btn('▶ 开始', 'btn-primary', () => {
        if (mode === 'countdown') total = (parseInt(workIn.value) || 25) * 60;
        start();
      });
      const pauseBtn = btn('⏸ 暂停', 'btn-secondary', () => { stop(); if (mode !== 'stopwatch') startTs = Date.now() - (total - remain) * 1000; });
      const resetBtn = btn('↺ 重置', 'btn-secondary', () => { stop(); setMode(mode); });
      drawRing(1);
      page.appendChild(div('card', div('card-title', '模式', ...Object.values(btns)),
        statusText, display, ring,
        div('form-row', startBtn, pauseBtn, resetBtn)));
      page.appendChild(div('card', div('card-title', '参数'),
        div('form-row', h('span', { class: 'form-label' }, '专注时长(分)'), workIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '休息(分)'), restIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '目标番茄数'), countIn,
          h('span', { class: 'field-hint' }, `已完成 ${pomodoros}`))));
    }
  });

  /* ---------- 日历与农历 ---------- */
  register({
    id: 'calendar-lunar', name: '日历与农历', module: MOD, icon: 'calendar',
    desc: '公农历互转、月历视图、节日与节气查询',
    keywords: ['日历', '农历', '节气', '黄历'],
    render(page) {
      const today = new Date();
      let viewYear = today.getFullYear(), viewMonth = today.getMonth();
      const header = div('form-row');
      const grid = div('');
      const info = div('');
      let drawSeq = 0; // 连续点 ‹/› 时丢弃过期的绘制，避免两份日历交错
      async function draw() {
        const t = ++drawSeq;
        header.innerHTML = '';
        header.appendChild(btn('‹', 'btn-sm btn-secondary', () => { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } draw(); }));
        header.appendChild(h('span', { style: { fontWeight: 600, fontSize: '16px', minWidth: '140px', textAlign: 'center' } }, `${viewYear} 年 ${viewMonth + 1} 月`));
        header.appendChild(btn('›', 'btn-sm btn-secondary', () => { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } draw(); }));
        header.appendChild(btn('今天', 'btn-sm btn-text', () => { viewYear = today.getFullYear(); viewMonth = today.getMonth(); draw(); }));
        grid.innerHTML = '';
        const first = new Date(viewYear, viewMonth, 1);
        const days = new Date(viewYear, viewMonth + 1, 0).getDate();
        const startWeek = first.getDay();
        const table = h('table', { style: { width: '100%', borderCollapse: 'collapse', textAlign: 'center' } });
        const thead = h('thead', null, h('tr', null, ...['日', '一', '二', '三', '四', '五', '六'].map(d => h('th', { style: { padding: '8px', color: 'var(--text-3)', fontWeight: 500 } }, d))));
        const tbody = h('tbody');
        let row = h('tr');
        for (let i = 0; i < startWeek; i++) row.appendChild(h('td'));
        for (let d = 1; d <= days; d++) {
          let lunarText = '';
          try {
            const l = await invoke('lunar:s2l', viewYear, viewMonth + 1, d);
            if (t !== drawSeq) return;
            lunarText = l.isTerm ? l.term : (l.lDay === 1 ? l.monthCn : l.dayCn);
          } catch (e) { lunarText = ''; }
          const isToday = d === today.getDate() && viewMonth === today.getMonth() && viewYear === today.getFullYear();
          const td = h('td', { style: { padding: '8px 4px', borderRadius: '6px', cursor: 'pointer', background: isToday ? 'var(--primary)' : 'transparent', color: isToday ? '#fff' : 'var(--text-1)' } },
            h('div', { style: { fontWeight: isToday ? 600 : 400 } }, String(d)),
            h('div', { style: { fontSize: '11px', color: isToday ? 'rgba(255,255,255,0.85)' : 'var(--text-3)' } }, lunarText));
          td.addEventListener('click', () => showInfo(viewYear, viewMonth + 1, d));
          row.appendChild(td);
          if ((startWeek + d) % 7 === 0) { tbody.appendChild(row); row = h('tr'); }
        }
        if (row.children.length) tbody.appendChild(row);
        table.appendChild(thead); table.appendChild(tbody);
        if (t !== drawSeq) return;
        grid.appendChild(table);
      }
      async function showInfo(y, m, d) {
        try {
          const l = await invoke('lunar:s2l', y, m, d);
          info.innerHTML = '';
          const card = div('card');
          card.style.marginTop = '12px';
          card.appendChild(div('card-title', `${y}-${pad2(m)}-${pad2(d)} 农历信息`));
          card.appendChild(window.ui.kvGrid([
            ['农历', `${l.yearCn}年 ${l.monthCn}${l.dayCn}`],
            ['生肖', l.animal], ['干支', `${l.gzYear}年 ${l.gzMonth}月 ${l.gzDay}日`],
            ['节气', l.isTerm ? l.term : '无'], ['星期', l.ncWeek]
          ]));
          info.appendChild(card);
        } catch (e) { toast(e.message, 'error'); }
      }
      // 公历→农历 & 农历→公历 转换器
      const convCard = div('card', div('card-title', '公历 ↔ 农历 互转'));
      const sIn = h('input', { type: 'date', class: 'input input-sm' });
      sIn.value = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
      const sBtn = btn('公历 → 农历', 'btn-sm btn-primary', async () => {
        try {
          const [y, m, d] = sIn.value.split('-').map(Number);
          const l = await invoke('lunar:s2l', y, m, d);
          sOut.textContent = `${l.yearCn}年 ${l.monthCn}${l.dayCn}（${l.animal}年 · ${l.gzYear}${l.gzMonth}${l.gzDay}）`;
        } catch (e) { toast(e.message || String(e), 'error'); }
      });
      const sOut = h('span', { style: { userSelect: 'text' } }, '');
      const lY = h('input', { type: 'number', class: 'input input-sm', value: String(today.getFullYear()), style: { width: '90px' } });
      const lM = h('input', { type: 'number', class: 'input input-sm', value: '1', min: '1', max: '12', style: { width: '60px' } });
      const lD = h('input', { type: 'number', class: 'input input-sm', value: '1', min: '1', max: '30', style: { width: '60px' } });
      const lLeap = h('input', { type: 'checkbox', class: 'checkbox' });
      const lBtn = btn('农历 → 公历', 'btn-sm btn-secondary', async () => {
        try {
          const r = await invoke('lunar:l2s', parseInt(lY.value), parseInt(lM.value), parseInt(lD.value), lLeap.checked);
          if (r === -1) { lOut.textContent = '无效的农历日期'; return; }
          lOut.textContent = `${r.cYear}-${pad2(r.cMonth)}-${pad2(r.cDay)}`;
        } catch (e) { lOut.textContent = e.message; }
      });
      const lOut = h('span', { style: { userSelect: 'text' } }, '');
      convCard.appendChild(div('form-row', sIn, sBtn, sOut));
      convCard.appendChild(div('form-row', lY, '年 农历', lM, '月', lD, h('label', { class: 'field-hint' }, lLeap, '闰月'), lBtn, lOut));
      page.appendChild(div('card', header, grid));
      page.appendChild(convCard);
      page.appendChild(info);
      draw();
      showInfo(today.getFullYear(), today.getMonth() + 1, today.getDate());
    }
  });

  /* ---------- 便签 / 待办 ---------- */
  register({
    id: 'notes', name: '便签 / 待办', module: MOD, icon: 'note',
    desc: '桌面便签与待办清单，本地保存',
    keywords: ['便签', '待办', 'todo', '清单'],
    render(page) {
      const list = div('');
      const input = h('input', { class: 'input', placeholder: '记录一条待办 / 便签，回车添加…', style: { flex: '1' } });
      async function load() {
        const items = await invoke('store:get', 'notes', []);
        list.innerHTML = '';
        if (!items.length) { list.appendChild(div('empty-tip', '还没有便签，添加第一条吧')); return; }
        for (const it of [...items].sort((a, b) => (a.done - b.done) || (b.time - a.time))) {
          const cb = h('input', { type: 'checkbox', class: 'checkbox', checked: it.done });
          cb.addEventListener('change', async () => {
            const items = await invoke('store:get', 'notes', []);
            const t = items.find(x => x.id === it.id);
            if (t) t.done = cb.checked;
            await invoke('store:set', 'notes', items);
            load();
          });
          const row = div('form-row', cb,
            h('span', { style: { flex: '1', textDecoration: it.done ? 'line-through' : 'none', color: it.done ? 'var(--text-3)' : 'var(--text-1)', userSelect: 'text' } }, it.text),
            h('span', { class: 'field-hint' }, fmtDate(it.time, false)),
            btn('删除', 'btn-sm btn-text', async () => {
              const items = await invoke('store:get', 'notes', []);
              const idx = items.findIndex(x => x.id === it.id);
              if (idx < 0) { load(); return; } // 重复点击时条目已删，避免 splice(-1) 误删末条
              items.splice(idx, 1);
              await invoke('store:set', 'notes', items);
              load();
            }));
          list.appendChild(row);
        }
      }
      async function add() {
        const text = input.value.trim();
        if (!text) return;
        const items = await invoke('store:get', 'notes', []);
        items.push({ id: 'n' + Date.now(), text, done: false, time: Date.now() });
        await invoke('store:set', 'notes', items);
        input.value = '';
        load();
      }
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
      page.appendChild(div('card', div('card-title', '我的便签'),
        div('form-row', input, btn('添加', 'btn-primary', add))));
      page.appendChild(div('card', div('card-title', '清单'), list));
      load();
    }
  });

  /* ---------- 屏幕标尺 ---------- */
  register({
    id: 'screen-ruler', name: '屏幕标尺', module: MOD, icon: 'ruler',
    desc: '像素级透明悬浮标尺，横竖切换，实时读数',
    keywords: ['标尺', '像素', '测量'],
    render(page) {
      page.appendChild(window.ui.placeholder('ruler', '屏幕标尺', '点击下方按钮将打开一个透明悬浮的像素标尺窗口，支持横向 / 纵向切换，拖动边缘可调整长度，双击关闭。'));
      const openBtn = btn('📏 打开横向标尺', 'btn-primary btn-lg', () => openRuler('h'), 'ruler');
      const openVBtn = btn('📐 打开纵向标尺', 'btn-secondary btn-lg', () => openRuler('v'), 'ruler');
      async function openRuler(dir) {
        if (!isDesktop) return toast('桌面端可用', 'warn');
        try { await invoke('win:ruler', dir); } catch (e) { toast(e.message, 'error'); }
      }
      page.appendChild(div('card', div('form-row', openBtn, ' ', openVBtn)));
    }
  });
})();
