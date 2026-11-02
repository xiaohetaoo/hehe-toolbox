#!/usr/bin/env node
'use strict';
/* 确保 Release 正文非空（发布流程的兜底步骤）。
 *
 * ============ 这个脚本为什么存在 ============
 * release.yml 里 softprops/action-gh-release 配了 generate_release_notes: true，
 * 但实测 **v0.3.7 的 Release body 是 null**，而 v0.3.6 / v0.3.5 / v0.2.8
 * 都有正文（3386 / 1714 / 1380 字符）。
 *
 * 已排除的原因：
 *   · 配置没改过 —— git diff v0.3.6..v0.3.7 -- .github/workflows/release.yml 是空的
 *   · 权限够 —— permissions: contents: write
 *   · 步骤没失败 —— "Publish release with assets" 与 "Normalize release title" 都是 success
 *   · 不是我们的脚本覆盖的 —— fix-release-title.js 只 PATCH name 字段，不碰 body
 * 上游有同类 issue（softprops/action-gh-release#191「generate_release_notes」），
 * 属于那次 action 行为不稳定。
 *
 * 结论：**不能把「Release 有正文」寄托在第三方 action 的一个布尔参数上**。
 * 这个脚本在发布完成后跑一次，检查 body；为空就用 GitHub 的
 * generate-notes API 自己补上。与 fix-release-title.js 是同一套模式
 * （显式 JSON、回读校验、幂等、不改已正确的值）。
 *
 * ============ 为什么用 API 而不是让 action 再生成一次 ============
 * v0.2.6 那次曾用 `curl -d` 改 Release 标题，而 curl 的 -d 默认
 * Content-Type 是 x-www-form-urlencoded，GitHub 按表单解析拿不到对象、
 * 返回 200 但什么都没改，最后循环跑完判定失败，白挂一个红灯。
 * 所以这里统一走 fetch + 显式 application/json + 回读校验。
 *
 * 用法：
 *   node scripts/ensure-release-notes.js <tag>
 * 环境变量：GITHUB_TOKEN / GH_TOKEN（必需）、GITHUB_REPOSITORY（必需）
 */
const API = 'https://api.github.com';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function apiCall(repo, token, method, urlPath, body, accept) {
  const res = await fetch(`${API}/repos/${repo}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'hehe-toolbox-release-notes',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}

/** 取某个 tag 对应的 release（最多等一会儿，刚发布的可能还没索引到） */
async function findRelease(repo, token, tag) {
  for (let i = 0; i < 10; i++) {
    const r = await apiCall(repo, token, 'GET', `/releases/tags/${encodeURIComponent(tag)}`);
    if (r.ok && r.json) return r.json;
    if (r.status !== 404) {
      throw new Error('取 release 失败：HTTP ' + r.status + ' ' + String(r.text).slice(0, 200));
    }
    await sleep(2000);
  }
  return null;
}

/** 让 GitHub 生成本次相对上一个 tag 的 release notes */
async function generateNotes(repo, token, tag) {
  /* 先试 generate-notes（推荐，会按 PR 分类）；
   * 失败再退回 /releases 的 generate_release_notes（按 commit 生成）。 */
  const byTag = await apiCall(
    repo, token, 'POST', `/releases/generate-notes`,
    { tag_name: tag }, 'application/vnd.github+json'
  );
  if (byTag.ok && byTag.json && byTag.json.body) return byTag.json.body;

  const alt = await apiCall(
    repo, token, 'POST', `/releases`,
    { tag_name: tag, generate_release_notes: true, draft: true }, 'application/vnd.github+json'
  );
  if (alt.ok && alt.json && alt.json.body) {
    /* 顺手删掉这个临时草稿（它的唯一用途是拿到生成的正文） */
    if (alt.json.id) await apiCall(repo, token, 'DELETE', `/releases/${alt.json.id}`);
    return alt.json.body;
  }
  return '';
}

async function main() {
  const tag = process.argv[2];
  if (!tag) { console.error('用法：node scripts/ensure-release-notes.js <tag>'); process.exit(1); }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token) { console.error('缺少 GITHUB_TOKEN / GH_TOKEN'); process.exit(1); }
  if (!repo) { console.error('缺少 GITHUB_REPOSITORY'); process.exit(1); }

  const rel = await findRelease(repo, token, tag);
  if (!rel) { console.error('找不到 release：' + tag); process.exit(1); }

  const cur = String(rel.body || '');
  if (cur.trim()) {
    /* 已经有正文 —— 幂等退出，不改任何东西。
     * 这一点很重要：如果将来 action 又能自己生成了，这个脚本不能把它覆盖掉。 */
    console.log('[release-notes] ' + tag + ' 已有正文（' + cur.length + ' 字符），无需处理');
    return;
  }

  console.log('[release-notes] ' + tag + ' 的正文为空，尝试生成…');
  const body = await generateNotes(repo, token, tag);
  if (!body.trim()) {
    /* 【生成失败不能让发布流程变红】
     * 资产已经上传成功、用户能下载了；正文缺失是「说明不完整」，
     * 不是「发布失败」。打一行以 WARN 开头的日志让人看见即可，
     * 不要把已经成功的发布判成失败。
     * （对比：fix-release-title.js 失败时会挂红，因为标题与 tag 不一致
     *  会让用户按 tag 找包时对不上 —— 那是真问题。正文为空不是。） */
    console.log('WARN ' + tag + ' 的正文仍为空（generate-notes 没返回内容），请手动补充');
    return;
  }

  const patched = await apiCall(
    repo, token, 'PATCH', `/releases/${rel.id}`, { body }, 'application/vnd.github+json'
  );
  if (!patched.ok) {
    console.log('WARN 写入正文失败：HTTP ' + patched.status + ' ' + String(patched.text).slice(0, 200));
    return;
  }

  /* 回读校验：不能只信 PATCH 的返回码（v0.2.6 就是 200 但没生效） */
  const back = await apiCall(repo, token, 'GET', `/releases/${rel.id}`);
  const now = String((back.ok && back.json && back.json.body) || '');
  if (!now.trim()) {
    console.log('WARN 正文写入后回读仍为空');
    return;
  }
  console.log('[release-notes] 已补上正文（' + now.length + ' 字符）');
}

main().catch((e) => {
  /* 同样不挂红：见上面的说明 */
  console.log('WARN 补正文时出错：' + (e && e.message ? e.message : e));
});
