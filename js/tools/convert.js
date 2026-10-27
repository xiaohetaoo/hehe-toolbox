/* 模块：文本与编码/开发调试 —— 进制、时间戳、单位换算、科学计算器 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, fmtNum, pad2, fieldRow } = window.ui;

  /* ---------- 进制转换（支持大数 BigInt） ---------- */
  register({
    id: 'radix', name: '进制转换', module: 'text', icon: 'calculator',
    desc: '2/8/10/16 进制互转，支持任意大数（BigInt）',
    keywords: ['进制', '二进制', '十六进制', 'bin', 'hex'],
    render(page) {
      const input = h('input', { class: 'input', placeholder: '输入数值（支持负数与小数点前的整数）', style: { flex: '1' } });
      const fromSel = h('select', { class: 'select' }, ...[['2', '二进制'], ['8', '八进制'], ['10', '十进制'], ['16', '十六进制']].map(([v, n]) => h('option', { value: v }, n)));
      fromSel.value = '10';
      const grid = div('');
      grid.style.marginTop = '14px';
      function fire() {
        const val = input.value.trim().replace(/[\s,]/g, '');
        const from = parseInt(fromSel.value);
        grid.innerHTML = '';
        if (!val) return;
        try {
          const neg = val.startsWith('-');
          const raw = neg ? val.slice(1) : val;
          if (!/^[0-9a-fA-F]+$/.test(raw)) throw new Error('包含非法字符');
          // 注意：BigInt('-0xFF') / BigInt('-0b101') 按规范是 SyntaxError（带符号的字符串只允许十进制）。
          // 所以必须先按进制取绝对值，再取反。
          const abs = BigInt((from === 16 ? '0x' : from === 8 ? '0o' : from === 2 ? '0b' : '') + raw);
          const big = neg ? -abs : abs;
          const rows = [['十进制', big.toString(10)], ['二进制', big.toString(2)], ['八进制', big.toString(8)], ['十六进制', big.toString(16).toUpperCase()]];
          for (const [name, v] of rows) {
            const row = div('form-row');
            row.appendChild(h('span', { class: 'form-label' }, name));
            const inp = h('input', { class: 'input mono', readonly: true, value: v, style: { flex: '1', userSelect: 'text' } });
            inp.addEventListener('click', () => inp.select());
            row.appendChild(inp);
            row.appendChild(btn('复制', 'btn-sm btn-text', () => copyText(v)));
            grid.appendChild(row);
          }
        } catch (e) {
          grid.appendChild(div('field-err', '⚠ ' + e.message + '（请确认与所选进制匹配）'));
        }
      }
      input.addEventListener('input', fire);
      fromSel.addEventListener('change', fire);
      page.appendChild(div('card', div('card-title', '输入'), div('form-row', fromSel, input)));
      page.appendChild(div('card', div('card-title', '转换结果'), grid));
    }
  });

  /* ---------- 时间戳工具 ---------- */
  register({
    id: 'timestamp', name: '时间戳工具', module: 'text', icon: 'clock',
    desc: '时间戳与日期双向转换，支持秒/毫秒、UTC/本地时区',
    keywords: ['时间戳', 'timestamp', '日期', 'unix'],
    render(page) {
      let unit = 's'; // s | ms
      let useUTC = false;
      const nowBtn = btn('当前时间', 'btn-secondary btn-sm', () => {
        const ms = Date.now();
        tsInput.value = unit === 's' ? String(Math.floor(ms / 1000)) : String(ms);
        fireTs();
      });
      const tsInput = h('input', { class: 'input mono', placeholder: '输入时间戳', style: { flex: '1' } });
      const unitSel = h('select', { class: 'select input-sm' }, h('option', { value: 's' }, '秒级'), h('option', { value: 'ms' }, '毫秒级'));
      unitSel.addEventListener('change', () => { unit = unitSel.value; fireTs(); });
      const dateIn = h('input', { type: 'datetime-local', class: 'input', step: '1' });
      const tzChk = h('label', { class: 'field-hint' }, h('input', { type: 'checkbox', class: 'checkbox' }), ' 使用 UTC 时区');
      tzChk.querySelector('input').addEventListener('change', (e) => { useUTC = e.target.checked; fireTs(); fireDate(); });

      const outGrid = div('');
      const tsOut = h('input', { class: 'input mono', readonly: true, style: { flex: '1' } });
      let tsEcho = null; // 「日期→时间戳」卡片中的回显 span，随 fireDate 同步更新
      const tsOutBtn = btn('复制', 'btn-sm btn-text', () => copyText(tsOut.value));

      function fmtD(date) {
        if (useUTC) return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
      }
      function fireTs() {
        const v = tsInput.value.trim();
        outGrid.innerHTML = '';
        if (!v) { tsOut.value = ''; return; }
        if (!/^-?\d+$/.test(v)) { outGrid.appendChild(div('field-err', '⚠ 时间戳必须是整数')); return; }
        let ms = parseInt(v);
        if (unit === 's') ms *= 1000;
        const d = new Date(ms);
        if (isNaN(d.getTime())) { outGrid.appendChild(div('field-err', '⚠ 无效时间戳')); return; }
        const local = d.toLocaleString('zh-CN', { hour12: false });
        const rows = [
          ['本地时间', fmtD(new Date(ms - (useUTC ? 0 : 0)))],
          ['UTC 时间', d.toISOString().replace('T', ' ').replace('Z', '')],
          ['相对时间', `${fmtNum(Math.floor((Date.now() - ms) / 1000))} 秒前`]
        ];
        tsOut.value = fmtD(d);
        for (const [k, val] of rows) outGrid.appendChild(div('form-row', h('span', { class: 'form-label' }, k), h('span', { class: 'mono', style: { userSelect: 'text' } }, val)));
      }
      function fireDate() {
        if (!dateIn.value) return;
        const d = new Date(dateIn.value + (useUTC ? 'Z' : ''));
        if (isNaN(d.getTime())) return;
        tsOut.value = unit === 's' ? String(Math.floor(d.getTime() / 1000)) : String(d.getTime());
        if (tsEcho) tsEcho.textContent = tsOut.value;
      }
      tsInput.addEventListener('input', fireTs);
      dateIn.addEventListener('input', () => { fireDate(); });
      // 默认填充当前
      const n = new Date();
      dateIn.value = `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}T${pad2(n.getHours())}:${pad2(n.getMinutes())}:${pad2(n.getSeconds())}`;
      fireDate();

      page.appendChild(div('card', div('card-title', '时间戳 → 日期'),
        div('form-row', tsInput, unitSel, nowBtn), outGrid,
        div('form-row', h('span', { class: 'form-label' }, '结果'), tsOut, tsOutBtn)));
      page.appendChild(div('card', div('card-title', '日期 → 时间戳'),
        div('form-row', dateIn, tzChk),
        div('form-row', h('span', { class: 'form-label' }, '时间戳'), tsEcho = h('span', { class: 'mono', style: { userSelect: 'text' } }, tsOut.value || '')),
        div('form-row', btn('复制上方时间戳', 'btn-sm btn-text', () => copyText(tsOut.value)))));
    }
  });

  /* ---------- 单位换算 ---------- */
  register({
    id: 'unit-convert', name: '单位换算', module: 'dev', icon: 'move-h',
    desc: '长度、重量、面积、体积、存储、时间、速度、温度换算',
    keywords: ['单位', '换算', '长度', '重量', '存储'],
    render(page) {
      const CATS = {
        length: { name: '长度', units: { 毫米: 0.001, 厘米: 0.01, 米: 1, 千米: 1000, 英寸: 0.0254, 英尺: 0.3048, 码: 0.9144, 英里: 1609.344, 海里: 1852, 尺: 1 / 3, 里: 500 } },
        weight: { name: '重量', units: { 毫克: 1e-6, 克: 0.001, 千克: 1, 吨: 1000, 两: 0.05, 斤: 0.5, 磅: 0.45359237, 盎司: 0.028349523 } },
        area: { name: '面积', units: { 平方毫米: 1e-6, 平方厘米: 1e-4, 平方米: 1, 平方千米: 1e6, 公顷: 1e4, 亩: 666.6667, 平方英尺: 0.09290304, 平方英寸: 0.00064516 } },
        volume: { name: '体积', units: { 毫升: 0.001, 升: 1, 立方米: 1000, 加仑美: 3.785412, 加仑英: 4.546092, 品脱美: 0.4731765 } },
        storage: { name: '存储', units: { bit: 1 / 8, Byte: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 } },
        time: { name: '时间', units: { 毫秒: 0.001, 秒: 1, 分钟: 60, 小时: 3600, 天: 86400, 周: 604800, 月: 2592000, 年: 31536000 } },
        speed: { name: '速度', units: { '米/秒': 1, '千米/时': 1 / 3.6, '英里/时': 0.44704, 节: 0.5144444, '英尺/秒': 0.3048 } },
        temp: { name: '温度', units: { '°C': 1, '°F': 1, K: 1 }, special: true }
      };
      const catSel = h('select', { class: 'select' }, ...Object.entries(CATS).map(([k, c]) => h('option', { value: k }, c.name)));
      const fromSel = h('select', { class: 'select' });
      const toSel = h('select', { class: 'select' });
      const valIn = h('input', { class: 'input mono', placeholder: '输入数值', style: { flex: '1' } });
      const resultEl = div('');
      resultEl.style.fontSize = '20px';
      resultEl.style.fontWeight = '600';
      resultEl.style.color = 'var(--primary)';
      resultEl.style.marginTop = '8px';
      function fillUnits() {
        const cat = CATS[catSel.value];
        fromSel.innerHTML = ''; toSel.innerHTML = '';
        for (const u of Object.keys(cat.units)) { fromSel.appendChild(h('option', { value: u }, u)); toSel.appendChild(h('option', { value: u }, u)); }
        const keys = Object.keys(cat.units);
        fromSel.value = keys[2] || keys[0];
        toSel.value = keys[3] || keys[1] || keys[0];
        fire();
      }
      function tempConvert(v, from, to) {
        let c = v;
        if (from === '°F') c = (v - 32) * 5 / 9;
        else if (from === 'K') c = v - 273.15;
        let r = c;
        if (to === '°F') r = c * 9 / 5 + 32;
        else if (to === 'K') r = c + 273.15;
        return r;
      }
      function fire() {
        const cat = CATS[catSel.value];
        const v = parseFloat(valIn.value);
        resultEl.innerHTML = '';
        if (isNaN(v)) { resultEl.textContent = '请输入数值'; resultEl.style.color = 'var(--text-3)'; return; }
        let r;
        if (cat.special) r = tempConvert(v, fromSel.value, toSel.value);
        else r = v * cat.units[fromSel.value] / cat.units[toSel.value];
        const nice = Math.abs(r) >= 1e10 || (Math.abs(r) < 1e-6 && r !== 0) ? r.toExponential(6) : parseFloat(r.toPrecision(12)).toString();
        resultEl.style.color = 'var(--primary)';
        resultEl.textContent = `${v} ${fromSel.value} = ${nice} ${toSel.value}`;
      }
      catSel.addEventListener('change', fillUnits);
      fromSel.addEventListener('change', fire);
      toSel.addEventListener('change', fire);
      valIn.addEventListener('input', fire);
      page.appendChild(div('card', div('card-title', '换算'),
        div('form-row', h('span', { class: 'form-label' }, '类别'), catSel),
        div('form-row', h('span', { class: 'form-label' }, '数值'), valIn),
        div('form-row', h('span', { class: 'form-label' }, '从'), fromSel, iconSwap(), h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '到'), toSel,
          btn('⇄ 交换', 'btn-sm btn-secondary', () => { const t = fromSel.value; fromSel.value = toSel.value; toSel.value = t; fire(); })),
        resultEl));
      function iconSwap() { return h('span', { style: { color: 'var(--text-3)' } }, '→'); }
      fillUnits();
    }
  });

  /* ---------- 科学计算器 ---------- */
  register({
    id: 'calculator', name: '科学计算器', module: 'dev', icon: 'calculator',
    desc: '表达式计算，支持函数、常量与历史记录',
    keywords: ['计算器', '科学计算', '表达式', 'calc'],
    render(page) {
      const input = h('input', { class: 'input mono', placeholder: '输入表达式，如 sin(pi/4)+2^10*1.5', style: { flex: '1', fontSize: '15px' } });
      const result = div('');
      result.style.cssText = 'font-size:24px;font-weight:600;color:var(--primary);margin:10px 0;min-height:34px;user-select:text';
      const historyEl = div('');
      const fns = [
        ['sin', 'sin('], ['cos', 'cos('], ['tan', 'tan('], ['asin', 'asin('], ['log', 'log10('], ['ln', 'ln('],
        ['sqrt', 'sqrt('], ['abs', 'abs('], ['π', 'pi'], ['e', 'e'], ['^', '^'], ['(', '('], [')', ')']
      ];
      function evaluate(expr) {
        let e = expr
          .replace(/×/g, '*').replace(/÷/g, '/').replace(/，/g, ',')
          .replace(/\bpi\b/gi, 'Math.PI').replace(/\be\b/g, 'Math.E')
          .replace(/\b(sin|cos|tan|asin|acos|atan)\(/g, 'Math.$1(')
          .replace(/\blog10\(/g, 'Math.log10(').replace(/\blog\(/g, 'Math.log10(')
          .replace(/\bln\(/g, 'Math.log(')
          .replace(/\bsqrt\(/g, 'Math.sqrt(').replace(/\babs\(/g, 'Math.abs(')
          .replace(/\bceil\(/g, 'Math.ceil(').replace(/\bfloor\(/g, 'Math.floor(')
          .replace(/\bround\(/g, 'Math.round(')
          .replace(/\^/g, '**')
          .replace(/(\d+(?:\.\d+)?)%/g, '($1/100)');
        // 处理嵌套^: 简化处理 — 使用循环替换
        while (/\^\s*\(/.test(e)) e = e.replace(/\^\s*\(/g, '**(');
        e = e.replace(/\^/g, '**');
        // 阻止访问全局对象/危险函数（字符白名单无法区分标识符）
        if (/\b(document|location|window|globalThis|self|top|parent|alert|eval|Function|fetch|XMLHttpRequest|localStorage|sessionStorage|indexedDB|import|constructor|process|require|navigator|cookieStore)\b/i.test(e)) throw new Error('包含不允许的调用');
        // 安全检查
        if (!/^[-+*/%().,\d\sMathepowinaclsqrtbfgediupwinxomrPIE_,*]*$/i.test(e)) throw new Error('包含不允许的字符');
        const val = Function('"use strict"; return (' + e + ')')();
        if (typeof val !== 'number' || isNaN(val)) throw new Error('无法计算');
        return val;
      }
      function fmt(v) {
        if (!isFinite(v)) return v > 0 ? '∞' : '-∞';
        if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
        return parseFloat(v.toPrecision(12)).toString();
      }
      const history = [];
      function fire() {
        const t = input.value.trim();
        if (!t) { result.textContent = ''; return; }
        try {
          const v = evaluate(t);
          result.textContent = '= ' + fmt(v);
          history.unshift({ expr: t, val: '= ' + fmt(v) });
          if (history.length > 30) history.pop();
          renderHistory();
        } catch (err) {
          result.textContent = '';
          result.style.color = 'var(--danger)';
          result.textContent = '⚠ ' + (err.message.includes('不允许') ? err.message : '表达式有误');
          setTimeout(() => { result.style.color = 'var(--primary)'; }, 100);
        }
      }
      function renderHistory() {
        historyEl.innerHTML = '';
        if (!history.length) return;
        historyEl.appendChild(div('card-title', '历史记录'));
        for (const [i, item] of history.slice(0, 10).entries()) {
          const row = div('form-row', h('span', { class: 'mono', style: { flex: '1', userSelect: 'text', fontSize: '12px', color: 'var(--text-2)' } }, `${item.expr} ${item.val}`),
            btn('填入', 'btn-sm btn-text', () => { input.value = item.expr; fire(); }));
          historyEl.appendChild(row);
        }
      }
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') fire(); });
      input.addEventListener('change', fire);
      page.appendChild(div('card', div('card-title', '表达式'),
        div('form-row', input, btn('计算', 'btn-primary', fire)),
        div('form-row', ...fns.map(([n, v]) => btn(n, 'btn-sm btn-secondary', () => { input.value += v; input.focus(); }))),
        result));
      const hcard = div('card', historyEl);
      page.appendChild(hcard);
    }
  });
})();
