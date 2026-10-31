/* 模块：文件处理 —— 目录搬家（复制到新盘 + 在原位建目录联接） */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, confirmBox, renderTable } = window.ui;
  const { invoke } = window.api;
  const MOD = 'file';

  register({
    id: 'dir-move',
    name: '目录搬家',
    module: MOD,
    icon: 'folder',
    desc: '把大目录搬到别的盘，并在原位置建目录联接 —— 路径不变，空间腾出来',
    keywords: ['搬家', '迁移', '移动目录', 'junction', '联接', '腾空间', '符号链接', 'move'],
    render(page) {
      const state = {
        src: '',
        dst: '',
        precheck: null,
        running: false,
        steps: [],      // { id, label, detail, status, note }
      };

      /* ---------------- 顶部说明：先讲清楚它到底做什么 ---------------- */
      page.appendChild(div('card',
        div('card-title', '它做什么？'),
        div('field-hint',
          '把「源目录」完整复制到新位置，校验无误后，把源目录改名为 .bak，' +
          '再在**原路径**上建一个目录联接（junction）指向新位置。'),
        div('field-hint', { style: { marginTop: '6px' } },
          '结果：程序仍然按原路径访问它（路径完全不变），但实际数据已经在新盘上 —— ' +
          '适合「C 盘满了但某软件只认固定路径」的场景。'),
        div('field-hint', { style: { marginTop: '6px', color: 'var(--text-3)' } },
          '注意：目录联接只在本机有效。如果把这个目录所在的位置同步到云端或拷到别的机器，' +
          '链接不会跟着走。源目录与目标必须在**不同盘**（同盘搬家没意义，直接移动即可）。')));

      /* ---------------- 选择源与目标 ---------------- */
      const srcInput = h('input', { class: 'input', placeholder: '源目录，例如 C:\\Users\\me\\AppData\\Local\\某软件', style: { flex: '1' } });
      const dstInput = h('input', { class: 'input', placeholder: '新位置，例如 D:\\MovedData\\某软件', style: { flex: '1' } });

      /* 路径一改，之前那次校验就作废：清空结论、禁用「开始搬家」。
       * 只靠执行前的比对还不够 —— 用户会长时间盯着一个「可以搬」的绿色结论
       * 却在操作一个完全不同的路径，必须让状态本身立刻变成「需重新校验」。 */
      const invalidate = () => {
        if (!state.precheck) return;     // 本来就没校验过，不用刷屏
        state.precheck = null;
        goBtn.disabled = true;
        precheckBox.innerHTML = '';
        precheckBox.appendChild(div('card',
          div('card-title', '路径已修改，请重新校验'),
          div('field-hint', '源目录或新位置已经改动，之前那次校验的结论不再适用。' +
            '请重新点「① 校验能不能搬」。')));
      };
      /* 监听在 goBtn/precheckBox 声明之后才注册（见页面装配前那段）。
       * 事件回调里引用它们不会有 TDZ 问题，但把注册顺序与依赖顺序对齐
       * 能避免后人把这段代码挪到别处时踩坑。 */

      const srcBrowse = btn('浏览…', 'btn-sm btn-secondary', async () => {
        try {
          const r = await invoke('dialog:open', { properties: ['openDirectory'] });
          /* 程序改 value 不会触发 input 事件，必须显式作废校验结论 */
          if (r && r[0]) { srcInput.value = r[0]; autoFillDst(); invalidate(); }
        } catch (e) { toast(e.message, 'error'); }
      });
      const dstBrowse = btn('浏览…', 'btn-sm btn-secondary', async () => {
        try {
          const r = await invoke('dialog:open', { properties: ['openDirectory'] });
          if (r && r[0]) { dstInput.value = r[0]; invalidate(); }
        } catch (e) { toast(e.message, 'error'); }
      });

      /* 目标位置默认给个建议：同名的目录，但用户必须换成别的盘 */
      function autoFillDst() {
        if (!srcInput.value.trim()) return;
        if (dstInput.value.trim()) return;   // 用户已填过就不覆盖
        const base = srcInput.value.trim().split(/[\\/]/).filter(Boolean).pop() || 'moved';
        // 建议放在 D 盘（最常见的第二块盘）；用户可改
        dstInput.value = 'D:\\MovedData\\' + base;
      }

      const precheckBox = div('');
      const stepsBox = div('');

      /* ---------------- 校验 ---------------- */
      const checkBtn = btn('① 校验能不能搬', 'btn-primary', async () => {
        state.src = srcInput.value.trim();
        state.dst = dstInput.value.trim();
        if (!state.src) return toast('请填写源目录', 'warn');
        if (!state.dst) return toast('请填写新位置', 'warn');
        precheckBox.innerHTML = '<div class="card"><div class="field-hint">校验中…</div></div>';
        try {
          const r = await invoke('dir:move-precheck', { src: state.src, dst: state.dst });
          state.precheck = r;
          state.steps = (r.plan || []).map((s) => Object.assign({}, s, { status: 'idle', note: '' }));
          renderPrecheck();
          renderSteps();
          /* 校验通过才允许搬家；不通过则保持禁用，避免用户点下去才被拦 */
          goBtn.disabled = !r.ok;
        } catch (e) {
          precheckBox.innerHTML = '';
          precheckBox.appendChild(div('card', div('card-title', '校验失败'), div('field-err', '✗ ' + e.message)));
          state.precheck = null;
          goBtn.disabled = true;
        }
      });

      function renderPrecheck() {
        precheckBox.innerHTML = '';
        const r = state.precheck;
        if (!r) return;

        const card = div('card');
        if (!r.ok) {
          card.appendChild(div('card-title', h('span', { class: 'tag tag-red', style: { marginRight: '8px' } }, '不能搬')));
          card.appendChild(div('field-err', r.reason || '校验未通过'));
          if (r.advice) card.appendChild(div('field-hint', { style: { marginTop: '6px' } }, r.advice));
          precheckBox.appendChild(card);
          return;
        }

        card.appendChild(div('card-title', h('span', { class: 'tag tag-green', style: { marginRight: '8px' } }, '可以搬')));

        /* 把「这次要做什么」用数据摆出来，而不是让用户凭感觉 */
        const rows = [
          { k: '源目录', v: r.src },
          { k: '新位置', v: r.dst },
          { k: '需要空间', v: r.needBytes != null ? fmtBytes(r.needBytes) : '（无法预估）' },
          { k: '目标盘剩余', v: r.freeBytes != null ? fmtBytes(r.freeBytes) : '（未知）' },
        ];
        card.appendChild(renderTable({
          columns: [
            { key: 'k', title: '项目', width: '110px' },
            { key: 'v', title: '内容', render: (row) => h('span', { style: { fontSize: '12px', wordBreak: 'break-all', userSelect: 'text' } }, row.v) },
          ],
          rows, rowKey: (row) => row.k, empty: '无',
        }));
        precheckBox.appendChild(card);
      }

      /* ---------------- 逐步显示执行过程 ----------------
       * 搬家是一个有状态的链，用户必须能看到「现在到哪一步了」，
       * 尤其是「源已改名、链接还没建好」这个危险窗口。 */
      function renderSteps() {
        stepsBox.innerHTML = '';
        if (!state.steps.length) return;
        const card = div('card');
        card.appendChild(div('card-title', '执行步骤'));
        for (const s of state.steps) {
          const icon = {
            idle: '○', running: '◌', ok: '✓', fail: '✗', skip: '–',
          }[s.status] || '○';
          const color = {
            ok: 'var(--success, #00b42a)', fail: 'var(--danger, #f53f3f)',
            running: 'var(--primary)', idle: 'var(--text-3)',
          }[s.status] || 'var(--text-3)';
          const row = div('form-row', { style: { alignItems: 'flex-start', padding: '4px 0' } });
          row.appendChild(h('span', {
            style: { width: '18px', color, fontWeight: '600', flex: '0 0 auto' },
          }, icon));
          const body = div('', { style: { flex: '1' } });
          body.appendChild(div('', { style: { fontSize: '13px', fontWeight: s.status === 'running' ? '600' : '400' } }, s.label));
          body.appendChild(div('field-hint', { style: { marginTop: '1px' } }, s.note || s.detail));
          row.appendChild(body);
          card.appendChild(row);
        }
        stepsBox.appendChild(card);
      }

      function setStep(id, status, note) {
        const s = state.steps.find((x) => x.id === id);
        if (!s) return;
        s.status = status;
        if (note != null) s.note = note;
        renderSteps();
      }

      /* ---------------- 执行 ---------------- */
      const goBtn = btn('② 开始搬家', 'btn-danger', async () => {
        if (state.running) return;
        if (!state.precheck || !state.precheck.ok) {
          return toast('请先通过校验', 'warn');
        }
        /* 【执行前再核对一次输入框】
         * state.src/dst 是「校验通过那一刻」的值。用户完全可能校验完又去改
         * 输入框 —— 那时界面显示的是新路径，但真要搬的旧路径还在 state 里，
         * 搬错目录的后果是数据事故。所以这里必须用**当前输入框**跟 state 比对，
         * 不一致就拒绝并要求重新校验，不去猜用户想要哪个。 */
        const curSrc = srcInput.value.trim();
        const curDst = dstInput.value.trim();
        if (curSrc !== state.src || curDst !== state.dst) {
          state.precheck = null;
          goBtn.disabled = true;
          precheckBox.innerHTML = '';
          precheckBox.appendChild(div('card',
            div('card-title', '路径已修改，请重新校验'),
            div('field-hint', '你改了源目录或新位置，之前那次校验的结论已经不适用了。' +
              '请重新点「① 校验能不能搬」。')));
          return toast('路径已修改，请重新校验', 'warn');
        }
        const ok = await confirmBox({
          title: '确认开始搬家',
          message:
            '源目录：' + state.src + '\n新位置：' + state.dst + '\n\n' +
            '流程：复制 → 校验 → 源目录改名 .bak → 原位置建链接 → 验证链接 → 删备份。\n' +
            '中途任何一步失败都会自动回退，最终保证原路径能打开东西。\n\n' +
            '搬家期间请不要操作这两个目录。',
          danger: true, okText: '开始',
        });
        if (!ok) return;

        state.running = true;
        goBtn.disabled = true;
        for (const s of state.steps) { s.status = 'idle'; s.note = ''; }
        renderSteps();

        /* 订阅 job:stream 拿到逐步进度。
         * 【id 由主进程生成，渲染层不自己拼】
         * 早期这里拼 'dirmv-' + Date.now()：带连字符，不符合项目
         * 「前缀 + 纯数字」的约定，也不在 lib/job-id.js / js/job-prefixes.js
         * 两张表里 —— belongsTo 永远匹配不上，test-job-prefix-sync 也覆盖不到。
         * 现在不传 jobId，让主进程按 jobSeq 生成 dirmv<序号>；
         * 渲染层这里按前缀认领（搬家是主进程单飞的，同一时刻只会有一个 dirmv 任务）。 */
        let claimedId = null;
        const unsub = window.api.on('job:stream', (d) => {
          if (!d || !d.id) return;
          if (!window.JobPrefix) return;
          if (!claimedId) {
            if (!window.JobPrefix.belongsTo(d.id, 'dirmv')) return;
            claimedId = d.id;
          } else if (d.id !== claimedId) {
            return;
          }
          let j = null;
          try { j = JSON.parse(d.data); } catch (e) { return; }
          if (!j || !j.stage) return;
          if (j.stage === 'done') return;
          const status = j.ok === null ? 'running' : (j.ok ? 'ok' : 'fail');
          let note = '';
          if (j.error) note = '失败：' + j.error;
          if (j.files != null) note = '校验通过：' + j.files + ' 个文件，抽样哈希 ' + (j.hashed || 0) + ' 个';
          if (j.sampled != null) note = '链接可读，抽查 ' + j.sampled + ' 个文件';
          if (j.restored === false) note = '⚠ 回退也失败了，请按提示手动恢复';
          setStep(j.stage, status, note);
        });

        try {
          const r = await invoke('dir:move', { src: state.src, dst: state.dst });
          toast('搬家完成', 'success');
          stepsBox.appendChild(div('field-hint', { style: { padding: '8px 6px' } }, r.advice || ''));
          for (const s of state.steps) if (s.status === 'running') s.status = 'ok';
          renderSteps();
        } catch (e) {
          toast(e.message, 'error');
          stepsBox.appendChild(div('card',
            div('card-title', h('span', { class: 'tag tag-red', style: { marginRight: '8px' } }, '搬家未完成')),
            div('field-err', '✗ ' + e.message)));
        } finally {
          try { unsub && unsub(); } catch (err) {}
          state.running = false;
          goBtn.disabled = false;
        }
      });

      page.appendChild(div('card',
        div('card-title', '① 选择源目录与新位置'),
        div('form-row', h('span', { class: 'form-label' }, '源目录'), srcInput, ' ', srcBrowse),
        div('form-row', h('span', { class: 'form-label' }, '新位置'), dstInput, ' ', dstBrowse),
        div('form-row', checkBtn, ' ', goBtn)));

      page.appendChild(precheckBox);
      page.appendChild(stepsBox);

      /* 到这里 goBtn / precheckBox 都已就绪，再挂「路径改动即作废校验」的监听。
       * 浏览器选择框（浏览…）也会改 input.value，但它不触发 input 事件 ——
       * 所以那段末尾显式调了一次 invalidate（见 srcBrowse/dstBrowse）。 */
      srcInput.addEventListener('input', invalidate);
      dstInput.addEventListener('input', invalidate);
    },
  });
})();
