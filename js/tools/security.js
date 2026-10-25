/* 模块：安全与密码 —— 密码生成 / 强度检测 / 剪贴板历史 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, copyText, renderTable, fmtDate, switchEl } = window.ui;
  const { invoke } = window.api;
  const MOD = 'security';

  register({
    id: 'password-gen', name: '密码生成器', module: MOD, icon: 'key',
    desc: '自定义长度与字符集的高强度随机密码',
    keywords: ['密码', '随机', 'password'],
    render(page) {
      const lenIn = h('input', { type: 'number', class: 'input input-sm', value: '16', min: '4', max: '128', style: { width: '80px' } });
      const countIn = h('input', { type: 'number', class: 'input input-sm', value: '5', min: '1', max: '50', style: { width: '70px' } });
      const sets = [
        ['upper', '大写 A-Z', true], ['lower', '小写 a-z', true], ['digit', '数字 0-9', true],
        ['symbol', '符号 !@#$%', true], ['noAmbiguous', '排除易混淆 (0O1lI)', false]
      ];
      const boxes = sets.map(([id, label, checked]) => {
        const el = h('label', { class: 'field-hint', style: { marginRight: '12px' } }, h('input', { type: 'checkbox', class: 'checkbox', checked, dataset: { set: id } }), ' ' + label);
        return el;
      });
      const out = div('');
      function scorePwd(p) {
        let pool = 0;
        if (/[a-z]/.test(p)) pool += 26;
        if (/[A-Z]/.test(p)) pool += 26;
        if (/\d/.test(p)) pool += 10;
        if (/[^a-zA-Z0-9]/.test(p)) pool += 25;
        return Math.round(p.length * Math.log2(Math.max(pool, 2)));
      }
      function gen() {
        let chars = '';
        const get = (id) => boxes.find(b => b.querySelector('input').dataset.set === id).querySelector('input').checked;
        if (get('upper')) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        if (get('lower')) chars += 'abcdefghijklmnopqrstuvwxyz';
        if (get('digit')) chars += '0123456789';
        if (get('symbol')) chars += '!@#$%^&*()-_=+[]{};:,.<>?/~';
        if (get('noAmbiguous')) chars = [...chars].filter(c => !'0O1lI|`'.includes(c)).join('');
        if (!chars) { out.innerHTML = '<div class="field-err">请至少选择一种字符集</div>'; return; }
        const len = Math.min(128, Math.max(4, parseInt(lenIn.value) || 16));
        const n = Math.min(50, Math.max(1, parseInt(countIn.value) || 5));
        out.innerHTML = '';
        for (let i = 0; i < n; i++) {
          const arr = new Uint32Array(len);
          crypto.getRandomValues(arr);
          const pwd = [...arr].map(x => chars[x % chars.length]).join('');
          const strength = scorePwd(pwd);
          out.appendChild(div('form-row',
            h('span', { class: 'mono', style: { flex: '1', fontSize: '14px', userSelect: 'text' } }, pwd),
            strengthTag(strength),
            btn('复制', 'btn-sm btn-text', () => copyText(pwd))));
        }
      }
      function strengthTag(s) {
        const map = [[30, '弱', 'tag-red'], [50, '中', 'tag-orange'], [70, '强', 'tag-blue'], [Infinity, '极强', 'tag-green']];
        const [, name, cls] = map.find(([min]) => s < min) || map[3];
        return h('span', { class: 'tag ' + cls, style: { width: '44px', justifyContent: 'center' } }, name);
      }
      page.appendChild(div('card', div('card-title', '生成选项'),
        div('form-row', h('span', { class: 'form-label' }, '长度'), lenIn, h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '数量'), countIn),
        div('form-row', ...boxes)));
      page.appendChild(div('card', div('card-title', '密码列表'), btn('🎲 生成', 'btn-primary', gen), div('', out)));
      gen();
    }
  });

  register({
    id: 'password-strength', name: '密码强度检测', module: MOD, icon: 'shield',
    desc: '评估密码强度等级（熵值估算），给出优化建议',
    keywords: ['强度', '检测', '熵'],
    render(page) {
      const pwdIn = h('input', { type: 'text', class: 'input', placeholder: '输入要检测的密码（仅本地计算，不上传）', style: { flex: '1', fontSize: '16px' } });
      const bar = div('progress', div('progress-fill'));
      bar.style.margin = '12px 0';
      const level = h('div', { style: { fontWeight: 600, fontSize: '18px' } }, '');
      const suggestions = div('');
      const commonList = ['123456', 'password', '12345678', 'qwerty', '111111', '123123', 'abc123', '123456789', '1234567890', 'password1', 'admin', 'iloveyou', '000000', '666666', '888888', 'qwertyuiop', '1qaz2wsx', 'aa123456'];
      function analyze() {
        const p = pwdIn.value;
        suggestions.innerHTML = '';
        if (!p) { bar.firstChild.style.width = '0'; level.textContent = ''; return; }
        let pool = 0;
        if (/[a-z]/.test(p)) pool += 26;
        if (/[A-Z]/.test(p)) pool += 26;
        if (/\d/.test(p)) pool += 10;
        if (/[^a-zA-Z0-9]/.test(p)) pool += 33;
        let entropy = p.length * Math.log2(Math.max(pool, 2));
        const tips = [];
        if (commonList.includes(p.toLowerCase())) { entropy = Math.min(entropy, 10); tips.push('⚠ 这是常见弱密码，极易被字典破解'); }
        if (/^(.)\1+$/.test(p)) { entropy = Math.min(entropy, 8); tips.push('⚠ 全部字符相同'); }
        if (/^(012|123|234|345|456|567|678|789|abc|bcd|qwe|asd|zxc)/i.test(p)) { entropy *= 0.7; tips.push('⚠ 包含连续键盘/顺序序列'); }
        if (p.length < 8) tips.push('长度不足 8 位，建议至少 12 位');
        if (!/[A-Z]/.test(p)) tips.push('建议添加大写字母');
        if (!/\d/.test(p)) tips.push('建议添加数字');
        if (!/[^a-zA-Z0-9]/.test(p)) tips.push('建议添加特殊符号');
        if (/^\d+$/.test(p)) tips.push('纯数字密码建议改用混合字符');
        const pct = Math.min(100, entropy / 100 * 100);
        bar.firstChild.style.width = pct + '%';
        let lv, color;
        if (entropy < 35) { lv = '弱'; color = 'var(--danger)'; }
        else if (entropy < 60) { lv = '中'; color = 'var(--warning)'; }
        else if (entropy < 90) { lv = '强'; color = 'var(--primary)'; }
        else { lv = '极强'; color = 'var(--success)'; }
        level.textContent = `${lv}（熵约 ${Math.round(entropy)} bit）`;
        level.style.color = color;
        bar.firstChild.style.background = color;
        if (entropy >= 60) tips.unshift('✓ 暴力破解难度较高，可用于重要账户');
        const crackTime = estimateCrack(entropy);
        suggestions.appendChild(div('form-row', h('span', { class: 'field-hint' }, `暴力穷举估算（10¹¹ 次/秒 GPU 集群）：${crackTime}`)));
        for (const t of tips) suggestions.appendChild(div('form-row', h('span', { class: 'field-hint' }, t)));
      }
      function estimateCrack(bits) {
        const combos = Math.pow(2, bits) / 1e11;
        const seconds = combos;
        if (seconds < 1) return '瞬间破解';
        if (seconds < 3600) return Math.ceil(seconds / 60) + ' 分钟';
        if (seconds < 86400) return Math.ceil(seconds / 3600) + ' 小时';
        if (seconds < 86400 * 365) return Math.ceil(seconds / 86400) + ' 天';
        const years = seconds / 86400 / 365;
        if (years < 1e4) return Math.ceil(years) + ' 年';
        if (years < 1e8) return (years / 1e4).toFixed(1) + ' 万年';
        return (years / 1e8).toFixed(1) + ' 亿年';
      }
      pwdIn.addEventListener('input', window.ui.debounce(analyze, 200));
      page.appendChild(div('card', div('card-title', '密码'), div('form-row', pwdIn), bar, level, suggestions));
    }
  });

  register({
    id: 'clipboard-history', name: '剪贴板历史', module: MOD, icon: 'clipboard',
    desc: '自动记录文本/图片剪贴板历史，支持检索与一键复用',
    keywords: ['剪贴板', '历史', 'clipboard', '粘贴'],
    render(page) {
      const list = div('');
      const searchIn = h('input', { class: 'input input-sm', placeholder: '搜索历史…', style: { flex: '1' } });
      const watchSw = switchEl(false, (v) => { watching = v; if (v) poll(); else if (timer) clearTimeout(timer); });
      let watching = false, timer = null, lastClip = '';
      window.App.onCleanup(() => { watching = false; if (timer) { clearTimeout(timer); timer = null; } });
      let history = [];
      async function load() {
        history = await invoke('store:get', 'clipHistory', []);
        render();
      }
      async function poll() {
        if (!watching) return;
        try {
          const text = await invoke('clip:read-text');
          if (text && text !== lastClip) {
            lastClip = text;
            history.unshift({ type: 'text', content: text, time: Date.now() });
            history = history.slice(0, 200);
            await invoke('store:set', 'clipHistory', history);
            render();
          } else if (!text) {
            const img = await invoke('clip:read-image');
            if (img && img !== lastClip) {
              lastClip = img;
              // 图片落盘为文件，避免 dataURL 撑爆 store JSON
              let entry = { type: 'image', content: img, time: Date.now() };
              try { const r = await invoke('clip:save-image', img); entry = { type: 'image', file: r.path, time: Date.now() }; } catch (e) {}
              history.unshift(entry);
              history = history.slice(0, 100);
              await invoke('store:set', 'clipHistory', history);
              render();
            }
          }
        } catch (e) { /* browser */ }
        timer = setTimeout(poll, 1200);
      }
      function render() {
        const q = searchIn.value.trim().toLowerCase();
        list.innerHTML = '';
        const items = history
          .filter(x => !q || (x.type === 'text' && x.content.toLowerCase().includes(q)) || (x.type === 'image' && '图片 image 截图'.includes(q)))
          .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.time - a.time);
        if (!items.length) { list.appendChild(div('empty-tip', watching ? '暂无记录，复制点什么试试' : '开启上方开关开始记录剪贴板')); return; }
        for (const [i, item] of items.entries()) {
          const card = div('card');
          card.style.padding = '12px';
          card.style.border = '1px solid var(--border-light)';
          const head = div('form-row');
          head.appendChild(h('span', { class: 'tag ' + (item.type === 'text' ? 'tag-blue' : 'tag-green') }, item.type === 'text' ? '文本' : '图片'));
          if (item.pinned) head.appendChild(h('span', { class: 'tag tag-orange' }, '置顶'));
          head.appendChild(h('span', { class: 'field-hint' }, fmtDate(item.time)));
          const btns = h('span', { style: { marginLeft: 'auto' } });
          btns.appendChild(btn(item.pinned ? '取消置顶' : '置顶', 'btn-sm btn-text', async () => {
            item.pinned = !item.pinned;
            await invoke('store:set', 'clipHistory', history);
            render();
          }));
          const contentRef = item.content || null; // 图片：优先已有 dataURL，否则异步读文件
          btns.appendChild(btn(item.type === 'text' ? '复制' : '复制图片', 'btn-sm btn-text', async () => {
            try {
              if (item.type === 'text') await invoke('clip:write-text', item.content);
              else {
                let du = contentRef;
                if (!du && item.file) { const r = await invoke('fs:read-file-b64', item.file); du = 'data:image/png;base64,' + r.b64; }
                if (du) await invoke('clip:write-image', du);
              }
              toast('已复制', 'success', 1000);
            } catch (e) { toast(e.message, 'error'); }
          }));
          btns.appendChild(btn('删除', 'btn-sm btn-text', async () => {
            const idx = history.indexOf(item);
            history.splice(idx, 1);
            await invoke('store:set', 'clipHistory', history);
            render();
          }));
          head.appendChild(btns);
          card.appendChild(head);
          if (item.type === 'text') {
            const pre = h('div', { class: 'mono', style: { fontSize: '12px', color: 'var(--text-2)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '100px', overflow: 'hidden', userSelect: 'text' } },
              item.content.length > 500 ? item.content.slice(0, 500) + '…' : item.content);
            pre.addEventListener('dblclick', async () => { await invoke('clip:write-text', item.content); toast('已复制', 'success', 1000); });
            card.appendChild(pre);
          } else {
            const imgEl = h('img', { src: contentRef || '', style: { maxWidth: '100%', maxHeight: '160px', borderRadius: '6px', cursor: 'pointer' } });
            imgEl.addEventListener('click', async () => {
              try {
                let du = contentRef;
                if (!du && item.file) { const r = await invoke('fs:read-file-b64', item.file); du = 'data:image/png;base64,' + r.b64; }
                if (du) { await invoke('clip:write-image', du); toast('已复制', 'success', 1000); }
              } catch (e) {}
            });
            card.appendChild(imgEl);
            if (!contentRef && item.file) invoke('fs:read-file-b64', item.file).then((r) => { imgEl.src = 'data:image/png;base64,' + r.b64; }).catch(() => { card.appendChild(div('field-hint', '（图片文件已清理）')); });
          }
          list.appendChild(card);
        }
      }
      searchIn.addEventListener('input', render);
      const clearBtn = btn('清空历史', 'btn-sm btn-danger-plain', async () => {
        if (!(await window.ui.confirmBox({ title: '清空剪贴板历史', message: '确定清空全部剪贴板历史？', danger: true, okText: '清空' }))) return;
        history = [];
        await invoke('store:set', 'clipHistory', []);
        render();
      });
      page.appendChild(div('card', div('card-title', '控制'),
        div('form-row', h('span', { class: 'form-label' }, '自动记录'), watchSw, h('span', { class: 'field-hint' }, '开启后自动捕获复制的文本与图片（仅本机保存）')),
        div('form-row', searchIn, clearBtn)));
      page.appendChild(list);
      load();
    }
  });
})();
