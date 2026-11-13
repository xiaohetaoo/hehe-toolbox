/* 工具链：把多个文件操作串成一条流水线，一键跑完。
 *
 * ============ 为什么是「操作」而不是「工具」 ============
 * 工具箱里的 106 个工具绝大多数是**带 UI 的页面**：它们要用户选文件、
 * 填参数、点按钮，然后自己 toast。把它们串起来在技术上能做（调用 render
 * 再模拟点击），但那等于把界面当 API 用 —— 界面上任何一次改版都会
 * 悄悄打断所有工具链，而且中间态（进度、弹窗）根本没法统一处理。
 *
 * 所以工具链的原子单位是**可无头执行的操作**：每个操作接收「一批文件路径
 * + 参数」，返回「新的一批路径」。压缩/解压/转码/转换/哈希/重命名都符合
 * 这个模型；"给图片加水印"这种依赖复杂交互的先不进来（见 OPERATIONS 里
 * 每条的说明）。这样：
 *   · 链条是纯数据驱动，能保存、能序列化、能重放；
 *   · 中间产物路径可追踪，失败时能准确报出「第几步、哪个文件」。
 *
 * ============ 失败策略 ============
 * 单步失败**不中断整链**，而是把该文件标记为失败并跳过后续步骤。
 * 理由：用户可能一次拖入 50 张图，第 3 张坏了就丢掉整批 47 张好的，
 * 这不合理。最终报告里按文件列出「在哪一步失败、原因是什么」。
 * 但若**某一步对全部文件都失败**（通常是参数错或环境缺失），
 * 立刻中止并报该步错误 —— 继续跑下去只会产生 50 条同样的错误。
 */
(function () {
  const Channels = window.Channels;
  const { div, h, btn, toast } = window.ui;
  const { invoke } = window.api;
  const { register } = window.Registry;

  /* ============ 操作定义 ============
   * run(ctx) 的 ctx = { files: [路径], params: {…}, onProgress(done, total, label) }
   * 返回 { files: [新路径], note?: '给用户看的一句话' }
   * 抛错 = 这一步失败（由调用方决定是跳过还是中止）。
   */
  const OPERATIONS = [
    {
      id: 'compress-image',
      name: '图片压缩',
      desc: '按质量重新编码（JPG/PNG/WebP），输出到同目录',
      params: [{ key: 'quality', label: '质量 1-100', type: 'number', value: 80, min: 10, max: 100 }],
      accepts: /\.(jpe?g|png|webp|bmp)$/i,
      async run(ctx) {
        const q = Math.max(10, Math.min(100, Number(ctx.params.quality) || 80)) / 100;
        const out = [];
        for (let i = 0; i < ctx.files.length; i++) {
          const p = ctx.files[i];
          ctx.onProgress(i, ctx.files.length, '压缩 ' + baseName(p));
          /* 【图片压缩必须在渲染层做，没有 IPC 通道】
           * 全项目只有 ffmpeg:convert，而它是音视频专用（extMap 里全是
           * mp4/webm/mp3…，opts 里没有 image 概念）。img-compress 工具
           * 自己也是用 canvas.toDataURL(mime, q) 再 fs:write-file-b64 写盘 ——
           * 所以这里照同一条路走，不另造编码逻辑。
           *
           * 格式保持原样（PNG 仍出 PNG、JPG 仍出 JPG）：用户没要求转换格式，
           * 悄悄改格式会让人以为文件被"处理坏了"。 */
          const r = await invoke(Channels.CHANNELS.FS.READ_FILE_B64, p);
          const buf = 'data:image/' + guessMime(p) + ';base64,' + r.b64;
          const img = await loadImg(buf);
          const ext = (p.match(/\.([^.\\/]+)$/) || [])[1] || 'png';
          const mime = /^jpe?g$/i.test(ext) ? 'image/jpeg' : /^webp$/i.test(ext) ? 'image/webp' : 'image/png';
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, img.naturalWidth);
          canvas.height = Math.max(1, img.naturalHeight);
          const c2d = canvas.getContext('2d');
          /* JPEG 无 alpha：不铺白底的话透明区会变黑 */
          if (mime === 'image/jpeg') { c2d.fillStyle = '#fff'; c2d.fillRect(0, 0, canvas.width, canvas.height); }
          c2d.drawImage(img, 0, 0);
          const du = canvas.toDataURL(mime, q);
          const outPath = await invoke(Channels.CHANNELS.FS.UNIQUE_PATH, p.replace(/(\.[^.\\/]+)$/, '-min$1'));
          await invoke(Channels.CHANNELS.FS.WRITE_FILE_B64, outPath, du.split(',')[1]);
          out.push(outPath);
        }
        ctx.onProgress(ctx.files.length, ctx.files.length, '完成');
        return { files: out, note: out.length + ' 个图片已压缩（质量 ' + Math.round(q * 100) + '）' };
      },
    },
    {
      id: 'zip',
      name: '打包 ZIP',
      desc: '把这一批文件打成一个 ZIP',
      params: [{ key: 'name', label: '包名（留空自动）', type: 'text', value: '' }],
      async run(ctx) {
        const first = ctx.files[0];
        const dir = first ? first.replace(/[\\/][^\\/]+$/, '') : '';
        const name = String(ctx.params.name || '').trim() || 'bundle';
        /* 【签名是位置参数，不是对象】zip:compress(paths, outZip)。
         * 传对象会静默拼出错误的归档内容（参数错位），所以这里逐个对齐。 */
        const outZip = await invoke(Channels.CHANNELS.FS.UNIQUE_PATH, dir + '/' + name + '.zip');
        await invoke(Channels.CHANNELS.ZIP.COMPRESS, ctx.files, outZip);
        return { files: [outZip], note: ctx.files.length + ' 个文件已打包' };
      },
    },
    {
      id: 'unzip',
      name: '解压',
      desc: '把这一批压缩包解到同目录',
      async run(ctx) {
        const out = [];
        for (let i = 0; i < ctx.files.length; i++) {
          const p = ctx.files[i];
          ctx.onProgress(i, ctx.files.length, '解压 ' + baseName(p));
          /* 签名 zip:extract(zipPath, outDir) —— 同样两个位置参数 */
          const outDir = await invoke(Channels.CHANNELS.FS.UNIQUE_PATH, p.replace(/\.[^.\\/]+$/, ''));
          await invoke(Channels.CHANNELS.ZIP.EXTRACT, p, outDir);
          out.push(outDir);
        }
        return { files: out, note: out.length + ' 个包已解压' };
      },
    },
    {
      id: 'hash',
      name: '计算哈希',
      desc: '对每个文件算 SHA-256（结果写进报告）',
      async run(ctx) {
        /* 签名 fs:hash-file-multi(path, algos) 是**单文件**版，
         * 不是一批。所以逐个调（哈希本身很快，串行足够）。 */
        const lines = [];
        for (const p of ctx.files) {
          try {
            const r = await invoke(Channels.CHANNELS.FS.HASH_FILE_MULTI, p, ['sha256']);
            const hex = (r && (r.sha256 || (r[0] && r[0].sha256))) || '';
            if (hex) lines.push(baseName(p) + '  ' + hex);
          } catch (e) { /* 单个文件读不了不影响整批 */ }
        }
        return { files: ctx.files.slice(), note: lines.length ? '已算 ' + lines.length + ' 个 SHA-256' : '哈希完成' };
      },
    },
    {
      id: 'rename-seq',
      name: '批量重命名',
      desc: '按 前缀-序号 重命名（保留扩展名）',
      params: [
        { key: 'prefix', label: '前缀', type: 'text', value: 'file' },
        { key: 'start', label: '起始序号', type: 'number', value: 1, min: 0 },
      ],
      async run(ctx) {
        const prefix = String(ctx.params.prefix || 'file');
        let n = Number(ctx.params.start) || 1;
        const out = [];
        for (const p of ctx.files) {
          const ext = (p.match(/\.[^.\\/]+$/) || [''])[0];
          const dir = p.replace(/[\\/][^\\/]+$/, '');
          const target = dir + '/' + prefix + '-' + String(n).padStart(3, '0') + ext;
          const uniq = await invoke(Channels.CHANNELS.FS.UNIQUE_PATH, target);
          await invoke(Channels.CHANNELS.FS.RENAME, p, uniq);
          out.push(uniq);
          n++;
        }
        return { files: out, note: out.length + ' 个文件已重命名' };
      },
    },
    {
      id: 'to-pdf',
      name: '图片转 PDF',
      desc: '把这一批图片合成一个 PDF',
      async run(ctx) {
        const imgs = ctx.files.filter((p) => /\.(jpe?g|png|webp|bmp)$/i.test(p));
        if (!imgs.length) throw new Error('这一批里没有图片');
        const dir = imgs[0].replace(/[\\/][^\\/]+$/, '');
        const out = await invoke(Channels.CHANNELS.OFFICE.CONVERT, {
          files: imgs, target: 'pdf', outDir: dir,
        });
        const ok = out && out.results && out.results.find((x) => x.ok);
        const path = ok && ok.out ? ok.out : dir;
        return { files: [path], note: imgs.length + ' 张图片已合成 PDF' };
      },
    },
  ];

  const OP_BY_ID = new Map(OPERATIONS.map((o) => [o.id, o]));

  function baseName(p) { return String(p || '').replace(/^.*[\\/]/, ''); }

  /* 从扩展名推 MIME。只在 read-file-b64 → <img> 这一步用得上：
   * 浏览器按 data URL 的 mime 决定解码器，猜错就解码失败。
   * 猜不出时给 png —— 它是唯一对"任意字节"最宽容的候选。 */
  function guessMime(p) {
    const ext = (String(p).match(/\.([^.\\/]+)$/) || [])[1] || '';
    const m = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', bmp: 'bmp', gif: 'gif' };
    return m[ext.toLowerCase()] || 'png';
  }

  /* 把 data URL 载成 <img>。用 Promise 包一层是因为 onload/onerror
   * 必须同时挂 —— 只挂 onload 的话坏图会让链条永远挂在这一步。 */
  function loadImg(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片无法解码'));
      img.src = src;
    });
  }

  /* ============ 存储 ============
   * 链条存在 store 里（settings.chains），与其它偏好同一套机制：
   * 它有容量上限、有损坏容错，不需要另建一套持久化。 */
  const STORE_KEY = 'settings.chains';

  async function loadChains() {
    try {
      const v = await invoke(Channels.CHANNELS.STORE.GET, STORE_KEY, []);
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  async function saveChains(list) {
    try { await invoke(Channels.CHANNELS.STORE.SET, STORE_KEY, list); }
    catch (e) { toast('保存工具链失败：' + e.message, 'error'); }
  }

  /* ============ 执行引擎 ============
   * 返回逐文件的执行报告，供 UI 展示。
   * 【为什么按文件记状态而不是只记步骤】用户最关心「我这个文件到底成了没成」，
   * 而不是「第 2 步整体成功」。所以每个文件带一条状态链。 */
  async function runChain(chain, files, onProgress) {
    const steps = (chain.steps || []).map((id) => OP_BY_ID.get(id)).filter(Boolean);
    if (!steps.length) throw new Error('这条工具链没有可用步骤');
    /* 每个文件维护自己的当前路径与失败信息 */
    let state = files.map((p) => ({ orig: p, cur: p, failed: null, doneSteps: 0 }));
    let cur = state.map((s) => s.cur);

    for (let si = 0; si < steps.length; si++) {
      const op = steps[si];
      /* 只把上一轮还活着的文件投进去 */
      const alive = state.filter((s) => !s.failed);
      if (!alive.length) break;
      const inputs = alive.map((s) => s.cur);
      onProgress && onProgress({ step: si + 1, totalSteps: steps.length, label: op.name, files: inputs.length });

      let res;
      try {
        res = await op.run({
          files: inputs,
          params: chain.params && chain.params[op.id] ? chain.params[op.id] : {},
          onProgress: (d, t2, label) => onProgress && onProgress({
            step: si + 1, totalSteps: steps.length, label: label || op.name, subDone: d, subTotal: t2,
          }),
        });
      } catch (e) {
        /* 整步失败：给所有存活文件记上同一条原因 */
        alive.forEach((s) => { s.failed = op.name + '：' + (e.message || String(e)); });
        /* 若这是第一步，说明参数或环境就不对，直接抛出更清楚 */
        if (si === 0) throw e;
        break;
      }

      /* 把返回的新路径按顺序对回文件。操作可能改变数量（如 ZIP 把多个
       * 文件收成一个），此时只能把结果记到第一个文件上，其余标记为"已合并"。 */
      const outFiles = (res && res.files) || inputs;
      if (outFiles.length === inputs.length) {
        alive.forEach((s, i) => { s.cur = outFiles[i]; s.doneSteps++; });
      } else {
        alive.forEach((s, i) => {
          if (i === 0) { s.cur = outFiles[0]; s.doneSteps++; }
          else { s.doneSteps++; s.mergedInto = outFiles[0]; }
        });
      }
      cur = state.filter((s) => !s.failed).map((s) => s.cur);
      if (res && res.note) onProgress && onProgress({
        step: si + 1, totalSteps: steps.length, label: res.note,
      });
    }
    return { state, outputs: cur };
  }

  window.ChainEngine = { OPERATIONS, OP_BY_ID, loadChains, saveChains, runChain };

  /* ============ 工具页 ============ */
  register({
    id: 'tool-chain', name: '工具链', nameEn: 'Tool Chain', module: 'dev', icon: 'link',
    desc: '把多个文件操作串成流水线，一键批量跑完并出报告',
    descEn: 'Chain file operations into a pipeline and run them in one click',
    keywords: ['工具链', 'chain', '流水线', 'pipeline', '批处理', '批量', 'batch', '编排'],
    render(page) {
      let chains = [];
      let selected = -1;      // 当前编辑的链条下标
      let files = [];         // 待处理文件
      let running = false;

      const picker = window.ui.filePicker({
        text: '拖入文件，或点击选择（这一步的输入）',
        emptyText: '还没有选择文件',
        onChange: (items) => { files = items.map((x) => x.path); paintFileCount(); },
      });

      const listBox = div('chain-list');
      const editorBox = div('');
      const fileCount = div('field-hint', '');
      const reportBox = div('');

      function paintFileCount() {
        fileCount.textContent = files.length ? '共 ' + files.length + ' 个文件待处理' : '还没有选择文件';
      }

      async function reload(keepSel) {
        chains = await loadChains();
        if (keepSel != null && keepSel < chains.length) selected = keepSel;
        else if (selected >= chains.length) selected = chains.length - 1;
        paintList();
        paintEditor();
      }

      function paintList() {
        listBox.innerHTML = '';
        if (!chains.length) {
          listBox.appendChild(div('field-hint', '还没有工具链。点下面的「新建」开始。'));
          return;
        }
        chains.forEach((c, i) => {
          const row = div('chain-row' + (i === selected ? ' active' : ''));
          row.appendChild(div('chain-name', c.name || ('工具链 ' + (i + 1))));
          row.appendChild(div('chain-steps', (c.steps || []).map((id) => (OP_BY_ID.get(id) || {}).name || id).join(' → ')));
          /* 点行选中；右侧单独一个删除按钮（避免"点一下删一条"的误操作） */
          window.ui.makeButtonLike(row, '选择工具链 ' + (c.name || i + 1));
          row.addEventListener('click', () => { selected = i; paintList(); paintEditor(); });
          const del = btn('删除', 'btn-sm btn-text', async (e) => {
            e.stopPropagation();
            chains.splice(i, 1);
            if (selected >= chains.length) selected = chains.length - 1;
            await saveChains(chains);
            paintList(); paintEditor();
          });
          row.appendChild(del);
          listBox.appendChild(row);
        });
      }

      function paintEditor() {
        editorBox.innerHTML = '';
        /* 没有选中链条时给一条空白编辑态：用户点「新建」之后才有 selected */
        if (selected < 0 || !chains[selected]) {
          editorBox.appendChild(div('field-hint', '选一条工具链来编辑，或点「新建」。'));
          return;
        }
        const chain = chains[selected];
        const nameInput = h('input', { class: 'input input-sm', value: chain.name || '', style: { width: '220px' } });
        nameInput.addEventListener('input', () => { chain.name = nameInput.value; });

        editorBox.appendChild(div('form-row',
          h('span', { class: 'form-label' }, '名称'), nameInput));

        /* 步骤列表：可上下移动、可删除 */
        const stepBox = div('');
        (chain.steps || []).forEach((id, i) => {
          const op = OP_BY_ID.get(id);
          const row = div('chain-step');
          row.appendChild(div('chain-step-idx', String(i + 1)));
          row.appendChild(div('chain-step-name', op ? op.name : id + '（未知操作）'));
          if (op) row.appendChild(div('chain-step-desc', op.desc));
          const up = btn('↑', 'btn-sm btn-text', () => {
            if (i === 0) return;
            const a = chain.steps;
            [a[i - 1], a[i]] = [a[i], a[i - 1]];
            saveChains(chains); paintEditor(); paintList();
          });
          const down = btn('↓', 'btn-sm btn-text', () => {
            if (i === chain.steps.length - 1) return;
            const a = chain.steps;
            [a[i + 1], a[i]] = [a[i], a[i + 1]];
            saveChains(chains); paintEditor(); paintList();
          });
          const del = btn('×', 'btn-sm btn-text', () => {
            chain.steps.splice(i, 1);
            saveChains(chains); paintEditor(); paintList();
          });
          row.appendChild(div('chain-step-ops', up, down, del));
          stepBox.appendChild(row);
        });
        editorBox.appendChild(stepBox);

        /* 加步骤：下拉选操作 + 「添加」 */
        const sel = h('select', { class: 'select input-sm' },
          ...OPERATIONS.map((o) => h('option', { value: o.id }, o.name + ' — ' + o.desc)));
        const addBtn = btn('添加这一步', 'btn-sm btn-secondary', () => {
          chain.steps = chain.steps || [];
          chain.steps.push(sel.value);
          saveChains(chains); paintEditor(); paintList();
        });
        editorBox.appendChild(div('form-row', sel, addBtn));

        /* 参数编辑：只显示这条链里实际出现的操作的参数 */
        const used = [...new Set(chain.steps || [])].map((id) => OP_BY_ID.get(id)).filter(Boolean)
          .filter((op) => op.params && op.params.length);
        if (used.length) {
          chain.params = chain.params || {};
          editorBox.appendChild(div('card-title', '参数'));
          used.forEach((op) => {
            chain.params[op.id] = chain.params[op.id] || {};
            op.params.forEach((pdef) => {
              const cur = chain.params[op.id][pdef.key] != null ? chain.params[op.id][pdef.key] : pdef.value;
              const inp = h('input', {
                class: 'input input-sm',
                type: pdef.type === 'number' ? 'number' : 'text',
                value: String(cur == null ? '' : cur),
                style: { width: '120px' },
              });
              if (pdef.min != null) inp.min = String(pdef.min);
              if (pdef.max != null) inp.max = String(pdef.max);
              inp.addEventListener('input', () => {
                chain.params[op.id][pdef.key] = pdef.type === 'number' ? Number(inp.value) : inp.value;
                saveChains(chains);
              });
              editorBox.appendChild(div('form-row',
                h('span', { class: 'form-label' }, op.name + ' · ' + pdef.label), inp));
            });
          });
        }
      }

      /* ---- 执行 ---- */
      const progressLine = div('field-hint', '');
      const runBtn = btn('开始执行', 'btn-primary', async () => {
        if (running) return;
        if (selected < 0 || !chains[selected]) return toast('先选一条工具链', 'warn');
        if (!files.length) return toast('先选择要处理的文件', 'warn');
        const chain = chains[selected];
        if (!(chain.steps || []).length) return toast('这条工具链还没有步骤', 'warn');
        running = true;
        runBtn.disabled = true;
        reportBox.innerHTML = '';
        try {
          const t0 = Date.now();
          const rep = await runChain(chain, files.slice(), (p) => {
            const sub = p.subTotal ? '（' + p.subDone + '/' + p.subTotal + '）' : '';
            progressLine.textContent = '第 ' + p.step + '/' + p.totalSteps + ' 步：' + p.label + sub;
          });
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          const okCount = rep.state.filter((s) => !s.failed).length;
          progressLine.textContent = '完成：' + okCount + '/' + rep.state.length + ' 个文件成功，耗时 ' + secs + ' 秒';
          /* 逐文件报告：成功的给最终路径，失败的给「哪一步 + 原因」 */
          rep.state.forEach((s) => {
            const row = div('chain-report-row' + (s.failed ? ' bad' : ''));
            row.appendChild(div('chain-report-name', baseName(s.orig)));
            if (s.failed) row.appendChild(div('chain-report-err', '✗ ' + s.failed));
            else if (s.mergedInto) row.appendChild(div('chain-report-ok', '✓ 已并入 ' + baseName(s.mergedInto)));
            else row.appendChild(div('chain-report-ok', '✓ ' + s.cur));
            reportBox.appendChild(row);
          });
          toast(okCount === rep.state.length ? '工具链执行完成' : '完成，但有条目失败', okCount === rep.state.length ? 'success' : 'warn');
        } catch (e) {
          progressLine.textContent = '';
          toast('执行失败：' + e.message, 'error');
        } finally {
          running = false;
          runBtn.disabled = false;
        }
      });

      const newBtn = btn('新建', 'btn-sm btn-secondary', async () => {
        chains.push({ name: '工具链 ' + (chains.length + 1), steps: [], params: {} });
        selected = chains.length - 1;
        await saveChains(chains);
        paintList(); paintEditor();
      });

      page.appendChild(div('card', div('card-title', '工具链'),
        div('form-row', newBtn, h('span', { class: 'field-hint' }, '一条链 = 若干操作按顺序跑，上一步的输出作为下一步的输入')),
        listBox));
      page.appendChild(div('card', div('card-title', '编辑'), editorBox));
      page.appendChild(div('card', div('card-title', '待处理文件'), picker.el, fileCount));
      page.appendChild(div('card', div('card-title', '执行'), div('form-row', runBtn, progressLine), reportBox));

      reload();
    },
  });
})();
