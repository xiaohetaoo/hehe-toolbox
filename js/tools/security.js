/* 模块：安全与密码 —— 密码生成 / 强度检测 / 剪贴板历史 */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
  const { div, btn, toast, copyText, renderTable, fmtDate, switchEl } = window.ui;
  const { invoke } = window.api;
  const MOD = 'security';

  register({
    id: 'password-gen', name: '密码生成器', nameEn: 'Password Generator', module: MOD, icon: 'key',
    desc: '自定义长度与字符集的高强度随机密码', descEn: 'Generate strong random passwords with custom length and character sets',
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
          /* 【消除取模偏差】x % chars.length 会让靠前的字符出现概率略高：
           * 2^32 不能被字符集长度整除时，余数小的那几个字符多出一次机会。
           * 虽然差异很小，但这是「安全与密码」模块，不该有已知偏差。
           * 用拒绝采样：只接受落在「可整除区间」内的随机数，否则重新取。
           * 字符集常见长度（62/87 等），被拒概率 < 1/10^7，性能无影响。 */
          const cLen = chars.length;
          const limit = Math.floor(0x100000000 / cLen) * cLen; // 可整除的上界
          /* 【变量名不能叫 out】
           * 外层 `const out = div('')` 是结果容器；这里再声明 `const out = []`
           * 会把它遮蔽掉，循环结束后 `out.appendChild(...)` 就变成
           * 「对数组调 appendChild」→ TypeError。
           * 后果很具体：点「生成」毫无反应、控制台只有一行报错，
           * 密码一个都生成不出来 —— 这个工具从写下这段代码起就是坏的。
           * 改名 buf，并在循环里直接往容器追加行。 */
          const buf = [];
          while (buf.length < len) {
            const arr = new Uint32Array(len - buf.length);
            crypto.getRandomValues(arr);
            for (const x of arr) {
              if (x < limit) buf.push(chars[x % cLen]);
              else { /* 落在偏差区，丢弃重取 */ }
              if (buf.length >= len) break;
            }
          }
          const pwd = buf.join('');
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
      page.appendChild(div('card', div('card-title', '密码列表'), btn('生成', 'btn-primary', gen, 'dice'), div('', out)));
      gen();
    }
  });

  register({
    id: 'password-strength', name: '密码强度检测', nameEn: 'Password Strength', module: MOD, icon: 'shield',
    desc: '评估密码强度等级（熵值估算），给出优化建议', descEn: 'Estimate password strength and see what to improve',
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
        /* 用对数分档：直接 Math.pow(2, bits) 在 1024 bit 以上会溢出成 Infinity
           （输入 157 位以上混合字符就会触发），显示「Infinity 亿年」；
           即使用 64 位这种常见长密码，也会给出「1.9e50 亿年」这种没法读的数字。 */
        const log10Seconds = bits * Math.LN2 / Math.LN10 - 11;
        if (log10Seconds < 0) return '瞬间破解';
        // 约 1.4e14 年 ≈ 宇宙年龄的 1 万倍，再往上给个上限文案即可
        const MAX_LOG10_SECONDS = Math.log10(1.4e14 * 86400 * 365);
        if (log10Seconds > MAX_LOG10_SECONDS) return '远超宇宙年龄';
        const seconds = Math.pow(10, log10Seconds);
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
    id: 'clipboard-history', name: '剪贴板历史', nameEn: 'Clipboard History', module: MOD, icon: 'clipboard',
    desc: '自动记录文本/图片剪贴板历史，支持检索与一键复用', descEn: 'Keep a searchable history of copied text and images, filter by type',
    keywords: ['剪贴板', '历史', 'clipboard', '粘贴'],
    render(page) {
      const list = div('');
      const searchIn = h('input', { class: 'input input-sm', placeholder: '搜索历史…', style: { flex: '1' } });
      /* 类型筛选。
       * 【第一版只有 全部/文本/图片 三档，仍然不够用】
       * 用户的实际诉求是"我想找上次复制的那段 JSON"或"那个网址"。
       * 只分文本/图片时，上百条文本混在一起，搜索还得记得关键字。
       * 所以把文本再细分，判据直接复用 lib/clip-analyze.js —— 它本来
       * 就是"内容 → 类型"的唯一实现，这里不另写一套正则（否则两处
       * 判定规则必然漂移）。增加的档位：网址 / JSON / 代码（哈希·JWT·颜色）。
       * 图片与其它保持不变。 */
      let typeFilter = 'all'; // all | text | image | url | json | misc
      /* 每条文本的类型缓存：同一份历史在多次 render 之间反复分类很浪费，
       * 而分类要跑 JSON.parse（大 JSON 更贵）。用 WeakMap 挂在条目对象上，
       * 条目被淘汰时缓存跟着回收，不会泄漏。 */
      const kindCache = new WeakMap();
      function kindOf(item) {
        if (item.type === 'image') return 'image';
        const hit = kindCache.get(item);
        if (hit) return hit;
        let k = 'text';
        try {
          const C = window.ClipAnalyze;
          if (C) {
            const r = C.analyze({ text: item.content || '' });
            if (r.kind === 'url') k = 'url';
            else if (r.kind === 'json') k = 'json';
            else if (r.kind === 'hash' || r.kind === 'jwt' || r.kind === 'color' || r.kind === 'timestamp') k = 'misc';
          }
        } catch (e) { /* 分类失败就当普通文本 */ }
        kindCache.set(item, k);
        return k;
      }
      const typeBtns = {};
      function makeTypeBtn(key, label) {
        const b = btn(label, 'btn-sm btn-secondary', () => {
          typeFilter = key;
          for (const [k, el] of Object.entries(typeBtns)) el.className = 'btn btn-sm ' + (k === key ? 'btn-primary' : 'btn-secondary');
          render();
        });
        typeBtns[key] = b;
        return b;
      }
      const watchSw = switchEl(false, (v) => { watching = v; if (v) poll(); else if (timer) clearTimeout(timer); });
      /* ---- 敏感内容自动过期 ----
       * 开关状态落在 settings.clipSensitiveTtl（分钟，0 = 关闭）。
       * 用分钟数而不是布尔：以后想加"30 分钟/1 小时/1 天"三档只改常量表，
       * 不用再加一个键。 */
      const SENSITIVE_TTL_MIN = 10;
      const sensitiveSw = switchEl(false, async (v) => {
        sensitiveTtl = v ? SENSITIVE_TTL_MIN : 0;
        try { await invoke(Channels.CHANNELS.STORE.SET, 'settings.clipSensitiveTtl', sensitiveTtl); } catch (e) {}
        if (v) sweepSensitive();
        render();
      });
      let sensitiveTtl = 0;
      /* 载入用户的开关状态 */
      invoke(Channels.CHANNELS.STORE.GET, 'settings.clipSensitiveTtl', 0).then((v) => {
        sensitiveTtl = Number(v) || 0;
        /* 【必须走 set() 而不是 classList.add('on')】switchEl 的状态有两份：
         * class 'on'（视觉）与 aria-checked（读屏）。只改 class 的话，
         * 开关看起来是开的，读屏却播报「已关闭」—— 两份状态从此分叉，
         * 用户下一次点击的 toggle 结果也与预期相反。set() 一次同步两份。 */
        try { if (sensitiveTtl > 0) sensitiveSw.set(true); } catch (e) {}
      }).catch(() => {});
      /* 敏感内容的形态判据在 lib/sensitive.js —— 抽到 lib 是为了能在
       * Node 里直接单测（写在这里就只能靠真机 E2E，而 E2E 在 CI 会 SKIP，
       * 等于这条判据没有守卫）。判据的取舍原则见那个文件的说明。
       *
       * 这里不另包一层 isSensitive：sweepSensitive 直接调 S.pickExpired，
       * 那是同一个文件里的纯函数，已经包含"判敏感 + 判过期 + 尊重置顶"三件事。 */
      /* 清掉过期的敏感条目。返回删掉几条（0 表示没动，不写盘）。 */
      async function sweepSensitive() {
        if (!(sensitiveTtl > 0)) return 0;
        const S = window.Sensitive;
        if (!S || !S.pickExpired) return 0;
        const r = S.pickExpired(history, { ttlMinutes: sensitiveTtl, now: Date.now() });
        if (!r.drop.length) return 0;
        history = r.keep;
        await dropImages(r.drop);
        await invoke(Channels.CHANNELS.STORE.SET, 'clipHistory', history);
        try { toast('已自动清理 ' + r.drop.length + ' 条敏感记录（超过 ' + sensitiveTtl + ' 分钟）', 'info', 3000); } catch (e) {}
        return r.drop.length;
      }
      let watching = false, timer = null, lastClip = '';
      window.App.onCleanup(() => { watching = false; if (timer) { clearTimeout(timer); timer = null; } });
      let history = [];
      /* 【两条裁剪路径必须共用同一个上限】
       * 原来文本路径写 `history.slice(0, 200)`、图片路径调 `trimHistory(history, 100)`
       * —— 截一张图就可能把整条历史（含文本）从 200 砍到 100，用户没做任何"清理"操作
       * 却丢掉一半记录，而且这种缩水完全无声。
       * 另外文本那条没走 trimHistory，于是被挤出的图片条目对应的
       * clip-img/*.png 永远不会被回收，文件无限堆积。 */
      /* 【上限现在可配置】设置 → 通用 → 剪贴板历史条数（50~1000）。
       * 用函数而不是常量：用户在设置页改完，回到这个工具页就该按新值裁剪，
       * 而常量在模块加载时就定死了，改完必须重启才生效。
       * 取不到（极端时序）时 Prefs.get 会返回规格里的默认值 200，不会 undefined。 */
      function historyLimit() {
        const v = window.Prefs && window.Prefs.get('clipHistoryLimit');
        return (typeof v === 'number' && v > 0) ? v : 200;
      }
      // 删除条目时连带删掉它落盘的图片文件（否则 clip-img 会无限堆积）
      async function dropImages(entries) {
        const files = (entries || []).filter(x => x && x.type === 'image' && x.file).map(x => x.file);
        if (!files.length) return;
        try { await invoke(Channels.CHANNELS.CLIP.REMOVE_IMAGES, files); } catch (e) {}
      }
      /* 按统一上限裁剪：**任何**被淘汰的条目（文本或图片）都先走 dropImages，
       * 再截断。这样「文本把图片挤出列表」时对应的 png 也会被回收。 */
      /* eslint-disable-next-line no-shadow -- 历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响） */
      async function trimHistory(list) {
        const cap = historyLimit();
        if (list.length <= cap) return list;
        const dropped = list.slice(cap);
        await dropImages(dropped);
        return list.slice(0, cap);
      }
      async function load() {
        history = await invoke(Channels.CHANNELS.STORE.GET, 'clipHistory', []);
        /* 每次进页面先扫一次过期敏感条目 —— 用户可能几天没打开这个工具，
         * 期间过期的凭据一直躺在磁盘上。 */
        try { await sweepSensitive(); } catch (e) {}
        render();
      }
      // 单条文本上限：条数 × 单条体积决定 hehe-data.json 的大小，而 store 是
      // 整文件 JSON.stringify + 同步写盘，单条太大时卡死的不只是剪贴板功能。
      // 超出部分只保留开头用于检索、并在界面上标注"已截断"？不——截断后复制
      // 会给用户错误内容，所以超长条目干脆不入库，只提示一次。
      // 【现在可配置】设置 → 通用 → 单条剪贴板上限（16~4096 KB）。
      function textLimitBytes() {
        const kb = window.Prefs && window.Prefs.get('clipTextLimitKB');
        const n = (typeof kb === 'number' && kb > 0) ? kb : 256;
        return n * 1024;
      }
      let limitWarned = false;
      /* 【上限必须按字节判，不能按字符串长度】
       * 设置项与函数名都写着「KB（字节）」，而 String.length 是 UTF-16
       * 码元数。中文场景下 1 个 length 单位 = 3 字节（UTF-8，且 JSON.stringify
       * 不转义中文），所以 limit = kb*1024 与实际占用最多差 3 倍 ——
       * 设 256KB 时历史库单条能涨到约 768KB，而这条上限存在的全部意义
       * 就是「别让 store 的整文件 JSON.stringify 卡住」。
       *
       * 【先做廉价预筛，再精确测量】
       * TextEncoder 要把整串走一遍；而这个函数在 1.2 秒一次的轮询里
       * 每条新剪贴板内容都会调一次。UTF-8 每码元最多 3 字节
       * （BMP 内 3 字节；星形平面按代理对算 2 个码元 / 4 字节，比值 2），
       * 所以 length * 3 <= limit 时**必然**不超限，可以直接放行，
       * 省掉绝大多数正常文本的编码开销。 */
      function utf8Bytes(text) {
        const s = String(text == null ? '' : text);
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
        /* 极老环境兜底：按码元粗估，宁可多算不漏算。 */
        return s.length * 3;
      }
      function admitText(text) {
        const limit = textLimitBytes();
        if (text.length * 3 <= limit) return text;   // 廉价预筛：必然不超
        if (utf8Bytes(text) <= limit) return text;
        if (!limitWarned) {
          limitWarned = true;
          try { toast(`单条文本超过 ${Math.round(limit / 1024)}KB，已跳过记录（避免历史库撑爆）`, 'warn', 4000); } catch (e) {}
        }
        return null;
      }
      async function poll() {
        if (!watching) return;
        try {
          const text = await invoke(Channels.CHANNELS.CLIP.READ_TEXT);
          if (text && text !== lastClip) {
            lastClip = text;
            const okText = admitText(text);
            if (okText === null) { timer = setTimeout(poll, 1200); return; }
            history.unshift({ type: 'text', content: okText, time: Date.now() });
            /* 必须走 trimHistory：它会回收被挤出上限的图片文件。
             * 直接 slice(0, 200) 会让图片条目"消失但文件还在"。 */
            history = await trimHistory(history);
            await invoke(Channels.CHANNELS.STORE.SET, 'clipHistory', history);
            render();
          } else if (!text) {
            const img = await invoke(Channels.CHANNELS.CLIP.READ_IMAGE);
            if (img && img !== lastClip) {
              lastClip = img;
              // 图片落盘为文件，避免 dataURL 撑爆 store JSON
              let entry = { type: 'image', content: img, time: Date.now() };
              try { const r = await invoke(Channels.CHANNELS.CLIP.SAVE_IMAGE, img); entry = { type: 'image', file: r.path, time: Date.now() }; } catch (e) {}
              history.unshift(entry);
              history = await trimHistory(history);
              await invoke(Channels.CHANNELS.STORE.SET, 'clipHistory', history);
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
          .filter(x => typeFilter === 'all' || kindOf(x) === typeFilter)
          .filter(x => !q || (x.type === 'text' && x.content.toLowerCase().includes(q)) || (x.type === 'image' && '图片 image 截图'.includes(q)))
          .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.time - a.time);
        if (!items.length) {
          // 有筛选条件时不能说"暂无记录"——记录其实有，只是被筛掉了，
          // 否则用户会以为历史丢了
          const filtered = typeFilter !== 'all' || q;
          list.appendChild(div('empty-tip', filtered
            ? '没有符合当前筛选的记录'
            : (watching ? '暂无记录，复制点什么试试' : '开启上方开关开始记录剪贴板')));
          return;
        }
        /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
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
            await invoke(Channels.CHANNELS.STORE.SET, 'clipHistory', history);
            render();
          }));
          const contentRef = item.content || null; // 图片：优先已有 dataURL，否则异步读文件
          btns.appendChild(btn(item.type === 'text' ? '复制' : '复制图片', 'btn-sm btn-text', async () => {
            try {
              if (item.type === 'text') await invoke(Channels.CHANNELS.CLIP.WRITE_TEXT, item.content);
              else {
                let du = contentRef;
                if (!du && item.file) { const r = await invoke(Channels.CHANNELS.FS.READ_FILE_B64, item.file); du = 'data:image/png;base64,' + r.b64; }
                if (du) await invoke(Channels.CHANNELS.CLIP.WRITE_IMAGE, du);
              }
              toast('已复制', 'success', 1000);
            } catch (e) { toast(e.message, 'error'); }
          }));
          btns.appendChild(btn('删除', 'btn-sm btn-text', async () => {
            const idx = history.indexOf(item);
            if (idx >= 0) history.splice(idx, 1);
            await dropImages([item]);
            await invoke(Channels.CHANNELS.STORE.SET, 'clipHistory', history);
            render();
          }));
          head.appendChild(btns);
          card.appendChild(head);
          if (item.type === 'text') {
            const pre = h('div', { class: 'mono', style: { fontSize: '12px', color: 'var(--text-2)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '100px', overflow: 'hidden', userSelect: 'text' } },
              item.content.length > 500 ? item.content.slice(0, 500) + '…' : item.content);
            pre.addEventListener('dblclick', async () => { await invoke(Channels.CHANNELS.CLIP.WRITE_TEXT, item.content); toast('已复制', 'success', 1000); });
            card.appendChild(pre);
          } else {
            const imgEl = h('img', { src: contentRef || '', style: { maxWidth: '100%', maxHeight: '160px', borderRadius: '6px', cursor: 'pointer' } });
            /* 点图片 = 把这张图重新写回剪贴板，这是图片条目**唯一**的操作入口。
             * 不接键盘的话，纯键盘用户能看见历史图片却一张都复用不了。 */
            imgEl.addEventListener('click', async () => {
              try {
                let du = contentRef;
                if (!du && item.file) { const r = await invoke(Channels.CHANNELS.FS.READ_FILE_B64, item.file); du = 'data:image/png;base64,' + r.b64; }
                if (du) { await invoke(Channels.CHANNELS.CLIP.WRITE_IMAGE, du); toast('已复制', 'success', 1000); }
              } catch (e) {}
            });
            if (window.ui.makeButtonLike) window.ui.makeButtonLike(imgEl, '复制这张历史图片');
            if (window.ui.focusable) window.ui.focusable(imgEl);
            card.appendChild(imgEl);
            if (!contentRef && item.file) invoke(Channels.CHANNELS.FS.READ_FILE_B64, item.file).then((r) => { imgEl.src = 'data:image/png;base64,' + r.b64; }).catch(() => { card.appendChild(div('field-hint', '（图片文件已清理）')); });
          }
          list.appendChild(card);
        }
      }
      searchIn.addEventListener('input', render);
      const clearBtn = btn('清空历史', 'btn-sm btn-danger-plain', async () => {
        if (!(await window.ui.confirmBox({ title: '清空剪贴板历史', message: '确定清空全部剪贴板历史？图片文件也会一并删除。', danger: true, okText: '清空' }))) return;
        const old = history.slice();
        history = [];
        await invoke(Channels.CHANNELS.STORE.SET, 'clipHistory', []);
        await dropImages(old);
        render();
      });
      page.appendChild(div('card', div('card-title', '控制'),
        div('form-row', h('span', { class: 'form-label' }, '自动记录'), watchSw, h('span', { class: 'field-hint' }, '开启后自动捕获复制的文本与图片（仅本机保存）')),
        /* 筛选按钮从三个扩到六个：文本太笼统，用户找的是"那段 JSON"或"那个网址"。
         * 分类判据复用 lib/clip-analyze.js 的 analyze()，与剪贴板动作面板
         * 用的是同一套规则 —— 两处规则必须一致，否则同样一段内容
         * 在面板里叫"网址"、在历史里被归到"文本"，用户会困惑。 */
        div('form-row', searchIn,
          makeTypeBtn('all', '全部'), makeTypeBtn('text', '文本'),
          makeTypeBtn('image', '图片'), makeTypeBtn('url', '网址'),
          makeTypeBtn('json', 'JSON'), makeTypeBtn('misc', '哈希/令牌/颜色'),
          clearBtn),
        /* ---- 敏感内容自动过期 ---- */
        /* 【为什么需要】
         * 剪贴板历史会把用户复制的密码、密钥、身份证号一并存进一个
         * 明文的 hehe-data.json，而且默认永不清理。这是真实风险，
         * 不是"可能有点不安全"。
         *
         * 【为什么不默认开启】默认开启会让"10 分钟前复制的东西不见了"
         * 变成困惑；而且识别敏感内容总有误判。默认关闭、由用户主动打开，
         * 并把"哪些会被清掉"写清楚，比偷偷删更可信。
         *
         * 【判据：两类】看内容形态（密码/密钥/token/私钥块/证件号），
         * 以及"用户在密码框里复制的"（拿不到来源，只能看内容）。 */
        div('form-row',
          h('span', { class: 'form-label' }, '敏感内容自动清理'),
          sensitiveSw,
          h('span', { class: 'field-hint' }, '开启后，形如密码/密钥/令牌的记录 ' + SENSITIVE_TTL_MIN + ' 分钟后自动删除'))));
      page.appendChild(list);
      load();
    }
  });
})();
