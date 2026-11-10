'use strict';
const {createSuite,assert,readSrc,extractFn,ROOT}=require('./lib/harness');
const {t,done}=createSuite({order:'sequential'});
const fs=require('fs'),path=require('path'),os=require('os'),Module=require('module');
const {EventEmitter}=require('events');
const {rmDir}=require('./lib/test-fs');
const CH=require('../lib/channels').CHANNELS;
async function mediaFixture(run, realFfmpeg = null) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hehe-media-session-'));
  const filename=path.join(ROOT,'ipc/media-ffmpeg.js'),localRequire=Module.createRequire(filename);
  const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));
  const captured=[];
  const spawn=(bin,args)=>{
    if (realFfmpeg) return require('child_process').spawn(bin,args,{windowsHide:true});
    captured.push(args);const proc=new EventEmitter();proc.pid=65000;proc.exitCode=null;
    proc.stdout=new EventEmitter();proc.stderr=new EventEmitter();
    const finish=()=>{if(proc.exitCode!==null)return;proc.exitCode=0;proc.emit('exit',0);proc.emit('close',0);};
    proc.stdin={write:()=>setImmediate(finish)};proc.kill=()=>{setImmediate(finish);return true;};
    fs.writeFileSync(args[args.length-1],'SEGMENT-'+captured.length);
    if(!args.includes('gdigrab'))setImmediate(finish);
    return proc;
  };
  mod.require=name=>name==='electron'?{dialog:{}}:name==='child_process'?{...require('child_process'),spawn}:name==='../lib/spawn-detached'?{spawnDetached:()=>null}:localRequire(name);
  const handlers={},jobs=new Map();let seq=0;
  // Timer injection avoids waiting on real recording startup; no device/process is used.
  new Function('require','module','exports','__dirname','__filename','setTimeout','clearTimeout',readSrc('ipc/media-ffmpeg.js',{raw:true}))(
    mod.require,mod,mod.exports,path.dirname(filename),filename,(fn,ms)=>setTimeout(fn,Math.min(ms,20)),clearTimeout);
  mod.exports({jobs,isWin:true,nextJobSeq:()=>++seq},{
    handle:(ch,fn)=>{handlers[ch]=fn;},pathExists:async p=>fs.existsSync(p),send:()=>{},fmtErr:String,
    runCmd:async(bin,args)=>{
      if(args.includes('concat')) {
        const list=await fs.promises.readFile(args[args.indexOf('-i')+1],'utf8');
        const parts=await Promise.all(list.split('\n').filter(Boolean).map(line=>fs.promises.readFile(line.slice(6,-1),'utf8')));
        await fs.promises.writeFile(args[args.length-1],parts.join('|'));
      }
      return {code:0,stdout:'{"format":{"duration":"1"}}',stderr:''};
    },
    storeGet:(key,fallback)=>['settings.ffmpegPath','settings.ffprobePath'].includes(key)?(realFfmpeg||process.execPath):key==='settings.hwAccel'?false:fallback,
    storeSet:()=>{},moveFile:fs.promises.rename,uniqueTarget:()=>{},setLatestCancelable:()=>{},
    tempDir:()=>root,userDataDir:()=>root,pathGuard:require('../lib/path-guard'),tempNames:require('../lib/temp-names'),targetSize:require('../lib/target-size'),AdmZip:require('adm-zip'),downloadToFile:()=>{},
  });
  try{await run({root,handlers,captured});}finally{rmDir(root);}
}
t('静音转换只移除音频，保留视频流',()=>mediaFixture(async({root,handlers,captured})=>{
  const input=path.join(root,'input.mp4');fs.writeFileSync(input,'fixture');
  const result=await handlers[CH.FFMPEG.CONVERT]({}, {items:[input],outDir:path.join(root,'out'),opts:{format:'mp4',mute:true,vcodec:'copy'}});
  assert.strictEqual(result.results[0].ok,true);assert.ok(captured[0].includes('-an'));assert.strictEqual(captured[0].includes('-vn'),false);
}));
t('纯音频格式都移除视频流，普通视频保留视频流',()=>mediaFixture(async({root,handlers,captured})=>{
  const input=path.join(root,'input.mp4');fs.writeFileSync(input,'fixture');
  for (const format of ['mp3','m4a','wav','flac','mp4']) {
    const result=await handlers[CH.FFMPEG.CONVERT]({}, {items:[input],outDir:path.join(root,format),opts:{format,vcodec:'copy'}});
    assert.strictEqual(result.results[0].ok,true);
    assert.strictEqual(captured[captured.length-1].includes('-vn'),format!=='mp4',format);
  }
}));
if (process.env.HEHE_TEST_FFMPEG) t('真实 FFmpeg 对合成视频静音后仍有视频且无音轨',()=>mediaFixture(async({root,handlers})=>{
  const {promisify}=require('util');
  const execFile=promisify(require('child_process').execFile);
  const input=path.join(root,'synthetic.mp4');
  await execFile(process.env.HEHE_TEST_FFMPEG,['-v','error','-f','lavfi','-i','color=size=64x64:rate=5:duration=1',
    '-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac','-shortest',input],{windowsHide:true});
  const result=await handlers[CH.FFMPEG.CONVERT]({}, {items:[input],outDir:path.join(root,'out'),opts:{format:'mp4',mute:true,vcodec:'copy'}});
  assert.strictEqual(result.results[0].ok,true);
  const probe=path.join(path.dirname(process.env.HEHE_TEST_FFMPEG),process.platform==='win32'?'ffprobe.exe':'ffprobe');
  const {stdout}=await execFile(probe,['-v','error','-show_entries','stream=codec_type','-of','json',result.results[0].out],{windowsHide:true});
  assert.deepStrictEqual(JSON.parse(stdout).streams.map(s=>s.codec_type),['video']);
},process.env.HEHE_TEST_FFMPEG));
t('启动中及暂停的会话均阻止新录制，其他窗口不能控制会话',()=>mediaFixture(async({root,handlers})=>{
  const owner={sender:{id:1}},other={sender:{id:2}},out=path.join(root,'first.mp4');
  const first=handlers[CH.REC.START](owner,{outPath:out,fps:5});
  await assert.rejects(()=>handlers[CH.REC.START](other,{outPath:path.join(root,'second.mp4')}),/会话/);
  await first;
  await assert.rejects(()=>handlers[CH.REC.PAUSE](other),/另一个窗口/);
  await handlers[CH.REC.PAUSE](owner);
  await assert.rejects(()=>handlers[CH.REC.START](other,{outPath:path.join(root,'second.mp4')}),/会话/);
  await handlers[CH.REC.RESUME](owner);
  await assert.rejects(()=>handlers[CH.REC.RESUME](owner),/已经在录制/);
  const saved=await handlers[CH.REC.STOP](owner,false);assert.strictEqual(saved.outPath,out);
  assert.strictEqual(await fs.promises.readFile(out,'utf8'),'SEGMENT-1|SEGMENT-2');
  await handlers[CH.REC.START](other,{outPath:path.join(root,'second.mp4')});
  await handlers[CH.REC.STOP](other,false);
  assert.strictEqual(fs.existsSync(path.join(root,'second.mp4')),true);
}));
t('JSON 排序保留 __proto__、constructor 和嵌套字段',()=>{
  const source=readSrc('js/tools/json-regex.js',{raw:true});
  const sort=new Function(extractFn(source,'function sortKey(')+';return sortKey;')();
  const input=JSON.parse('{"__proto__":{"x":1},"constructor":2,"nested":[{"__proto__":"value","b":2,"a":1}]}');
  const output=sort(input);assert.deepStrictEqual(JSON.parse(JSON.stringify(output)),input);
  assert.strictEqual(Object.getPrototypeOf(output),Object.prototype);
  assert.deepStrictEqual(Object.keys(output.nested[0]),['__proto__','a','b']);
});
done();
