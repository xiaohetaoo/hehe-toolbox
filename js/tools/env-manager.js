/* 模块：开发调试 —— 开发环境（便携运行时下载与管理）
 *
 * 产品约定（用户明确要求）：
 *   · 安装默认「加入当前用户环境」——新终端能直接用；可在下拉里改成「仅本工具箱」。
 *   · 安装前必须检测本机已有版本并警告「加入后新终端会优先用工具箱版本」。
 *   · 始终提供「官方安装器」入口：需要系统级安装 / 注册表登记时走厂商安装器。
 *   · 只改 HKCU（用户 PATH / JAVA_HOME），系统 PATH 永不碰；改前有备份，可一键撤销。
 *
 * 文案已迁到双语（v0.8.9 修补）：用户可见文字走 T('中文原文')，
 * 英文表在 js/tools/i18n.js 的 env 域；中文模式直接返回字面量、不查表。
 */
(function () {
  const Channels = window.Channels;
  const { register } = window.Registry;
  const { div, btn, icon, toast, confirmBox, fmtBytes } = window.ui;
  const { invoke } = window.api;
  const T = (zh, vars) => TT('env', zh, vars);
  const MOD = 'dev';

  register({
    id: 'env-manager',
    name: '开发环境',
    nameEn: 'Dev Environments',
    module: MOD,
    icon: 'box',
    i18n: true,
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
      /* 安装/下载的 per-run 序号（见 cancelBtn 的说明） */
      let installRunSeq = 0;
      let busy = false;

      const modeSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'user' }, T('安装后加入当前用户环境（推荐）')),
        h('option', { value: 'private' }, T('仅本工具箱使用（不改环境变量）')));
      /* 下载动辄几十上百 MB，必须能停。
       * 【取消必须立刻生效】ENV.INSTALL 是阻塞式 handler（装完才返回），
       * lastJob 要等首条 job:stream 才被认领 —— 在那之前的取消窗口里
       * `if (!lastJob) return` 什么都不做，而 installEnv 恢复后任务照旧在跑。
       * 现在：取消先递增 installRunSeq（让 installEnv 的收尾判定过期），
       * 有 lastJob 就 kill，并立刻恢复界面可用状态。 */
      /* 样式与其它页面的「停止/取消」一致：btn-danger-plain（原来是 btn-text，
       * 看起来像一个普通链接，不像一个会中止任务的操作）。 */
      const cancelBtn = btn(T('停止下载'), 'btn-sm btn-danger-plain', async () => {
        installRunSeq++;
        const job = lastJob;
        lastJob = null;
        if (job) {
          try {
            await invoke(Channels.CHANNELS.JOB.KILL, job);
            toast(T('已请求停止'), 'info');
          } catch (e) { toast(e.message, 'error'); }
        } else {
          /* 还没有 job id：说明主进程还没开始下载。取消语义仍然成立 ——
           * installEnv 的收尾会因为序号变化而丢弃本次结果。 */
          toast(T('已取消本次安装'), 'info');
        }
        /* 界面立刻回到可用：不等 installEnv 的 await 返回 */
        try {
          progressLine.textContent = '';
          cancelBtn.disabled = true;
          setBusy(false);
        } catch (e) {}
      }, 'stop');
      cancelBtn.disabled = true;

      /* 下载/解压阶段都会发 job:stream；前缀 env 已在 job-id 表登记。
       * 【订阅必须可重入】cleanup 会退订，而保活复用时页面不重新 render ——
       * 不退订会泄漏，退订后不重绑则返回后进度永久冻结（安装其实还在跑，
       * 用户却看不到任何变化，以为卡死）。抽成 bindEnvProgress()。 */
      let unsubEnv = null;
      function bindEnvProgress() {
        if (unsubEnv) { try { unsubEnv(); } catch (e) {} unsubEnv = null; }
        if (!(window.JobPrefix && window.JobPrefix.subscribe)) return;
        unsubEnv = window.JobPrefix.subscribe('env', (d) => {
          try {
            const j = JSON.parse(d.data || '{}');
            if (d.id) lastJob = d.id;
            if (j.pct != null) progressLine.textContent = T('下载中 {pct}% · {mb} MB', { pct: (j.pct || 0).toFixed(0), mb: (j.mb || 0).toFixed(1) });
            else if (j.done) progressLine.textContent = T('下载完成，校验与解压中…');
          } catch (e) { /* 进度是增强，解析失败不影响主流程 */ }
        });
      }
      bindEnvProgress();
      if (unsubEnv) window.App.onCleanup(() => { if (unsubEnv) { try { unsubEnv(); } catch (e) {} unsubEnv = null; } });
      /* 【复用回来：重绑进度订阅，并把清单/安装状态重新拉一遍】
       * 离开期间安装可能已经完成或失败，不重拉就一直是旧状态。 */
      if (window.App.onEnter) {
        window.App.onEnter(() => {
          bindEnvProgress();
          /* 【loadCatalog 完成后必须重刷 busy】loadCatalog 会
           * `listBox.innerHTML = ''` 再 append 全新按钮 —— 新按钮默认是
           * **启用**态，而 busy 仍然是 true（安装还在跑）。
           * 结果：安装进行中返回页面，按钮看起来全部可点，用户一点就
           * "已有操作进行中"（或更糟：连点触发重复安装）。
           * 必须在重建之后再 setBusy(busy) 一次，让视觉与真实状态一致。 */
          Promise.resolve()
            .then(() => loadCatalog(false))
            .catch(() => {})
            .then(() => { try { if (busy) setBusy(true); } catch (e) {} });
        });
      }

      /* 串行：环境操作在 IPC 侧也排队，但界面同时禁用按钮，避免用户连点 */
      function setBusy(v) {
        busy = v;
        modeSel.disabled = v;
        for (const b of listBox.querySelectorAll('button')) b.disabled = v;
        openTermBtn.disabled = v;
        unapplyAllBtn.disabled = v;
        cleanBtn.disabled = v;
      }

      async function loadCatalog(force) {
        listBox.innerHTML = '';
        listBox.appendChild(window.ui.loadingBlock(T('读取环境清单…')));
        try {
          catalog = await invoke(Channels.CHANNELS.ENV.CATALOG);
        } catch (e) {
          listBox.innerHTML = '';
          listBox.appendChild(div('empty-tip', T('读取失败：') + e.message));
          return;
        }
        draw();
        loadDetect(force);
      }

      async function loadDetect(force) {
        detectBox.innerHTML = '';
        detectBox.appendChild(window.ui.loadingBlock(T('检测本机已有环境…')));
        try {
          detected = (await invoke(Channels.CHANNELS.ENV.DETECT, !!force)).detected || [];
        } catch (e) {
          detected = [];
          /* 【与 R11-2 同类】空 catch 会把「检测失败」伪装成「没有已装环境」：
           * 用户看到「没有检测到…」就可能直接去装，而实际只是检测命令被策略挡了。
           * 如实写出原因；旧冲突警告一并清掉（检测失败时它已不可信）。 */
          detectBox.innerHTML = '';
          detectBox.appendChild(div('field-err', '✗ ' + T('检测本机环境失败：') + ((e && e.message) || String(e))));
          warnBox.innerHTML = '';
          draw();
          return;
        }
        drawDetect();
        draw();  /* 重新绘制卡片里的「本机已装」提示 */
      }

      function findDetected(id) {
        return detected.find((d) => d.id === id) || null;
      }

      function drawDetect() {
        detectBox.innerHTML = '';
        const found = detected.filter((d) => d.found);
        const card = div('card', div('card-title', T('本机已检测到的环境'),
          h('span', { class: 'field-hint' }, found.length ? T('{n} 项', { n: found.length }) : T('无'))));
        if (!found.length) {
          card.appendChild(div('empty-tip', T('没有检测到已安装的 Python / Java / Node / GCC —— 直接往下安装即可')));
        }
        for (const d of found) {
          const rt = catalog && (catalog.runtimes || []).find((r) => r.id === d.id);
          card.appendChild(div('form-row',
            h('span', { style: { fontWeight: 500, width: '150px' } }, rt ? rt.name : d.id),
            h('span', { class: 'mono', style: { width: '160px', fontSize: '12px' } }, d.version || T('版本未知')),
            h('span', { class: 'mono field-hint', style: { flex: '1', wordBreak: 'break-all', fontSize: '11.5px' } },
              d.path || (d.paths || []).join(' ; ')),
            rt && rt.installed ? h('span', { class: 'tag tag-green' }, T('工具箱已装')) : h('span', { class: 'tag tag-gray' }, T('仅本机'))));
        }
        card.appendChild(div('field-hint', T('加入用户环境后，新开的终端会优先使用工具箱里的版本；系统原有版本不会被删除或修改。')));
        detectBox.appendChild(card);

        /* 冲突警告：有旧版本且与工具箱版本不同。
         * 版本比较对 Python 只比 major.minor（`py -0p` 只给 3.12），否则永远误报。 */
        const conflicts = found.filter((d) => {
          const rt = catalog && (catalog.runtimes || []).find((r) => r.id === d.id);
          if (!d.version) return false;
          if (!rt || !rt.version) return true;
          if (d.id === 'python') return d.version.replace(/^Python\s*/i, '').slice(0, 4) !== rt.version.slice(0, 4);
          return d.version !== rt.version;
        });
        warnBox.innerHTML = '';
        if (conflicts.length) {
          const c = div('card');
          c.style.border = '1px solid var(--warning)';
          c.appendChild(div('card-title', icon('alert'), ' ' + T('检测到已有版本')));
          for (const d of conflicts) {
            const rt = catalog && (catalog.runtimes || []).find((r) => r.id === d.id);
            c.appendChild(div('field-hint', T('· {name}：本机 {ver}（{path}）', {
              name: rt ? rt.name : d.id, ver: d.version, path: d.path || (d.paths || []).join(' ; '),
            })));
          }
          c.appendChild(div('field-hint', T('加入用户环境后，新终端会优先使用工具箱版本（旧版本仍在，只是不在 PATH 最前面）。不想改变现有行为就选「仅本工具箱使用」。')));
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
            installed ? h('span', { class: 'tag tag-green', style: { marginLeft: '6px' } }, T('已安装')) : null,
            applied ? h('span', { class: 'tag tag-blue', style: { marginLeft: '6px' } }, T('已加入用户环境')) : null));
          card.appendChild(div('form-row',
            h('span', { class: 'field-hint', style: { flex: '1' } }, r.note || ''),
            installed ? btn(T('删除'), 'btn-sm btn-danger-plain', () => removeEnv(r), 'trash') : null,
            !installed ? btn(T('下载安装'), 'btn-sm btn-primary', () => installEnv(r), 'download') : null,
            installed && !applied ? btn(T('加入环境'), 'btn-sm btn-secondary', () => applyOne(r), 'zap') : null,
            applied ? btn(T('从环境移除'), 'btn-sm btn-text', () => unapplyOne(r), 'unlock') : null,
            btn(T('官方安装器'), 'btn-sm btn-text', () => openOfficial(r), 'external')));
          if (installed) {
            card.appendChild(div('field-hint mono', { style: { fontSize: '11.5px', wordBreak: 'break-all' } }, installed.dir));
          }
          if (d && d.found) {
            card.appendChild(div('field-hint', T('本机已装：{ver}（{path}）', {
              ver: d.version || T('版本未知'), path: d.path || (d.paths || []).join(' ; '),
            })));
          }
          listBox.appendChild(card);
        }
      }

      async function installEnv(r) {
        if (busy) return toast(T('已有操作进行中'), 'warn');
        const mode = modeSel.value;
        const d = findDetected(r.id);
        const lines = [
          T('将下载并安装 {name} {ver}（{fmt}，来源已在清单里固定并校验 SHA-256）。', {
            name: r.name, ver: r.version, fmt: r.archive,
          }),
          mode === 'user'
            ? T('安装后会把它的 bin 目录加入「当前用户」的 PATH（Java 还会设 JAVA_HOME）——新开的终端会优先使用它。系统 PATH 不会被修改，随时可撤销。')
            : T('不会修改任何环境变量；之后可以用「打开带环境的终端」使用它（或随时再点「加入环境」）。'),
        ];
        if (d && d.found && mode === 'user') {
          lines.push(T('注意：本机已检测到 {name} {ver}，加入后新终端会优先使用工具箱版本。', {
            name: r.name, ver: d.version,
          }));
        }
        lines.push('', T('确定继续？'));
        if (!(await confirmBox({ title: T('安装 {name}', { name: r.name }), message: lines.join('\n'), okText: T('开始下载') }))) return;
        progressLine.textContent = T('准备下载…');
        const runToken = ++installRunSeq;
        setBusy(true);
        cancelBtn.disabled = false;
        try {
          const res = await invoke(Channels.CHANNELS.ENV.INSTALL, r.id, { applyPath: mode === 'user' });
          /* 【过期就别改界面】用户已点了停止（或离开页面）——这次的安装结果
           * 不属于当前界面。但仍要刷新清单：主进程那边可能真的装完了。 */
          if (runToken !== installRunSeq) {
            progressLine.textContent = '';
            try { await loadCatalog(true); } catch (e) {}
            return;
          }
          progressLine.textContent = '';
          toast((res.already ? T('已安装，无需重复下载') : T('已安装 {name} {ver}', { name: r.name, ver: res.version }))
            + (res.applied ? T('，并已加入用户环境') : ''), 'success', 5000);
          if (res.warnings && res.warnings.length) toast(res.warnings[0], 'warn', 7000);
          await loadCatalog(true);
        } catch (e) {
          /* 过期的失败不弹错（用户已经取消/离开了） */
          if (runToken !== installRunSeq) { progressLine.textContent = ''; return; }
          progressLine.textContent = '';
          toast(e.message, 'error', 8000);
        } finally {
          if (runToken === installRunSeq) {
            cancelBtn.disabled = true;
            lastJob = null;
            setBusy(false);
          }
        }
      }

      async function removeEnv(r) {
        if (busy) return toast(T('已有操作进行中'), 'warn');
        if (!(await confirmBox({
          title: T('删除 {name}', { name: r.name }),
          message: T('将删除工具箱里的 {name} {ver}（只删工具箱自己的目录）。\n如果它已加入用户环境，会同时从 PATH 里移除。系统里另行安装的版本不受影响。', {
            name: r.name, ver: r.version,
          }),
          danger: true, okText: T('删除'),
        }))) return;
        setBusy(true);
        try {
          await invoke(Channels.CHANNELS.ENV.REMOVE, r.id);
          toast(T('已删除'), 'success');
          await loadCatalog(true);
        } catch (e) { toast(e.message, 'error'); }
        finally { setBusy(false); }
      }

      async function applyOne(r) {
        if (busy) return toast(T('已有操作进行中'), 'warn');
        if (!(await confirmBox({
          title: T('加入用户环境'),
          message: T('将把 {name} 的 bin 目录前置到「当前用户」的 PATH', { name: r.name })
            + (r.id === 'jdk' ? T('，并设置 JAVA_HOME') : '') + T('。\n\n新开的终端会优先使用它；系统 PATH 不会改动。'),
          okText: T('加入环境'),
        }))) return;
        setBusy(true);
        try {
          const res = await invoke(Channels.CHANNELS.ENV.APPLY, [r.id]);
          toast(res.appliedIds && res.appliedIds.length ? T('已加入用户环境') : T('没有可加入的环境'), 'success');
          if (res.warnings && res.warnings.length) toast(res.warnings[0], 'warn', 7000);
          await loadCatalog(true);
        } catch (e) { toast(e.message, 'error'); }
        finally { setBusy(false); }
      }

      async function unapplyOne(r) {
        if (busy) return toast(T('已有操作进行中'), 'warn');
        if (!(await confirmBox({
          title: T('从用户环境移除'),
          message: T('将把 {name} 的目录从当前用户 PATH 里移除（只删我们加的那几项）。', { name: r.name }) + '\n'
            + (r.id === 'jdk' ? T('JAVA_HOME 如果仍是工具箱设置的值，会还原为之前的设置。\n') : '')
            + T('已装的文件会保留。'),
          okText: T('从环境移除'),
        }))) return;
        setBusy(true);
        try {
          await invoke(Channels.CHANNELS.ENV.UNAPPLY, [r.id]);
          toast(T('已从用户环境移除'), 'success');
          await loadCatalog(true);
        } catch (e) { toast(e.message, 'error'); }
        finally { setBusy(false); }
      }

      function openOfficial(r) {
        const url = (r.official && r.official.url) || r.homepage;
        if (!url) return toast(T('没有官方入口'), 'warn');
        invoke(Channels.CHANNELS.SHELL.OPEN_URL, url).catch((e) => toast(e.message, 'error'));
      }

      const openTermBtn = btn(T('打开带环境的终端'), 'btn-secondary', async () => {
        if (busy) return toast(T('已有操作进行中'), 'warn');
        try { await invoke(Channels.CHANNELS.ENV.OPEN_TERMINAL); }
        catch (e) { toast(e.message, 'error'); }
      }, 'terminal');
      const unapplyAllBtn = btn(T('撤销全部环境修改'), 'btn-sm btn-text', async () => {
        if (busy) return toast(T('已有操作进行中'), 'warn');
        if (!(await confirmBox({
          title: T('撤销全部环境修改'),
          message: T('将把工具箱加进用户 PATH 的所有目录移除，并还原 JAVA_HOME（如果仍是工具箱设置的）。\n\n已安装的文件会保留。'),
          okText: T('撤销'),
        }))) return;
        setBusy(true);
        try { await invoke(Channels.CHANNELS.ENV.UNAPPLY); toast(T('已撤销'), 'success'); await loadCatalog(true); }
        catch (e) { toast(e.message, 'error'); }
        finally { setBusy(false); }
      }, 'refresh');
      const cleanBtn = btn(T('清理安装包'), 'btn-sm btn-text', async () => {
        if (busy) return toast(T('已有操作进行中'), 'warn');
        if (!(await confirmBox({
          title: T('清理安装包'),
          message: T('将删除已下载的安装包缓存（不影响已安装的环境；下次安装会重新下载）。'),
          okText: T('清理'),
        }))) return;
        setBusy(true);
        try {
          const r = await invoke(Channels.CHANNELS.ENV.CLEAN);
          /* 【必须读 r.errors】
           * 后端现在把「删除失败的项」放进 errors（原来 fsp.rm 的失败被
           * catch 吞掉后仍 removed++，界面照样报「已清理 N 个」绿色成功）。
           * 三种情况要说清：
           *   · 全部失败 → 红色错误，不能报「没有可清理」也不能报成功
           *     （「没有可清理」会让用户以为文件本来就不存在）；
           *   · 部分失败 → 黄色警告 + 具体条数与首个原因；
           *   · 全部成功且删了东西 → 绿色成功；
           *   · 没有文件可清理 → 普通提示（不是成功，也不是失败）。 */
          const errs = Array.isArray(r.errors) ? r.errors : [];
          const removed = Number(r.removed) || 0;
          if (errs.length && removed === 0) {
            /* 全部失败：明确是错误，并给出第一条原因 */
            toast(T('清理失败：{n} 个文件无法删除（{reason}）', { n: errs.length, reason: errs[0] }), 'error', 8000);
          } else if (errs.length) {
            /* 部分失败：说清成功几条、失败几条 */
            toast(T('已清理 {n} 个、失败 {m} 个（{reason}）', { n: removed, m: errs.length, reason: errs[0] }), 'warn', 8000);
          } else if (removed > 0) {
            toast(T('已清理 {n} 个安装包，释放 {size}', { n: removed, size: fmtBytes(r.freed) }), 'success');
          } else {
            /* 真的没有文件：既不是成功也不是失败，用 info 不用 success 绿 */
            toast(T('没有可清理的安装包'), 'info');
          }
        } catch (e) { toast(e.message, 'error'); }
        finally { setBusy(false); }
      }, 'trash');

      page.appendChild(div('card', div('card-title', icon('box'), ' ' + T('开发环境'), btn(T('刷新'), 'btn-sm btn-secondary', () => loadCatalog(true), 'refresh')),
        div('form-row', h('span', { class: 'form-label' }, T('安装方式')), modeSel, openTermBtn, unapplyAllBtn, cleanBtn),
        div('form-row', progressLine, cancelBtn),
        div('field-hint', T('只下载官方便携构建（版本与 SHA-256 固定）。默认加入当前用户环境；系统 PATH 不会被修改。需要「所有软件/安装器都能识别」的环境时，点「官方安装器」走厂商安装程序。'))));
      page.appendChild(warnBox);
      page.appendChild(detectBox);
      page.appendChild(listBox);
      loadCatalog(false);
    },
  });
})();