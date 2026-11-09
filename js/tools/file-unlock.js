/* 模块：文件处理 —— 文件占用解锁（查谁占着文件） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量表（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, confirmBox, filePicker, renderTable, guard } = window.ui;
  const { invoke } = window.api;
  const MOD = 'file';

  register({
    id: 'file-unlock',
    name: '文件占用解锁', nameEn: 'File Unlock',
    module: MOD,
    icon: 'lock',
    desc: '删不掉、提示被占用时，查出是哪个进程占着它，并可一键结束它来解锁（Windows Restart Manager）', descEn: 'Find which process is locking a file and release it by closing that process',
    keywords: ['占用', '解锁', '删不掉', '被占用', 'lock', 'unlock', 'handle', '正在使用'],
    render(page) {
      const state = { items: [], lockers: [], notes: [] };

      /* 顶部说明：讲清「能做什么、不能做什么」。
       * 同类工具常号称「强制解锁」，实际是杀进程或强删句柄，
       * 两者都可能让占用方丢数据。这里明确说清手段与代价。 */
      page.appendChild(div('card',
        div('card-title', '为什么删不掉？'),
        div('field-hint',
          'Windows 上文件被程序打开时无法删除或改名，系统只会提示「文件正在使用」。' +
          '本工具用 Windows 自带的 Restart Manager 查出具体是哪个进程占着它。'),
        div('field-hint', { style: { marginTop: '6px' } },
          '查到之后可以「结束它并解锁」—— 这是 Windows 上唯一可靠的解锁手段：' +
          '实测文件被独占打开时，删除 / 改名 / 清空内容全部返回「设备忙」，' +
          '只有结束持有它的进程才能真正解开。所以这里不提供"静默强删"，' +
          '而是把要结束谁、为什么结束摆在你面前。'),
        div('field-hint', { style: { marginTop: '6px', display: 'flex', alignItems: 'flex-start', gap: '6px' } },
          window.ui.icon('alert', { size: 14, style: { flex: '0 0 auto', marginTop: '2px' } }),
          h('span', null,
            '强制结束进程会让占用方丢失未保存的数据。请先确认那确实是你在用的程序，' +
            '系统服务与系统关键进程会被拒绝。'))));

      const picker = filePicker({
        text: '选择或拖入被占用的文件 / 目录',
        multiple: true,
        /* 【不要用 directory: true —— 它会把对话框锁成"只能选一个目录"】
         * dropzone 里 props 的取法是：
         *   pickProps || (directory ? ['openDirectory'] : (multiple ? ['openFile','multiSelections'] : ['openFile']))
         * 也就是说 directory:true 时 **multiple 完全不生效**，props 恒为
         * ['openDirectory']。后果有两条，都对不上界面文案：
         *   ① 点「选择目标」只能选**目录**，选不了单个文件 ——
         *      而"删不掉某个文件"正是这个工具最主流的用法；
         *   ② 只能选**一个**目录，没法一次查多个。
         * 用户会把文件拖进来绕过去（拖拽走的是另一条路径，不经过这个 props），
         * 于是"拖能用、点不能用"——这种半坏最难被发现，也最容易让人以为软件坏了。
         *
         * 正确写法与本项目 zip-tool 一致：显式给 pickProps，让文件与目录
         * 都能选、且支持多选。 */
        pickProps: ['openFile', 'openDirectory', 'multiSelections'],
        onChange: (items) => {
          /* 【保留 isDir：它就是「目录还是文件」的唯一真实来源】
           * fileList 的字段名是 isDir（不是 dir），而且在 add() 里初始是 false，
           * 真正的类型要等 fs:stat-multi 回来才被异步补上（见 ui.js 的 flushSizes）。
           * 早期这里 map 成 {path, name} 把它整个丢掉，导致 scan() 里判 it.dir
           * 恒为 undefined，file:who-locks-dir 永远走不到 ——
           * 「删不掉目录」这个最主要的用法反而永远得到「没有检测到占用」。
           * 所以这里留着它，并且**不假设它已经有值**：
           * undefined 表示「还没查出来」，交给 ensureTypes() 去确认，
           * 不要拿 false 当「它是文件」。 */
          state.items = items.map((x) => ({
            path: x.path,
            name: x.name || String(x.path).split(/[\\/]/).pop(),
            isDir: (typeof x.isDir === 'boolean') ? x.isDir : undefined,
            size: x.size,
          }));
          state.lockers = [];
          state.notes = [];
          renderResult();
        },
      });

      const resultBox = div('');

      function renderResult() {
        resultBox.innerHTML = '';
        if (!state.items.length) return;

        /* ---------- 还没查：只显示已选目标 ---------- */
        if (!state.lockers.length && !state.notes.length) {
          const card = div('card');
          card.appendChild(div('card-title', '已选 ' + state.items.length + ' 项'));
          for (const it of state.items) {
            card.appendChild(div('form-row',
              h('span', { style: { flex: '1', fontSize: '12px', wordBreak: 'break-all' } }, it.path)));
          }
          resultBox.appendChild(card);
          return;
        }

        /* ---------- 没查到占用 ---------- */
        if (!state.lockers.length) {
          resultBox.appendChild(div('card',
            div('card-title', '没有检测到占用进程'),
            div('field-hint',
              '这通常意味着：① 文件其实已经没被占用了（重新试一次删除即可）；' +
              '② 占用来自权限不足而非进程占用；' +
              '③ 占用方是驱动或杀毒软件的实时扫描（Restart Manager 看不到这类）。')));
          for (const n of state.notes) {
            resultBox.appendChild(div('field-hint', { style: { padding: '2px 6px' } }, n));
          }
          return;
        }

        /* ---------- 查到占用：表格 + 每个进程一个结束按钮 ---------- */
        const card = div('card');
        card.appendChild(div('card-title', '占用进程（' + state.lockers.length + ' 个）'));
        card.appendChild(renderTable({
          columns: [
            { key: 'pid', title: 'PID', width: '80px' },
            {
              key: 'name', title: '进程',
              render: (row) => {
                const wrap = h('span');
                wrap.appendChild(h('span', null, row.name || row.procName || '（未知）'));
                if (row.type === 'service') {
                  wrap.appendChild(h('span', { class: 'tag tag-orange', style: { marginLeft: '6px' } }, '服务'));
                }
                return wrap;
              },
            },
            {
              key: 'path', title: '可执行文件',
              render: (row) => h('span', { title: row.path || '', style: { fontSize: '11px', wordBreak: 'break-all' } }, row.path || '—'),
            },
            {
              key: 'files', title: '占用的文件',
              render: (row) => h('span', { style: { fontSize: '11px', wordBreak: 'break-all' }, title: row.files.join('\n') },
                row.files.length === 1
                  ? String(row.files[0]).split(/[\\/]/).pop()
                  : row.files.length + ' 项'),
            },
          ],
          rows: state.lockers,
          rowKey: (row) => row.pid,
          empty: '没有占用进程',
        }));

        /* 操作区：逐行一个按钮，文案带进程名，避免「结束进程 ×N」分不清谁是谁 */
        const ops = div('form-row');
        for (const row of state.lockers) {
          const label = '结束「' + (row.name || row.procName || ('PID ' + row.pid)) + '」并解锁';
          ops.appendChild(btn(label, 'btn-sm btn-danger-plain', () => unlockOne(row)));
        }
        /* 【一次性解锁全部：这是用户最想要的入口】
         * 删除一个被占用的文件时，占用它的常常不止一个进程
         * （编辑器 + 预览器 + 杀软扫描）。逐个点既慢又容易漏，
         * 漏掉一个就还是删不掉。这里给一个"全部结束"的按钮，
         * 但仍然走同一条后台通道（通道里逐 pid 过安全判据）。
         * 文案里写明数量，让用户在点之前就知道会影响几个进程。 */
        if (state.lockers.length > 1) {
          ops.appendChild(btn('全部结束（' + state.lockers.length + ' 个）并解锁', 'btn-sm btn-danger-plain',
            () => unlockOne(null)));
        }
        card.appendChild(ops);
        resultBox.appendChild(card);

        for (const n of state.notes) {
          resultBox.appendChild(div('field-hint', { style: { padding: '4px 6px' } }, n));
        }
        resultBox.appendChild(div('field-hint', { style: { padding: '8px 6px' } },
          '建议：先回到占用它的那个程序里保存并关闭，再重新删除。' +
          '只有确认那是你自己的程序、且没有未保存内容时，才用上面的「结束并解锁」。'));
      }

      /* 解锁：结束占用进程 → 复核 → 自动重查。
       * 【走 UNLOCK 通道而不是连调 PROC.KILL】
       * 后台会重新查一遍占用、逐 pid 过安全判据、杀完再复核，
       * 三步原子，界面不会停在"进程杀了但文件还在占用"这种半截状态。
       * 详见 lib/channels.js 里 UNLOCK 的注释。 */
      async function unlockOne(row) {
        const targets = row ? [row] : state.lockers.slice();
        if (!targets.length) return;
        const names = targets.map((x) => x.procName || x.name || ('PID ' + x.pid));
        /* 服务类先在界面上挡一层：后台也会挡，但提前说清能少一次无谓的确认 */
        const svc = targets.filter((x) => x.type === 'service');
        if (row && svc.length) {
          return toast('这是系统服务，请到「服务管理」里停止它，不要直接结束', 'warn');
        }
        const ok = await confirmBox({
          title: targets.length === 1 ? '结束进程并解锁' : '结束 ' + targets.length + ' 个进程并解锁',
          message: '将要结束：' + names.join('、') + '。\n\n' +
            '注意：如果它们正在处理你的文件，未保存的数据会丢失。\n' +
            '系统关键进程与服务会被自动拒绝。\n\n' +
            '结束后会自动重查一次，确认文件是否真的解开了。',
          danger: true, okText: '结束并解锁',
        });
        if (!ok) return;
        const paths = state.items.map((it) => it.path);
        try {
          const r = await invoke(Channels.CHANNELS.ACL_LINKS.UNLOCK, {
            paths,
            pids: targets.map((x) => x.pid),
          });
          /* 文案统一由主进程给（unlockSummary），界面只负责展示 ——
           * 两边各拼一份必然分叉：主进程说"已结束 2 个"、界面说"解锁成功"，
           * 而实际上文件还锁着。 */
          if (r && r.summary) {
            toast(r.summary, r.ok ? 'success' : 'warn', r.ok ? 2600 : 5000);
          }
          /* 【三种"没做成"要分别说清，不能都靠 summary 一句带过】
           * 真机验证时踩到：持有者在我们查询之后自行退出了，
           * 通道返回 { ok:false, missing:[pid], reason:'已经不在占用列表里' }，
           * 而当时的界面**一个字都没显示** —— 用户点了「结束并解锁」，
           * 既没看到成功也没看到失败，只能反复点。
           * 这里把三类结果都落到 notes 上：
           *   missing  已经自己退出了（等于解锁了，但要说清）
           *   blocked  被安全判据拒绝（要解释为什么）
           *   failed   执行失败（带原因） */
          const notes = [];
          if (r && r.missing && r.missing.length) {
            notes.push('这些进程已经自行退出，无需结束：' + r.missing.join('、') +
              '（文件现在应该可以删了，可以再试一次原操作）');
          }
          for (const b of (r && r.blocked) || []) {
            notes.push('未结束「' + b.name + '」（PID ' + b.pid + '）：' + b.reason);
          }
          for (const f of (r && r.failed) || []) {
            notes.push('结束「' + f.name + '」（PID ' + f.pid + '）失败：' + (f.error || '未知原因'));
          }
          if (r && r.stillLocked) {
            notes.push('文件仍然被占用' + (r.remaining && r.remaining.length
              ? '：' + r.remaining.map((x) => (x.name || 'PID ' + x.pid)).join('、')
              : '') + '。可能是驱动或杀软扫描（这类占用 Restart Manager 看不到），建议重启后再试。');
          }
          /* reason 只在"完全没做事"时补一句，避免与上面的 notes 重复 */
          if (r && !r.killed.length && !notes.length && r.reason) notes.push(r.reason);
          state.notes = notes;
        } catch (e) {
          toast(window.api.errText ? window.api.errText(e) : (e && e.message) || '解锁失败', 'error');
          state.notes = [];
        }
        scan();   // 无论成败都重查：失败了也要让用户看到"还剩下谁"
      }

      /* 【已移除 killOne】它原来只做「结束进程」，不复核、不重查占用，
       * 而解锁功能上线后所有按钮都走 unlockOne（结束 + 复核 + 重查）。
       * 留着它就是一条"看起来能用但少了复核"的旁路 ——
       * 谁把它接回按钮，界面就会在"进程杀了但文件还锁着"时说"已结束"。 */

      /* 【查询前先把「文件还是目录」确认掉，不靠 undefined 猜】
       * isDir 是 fileList 异步补上的：用户完全可能在 fs:stat-multi 返回之前
       * 就点了查询。早期代码拿 it.dir（一个根本不存在的字段）判断，
       * 恒为 undefined → 永远走单文件通道，目录分支是死代码，
       * 于是「删不掉整个目录」得到的是「没有检测到占用」这个错误结论。
       *
       * 这里用 fs:stat-multi 当场确认一次类型：
       *  - 查到 isDir=true → 走目录通道（扫目录内一层）
       *  - 查到 isDir=false → 走单文件通道
       *  - 查不到（null，路径不存在/无权限）→ 也走单文件通道，
       *    由 file:who-locks 的 missing 分支如实报「路径不存在」，
       *    这比静默当成文件查询更诚实。
       * 不做「先查文件再补查目录」：那会给出两份互相矛盾的结论。 */
      /* 【只在快照上补类型，绝不默认「按文件查」】
       * 早期这里对 state.items 里的对象原地赋值 isDir，而 onChange 会用
       * state.items = items.map(...) **整体换掉数组与对象** ——
       * 用户在 fs:stat-multi 返回前动一下选择，回来补的就补到了已经被丢弃的
       * 旧对象上，新一轮的条目 isDir 仍是 undefined。
       * 而 undefined 是假值，于是目录被送进 file:who-locks（单文件通道），
       * Restart Manager 注册目录会整批返回 ERR list 5，整个扫描作废。
       *
       * 现在：调用方传入要处理的**同批对象**，只改这一批；
       * 查不到类型的（stat 失败 / 路径已消失）保持 undefined，
       * 由 scanOnce 跳过并记一条 note —— 不猜「它是文件」。 */
      async function resolveTypes(batch) {
        const list = Array.isArray(batch) ? batch : [];
        const unknown = list.filter((it) => typeof it.isDir !== 'boolean');
        if (!unknown.length) return;
        let stats = null;
        try { stats = await invoke(Channels.CHANNELS.FS.STAT_MULTI, unknown.map((it) => it.path)); }
        catch (e) { stats = null; }
        unknown.forEach((it, k) => {
          const st = stats && stats[k];
          /* 查到就记下真实类型；查不到**保持 undefined**（见上面的注释） */
          if (st && typeof st.isDir === 'boolean') it.isDir = st.isDir;
        });
      }

      /* 【扫描的防重入收口】
       * 一次扫描要发 1 次 fs:stat-multi + N 次 file:who-locks(-dir)，
       * 用户双击「查出占用它的进程」就会并发两轮，两轮结果互相覆盖、
       * 界面闪烁且结论可能来自不同时刻。手写 running 标志在这里没有，
       * 一律走 ui.guard()：并发时第二次直接挡掉，任何 return/throw 都复位。
       * （scan 的调用点有两处：按钮，以及解锁成功后自动重查。） */
      async function scanOnce() {
        if (!state.items.length) return toast('请先选择文件或目录', 'warn');

        /* 【整轮扫描只认这一份快照】
         * resolveTypes 有 await，期间用户完全可能又改了选择（onChange 会整体
         * 替换 state.items 的数组与对象）。一旦「补类型的对象」和「发任务的
         * 对象」不是同一批，就会把目录当文件查（见 resolveTypes 的注释）。
         * 所以先切片，之后类型、任务、结果归并全部基于快照；和最新选择不一致
         * 时只说一句「选择已变，请重扫」，不去猜用户想查哪一批。 */
        const snapshot = state.items.slice();
        await resolveTypes(snapshot);

        const changed = state.items.length !== snapshot.length
          || state.items.some((it, i) => !snapshot[i] || it.path !== snapshot[i].path);
        if (changed) {
          resultBox.innerHTML = '';
          state.lockers = [];
          state.notes = ['选择在查询过程中发生了变化，请重新点「查出占用它的进程」。'];
          renderResult();
          return;
        }

        /* 清空放在 resolveTypes 之后：await 期间可能已经渲染过一次 */
        resultBox.innerHTML = '';

        const tasks = [];
        const taskItems = [];        // 与 tasks 一一对应（下面归并结果要用）
        const skipped = [];
        for (const it of snapshot) {
          if (typeof it.isDir !== 'boolean') {
            /* 类型查不出来的**不猜**。按文件查会让目录走错通道
             * （Restart Manager 注册目录会整批 ERR 5），按目录查则会把
             * 文件当成目录。宁可跳过并如实说明。 */
            skipped.push(it);
            continue;
          }
          /* 目录走专门通道（扫目录内一层文件）；文件走批量查询。
           * 目录那条更常用：删目录失败时，用户通常不知道是里面哪个文件被占。 */
          taskItems.push(it);
          tasks.push(it.isDir
            ? invoke(Channels.CHANNELS.ACL_LINKS.WHO_LOCKS_DIR, it.path)
            : invoke(Channels.CHANNELS.ACL_LINKS.WHO_LOCKS, [it.path]));
        }

        const notes = [];
        if (skipped.length) {
          notes.push('有 ' + skipped.length + ' 个条目查不出是文件还是目录（可能已被移走或没有访问权限），已跳过：'
            + skipped.slice(0, 5).map((it) => it.name || it.path).join('、')
            + (skipped.length > 5 ? ' 等' : ''));
        }
        if (!tasks.length) {
          state.lockers = [];
          state.notes = notes;
          renderResult();
          return;
        }

        /* 【逐条 settled：一个条目失败不许拖垮其余所有结论】
         * 早期是 Promise.all：20 个条目里只要有 1 个被别的程序删掉、
         * 或者没有列目录权限（这两个通道遇到那种情况会 reject），
         * 另外 19 个已经查到的结果全部丢掉，界面只剩一行「✗ 读取目录失败」。
         * 用户看到的是「功能坏了」，而不是「这 19 个没问题、那 1 个查不了」。 */
        const settled = await Promise.all(tasks.map((p) => p.then(
          (r) => ({ ok: true, r }),
          (e) => ({ ok: false, e })
        )));

        /* 同一个进程占用多个文件时按 pid 归并，展示更清爽 */
        const byPid = new Map();
        const failed = [];
        for (let i = 0; i < settled.length; i++) {
          const one = settled[i];
          const src = taskItems[i];
          if (!one.ok) {
            failed.push({ name: (src && (src.name || src.path)) || '（未知条目）', msg: one.e && one.e.message });
            continue;
          }
          const r = one.r || {};
          for (const l of (r.lockers || [])) {
            if (!byPid.has(l.pid)) {
              byPid.set(l.pid, Object.assign({}, l, { files: [] }));
            }
            byPid.get(l.pid).files.push(src ? src.path : '');
          }
          if (r.missing && r.missing.length) notes.push('路径不存在：' + r.missing.join('、'));
          if (r.scanned != null && r.total != null) notes.push('目录扫描 ' + r.scanned + '/' + r.total + ' 项');
          if (r.advice) notes.push(r.advice);
        }
        if (failed.length) {
          notes.push(failed.length + ' 个条目查询失败：'
            + failed.slice(0, 5).map((f) => f.name + (f.msg ? '（' + String(f.msg).slice(0, 60) + '）' : '')).join('；')
            + (failed.length > 5 ? ' 等' : '')
            + '。其余 ' + (settled.length - failed.length) + ' 个条目已查询，结果见上。');
        }

        state.lockers = [...byPid.values()];
        state.notes = notes;
        renderResult();
      }

      const scan = guard(scanOnce);
      const scanBtn = btn('查出占用它的进程', 'btn-primary', scan, 'search');
      const clearBtn = btn('清空', 'btn-sm btn-secondary', () => {
        state.items = [];
        state.lockers = [];
        state.notes = [];
        if (picker.clear) picker.clear();
        resultBox.innerHTML = '';
      });

      page.appendChild(div('card',
        div('card-title', '选择目标'),
        picker.el,
        div('form-row', scanBtn, ' ', clearBtn)));

      page.appendChild(resultBox);
    },
  });
})();
