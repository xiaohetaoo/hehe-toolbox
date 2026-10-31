'use strict';
/* 局域网设备扫描的纯逻辑部分：ARP 表解析、网段计算、结果整理。
 *
 * 【为什么用 ARP 而不是只 ping】
 *   ping 只能发现「响应 ICMP 的主机」，而 Windows 默认防火墙会挡 ping，
 *   很多在线设备（手机、路由器、打印机）根本不回。ARP 是二层协议，
 *   只要设备在同一个网段且最近有过通信，ARP 表里就有它。
 *   所以正确做法是：先 ping 一轮（把 ARP 缓存催起来）→ 读 ARP 表 → 合并结果。
 *
 * 【为什么不能只读 ARP】
 *   ARP 表只包含「最近通信过」的设备，刚从休眠回来的设备可能不在表里。
 *   所以 ping 扫段仍要跑，只是结果可能不全 —— 这一点要在界面上说清楚。
 */

/**
 * 解析 `arp -a` 的输出。
 *
 * Windows 的输出形如（GBK 编码，中文标题）：
 *   接口: 192.168.1.100 --- 0x4
 *     Internet 地址         物理地址              类型
 *     192.168.1.1            b0-be-76-xx-xx-xx     动态
 *     192.168.1.5            00-1a-2b-xx-xx-xx     动态
 *     192.168.1.255          ff-ff-ff-ff-ff-ff     静态
 *
 * @param {string} stdout
 * @returns {Array<{ip:string, mac:string, type:string}>}
 */
function parseArp(stdout) {
  const text = String(stdout || '');
  const rows = [];
  const seen = new Set();

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;

    /* 匹配「IPv4 地址 + MAC + 类型」。
     * MAC 在 Windows 上是「6 段两位十六进制、用 - 连接」，也可能是冒号。
     * 【实测踩坑】早期写成 `\b(\d{1,2}...)` + `[0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5}`，
     * 在本机真实 arp 输出上匹配数为 0 —— \b 与前面多个空格组合、以及
     * {5} 分组计数都有问题。这里改成显式列举两种分隔符各 5 段的形式，
     * 已用真实输出验证可用。 */
    const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2}){5}|[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\s*(.*)$/.exec(t);
    if (!m) continue;

    const ip = m[1];
    const mac = m[2].replace(/:/g, '-').toLowerCase();
    const type = (m[3] || '').trim();

    /* 过滤掉明显不是设备的条目：
     *   - 广播地址 ff-ff-ff-ff-ff-ff（不是真实设备）
     *   - 全零 MAC
     *   - **组播/多播地址**：224.0.0.0/8（IPv4 组播）与 239.x.x.x（管理组播）
     *     这些是协议用的虚拟地址，不是任何一台设备。实测本机 ARP 表里
     *     就有 5 条 224.x/239.x 的静态项 —— 不过滤会让用户以为网里有十几个"设备"。
     *   - 本机自身地址（后面单独标记，用户想看的是"网里还有谁"） */
    if (mac === 'ff-ff-ff-ff-ff-ff') continue;
    if (mac === '00-00-00-00-00-00') continue;
    const firstOctet = Number(ip.split('.')[0]);
    if (firstOctet >= 224 && firstOctet <= 239) continue;   // 组播/多播
    if (seen.has(ip)) continue;
    seen.add(ip);
    rows.push({ ip, mac, type });
  }
  return rows;
}

/**
 * 从 IPv4 地址推导网段起始地址与广播地址（/24 段）。
 * 之所以固定 /24：家用/小办公室几乎都是 /24；
 * 做全 /16 或 /8 扫描会打到几万个地址，既慢又容易被当成攻击。
 *
 * @param {string} ip 例如 192.168.1.100
 * @returns {{network:string, first:string, last:string, broadcast:string}|null}
 */
function subnetOf(ip) {
  const parts = String(ip || '').trim().split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((x) => Number(x));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  const [a, b, c] = nums;
  return {
    network: a + '.' + b + '.' + c + '.0',
    first: a + '.' + b + '.' + c + '.1',
    last: a + '.' + b + '.' + c + '.254',
    broadcast: a + '.' + b + '.' + c + '.255',
  };
}

/**
 * 生成要 ping 的地址列表（排除广播与 .255）。
 * @param {string} ip 本机地址
 * @returns {string[]}
 */
function hostsToScan(ip) {
  const sub = subnetOf(ip);
  if (!sub) return [];
  const out = [];
  const parts = sub.network.split('.').map(Number);
  for (let i = 1; i <= 254; i++) {
    out.push(parts[0] + '.' + parts[1] + '.' + parts[2] + '.' + i);
  }
  return out;
}

/**
 * 把 ARP 结果与 ping 结果合并成设备列表。
 *
 * @param {object} p
 * @param {Array} p.arp parseArp 的结果
 * @param {Array<string>} p.pinged 回应了 ping 的 IP
 * @param {string} p.selfIp 本机 IP
 * @param {Object<string,string>} p.names IP → 主机名（可空）
 * @returns {Array<{ip, mac, type, source, name, scanme}>}
 */
function mergeDevices(p) {
  const x = p || {};
  const arp = x.arp || [];
  const pinged = new Set(x.pinged || []);
  const names = x.names || {};
  const selfIp = String(x.selfIp || '');

  const byIp = new Map();

  // 先放 ARP（信息最全：有 MAC）
  for (const a of arp) {
    if (/\.255$/.test(a.ip) || /\.0$/.test(a.ip)) continue;
    byIp.set(a.ip, {
      ip: a.ip, mac: a.mac, type: a.type,
      source: 'arp', name: names[a.ip] || null,
      isSelf: a.ip === selfIp,
    });
  }
  // 再把只 ping 通、但 ARP 里没有的补上（MAC 未知）
  for (const ip of pinged) {
    if (byIp.has(ip)) {
      byIp.get(ip).source = 'arp+ping';
      continue;
    }
    if (/\.255$/.test(ip) || /\.0$/.test(ip)) continue;
    byIp.set(ip, {
      ip, mac: null, type: '',
      source: 'ping', name: names[ip] || null,
      isSelf: ip === selfIp,
    });
  }

  /* 排序：本机在最前，然后按 IP 数值升序（用户更容易对上路由器/网关的固定位置） */
  const list = [...byIp.values()].sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    const na = ipNum(a.ip), nb = ipNum(b.ip);
    return na - nb;
  });
  return list;
}

function ipNum(ip) {
  const parts = String(ip || '').split('.').map((x) => Number(x) || 0);
  if (parts.length !== 4) return 0;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

/**
 * 界面提示：说明「这个列表可能不全」以及为什么。
 * 诚实交代局限，比列出 3 台设备却让用户以为网里只有 3 台要好。
 *
 * @param {{total:number, arpOnly:number, pingOnly:number}} stats
 * @returns {string[]}
 */
function caveats(stats) {
  const s = stats || {};
  const out = [];
  out.push('结果可能不全：Windows 防火墙默认会挡掉 ping，很多手机、打印机也不回 ICMP，' +
    '它们只能靠 ARP 缓存被发现 —— 所以**刚从休眠回来的设备可能不在列表里**。');
  if ((s.arpOnly || 0) > 0) {
    out.push('有 ' + s.arpOnly + ' 台设备只在 ARP 表里出现（ping 不通），这是正常现象，不代表它离线。');
  }
  if ((s.pingOnly || 0) > 0) {
    out.push('有 ' + s.pingOnly + ' 台设备响应了 ping 但 ARP 表里没有 MAC —— 可能刚加入网络，稍后再扫一次会更全。');
  }
  out.push('只扫描本机所在的 /24 网段（即 xxx.xxx.xxx.1–254）。扫描更大的网段既慢，也容易被网络管理员当成扫描攻击。');
  return out;
}

/**
 * 是否是私有（内网）网段：10/8、172.16/12、192.168/16。
 * @param {string} ip 或网段地址
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  const nums = String(ip || '').split('.').map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * 从 ipconfig /all 的输出里找出**全部** IPv4 地址与所属网卡。
 *
 * 【为什么不能取第一个 IPv4】
 * 装了 VMware / Hyper-V / VirtualBox / WSL 的机器上，虚拟网卡经常排在前面，
 * 于是扫描就打到 192.168.x 的虚拟网段去了 —— 结果「一台设备都没有」，
 * 用户以为工具坏了。本机若在公网地址上，还会去打别人的 /24。
 * 所以这里收集全部候选，由调用方优先挑私有网段。
 *
 * ipconfig 的中文输出形如：
 *    以太网适配器 以太网:
 *       IPv4 地址 . . . . . . . . . . . . : 192.168.1.100
 *    无线局域网适配器 WLAN:
 *       IPv4 地址 . . . . . . . . . . . . : 10.0.0.5
 * 英文系统是 "IPv4 Address. . . :"。两种都认。
 *
 * @param {string} stdout
 * @returns {Array<{ip:string, adapter:string, isPrivate:boolean}>}
 */
function parseIpconfig(stdout) {
  const text = String(stdout || '');
  const out = [];
  const seen = new Set();
  let adapter = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    /* 网卡标题行：包含「适配器」或 adapter，且以冒号结尾（中文系统是「适配器 X:」） */
    if (/适配器|adapter/i.test(line) && /:$/.test(line) && !/IPv4/.test(line)) {
      adapter = line.replace(/:$/, '').replace(/(适配器|adapter)/i, '').trim() || line;
      continue;
    }
    const m = /IPv4\s*(?:地址|Address)[^:]*:\s*([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/i.exec(line);
    if (!m) continue;
    const ip = m[1];
    if (seen.has(ip)) continue;
    seen.add(ip);
    out.push({ ip, adapter, isPrivate: isPrivateIp(ip) });
  }
  return out;
}

/**
 * 挑出默认该扫的本机地址：优先第一个私有网段。
 *
 * @param {Array<{ip,adapter,isPrivate}>} list parseIpconfig 的结果
 * @returns {{ip:string, adapter:string}|null} 找不到私有地址就返回 null
 *   —— 调用方应明确报错，而不是退回去照扫一个公网 /24。
 */
function pickScanTarget(list) {
  const all = Array.isArray(list) ? list : [];
  const priv = all.filter((x) => x && isPrivateIp(x.ip));
  if (!priv.length) return null;
  return { ip: priv[0].ip, adapter: priv[0].adapter || '' };
}

module.exports = { parseArp, subnetOf, hostsToScan, mergeDevices, ipNum, caveats,
  isPrivateIp, parseIpconfig, pickScanTarget };

