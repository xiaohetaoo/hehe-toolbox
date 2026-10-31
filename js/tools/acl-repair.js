/* 模块：文件处理 —— 权限修复与取得所有权 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, confirmBox, renderTable, filePicker } = window.ui;
  const { invoke } = window.api;
  const MOD = 'file';

  register({
    id: 'acl-repair',
    name: '权限修复',
    module: MOD,
    icon: 'shield',
    desc: '文件删不掉、提示拒绝访问时，查清缺哪条权限，并可取得所有权（需管理员）',
    keywords: ['权限', '拒绝访问', '所有权', 'takeown', 'icacls', 'ACL', '删不掉', '访问被拒绝'],
    render(page) {
      /* 【state.repair 存在的理由】
       * 修复完成后要「再诊断一次」看是否真的修好，而诊断的第一步就是
       * resultBox.innerHTML = '诊断中…' —— 整个修复卡（含命令输出）被清掉。
       * 早期实现是「先 renderRepairResult 再 diagBtn.click()」，于是用户
       * 只看到界面闪一下又回到诊断卡，takeown/icacls 的输出和
       * 「已取得完全控制」的结论永远看不到。
       * 把修复结果存进 state，让 render() 在重建页面时一并画出来。 */
      const state = { target: null, diag: null, recursive: false, repair: null };

      page.appendChild(div('card',
        div('card-title', '删不掉的两种原因'),
        div('field-hint',
          '① 文件被别的程序占用 —— 用「文件占用解锁」查是谁占着。'),
        div('field-hint', { style: { marginTop: '3px' } },
          '② 你没有权限 —— 就是这个工具。表现为「拒绝访问」「需要权限」或删除按钮灰掉。'),
        div('field-hint', { style: { marginTop: '6px', color: 'var(--text-3)' } },
          '本工具只处理**你显式选中的那一个路径**，不会全盘扫描、不会批量套用。' +
          '修复会放宽该路径（以及它的子项）的访问权限，请确认这确实是你要的。')));

      /* ---------------- 选择目标 ---------------- */
      const picker = filePicker({
        text: '选择或拖入那个删不掉的 文件 / 目录',
        multiple: false,
        single: true,
        directory: false,
        emptyText: '还没有选择目标',
        onChange: (items) => {
          state.target = items.length ? items[0].path : null;
          state.diag = null;
          state.repair = null;
          resultBox.innerHTML = '';
        },
      });

      const dirInput = h('input', { class: 'input input-sm', placeholder: '或者直接填路径（目录也行）', style: { flex: '1' } });
      const usePathBtn = btn('用这个路径', 'btn-sm btn-secondary', () => {
        const v = dirInput.value.trim();
        if (!v) return toast('请填写路径', 'warn');
        state.target = v;
        state.diag = null;
        state.repair = null;
        resultBox.innerHTML = '';
        toast('已选定：' + v, 'info', 1600);
      });

      const resultBox = div('');

      const diagBtn = btn('🔍 诊断缺什么权限', 'btn-primary', async () => {
        if (!state.target) return toast('请先选择文件/目录，或填一个路径', 'warn');
        resultBox.innerHTML = '<div class="card"><div class="field-hint">诊断中…</div></div>';
        try {
          const d = await invoke('acl:diagnose', state.target);
          state.diag = d;
          render();
        } catch (e) {
          resultBox.innerHTML = '';
          resultBox.appendChild(div('card', div('card-title', '诊断失败'),
            div('field-err', '✗ ' + e.message)));
        }
      });
      function render() {
        resultBox.innerHTML = '';
        const d = state.diag;
        if (!d) return;
        /* ---- 概览：所有者 / 我是不是管理员 / 有没有完全控制 ---- */
        const card = div('card');
        card.appendChild(div('card-title', '当前状况'));
        card.appendChild(renderTable({
          columns: [
            { key: 'k', title: '项目', width: '130px' },
            { key: 'v', title: '值', render: (row) => h('span', { style: { fontSize: '12px', wordBreak: 'break-all', userSelect: 'text' } }, row.v) },
          ],
          rows: [
            { k: '目标路径', v: d.path },
            { k: '所有者', v: d.owner || '（读不到）' },
            { k: '当前用户', v: d.me || '（读不到）' },
            { k: '所有者是你吗', v: d.ownerIsMe == null ? '（未知）' : (d.ownerIsMe ? '是' : '否') },
            { k: '完全控制', v: d.hasFull ? '有' : '没有' },
            { k: '管理员运行', v: d.isAdmin ? '是' : '否' },
          ],
          rowKey: (row) => row.k,
          empty: '无',
        }));

        /* ---- 诊断结论 ---- */
        if (d.codes && d.codes.length) {
          const codes = div('form-row', { style: { marginTop: '8px' } });
          for (const c of d.codes) {
            const label = {
              OWNER: '所有者不是你', DENY: '存在拒绝权限', NO_WRITE: '缺少写入权限',
              LOCKED: '被进程占用', UNKNOWN: '原因未定', NOT_EXIST: '路径不存在',
            }[c] || c;
            const cls = c === 'LOCKED' ? 'tag-orange' : 'tag-red';
            codes.appendChild(h('span', { class: 'tag ' + cls }, label));
          }
          card.appendChild(codes);
        }
        for (const m of (d.messages || [])) {
          card.appendChild(div('field-hint', { style: { marginTop: '4px' } }, m));
        }

        /* ---- 占用问题的转诊：这是并列原因，别让用户在这里白费劲 ---- */
        if (d.codes && d.codes.indexOf('LOCKED') !== -1) {
          card.appendChild(div('form-row', { style: { marginTop: '8px' } },
            btn('去查是谁占用着 →', 'btn-sm btn-secondary', () => window.App.openTool('file-unlock'))));
        }
        resultBox.appendChild(card);

        if (d.codes && d.codes.indexOf('NOT_EXIST') !== -1) return;

        /* ---- 修复区 ---- */
        const fixCard = div('card');
        fixCard.appendChild(div('card-title', '修复'));

        /* 风险提示必须显眼：目录会波及子项 */
        const riskRow = div('', {
          style: {
            padding: '8px 10px', borderRadius: '6px', marginBottom: '10px',
            background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
            border: '1px solid var(--warning)',
          },
        });
        riskRow.appendChild(div('', { style: { fontWeight: 600, fontSize: '13px' } }, '⚠ 影响范围'));
        riskRow.appendChild(div('field-hint', { style: { marginTop: '2px' } }, d.risk || ''));
        fixCard.appendChild(riskRow);

        /* 递归开关：只对目录显示，且默认关 */
        if (d.isAdmin === false) {
          fixCard.appendChild(div('field-err',
            '当前不是管理员运行 —— 改所有者（takeown）这一步普通权限做不了。' +
            '请关闭本程序，右键「以管理员身份运行」后重试。'));
        }

        const recRow = div('form-row');
        if (/目录/.test(d.risk || '')) {
          const chk = h('input', { type: 'checkbox', id: 'acl-rec' });
          chk.checked = false;
          chk.addEventListener('change', () => { state.recursive = chk.checked; });
          const lab = h('label', { for: 'acl-rec', style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px' } });
          lab.appendChild(chk);
          lab.appendChild(h('span', null, '递归到该目录下的所有子项（危险，仅在确实需要整棵树时勾选）'));
          recRow.appendChild(lab);
        }
        fixCard.appendChild(recRow);

        const runBtn = btn('取得所有权并授予完全控制', 'btn-danger', async () => {
          const isRec = state.recursive && /目录/.test(d.risk || '');
          const ok = await confirmBox({
            title: '确认修复权限',
            message:
              '目标：' + d.path + '\n\n' +
              (isRec
                ? '⚠ 已勾选递归：会改动该目录下**每一个**条目。\n\n'
                : '只作用于这一个路径。\n\n') +
              '将执行两步：\n' +
              '  1. takeown —— 把所有者改成你\n' +
              '  2. icacls —— 给你授予完全控制（含继承标记）\n\n' +
              '这会让该路径对当前用户完全开放。确认继续？',
            danger: true, okText: '确认修复',
          });
          if (!ok) return;

          runBtn.disabled = true;
          try {
            const r = await invoke('acl:repair', { target: d.path, recursive: isRec });
            /* 先存结果，再重查 —— 顺序反了结果就会被抹掉（见 state.repair 的注释） */
            state.repair = r;
            renderRepairResult(r);
            diagBtn.click();   // 自动重查，看是否真的修好了（render() 会带上 repair 结果）
          } catch (e) {
            toast(e.message, 'error');
            fixCard.appendChild(div('field-err', { style: { marginTop: '6px' } }, '✗ ' + e.message));
          } finally {
            runBtn.disabled = false;
          }
        });
        fixCard.appendChild(div('form-row', { style: { marginTop: '8px' } }, runBtn));

        const repairBox = div('');
        fixCard.appendChild(repairBox);

        function renderRepairResult(r) {
          repairBox.innerHTML = '';
          if (!r) return;
          const done = div('', { style: { marginTop: '10px' } });
          done.appendChild(div('', {
            style: { fontWeight: 600, fontSize: '13px', color: r.ok ? 'var(--success, #00b42a)' : 'var(--danger, #f53f3f)' },
          }, r.ok ? (r.gained ? '✓ 修复成功，已取得完全控制' : '命令已执行，但复核未通过') : '✗ 修复中止'));
          done.appendChild(div('field-hint', { style: { marginTop: '4px' } }, r.advice || ''));
          if (r.steps && r.steps.length) {
            done.appendChild(renderTable({
              columns: [
                { key: 'tool', title: '命令', width: '90px' },
                { key: 'ok', title: '结果', width: '70px', render: (row) => h('span', { class: 'tag ' + (row.ok ? 'tag-green' : 'tag-red') }, row.ok ? '成功' : '失败') },
                { key: 'text', title: '输出', render: (row) => h('span', { style: { fontSize: '11px', wordBreak: 'break-all' } }, (row.text || '').slice(0, 200)) },
              ],
              rows: r.steps,
              rowKey: (row) => row.tool,
              empty: '无',
            }));
          }
          repairBox.appendChild(done);
        }

        resultBox.appendChild(fixCard);
        /* 【把上次的修复结果画回来】
         * 修复后自动重查会重建整个页面，修复卡是新建的、repairBox 是空的。
         * 这里按 state.repair 复现一次，让用户同时看到「刷新后的诊断结论」
         * 和「命令到底执行了什么、复核有没有通过」。 */
        if (state.repair) renderRepairResult(state.repair);

        /* ---- ACL 明细：给想看细节的人 ---- */
        if (d.aclEntries && d.aclEntries.length) {
          const aclCard = div('card');
          aclCard.appendChild(div('card-title', '权限条目（最多显示 20 条）'));
          aclCard.appendChild(renderTable({
            columns: [
              { key: 'principal', title: '账号', render: (row) => h('span', { style: { fontSize: '12px', wordBreak: 'break-all' } }, row.principal) },
              { key: 'perms', title: '权限', width: '90px' },
              { key: 'deny', title: '类型', width: '70px', render: (row) => h('span', { class: 'tag ' + (row.deny ? 'tag-red' : 'tag-green') }, row.deny ? '拒绝' : '允许') },
            ],
            rows: d.aclEntries,
            rowKey: (row) => row.principal + row.perms,
            empty: '无',
          }));
          resultBox.appendChild(aclCard);
        }
      }

      page.appendChild(div('card',
        div('card-title', '选择目标'),
        picker.el,
        div('form-row', { style: { marginTop: '8px' } }, dirInput, ' ', usePathBtn),
        div('form-row', { style: { marginTop: '8px' } }, diagBtn,
          ' ', btn('清空', 'btn-sm btn-secondary', () => {
            state.target = null; state.diag = null; state.recursive = false;
            resultBox.innerHTML = '';
            if (picker.clear) picker.clear();
          }))));

      page.appendChild(resultBox);
    },
  });
})();
