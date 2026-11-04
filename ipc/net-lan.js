'use strict';
/* 网络运维域：网卡信息 / 公网 IP / TCP 连通 / 局域网扫描 / 端口扫描 / HTTP 探测 / 测速。
 *
 * 【从 main.js 搬出来的原因】
 * main.js 一度 4600+ 行、114 个字面量通道，合并冲突面太大。
 * 这一批是**最内聚的一块**：全部与"本机网络"相关，依赖只有
 * handle / runCmd / jobs 三个外部能力，没有穿插别的域。
 *
 * 【拆分纪律】
 * · 整段照抄，只做机械替换（jobs 通过 deps 注入）
 * · handle 必须用注入的那个：CAP_GATED_CHANNELS 门禁只在 main.js 的包装层里，
 *   模块自己再定义一个 handle 会让这些通道绕过「高危功能」开关
 * · parseIpconfig 一并搬来（只有本域用）
 */

const os = require('os');
/* net / dns 在块内部按需 require（原文如此）。
 * 提到顶部反而让块内的 const net = require('net') 变成 no-shadow。 */
const lanScanLib = require('../lib/lan-scan');
const CH = require('../lib/channels').CHANNELS;   // IPC 通道名唯一来源

/**
 * @param {{handle: Function, runCmd: Function, jobs: Map,
 *          nextJobSeq: Function, setLatestCancelable: Function,
 *          send: Function, ps: Function}} ctx
 *
 * 【为什么这几个必须注入而不是自己实现】
 * · handle         —— CAP_GATED_CHANNELS 门禁只在 main.js 的包装层里
 * · nextJobSeq     —— 全局任务编号，各自编号会撞车（job:stream 靠它区分）
 * · setLatestCancelable —— 只允许取消"最近一个可取消任务"，是全局状态
 * · send           —— 主进程→渲染事件，必须用主窗口的 webContents
 * · ps             —— 执行 PowerShell 的统一封装（含超时/编码处理）
 */
module.exports = function register(ctx) {
  const {
    handle, runCmd, jobs,
    nextJobSeq, setLatestCancelable, send, ps,
  } = ctx;

/* ================= IPC: network ================= */
handle(CH.NET.INTERFACES, async () => {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      out.push({ name, family: a.family, address: a.address, mac: a.mac, internal: a.internal, cidr: a.cidr });
    }
  }
  let ipall = '';
  try { ipall = (await runCmd('ipconfig', ['/all'], { timeout: 15000, encoding: 'gbk' })).stdout; } catch (err) {}
  const info = parseIpconfig(ipall);
  return { addrs: out, adapters: info, hostname: os.hostname() };
});
function parseIpconfig(text) {
  // very tolerant parse of Chinese ipconfig /all
  const adapters = [];
  let cur = null;
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^[^\s].*:/.test(line) && !/^\s{2,}/.test(line)) {
      // adapter header contains 网卡/适配器 (zh) or adapter (en)
      if (/网卡|适配器|adapter/i.test(line) && line.includes(':')) {
        if (cur) adapters.push(cur);
        cur = { name: line.replace(/[:：].*$/, '').replace(/^\d+\.?/, '').trim(), status: '', ipv4: [], gateway: [], dns: [], dhcp: '', dhcpEnabled: '', mac: '', desc: '' };
        const m = line.match(/[:：]\s*(.*)$/); if (m && /已启用|已连接|connected/i.test(m[1])) cur.status = m[1].trim();
        continue;
      }
    }
    if (!cur) continue;
    const kv = line.match(/^\s*(.+?)\s*[.·]*\s*[:：]\s*(.*)$/);
    if (!kv) continue;
    const k = kv[1], v = kv[2].trim();
    if (/描述|Description/i.test(k)) cur.desc = v;
    else if (/物理地址|Physical Address/i.test(k)) cur.mac = v;
    else if (/DHCP 已启用/.test(k)) cur.dhcpEnabled = v;
    else if (/DHCP 服务器/.test(k)) cur.dhcp = v;
    else if (/IPv4/.test(k)) cur.ipv4.push(v.replace(/\(首选\)/, '').trim());
    else if (/默认网关|Default Gateway/i.test(k)) { if (v) cur.gateway.push(v); }
    else if (/DNS 服务器|DNS Servers/i.test(k)) { if (v) cur.dns.push(v); }
    else if (/媒体状态|Media State/i.test(k)) cur.status = v;
  }
  if (cur) adapters.push(cur);
  return adapters.filter(a => a.ipv4.length || a.mac);
}
handle(CH.NET.PUBLIC_IP, async () => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
    const j = await r.json();
    return { ip: j.ip };
  } finally { clearTimeout(t); }
});
handle(CH.NET.TCP_TEST, (e, host, port, timeoutMs = 4000) => {
  const net = require('net');
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (open) => { if (done) return; done = true; sock.destroy(); resolve({ open, ms: Date.now() - start }); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(parseInt(port, 10), host);
  });
});
/* ================= IPC: 局域网设备扫描 =================
 * 「网里有谁」—— 现有 net 模块只有「我这台机器」的视角（端口/连通/路由）。
 *
 * 【方法】ARP + ping 合并（原因见 lib/lan-scan.js 顶部注释）：
 *   1. 先并发 ping 一轮本机所在 /24 段，把 ARP 缓存催起来；
 *   2. 读 arp -a 拿到 IP + MAC（这是最可靠的来源）；
 *   3. 合并两者，ARP 为主、ping 补充。
 *
 * 【并发】复用 net:scan 的分批并发模型：254 个地址一次全发会打满句柄，
 * 按 20 个一批、每批等完成再下一批。
 */
handle(CH.LAN.SCAN, async (e, opts = {}) => {
  const net = require('net');
  const o = opts || {};

  /* 取本机 IPv4 与默认网关：用 ipconfig 而不是 WMI，因为 ipconfig 更稳且已在本项目里用了 */
  let selfIp = '';
  let adapterName = '';
  let ifaces = [];
  try {
    const r = await runCmd('ipconfig', ['/all'], { timeout: 15000, encoding: 'gbk' });
    const txt = String(r.stdout || '');
    /* 交给 lib 解析出**全部** IPv4 与网卡名，不再取第一个（见下方注释） */
    ifaces = lanScanLib.parseIpconfig(txt);
  } catch (err) { ifaces = []; }

  /* 【必须收集全部 IPv4 再挑，不能取第一个】
   * 装了 VMware / Hyper-V / VirtualBox / WSL 的机器上，虚拟网卡常排在前面，
   * 直接取第一个会去扫虚拟网段（结果「一台设备都没有」，用户以为工具坏了），
   * 本机在公网地址上还会去打别人的 /24。
   * 所以：解析全部候选 → 默认选第一个私有网段 → 没有私有网段就明确报错。
   * 渲染层也可以用 opts.ip 指定网卡（多网卡机器上要让用户能切换）。 */
  const wanted = String(o.ip || o.iface || '').trim();
  if (wanted) {
    const hit = ifaces.find((x) => x.ip === wanted || (x.adapter && x.adapter.indexOf(wanted) !== -1));
    if (hit) { selfIp = hit.ip; adapterName = hit.adapter || ''; }
  }
  if (!selfIp) {
    const pick = lanScanLib.pickScanTarget(ifaces);
    if (pick) { selfIp = pick.ip; adapterName = pick.adapter || ''; }
  }
  if (!selfIp) {
    /* 没有私有网段：明确报错，不要退回去照扫一个公网 /24。
     * 把找到了哪些地址一并说明，用户才知道为什么被拒。 */
    const found = ifaces.map((x) => x.ip).filter(Boolean);
    throw new Error('本机没有可扫描的私有网段（10/8、172.16/12、192.168/16）。' +
      (found.length
        ? '当前检测到的 IPv4：' + found.join('、') + '。请连回内网后重试。'
        : '未能从 ipconfig 读到任何 IPv4 地址，请检查网络连接。'));
  }

  const sub = lanScanLib.subnetOf(selfIp);
  if (!sub) throw new Error('本机 IP 不属于常规 IPv4 地址：' + selfIp);

  const hosts = lanScanLib.hostsToScan(selfIp);
  const id = 'lanscan' + (nextJobSeq());
  const cancelRef = { canceled: false };
  jobs.set(id, { cancel: () => { cancelRef.canceled = true; } });

  /* ---- 1) 并发 ping ---- */
  const pinged = [];
  const BATCH = 20;
  const TIMEOUT = 1200;
  let done = 0;

  async function pingOne(ip) {
    return new Promise((resolve) => {
      const s = new net.Socket();
      let finished = false;
      const fin = (ok) => {
        if (finished) return;
        finished = true;
        try { s.destroy(); } catch (err) {}
        resolve(ok);
      };
      s.setTimeout(TIMEOUT);
      s.once('connect', () => fin(true));
      s.once('timeout', () => fin(false));
      s.once('error', () => fin(false));
      try { s.connect(80, ip); } catch (err) { fin(false); }
      /* 用 TCP 80 而不是 ICMP ping：Node 没有原生 ICMP，
       * 且很多设备不响应 ICMP 但开了 80/443。
       * 端口不通不代表设备不在线 —— 那一部分靠 ARP 兜底，
       * 而「催 ARP 缓存」这个目的也达到了（连过就会进 ARP 表）。 */
    });
  }

  try {
    for (let i = 0; i < hosts.length; i += BATCH) {
      if (cancelRef.canceled) break;
      const slice = hosts.slice(i, i + BATCH);
      const res = await Promise.all(slice.map(pingOne));
      for (let k = 0; k < res.length; k++) if (res[k]) pinged.push(slice[k]);
      done += slice.length;
      send('job:progress', { id, kind: 'lan', done, total: hosts.length, found: pinged.length });
    }
  } finally {
    jobs.delete(id);
  }
  if (cancelRef.canceled) throw new Error('已取消');

  /* ---- 2) 读 ARP 表 ---- */
  let arpRows = [];
  try {
    const r = await runCmd('arp', ['-a'], { timeout: 15000, encoding: 'gbk' });
    arpRows = lanScanLib.parseArp(String(r.stdout || ''));
  } catch (err) { arpRows = []; }

  /* ---- 3) 反查主机名（只查前若干个，避免拖太久） ---- */
  /** @type {Record<string,string>} 反查到的设备名，按 IP 索引 */
  const names = {};
  const toResolve = arpRows.slice(0, 30);
  for (const row of toResolve) {
    if (cancelRef.canceled) break;
    try {
      const r = await ps(`(Resolve-DnsName -Name '${row.ip}' -NameType A -ErrorAction SilentlyContinue).NameHost`, 6000);
      const n = String(r.stdout || '').trim().split(/\r?\n/)[0];
      if (n && !/^\d+\./.test(n)) names[row.ip] = n;
    } catch (err) { /* 反查失败很常见，忽略即可 */ }
  }

  /* ---- 4) 合并 ---- */
  const devices = lanScanLib.mergeDevices({ arp: arpRows, pinged, selfIp, names });
  const arpOnly = devices.filter((d) => d.source === 'arp').length;
  const pingOnly = devices.filter((d) => d.source === 'ping').length;

  return {
    selfIp, subnet: sub, scanned: hosts.length,
    /* adapter：本机实际用的网卡名（多网卡时用户要知道扫的是哪张）
     * ifaces：全部候选地址，界面据此给一个网卡切换下拉 ——
     * 默认判断可能仍有偏差（比如虚拟网卡也报了私有段），让用户能自己改。 */
    adapter: adapterName || null,
    ifaces,
    devices,
    stats: { total: devices.length, arpOnly, pingOnly, pingedCount: pinged.length },
    caveats: lanScanLib.caveats({ arpOnly, pingOnly }),
  };
});

handle(CH.NET.SCAN, async (e, host, ports, opts = {}) => {
  const net = require('net');
  const concurrency = opts.concurrency || 300, timeout = opts.timeout || 500;
  const id = 'scanp' + (nextJobSeq());
  const cancelRef = { canceled: false };
  jobs.set(id, { cancel: () => { cancelRef.canceled = true; } });
  const open = [];
  let idx = 0, done = 0;
  async function worker() {
    while (!cancelRef.canceled) {
      const i = idx++;
      if (i >= ports.length) return;
      const port = ports[i];
      await new Promise((res) => {
        const s = new net.Socket();
        const fin = () => { s.destroy(); res(); };
        s.setTimeout(timeout); s.once('connect', () => { open.push(port); fin(); });
        s.once('timeout', fin); s.once('error', fin);
        try { s.connect(port, host); } catch (err) { fin(); }
      });
      done++;
      if (done % 100 === 0) send('job:progress', { id, kind: 'ports', done, total: ports.length, open: open.length });
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker));
  } finally { jobs.delete(id); }
  if (cancelRef.canceled) throw new Error('已取消');
  return { open: open.sort((a, b) => a - b), scanned: ports.length };
});
handle(CH.NET.HTTP, async (e, opts) => {
  const { method = 'GET', url, headers = {}, body, timeoutMs = 30000 } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const r = await fetch(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body, signal: ctrl.signal });
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.length > 1024 * 512 ? buf.toString('utf8', 0, 1024 * 512) + '\n…[已截断，共 ' + buf.length + ' 字节]' : buf.toString('utf8');
    return { status: r.status, statusText: r.statusText, /* Headers 在旧版 lib.dom 类型里没有 entries()；用 forEach 累加，
   * 运行时行为完全一致，且不受类型定义版本影响。 */
      headers: (function () { const h = {}; r.headers.forEach((val, key) => { h[key] = val; }); return h; })(), body: text, bytes: buf.length, ms: Date.now() - start };
  } finally { clearTimeout(timer); }
});
/* speedtest job */
handle(CH.NET.SPEEDTEST, async (e, { direction, url, seconds = 10 }) => {
  const id = 'speed' + (nextJobSeq());
  const ctrl = new AbortController();
  jobs.set(id, { cancel: () => ctrl.abort() });
  setLatestCancelable(() => ctrl.abort());
  const started = Date.now();
  try {
    if (direction === 'down') {
      const r = await fetch(url || 'https://speed.cloudflare.com/__down?bytes=104857600', { signal: ctrl.signal });
      if (!r.ok) throw new Error('测速服务器响应 ' + r.status);
      const reader = r.body.getReader();
      let bytes = 0, samples = [];
      let lastT = Date.now(), lastB = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        const now = Date.now();
        if (now - lastT > 300) {
          const inst = (bytes - lastB) / ((now - lastT) / 1000) * 8 / 1e6;
          samples.push({ t: now - started, mbps: inst });
          send('job:stream', { id, data: JSON.stringify({ bytes, elapsed: now - started, samples: samples.slice(-40) }) });
          lastT = now; lastB = bytes;
          if ((now - started) / 1000 > seconds + 5) break;
        }
      }
      const elapsed = (Date.now() - started) / 1000;
      return { mbps: bytes * 8 / 1e6 / elapsed, bytes, elapsed, samples };
    } else {
      const size = 10 * 1024 * 1024;
      const payload = Buffer.alloc(size, 1);
      const r = await fetch(url || 'https://speed.cloudflare.com/__up', { method: 'POST', body: payload, signal: ctrl.signal });
      await r.arrayBuffer();
      const elapsed = (Date.now() - started) / 1000;
      return { mbps: size * 8 / 1e6 / elapsed, bytes: size, elapsed, samples: [] };
    }
  } finally { jobs.delete(id); }
});
};
