'use strict';
/* 结构化错误：稳定的错误码 + 友好说明 + 建议操作。
 *
 * 借鉴 YourCatFileAssistant 的 ConversionError 设计：
 *   错误对象同时携带「给用户看的说明」和「给开发者看的诊断」，
 *   界面默认只展示说明与建议，技术细节折叠在"高级"里。
 *
 * 核核现状：handler 抛 new Error(中文语句)，渲染端 toast 原文。
 * 问题在于同一类失败（磁盘满、权限、占用）散落在各处、措辞不一，
 * 用户拿不到"下一步该做什么"，也无法据此做程序化判断。
 *
 * 本模块把常见失败映射成 (code, message, advice) 三元组，
 * 并提供 toPayload() 供 IPC 信封携带结构化信息。
 */

const CODES = {
  DISK_FULL: { code: 'DISK_FULL', advice: '清理目标磁盘空间后重试，或换一个输出目录' },
  PERMISSION: { code: 'PERMISSION', advice: '换到有写入权限的目录，或以管理员身份运行' },
  FILE_LOCKED: { code: 'FILE_LOCKED', advice: '关闭正在占用该文件的程序后重试' },
  NOT_FOUND: { code: 'NOT_FOUND', advice: '确认文件仍然存在、路径未被移动' },
  INVALID_INPUT: { code: 'INVALID_INPUT', advice: '检查输入格式是否符合该工具要求' },
  ENGINE_MISSING: { code: 'ENGINE_MISSING', advice: '先到「FFmpeg 环境」或相应设置页安装所需引擎' },
  TOO_LARGE: { code: 'TOO_LARGE', advice: '目标体积过小，换更大的目标或缩短内容' },
  CANCELLED: { code: 'CANCELLED', advice: '任务已按你的操作停止' },
  UNKNOWN: { code: 'UNKNOWN', advice: '可展开技术详情用于排查' }
};

/* 从 Node 错误对象推断稳定错误码。按 errno/code 字段判断，不看中文文案。 */
function classify(err) {
  const raw = (err && (err.code || err.errno || '')) + '';
  const msg = (err && err.message) || String(err || '');
  if (/ENOSPC/.test(raw) || /no space left/i.test(msg)) return CODES.DISK_FULL;
  if (/EACCES|EPERM/.test(raw) || /permission denied|拒绝访问/i.test(msg)) return CODES.PERMISSION;
  if (/EBUSY/.test(raw) || /resource busy|being used by another|正被占用/i.test(msg)) return CODES.FILE_LOCKED;
  if (/ENOENT/.test(raw) || /no such file|找不到/i.test(msg)) return CODES.NOT_FOUND;
  if (/已取消|ABORTED|cancel/i.test(msg)) return CODES.CANCELLED;
  if (/未找到 ffmpeg|未找到 ffprobe|未找到 7z/i.test(msg)) return CODES.ENGINE_MISSING;
  if (/目标体积|码率仅剩|无法压到目标/i.test(msg)) return CODES.TOO_LARGE;
  return CODES.UNKNOWN;
}

/**
 * 构造结构化错误载荷。
 * @param {Error|string} err 原始错误
 * @param {object} [extra]   额外字段（如 stage、file）
 * @returns {{code:string, message:string, advice:string, detail:string, stage?:string, file?:string}}
 */
function toPayload(err, extra = {}) {
  const base = classify(err);
  const message = (err && err.message) || String(err || '未知错误');
  return Object.assign({
    code: base.code,
    message,
    advice: base.advice,
    // detail 只给"需要排查的人"看，界面上折叠
    detail: (err && err.stack) ? String(err.stack).split('\n').slice(0, 6).join('\n') : message
  }, extra);
}

/** 把结构化载荷渲染成一段可读文本（用于 alertBox / 列表行）。 */
function format(payload) {
  const p = payload || {};
  let s = p.message || '操作失败';
  if (p.advice) s += '\n建议：' + p.advice;
  return s;
}

module.exports = { CODES, classify, toPayload, format };
