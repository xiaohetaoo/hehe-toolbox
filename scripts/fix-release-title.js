#!/usr/bin/env node
/**
 * 把某个 tag 对应的 Release 标题钉死成「核核工具箱 <tag>」。
 *
 * 背景：softprops/action-gh-release 的 name 输入实测会被忽略，
 * v0.2.1 和 v0.2.6 发布后标题都变成了去掉 v 前缀的 tag（"0.2.1" / "0.2.6"），
 * 与既有的其他 Release（「核核工具箱 vX.Y.Z」）不一致。
 *
 * 为什么改成 node fetch 而不是 curl：
 * 之前用的是 `curl -sf -X PATCH -d '{"name":"..."}'`，而 curl 的 -d
 * 默认 Content-Type 是 application/x-www-form-urlencoded，中文 JSON 体
 * 被当成表单字段解析。GitHub 返回 200 OK，但 name 根本没改，
 * 于是脚本循环 10 次后判定失败、整个 Release workflow 挂红
 * （v0.2.6 就是这样：包已经发上去了，标题错了，CI 还是红的）。
 * 这里显式写 Content-Type: application/json，走 JSON 体，没有歧义。
 *
 * 用法：
 *   GH_TOKEN=xxx GITHUB_REPOSITORY=owner/repo node scripts/fix-release-title.js v0.2.6
 *   TAG=v0.2.6 / 首个位置参数 / 读 .github/release-title-target 三种取值顺序
 *
 * 退出码 0 表示标题已是期望值（已校验），非 0 表示没改成功。
 */

const fs = require('fs');
const path = require('path');

// 允许测试用本地假服务覆盖；生产默认打真实 GitHub
const API = (process.env.HEHE_GH_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
const WANT_PREFIX = '核核工具箱 ';
const MAX_ATTEMPTS = 10;
const RETRY_MS = 2000;

function log(msg) {
  console.log(msg);
}

// 不用 process.exit：fetch 的句柄还没释放，Node 在 Windows 上会撞
// libuv 断言（UV_HANDLE_CLOSING）直接崩成 3221226505，把「成功」也变成失败。
// 改成抛带退出码的错误，由 main().catch 统一处理并自然退出。
class Exit extends Error {
  constructor(code, msg) {
    super(msg || '');
    this.code = code;
  }
}

function fail(msg) {
  throw new Exit(1, msg);
}

function resolveTag() {
  const argvTag = process.argv[2];
  if (argvTag && argvTag.trim()) return argvTag.trim();
  if (process.env.TAG && process.env.TAG.trim()) return process.env.TAG.trim();
  // 兜底：读仓库里的目标文件，方便在没有 workflow_dispatch 输入的情况下触发
  const cf = path.join(__dirname, '..', '.github', 'release-title-target');
  if (fs.existsSync(cf)) {
    const t = fs.readFileSync(cf, 'utf8').split(/\r?\n/)[0].trim();
    if (t) return t;
  }
  return '';
}

function resolveToken() {
  return (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
}

function resolveRepo() {
  const fromEnv = (process.env.GITHUB_REPOSITORY || '').trim();
  if (fromEnv && fromEnv.includes('/')) return fromEnv;
  fail('缺少 GITHUB_REPOSITORY 环境变量（需要在 workflow 里跑，或手动指定 owner/repo）');
  return '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiCall(repo, token, method, urlPath, body) {
  const res = await fetch(`${API}/repos/${repo}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'hehe-toolbox-release-title',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

async function main() {
  const argvAll = process.argv.slice(2).includes('--all');
  const token = resolveToken();
  const repo = resolveRepo();

  if (!token) fail('缺少 GH_TOKEN / GITHUB_TOKEN');

  if (argvAll) return await normalizeAll(repo, token);

  const tag = resolveTag();
  if (!tag) fail('没有指定 tag（位置参数 / TAG 环境变量 / .github/release-title-target 都为空）');
  if (!/^v?\d+\.\d+\.\d+$/.test(tag)) fail(`tag 格式可疑：'${tag}'`);

  const want = WANT_PREFIX + (tag.startsWith('v') ? tag : 'v' + tag);
  const wantTag = tag.startsWith('v') ? tag : 'v' + tag;
  log(`repo=${repo} tag=${wantTag}`);
  log(`期望标题：${want}`);

  let got = '';
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const cur = await apiCall(repo, token, 'GET', `/releases/tags/${encodeURIComponent(wantTag)}`);
    if (cur.status === 404) {
      log(`第 ${i} 次：Release ${wantTag} 还不存在，等待中…`);
      await sleep(RETRY_MS);
      continue;
    }
    if (!cur.ok) {
      fail(`读取 Release 失败：HTTP ${cur.status} ${cur.text.slice(0, 300)}`);
    }
    got = (cur.json && cur.json.name) || '';
    if (got === want) {
      log(`标题已正确：${got}`);
      return 0;
    }

    log(`第 ${i} 次：当前标题 '${got}'，尝试改写…`);
    const patched = await apiCall(repo, token, 'PATCH', `/releases/${cur.json.id}`, { name: want });
    if (!patched.ok) {
      log(`  改写失败：HTTP ${patched.status} ${patched.text.slice(0, 300)}`);
    } else {
      // 不信 200，回读确认
      const back = await apiCall(repo, token, 'GET', `/releases/tags/${encodeURIComponent(wantTag)}`);
      got = (back.ok && back.json && back.json.name) || '';
      log(`  回读标题 '${got}'`);
      if (got === want) {
        log(`OK 标题已钉死：${got}`);
        log(`   ${(cur.json.html_url || '').trim()}`);
        return 0;
      }
    }
    await sleep(RETRY_MS);
  }

  fail(`标题未统一，实际 '${got}'，期望 '${want}'`);
}

/* --all：把仓库里所有 Release 的标题都归并成「核核工具箱 vX.Y.Z」。
 * 用途：历史上漏改的标题（v0.2.6 就是），补一次即可。
 * 幂等的条目不会发 PATCH，重复跑没有副作用。 */
async function normalizeAll(repo, token) {
  log(`repo=${repo} 模式=--all（归并全部 Release 标题）`);
  const failed = [];
  let checked = 0, fixed = 0;

  for (let page = 1; page <= 10; page++) {
    const list = await apiCall(repo, token, 'GET', `/releases?per_page=100&page=${page}`);
    if (!list.ok) fail(`列出 Release 失败：HTTP ${list.status} ${list.text.slice(0, 300)}`);
    const items = Array.isArray(list.json) ? list.json : [];
    if (items.length === 0) break;

    for (const rel of items) {
      checked++;
      const tag = rel.tag_name || '';
      if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
        log(`- ${tag}: 非 vX.Y.Z 形式的 tag，跳过`);
        continue;
      }
      const want = WANT_PREFIX + tag;
      const got = rel.name || '';
      if (got === want) {
        log(`- ${tag}: 标题已正确`);
        continue;
      }
      log(`- ${tag}: '${got}' -> '${want}'`);
      const patched = await apiCall(repo, token, 'PATCH', `/releases/${rel.id}`, { name: want });
      if (!patched.ok) {
        log(`    改写失败：HTTP ${patched.status} ${patched.text.slice(0, 200)}`);
        failed.push(tag);
        continue;
      }
      const back = await apiCall(repo, token, 'GET', `/releases/${rel.id}`);
      const now = (back.ok && back.json && back.json.name) || '';
      if (now === want) {
        log('    OK 回读确认');
        fixed++;
      } else {
        log(`    回读仍不对：'${now}'`);
        failed.push(tag);
      }
    }
    if (items.length < 100) break;
  }

  log(`共检查 ${checked} 个 Release，修正 ${fixed} 个，失败 ${failed.length} 个`);
  if (failed.length) fail(`以下 Release 标题仍未统一：${failed.join(', ')}`);
  return 0;
}

main()
  .then((code) => { process.exitCode = code || 0; })
  .catch((e) => {
    if (e instanceof Exit) {
      console.log(`::error::${e.message}`);
      console.error(e.message);
      process.exitCode = e.code;
    } else {
      const msg = `异常：${e && e.message ? e.message : e}`;
      console.log(`::error::${msg}`);
      console.error(msg);
      process.exitCode = 1;
    }
  });
