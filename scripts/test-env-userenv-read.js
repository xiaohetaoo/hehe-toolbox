'use strict';
/* 真实 PowerShell 读用户环境（只读、opt-in）。
 *
 * 默认跳过：CI/普通本地跑不碰真实注册表。
 * 需要验证编码修复时：HEHE_TEST_PS=1 node scripts/test-env-userenv-read.js
 *
 * 锁的是第五轮审查的 P0：readUserEnv 若没加强制 UTF-8，含中文的 PATH 会读成
 * 乱码（U+FFFD）—— 这里用「独立的一次注册表读取」做对照，两边必须逐字相等。
 */
const { t, done } = require('./lib/harness');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { execFile } = require('child_process');
const { rmDir } = require('./lib/test-fs');

const psSingleQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
/* 与 main.js runCmd 同样的形态（utf8 解码、windowsHide、超时） */
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 30000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      if (err && !stdout) reject(err);
      else resolve({ stdout: stdout || '', stderr: stderr || '', code });
    });
  });
}

const ENABLED = process.env.HEHE_TEST_PS === '1';

t('EU1 真实注册表：readUserEnv 与独立读取逐字一致（无乱码）', async () => {
  if (!ENABLED) {
    console.log('SKIP 需要 HEHE_TEST_PS=1 才读真实注册表');
    return;
  }
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'envps-'));
  const handlers = new Map();
  const store = new Map();
  const api = require('../ipc/env-manager')({}, {
    handle: (ch, fn) => handlers.set(ch, fn),
    jobs: new Map(),
    nextJobSeq: (() => { let n = 0; return () => ++n; })(),
    setLatestCancelable: () => {},
    downloadToFile: async () => {},
    userDataDir: () => ud,
    runCmd,
    storeGet: (k, d) => (store.has(k) ? store.get(k) : d),
    storeSet: (k, v) => { store.set(k, v); return true; },
    psSingleQuote: psSingleQuote,
    moveFile: async () => {},
  });
  try {
    const got = await api.readUserEnv();
    assert.strictEqual(typeof got.path, 'string');
    assert.ok(got.pathKind === 'String' || got.pathKind === 'ExpandString', 'pathKind 形态异常：' + got.pathKind);
    assert.ok(!/\uFFFD/.test(got.path), '读回的 PATH 含替换字符（编码坏了）');
    assert.ok(!/\uFFFD/.test(got.vars.JAVA_HOME || ''), 'JAVA_HOME 含替换字符');

    /* 独立读一次（同样加强制 UTF-8），两边逐字相等才算通过 */
    const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
      + '$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment"); '
      + 'if ($k -eq $null) { "" } else { [string]$k.GetValue("Path", "", '
      + '[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }';
    const expect = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(got.path, String(expect).replace(/\r?\n$/, ''), '与独立读取不一致');
  } finally {
    rmDir(ud);
  }
});

done();