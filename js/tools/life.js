/* 模块：生活辅助 —— 番茄钟 / 日历农历 / 便签待办 / 屏幕标尺 */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
  const { div, btn, toast, confirmBox, promptBox, pad2, fmtDate, makeButtonLike } = window.ui;
  const { invoke, isDesktop } = window.api;
  const MOD = 'life';

  /* ---------- 番茄钟 / 倒计时 ---------- */
  register({
    id: 'pomodoro', name: '番茄钟 / 倒计时', nameEn: 'Pomodoro', module: MOD, icon: 'timer',
    desc: '专注计时、正计时、倒计时，完成自动提醒', descEn: 'Pomodoro timer with focus and break cycles',
    keywords: ['番茄钟', '专注', '倒计时', '计时'],
    render(page) {
      let mode = 'pomodoro'; // pomodoro | countdown | stopwatch
      let total = 25 * 60, remain = 25 * 60, running = false, timer = null, startTs = 0;
      let swElapsed = 0; // 秒表已累计秒数：暂停时冻结，开始时用它扣回锚点
      const display = h('div', { class: 'stat-num', style: { fontSize: '64px', textAlign: 'center', fontVariantNumeric: 'tabular-nums', position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' } }, '25:00');
      const statusText = h('div', { style: { textAlign: 'center', color: 'var(--text-3)', marginBottom: '10px' } }, '专注模式 · 25 分钟');
      // 数字叠在圆环中央，作为一个整体呈现
      const ring = h('div', { style: { position: 'relative', display: 'flex', justifyContent: 'center', margin: '10px 0 18px' } });
      const canvas = h('canvas', { width: 220, height: 220 });
      ring.appendChild(canvas);
      ring.appendChild(display);
      const workIn = h('input', { type: 'number', class: 'input input-sm', value: '25', min: '1', max: '120', style: { width: '70px' } });
      const restIn = h('input', { type: 'number', class: 'input input-sm', value: '5', min: '1', max: '60', style: { width: '70px' } });
      const countIn = h('input', { type: 'number', class: 'input input-sm', value: '4', min: '1', max: '20', style: { width: '70px' } });
      let pomodoros = 0, targetPomodoros = 4, phase = 'work';
      /* 【「已完成」必须是可更新的节点，不是一次性文本】
       * 原来是 h('span', ..., `已完成 ${pomodoros}`) —— 字符串在 render 时就定死了，
       * 之后 pomodoros 再变也不会刷新，用户永远看到「已完成 0」。 */
      const doneEl = h('span', { class: 'field-hint' }, '');
      function paintDone() { doneEl.textContent = `已完成 ${pomodoros} / ${targetPomodoros}`; }
      /* 【「目标番茄数」输入框必须真的被读取】
       * countIn 原来创建后从未被读过，targetPomodoros 恒为 4 ——
       * 用户改成 8 也没用，toast 里永远显示 (1/4)。
       * 在一轮开始之前（setMode 与 start 的第一次开始）读一次即可：
       * 中途改目标会让「已完成 N」的含义漂移。 */
      function readTarget() {
        const v = parseInt(countIn.value, 10);
        targetPomodoros = Math.max(1, Math.min(20, Number.isFinite(v) ? v : 4));
        paintDone();
      }
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
          /* 【这里曾有一句 clip:write-text ''，已删除】
           * 倒计时结束会**清空用户剪贴板** —— 而番茄钟、休息两条分支都没有
           * 这个动作，代码里也找不出任何理由解释它（不是粘贴、不是复制）。
           * 用户可能正好复制了一段要粘贴的内容，倒计时一响就没了。
           * 提醒本身已经由 toast + Notification 完成，不需要碰剪贴板。 */
          toast('⏰ 倒计时结束！', 'success', 4000);
          new Notification('核核工具箱', { body: '倒计时结束！' });
          return;
        }
        if (phase === 'work') {
          pomodoros++;
          paintDone();
          toast(`完成一个番茄！(${pomodoros}/${targetPomodoros})，休息一下`, 'success', 4000);
          new Notification('核核工具箱', { body: `完成第 ${pomodoros} 个番茄，休息 ${restIn.value} 分钟` });
          phase = 'rest';
          total = (parseInt(restIn.value) || 5) * 60;
          statusText.textContent = `休息中 · ${restIn.value} 分钟`;
        } else {
          toast('休息结束，开始新番茄', 'success', 3000);
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
        /* 【秒表必须从暂停点续计】原来秒表分支写死 `- 0`，锚点被拉回当前时刻，
         * 于是「暂停 → 再点开始」等于把已计时清零重来（番茄钟/倒计时因为
         * 用 (total - remain) 重锚而没这个问题）。
         * 这里给秒表另存一个已计秒数 swElapsed，暂停时冻结，开始时扣回去。 */
        if (mode === 'stopwatch') {
          startTs = Date.now() - swElapsed * 1000;
        } else {
          startTs = Date.now() - (total - remain) * 1000;
        }
        timer = setInterval(tick, 200);
      }
      function stop() {
        // 暂停/切换前先把秒表的已计时冻结下来，供 start() 扣回
        if (mode === 'stopwatch' && running) swElapsed = (Date.now() - startTs) / 1000;
        running = false; clearInterval(timer);
      }
      /* 【切页处理】计时器跨页存续是常见预期，但整页销毁时 DOM 也没了，
       * 计时器留着会变成「看不见还在跑」的幽灵任务。
       * 折中做法：切页时停表，但**明确告知**用户已经停了，
       * 而不是静默归零让人以为功能坏了。 */
      window.App.onCleanup(() => {
        if (!running) return;
        stop();
        toast('计时已暂停（离开页面会导致计时停止）', 'warn', 2600);
      });
      function setMode(m) {
        stop();
        mode = m;
        phase = 'work';
        swElapsed = 0; // 切模式/重置都要把秒表累计清零，否则「重置」后会从旧值接着走
        if (m === 'pomodoro') { readTarget(); total = (parseInt(workIn.value) || 25) * 60; statusText.textContent = `专注模式 · 第 ${pomodoros + 1} 个番茄`; display.style.fontSize = '64px'; }
        else if (m === 'countdown') { total = (parseInt(workIn.value) || 25) * 60; statusText.textContent = '倒计时模式'; display.style.fontSize = '64px'; }
        else { statusText.textContent = '正计时（秒表）'; display.style.fontSize = '48px'; }
        remain = total;
        resetDisplay();
      }
      const btns = {};
      for (const [m, label, iconName] of [['pomodoro', '番茄钟', 'timer'], ['countdown', '倒计时', 'clock'], ['stopwatch', '正计时', 'activity']]) {
        btns[m] = btn(label, 'btn-sm btn-secondary', () => {
          setMode(m);
          Object.values(btns).forEach(b => b.className = 'btn btn-sm btn-secondary');
          btns[m].className = 'btn btn-sm btn-primary';
        }, iconName);
      }
      const startBtn = btn('开始计时', 'btn-primary', () => {
        if (mode === 'countdown') total = (parseInt(workIn.value) || 25) * 60;
        start();
      }, 'play');
      const pauseBtn = btn('暂停', 'btn-secondary', () => { stop(); if (mode !== 'stopwatch') startTs = Date.now() - (total - remain) * 1000; }, 'timer');
      const resetBtn = btn('重置', 'btn-secondary', () => { stop(); setMode(mode); }, 'refresh');
      drawRing(1);
      page.appendChild(div('card', div('card-title', '模式', ...Object.values(btns)),
        statusText, ring,
        div('form-row', startBtn, pauseBtn, resetBtn)));
      page.appendChild(div('card', div('card-title', '参数'),
        div('form-row', h('span', { class: 'form-label' }, '专注时长（分）'), workIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '休息（分）'), restIn,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '目标番茄数'), countIn,
          doneEl)));
      /* 首屏就把「已完成 0 / 目标 N」算出来（原来这里是一次性文本，永远是 0）。
       * 加 change 监听：用户改目标后立刻反映到文案上，不用等到开始计量。 */
      readTarget();
      countIn.addEventListener('change', readTarget);
    }
  });

  /* ---------- 日历与农历 ---------- */
  register({
    id: 'calendar-lunar', name: '日历与农历', nameEn: 'Calendar & Lunar', module: MOD, icon: 'calendar',
    desc: '公农历互转、月历视图、节日与节气查询', descEn: 'Solar and lunar date conversion with festivals and the 24 solar terms',
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
            const l = await invoke(Channels.CHANNELS.LUNAR.S2L, viewYear, viewMonth + 1, d);
            if (t !== drawSeq) return;
            lunarText = l.isTerm ? l.term : (l.lDay === 1 ? l.monthCn : l.dayCn);
          } catch (e) { lunarText = ''; }
          const isToday = d === today.getDate() && viewMonth === today.getMonth() && viewYear === today.getFullYear();
          const td = h('td', { style: { padding: '8px 4px', borderRadius: '6px', cursor: 'pointer', background: isToday ? 'var(--primary)' : 'transparent', color: isToday ? '#fff' : 'var(--text-1)' } },
            h('div', { style: { fontWeight: isToday ? 600 : 400 } }, String(d)),
            h('div', { style: { fontSize: '11px', color: isToday ? 'rgba(255,255,255,0.85)' : 'var(--text-3)' } }, lunarText));
          /* 日历格子是这一页唯一的交互区，纯鼠标的话键盘用户
           * 连「看看这个月某天的农历」都做不到。读屏名称带上完整日期。 */
          makeButtonLike(td, viewYear + '-' + pad2(viewMonth + 1) + '-' + pad2(d) + (lunarText ? ' ' + lunarText : ''));
          td.addEventListener('click', () => showInfo(viewYear, viewMonth + 1, d));
          row.appendChild(td);
          if ((startWeek + d) % 7 === 0) { tbody.appendChild(row); row = h('tr'); }
        }
        if (row.children.length) tbody.appendChild(row);
        table.appendChild(thead); table.appendChild(tbody);
        if (t !== drawSeq) return;
        grid.appendChild(table);
      }
      // 详情请求同样要序号守卫：连续点 3 号、15 号时，若 3 号的 IPC 后返回，
      // 标题用的是后一次的 y/m/d，内容却是 3 号的农历 —— 用户看到自相矛盾的数据。
      let infoSeq = 0;
      async function showInfo(y, m, d) {
        const token = ++infoSeq;
        try {
          const l = await invoke(Channels.CHANNELS.LUNAR.S2L, y, m, d);
          if (token !== infoSeq) return; // 已切到别的日期，丢弃过期响应
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
        } catch (e) { if (token === infoSeq) toast(e.message, 'error'); }
      }
      // 公历→农历 & 农历→公历 转换器
      const convCard = div('card', div('card-title', '公历 ↔ 农历 互转'));
      const sIn = h('input', { type: 'date', class: 'input input-sm' });
      sIn.value = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
      const sBtn = btn('公历 → 农历', 'btn-sm btn-primary', async () => {
        try {
          const [y, m, d] = sIn.value.split('-').map(Number);
          const l = await invoke(Channels.CHANNELS.LUNAR.S2L, y, m, d);
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
          const r = await invoke(Channels.CHANNELS.LUNAR.L2S, parseInt(lY.value), parseInt(lM.value), parseInt(lD.value), lLeap.checked);
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
    id: 'notes', name: '便签 / 待办', nameEn: 'Sticky Notes & To-do', module: MOD, icon: 'note',
    desc: '桌面便签与待办清单，本地保存', descEn: 'Desktop sticky notes and a to-do list, saved locally',
    keywords: ['便签', '待办', 'todo', '清单'],
    render(page) {
      const list = div('');
      const input = h('input', { class: 'input', placeholder: '记录一条待办 / 便签，回车添加…', style: { flex: '1' } });
      async function load() {
        const items = await invoke(Channels.CHANNELS.STORE.GET, 'notes', []);
        list.innerHTML = '';
        if (!items.length) { list.appendChild(div('empty-tip', '还没有便签，添加第一条吧')); return; }
        for (const it of [...items].sort((a, b) => (a.done - b.done) || (b.time - a.time))) {
          const cb = h('input', { type: 'checkbox', class: 'checkbox', checked: it.done });
          cb.addEventListener('change', async () => {
            /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
            const items = await invoke(Channels.CHANNELS.STORE.GET, 'notes', []);
            const t = items.find(x => x.id === it.id);
            if (t) t.done = cb.checked;
            await invoke(Channels.CHANNELS.STORE.SET, 'notes', items);
            load();
          });
          const row = div('form-row', cb,
            h('span', { style: { flex: '1', textDecoration: it.done ? 'line-through' : 'none', color: it.done ? 'var(--text-3)' : 'var(--text-1)', userSelect: 'text' } }, it.text),
            h('span', { class: 'field-hint' }, fmtDate(it.time, false)),
            btn('删除', 'btn-sm btn-text', async () => {
              /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
              const items = await invoke(Channels.CHANNELS.STORE.GET, 'notes', []);
              const idx = items.findIndex(x => x.id === it.id);
              if (idx < 0) { load(); return; } // 重复点击时条目已删，避免 splice(-1) 误删末条
              items.splice(idx, 1);
              await invoke(Channels.CHANNELS.STORE.SET, 'notes', items);
              load();
            }));
          list.appendChild(row);
        }
      }
      async function add() {
        const text = input.value.trim();
        if (!text) return;
        const items = await invoke(Channels.CHANNELS.STORE.GET, 'notes', []);
        items.push({ id: 'n' + Date.now(), text, done: false, time: Date.now() });
        await invoke(Channels.CHANNELS.STORE.SET, 'notes', items);
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
    id: 'screen-ruler', name: '屏幕标尺', nameEn: 'Screen Ruler', module: MOD, icon: 'ruler',
    desc: '像素级透明悬浮标尺，横竖切换，实时读数', descEn: 'Measure pixels on screen with a horizontal or vertical ruler',
    keywords: ['标尺', '像素', '测量'],
    render(page) {
      page.appendChild(window.ui.placeholder('ruler', '屏幕标尺', '点击下方按钮将打开一个透明悬浮的像素标尺窗口，支持横向 / 纵向切换，拖动边缘可调整长度，双击关闭。'));
      const openBtn = btn('打开横向标尺', 'btn-primary btn-lg', () => openRuler('h'), 'ruler');
      const openVBtn = btn('打开纵向标尺', 'btn-secondary btn-lg', () => openRuler('v'), 'ruler');
      async function openRuler(dir) {
        if (!isDesktop) return toast('桌面端可用', 'warn');
        try { await invoke(Channels.CHANNELS.WIN.RULER, dir); } catch (e) { toast(e.message, 'error'); }
      }
      page.appendChild(div('card', div('form-row', openBtn, ' ', openVBtn)));
    }
  });
})();
