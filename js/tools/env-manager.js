/* 模块：开发调试 —— 开发环境（便携运行时下载与管理）
 *
 * 产品约定（用户明确要求）：
 *   · 安装默认「加入当前用户环境」——新终端能直接用；可在下拉里改成「仅本工具箱」。
 *   · 安装前必须检测本机已有版本并警告「加入后新终端会优先用工具箱版本」。
 *   · 始终提供「官方安装器」入口：需要系统级安装 / 注册表登记时走厂商安装器。
 *   · 只改 HKCU（用户 PATH / JAVA_HOME），系统 PATH 永不碰；改前有备份，可一键撤销。
 */
(function () {
  const Channels = window.Channels;
  const { register } = window.Registry;
  const { div, btn, icon, toast, confirmBox } = window.ui;
  const { invoke } = window.api;
  const MOD = 'dev';

  register({
    id: 'env-manager',
    name: '开发环境',
    nameEn: 'Dev Environments',
    module: MOD,
    icon: 'box',
    desc: '一键下载便携版 Python / Java / Node / C++ 工具链，默认加入当前用户环境（可撤销）',
    descEn: 'Download portable Python / Java / Node / C++ toolchains; add them to your user environment by default',
    keywords: ['环境', 'runtime', 'python', 'java', 'jdk', 'node', 'c++', 'gcc', 'mingw', '下载', 'path'],
    render(page) {
      const progressLine = div('field-hint', '');
      const warnBox = div('');
      const listBox = div('');
      const detectBox = div('');
      let catalog = null;
      let detected = [];
      let lastJob = null;
      let busy = false;

      const modeSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'user' }, '安装后加入当前用户环境（推荐）'),
        h('option', { value: 'private' }, '仅本工具箱使用（不改环境变量）'));
      /* 下载动辄几十上百 MB，必须能停 */
      const cancelBtn = btn('停止下载', 'btn-sm btn-text', async () => {
        if (!lastJob) return toast('没有进行中的下载', 'warn');
        try { await invoke(Channels.CHANNELS.JOB.KILL, lastJob); toast('已请求停止', 'info'); }
        catch (e) { toast(e.message, 'error'); }
      }, 'stop');
      cancelBtn.disabled = true;

      /* 下载与解压阶段都会发 job:stream；前缀 env 已在 job-id 表登记 */
      const unsub = window.JobPrefix && window.JobPrefix.subscribe
        ? window.JobPrefix.subscribe('env', (d) => {
          try {
            const j = JSON.parse(d.data || '{}');
            if (d.id) lastJob = d.id;
            if (j.pct != null) progressLine.textContent = `下载中 ${(j.pct || 0).toFixed(0)}% · ${(j.mb || 0).toFixed(1)} MB`;
            else if (j.done) progressLine.textContent = '下载完成，校验与解压中…';
          } catch (e) { /* 进度是增强，解析失败不影响主流程 */ }
        })
        : null;
      if (unsub) window.App.onCleanup(() => { try { unsub(); } catch (e) {} });

      async function loadCatalog() {
        listBox.innerHTML = '';
        listBox.appendChild(window.ui.loadingBlock('读取环境清单…'));
        try {
          catalog = await invoke(Channels.CHANNELS.ENV.CATALOG);
        } catch (e) {
          listBox.innerHTML = '';
          listBox.appendChild(div('empty-tip', '读取失败：' + e.message));
          return;
        }
        draw();
        loadDetect();
      }

      async function loadDetect() {
        detectBox.innerHTML = '';
        detectBox.appendChild(window.ui.loadingBlock('检测本机已有环境…'));
        try {
          detected = (await invoke(Channels.CHANNELS.ENV.DETECT)).detected || [];
        } catch (e) { detected = []; }
        drawDetect();
        draw();  /* 重新绘制卡片里的「本机已装」提示 */
      }

      function findDetected(id) {
        return detected.find((d) => d.id === id) || null;
      }

      function drawDetect() {
        detectBox.innerHTML = '';
        const found = detected.filter((d) => d.found);
        const card = div('card', div('card-title', '本机已检测到的环境',
          h('span', { class: 'field-hint' }, found.length ? found.length + ' 项' : '无')));
        if (!found.length) {
          card.appendChild(div('empty-tip', '没有检测到已安装的 Python / Java / Node / GCC —— 直接往下安装即可'));
        }
        for (const d of found) {
          const rt = catalog && (catalog.runtimes || []).find((r) => r.id === d.id);
          card.appendChild(div('form-row',
            h('span', { style: { fontWeight: 500, width: '150px' } }, rt ? rt.name : d.id),
            h('span', { class: 'mono', style: { width: '140px', fontSize: '12px' } }, d.version || '版本未知'),
            h('span', { class: 'mono field-hint', style: { flex: '1', wordBreak: 'break-all', fontSize: '11.5px' } },
              d.path || (d.paths || []).join(' ; ')),
            rt && rt.installed ? h('span', { class: 'tag tag-green' }, '工具箱已装') : h('span', { class: 'tag tag-gray' }, '仅本机')));
        }
        card.appendChild(div('field-hint', '加入用户环境后，新开的终端会优先使用工具箱里的版本；系统原有版本不会被删除或修改。'));
        detectBox.appendChild(card);

        /* 冲突警告：有旧版本且与工具箱版本不同 —— 用户最需要知道的那件事 */
        const conflicts = found.filter((d) => {
          const rt = catalog && (catalog.runtimes || []).find((r) => r.id === d.id);
          return d.version && (!rt || (rt.version && d.version !== rt.version));
        });
        warnBox.innerHTML = '';
        if (conflicts.length) {
          const c = div('card');
          c.style.border = '1px solid var(--warning)';
          c.appendChild(div('card-title', icon('alert'), ' 检测到已有版本'));
          for (const d of conflicts) {
            c.appendChild(div('field-hint', '· ' + d.id + '：本机 ' + d.version + (d.path ? '（' + d.path + '）' : '')));
          }
          c.appendChild(div('field-hint', '加入用户环境后，新终端会优先使用工具箱版本（旧版本仍在，只是不在 PATH 最前面）。'
            + '不想改变现有行为就选「仅本工具箱使用」。'));
          warnBox.appendChild(c);
        }
      }

      function draw() {
        if (!catalog) return;
        listBox.innerHTML = '';
        const runtimes = catalog.runtimes || [];
        for (const r of runtimes) {
          const d = findDetected(r.id);
          const installed = r.installed;
          const applied = r.applied;
          const card = div('card');
          card.appendChild(div('card-title', icon('box'), ' ' + r.name,
            h('span', { class: 'tag tag-gray', style: { marginLeft: '8px' } }, 'v' + r.version),
            installed ? h('span', { class: 'tag tag-green', style: { marginLeft: '6px' } }, '已安装') : null,
            applied ? h('span', { class: 'tag tag-blue', style: { marginLeft: '6px' } }, '已加入用户环境') : null));
          card.appendChild(div('form-row',
            h('span', { class: 'field-hint', style: { flex: '1' } }, r.note || ''),
            installed ? btn('删除', 'btn-sm btn-danger-plain', () => removeEnv(r), 'trash') : null,
            !installed ? btn('下载安装', 'btn-sm btn-primary', () => installEnv(r), 'download') : null,
            installed && !applied ? btn('加入环境', 'btn-sm btn-secondary', () => applyOne(r), 'zap') : null,
            applied ? btn('从环境移除', 'btn-sm btn-text', () => unapplyOne(r), 'unlock') : null,
            btn('官方安装器', 'btn-sm btn-text', () => openOfficial(r), 'external')));
          if (installed) {
            card.appendChild(div('field-hint mono', { style: { fontSize: '11.5px', wordBreak: 'break-all' } }, installed.dir));
          }
          if (d && d.found) {
            card.appendChild(div('field-hint', '本机已装：' + (d.version || '版本未知') + (d.path ? '（' + d.path + '）' : '')));
          }
          listBox.appendChild(card);
        }
      }

      async function installEnv(r) {
        if (busy) return toast('已有安装进行中', 'warn');
        const mode = modeSel.value;
        const d = findDetected(r.id);
        const lines = [
          '将下载并安装 ' + r.name + ' ' + r.version + '（' + r.archive + '，来源已在清单里固定并校验 SHA-256）。',
          mode === 'user'
            ? '安装后会把它的 bin 目录加入「当前用户」的 PATH（Java 还会设 JAVA_HOME）——新开的终端会优先使用它。系统 PATH 不会被修改，随时可撤销。'
            : '不会修改任何环境变量；之后可以用「打开带环境的终端」使用它（或随时再点「加入环境」）。',
        ];
        if (d && d.found && mode === 'user') {
          lines.push('注意：本机已检测到 ' + r.id + ' ' + d.version + '，加入后新终端会优先使用工具箱版本。');
        }
        lines.push('', '确定继续？');
        if (!(await confirmBox({ title: '安装 ' + r.name, message: lines.join('\n'), okText: '开始下载' }))) return;
        busy = true;
        cancelBtn.disabled = false;
        progressLine.textContent = '准备下载…';
        try {
          const res = await invoke(Channels.CHANNELS.ENV.INSTALL, r.id, { applyPath: mode === 'user' });
          progressLine.textContent = '';
          toast((res.already ? '已安装，无需重复下载' : '已安装 ' + r.name + ' ' + res.version)
            + (res.applied ? '，并已加入用户环境' : ''), 'success', 5000);
          if (res.warnings && res.warnings.length) toast(res.warnings[0], 'warn', 7000);
          await loadCatalog();
        } catch (e) {
          progressLine.textContent = '';
          toast(e.message, 'error', 8000);
        } finally { busy = false; cancelBtn.disabled = true; lastJob = null; }
      }

      async function removeEnv(r) {
        if (!(await confirmBox({
          title: '删除 ' + r.name,
          message: '将删除工具箱里的 ' + r.name + ' ' + r.version + '（只删工具箱自己的目录）。\n'
            + '如果它已加入用户环境，会同时从 PATH 里移除。系统里另行安装的版本不受影响。',
          danger: true, okText: '删除',
        }))) return;
        try { await invoke(Channels.CHANNELS.ENV.REMOVE, r.id); toast('已删除', 'success'); await loadCatalog(); }
        catch (e) { toast(e.message, 'error'); }
      }

      async function applyOne(r) {
        if (!(await confirmBox({
          title: '加入用户环境',
          message: '将把 ' + r.name + ' 的 bin 目录前置到「当前用户」的 PATH'
            + (r.id === 'jdk' ? '，并设置 JAVA_HOME' : '') + '。\n\n新开的终端会优先使用它；系统 PATH 不会改动。',
          okText: '加入',
        }))) return;
        try {
          const res = await invoke(Channels.CHANNELS.ENV.APPLY, [r.id]);
          toast(res.appliedIds && res.appliedIds.length ? '已加入用户环境' : '没有可加入的环境', 'success');
          if (res.warnings && res.warnings.length) toast(res.warnings[0], 'warn', 7000);
          await loadCatalog();
        } catch (e) { toast(e.message, 'error'); }
      }

      async function unapplyOne(r) {
        if (!(await confirmBox({
          title: '从用户环境移除',
          message: '将把 ' + r.name + ' 的目录从当前用户 PATH 里移除（只删我们加的那几项）。\n'
            + (r.id === 'jdk' ? 'JAVA_HOME 如果仍是工具箱设置的值，会还原为之前的设置。\n' : '')
            + '已装的文件会保留。',
          okText: '移除',
        }))) return;
        try { await invoke(Channels.CHANNELS.ENV.UNAPPLY, [r.id]); toast('已从用户环境移除', 'success'); await loadCatalog(); }
        catch (e) { toast(e.message, 'error'); }
      }

      function openOfficial(r) {
        const url = (r.official && r.official.url) || r.homepage;
        if (!url) return toast('没有官方入口', 'warn');
        invoke(Channels.CHANNELS.SHELL.OPEN_URL, url).catch((e) => toast(e.message, 'error'));
      }

      const openTermBtn = btn('打开带环境的终端', 'btn-secondary', async () => {
        try { await invoke(Channels.CHANNELS.ENV.OPEN_TERMINAL); }
        catch (e) { toast(e.message, 'error'); }
      }, 'terminal');
      const unapplyAllBtn = btn('撤销全部环境修改', 'btn-sm btn-text', async () => {
        if (!(await confirmBox({
          title: '撤销全部环境修改',
          message: '将把工具箱加进用户 PATH 的所有目录移除，并还原 JAVA_HOME（如果仍是工具箱设置的）。\n\n已安装的文件会保留。',
          okText: '撤销',
        }))) return;
        try { await invoke(Channels.CHANNELS.ENV.UNAPPLY); toast('已撤销', 'success'); await loadCatalog(); }
        catch (e) { toast(e.message, 'error'); }
      }, 'refresh');

      page.appendChild(div('card', div('card-title', icon('box'), ' 开发环境', btn('刷新', 'btn-sm btn-secondary', loadCatalog, 'refresh')),
        div('form-row', h('span', { class: 'form-label' }, '安装方式'), modeSel, openTermBtn, unapplyAllBtn),
        div('form-row', progressLine, cancelBtn),
        div('field-hint', '只下载官方便携构建（版本与 SHA-256 固定）。默认加入当前用户环境；系统 PATH 不会被修改。'
          + '需要「所有软件/安装器都能识别」的环境时，点「官方安装器」走厂商安装程序。')));
      page.appendChild(warnBox);
      page.appendChild(detectBox);
      page.appendChild(listBox);
      loadCatalog();
    },
  });
})();