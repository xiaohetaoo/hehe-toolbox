#!/usr/bin/env node
'use strict';
/* 确保 Release 正文是**有用的版本介绍**（发布流程的最后一步）。
 *
 * ============ 这个脚本为什么存在 ============
 * 最初的目标只是「正文别为空」，因为 v0.3.7 的 body 是 null。
 * 但 v0.3.8 发布后暴露出更深的问题：body 不空，却只有 86 个字符 ——
 *   **Full Changelog**: https://github.com/.../compare/v0.3.7...v0.3.8
 * 这仍然是「用户看不到这个版本做了什么」。而历史版本
 * v0.3.6 / v0.3.5 / v0.2.8 的正文是 3386 / 1716 / 1380 字符的实质内容。
 *
 * 所以判据从「非空」改成「够不够像一份说明」：
 *   · 空 → 需要补
 *   · 只有一行 changelog 链接（自动生成的兜底）→ 需要补
 *   · 已经是实质内容（≥ MIN_BODY 且不只含链接）→ 幂等跳过，不动它
 *
 * ============ 正文从哪来 ============
 * 优先级：
 *   1. 仓库里的 docs/release-notes/v<tag>.md（策划好的版本介绍，人工维护）
 *   2. GitHub 的 generate-notes API（兜底，至少给出 compare 链接）
 *
 * 为什么先看仓库文件：GitHub 自动生成的 notes 只有 PR 列表/commit 链接，
 * 而这个项目的发布说明需要写清「改了什么、为什么改、有什么已知限制」——
 * 那些信息在 commit message 里有，但自动 notes 不会替我们组织。
 *
 * ============ 为什么不用 curl ============
 * v0.2.6 那次用 `curl -d` 改 Release 标题：curl 的 -d 默认
 * Content-Type 是 x-www-form-urlencoded，GitHub 按表单解析拿不到对象、
 * 返回 200 但什么都没改，最后循环跑完判定失败、白挂一个红灯。
 * 所以统一走 fetch + 显式 application/json + 回读校验。
 *
 * 用法：node scripts/ensure-release-notes.js <tag>
 * 环境变量：GITHUB_TOKEN / GH_TOKEN（必需）、GITHUB_REPOSITORY（必需）
 */
const fs = require('fs');
const path = require('path');

const API = 'https://api.github.com';
/* 少于这个长度就认为「不是一份说明」。
 * 自动生成的纯 changelog 链接是 86 字符；而一份真正的版本介绍
 * 至少要讲清楚一两件事，1000 字符是很容易达到的下限。 */
const MIN_BODY = 400;

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

/** 取某个 tag 对应的 release（刚发布的可能还没索引到，重试几次） */
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

/** 现有正文是否「像一份说明」（而非空 / 纯链接） */
function isMeaningful(body) {
  const s = String(body || '').trim();
  if (!s) return false;
  if (s.length < MIN_BODY) return false;
  /* 只剩自动 changelog 链接的形态：整段去掉链接与空白后没剩什么 */
  const withoutLinks = s
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*\*\*Full Changelog\*\*:?\s*$/gim, '')
    .replace(/\s+/g, '');
  return withoutLinks.length >= MIN_BODY / 4;
}

/** 从仓库里读策划好的版本说明（存在则优先用它） */
function readPlannedNotes(tag) {
  const bare = String(tag).replace(/^v/i, '');
  const candidates = [
    path.join(process.cwd(), 'docs', 'release-notes', 'v' + bare + '.md'),
    path.join(process.cwd(), 'docs', 'release-notes', bare + '.md'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const t = fs.readFileSync(p, 'utf8').trim();
        if (t) { console.log('[release-notes] 使用仓库里的版本说明：' + p); return t; }
      }
    } catch (e) { /* 读不到就继续试下一个 */ }
  }
  return null;
}

/** 让 GitHub 生成一份 notes（兜底） */
async function generateNotes(repo, token, tag) {
  const byTag = await apiCall(
    repo, token, 'POST', '/releases/generate-notes',
    { tag_name: tag }, 'application/vnd.github+json'
  );
  if (byTag.ok && byTag.json && byTag.json.body) return byTag.json.body;
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
  if (!rel) {
    /* 【Release 不存在不是本脚本该判的失败】
     * 这一步在 workflow 里挂了 `if: always()`：必须在前面的步骤失败时也跑
     * （典型情形是"发了但正文空"）。但另一种情形是 Release 根本没创建
     * （Publish 被 skip，v0.6.9 就是这样）—— 那时这里 exit 1 会让日志最后
     * 一条红是"找不到 release"，把真正的失败（没有产物）盖在后面。
     *
     * 改成打印一行说明并正常退出。"没有 Release = 发布失败"由
     * scripts/verify-release.js 负责判：它会把「tag 有、Release 无」
     * 明确报成 ::error:: 并挂红。职责分开，日志才读得懂。
     *
     * 注意只影响"Release 不存在"这一种：Release 在但正文写不进去时，
     * 本脚本仍打 WARN 且不挂红（见下方说明）。 */
    console.log('[release-notes] ' + tag + ' 没有对应的 Release —— 跳过正文检查'
      + '（发布是否成功由 verify-release 判定）');
    return;
  }

  const cur = String(rel.body || '');
  if (isMeaningful(cur)) {
    /* 已经有实质说明 —— 幂等退出，一个字都不改。
     * 这条分支保证：将来有人手工写好正文、或 action 又能生成了，
     * 这个脚本不会把人工内容覆盖掉。 */
    console.log('[release-notes] ' + tag + ' 已有实质正文（' + cur.length + ' 字符），保持不变');
    return;
  }
  console.log('[release-notes] ' + tag + ' 的正文不够用（当前 ' + cur.length + ' 字符），准备补上');

  /* 优先用仓库里的策划稿；没有才退回自动生成 */
  let body = readPlannedNotes(tag);
  if (!body) {
    body = await generateNotes(repo, token, tag);
    if (body) console.log('[release-notes] 仓库里没有策划稿，使用 GitHub 自动生成的内容');
  }

  if (!body || !body.trim()) {
    /* 【生成失败不能让发布流程变红】
     * 资产已经上传成功、用户能下载了；正文缺失是「说明不完整」，
     * 不是「发布失败」。打一行 WARN 让人看见即可。
     * （对比：标题归一化失败会挂红 —— 标题与 tag 不一致会让用户按 tag
     *  找包时对不上，那是真问题。正文不够详细不是。） */
    console.log('WARN ' + tag + ' 没有可用的正文内容，请手动补充');
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
  if (!isMeaningful(now)) {
    console.log('WARN 正文写入后回读仍不合格（' + now.length + ' 字符）');
    return;
  }
  console.log('[release-notes] 已补上正文（' + now.length + ' 字符）');
}

main().catch((e) => {
  /* 同样不挂红：见上面对「正文缺失不是发布失败」的说明 */
  console.log('WARN 补正文时出错：' + (e && e.message ? e.message : e));
});
