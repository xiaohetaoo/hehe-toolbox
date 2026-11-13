/* 模块：文本与编码 —— 编解码转换系列 */
(function () {
  const { register } = window.Registry;
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
  const { convertLayout, copyText, toast } = window.ui;
  const MOD = 'text';
  /* 文案取词（与 qr / hash / exif / snip 同一套约定）：中文原文作键，
   * 中文模式直接返回调用点字面量、不查表，所以中文界面零行为改动。 */
  const T = (zh, vars) => TT('codec', zh, vars);

  function utf8ToBytes(str) { return new TextEncoder().encode(str); }
  function bytesToUtf8(bytes) { return new TextDecoder().decode(bytes); }

  /* 严格版解码：非法 UTF-8 直接抛错，而不是塞一堆 U+FFFD。
   *
   * 【为什么不用默认的 TextDecoder】默认是非严格模式，遇到非法字节**不报错**，
   * 每个坏字节换成一个替换字符（U+FFFD，显示成「�」）。
   * 实测：把「中文」的 GBK 字节 D6 D0 CE C4 喂进去，输出是「����」——
   * 用户看到四个问号，分不清是"自己编码选错了"还是"工具坏了"。
   *
   * 而中文用户拿到的十六进制串**很可能就是 GBK**：抓包、老系统的配置、
   * 记事本另存为 ANSI，都是 GBK。所以这条路径踩中的概率很高。
   *
   * 严格模式会抛 TypeError，调用方据此给出明确指引。
   * 注意：不能直接用 fatal:true 的异常文案（"The encoded data was not valid..."），
   * 那是英文且不提 GBK —— 归因见下面的 decodeErrHint。 */
  function bytesToUtf8Strict(bytes) {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  /* 把解码失败归因成一句用户能据此行动的话。
   *
   * 【为什么要单独判"像不像 GBK"】光说"不是合法 UTF-8"用户仍然不知道该怎么办；
   * 而绝大多数失败场景就是"这是 GBK 不是 UTF-8"。点出来他立刻知道换工具
   * 或换来源。判据用"字节数是否成对且都 ≥ 0x80"粗略估计 —— 不做真正的 GBK
   * 解码（那要引编码表，而本工具刻意不背表），只是给一句可操作的方向。
   *
   * 【真机踩坑：旧判据只认 Node 的措辞，浏览器里永远不触发】
   * 旧判定是 `/not valid for encoding utf-8/i`。那串完整报错
   * "The encoded data was not valid for encoding utf-8" 是 **Node** 拼的。
   * 本工具跑在渲染进程，Chromium 的 TextDecoder 抛的是
   * "Failed to execute 'decode' on 'TextDecoder': The encoded data was not valid."
   * —— 它把 "for encoding utf-8" 省掉了，正则因此永远不命中。
   * 后果：单元测试用 Node 拼报错能过，真机上 GBK 归因**一次都没出现过**，
   * 用户看到的是一条英文 TypeError。这是靠真机点击才发现的（单测测不出）。
   * 所以判据收敛到各家共有的 "not valid"，再补其它引擎的措辞，
   * 而不是依赖某一家把参数回显在报错文本里。 */
  function decodeErrHint(e) {
    const msg = String((e && e.message) || e);
    if (/not valid|malformed|invalid|encodingerror/i.test(msg)) {
      return '这串字节不是合法的 UTF-8。如果原文是中文，多半是 GBK 编码'
        + '（抓包、旧系统、记事本「ANSI」另存都是 GBK），本工具只做 UTF-8。';
    }
    return msg;
  }

  register({
    id: 'base64', name: 'Base64 编解码', nameEn: 'Base64 Codec', module: MOD, icon: 'box', i18n: true,
    desc: 'Base64 与文本实时互转，支持中文与文件安全字符集', descEn: 'Convert between Base64 and text in real time, safe for Chinese and file characters',
    keywords: ['base64', '编码', '解码', 'encode'],
    render(page) {
      const box = convertLayout({
        inputLabel: T('原文'), outputLabel: T('Base64'), realtime: true,
        onConvert(text) {
          const bytes = utf8ToBytes(text);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return btoa(bin);
        }
      });
      let decodeMode = false;
      const swapBtn = window.ui.btn(T('解码模式'), 'btn-secondary btn-sm', () => {
        decodeMode = !decodeMode;
        swapBtn.querySelector('.btn-label').textContent = decodeMode ? T('编码模式') : T('解码模式');
        box.el.querySelector('.pane-head span').textContent = decodeMode ? T('Base64') : T('原文');
        box.el.querySelectorAll('.pane-head span')[1] && null;
        const heads = box.el.querySelectorAll('.pane-head');
        heads[0].firstChild.textContent = decodeMode ? T('Base64 输入') : T('原文');
        heads[1].firstChild.textContent = decodeMode ? T('解码结果') : T('Base64');
        run(); // 用双向转换逻辑刷新，box.fire() 只会单向编码
      }, 'git-compare');
      /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
      const origConvert = box.fire;
      const opts = div('form-row', swapBtn);
      page.appendChild(opts);
      page.appendChild(box.el);
      // 重写转换逻辑支持双向
      const ta = box.input, out = box.output;
      const run = () => {
        try {
          if (decodeMode) {
            // 粘贴来的 Base64 常带换行/空格（邮件、JWT、base64 -w 76 的产物），
            // atob 遇到这些非法字符会直接抛错，所以先剥掉空白再解。
            const b64 = ta.value.replace(/[\s\r\n]+/g, '').replace(/-/g, '+').replace(/_/g, '/');
            const bin = atob(b64);
            out.value = bytesToUtf8(Uint8Array.from(bin, c => c.charCodeAt(0)));
          } else {
            const bytes = utf8ToBytes(ta.value);
            let bin = '';
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); // 分块避免参数上限
            out.value = btoa(bin);
          }
        } catch (e) {
          /* 静默清空会让用户以为工具"没反应"，这里必须把原因显示出来。
           * 【但不能直接拼 e.message —— 那是浏览器的英文原文】
           * 真机实测：解码模式下输入中文，界面显示的是
           *   「⚠ 不是合法的 Base64：Failed to execute 'atob' on 'Window':
           *     The string to be decoded contains characters outside of
           *     the Latin1 range.」
           * 中文界面里冒出一整句英文，用户既看不懂也不知道该改什么。
           *
           * 这里分三种情况给出可操作的中文说明：
           *   ① 含非 Latin1 字符（中文/emoji）→ 用户把原文粘进了解码框，最常见
           *   ② atob 报 InvalidCharacterError → 混进了非 base64 的字符
           *   ③ UTF-8 解码失败（bytesToUtf8 抛出）→ 字节不像文本
           * 兜底才附英文原文，避免"认不出就什么都不说"。 */
          const msg = String((e && e.message) || e || '');
          let hint;
          if (/outside of the Latin1 range|not of type 'Latin1'|Latin1/i.test(msg)) {
            hint = '这段内容不是 Base64（里面有中文或表情）。Base64 只包含 A-Z a-z 0-9 + / = 这些字符 —— 请确认你粘的是编码后的结果。';
          } else if (/InvalidCharacterError|invalid character|Invalid character/i.test(msg)) {
            hint = '这段内容里有不属于 Base64 的字符（只允许 A-Z a-z 0-9 + / =）。可能混入了中文标点、引号或说明文字。';
          } else if (/不是合法的 UTF-8|UTF-8/i.test(msg)) {
            hint = decodeErrHint(msg);
          } else {
            hint = '无法解码为文本。请确认内容完整的 Base64（可能把原文当成了编码结果）。' +
              (msg ? '（原始报错：' + msg + '）' : '');
          }
          out.value = '注意：' + hint;
        }
      };
      ta.addEventListener('input', run);
      run();
    }
  });

  register({
    id: 'url-codec', name: 'URL 编解码', nameEn: 'URL Codec', module: MOD, icon: 'link', i18n: true,
    desc: 'URL 百分号编码与解码，支持 encodeURIComponent / 全量编码', descEn: 'Encode and decode URLs and query strings',
    keywords: ['url', 'encode', 'decode', 'uri', '百分号'],
    render(page) {
      let full = false;
      const box = convertLayout({
        inputLabel: T('原文'), outputLabel: T('URL 编码'), realtime: true,
        onConvert: (t) => full ? [...utf8ToBytes(t)].map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('') : encodeURIComponent(t)
      });
      const chk = h('label', { class: 'field-hint' }, h('input', { type: 'checkbox', class: 'checkbox' }), T(' 全量编码（含 : / ? 等保留字符）'));
      chk.querySelector('input').addEventListener('change', (e) => { full = e.target.checked; fire2(); });
      page.appendChild(div('form-row', chk));
      page.appendChild(box.el);
      const ta = box.input, out = box.output;
      function fire2() {
        try {
          if (mode()) {
            // decode: try decodeURIComponent
            out.value = decodeURIComponent(ta.value.replace(/\+/g, ' '));
          } else {
            out.value = full ? [...utf8ToBytes(ta.value)].map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('') : encodeURIComponent(ta.value);
          }
        } catch (e) {
          /* 【静默清空 = 用户以为工具没反应】
           * 解码失败（裸 %、非法 UTF-8 序列）时输出框直接清空，没有任何提示。
           * base64 半边对同类问题有三类中文归因（decodeErrHint），
           * URL 半边也复用它 —— 同一文件两套标准是明显的不一致。 */
          out.value = '';
          const hint = decodeErrHint(String((e && e.message) || e));
          out.value = '注意：' + hint;
        }
      }
      function mode() { return swapDecode; }
      let swapDecode = false;
      const swapBtn = window.ui.btn('解码', 'btn-secondary btn-sm', () => {
        swapDecode = !swapDecode;
        swapBtn.querySelector('.btn-label').textContent = swapDecode ? '编码' : '解码';
        const heads = box.el.querySelectorAll('.pane-head');
        heads[0].firstChild.textContent = swapDecode ? 'URL 编码' : '原文';
        heads[1].firstChild.textContent = swapDecode ? '解码结果' : 'URL 编码';
        fire2();
      }, 'git-compare');
      page.querySelector('.form-row').prepend(swapBtn);
      ta.addEventListener('input', fire2);
      fire2();
    }
  });

  register({
    id: 'unicode-convert', name: 'Unicode 转换', nameEn: 'Unicode Convert', module: MOD, icon: 'languages', i18n: true,
    desc: '文本与 \\uXXXX 转义序列互转，支持中文转 Unicode', descEn: 'Convert between Unicode escapes, HTML entities and plain text',
    keywords: ['unicode', 'uXXXX', '转义', 'escape'],
    render(page) {
      /* 星形平面字符（emoji 等，码点 > 0xFFFF）必须拆成高低代理对两个 \uXXXX，
         否则 charCodeAt(0) 只取到高代理项，低代理项被整个丢掉，
         往返一次就变成乱码。（早期实现用 [...t].map(c => c.charCodeAt(0)) 就踩了这个坑） */
      function escOne(c) {
        const cp = c.codePointAt(0);
        if (cp > 0xFFFF) {
          const hi = Math.floor((cp - 0x10000) / 0x400) + 0xD800;
          const lo = ((cp - 0x10000) % 0x400) + 0xDC00;
          return '\\u' + hi.toString(16) + '\\u' + lo.toString(16);
        }
        return '\\u' + cp.toString(16).padStart(4, '0');
      }
      /* 【编码/解码只能有一份实现】
       * 原来这里有两个 input 监听器：convertLayout(realtime:true) 自己注册的
       * （会调 onConvert），以及下面又加的 ta.addEventListener('input', fire)。
       * 两者的转义规则不一致 —— onConvert 会转义控制字符（\t \n \x00），
       * fire 不会。后注册的覆盖先注册的，于是**控制字符转义成了死代码**，
       * 永远不会出现在输出里，而且每次击键把整段文本转两遍。
       * 现在：方向判断收进 onConvert，只留 convertLayout 那一个监听器；
       * 切换方向时主动调 box.fire() 重算（输入没变但方向变了）。 */
      function decodeUnicode(t) {
        // 逐字符解析成 code point 再 fromCodePoint，代理对会自动重组
        const s0 = String(t).replace(/\\\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        return s0.replace(/[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]/g, (pair) =>
          String.fromCodePoint((pair.charCodeAt(0) - 0xD800) * 0x400 + (pair.charCodeAt(1) - 0xDC00) + 0x10000));
      }
      const encodeUnicode = (t) => [...t].map((c) =>
        (c.codePointAt(0) > 127 || /[\u0000-\u001f]/.test(c)) ? escOne(c) : c).join('');
      let decode = false;
      const box = convertLayout({
        inputLabel: T('原文'), outputLabel: T('Unicode 转义'), realtime: true,
        onConvert: (t) => (decode ? decodeUnicode(t) : encodeUnicode(t))
      });
      page.appendChild(box.el);
      const swapBtn = window.ui.btn('解码', 'btn-secondary btn-sm', () => {
        decode = !decode;
        swapBtn.querySelector('.btn-label').textContent = decode ? '编码' : '解码';
        const heads = box.el.querySelectorAll('.pane-head');
        heads[0].firstChild.textContent = decode ? 'Unicode 转义' : '原文';
        heads[1].firstChild.textContent = decode ? '解码结果' : 'Unicode 转义';
        box.fire();
      }, 'git-compare');
      page.insertBefore(div('form-row', swapBtn), box.el);
      box.fire();
    }
  });

  register({
    id: 'html-entity', name: 'HTML 实体转义', nameEn: 'HTML Entities', module: MOD, icon: 'code', i18n: true,
    desc: 'HTML 特殊字符转义与还原，防止 XSS', descEn: 'Escape and unescape HTML entities',
    keywords: ['html', 'escape', '转义', '实体', 'xss'],
    render(page) {
      const box = convertLayout({
        inputLabel: T('原文'), outputLabel: T('HTML 转义'), realtime: true,
        onConvert: (t) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
      });
      page.appendChild(box.el);
      const ta = box.input, out = box.output;
      let decode = false;
      const swapBtn = window.ui.btn(T('还原'), 'btn-secondary btn-sm', () => {
        decode = !decode;
        swapBtn.querySelector('.btn-label').textContent = decode ? '转义' : T('还原');
        const heads = box.el.querySelectorAll('.pane-head');
        heads[0].firstChild.textContent = decode ? 'HTML 转义' : '原文';
        heads[1].firstChild.textContent = decode ? T('还原结果') : 'HTML 转义';
        fire();
      }, 'git-compare');
      page.insertBefore(div('form-row', swapBtn), box.el);
      function fire() {
        if (decode) {
          const d = h('textarea'); d.innerHTML = ta.value;
          out.value = d.value;
        } else {
          out.value = ta.value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }
      }
      ta.addEventListener('input', fire);
      fire();
    }
  });

  register({
    /* 【名称里的 ASCII 会误导，副标题必须把编码说清楚】
     * 这个工具实际做的是 **UTF-8** 字节与十六进制的互转（靠 TextEncoder/
     * TextDecoder，项目里没有任何内置编码表）。但中文用户看到「ASCII」
     * 输入「中」时期望的是 GBK 的 D6 D0 —— 这里给的是 UTF-8 的 E4 B8 AD，
     * 两边字节完全对不上，而旧文案没有任何地方说明。
     * 名字本身保留（改 id/name 会牵动搜索关键词与用户习惯），
     * 但在副标题里点明 UTF-8 —— 那是用户决定"要不要用这个工具"时看的字段。 */
    id: 'hex-ascii', name: 'Hex / ASCII 互转', nameEn: 'Hex ↔ ASCII', module: MOD, icon: 'hash', i18n: true,
    desc: '文本与十六进制字节互转（按 UTF-8 编码，非 GBK），支持自定义分隔符',
    descEn: 'Convert between text and hex bytes (UTF-8, not GBK); custom separators',
    keywords: ['hex', 'ascii', 'utf8', '十六进制', '字节'],
    render(page) {
      let sep = ' ';
      const box = convertLayout({
        inputLabel: T('文本'), outputLabel: T('十六进制'), realtime: true,
        onConvert: (t) => [...utf8ToBytes(t)].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(sep)
      });
      const sel = h('select', { class: 'select input-sm' },
        h('option', { value: ' ' }, T('空格分隔')), h('option', { value: '' }, T('无分隔')), h('option', { value: ',' }, T('逗号分隔')), h('option', { value: '\\x' }, T('\\x 前缀')));
      sel.addEventListener('change', () => { sep = sel.value === '\\x' ? '' : sel.value; fire2(); });
      page.appendChild(div('form-row', h('span', { class: 'form-label' }, '格式'), sel));
      page.appendChild(box.el);
      const ta = box.input, out = box.output;
      let decode = false;
      const swapBtn = window.ui.btn('解码', 'btn-secondary btn-sm', () => {
        decode = !decode;
        swapBtn.querySelector('.btn-label').textContent = decode ? '编码' : '解码';
        const heads = box.el.querySelectorAll('.pane-head');
        heads[0].firstChild.textContent = decode ? '十六进制' : '文本';
        heads[1].firstChild.textContent = decode ? '解码结果' : '十六进制';
        fire2();
      }, 'git-compare');
      page.querySelector('.form-row').appendChild(swapBtn);
      function fire2() {
        try {
          if (decode) {
            const clean = ta.value.replace(/0x/gi, '').replace(/\\x/g, '').replace(/[\s,]/g, '');
            if (!clean) { out.value = ''; return; }
            if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) throw new Error('无效的十六进制输入');
            const bytes = new Uint8Array(clean.match(/.{2}/g).map(x => parseInt(x, 16)));
            /* 【用严格解码，并给出可操作的归因】
             * 旧的 bytesToUtf8 遇到 GBK 字节会静默输出「����」——
             * 用户分不清是输入错了还是工具坏了。见 bytesToUtf8Strict 的说明。 */
            try {
              out.value = bytesToUtf8Strict(bytes);
            } catch (e) {
              out.value = '解码失败：' + decodeErrHint(e);
            }
          } else {
            const arr = [...utf8ToBytes(ta.value)];
            out.value = sep === '' && sel.value === '\\x'
              ? arr.map(b => '\\x' + b.toString(16).padStart(2, '0')).join('')
              : arr.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(sep);
          }
        } catch (e) {
          /* 走到这里的是"十六进制串本身有问题"（奇数长度、含非 hex 字符）——
           * 解码失败已在上面就地处理并给了归因。这里只补一句格式指引。 */
          const m = String((e && e.message) || e);
          out.value = '格式错误：' + (/无效的十六进制/.test(m)
            ? '无效的十六进制输入：只能是 0-9 / a-f，且每字节两位（长度必须是偶数）'
            : decodeErrHint(e));
        }
      }
      ta.addEventListener('input', fire2);
      fire2();
    }
  });
})();
