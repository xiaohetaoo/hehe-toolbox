/* 模块：文件处理 —— 目录搬家（复制到新盘 + 在原位建目录联接） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量表（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, confirmBox, renderTable, guard } = window.ui;
  const { invoke } = window.api;
  const MOD = 'file';

  register({
    id: 'dir-move',
    name: '目录搬家', nameEn: 'Move Folder',
    module: MOD,
    icon: 'folder',
    desc: '把大目录搬到别的盘，并在原位置建目录联接 —— 路径不变，空间腾出来', descEn: 'Move a large folder across drives safely, with pre-checks and resume',
    keywords: ['搬家', '迁移', '移动目录', 'junction', '联接', '腾空间', '符号链接', 'move'],
    render(page) {
      /* 【切页清理必须在同步阶段就注册】
       * 原来整个文件没有任何 App.onCleanup：DIR_MOVE.MOVE 是阻塞式长任务，
       * 用户切到别的页面之后整棵树还在复制，完成时 toast 弹在新页面上 ——
       * 「我没在搬东西，它却说搬完了」。
       *
       * 注意注册位置：渲染新页面时会先执行上一轮登记的清理，
       * 所以清理函数必须在这里（render 的同步阶段）挂上去；
       * 挂在点击后的 await 之后就已经属于"新页面的生命周期"了，等于没挂。
       * 变量用外层闭包承装，点击流程里只更新它的字段。 */
      let runUnsub = null;
      let runClaimedId = null;
      if (window.App && App.onCleanup) {
        App.onCleanup(() => {
          if (runUnsub) { try { runUnsub(); } catch (e) {} runUnsub = null; }
          /* 尽力请求停止：主进程若登记了 cancel 就真能停，没有也只是空操作，
           * 但至少不会再把事件推给已经销毁的页面。 */
          if (runClaimedId) {
            try { invoke(Channels.CHANNELS.JOB.KILL, runClaimedId).catch(() => {}); } catch (e) {}
            runClaimedId = null;
          }
        });
      }
      const state = {
        src: '',
        dst: '',
        precheck: null,
        /* 刚搬完：预检已作废、绿卡换成「已搬完」，要等路径变化才恢复 */
        moved: false,
        steps: [],      // { id, label, detail, status, note }
      };

      /* ---------------- 顶部说明：先讲清楚它到底做什么 ---------------- */
      page.appendChild(div('card',
        div('card-title', '它做什么？'),
        div('field-hint',
          '把「源目录」完整复制到新位置，校验无误后，把源目录改名为 .bak，' +
          '再在原路径上建一个目录联接（junction）指向新位置。'),
        div('field-hint', { style: { marginTop: '6px' } },
          '结果：程序仍然按原路径访问它（路径完全不变），但实际数据已经在新盘上 —— ' +
          '适合「C 盘满了但某软件只认固定路径」的场景。'),
        div('field-hint', { style: { marginTop: '6px', color: 'var(--text-3)' } },
          '注意：目录联接只在本机有效。如果把这个目录所在的位置同步到云端或拷到别的机器，' +
          '链接不会跟着走。源目录与目标必须在不同盘（同盘搬家没意义，直接移动即可）。')));

      /* ---------------- 选择源与目标 ---------------- */
      const srcInput = h('input', { class: 'input', placeholder: '源目录，例如 C:\\Users\\me\\AppData\\Local\\某软件', style: { flex: '1' } });
      const dstInput = h('input', { class: 'input', placeholder: '新位置，例如 D:\\MovedData\\某软件', style: { flex: '1' } });

      /* 路径一改，之前那次校验就作废：清空结论、禁用「开始搬家」。
       * 只靠执行前的比对还不够 —— 用户会长时间盯着一个「可以搬」的绿色结论
       * 却在操作一个完全不同的路径，必须让状态本身立刻变成「需重新校验」。 */
      const invalidate = () => {
        /* 【两个都要处理：校验过的结论、以及「已搬完」那张卡】
         * 早期这里只判 state.precheck，而搬家成功后会把它置空 ——
         * 于是改了路径，「已搬完」那张卡还挂在那儿，说的是另一个路径的事。
         * 现在多一个 moved 标记，两种状态都会在路径变化时清掉。 */
        if (!state.precheck && !state.moved) return;   // 本来就没结论，不用刷屏
        state.precheck = null;
        state.moved = false;
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
          const r = await invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: ['openDirectory'] });
          /* 程序改 value 不会触发 input 事件，必须显式作废校验结论 */
          if (r && r[0]) { srcInput.value = r[0]; autoFillDst(); invalidate(); }
        } catch (e) { toast(e.message, 'error'); }
      });
      const dstBrowse = btn('浏览…', 'btn-sm btn-secondary', async () => {
        try {
          const r = await invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: ['openDirectory'] });
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
      /* 【校验也要防重入】
       * 预检现在是「一次全树遍历（体积+链接）+ 必要时一次 PowerShell」，
       * 大目录上要几秒。双击「校验能不能搬」会并发两遍全树 IO，
       * 而且两次结论会互相覆盖（后一次未必对应界面上的路径）。 */
      const doCheck = guard(doCheckOnce);
      const checkBtn = btn('① 校验能不能搬', 'btn-primary', doCheck);

      async function doCheckOnce() {
        state.src = srcInput.value.trim();
        state.dst = dstInput.value.trim();
        if (!state.src) return toast('请填写源目录', 'warn');
        if (!state.dst) return toast('请填写新位置', 'warn');
        precheckBox.innerHTML = '<div class="card"><div class="field-hint">校验中…</div></div>';
        try {
          const r = await invoke(Channels.CHANNELS.DIR_MOVE.PRECHECK, { src: state.src, dst: state.dst });
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
      }

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
          /* 【读不到剩余空间时必须把话说全】
           * 原来只写「（未知）」，用户很容易扫一眼就当成"校验过了"。
           * 事实是：freeBytes 拿不到时 NO_SPACE 那条判据整段跳过 ——
           * 空间够不够**根本没校验**。搬家是「先完整复制再改名」的长流程，
           * 空间不够会拷到一半失败，所以这行必须把"未校验"讲明白。 */
          { k: '目标盘剩余', v: r.freeBytes != null ? fmtBytes(r.freeBytes)
            : (r.freeBytesUnknown ? '（无法获取，空间是否足够未校验）' : '（未知）') },
        ];
        /* 【源目录里的链接必须提前告知】
         * 搬家会把它们重建到新位置，用户若不知道，事后看到「多了一个链接」
         * 会以为是 bug（甚至是「被塞了东西」）。
         *
         * 【文案要区分「原样重建」与「改写目标」】
         * 早期这里一律写「会原样重建到新位置」，但对目标落在**源目录树内部**
         * 的链接（指向源自身、源内子目录、源内兄弟目录）必须把目标改写成
         * 新位置里的对应路径 —— 否则它指向的旧路径会随 .hehe-bak 一起被删，
         * 重建出来就是死链，而流程还显示「搬家完成」。
         * 所以这两类要分开说，做的事和文案才对得上。 */
        if (r.linkCount) {
          const parts = [];
          const inner = Number(r.innerLinkCount) || 0;
          const outer = r.linkCount - inner;
          if (outer > 0) parts.push(outer + ' 个指向源目录之外，原样重建');
          if (inner > 0) parts.push(inner + ' 个的目标在源目录内部，会改写成新位置的对应路径');
          rows.push({
            k: '源里的链接',
            v: r.linkCount + ' 个（' + parts.join('；') + '）' +
              (r.fileLinkCount ? '。其中 ' + r.fileLinkCount + ' 个是文件符号链接 —— ' +
                'Windows 创建符号链接需要特权，这一步可能失败' : ''),
          });
        }
        /* 占用查询本身失败（Restart Manager 报错）时如实说明：
         * 「查不到」不等于「没有占用」，两者混同会让用户反复重试。 */
        if (r.lockCheckError) {
          rows.push({ k: '占用检查', v: '查询失败：' + r.lockCheckError + '（这不代表没有占用）' });
        }
        /* 链接性质查询失败同理：查不到「目录还是文件」时重建会拒绝，
         * 而 fileLinkCount 会漏算 —— 那不代表没有文件链接。 */
        if (r.linkNaturesError) {
          rows.push({
            k: '链接性质',
            v: '查询失败：' + r.linkNaturesError +
              '（这不代表没有文件链接；目标在源目录内部的链接也可能因此没被查出）',
          });
        }
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

      /* ---------------- 执行 ----------------
       * 【防重入收口到 guard】
       * 原来这里是手写的 `if (state.running) return; state.running = true;`。
       * 手写标志要在每个出口都记得复位，本项目已经因为漏复位出过 7 次卡死；
       * 而且它在 confirmBox 的 await **之后**才置位 —— 连点两次会两次都进
       * 确认框。改用 ui.guard() 后并发第二次直接挡掉。
       * 按钮禁用/恢复仍写在业务里（不能用 guard 的 after 统一恢复：
       * 「路径已改动」那个早退分支是**故意**把按钮禁到重新校验为止的）。 */
      const goBtn = btn('② 开始搬家', 'btn-danger', guard(runMoveOnce));

      async function runMoveOnce() {
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
        runClaimedId = null;
        /* 【把「复制期间消失」的文案集中到一处】
         * 复制阶段与校验阶段都会遇到源条目被删，两个阶段各写一份文案的话，
         * 措辞迟早会不一致（而且早期那版把目录也算成「文件」）。
         * 这里按 skippedFiles / skippedDirs 分开说，为 0 的那类不提。 */
        const goneText = (files, dirs, examples, when) => {
          const f = files || 0, dd = dirs || 0;
          if (!f && !dd) return '';
          const parts = [];
          if (f) parts.push(f + ' 个文件');
          if (dd) parts.push(dd + ' 个目录');
          let s = '；⚠ ' + parts.join('、') + '在' + (when || '复制期间') + '从源目录消失，已跳过';
          const ex = Array.isArray(examples) ? examples : [];
          if (ex.length) s += '（如 ' + ex.slice(0, 3).join('、') + ((f + dd) > 3 ? ' 等' : '') + '）';
          return s;
        };
        runUnsub = window.api.on('job:stream', (d) => {
          if (!d || !d.id) return;
          if (!window.JobPrefix) return;
          if (!runClaimedId) {
            if (!window.JobPrefix.belongsTo(d.id, 'dirmv')) return;
            runClaimedId = d.id;
          } else if (d.id !== runClaimedId) {
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
          /* 链接重建：说清「改写了多少个目标」，这件事对用户是有后果的 ——
           * 那些链接现在指向新位置，而不是它原来的绝对路径。 */
          if (j.stage === 'copy' && j.ok === true && j.links != null) {
            note = j.links + ' 个链接已重建';
            if (j.innerRewritten) note += '（其中 ' + j.innerRewritten + ' 个的目标在源目录内部，已改写到新位置）';
            if (j.fileLinks) note += '；含 ' + j.fileLinks + ' 个文件符号链接';
            if (j.files != null) note = (j.files + ' 个文件、' + (j.dirs || 0) + ' 个目录已复制；' + note);
            /* 【复制期间消失的条目必须点名】
             * 这类跳过不是错误（源目录是活的，被别的程序删了很正常），
             * 但它意味着目标侧**比源侧少**了东西 —— 用户有权知道少了几个。
             * 不说明的话，后面校验发现数量对不上会让人怀疑搬家坏了。
             *
             * 【文件与目录要分开说】
             * 早期把两者合进一个计数却统一写成「N 个文件…消失」：
             * 消失的是一个目录时那句话直接是错的，用户会去数文件、数不出来。
             * 现在按 skippedFiles / skippedDirs 分别写，各为 0 就不提它。 */
            note += goneText(j.skippedFiles, j.skippedDirs, j.skippedExamples, '复制期间');
          }
          /* 链接性质查询失败：不是致命错，但必须让用户看见 ——
           * 否则后面「无法判断这个链接指向目录还是文件」会显得莫名其妙。 */
          if (j.linkNaturesError) note = '⚠ 链接性质查询失败：' + j.linkNaturesError + '（这不代表没有文件链接）';
          /* 校验阶段也可能遇到源条目被删（复制完、校验前）。主进程已经把
           * 两阶段的数字合并成一个总数传过来（避免出现「跳过 2 个」又「跳过 3 个」），
           * 所以这里只负责说清楚。 */
          if (j.stage === 'verify' && j.ok === true && j.skippedDisappeared) {
            note += goneText(j.skippedFiles, j.skippedDirs, j.skippedExamples, '复制期间');
          }
          setStep(j.stage, status, note);
        });

        let done = false;
        try {
          const r = await invoke(Channels.CHANNELS.DIR_MOVE.MOVE, { src: state.src, dst: state.dst });
          done = true;
          toast('搬家完成', 'success');
          stepsBox.appendChild(div('field-hint', { style: { padding: '8px 6px' } }, r.advice || ''));
          for (const s of state.steps) if (s.status === 'running') s.status = 'ok';
          renderSteps();

          /* 【搬完之后必须作废校验结论】
           * 源路径此刻已经变成「指向新位置的联接」，不可能再搬一次 —— 主进程
           * 会用 SRC_IS_LINK 拒掉。如果这里仍留着那张绿卡「可以搬」、
           * 按钮还点得动，用户点下去就弹「源本身已经是链接」：
           * 界面先说可以、再说不行，两个说法互相打脸。
           * 所以作废预检、把卡片换成「已搬完」的说明，并在路径变化前保持禁用
           * （invalidate() 已挂在两个输入框的 input 事件上，改路径就恢复）。 */
          state.precheck = null;
          state.moved = true;
          state.steps = [];
          precheckBox.innerHTML = '';
          precheckBox.appendChild(div('card',
            div('card-title', h('span', { class: 'tag tag-green', style: { marginRight: '8px' } }, '已搬完')),
            div('field-hint', '源路径现在是一个指向新位置的目录联接，不能对同一路径再搬一次。'),
            div('field-hint', { style: { marginTop: '4px', color: 'var(--text-3)' } },
              '如果要搬别的目录，改一下上面的路径（或点「浏览…」）就会重新启用校验。')));
        } catch (e) {
          toast(e.message, 'error');
          stepsBox.appendChild(div('card',
            div('card-title', h('span', { class: 'tag tag-red', style: { marginRight: '8px' } }, '搬家未完成')),
            div('field-err', '✗ ' + e.message)));
        } finally {
          try { if (runUnsub) runUnsub(); } catch (err) {}
          /* 成功时保持禁用（见上）；失败时才恢复可点，让用户能改完重试 */
          goBtn.disabled = done ? true : false;
        }
      }

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
