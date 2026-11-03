/* 模块：多媒体处理 —— exif-view（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, filePicker } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';

register({
    id: 'exif-view', name: 'EXIF 信息查看', module: MOD, icon: 'eye',
    desc: '查看 JPEG 拍摄参数（时间/设备/GPS），支持一键清除',
    keywords: ['exif', '照片', '信息', '隐私'],
    render(page) {
      const result = div('');
      const picker = filePicker({
        text: '拖入 JPEG 照片查看 EXIF',
        single: true,
        emptyText: '还没有选择照片',
        filters: [{ name: '照片', extensions: ['jpg', 'jpeg'] }],
        onChange: (items) => {
          if (items.length && !items[0].virtual) analyze(items[0].path);
          else result.innerHTML = '';
        }
      });
      async function analyze(path) {
        result.innerHTML = '';
        try {
          const r = await invoke('fs:read-file-b64', path);
          const buf = Uint8Array.from(atob(r.b64), c => c.charCodeAt(0));
          const exif = parseExif(buf);
          if (!exif || !Object.keys(exif).length) { result.appendChild(div('empty-tip', '未找到 EXIF 信息（可能已被清除或不是照片）')); return; }
          const card = div('card');
          card.style.border = '1px solid var(--border)';
          card.appendChild(window.ui.kvGrid(Object.entries(exif)));
          result.appendChild(card);
          const cleanBtn = btn('清除 EXIF 并保存副本', 'btn-danger-plain', async () => {
            // 输出必须唯一：固定 -noexif.jpg 会让第二次点击静默覆盖前一次的结果
            const out = await invoke('fs:unique-path', path.replace(/\.jpe?g$/i, '') + '-noexif.jpg');
            try {
              await invoke('fs:write-file-b64', out, stripExif(buf));
              toast('已保存无 EXIF 副本：' + out, 'success');
            } catch (e) { toast('保存失败：' + e.message, 'error'); }
          }, 'refresh');
          result.appendChild(div('form-row', cleanBtn));
        } catch (e) { result.innerHTML = `<div class="field-err">${escapeHtml(e.message)}</div>`; }
      }
      function parseExif(buf) {
        try {
          let offset = 2;
          const dv = new DataView(buf.buffer);
          while (offset < buf.length) {
            if (buf[offset] !== 0xFF) { offset++; continue; }
            const marker = buf[offset + 1];
            const size = dv.getUint16(offset + 2);
            if (marker === 0xE1 && offset + 4 < buf.length) {
              // APP1 check Exif
              const head = String.fromCharCode(...buf.slice(offset + 4, offset + 10));
              if (head === 'Exif\u0000') return parseTiff(buf, offset + 10);
            }
            if (marker === 0xDA) break; // SOS
            offset += 2 + size;
          }
          return null;
        } catch (e) { return null; }
      }
      /* 【buf 必须作为参数传进来 —— 这是一个真实的 ReferenceError】
       * parseTiff 定义在 parseExif **外面**（在 render() 的作用域里），
       * 而 buf 是 parseExif 的形参。原来这里直接用裸 `buf`，走到
       * 「JPEG 里有 Exif 段」这条分支时必然抛 ReferenceError: buf is not defined，
       * 被外层 catch 吞掉 → EXIF 卡片上只剩「未找到 EXIF 信息」。
       * 换句话说：带 EXIF 的照片（也就是绝大多数相机/手机原图）反而看不到参数，
       * 而**没有** EXIF 的照片看起来正常 —— 表现极具迷惑性。
       * 这是 ESLint 的 no-undef 抓出来的（任务 3）。 */
      function parseTiff(buf, start) {
        // DataView 基于完整 buffer，配合 base 偏移读取
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const base = start;
        const little = dv.getUint16(base) === 0x4949;
        const g16 = (o) => dv.getUint16(base + o, little);
        const g32 = (o) => dv.getUint32(base + o, little);
        const ifd = g32(4);
        const TAGS = { 0x010F: '相机制造商', 0x0110: '相机型号', 0x0112: '方向', 0x0132: '拍摄时间', 0x8769: '_exifIFD', 0x8827: 'ISO', 0x829A: '曝光时间', 0x829D: '光圈值(F)', 0x920A: '焦距(mm)', 0xA002: '图像宽度', 0xA003: '图像高度', 0x9003: '原始时间', 0x0002: '' };
        const out = {};
        function readIFD(off) {
          const count = g16(off);
          for (let i = 0; i < count; i++) {
            const e = off + 2 + i * 12;
            const tag = g16(e), type = g16(e + 2), num = g32(e + 4);
            const name = TAGS[tag];
            if (!name || name.startsWith('_')) {
              if (tag === 0x8769) { const sub = g32(e + 8); readIFD(sub); }
              continue;
            }
            let val;
            if (type === 2) {
              /* ASCII 标签：count 是字节数（含结尾 \0）。
               * 【修正】原来是 `j < len - 1` 只跳过**最后**一个字节，
               * 若实际字符串后面有多个 \0（很多相机会补零对齐），
               * 会把多余的空字节也读进来，显示成乱码。
               * 正确做法是读到第一个 \0 为止。
               * 偏移也要区分：count <= 4 时值内联在条目里（绝对偏移 e+8），
               * 否则第 4 字段是相对 TIFF 头(base) 的偏移。 */
              const len = num;
              const valOff = num <= 4 ? e + 8 : base + g32(e + 8);
              let s = '';
              for (let j = 0; j < len && j < 64; j++) {
                const code = dv.getUint8(valOff + j);
                if (code === 0) break;            // 遇结束符就停
                s += String.fromCharCode(code);
              }
              val = s;
            } else if (type === 3) val = g16(e + 8);
            else if (type === 4) val = g32(e + 8);
            else if (type === 5) {
              const vOff = base + g32(e + 8);
              val = num > 0 ? (g32(e + 8) ? (dv.getUint32(vOff, little) / dv.getUint32(vOff + 4, little)).toFixed(2) : '-') : '-';
            } else val = g32(e + 8);
            if (val !== '' && val != null) out[name] = String(val);
          }
        }
        readIFD(ifd);
        return out;
      }
      function stripExif(b) {
        // remove APP1 segment
        const dv = new DataView(b.buffer);
        let offset = 2;
        while (offset < b.length) {
          if (b[offset] !== 0xFF) { offset++; continue; }
          const marker = b[offset + 1];
          const size = dv.getUint16(offset + 2);
          if (marker === 0xE1) {
            const out = new Uint8Array(b.length - (2 + size));
            out.set(b.subarray(0, offset), 0);
            out.set(b.subarray(offset + 2 + size), offset);
            let bin = '';
            for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
            return btoa(bin);
          }
          if (marker === 0xDA) break;
          offset += 2 + size;
        }
        // 【分块转换】不能写 String.fromCharCode(...b) —— 展开运算符会把整个
        // Uint8Array 作为实参压入调用栈，实测 1,000,000 字节即抛
        // RangeError: Maximum call stack size exceeded。
        // 一张不带 EXIF 的普通大图（>1MB）会直接崩溃。
        let bin2 = '';
        for (let i = 0; i < b.length; i += 0x8000) bin2 += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        return btoa(bin2);
      }
      page.appendChild(div('card', div('card-title', '照片'), picker.el, result));
    }
  })
})();
