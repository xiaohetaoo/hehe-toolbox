/* 模块：办公文档 —— diff3（三栏对比）
 *
 * 【为什么是"三栏对比"而不是"自动三路合并"】
 * 三路合并（git merge 那种）要决定：同一行两边都改了怎么办、
 * 一边删除一边修改怎么办、增删行交错怎么办……边界情况极多，
 * 而且**自动合并错了比不合并更糟**——用户会以为结果是可信的。
 *
 * 三栏对比解决的是 90% 的实际需求：**眼睛看冲突在哪**。
 * 基准在中间，左边是 A 的改法、右边是 B 的改法，三种状态一眼分清：
 *   · 只有 A 改 → 蓝（A 行）
 *   · 只有 B 改 → 蓝（B 行）
 *   · 两边都改 → 红（冲突，需要人判断）
 *   · 都没改     → 灰（不动）
 *
 * 【为什么不用 diff-tool 的 LCS 而是自己算】
 * diff-tool 的 diff() 定义在它的 render 作用域里，取不到。
 * 而且三栏的判据是「相对基准行是否变化」，不是"两两 LCS 再对齐"：
 * 逐行按索引比较就够用，且不会出现"两个 LCS 结果对不上"的问题。
 * 代价是插入/删除行会让后续行全部错位 —— 所以界面上明确说明
 * 「按行号对齐」，并提示这适用于"改了几行"的场景，
 * 不适用于"大段插入删除"的重构对比。
 */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, copyText, icon } = window.ui;
  const { invoke } = window.api;
  const MOD = 'office';
  /* 文案取词（与 qr / hash / exif / snip / codec 同一套约定）：中文原文作键，
   * 中文模式直接返回调用点字面量、不查表，所以中文界面零行为改动。 */
  const T = (zh, vars) => TT('diff3', zh, vars);

  register({
    id: 'diff3',
    name: '三栏对比', nameEn: 'Three-way Compare',
    module: MOD,
    icon: 'git-compare', i18n: true,
    desc: '以基准版本为中心，并排看 A / B 两处改动，冲突行标红', descEn: 'Compare a base version against two changed versions side by side',
    keywords: ['三路', '三栏', '合并', 'merge', 'diff3', '冲突', '对比'],
    render(page) {
      const mk = (ph) => h('textarea', { class: 'pane-ta mono', placeholder: ph, style: { minHeight: '150px' } });
      const taBase = mk(T('基准版本（两边共同的原稿）…'));
      const taA = mk(T('A 的改法…'));
      const taB = mk(T('B 的改法…'));
      const result = div('');

      function openTo(ta) {
        return async () => {
          try {
            const p = await invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: ['openFile'] });
            if (!p || !p[0]) return;
            const r = await invoke(Channels.CHANNELS.FS.READ_TEXT, p[0]);
            ta.value = r.content;
          } catch (e) { toast(T('读取失败：{e}', { e: e.message }), 'error'); }
        };
      }

      function lines(s) { return String(s || '').split(/\r?\n/); }

      /* 逐行按索引比较。返回每一行的状态：
       *   same     —— 三方一致
       *   base-only —— 基准有、两边都删了
       *   a        —— 只有 A 改了
       *   b        —— 只有 B 改了
       *   both     —— 两边都改了但内容不同（冲突）
       *   both-same —— 两边改成了同样的内容（不算冲突，值得指出）
       *   miss     —— 某一方没有这一行（长度不一致）
       */
      function compare(base, a, b) {
        const n = Math.max(base.length, a.length, b.length);
        const rows = [];
        for (let i = 0; i < n; i++) {
          /* 变量名要说清"谁的哪一行"：bl=基准行、al=A 行、cl=B 行。
           * 一开始写成 bl/bl2，读代码时反复搞混 B 是哪一个。 */
          const bl = base[i], al = a[i], cl = b[i];
          const hasBase = i < base.length, hasA = i < a.length, hasB = i < b.length;
          let kind;
          if (!hasA && !hasB) kind = 'base-only';       // 两边都删了这一行
          else if (!hasA || !hasB || !hasBase) kind = 'miss'; // 行数不一致，无法对齐
          else if (al === bl && cl === bl) kind = 'same';     // 三方一致
          else if (al === cl && al !== bl) kind = 'both-same'; // 两边改成了一样的内容
          else if (al === bl) kind = 'b';               // 只有 B 改了
          else if (cl === bl) kind = 'a';               // 只有 A 改了
          else kind = 'both';                            // 两边都改了且不同 = 冲突
          rows.push({ i, base: hasBase ? bl : null, a: hasA ? al : null, b: hasB ? cl : null, kind });
        }
        return rows;
      }

      const KIND_STYLE = {
        same: { bg: 'transparent', label: T('一致'), cls: 'tag-gray' },
        'base-only': { bg: 'rgba(245,63,63,0.12)', label: T('两边都删了'), cls: 'tag-red' },
        a: { bg: 'rgba(22,93,255,0.12)', label: T('仅 A 改'), cls: 'tag-blue' },
        b: { bg: 'rgba(22,93,255,0.12)', label: T('仅 B 改'), cls: 'tag-blue' },
        both: { bg: 'rgba(245,63,63,0.18)', label: T('冲突'), cls: 'tag-red' },
        'both-same': { bg: 'rgba(0,180,42,0.12)', label: T('两边改成一样'), cls: 'tag-green' },
        miss: { bg: 'rgba(255,125,0,0.14)', label: T('行数不一致'), cls: 'tag-orange' }
      };

      function run() {
        result.innerHTML = '';
        const base = lines(taBase.value), a = lines(taA.value), b = lines(taB.value);
        if (!taBase.value && !taA.value && !taB.value) {
          return toast(T('请至少填入基准版本与一份改法'), 'warn');
        }
        const rows = compare(base, a, b);

        /* 统计：先给出结论，再给明细。用户最想知道"有几个冲突"。 */
        const conflicts = rows.filter((r) => r.kind === 'both').length;
        const onlyA = rows.filter((r) => r.kind === 'a').length;
        const onlyB = rows.filter((r) => r.kind === 'b').length;
        const bothSame = rows.filter((r) => r.kind === 'both-same').length;
        const mismatch = rows.filter((r) => r.kind === 'miss').length;

        const head = div('form-row',
          conflicts ? h('span', { class: 'tag tag-red' }, icon('alert'), T('{n} 处冲突', { n: conflicts })) : h('span', { class: 'tag tag-green' }, T('无冲突')),
          onlyA ? h('span', { class: 'tag tag-blue' }, T('仅 A 改 {n} 行', { n: onlyA })) : null,
          onlyB ? h('span', { class: 'tag tag-blue' }, T('仅 B 改 {n} 行', { n: onlyB })) : null,
          bothSame ? h('span', { class: 'tag tag-green' }, T('两边改成一样 {n} 行', { n: bothSame })) : null,
          mismatch ? h('span', { class: 'tag tag-orange' }, T('行数不一致 {n} 行', { n: mismatch })) : null);
        result.appendChild(head);

        if (mismatch) {
          result.appendChild(div('field-hint', { style: { marginTop: '4px' } },
            T('三份文本的行数不同。本工具**按行号对齐**，行数不一致的位置已标橙——那种情况下后面的行可能整体错位，建议先让三份文本行数一致再比。')));
        }

        /* 只显示"有差异的行 + 前后各 2 行上下文"，其余折叠。
         * 三份几十行的文本全铺出来没人看，冲突往往只有一两处。 */
        const show = new Set();
        rows.forEach((r) => {
          if (r.kind === 'same') return;
          for (let d = -2; d <= 2; d++) {
            const k = r.i + d;
            if (k >= 0 && k < rows.length) show.add(k);
          }
        });
        const shown = rows.filter((r) => show.has(r.i));

        const table = h('div', { style: { marginTop: '10px', fontFamily: 'Consolas, monospace', fontSize: '12.5px' } });
        // 表头
        const head2 = h('div', { style: { display: 'grid', gridTemplateColumns: '44px 1fr 1fr 1fr', gap: '6px', color: 'var(--text-3)', padding: '4px 6px', borderBottom: '1px solid var(--border)' } },
          h('div', null, T('行号')), h('div', null, 'A'), h('div', null, T('基准')), h('div', null, 'B'));
        table.appendChild(head2);

        for (const r of shown) {
          const st = KIND_STYLE[r.kind] || KIND_STYLE.same;
          const row = h('div', {
            style: {
              display: 'grid', gridTemplateColumns: '44px 1fr 1fr 1fr', gap: '6px',
              padding: '2px 6px', background: st.bg, alignItems: 'start'
            }
          });
          row.appendChild(h('div', { style: { color: 'var(--text-3)', textAlign: 'right' } }, String(r.i + 1)));
          const cell = (v, highlight) => {
            const d = h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: highlight ? 'var(--text-1)' : 'var(--text-3)' } }, v == null ? '' : v);
            return d;
          };
          row.appendChild(cell(r.a, r.kind === 'a' || r.kind === 'both' || r.kind === 'miss'));
          row.appendChild(cell(r.base, r.kind !== 'same'));
          row.appendChild(cell(r.b, r.kind === 'b' || r.kind === 'both' || r.kind === 'miss'));
          table.appendChild(row);
        }
        result.appendChild(table);

        if (shown.length < rows.length) {
          result.appendChild(div('field-hint', { style: { marginTop: '8px' } },
            T('只显示有差异的行及其前后 2 行（共 {total} 行，显示 {shown} 行）。', { total: rows.length, shown: shown.length })));
        }

        result.appendChild(div('form-row', { style: { marginTop: '10px' } },
          btn(T('复制冲突行'), 'btn-sm btn-secondary', () => {
            const txt = rows.filter((r) => r.kind === 'both')
              .map((r) => T('第 {n} 行：\n  A: {a}\n  基准: {base}\n  B: {b}', { n: r.i + 1, a: r.a, base: r.base, b: r.b })).join('\n\n');
            if (!txt) return toast(T('没有冲突行'), 'info');
            copyText(txt);
          }),
          /* 【可编辑合并】上面的表格只能"看"，看完用户还得手动去第三份文件里
           * 一行行敲。这里给一条出路：进入合并模式，每个差异行给 A/B/基准
           * 三个单选，选完直接导出结果。
           *
           * 【为什么不做三路自动合并】
           * 那个问题（git merge 那种）的边界情况极多：一边删一边改、
           * 增删行交错、两处改动重叠……**自动合并错了比不合并更糟**，
           * 因为用户会以为结果可信。这里是"人做决定、工具只负责拼装"，
           * 每个决定都由用户点出来，责任边界清楚。 */
          btn(T('进入合并模式'), 'btn-sm btn-primary', () => enterMerge(rows), 'merge')));
      }

      /* ============ 合并模式 ============
       *
       * 三段式：
       *   ① 每个差异行（kind !== 'same'）给 A / 基准 / B 三个单选；
       *   ② 结果区实时显示拼好的全文；
       *   ③ 可复制、可另存。
       *
       * 【默认选谁】
       * 按"最少惊讶"原则：
       *   · both-same（两边改成一样）→ 默认选 A（两边内容相同，选谁都一样）
       *   · a（只有 A 改）           → 默认选 A
       *   · b（只有 B 改）           → 默认选 B
       *   · both（冲突）             → 默认选**基准**，并标红提醒"这里必须人工决定"
       *   · base-only（两边都删）    → 默认删除（选"删除"而不是留空行）
       *   · miss（行数不一致）       → 默认选基准（有就用，没有就空）
       * 只有"只有一方改"才自动采信 —— 那是无争议的。冲突一律不替用户决定。 */
      function enterMerge(rows) {
        const wrap = div('');
        /* 每行当前选择：'a' | 'base' | 'b' | 'none' */
        const choice = new Map();
        for (const r of rows) {
          if (r.kind === 'same') { choice.set(r.i, 'base'); continue; }
          if (r.kind === 'a') choice.set(r.i, 'a');
          else if (r.kind === 'b') choice.set(r.i, 'b');
          else if (r.kind === 'both-same') choice.set(r.i, 'a');
          else if (r.kind === 'base-only') choice.set(r.i, 'none');
          else choice.set(r.i, 'base');   // both / miss → 基准，且界面上标"待定"
        }

        const out = h('textarea', { class: 'pane-ta mono readonly', readonly: true, style: { minHeight: '200px' } });

        function buildText() {
          const outLines = [];
          for (const r of rows) {
            const c = choice.get(r.i);
            if (c === 'none') continue;
            const v = c === 'a' ? r.a : (c === 'b' ? r.b : r.base);
            /* null 表示那一方没有这一行 —— 跳过，不要塞空字符串
             * （否则结果里会出现凭空的空行，与原文不符）。 */
            if (v == null) continue;
            outLines.push(v);
          }
          return outLines.join('\n');
        }
        function refresh() {
          out.value = buildText();
          /* 剩余待定冲突数：both 且还停在 base 的 */
          const pending = rows.filter((r) => r.kind === 'both' && choice.get(r.i) === 'base'
            && r.a !== r.base && r.b !== r.base).length;
          const badge = wrap.querySelector('.merge-pending');
          if (badge) {
            badge.textContent = pending ? T('还有 {n} 行冲突未决定', { n: pending }) : T('所有冲突已决定');
            badge.className = 'tag ' + (pending ? 'tag-red' : 'tag-green') + ' merge-pending';
          }
        }

        const listWrap = div('merge-list');
        for (const r of rows) {
          if (r.kind === 'same') continue;
          const st = KIND_STYLE[r.kind] || KIND_STYLE.same;
          const row = div('merge-row');
          row.style.background = st.bg;

          const num = div('merge-num', String(r.i + 1));
          row.appendChild(num);

          const opts = div('merge-opts');
          const mkChoice = (val, label, text) => {
            const id = 'mg' + r.i + '_' + val;
            const input = h('input', { type: 'radio', name: 'mg' + r.i, id, class: 'radio' });
            input.checked = choice.get(r.i) === val;
            input.addEventListener('change', () => { choice.set(r.i, val); refresh(); });
            /* 【不显示 null】那一方没有这一行时，选项要写"（无此行）"
             * 而不是显示空白 —— 空白和"这一行是空字符串"看起来一样，
             * 用户没法判断自己选的是什么。 */
            const shown = text == null ? T('（无此行）') : text;
            const lab = h('label', { for: id, class: 'merge-opt' },
              input, h('span', { class: 'merge-tag' }, label),
              h('span', { class: 'merge-text' }, shown));
            return lab;
          };
          opts.appendChild(mkChoice('a', 'A', r.a));
          opts.appendChild(mkChoice('base', T('基准'), r.base));
          opts.appendChild(mkChoice('b', 'B', r.b));
          /* "删除这一行"只对能删的行有意义（两边都没这行时没得删） */
          if (r.a != null || r.base != null || r.b != null) {
            opts.appendChild(mkChoice('none', T('删除'), ''));
          }
          row.appendChild(opts);

          /* 冲突行额外标红，并把"必须人工决定"说清楚 */
          if (r.kind === 'both') {
            row.appendChild(h('span', { class: 'tag tag-red merge-conflict' }, T('冲突')));
          } else if (r.kind === 'miss') {
            row.appendChild(h('span', { class: 'tag tag-orange merge-conflict' }, T('行数不一致')));
          }
          listWrap.appendChild(row);
        }

        const pendingBadge = h('span', { class: 'tag merge-pending' }, '');
        wrap.appendChild(div('form-row',
          h('span', { class: 'form-label' }, T('合并结果')),
          pendingBadge,
          btn(T('全部采用 A'), 'btn-sm btn-secondary', () => {
            for (const r of rows) if (r.kind !== 'same' && r.a != null) choice.set(r.i, 'a');
            /* 重新勾一遍界面上的单选，否则选择与实际状态脱节 */
            syncRadios();
            refresh();
          }),
          btn(T('全部采用 B'), 'btn-sm btn-secondary', () => {
            for (const r of rows) if (r.kind !== 'same' && r.b != null) choice.set(r.i, 'b');
            syncRadios();
            refresh();
          })));
        wrap.appendChild(listWrap);
        wrap.appendChild(div('form-row', { style: { marginTop: '10px' } },
          h('span', { class: 'form-label' }, T('合并结果')),
          btn(T('复制'), 'btn-sm btn-secondary', () => { copyText(out.value); }, 'copy'),
          btn(T('另存为'), 'btn-sm btn-primary', async () => {
            try {
              const p = await invoke(Channels.CHANNELS.DIALOG.SAVE, { title: T('保存合并结果'), defaultPath: 'merged.txt' });
              if (!p) return;
              await invoke(Channels.CHANNELS.FS.WRITE_TEXT, p, out.value);
              toast(T('已保存：{p}', { p }), 'success');
            } catch (e) { toast(T('保存失败：{e}', { e: e.message }), 'error'); }
          }, 'save')));
        wrap.appendChild(out);

        function syncRadios() {
          for (const r of rows) {
            if (r.kind === 'same') continue;
            const v = choice.get(r.i);
            const el = wrap.querySelector('#mg' + r.i + '_' + v);
            if (el) el.checked = true;
          }
        }

        result.innerHTML = '';
        result.appendChild(wrap);
        refresh();
        out.value = buildText();
      }

      page.appendChild(div('card', div('card-title', T('基准版本（两边共同的原稿）'), btn(T('打开文件'), 'btn-sm btn-secondary', openTo(taBase))), taBase));
      page.appendChild(div('card', div('card-title', T('A 的改法'), btn(T('打开文件'), 'btn-sm btn-secondary', openTo(taA))), taA));
      page.appendChild(div('card', div('card-title', T('B 的改法'), btn(T('打开文件'), 'btn-sm btn-secondary', openTo(taB))), taB));
      page.appendChild(div('card', div('card-title', T('对比结果')), div('form-row', btn(T('开始对比'), 'btn-primary', run, 'git-compare')), result));
    }
  });
})();
