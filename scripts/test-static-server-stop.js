'use strict';
/* server:stop 的时序结论：**不会 EADDRINUSE，旧传输自然完结，只有 status 短暂滞后**。
 *
 * ============ 为什么需要这个测试 ============
 * main.js 的 SERVER.STOP 里有一段长期挂着的「疑点，尚未复现」注释：
 * s.close() 是异步的，而紧接着就 serverMap.delete + 把端口置空。
 * 理论上「传输中点停止，再立刻启动」会撞 EADDRINUSE，甚至留下没人能 stop 的孤儿。
 *
 * 它一直没被证实也没被证伪，原因很具体：**只在进程外用 curl 试过**，
 * 而那样拿不到「端口何时真正释放」与「旧连接是否还活着」的时序。
 * 结论于是长期悬在空中，注释也就一直写着"待验证"。
 *
 * 这个测试把那段注释变成**可执行的结论**：
 *   · 在进程内起真服务器、真发请求、真限速；
 *   · 传到一半调 close()，并立刻同端口 listen；
 *   · 断言三件事：不 EADDRINUSE、旧传输收满、新服务器能绑上。
 * 哪天 Node / 平台改了这套语义（Linux 上 close 后立刻 listen 确实会 EADDRINUSE），
 * 这里会先红 —— 那时才需要真的去改 main.js。
 *
 * ============ 它测的是「平台语义」还是「我们的代码」 ============
 * 是前者，而且这是刻意的：main.js 里那段注释的结论本身就是**平台语义**的断言。
 * 我们不改代码的理由也正是它。所以测试的对象就是它，不是 main.js 的某一行。
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { t, done } = require('./lib/harness');

const BIG = path.join(os.tmpdir(), 'hehe-server-stop-probe-' + process.pid + '.bin');
const SIZE = 4 * 1024 * 1024;

t('SS1 close() 之后立刻同端口 listen 不会 EADDRINUSE（Windows 双绑定语义）', async () => {
  /* 锁的是：有人凭「close 是异步的」就断定一定会 EADDRINUSE，进而把
   * SERVER.STOP 改成「等 close 回调再清状态」—— 那样点停止要等当前传输跑完
   * 按钮才恢复，对用户是更糟的体验。这条把"不必改"的依据钉住。 */
  fs.writeFileSync(BIG, Buffer.alloc(SIZE, 7));
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': SIZE });
    fs.createReadStream(BIG).pipe(res);
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  let got = 0;
  let relistenErr = null;
  let relistenOk = false;

  await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.on('data', (d) => {
        got += d.length;
        /* 只在传到一半时动作一次：模拟「用户在传输进行中点停止」 */
        if (got > SIZE / 2 && !srv.__stopped) {
          srv.__stopped = true;
          res.pause();
          srv.close(() => {});
          setTimeout(() => {
            const srv2 = http.createServer((q, r) => r.end('ok'));
            srv2.once('error', (e) => { relistenErr = e.code; resolve(); });
            srv2.listen(port, '127.0.0.1', () => {
              relistenOk = true;
              srv2.close(() => {});
              res.resume();     // 恢复传输，验证旧连接没被打断
            });
          }, 100);
        }
      });
      res.on('end', () => resolve());
      res.on('error', () => resolve());
    });
    req.on('error', () => resolve());
  });

  try {
    /* 锁的是：close() 后立刻同端口 listen 报 EADDRINUSE —— 那时才需要改 SERVER.STOP。 */
    assert.strictEqual(relistenErr, null, '同端口重启失败了（' + relistenErr + '）—— 需要重新评估 SERVER.STOP');
    assert.strictEqual(relistenOk, true, '新服务器没能绑上端口');
    /* 锁的是：close() 把正在进行的传输截断了（用户下载到一半内容变短）。 */
    assert.strictEqual(got, SIZE, '旧传输被打断：收到 ' + got + '/' + SIZE + ' 字节');
  } finally {
    try { fs.unlinkSync(BIG); } catch (e) { /* 被占用则留给系统清理 */ }
  }
});

t('SS2 这个探针本身是有效的（能看见传输、也能看见端口冲突）', async () => {
  /* 【必须有这条对照】否则 SS1 通过可能只是因为探针失灵
   * （比如请求根本没发出去、got 恒为 0，assert.strictEqual(got, SIZE) 就会改成
   * 期望 0 而"通过"）。这里用一次真的端口冲突证明 listen 的失败是可见的。 */
  const a = http.createServer((q, r) => r.end('a'));
  await new Promise((r) => a.listen(0, '127.0.0.1', r));
  const port = a.address().port;
  const b = http.createServer((q, r) => r.end('b'));
  const err = await new Promise((resolve) => {
    b.once('error', (e) => resolve(e.code));
    b.listen(port, '127.0.0.1', () => resolve(null));
  });
  await new Promise((r) => a.close(r));
  try { b.close(() => {}); } catch (e) { /* 已失败则无需关 */ }
  /* 锁的是：探针看不见端口冲突 —— 那样 SS1 的"没有 EADDRINUSE"毫无意义。 */
  assert.strictEqual(err, 'EADDRINUSE', '探针看不到端口冲突，SS1 的结论不可信');
});

t('SS3 main.js 的注释与这个结论一致（不再写"尚未复现/待验证"）', () => {
  const { readSrc } = require('./lib/harness');
  /* 【必须 raw 读】readSrc 默认剥注释，而这里要验的**就是注释** ——
   * 用剥过注释的文本，两种断言都恒真/恒假。 */
  const src = readSrc('main.js', { raw: true });
  const i = src.indexOf('handle(CH.SERVER.STOP');
  assert.ok(i > 0, '找不到 SERVER.STOP');
  /* 只取 handler 开头往上一段（注释在 handler 内部，紧跟着 const s = ...） */
  const seg = src.slice(i, i + 2600);
  /* 锁的是：注释还停在"未复现"状态 —— 结论已经实测出来了，读者会继续
   * 以为这里有未解之谜，甚至有人去"顺手改掉"一个其实不该改的行为。 */
  assert.ok(!/尚未复现|未复现/.test(seg), '注释还写着"未复现"，与实测结论脱节');
  /* 锁的是：实测结论被删掉，只剩一句"不改" —— 后来者无从判断为什么。 */
  assert.ok(/EADDRINUSE/.test(seg), '注释里没有记下 EADDRINUSE 这个实测结论');
});

done();
