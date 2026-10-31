/* 模块：文件处理 —— 文件占用解锁（查谁占着文件） */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, confirmBox, filePicker, renderTable } = window.ui;
  const { invoke } = window.api;
  const MOD = 'file';

  register({
    id: 'file-unlock',
    name: '文件占用解锁',
    module: MOD,
    icon: 'lock',
    desc: '删不掉、提示被占用时，查出是哪个进程占着它（Windows Restart Manager）',
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
          await invoke('proc:kill', row.pid);
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
      async function resolveTypes() {
        const unknown = state.items.filter((it) => typeof it.isDir !== 'boolean');
        if (!unknown.length) return;
        let stats = null;
        try { stats = await invoke('fs:stat-multi', unknown.map((it) => it.path)); }
        catch (e) { stats = null; }
        unknown.forEach((it, k) => {
          const st = stats && stats[k];
          /* 查不到就定成 false（按文件查），不是因为「相信它是文件」，
           * 而是让上面的 missing 分支把「路径不存在」如实报出来 */
          it.isDir = !!(st && st.isDir);
        });
      }

      async function scan() {
        if (!state.items.length) return toast('请先选择文件或目录', 'warn');
        await resolveTypes();
        /* 清空放在 resolveTypes 之后：await 期间用户可能又改了选择，
         * 那句 onChange 会先渲染一次，这里再清一次保证从空白开始 */
        resultBox.innerHTML = '';
        const tasks = [];
        for (const it of state.items) {
          /* 目录走专门通道（扫目录内一层文件）；文件走批量查询。
           * 目录那条更常用：删目录失败时，用户通常不知道是里面哪个文件被占。 */
          tasks.push(it.isDir
            ? invoke('file:who-locks-dir', it.path)
            : invoke('file:who-locks', [it.path]));
        }

        try {
          const results = await Promise.all(tasks);

          /* 同一个进程占用多个文件时按 pid 归并，展示更清爽 */
          const byPid = new Map();
          const notes = [];
          for (let i = 0; i < results.length; i++) {
            const r = results[i] || {};
            const src = state.items[i];
            for (const l of (r.lockers || [])) {
              if (!byPid.has(l.pid)) {
                byPid.set(l.pid, Object.assign({}, l, { files: [] }));
              }
              byPid.get(l.pid).files.push(src.path);
            }
            if (r.missing && r.missing.length) notes.push('路径不存在：' + r.missing.join('、'));
            if (r.scanned != null && r.total != null) notes.push('目录扫描 ' + r.scanned + '/' + r.total + ' 项');
            if (r.advice) notes.push(r.advice);
          }

          state.lockers = [...byPid.values()];
          state.notes = notes;
          renderResult();
        } catch (e) {
          state.lockers = [];
          state.notes = ['✗ ' + e.message];
          renderResult();
          toast(e.message, 'error');
        }
      }

      const scanBtn = btn('🔍 查出占用它的进程', 'btn-primary', scan);
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
