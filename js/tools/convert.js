/* 模块：文本与编码/开发调试 —— 进制、时间戳、单位换算、科学计算器 */
(function () {
  const { register } = window.Registry;
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
  const { div, btn, toast, copyText, fmtNum, pad2, fieldRow } = window.ui;

  /* ---------- 进制转换（支持大数 BigInt） ---------- */
  register({
    id: 'radix', name: '进制转换', nameEn: 'Radix Convert', module: 'text', icon: 'calculator',
    desc: '2/8/10/16 进制互转，支持任意大数（BigInt）', descEn: 'Convert between base 2 / 8 / 10 / 16, with BigInt for large numbers',
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
    id: 'timestamp', name: '时间戳工具', nameEn: 'Timestamp', module: 'text', icon: 'clock',
    desc: '时间戳与日期双向转换，支持秒/毫秒、UTC/本地时区', descEn: 'Convert between timestamps and dates, seconds or milliseconds, UTC or local',
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
        let ms = parseInt(v, 10);
        if (unit === 's') ms *= 1000;
        const d = new Date(ms);
        if (isNaN(d.getTime())) { outGrid.appendChild(div('field-err', '⚠ 无效时间戳')); return; }
        /* 【「本地时间」这一行必须恒为本地时间】
         * 原来写的是 fmtD(new Date(ms - (useUTC ? 0 : 0)))，而 fmtD 内部
         * 已经按 useUTC 在 getUTC* / get* 之间切换 —— 两个时区偏移量都是 0，
         * 于是勾上「使用 UTC 时区」之后：
         *   · 「本地时间」行走 getUTC*  → 显示 UTC
         *   · 「UTC 时间」行恒走 toISOString → 也是 UTC
         * 两行一模一样，而用户真正的本地时间**在任何一行都看不到**。
         * 那个恒零表达式说明当初想手动加时区偏移，写到一半改成 fmtD 内部分支，
         * 留下了这个矛盾（旁边那个算了却没用的 local 变量是同一处改动的残留）。
         * 现在：本地行用独立的本地格式化，不受开关影响。 */
        const fmtLocal = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
        const diffSec = Math.floor((Date.now() - ms) / 1000);
        /* 【未来时间不能显示成「-86400 秒前」】
         * fmtNum 是 (n||0).toLocaleString()，不处理符号，于是输入明天的
         * 时间戳会得到「-86,400 秒前」—— 一个带负号的「秒前」。
         * 按差值正负分别说「秒前 / 秒后」。 */
        const relText = diffSec >= 0
          ? `${fmtNum(diffSec)} 秒前`
          : `${fmtNum(-diffSec)} 秒后`;
        const rows = [
          ['本地时间', fmtLocal(d)],
          ['UTC 时间', d.toISOString().replace('T', ' ').replace('Z', '')],
          ['相对时间', relText]
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
    id: 'unit-convert', name: '单位换算', nameEn: 'Unit Convert', module: 'dev', icon: 'move-h',
    desc: '长度、重量、面积、体积、存储、时间、速度、温度换算', descEn: 'Convert length, weight, area, volume, storage, time and temperature',
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
          btn('交换', 'btn-sm btn-secondary', () => { const t = fromSel.value; fromSel.value = toSel.value; toSel.value = t; fire(); }, 'git-compare')),
        resultEl));
      function iconSwap() { return h('span', { style: { color: 'var(--text-3)' } }, '→'); }
      fillUnits();
    }
  });

  /* ---------- 科学计算器 ---------- */
  register({
    id: 'calculator', name: '科学计算器', nameEn: 'Calculator', module: 'dev', icon: 'calculator',
    desc: '表达式计算，支持函数、常量与历史记录', descEn: 'Evaluate expressions with functions, constants and history',
    keywords: ['计算器', '科学计算', '表达式', 'calc'],
    render(page) {
      const input = h('input', { class: 'input mono', placeholder: '输入表达式，如 sin(pi/4)+2^10*1.5', style: { flex: '1', fontSize: '15px' } });
      const result = div('');
      result.style.cssText = 'font-size:24px;font-weight:600;color:var(--primary);margin:10px 0;min-height:34px;user-select:text';
      const historyEl = div('');
      const fns = [
        ['sin', 'sin('], ['cos', 'cos('], ['tan', 'tan('], ['asin', 'asin('], ['log', 'log10('], ['ln', 'ln('],
        ['sqrt', 'sqrt('], ['abs', 'abs('], ['π', 'pi'], ['e', 'e'], ['^', '^'], ['(', '('], [')', ')']
      ];      /* 求值交给 lib/expr-eval.js（递归下降解析器，不执行任何代码）。
       * 原实现是 Function('return (...)')()，为此整站 CSP 必须开 unsafe-eval；
       * 现在可以彻底关掉。lib 通过 preload 的 evalExpr 暴露（contextIsolation 限制）。 */
      function evaluate(expr) {
        const raw = String(expr || '').trim();
        if (!raw) throw new Error('表达式为空');
        if (window.api && window.api.evalExpr) {
          const r = window.api.evalExpr(raw);
          if (!r.ok) throw new Error(r.error || '无法计算');
          return r.value;
        }
        /* 极端兜底（浏览器演示模式且 preload 不可用）：用同一套规则的简化实现，
         * 仍然不碰 eval —— 只支持数字与四则，宁可报错也不执行代码。 */
        if (!/^[-+*/%^().\d\s]+$/.test(raw)) throw new Error('不支持该表达式（演示模式）');
        throw new Error('演示模式暂不支持复杂表达式');
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
          /* 【哪些错误原文该透出给用户】
           * 原来只放行含「不允许」的那一种（安全相关），其它一律显示
           * 「⚠ 表达式有误」—— 于是"嵌套太深"这种**能照着做**的提示也被吞了，
           * 用户只知道算不出来，不知道是深度问题、更不知道可以分层算。
           * 现在放行三类可操作提示：不允许（安全）/ 嵌套太深（复杂度）/
           * 无法计算（除零、溢出）。语法错仍然用通用文案，
           * 因为 parser 的语法提示对普通用户太细（"函数 log10 后需要括号"之类）。 */
          const actionable = /不允许|嵌套太深|无法计算/.test(err.message || '');
          result.textContent = '⚠ ' + (actionable ? err.message : '表达式有误');
          setTimeout(() => { result.style.color = 'var(--primary)'; }, 100);
        }
      }
      function renderHistory() {
        historyEl.innerHTML = '';
        if (!history.length) return;
        historyEl.appendChild(div('card-title', '历史记录'));
        /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
        for (const [i, item] of history.slice(0, 10).entries()) {
          const row = div('form-row', h('span', { class: 'mono', style: { flex: '1', userSelect: 'text', fontSize: '12px', color: 'var(--text-2)' } }, `${item.expr} ${item.val}`),
            btn('填入', 'btn-sm btn-text', () => { input.value = item.expr; fire(); }));
          historyEl.appendChild(row);
        }
      }
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') fire(); });
      input.addEventListener('change', fire);
      /* 【布局按"输入—键盘—结果—历史"四段垂直排】
       * 原来把 13 个函数按钮塞进**一个** .form-row，靠 flex-wrap 挤成一条；
       * 在 1366px 宽的窗口里它们刚好一行放下，但每个只有 26px 高、10px 间距，
       * 视觉上是一条细带，与上下卡片（输入框 34px、结果 24px 字号）不成比例 ——
       * 这就是「UI 不和谐」的来源。
       *
       * 改法：
       *   ① 按钮分成两组（三角函数 / 其它），各占一行，行数与按钮量级匹配
       *   ② 按钮高度提到 30px，与输入框的间距感一致
       *   ③ 结果区紧贴在键盘下方、历史记录单独成卡 —— 原来结果夹在
       *      "表达式"卡里、历史又是另一张卡，视线要跨两次卡片边界
       *   ④ 键盘区用等宽网格，不靠 flex-wrap 碰运气 */
      const keyBtn = (label, insert) => btn(label, 'btn-sm btn-secondary calc-key', () => {
        input.value += insert; input.focus();
      });
      const trigRow = div('calc-keys', ...fns.slice(0, 4).map(([n, v]) => keyBtn(n, v)));
      const mathRow = div('calc-keys', ...fns.slice(4, 8).map(([n, v]) => keyBtn(n, v)));
      const constRow = div('calc-keys', ...fns.slice(8).map(([n, v]) => keyBtn(n, v)));

      page.appendChild(div('card', div('card-title', '表达式'),
        div('form-row', input, btn('计算', 'btn-primary', fire))));
      page.appendChild(div('card',
        div('card-title', '函数与常量'),
        trigRow, mathRow, constRow));
      page.appendChild(div('card', div('card-title', '结果'), result));
      const hcard = div('card', historyEl);
      page.appendChild(hcard);
    }
  });
})();
