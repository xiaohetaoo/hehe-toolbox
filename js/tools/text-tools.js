/* 模块：文本与编码 —— 文本批量处理 / 统计 / 大小写 / 简繁 / CSV */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, convertLayout, renderTable, fmtNum } = window.ui;
  const MOD = 'text';

  register({
    id: 'text-batch', name: '文本批量处理', module: MOD, icon: 'list',
    desc: '去空行、去重、排序、反转、增删前后缀、拆分合并一步到位',
    keywords: ['去重', '排序', '空行', '批处理', '行'],
    render(page) {
      const ta = h('textarea', { class: 'pane-ta', placeholder: '每行一条，粘贴文本列表…', style: { minHeight: '200px' } });
      const out = h('textarea', { class: 'pane-ta readonly', readonly: true, placeholder: '处理结果…', style: { minHeight: '200px' } });
      const ops = [
        ['trim', '去首尾空格', lines => lines.map(l => l.trim())],
        ['noblank', '去空行', lines => lines.filter(l => l.trim() !== '')],
        ['dedup', '去重复行', lines => [...new Set(lines)]],
        ['sort', '升序排序', lines => [...lines].sort((a, b) => a.localeCompare(b, 'zh'))],
        ['sortd', '降序排序', lines => [...lines].sort((a, b) => b.localeCompare(a, 'zh'))],
        ['reverse', '行顺序反转', lines => [...lines].reverse()],
        ['num', '添加行号', lines => lines.map((l, i) => `${i + 1}. ${l}`)],
        ['length', '按长度排序', lines => [...lines].sort((a, b) => a.length - b.length)]
      ];
      const prefixIn = h('input', { class: 'input input-sm', placeholder: '行前缀', style: { width: '90px' } });
      const suffixIn = h('input', { class: 'input input-sm', placeholder: '行后缀', style: { width: '90px' } });
      const joinIn = h('input', { class: 'input input-sm', value: '\\n', style: { width: '70px' } });
      const btnRow = div('form-row', ...ops.map(([id, name, fn]) => btn(name, 'btn-secondary btn-sm', () => apply(fn))));
      page.appendChild(div('card', div('card-title', '输入'), ta));
      const actCard = div('card', div('card-title', '操作（可叠加执行）'), btnRow,
        div('form-row', h('span', { class: 'form-label' }, '前/后缀'), prefixIn, suffixIn,
          btn('添加前后缀', 'btn-secondary btn-sm', () => apply(lines => lines.map(l => prefixIn.value + l + suffixIn.value))),
          h('span', { class: 'form-label', style: { minWidth: 'auto', marginLeft: '10px' } }, '合并分隔符'), joinIn,
          btn('合并为一行', 'btn-secondary btn-sm', () => {
            const j = joinIn.value.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
            apply(lines => [lines.join(j)]);
          }),
          btn('按分隔符拆分', 'btn-secondary btn-sm', async () => {
            const sep = await window.ui.promptBox({ title: '按分隔符拆分', label: '输入分隔符（支持 \\t）：', value: ',' });
            if (sep == null) return;
            apply(lines => lines.flatMap(l => l.split(sep.replace(/\\t/g, '\t'))));
          })));
      page.appendChild(actCard);
      page.appendChild(div('card', div('card-title', '结果', h('span', { class: 'pane-count', id: 'tb-count' })), out,
        div('form-row', btn('复制结果', 'btn-secondary btn-sm', () => copyText(out.value)), btn('替换输入', 'btn-secondary btn-sm', () => { ta.value = out.value; out.value = ''; updateCount(); }))));
      function apply(fn) {
        const src = out.value ? out.value : ta.value; // 有上次结果时基于其叠加执行
        if (!src) return toast('请先输入文本', 'warn');
        const result = fn(src.split(/\r?\n/));
        out.value = result.join('\n');
        updateCount();
      }
      function updateCount() {
        const el = page.querySelector('#tb-count');
        if (el) el.textContent = out.value ? `${out.value.split(/\r?\n/).length} 行` : '';
      }
    }
  });

  register({
    id: 'text-stats', name: '文本统计', module: MOD, icon: 'eye',
    desc: '字符数、字数、行数、词频统计',
    keywords: ['统计', '字数', '词频', '行数'],
    render(page) {
      const ta = h('textarea', { class: 'pane-ta', placeholder: '粘贴要统计的文本…', style: { minHeight: '180px' } });
      const result = div('card');
      const wordBox = div('card');
      wordBox.style.display = 'none';
      ta.addEventListener('input', window.ui.debounce(update, 200));
      page.appendChild(div('card', div('card-title', '文本'), ta));
      page.appendChild(result);
      page.appendChild(wordBox);
      function update() {
        const text = ta.value;
        if (!text) { result.innerHTML = '<div class="empty-tip">开始输入后显示统计结果</div>'; wordBox.style.display = 'none'; return; }
        const chars = [...text].length;
        const noSpace = text.replace(/\s/g, '').length;
        const lines = text.split(/\r?\n/).length;
        const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length;
        const en = (text.match(/[a-zA-Z]+/g) || []).length;
        const nums = (text.match(/\d+/g) || []).length;
        const words = en + cn + nums;
        const paras = text.split(/\n\s*\n/).filter(p => p.trim()).length;
        result.innerHTML = '';
        result.className = 'card';
        result.appendChild(div('card-title', '统计结果'));
        result.appendChild(window.ui.kvGrid([
          ['总字符', fmtNum(chars)], ['不含空白', fmtNum(noSpace)],
          ['行数', fmtNum(lines)], ['段落数', fmtNum(paras)],
          ['中文字符', fmtNum(cn)], ['英文单词', fmtNum(en)],
          ['数字串', fmtNum(nums)], ['合计字数', fmtNum(words)]
        ]));
        // 词频
        const freq = new Map();
        for (const w of text.toLowerCase().match(/[a-zA-Z][a-zA-Z'-]*|[\u4e00-\u9fff]{2,}|\d+/g) || []) {
          freq.set(w, (freq.get(w) || 0) + 1);
        }
        const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
        wordBox.style.display = '';
        wordBox.innerHTML = '';
        wordBox.appendChild(div('card-title', '高频词 TOP 20'));
        if (top.length) {
          wordBox.appendChild(renderTable({
            columns: [
              { key: 'w', title: '词', render: r => r[0] },
              { key: 'c', title: '次数', width: '100px', render: r => r[1] },
              { key: 'p', title: '占比', width: '200px', render: r => div('', h('div', { class: 'progress', style: { height: '8px' } }, h('div', { class: 'progress-fill', style: { width: (r[1] / top[0][1] * 100) + '%' } }))) }
            ],
            rows: top
          }));
        } else wordBox.appendChild(div('empty-tip', '未识别到词语'));
      }
      update();
    }
  });

  register({
    id: 'case-convert', name: '大小写转换', module: MOD, icon: 'type',
    desc: '全大写、全小写、首字母大写、驼峰/下划线互转',
    keywords: ['大小写', '驼峰', 'upper', 'camel'],
    render(page) {
      const ta = h('textarea', { class: 'pane-ta', placeholder: '输入文本…', style: { minHeight: '120px' } });
      const out = h('textarea', { class: 'pane-ta readonly', readonly: true, style: { minHeight: '120px' } });
      const ops = [
        ['UPPER 全大写', s => s.toUpperCase()],
        ['lower 全小写', s => s.toLowerCase()],
        ['Sentence 首字母大写', s => s.toLowerCase().replace(/(^|[.!?]\s+)([a-z])/g, (_, p, c) => p + c.toUpperCase())],
        ['Title Each Word', s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase())],
        ['camelCase', s => s.toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase())],
        ['PascalCase', s => { const c = s.toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, x) => x.toUpperCase()); return c.charAt(0).toUpperCase() + c.slice(1); }],
        ['snake_case', s => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()],
        ['kebab-case', s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()],
        ['iNVERT 大小写反转', s => [...s].map(c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join('')]
      ];
      page.appendChild(div('card', div('card-title', '输入'), ta,
        div('form-row', ...ops.map(([name, fn]) => btn(name, 'btn-secondary btn-sm', () => { out.value = fn(ta.value); })))));
      page.appendChild(div('card', div('card-title', '结果'), out, div('form-row', btn('复制', 'btn-secondary btn-sm', () => copyText(out.value)))));
    }
  });

  register({
    id: 'zh-convert', name: '简繁转换', module: MOD, icon: 'languages',
    desc: '简体中文与繁体中文互转（OpenCC 本地引擎，离线可用）',
    keywords: ['简繁', '繁体', '简体', 'opencc'],
    render(page) {
      const box = convertLayout({
        inputLabel: '原文', outputLabel: '转换结果', realtime: true, height: 180,
        onConvert: (t) => convert(t)
      });
      page.appendChild(box.el);
      let converter = null, mode = 's2t';
      function convert(text) {
        if (!window.OpenCC) return '⚠ OpenCC 库加载失败';
        try {
          if (!converter || converter._mode !== mode) {
            const conf = mode === 's2t' ? 'Locale:zh-CN→zh-TW' : 'Locale:zh-TW→zh-CN';
            converter = window.OpenCC.Converter({ from: mode === 's2t' ? 'cn' : 't', to: mode === 's2t' ? 'tw' : 'cn' });
            converter._mode = mode;
          }
          return converter(text);
        } catch (e) { return '⚠ ' + e.message; }
      }
      const b1 = btn('简 → 繁', 'btn-secondary btn-sm', () => { mode = 's2t'; fire(); }, null);
      const b2 = btn('繁 → 简', 'btn-secondary btn-sm', () => { mode = 't2s'; fire(); }, null);
      page.insertBefore(div('form-row', h('span', { class: 'field-hint' }, '选择方向：'), b1, b2), box.el);
      const ta = box.input, out = box.output;
      function fire() {
        out.value = ta.value ? convert(ta.value) : '';
      }
      ta.addEventListener('input', fire);
      fire();
    }
  });

  register({
    id: 'csv-json', name: 'CSV / JSON 互转', module: MOD, icon: 'table',
    desc: 'CSV 与 JSON 表格互转，支持自定义分隔符与表头',
    keywords: ['csv', 'json', '表格', 'tsv'],
    render(page) {
      let mode = 'csv2json'; // csv2json | json2csv
      const ta = h('textarea', { class: 'pane-ta', placeholder: mode === 'csv2json' ? '粘贴 CSV 文本（首行为表头）…' : '粘贴 JSON 数组…', style: { minHeight: '180px' } });
      const out = h('textarea', { class: 'pane-ta readonly', readonly: true, style: { minHeight: '180px' } });
      const sepSel = h('select', { class: 'select input-sm' }, h('option', { value: ',' }, '逗号 ,'), h('option', { value: '\t' }, 'Tab'), h('option', { value: ';' }, '分号 ;'), h('option', { value: '|' }, '竖线 |'));
      function parseCSV(text, sep) {
        const rows = [];
        let row = [], field = '', inQ = false;
        for (let i = 0; i < text.length; i++) {
          const c = text[i];
          if (inQ) {
            if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
            else field += c;
          } else if (c === '"') inQ = true;
          else if (c === sep) { row.push(field); field = ''; }
          else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.length > 1 || row[0] !== '') rows.push(row);
            row = [];
          } else field += c;
        }
        row.push(field);
        if (row.length > 1 || row[0] !== '') rows.push(row);
        return rows;
      }
      function toCSV(arr, sep) {
        const esc = (v) => { const s = v == null ? '' : String(v); return new RegExp(`["\n\r${sep === '\t' ? '\\t' : sep === '|' ? '\\|' : sep === ';' ? ';' : ','}]`).test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        return arr.map(r => r.map(esc).join(sep)).join('\n');
      }
      function fire() {
        out.value = '';
        if (!ta.value.trim()) return;
        try {
          if (mode === 'csv2json') {
            const rows = parseCSV(ta.value, sepSel.value);
            if (rows.length < 1) return;
            const header = rows[0];
            const data = rows.slice(1).map(r => {
              const o = {};
              header.forEach((hd, i) => o[hd.trim() || `列${i + 1}`] = r[i] ?? '');
              return o;
            });
            out.value = JSON.stringify(data, null, 2);
          } else {
            const data = JSON.parse(ta.value);
            if (!Array.isArray(data) || !data.length) throw new Error('需要非空 JSON 数组');
            const header = [...new Set(data.flatMap(o => Object.keys(o)))];
            const rows = [header, ...data.map(o => header.map(k => o[k]))];
            out.value = toCSV(rows, sepSel.value);
          }
        } catch (e) { out.value = '⚠ ' + e.message; }
      }
      ta.addEventListener('input', window.ui.debounce(fire, 300));
      sepSel.addEventListener('change', fire);
      page.appendChild(div('card',
        div('card-title', '输入',
          btn('CSV → JSON', 'btn-sm ' + (mode === 'csv2json' ? 'btn-primary' : 'btn-secondary'), () => { mode = 'csv2json'; ta.placeholder = '粘贴 CSV 文本（首行为表头）…'; refreshMode(); fire(); }),
          ' ',
          btn('JSON → CSV', 'btn-sm ' + (mode === 'json2csv' ? 'btn-primary' : 'btn-secondary'), () => { mode = 'json2csv'; ta.placeholder = '粘贴 JSON 数组…'; refreshMode(); fire(); })),
        div('form-row', h('span', { class: 'form-label' }, '分隔符'), sepSel),
        ta));
      page.appendChild(div('card', div('card-title', '结果'), out, div('form-row', btn('复制', 'btn-secondary btn-sm', () => copyText(out.value)))));
      function refreshMode() {
        const btns = page.querySelectorAll('.card-title .btn');
        btns.forEach(b => { b.classList.remove('btn-primary'); b.classList.add('btn-secondary'); });
        if (btns[mode === 'csv2json' ? 0 : 1]) { btns[mode === 'csv2json' ? 0 : 1].classList.remove('btn-secondary'); btns[mode === 'csv2json' ? 0 : 1].classList.add('btn-primary'); }
      }
      fire();
    }
  });
})();
