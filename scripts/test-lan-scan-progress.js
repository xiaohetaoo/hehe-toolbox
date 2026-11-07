'use strict';
/* 局域网扫描：DNS 反查阶段必须有进度，且两个阶段能被区分开。
 *
 * ============ 锁的是哪个回归 ============
 * LAN.SCAN 分三段：① 并发 ping 254 个地址（约 10 秒，有进度）
 *                 ② 读 ARP 表（快）
 *                 ③ 反查主机名，最多 30 个 IP × 每个最长 6 秒 = 最坏 90 秒
 * 而 ③ **一个进度事件都不发**。于是界面上进度条停在 100%、
 * 状态文字停在「扫描中 254/254」—— 从点完到出结果之间有整段空档，
 * 用户会以为卡死并反复点（而每次点击都是新一轮扫描）。
 *
 * 修法有两半，缺一不可：
 *   主进程：反查每个 IP 后发一次 job:progress（带 phase:'resolve'）
 *   渲染层：收到 phase==='resolve' 时换文案，否则会显示成「扫描中 3/30」
 *           —— 那看起来像扫描重头开始了，比不动更糟。
 *
 * ============ 为什么用真模块而不是读源码 ============
 * 这条缺陷的本质是「某个分支上有没有 send 调用」，只能靠跑一遍才知道。
 * 所以这里加载真的 ipc/net-lan.js（注入桩），驱动真的 handler，
 * 断言**收到的 job:progress 序列**。渲染层那一半没有可跑的 DOM，
 * 只能读源码形态，但它锁的是"文案分支存在"这个具体事实，不是版面。
 */
const assert = require('assert');
const path = require('path');
const { t, done, readSrc } = require('./lib/harness');

const ROOT = path.join(__dirname, '..');

/**
 * 加载真的 ipc/net-lan.js，返回通道名 → handler 的 Map 与推送记录。
 * 依赖一律用桩：这一条要验的是「什么时候发进度」，不是网络本身。
 */
function loadNetLan(overrides) {
  const reg = require(path.join(ROOT, 'ipc', 'net-lan'));
  const handlers = new Map();
  const progress = [];
  const jobs = new Map();
  let seq = 0;

  const ctx = Object.assign({
    handle: (ch, fn) => { handlers.set(ch, fn); },
    jobs,
    nextJobSeq: () => ++seq,
    setLatestCancelable: () => {},
    send: (ev, payload) => { if (ev === 'job:progress') progress.push(payload); },
    ps: async () => ({ stdout: '', stderr: '', code: 0 }),
    runCmd: async () => ({ stdout: '', stderr: '', code: 0 }),
  }, overrides || {});

  reg(ctx);
  return { handlers, progress, jobs };
}

/* 一台「只有私有网段、ARP 里有 3 台设备」的机器 */
const IPCONFIG = [
  'Windows IP 配置',
  '',
  '以太网适配器 以太网:',
  '',
  '   描述. . . . . . . . . . . . . . . : Realtek',
  '   物理地址. . . . . . . . . . . . . : B0-BE-76-12-AB-34',
  '   IPv4 地址 . . . . . . . . . . . . : 192.168.1.100(首选)',
  '   默认网关. . . . . . . . . . . . . : 192.168.1.1',
].join('\r\n');

const ARP = [
  '接口: 192.168.1.100 --- 0x4',
  '  Internet 地址         物理地址              类型',
  '  192.168.1.1           b0-be-76-12-ab-34     动态',
  '  192.168.1.5           00-1a-2b-3c-4d-5e     动态',
  '  192.168.1.20          3c-52-82-aa-bb-cc     动态',
].join('\r\n');

/** 把 ps/runCmd 换成这套固定输出，并让每个 IP 的 TCP 探测都失败（只靠 ARP 发现设备）。 */
function stubMachine(extra) {
  const o = extra || {};
  return Object.assign({
    runCmd: async (cmd) => {
      if (cmd === 'ipconfig') return { stdout: IPCONFIG, stderr: '', code: 0 };
      if (cmd === 'arp') return { stdout: ARP, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
    ps: async () => ({ stdout: '', stderr: '', code: 0 }),
  }, o);
}

t('LP1 反查阶段会持续发 job:progress（带 phase=resolve）', async () => {
  const { handlers, progress } = loadNetLan(stubMachine());
  const scan = handlers.get('lan:scan');
  /* 锁的是：整段反查一个进度事件都没有 —— 界面在最后 30 个 DNS 查询里完全静止。 */
  assert.ok(scan, '找不到 lan:scan handler');

  /* 【把 TCP 探测换成"立刻失败"】否则 254 个地址真的去连，
   * 每个等 1.2 秒超时，这条测试要跑十几分钟。 */
  const net = require('net');
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function () {
    const self = this;
    process.nextTick(() => { try { self.emit('error', new Error('stub')); } catch (e) {} });
    return this;
  };
  try {
    await scan({}, { ip: '192.168.1.100' });
  } finally {
    net.Socket.prototype.connect = origConnect;
  }

  const resolveEvents = progress.filter((p) => p.phase === 'resolve');
  /* 锁的是：反查阶段不发进度。3 台设备 → 至少要 3 条。 */
  assert.strictEqual(resolveEvents.length, 3,
    '反查阶段只发了 ' + resolveEvents.length + ' 条进度（应为 3 条，每台一条）');
  /* 锁的是：done 不递增/恒为 0 —— 那样进度条不动，等于没发。 */
  assert.deepStrictEqual(resolveEvents.map((p) => p.done), [1, 2, 3], 'done 没有递增');
  assert.ok(resolveEvents.every((p) => p.total === 3), 'total 不是设备台数');
  /* 锁的是：反查阶段丢了 found —— 界面上的「已发现 N 台」会归零。 */
  assert.ok(resolveEvents.every((p) => typeof p.found === 'number'), 'resolve 事件缺少 found 字段');
});

t('LP2 扫描阶段与反查阶段的 phase 能区分开', async () => {
  const { handlers, progress } = loadNetLan(stubMachine());
  const net = require('net');
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function () {
    const self = this;
    process.nextTick(() => { try { self.emit('error', new Error('stub')); } catch (e) {} });
    return this;
  };
  let r;
  try { r = await handlers.get('lan:scan')({}, { ip: '192.168.1.100' }); }
  finally { net.Socket.prototype.connect = origConnect; }

  const phases = [...new Set(progress.map((p) => p.phase))];
  /* 锁的是：两个阶段都不带 phase —— 渲染层只能按 done/total 猜，
   * 于是反查时会显示成「扫描中 3/30」，看起来像扫描重头开始。 */
  assert.deepStrictEqual(phases.sort(), ['resolve', 'scan'], 'phase 取值应为 scan 与 resolve，实际 ' + JSON.stringify(phases));
  /* 扫描阶段的 total 是 254（整个 /24），反查阶段是设备台数 —— 两者量级不同，
   * 渲染层正是靠 phase 而不是靠 total 来分辨的。 */
  const scanEvents = progress.filter((p) => p.phase === 'scan');
  assert.ok(scanEvents.length > 1, '扫描阶段应有多条进度');
  assert.strictEqual(scanEvents[scanEvents.length - 1].total, 254, '扫描阶段 total 应为 254');
  assert.ok(r && Array.isArray(r.devices), 'lan:scan 应返回 devices');
});

t('LP3 渲染层按 phase 分文案（否则会显示成"扫描中 3/30"）', () => {
  const src = readSrc('js/tools/lan-scan.js');
  /* 锁的是：渲染层不认 phase，所有进度都按「扫描中 x/y」显示 ——
   * 反查 30 个 IP 时会突然出现「扫描中 3/30」，用户以为扫描重来了。 */
  assert.ok(/d\.phase === 'resolve'/.test(src), '渲染层没有按 phase 区分反查阶段');
  /* 锁的是：反查阶段没有自己的文案（复用扫描阶段的串）。 */
  assert.ok(/正在反查主机名/.test(src), '没有反查阶段的文案');
});

t('LP4 反查阶段沿用同一条通道 kind=lan（不要另开一条）', async () => {
  const { handlers, progress } = loadNetLan(stubMachine());
  const net = require('net');
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function () {
    const self = this;
    process.nextTick(() => { try { self.emit('error', new Error('stub')); } catch (e) {} });
    return this;
  };
  try { await handlers.get('lan:scan')({}, { ip: '192.168.1.100' }); }
  finally { net.Socket.prototype.connect = origConnect; }

  /* 锁的是：反查阶段改发别的 kind（如 'lan-dns'）——
   * 渲染层只订阅 kind==='lan'，那些事件会被整段丢掉。 */
  assert.ok(progress.every((p) => p.kind === 'lan'), '出现了非 lan 的 kind：' + JSON.stringify([...new Set(progress.map((p) => p.kind))]));
});

done();
