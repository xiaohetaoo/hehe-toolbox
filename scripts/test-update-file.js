'use strict';
const { t, done, assert, readSrc } = require('./lib/harness');
const { scanBrace } = require('../lib/src-scan');
const { verifyUpdateFile } = require('../lib/update-file');
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { rmDir } = require('./lib/test-fs');
const { segFromHandler } = require('./lib/seg-from-handler');
function executable() {
  const bytes=Buffer.alloc(128); bytes.write('MZ'); bytes.writeUInt32LE(64,0x3c); bytes.write('PE\0\0',64); return bytes;
}
async function fixture(fn) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'hehe-update-test-')); try{await fn(root);}finally{rmDir(root);} }
t('无摘要的旧版更新也必须满足可信大小和 PE 格式',()=>fixture(async root=>{
  const file=path.join(root,'new.exe'); fs.writeFileSync(file,executable());
  const result=await verifyUpdateFile(file,{assetSize:128,assetSha256:null});
  assert.strictEqual(result.size,128); assert.strictEqual(result.sha256,crypto.createHash('sha256').update(executable()).digest('hex'));
  fs.writeFileSync(file,''); await assert.rejects(()=>verifyUpdateFile(file,{assetSize:128}),/体积/);
  fs.writeFileSync(file,Buffer.alloc(128)); await assert.rejects(()=>verifyUpdateFile(file,{assetSize:128}),/可执行/);
}));
t('缺失大小、错误 PE 偏移和错误摘要均拒绝',()=>fixture(async root=>{
  const file=path.join(root,'new.exe'); const bytes=executable(); fs.writeFileSync(file,bytes);
  await assert.rejects(()=>verifyUpdateFile(file,{}),/大小/);
  await assert.rejects(()=>verifyUpdateFile(file,{assetSize:128,assetSha256:'a'.repeat(64)}),/SHA-256/);
  bytes.writeUInt32LE(0xffffffff,0x3c); fs.writeFileSync(file,bytes);
  await assert.rejects(()=>verifyUpdateFile(file,{assetSize:128}),/PE 头/);
}));
t('页面不能改写更新元数据或通过原型路径注入元数据',()=>{
  let handler; const writes=[];
  new Function('handle','CH','storeSet','broadcastUiPrefs',segFromHandler(readSrc('main.js',{raw:true}),'store:set')+');')(
    (ch,fn)=>{handler=fn;},require('../lib/channels').CHANNELS,(key,val)=>{writes.push([key,val]);return true;},()=>{});
  for(const key of ['updateCache','updateCache.payload','__proto__.updateCache','constructor.prototype.updateCache']) {
    assert.throws(()=>handler({},key,{assetSize:128}),/主进程/);
  }
  assert.strictEqual(handler({},'settings.fontSize',16),true);
  assert.deepStrictEqual(writes,[['settings.fontSize',16]]);
});
t('真实更新预检绑定主进程元数据；校验失败不生成脚本',()=>fixture(async root=>{
  const source=readSrc('main.js',{raw:true}); const start=source.indexOf('async function updateApplyImpl('), open=source.indexOf(') {',start)+2;
  const code=source.slice(start,scanBrace(source,open));
  const update=path.join(root,'update'); fs.mkdirSync(update);
  const file=path.join(update,'release.exe'); fs.writeFileSync(file,'');
  let metadata={assetName:'release.exe',assetSize:128,assetSha256:null};
  const fn=new Function('fs','fsp','path','crypto','app','psSingleQuote','updateFile','updateCacheGet','pathGuard', code+';return updateApplyImpl;')(
    fs,fs.promises,path,crypto,{getPath:key=>key==='exe'?path.join(root,'current.exe'):root},s=>"'"+s.replace(/'/g,"''")+"'",
    require('../lib/update-file'),()=>({payload:metadata}),require('../lib/path-guard'));
  await assert.rejects(()=>fn({newExe:file,dryRun:true}),/体积/);
  assert.strictEqual(fs.existsSync(path.join(update,'apply-update.ps1')),false);
  fs.writeFileSync(file,executable());
  metadata={...metadata,assetSha256:'f'.repeat(64)};
  await assert.rejects(()=>fn({newExe:file,expectSha256:null,dryRun:true}),/SHA-256/);
  metadata={...metadata,assetSha256:null};
  const result=await fn({newExe:file,dryRun:true}); assert.strictEqual(result.dryRun,true);
  // Only inspect generated text; do not run the PowerShell replacement script.
  const script=await fs.promises.readFile(result.script,'utf8');
  // 锁的是校验后文件被替换的回归；真实替换会退出应用、覆盖程序，因此只检查生成脚本中的预检及顺序。
  assert.ok(script.includes('Get-FileHash')); assert.ok(script.includes('$expectedSize = 128'));
  assert.ok(script.indexOf('Get-FileHash')<script.indexOf('Copy-Item'));
  // 锁的是预检失败时误恢复旧备份；真实更新不在本机执行，因此检查生成脚本的回滚条件。
  assert.ok(script.includes('$replacing -and'));
}));
done();
