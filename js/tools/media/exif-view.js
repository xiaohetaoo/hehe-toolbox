/* 模块：多媒体处理 —— exif-view（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, filePicker } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';

register({
    id: 'exif-view', name: 'EXIF 信息查看', nameEn: 'EXIF Viewer', module: MOD, icon: 'eye',
    desc: '查看 JPEG 拍摄参数（时间/设备/GPS），支持一键清除', descEn: 'Inspect JPEG shooting parameters (time, device, GPS) and strip them',
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
          const r = await invoke(Channels.CHANNELS.FS.READ_FILE_B64, path);
          const buf = Uint8Array.from(atob(r.b64), c => c.charCodeAt(0));
          const exif = window.ExifLib.parseExif(buf);
          if (!exif || !Object.keys(exif).length) { result.appendChild(div('empty-tip', '未找到 EXIF 信息（可能已被清除或不是照片）')); return; }
          const card = div('card');
          card.style.border = '1px solid var(--border)';
          card.appendChild(window.ui.kvGrid(Object.entries(exif)));
          result.appendChild(card);
          const cleanBtn = btn('清除 EXIF 并保存副本', 'btn-danger-plain', async () => {
            // 输出必须唯一：固定 -noexif.jpg 会让第二次点击静默覆盖前一次的结果
            const out = await invoke(Channels.CHANNELS.FS.UNIQUE_PATH, path.replace(/\.jpe?g$/i, '') + '-noexif.jpg');
            try {
              await invoke(Channels.CHANNELS.FS.WRITE_FILE_B64, out, stripExif(buf));
              toast('已保存无 EXIF 副本：' + out, 'success');
            } catch (e) { toast('保存失败：' + e.message, 'error'); }
          }, 'refresh');
          result.appendChild(div('form-row', cleanBtn));
        } catch (e) { result.innerHTML = `<div class="field-err">${escapeHtml(e.message)}</div>`; }
      }
      /* EXIF 解析已抽到 lib/exif.js（纯函数、可单测，也被
       * 「按拍摄时间批量重命名」复用）。这里只保留 stripExif ——
       * 那是「删除 EXIF 段」的写操作，与"读"是两件事，且只有本工具用。 */
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
