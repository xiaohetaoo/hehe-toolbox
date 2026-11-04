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
  const { register } = window.Registry;
  const { div, btn, toast, copyText } = window.ui;
  const { invoke } = window.api;
  const MOD = 'office';

  register({
    id: 'diff3',
    name: '三栏对比',
    module: MOD,
    icon: 'git-compare',
    desc: '以基准版本为中心，并排看 A / B 两处改动，冲突行标红',
    keywords: ['三路', '三栏', '合并', 'merge', 'diff3', '冲突', '对比'],
    render(page) {
      const mk = (ph) => h('textarea', { class: 'pane-ta mono', placeholder: ph, style: { minHeight: '150px' } });
      const taBase = mk('基准版本（两边共同的原稿）…');
      const taA = mk('A 的改法…');
      const taB = mk('B 的改法…');
      const result = div('');

      function openTo(ta) {
        return async () => {
          try {
            const p = await invoke('dialog:open', { properties: ['openFile'] });
            if (!p || !p[0]) return;
            const r = await invoke('fs:read-text', p[0]);
            ta.value = r.content;
          } catch (e) { toast('读取失败：' + e.message, 'error'); }
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
        same: { bg: 'transparent', label: '一致', cls: 'tag-gray' },
        'base-only': { bg: 'rgba(245,63,63,0.12)', label: '两边都删了', cls: 'tag-red' },
        a: { bg: 'rgba(22,93,255,0.12)', label: '仅 A 改', cls: 'tag-blue' },
        b: { bg: 'rgba(22,93,255,0.12)', label: '仅 B 改', cls: 'tag-blue' },
        both: { bg: 'rgba(245,63,63,0.18)', label: '冲突', cls: 'tag-red' },
        'both-same': { bg: 'rgba(0,180,42,0.12)', label: '两边改成一样', cls: 'tag-green' },
        miss: { bg: 'rgba(255,125,0,0.14)', label: '行数不一致', cls: 'tag-orange' }
      };

      function run() {
        result.innerHTML = '';
        const base = lines(taBase.value), a = lines(taA.value), b = lines(taB.value);
        if (!taBase.value && !taA.value && !taB.value) {
          return toast('请至少填入基准版本与一份改法', 'warn');
        }
        const rows = compare(base, a, b);

        /* 统计：先给出结论，再给明细。用户最想知道"有几个冲突"。 */
        const conflicts = rows.filter((r) => r.kind === 'both').length;
        const onlyA = rows.filter((r) => r.kind === 'a').length;
        const onlyB = rows.filter((r) => r.kind === 'b').length;
        const bothSame = rows.filter((r) => r.kind === 'both-same').length;
        const mismatch = rows.filter((r) => r.kind === 'miss').length;

        const head = div('form-row',
          conflicts ? h('span', { class: 'tag tag-red' }, `⚠ ${conflicts} 处冲突`) : h('span', { class: 'tag tag-green' }, '无冲突'),
          onlyA ? h('span', { class: 'tag tag-blue' }, `仅 A 改 ${onlyA} 行`) : null,
          onlyB ? h('span', { class: 'tag tag-blue' }, `仅 B 改 ${onlyB} 行`) : null,
          bothSame ? h('span', { class: 'tag tag-green' }, `两边改成一样 ${bothSame} 行`) : null,
          mismatch ? h('span', { class: 'tag tag-orange' }, `行数不一致 ${mismatch} 行`) : null);
        result.appendChild(head);

        if (mismatch) {
          result.appendChild(div('field-hint', { style: { marginTop: '4px' } },
            '三份文本的行数不同。本工具**按行号对齐**，行数不一致的位置已标橙——'
            + '那种情况下后面的行可能整体错位，建议先让三份文本行数一致再比。'));
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
          h('div', null, '行号'), h('div', null, 'A'), h('div', null, '基准'), h('div', null, 'B'));
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
            `只显示有差异的行及其前后 2 行（共 ${rows.length} 行，显示 ${shown.length} 行）。`));
        }

        result.appendChild(div('form-row', { style: { marginTop: '10px' } },
          btn('复制冲突行', 'btn-sm btn-secondary', () => {
            const txt = rows.filter((r) => r.kind === 'both')
              .map((r) => `第 ${r.i + 1} 行：\n  A: ${r.a}\n  基准: ${r.base}\n  B: ${r.b}`).join('\n\n');
            if (!txt) return toast('没有冲突行', 'info');
            copyText(txt);
          })));
      }

      page.appendChild(div('card', div('card-title', '基准版本（两边共同的原稿）', btn('打开文件', 'btn-sm btn-secondary', openTo(taBase))), taBase));
      page.appendChild(div('card', div('card-title', 'A 的改法', btn('打开文件', 'btn-sm btn-secondary', openTo(taA))), taA));
      page.appendChild(div('card', div('card-title', 'B 的改法', btn('打开文件', 'btn-sm btn-secondary', openTo(taB))), taB));
      page.appendChild(div('card', div('card-title', '对比结果'), div('form-row', btn('开始对比', 'btn-primary', run, 'git-compare')), result));
    }
  });
})();
