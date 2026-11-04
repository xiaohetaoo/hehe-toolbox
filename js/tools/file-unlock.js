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
    desc: '删不掉、提示被占用时，查出是哪个进程占着它（Windows Restart Manager）', descEn: 'Find which process is locking a file and release it',
    keywords: ['占用', '解锁', '删不掉', '被占用', 'lock', 'unlock', 'handle', '正在使用'],
    render(page) {
      const state = { items: [], lockers: [], notes: [] };

      /* 顶部说明：讲清「能做什么、不能做什么」。
       * 同类工具常号称「强制解锁」，实际是杀进程或强删句柄，
       * 两者都可能让占用方丢数据。这里明确只做诊断 + 可选结束进程。 */
      page.appendChild(div('card',
        div('card-title', '为什么删不掉？'),
        div('field-hint',
          'Windows 上文件被程序打开时无法删除或改名，系统只会提示「文件正在使用」。' +
          '本工具用 Windows 自带的 Restart Manager 查出具体是哪个进程占着它，' +
          '你可以据此关闭那个程序。'),
        div('field-hint', { style: { marginTop: '6px' } },
          '只做查询与诊断。强制结束进程可能让占用方丢失未保存的数据 ——' +
          '请先确认那确实是你在用的程序，系统服务尤其不要乱结束。')));

      const picker = filePicker({
        text: '选择或拖入被占用的文件 / 目录',
        multiple: true,
        directory: true,
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
          const label = '结束「' + (row.name || row.procName || ('PID ' + row.pid)) + '」';
          ops.appendChild(btn(label, 'btn-sm btn-danger-plain', () => killOne(row)));
        }
        card.appendChild(ops);
        resultBox.appendChild(card);

        for (const n of state.notes) {
          resultBox.appendChild(div('field-hint', { style: { padding: '4px 6px' } }, n));
        }
        resultBox.appendChild(div('field-hint', { style: { padding: '8px 6px' } },
          '建议：先回到占用它的那个程序里保存并关闭，再重新删除。' +
          '只有确认那是你自己的程序、且没有未保存内容时，才用上面的「结束」。'));
      }

      async function killOne(row) {
        if (row.type === 'service') {
          return toast('这是系统服务，请到「服务管理」里处理，不要直接结束', 'warn');
        }
        const nm = row.name || row.procName || ('PID ' + row.pid);
        const ok = await confirmBox({
          title: '结束进程',
          message: '确定结束「' + nm + '」（PID ' + row.pid + '）？\n\n' +
            '如果它正在处理你的文件，未保存的数据会丢失。\n' +
            '系统关键进程会被拒绝结束。',
          danger: true, okText: '结束它',
        });
        if (!ok) return;
        try {
          await invoke(Channels.CHANNELS.PROC.KILL, row.pid);
          toast('已结束「' + nm + '」', 'success');
          scan();   // 自动重查，确认是否真的解锁了
        } catch (e) {
          toast(e.message, 'error');
        }
      }

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
