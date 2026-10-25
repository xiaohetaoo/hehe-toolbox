/* 模块：开发调试 —— JSON 格式化 / 正则测试 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, renderTable } = window.ui;

  /* ---------- JSON 格式化 ---------- */
  register({
    id: 'json-format', name: 'JSON 格式化', module: 'dev', icon: 'code',
    desc: 'JSON 压缩、格式化、校验、树形展开查看',
    keywords: ['json', '格式化', '校验', '美化'],
    render(page) {
      const ta = h('textarea', { class: 'pane-ta', placeholder: '粘贴 JSON 字符串…', style: { minHeight: '220px' } });
      const out = h('textarea', { class: 'pane-ta readonly', readonly: true, style: { minHeight: '220px' } });
      const indentSel = h('select', { class: 'select input-sm' }, h('option', { value: '2' }, '2 空格'), h('option', { value: '4' }, '4 空格'), h('option', { value: '\t' }, 'Tab'));
      const sortChk = h('input', { type: 'checkbox', class: 'checkbox' });
      const status = h('span', { class: 'field-hint' }, '');
      let lastValid = null;
      function sortKey(v) {
        if (Array.isArray(v)) return v.map(sortKey);
        if (v && typeof v === 'object') {
          const o = {};
          for (const k of Object.keys(v).sort()) o[k] = sortKey(v[k]);
          return o;
        }
        return v;
      }
      function fire() {
        const text = ta.value.trim();
        status.textContent = '';
        status.style.color = '';
        if (!text) { out.value = ''; treeBox.innerHTML = ''; return; }
        try {
          let obj = JSON.parse(text);
          lastValid = obj;
          if (sortChk.checked) obj = sortKey(obj);
          out.value = JSON.stringify(obj, null, indentSel.value === '\t' ? '\t' : parseInt(indentSel.value));
          status.textContent = `✓ 校验通过 · ${Object.keys(obj).length && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj).length + ' 个顶层键' : (Array.isArray(obj) ? obj.length + ' 个元素' : '标量')}`;
          status.style.color = 'var(--success)';
          drawTree(obj);
        } catch (e) {
          out.value = '';
          lastValid = null;
          status.textContent = '✗ ' + e.message;
          status.style.color = 'var(--danger)';
          treeBox.innerHTML = '';
        }
      }
      const treeBox = div('');
      function drawTree(obj) {
        treeBox.innerHTML = '';
        const root = buildTreeNode('root', obj, true);
        treeBox.appendChild(root);
      }
      function buildTreeNode(key, value, isRoot) {
        const node = div('tree-node');
        node.style.marginLeft = isRoot ? '0' : '18px';
        const isObj = value && typeof value === 'object';
        const row = div('form-row');
        row.style.marginBottom = '2px';
        const typeTag = Array.isArray(value) ? 'array' : typeof value === 'object' && value ? 'object' : typeof value;
        const colors = { object: 'tag-blue', array: 'tag-green', string: 'tag-orange', number: 'tag-gray', boolean: 'tag-red', null: 'tag-gray' };
        if (isObj) {
          const arrow = h('span', { style: { cursor: 'pointer', color: 'var(--primary)', display: 'inline-flex', width: '16px' } }, '▾');
          row.appendChild(arrow);
          row.appendChild(h('span', { class: 'mono', style: { color: 'var(--primary)' } }, key));
          row.appendChild(h('span', { class: `tag ${colors[typeTag]}`, style: { marginLeft: '8px' } }, typeTag === 'object' ? `{${Object.keys(value).length}}` : `[${value.length}]`));
          const children = div('');
          for (const [k, v] of Object.entries(value)) children.appendChild(buildTreeNode(k, v));
          arrow.addEventListener('click', () => {
            const collapsed = children.style.display === 'none';
            children.style.display = collapsed ? '' : 'none';
            arrow.textContent = collapsed ? '▾' : '▸';
          });
          node.appendChild(row);
          node.appendChild(children);
        } else {
          row.appendChild(h('span', { style: { display: 'inline-flex', width: '16px' } }));
          row.appendChild(h('span', { class: 'mono', style: { color: 'var(--primary)' } }, key));
          row.appendChild(h('span', { class: 'mono', style: { marginLeft: '10px', color: typeTag === 'string' ? 'var(--success)' : 'var(--warning)', userSelect: 'text' } },
            typeTag === 'string' ? `"${value}"` : String(value)));
          row.appendChild(h('span', { class: `tag ${colors[typeTag]}`, style: { marginLeft: '8px' } }, typeTag));
          node.appendChild(row);
        }
        return node;
      }
      ta.addEventListener('input', window.ui.debounce(fire, 300));
      indentSel.addEventListener('change', fire);
      sortChk.addEventListener('change', fire);
      page.appendChild(div('card', div('card-title', '输入', status), div('form-row',
        h('span', { class: 'form-label' }, '缩进'), indentSel,
        h('label', { class: 'field-hint' }, sortChk, ' 键名排序')),
        ta,
        div('form-row',
          btn('格式化', 'btn-sm btn-primary', fire),
          btn('压缩', 'btn-sm btn-secondary', () => {
            try { out.value = JSON.stringify(JSON.parse(ta.value)); } catch (e) { toast('JSON 有误：' + e.message, 'error'); }
          }),
          btn('示例', 'btn-sm btn-text', () => { ta.value = '{"name":"核核工具箱","version":"1.0.0","tools":["base64","json"],"config":{"theme":"blue","count":66}}'; fire(); }))));
      page.appendChild(div('card', div('card-title', '格式化结果'), out, div('form-row', btn('复制', 'btn-sm btn-secondary', () => copyText(out.value)))));
      const treeCard = div('card', div('card-title', '树形查看'), treeBox);
      page.appendChild(treeCard);
    }
  });

  /* ---------- 正则测试 ---------- */
  register({
    id: 'regex-test', name: '正则测试', module: 'dev', icon: 'regex',
    desc: '正则匹配测试、分组提取、批量替换、常用模板',
    keywords: ['正则', 'regex', 'regexp', '匹配', '替换'],
    render(page) {
      const patternIn = h('input', { class: 'input mono', placeholder: '输入正则表达式', value: '', style: { flex: '1' } });
      const flagsIn = h('input', { class: 'input mono', value: 'g', style: { width: '70px' }, title: '标志位' });
      const testTa = h('textarea', { class: 'pane-ta', placeholder: '输入测试文本…', style: { minHeight: '150px' } });
      const matchOut = h('textarea', { class: 'pane-ta readonly', readonly: true, placeholder: '匹配结果…', style: { minHeight: '120px' } });
      const replaceIn = h('input', { class: 'input mono', placeholder: '替换为（支持 $1 $2 分组引用），留空则仅测试', style: { flex: '1' } });
      const replOut = h('textarea', { class: 'pane-ta readonly', readonly: true, placeholder: '替换结果…', style: { minHeight: '80px' } });
      const status = h('span', { class: 'field-hint' }, '');
      const TEMPLATES = {
        '邮箱': '[\\w.-]+@[\\w-]+(\\.[\\w-]+)+',
        '手机号': '1[3-9]\\d{9}',
        'URL': 'https?://[^\\s]+',
        'IPv4': '\\b(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d?\\d)\\b',
        '日期': '\\d{4}-\\d{2}-\\d{2}',
        '中文': '[\\u4e00-\\u9fff]+',
        'HTML 标签': '<[^>]+>',
        '空白行': '^\\s*$\\n?'
      };
      function fire() {
        status.textContent = '';
        status.style.color = '';
        matchOut.value = ''; replOut.value = '';
        if (!patternIn.value) return;
        try {
          const re = new RegExp(patternIn.value, flagsIn.value.includes('g') ? flagsIn.value : flagsIn.value + 'g');
          const text = testTa.value;
          const matches = [...text.matchAll(re)];
          if (!matches.length) { status.textContent = '无匹配'; status.style.color = 'var(--text-3)'; }
          else {
            status.textContent = `✓ 匹配 ${matches.length} 处`;
            status.style.color = 'var(--success)';
            matchOut.value = matches.map((m, i) => {
              const groups = m.slice(1).map((g, gi) => g != null ? `  组${gi + 1}: ${g}` : '').filter(Boolean).join('\n');
              return `[${i}] "${m[0]}" @${m.index}${groups ? '\n' + groups : ''}`;
            }).join('\n');
          }
          if (replaceIn.value !== '') {
            const re2 = new RegExp(patternIn.value, flagsIn.value);
            replOut.value = text.replace(re2, replaceIn.value);
          }
        } catch (e) { status.textContent = '✗ ' + e.message; status.style.color = 'var(--danger)'; }
      }
      const tplRow = div('form-row', h('span', { class: 'form-label' }, '模板'),
        ...Object.entries(TEMPLATES).map(([n, p]) => btn(n, 'btn-sm btn-secondary', () => { patternIn.value = p; fire(); })));
      page.appendChild(div('card', div('card-title', '表达式', status),
        div('form-row', patternIn, h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '/'), flagsIn),
        tplRow));
      page.appendChild(div('card', div('card-title', '测试文本'), testTa));
      page.appendChild(div('card', div('card-title', '匹配结果'),
        matchOut,
        div('form-row', h('span', { class: 'form-label' }, '替换'), replaceIn)));
      page.appendChild(div('card', div('card-title', '替换结果'), replOut, div('form-row', btn('复制替换结果', 'btn-sm btn-secondary', () => copyText(replOut.value)))));
      [patternIn, flagsIn, testTa, replaceIn].forEach(el => el.addEventListener('input', window.ui.debounce(fire, 300)));
      fire();
    }
  });
})();
