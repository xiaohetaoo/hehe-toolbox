#!/usr/bin/env node
'use strict';
/* 发布后的最终校验：tag 有 Release、且真的挂了两个产物。
 *
 * ============ 这个脚本为什么存在 ============
 * 2026-11-09 的 v0.6.9 发版暴露了一条很难察觉的失败路径：
 *   · tag 推了（git tag 与 push 都成功）
 *   · 但 CI 在「下载 electron 二进制」那一步失败，后续全部 skipped
 *   · 于是 Publish 步骤没跑 → **Release 根本不存在**
 * 而当时的两个兜底步骤（Normalize title / Ensure notes）都是 `if: always()`，
 * 它们照样执行、照样打 WARN 退出 0，让人误以为"发布流程跑完了，只是有点警告"。
 *
 * 更早的 v0.2.6 是另一种形态：Release 创建了、包里也传了，但标题不对导致红灯，
 * 看日志的人分不清"发布成功了吗"。
 *
 * 所以加这一步：**用 GitHub 的最终状态反查**，而不是相信中间步骤的退出码。
 * 判据只有三条，都是用户能直接感知的事实：
 *   ① tag 对应的 Release 存在
 *   ② 它不是 draft（draft 用户看不见）
 *   ③ 恰好挂了预期的两个产物（Portable exe + zip），且都不是 0 字节
 *
 * 【为什么这一步必须挂红】
 * 与 Ensure notes 相反：正文不全是"说明不完整"，而"Release 不存在 / 没产物"
 * 是**用户拿不到东西**。那种情况必须让人看见，不能打一行 WARN 就算过。
 *
 * 用法：node scripts/verify-release.js <tag>
 * 环境变量：GITHUB_TOKEN / GH_TOKEN（必需）、GITHUB_REPOSITORY（必需）
 * 退出码：0 = 校验通过；非 0 = 有问题（明确列出缺什么）
 */
const API = 'https://api.github.com';
const WANT_SUFFIX = ['.exe', '.zip'];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function apiCall(repo, token, method, urlPath) {
  const res = await fetch(`${API}/repos/${repo}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'hehe-toolbox-verify-release',
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}

async function fetchRelease(repo, token, tag) {
  /* 刚 Publish 完的几秒内可能还没索引到，重试几次。
   * 超过约 20 秒仍 404 就不是"慢"，是真的没有。 */
  for (let i = 0; i < 8; i++) {
    const r = await apiCall(repo, token, 'GET', `/releases/tags/${encodeURIComponent(tag)}`);
    if (r.ok && r.json) return r.json;
    if (r.status !== 404) {
      throw new Error('读取 Release 失败：HTTP ' + r.status + ' ' + String(r.text).slice(0, 200));
    }
    if (i < 7) await sleep(2500);
  }
  return null;
}

async function main() {
  const tag = process.argv[2];
  if (!tag) { console.error('用法：node scripts/verify-release.js <tag>'); process.exit(1); }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token) { console.error('缺少 GITHUB_TOKEN / GH_TOKEN'); process.exit(1); }
  if (!repo) { console.error('缺少 GITHUB_REPOSITORY'); process.exit(1); }

  const rel = await fetchRelease(repo, token, tag);
  const problems = [];

  if (!rel) {
    /* 【这是本次要防的核心场景】
     * tag 在、Release 不在 = 用户按 tag 找不到任何可下载的东西。
     * 报错里要写清"tag 已推送但发布没完成"，避免有人以为 tag 也没了。 */
    console.error('::error::tag ' + tag + ' 已推送，但**没有对应的 Release**。'
      + '说明 Publish 步骤没跑成功（通常是更早的步骤失败导致 skipped）。'
      + '请检查 Actions 日志，修好后重跑。');
    process.exit(1);
  }

  if (rel.draft) {
    problems.push('Release 是 draft（用户看不见），应为已发布状态');
  }

  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  if (assets.length === 0) {
    problems.push('Release 存在但**一个产物都没有**（assets 为空）');
  }

  /* 【只认 .exe 与 .zip，且必须各至少一个】
   * GitHub 会额外生成 Source code (zip) / (tar.gz) 两个自动产物 ——
   * 它们不算数：那只是源码快照，不是能直接运行的便携版。
   * 所以这里必须看文件名后缀，不能只看 assets.length。 */
  const named = assets.filter((a) => WANT_SUFFIX.some((suf) => String(a.name || '').endsWith(suf)));
  const hasExe = named.some((a) => String(a.name).endsWith('.exe'));
  const hasZip = named.some((a) => String(a.name).endsWith('.zip'));
  if (!hasExe) problems.push('缺少 Portable .exe 产物');
  if (!hasZip) problems.push('缺少 .zip 产物');

  for (const a of named) {
    if (!a.size || a.size < 1024 * 1024) {
      problems.push('产物异常小（' + (a.size || 0) + ' B）：' + a.name);
    }
  }

  if (problems.length) {
    console.error('::error::Release ' + tag + ' 校验未通过：');
    for (const p of problems) console.error('  · ' + p);
    console.error('  当前 assets：' + (assets.map((a) => a.name + '(' + a.size + 'B)').join(', ') || '(空)'));
    process.exit(1);
  }

  console.log('OK Release ' + tag + ' 校验通过');
  console.log('   页面：' + (rel.html_url || ''));
  for (const a of named) {
    console.log('   - ' + a.name + '  ' + (a.size / 1048576).toFixed(1) + ' MB');
  }
}

main().catch((e) => {
  console.error('::error::校验发布结果时出错：' + (e && e.message ? e.message : e));
  process.exit(1);
});
