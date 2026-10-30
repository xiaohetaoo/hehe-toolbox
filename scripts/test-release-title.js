'use strict';
/* Release 标题钉死的回归测试。
 *
 * 背景：v0.2.6 发布时 Release 本体成功（draft=false、2 个资产都 uploaded），
 * 但「Normalize release title」这一步挂了，标题停在 "0.2.6"。
 * 根因是那一步用 `curl -sf -X PATCH -d '{"name":"..."}'`，
 * curl 的 -d 默认把 Content-Type 写成 application/x-www-form-urlencoded，
 * GitHub 对 JSON 体按表单解析，返回 200 但 name 没改 → 循环 10 次后判失败。
 *
 * 这个测试起一个本地假 GitHub API：
 *   1) 断言脚本发来的 PATCH 体是合法 JSON，且 Content-Type 是 application/json；
 *   2) 只有 Content-Type 正确时才接受改写，否则学 GitHub 返回 200 但内容不变；
 *   3) 断言脚本最终退出码为 0 且回读到正确标题。
 * 这样「用 -d 发 JSON」这类坑在本地就能被抓住，不必再等 CI 挂红。
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'fix-release-title.js');
const TAG = 'v0.2.6';
const WANT = '核核工具箱 v0.2.6';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

/* 假 GitHub：记录每次请求；PATCH 只在 Content-Type 是 JSON 时真正改标题，
 * 否则模拟真实 GitHub 的行为——200 OK 但 name 保持不变。 */
function startFakeGithub({ initialName, honorFormBody = false, releases = null }) {
  const state = { name: initialName, requests: [], releaseId: 42 };
  // --all 模式用的列表；默认给两个 Release，其中一个标题是错的
  if (releases) state.releases = releases.map((r) => ({ ...r }));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const ct = String(req.headers['content-type'] || '');
      state.requests.push({ method: req.method, url: req.url, contentType: ct, body });

      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      // 列表：/releases?per_page=100&page=1
      if (req.method === 'GET' && /\/releases(\?|$)/.test(req.url) && state.releases) {
        return send(200, state.releases);
      }

      if (req.method === 'GET') {
        if (!req.url.includes('/releases/')) return send(404, { message: 'Not Found' });
        // 单个：/releases/42 或 /releases/tags/vX
        const byId = /\/releases\/(\d+)$/.exec(req.url);
        if (byId && state.releases) {
          const hit = state.releases.find((r) => String(r.id) === byId[1]);
          if (hit) return send(200, hit);
          return send(404, { message: 'Not Found' });
        }
        return send(200, {
          id: state.releaseId, tag_name: TAG, name: state.name,
          draft: false, html_url: 'http://example.invalid/release',
        });
      }

      if (req.method === 'PATCH' && /\/releases\/\d+$/.test(req.url)) {
        const id = Number(/\/releases\/(\d+)$/.exec(req.url)[1]);
        const isJson = ct.includes('application/json');
        let parsed = null;
        if (isJson || honorFormBody) {
          try { parsed = JSON.parse(body); } catch { parsed = null; }
        }
        if (parsed && typeof parsed.name === 'string') {
          if (state.releases) {
            const hit = state.releases.find((r) => r.id === id);
            if (hit) hit.name = parsed.name;
          }
          if (id === state.releaseId) state.name = parsed.name;
        }
        if (state.releases) {
          const hit = state.releases.find((r) => r.id === id);
          if (hit) return send(200, hit);
        }
        return send(200, { id, tag_name: TAG, name: state.name });
      }

      send(404, { message: 'Not Found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, port: server.address().port });
    });
  });
}

function runScript(env, args) {
  return new Promise((resolve) => {
    const argv = [SCRIPT, ...(args || [TAG])];
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

(async () => {
  /* ---- 用例 1：标题错了，脚本必须改对，且必须用 JSON 体 ---- */
  {
    const fake = await startFakeGithub({ initialName: '0.2.6' });
    const r = await runScript({
      HEHE_GH_API_BASE: `http://127.0.0.1:${fake.port}`,
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'fake-token',
    });
    fake.server.close();

    const patchReqs = fake.state.requests.filter((q) => q.method === 'PATCH');
    const getReqs = fake.state.requests.filter((q) => q.method === 'GET');

    t('发起了至少一次 PATCH', () => {
      assert.ok(patchReqs.length > 0, '一次 PATCH 都没发');
    });
    t('PATCH 的 Content-Type 是 application/json（而非 curl -d 的表单编码）', () => {
      for (const q of patchReqs) {
        assert.ok(q.contentType.includes('application/json'),
          `Content-Type 是 '${q.contentType}'，这正是 v0.2.6 挂红的根因`);
      }
    });
    t('PATCH 体是能解析出 name 的 JSON', () => {
      for (const q of patchReqs) {
        let b = null;
        try { b = JSON.parse(q.body); } catch { b = null; }
        assert.ok(b && typeof b.name === 'string', `PATCH 体不可用：'${String(q.body).slice(0, 120)}'`);
        assert.strictEqual(b.name, WANT);
      }
    });
    t('改写后回读了 Release（GET 校验）', () => {
      assert.ok(getReqs.length > 0, '没有回读校验');
    });
    t('假 GitHub 上的标题最终等于期望值', () => {
      assert.strictEqual(fake.state.name, WANT);
    });
    t('改写成功后退出码为 0', () => {
      assert.strictEqual(r.code, 0, `退出码 ${r.code}\n${r.stdout}\n${r.stderr}`);
    });
  }

  /* ---- 用例 2：标题本来就对，不该发 PATCH，直接成功退出 ---- */
  {
    const fake = await startFakeGithub({ initialName: WANT });
    const r = await runScript({
      HEHE_GH_API_BASE: `http://127.0.0.1:${fake.port}`,
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'fake-token',
    });
    fake.server.close();

    t('标题已正确时不发 PATCH（幂等，可重复跑）', () => {
      const patches = fake.state.requests.filter((q) => q.method === 'PATCH');
      assert.strictEqual(patches.length, 0, `不该改标题却发了 ${patches.length} 次 PATCH`);
    });
    t('标题已正确时退出码为 0', () => {
      assert.strictEqual(r.code, 0, `退出码 ${r.code}\n${r.stdout}\n${r.stderr}`);
    });
  }

  /* ---- 用例 3：服务端永远不接受改写 → 必须非 0 退出（不许假绿） ---- */
  {
    const fake = await startFakeGithub({ initialName: '0.2.6' });
    // 把 PATCH 全部改成不接受：用一个只会返回原值的 handlers 覆盖不易，
    // 改为让脚本打到会 500 的端口模拟持续失败。
    fake.server.close();

    const r = await runScript({
      HEHE_GH_API_BASE: 'http://127.0.0.1:9', // 保留端口，连接必失败
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'fake-token',
    });
    t('改写持续失败时退出码非 0（不假绿）', () => {
      assert.notStrictEqual(r.code, 0, `应当失败却退出 ${r.code}\n${r.stdout}\n${r.stderr}`);
    });
  }

  /* ---- 用例 4：缺 token / 缺 repo 必须立即失败 ---- */
  {
    const fake = await startFakeGithub({ initialName: '0.2.6' });
    const r1 = await runScript({
      HEHE_GH_API_BASE: `http://127.0.0.1:${fake.port}`,
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    });
    const r2 = await runScript({
      HEHE_GH_API_BASE: `http://127.0.0.1:${fake.port}`,
      GITHUB_REPOSITORY: '',
      GH_TOKEN: 'fake-token',
    });
    fake.server.close();

    t('缺 GH_TOKEN 时非 0 退出', () => {
      assert.notStrictEqual(r1.code, 0);
    });
    t('缺 GITHUB_REPOSITORY 时非 0 退出', () => {
      assert.notStrictEqual(r2.code, 0);
    });
  }

  /* ---- 用例 5：--all 模式把历史遗留的错误标题一次性归并 ---- */
  {
    const fake = await startFakeGithub({
      initialName: '0.2.6',
      releases: [
        { id: 1, tag_name: 'v0.2.6', name: '0.2.6', assets: [{ name: 'a' }] },
        { id: 2, tag_name: 'v0.2.1', name: '核核工具箱 v0.2.1', assets: [{ name: 'b' }] },
        { id: 3, tag_name: 'nightly', name: 'nightly', assets: [] },
      ],
    });
    const r = await runScript({
      HEHE_GH_API_BASE: `http://127.0.0.1:${fake.port}`,
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'fake-token',
    }, ['--all']);
    fake.server.close();

    t('--all 修正了错误标题', () => {
      const r26 = fake.state.releases.find((x) => x.tag_name === 'v0.2.6');
      assert.strictEqual(r26.name, '核核工具箱 v0.2.6');
    });
    t('--all 不动本来就对的标题（无多余 PATCH）', () => {
      const patchesToV21 = fake.state.requests.filter(
        (q) => q.method === 'PATCH' && /\/releases\/2$/.test(q.url));
      assert.strictEqual(patchesToV21.length, 0, 'v0.2.1 已经正确，不该被改');
    });
    t('--all 跳过非 vX.Y.Z 形式的 tag', () => {
      const patchesToNightly = fake.state.requests.filter(
        (q) => q.method === 'PATCH' && /\/releases\/3$/.test(q.url));
      assert.strictEqual(patchesToNightly.length, 0, 'nightly 不该被改');
    });
    t('--all 成功后退出码为 0', () => {
      assert.strictEqual(r.code, 0, `退出码 ${r.code}\n${r.stdout}\n${r.stderr}`);
    });
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
