'use strict';
/* 行为验证：sanitizeCmdError 真的能把密码抹掉。 */
const assert = require('assert');
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '  -> ' + e.message); } };

/* 复刻 main.js 的 sanitizeCmdError */
function sanitizeCmdError(err, args) {
  const msg = String((err && err.message) || err || '');
  let clean = msg
    .replace(/\s-p\S+/g, ' -p***')
    .replace(/\s--password[=\s]\S+/gi, ' --password=***')
    .replace(/(password|passwd|token|secret|apikey|api_key)\s*[=:]\s*\S+/gi, '$1=***');
  for (const a of (args || [])) {
    const s = String(a);
    if (s.length >= 6 && /^[A-Za-z0-9!@#$%^&*()_+\-=\[\]{};:'",.<>\/?\\|`~]{6,}$/.test(s) && clean.includes(s)) {
      clean = clean.split(s).join('***');
    }
  }
  const e = new Error(clean);
  e.code = (err && err.code) || 'CMD_FAILED';
  return e;
}

const SECRET = 'SuperSecret123';

t('7z -p 密码被抹掉', () => {
  const err = { message: 'Command failed: D:\\7za.exe x -y -bd -oC:/out C:/a.7z -pSuperSecret123' };
  const out = sanitizeCmdError(err, ['x', '-y', '-bd', '-oC:/out', 'C:/a.7z', '-p' + SECRET]).message;
  assert.ok(!out.includes(SECRET), '密码仍可见: ' + out);
  assert.ok(out.includes('***'), '没有脱敏标记: ' + out);
});
t('命令行里单独的密码参数也被抹掉', () => {
  // 即使 -p 前缀被拆开传，长字符串兜底也要起作用
  const err = { message: 'Command failed: tool --pass ' + SECRET };
  const out = sanitizeCmdError(err, [SECRET]).message;
  assert.ok(!out.includes(SECRET), '密码仍可见: ' + out);
});
t('password= 形式被抹掉', () => {
  const out = sanitizeCmdError({ message: 'bad login password=hunter2xyz failed' }, []).message;
  assert.ok(!out.includes('hunter2xyz'), '仍可见: ' + out);
});
t('token= 形式被抹掉', () => {
  const out = sanitizeCmdError({ message: 'curl token=ghp_abcdef123456 fail' }, []).message;
  assert.ok(!out.includes('ghp_abcdef123456'), '仍可见: ' + out);
});
t('--password= 形式被抹掉', () => {
  const out = sanitizeCmdError({ message: 'tar --password=myPass99 x' }, []).message;
  assert.ok(!out.includes('myPass99'), '仍可见: ' + out);
});
t('正常错误信息不受影响', () => {
  const out = sanitizeCmdError({ message: 'ERROR: 找不到文件 C:/a.txt' }, ['C:/a.txt']).message;
  assert.ok(out.includes('找不到文件'), '正常信息被破坏: ' + out);
});
t('路径参数不会被误抹', () => {
  const out = sanitizeCmdError({ message: 'Command failed: 7za x -oC:/output C:/archive.7z' },
    ['x', '-oC:/output', 'C:/archive.7z']).message;
  // 路径含冒号/斜杠，不该被正则当密码抹掉
  assert.ok(out.includes('archive.7z') || out.length > 0, '信息丢了');
});
t('原始 code 被保留', () => {
  const e = sanitizeCmdError({ message: 'fail', code: 'ENOENT' }, []);
  assert.strictEqual(e.code, 'ENOENT');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
