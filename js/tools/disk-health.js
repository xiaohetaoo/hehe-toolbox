/* 模块：系统与硬件 —— 磁盘健康与寿命 */
(function () {
  const { register } = window.Registry;
  const { div, btn, toast, renderTable, fmtBytes } = window.ui;
  const { invoke } = window.api;
  const MOD = 'system';

  /* 拿不到的字段统一显示这句 —— 绝不显示 0、绝不编数字。
   * 这比「不显示」更重要：0 会被用户当成「读数正常」，那是错误信息。 */
  const NA = '本机取不到';

  function val(v, unit) {
    if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return NA;
    if (typeof v === 'number' && unit) return v + ' ' + unit;
    return String(v);
  }

  register({
    id: 'disk-health',
    name: '磁盘健康',
    module: MOD,
    icon: 'activity',
    desc: '查看磁盘的系统健康状态与寿命读数；本机取不到的项会明确标注，不编造数据',
    keywords: ['磁盘', '健康', 'SMART', '寿命', '温度', '通电', '硬盘', 'SSD', 'smart'],
    render(page) {
      const resultBox = div('');

      page.appendChild(div('card',
        div('card-title', '这个工具能告诉你什么'),
        div('field-hint',
          '系统自己怎么看这些磁盘（健康状态、运行状态），以及**如果能读到**的话，' +
          '厂商上报的温度、通电时长、已用寿命、读写错误。'),
        div('field-hint', { style: { marginTop: '6px' } },
          '⚠ 重要：很多机器上根本读不到 SMART 明细 —— SATA 盘需要特定驱动接口、' +
          '厂商驱动可能拦截读取、外置 USB 盘通常不支持、普通权限也可能被系统策略挡住。' +
          '这些情况下本工具会明确写「本机取不到」，**不会显示 0，也不会给你算一个健康度**。' +
          '没有数据 ≠ 磁盘健康。'),
        div('field-hint', { style: { marginTop: '6px', color: 'var(--text-3)' } },
          '想知道真实寿命，最可靠的办法是用硬盘厂商自家工具（如三星 Magician、' +
          '西数 Dashboard）或用管理员权限下的 CrystalDiskInfo。')));

      const scanBtn = btn('🔍 读取磁盘健康', 'btn-primary', doScan);

      async function doScan() {
        resultBox.innerHTML = '<div class="card"><div class="field-hint">读取中…</div></div>';
        try {
          const r = await invoke('sys:disk-health', true);
          render(r);
        } catch (e) {
          resultBox.innerHTML = '';
          resultBox.appendChild(div('card', div('card-title', '读取失败'),
            div('field-err', '✗ ' + e.message)));
        }
      }

      function render(r) {
        resultBox.innerHTML = '';
        if (!r) return;

        /* ---- 限制说明放最上面：先说清楚「为什么很多项是空的」 ---- */
        if (r.limitations && r.limitations.length) {
          const limCard = div('card');
          limCard.appendChild(div('card-title', h('span', { class: 'tag tag-orange', style: { marginRight: '8px' } }, '数据可用性')));
          for (const l of r.limitations) {
            limCard.appendChild(div('field-hint', { style: { marginTop: '4px' } }, l));
          }
          if (!r.isAdmin) {
            limCard.appendChild(div('form-row', { style: { marginTop: '8px' } },
              h('span', { class: 'field-hint' }, '想再试一次？用「以管理员身份运行」重启本程序后重新读取。')));
          }
          resultBox.appendChild(limCard);
        }

        if (!r.disks || !r.disks.length) {
          resultBox.appendChild(div('card', div('card-title', '没有枚举到物理磁盘'),
            div('field-hint', '若你能在「磁盘管理」里看到磁盘，可能是存储驱动异常。')));
          return;
        }

        /* ---- 每块盘一张卡 ---- */
        for (const d of r.disks) {
          const card = div('card');
          const title = div('card-title');
          title.appendChild(h('span', null, d.model || '（未知型号）'));
          const lv = d.verdict ? d.verdict.level : 'unknown';
          const lvMeta = {
            ok: { cls: 'tag-green', txt: '读数正常' },
            warn: { cls: 'tag-orange', txt: '值得注意' },
            bad: { cls: 'tag-red', txt: '可能有问题' },
            unknown: { cls: 'tag', txt: '无法评估' },
          }[lv] || { cls: 'tag', txt: lv };
          title.appendChild(h('span', { class: 'tag ' + lvMeta.cls, style: { marginLeft: '8px' } }, lvMeta.txt));
          card.appendChild(title);

          card.appendChild(renderTable({
            columns: [
              { key: 'k', title: '项目', width: '120px' },
              { key: 'v', title: '值', render: (row) => h('span', { style: { fontSize: '12px', userSelect: 'text' } }, row.v) },
            ],
            rows: [
              { k: '型号', v: d.model || NA },
              { k: '介质类型', v: d.mediaType || NA },
              { k: '接口', v: d.busType || NA },
              { k: '容量', v: d.size != null ? fmtBytes(d.size) : NA },
              { k: '系统健康状态', v: d.healthStatus || NA },
              { k: '运行状态', v: d.operationalStatus || NA },
              { k: '温度', v: val(d.temperature, '°C') },
              { k: '通电时长', v: d.powerOnHours != null ? d.powerOnHours + ' 小时（约 ' + Math.round(d.powerOnHours / 24) + ' 天）' : NA },
              { k: '已用寿命', v: d.wear != null ? d.wear + '%' : NA },
              { k: '累计读错误', v: val(d.readErrors) },
              { k: '累计写错误', v: val(d.writeErrors) },
              { k: '启停次数', v: val(d.startStop) },
            ],
            rowKey: (row) => row.k,
            empty: '无',
          }));

          /* -------- 结论：只在有依据时才给判断 ------------- */
          if (d.verdict) {
            const vBox = div('', {
              style: {
                marginTop: '8px', padding: '8px 10px', borderRadius: '6px',
                background: 'color-mix(in srgb, var(--fill-1) 100%, transparent)',
                borderLeft: '3px solid ' + ({
                  ok: 'var(--success, #00b42a)', warn: 'var(--warning)', bad: 'var(--danger, #f53f3f)',
                  unknown: 'var(--text-3)',
                }[lv] || 'var(--text-3)'),
              },
            });
            vBox.appendChild(div('', { style: { fontWeight: 600, fontSize: '13px' } }, '结论'));
            vBox.appendChild(div('field-hint', { style: { marginTop: '3px' } }, d.verdict.text));
            card.appendChild(vBox);
          }

          /* ------------- 剩余寿命：只有拿到 wear 才给 ------------- */
          if (d.estimate) {
            const eBox = div('', { style: { marginTop: '8px' } });
            eBox.appendChild(div('', { style: { fontSize: '13px', fontWeight: 600 } }, '寿命估算'));
            eBox.appendChild(div('field-hint', { style: { marginTop: '2px' } }, d.estimate.text));
            if (d.estimate.caveat) {
              eBox.appendChild(div('field-hint', { style: { marginTop: '2px', color: 'var(--text-3)' } }, d.estimate.caveat));
            }
            card.appendChild(eBox);
          } else if (!d.hasSmart) {
            /* 明确说「不给估算」以及原因，而不是留白让用户以为漏了 */
            card.appendChild(div('field-hint', { style: { marginTop: '8px', color: 'var(--text-3)' } },
              '没有寿命估算：本机读不到厂商上报的磨损百分比。任何在此情况下给出的「剩余 X%」都是猜的。'));
          }

          /* 缺哪些字段，列清楚 */
          if (d.missingFields && d.missingFields.length) {
            card.appendChild(div('field-hint', { style: { marginTop: '6px', color: 'var(--text-3)' } },
              '本机取不到：' + d.missingFields.join('、')));
          }

          resultBox.appendChild(card);
        }
      }

      page.appendChild(div('card', div('card-title', '读取'), div('form-row', scanBtn)));
      page.appendChild(resultBox);
    },
  });
})();
