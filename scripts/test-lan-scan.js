'use strict';
/* 局域网扫描纯逻辑测试：ARP 解析、网段计算、结果合并。
 * ARP 输出用的是本机实测的真实格式。 */
const assert = require('assert');
const L = require('../lib/lan-scan');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

/* ---------- ARP 解析：真实格式 ---------- */
const REAL_ARP = [
  '接口: 192.168.1.100 --- 0x4',
  '  Internet 地址         物理地址              类型',
  '  192.168.1.1           b0-be-76-12-ab-34     动态',
  '  192.168.1.5           00-1a-2b-3c-4d-5e     动态',
  '  192.168.1.20          3c-52-82-aa-bb-cc     动态',
  '  192.168.1.255         ff-ff-ff-ff-ff-ff     静态',
].join('\n');

t('解析真实 arp -a 输出，能拿到 IP 与 MAC', () => {
  const r = L.parseArp(REAL_ARP);
  assert.strictEqual(r.length, 3, '应解析出 3 台设备（广播项已过滤），实际 ' + r.length);
  assert.strictEqual(r[0].ip, '192.168.1.1');
  assert.strictEqual(r[0].mac, 'b0-be-76-12-ab-34', 'MAC 应统一成小写短横线格式');
  assert.strictEqual(r[0].type, '动态');
});

t('广播地址 ff-ff-ff-ff-ff-ff 被过滤掉', () => {
  const r = L.parseArp(REAL_ARP);
  const broadcast = r.find((x) => x.mac === 'ff-ff-ff-ff-ff-ff');
  assert.strictEqual(broadcast, undefined, '广播项不该出现在设备列表里');
  const ip255 = r.find((x) => x.ip === '192.168.1.255');
  assert.strictEqual(ip255, undefined, '.255 不该出现');
});

t('兼容冒号格式的 MAC', () => {
  const r = L.parseArp('  10.0.0.2   00:11:22:33:44:55   dynamic');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].mac, '00-11-22-33-44-55', '冒号应归一成短横线');
});

t('同一 IP 重复出现只保留一条', () => {
  const r = L.parseArp('  10.0.0.5 aa-bb-cc-dd-ee-ff dynamic\n  10.0.0.5 aa-bb-cc-dd-ee-ff dynamic');
  assert.strictEqual(r.length, 1);
});

t('组播地址（224.x / 239.x）被过滤，不当成设备', () => {
  // 本机真实 ARP 表里就有这些静态组播项，不过滤会凭空多出好几台「设备」
  const out = [
    '  224.0.0.22     01-00-5e-00-00-16     静态',
    '  224.0.0.251    01-00-5e-00-00-fb     静态',
    '  239.255.255.250 01-00-5e-7f-ff-fa    静态',
    '  192.168.1.1    b0-be-76-12-ab-34     动态',
  ].join('\n');
  const r = L.parseArp(out);
  assert.strictEqual(r.length, 1, '只应剩下真实设备，实际 ' + r.length);
  assert.strictEqual(r[0].ip, '192.168.1.1');
});

t('空输出不崩', () => {
  assert.deepStrictEqual(L.parseArp(''), []);
});

/* ---------- 网段计算 ---------- */
t('从本机 IP 推导 /24 网段', () => {
  const s = L.subnetOf('192.168.1.100');
  assert.strictEqual(s.network, '192.168.1.0');
  assert.strictEqual(s.first, '192.168.1.1');
  assert.strictEqual(s.last, '192.168.1.254');
});

t('非法 IP 返回 null', () => {
  assert.strictEqual(L.subnetOf('192.168.1'), null);
  assert.strictEqual(L.subnetOf('999.1.1.1'), null);
  assert.strictEqual(L.subnetOf(''), null);
});

t('hostsToScan 生成 254 个地址且不含 0/255', () => {
  const list = L.hostsToScan('192.168.1.100');
  assert.strictEqual(list.length, 254, '应为 254 个，实际 ' + list.length);
  assert.strictEqual(list[0], '192.168.1.1');
  assert.strictEqual(list[list.length - 1], '192.168.1.254');
  assert.ok(!list.some((x) => x.endsWith('.0') || x.endsWith('.255')), '不该含 .0 或 .255');
});

/* ---------- 结果合并 ---------- */
t('合并 ARP 与 ping：ARP 优先（信息更全）', () => {
  const r = L.mergeDevices({
    arp: [{ ip: '192.168.1.1', mac: 'b0-be-76-12-ab-34', type: '动态' }],
    pinged: ['192.168.1.1'],
    selfIp: '192.168.1.100',
  });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].source, 'arp+ping', '同时出现在两处应标记 arp+ping');
});

t('只在 ping 通、ARP 里没有的设备也会被列出来（MAC 未知）', () => {
  const r = L.mergeDevices({
    arp: [],
    pinged: ['192.168.1.7'],
    selfIp: '192.168.1.100',
  });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].mac, null, 'MAC 应为 null 而不是编一个');
  assert.strictEqual(r[0].source, 'ping');
});

t('本机排在最前面', () => {
  const r = L.mergeDevices({
    arp: [{ ip: '192.168.1.1', mac: 'aa-bb-cc-dd-ee-ff' }, { ip: '192.168.1.100', mac: '11-22-33-44-55-66' }],
    pinged: [],
    selfIp: '192.168.1.100',
  });
  assert.strictEqual(r[0].ip, '192.168.1.100', '本机应排第一，实际 ' + r[0].ip);
  assert.strictEqual(r[0].isSelf, true);
});

t('其余设备按 IP 数值升序（10 排在 9 后面，不是按字符串）', () => {
  const r = L.mergeDevices({
    arp: [
      { ip: '192.168.1.10', mac: 'aa-bb-cc-dd-ee-11' },
      { ip: '192.168.1.9', mac: 'aa-bb-cc-dd-ee-10' },
      { ip: '192.168.1.2', mac: 'aa-bb-cc-dd-ee-12' },
    ],
    pinged: [], selfIp: '192.168.1.100',
  });
  const ips = r.map((x) => x.ip);
  assert.deepStrictEqual(ips, ['192.168.1.2', '192.168.1.9', '192.168.1.10'],
    '应按数值排序，实际 ' + ips.join(','));
});

t('合并时过滤 .255 与 .0', () => {
  const r = L.mergeDevices({
    arp: [{ ip: '192.168.1.255', mac: 'aa-bb-cc-dd-ee-ff' }],
    pinged: ['192.168.1.0'], selfIp: '192.168.1.100',
  });
  assert.strictEqual(r.length, 0, '网络边界地址不该被当成设备');
});

t('主机名能被带上', () => {
  const r = L.mergeDevices({
    arp: [{ ip: '192.168.1.5', mac: 'aa-bb-cc-dd-ee-ff' }],
    pinged: [], selfIp: '',
    names: { '192.168.1.5': 'DESKTOP-ABC' },
  });
  assert.strictEqual(r[0].name, 'DESKTOP-ABC');
});

/* ---------- 诚实提示 ---------- */
t('提示里明确说明「结果可能不全」及原因', () => {
  const c = L.caveats({ arpOnly: 2, pingOnly: 1 }).join(' ');
  assert.ok(/可能不全/.test(c), '应提示可能不全');
  assert.ok(/防火墙/.test(c), '应解释防火墙会挡 ping');
  assert.ok(/休眠/.test(c), '应解释休眠设备可能不在表里');
  assert.ok(/\/24/.test(c), '应说明只扫 /24');
});

/* ---------- 多网卡：默认必须挑私有网段 ----------
 * 装了 VMware / Hyper-V / VirtualBox / WSL 的机器上，虚拟网卡常排在前面，
 * 早期取「第一个 IPv4」会去扫虚拟网段 —— 结果一台设备都没有，
 * 用户以为工具坏了；本机在公网地址上还会去打别人的 /24。 */
const REAL_IPCONFIG = [
  'Windows IP 配置',
  '',
  '以太网适配器 以太网:',
  '',
  '   连接特定的 DNS 后缀 . . . . . . . : ',
  '   IPv4 地址 . . . . . . . . . . . . : 10.1.2.30',
  '',
  '以太网适配器 VMware Network Adapter VMnet8:',
  '',
  '   IPv4 地址 . . . . . . . . . . . . : 192.168.218.1',
  '',
  '无线局域网适配器 WLAN:',
  '',
  '   IPv4 地址 . . . . . . . . . . . . : 192.168.1.55',
].join('\n');

t('parseIpconfig 收集全部 IPv4 而不是只取第一个', () => {
  const list = L.parseIpconfig(REAL_IPCONFIG);
  assert.strictEqual(list.length, 3, '应解析出 3 个地址，实际 ' + list.length);
  const ips = list.map((x) => x.ip);
  assert.deepStrictEqual(ips, ['10.1.2.30', '192.168.218.1', '192.168.1.55']);
});

t('parseIpconfig 带上所属网卡名', () => {
  const list = L.parseIpconfig(REAL_IPCONFIG);
  assert.ok(/VMware/i.test(list[1].adapter), '第二个应归属 VMware 网卡，实际 ' + list[1].adapter);
  assert.ok(/WLAN|无线/i.test(list[2].adapter), '第三个应归属 WLAN，实际 ' + list[2].adapter);
});

t('英文 ipconfig 也能解析（IPv4 Address）', () => {
  const list = L.parseIpconfig('Ethernet adapter Ethernet:\n   IPv4 Address. . . . . . . . . . . : 192.168.1.10\n');
  assert.strictEqual(list.length, 1, '英文输出应解析出 1 个，实际 ' + list.length);
  assert.strictEqual(list[0].ip, '192.168.1.10');
});

t('pickScanTarget 默认挑私有网段', () => {
  const pick = L.pickScanTarget(L.parseIpconfig(REAL_IPCONFIG));
  assert.ok(pick, '应挑出一个地址');
  assert.ok(L.isPrivateIp(pick.ip), '必须挑私有地址，实际 ' + pick.ip);
  assert.strictEqual(pick.ip, '10.1.2.30', '应按出现顺序挑第一个私有地址');
});

t('没有私有网段 → pickScanTarget 返回 null（让调用方明确报错，别照扫公网）', () => {
  const list = L.parseIpconfig('   IPv4 地址 . . . : 8.8.8.8\\n');
  const pick = L.pickScanTarget(list);
  assert.strictEqual(pick, null, '公网地址不该被当成可扫网段');
});

t('isPrivateIp 覆盖 10/8、172.16-31、192.168 三种私有段', () => {
  assert.strictEqual(L.isPrivateIp('10.0.0.1'), true);
  assert.strictEqual(L.isPrivateIp('172.16.5.5'), true);
  assert.strictEqual(L.isPrivateIp('172.31.9.9'), true);
  assert.strictEqual(L.isPrivateIp('192.168.1.1'), true);
});

t('isPrivateIp 拒绝非私有段（172.32 不属 172.16/12）', () => {
  assert.strictEqual(L.isPrivateIp('172.32.0.1'), false);
  assert.strictEqual(L.isPrivateIp('8.8.8.8'), false);
  assert.strictEqual(L.isPrivateIp('203.0.113.5'), false);
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
