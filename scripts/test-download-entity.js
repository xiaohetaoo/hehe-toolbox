'use strict';
const {createSuite,assert}=require('./lib/harness');
const {t,done}=createSuite({order:'sequential'});
const {download}=require('../lib/download');
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),zlib=require('zlib');
const {rmDir}=require('./lib/test-fs');
async function serve(responder,run) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hehe-download-test-')); const requests=[];
  const server=http.createServer((req,res)=>{requests.push(req.headers);responder(req,res,requests.length);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {await run({root,requests,url:`http://127.0.0.1:${server.address().port}/fixture`});}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmDir(root);}
}
/* 【为什么不能 res.write('AAAA') 后立刻定时 destroy】
 * write 的 4 字节只是进了 Node 的发送缓冲，destroy 在 50ms 后才执行 ——
 * 正常时 4 字节早已送达，但全量跑 185 个脚本时机器负载高，客户端可能
 * 只读到 3 字节连接就断了。于是断点保存为 3，第二个请求发
 * Range: bytes=3-，与断言 bytes=4- 不符，用例假失败。
 * 修法：用 res.flush() 确认 4 字节真的离开缓冲后再 destroy，
 * 并把兜底延时放大到 300ms（flush 回调本身就是确定性信号）。 */
function partial(res,etag) {
  res.writeHead(200,{'Content-Length':8,...(etag?{ETag:etag}:{})});
  res.write('AAAA', () => {
    if (typeof res.flush === 'function') {
      res.flush(() => setTimeout(() => res.destroy(), 100));
    } else {
      /* 没有 compression 中间件时 flush 可能不存在：给足缓冲排空时间 */
      setTimeout(() => res.destroy(), 300);
    }
  });
}
const get=(url,out,ctrl=new AbortController())=>download(url,out,'test',ctrl,'fixture',{pause:async()=>{}});
t('相同 ETag 才续传，并携带 If-Range',()=>serve((req,res,n)=>{
  if(n===1)partial(res,'"one"');else{res.writeHead(206,{'Content-Length':4,'Content-Range':'bytes 4-7/8',ETag:'"one"'});res.end('BBBB');}
},async({root,url,requests})=>{
  const out=path.join(root,'out');await get(url,out);assert.strictEqual(await fs.promises.readFile(out,'utf8'),'AAAABBBB');
  assert.strictEqual(requests[1].range,'bytes=4-');assert.strictEqual(requests[1]['if-range'],'"one"');
}));
t('资源换版时从头下载，不拼接旧前缀',()=>serve((req,res,n)=>{
  if(n===1)partial(res,'"one"');else{res.writeHead(200,{'Content-Length':8,ETag:'"two"'});res.end('CCCCDDDD');}
},async({root,url})=>{const out=path.join(root,'out');await get(url,out);assert.strictEqual(await fs.promises.readFile(out,'utf8'),'CCCCDDDD');}));
t('错误版本或错误 Content-Range 的 206 被丢弃',async()=>{
  for(const range of ['bytes 4-7/8','bytes 0-3/8'])await serve((req,res,n)=>{
    if(n===1)partial(res,'"one"');else if(n===2){res.writeHead(206,{'Content-Length':4,'Content-Range':range,ETag:'"two"'});res.end('DDDD');}
    else{res.writeHead(200,{'Content-Length':8,ETag:'"two"'});res.end('CCCCDDDD');}
  },async({root,url,requests})=>{
    const out=path.join(root,'out');await get(url,out);assert.strictEqual(await fs.promises.readFile(out,'utf8'),'CCCCDDDD');assert.strictEqual(requests[2].range,undefined);
  });
});
t('无资源验证器时重下，416 后也清除断点',async()=>{
  for(const validator of [null,'"one"'])await serve((req,res,n)=>{
    if(n===1)partial(res,validator);else if(n===2&&validator){res.writeHead(416);res.end();}
    else{res.writeHead(200,{'Content-Length':8});res.end('CCCCDDDD');}
  },async({root,url,requests})=>{
    const out=path.join(root,'out');await get(url,out);assert.strictEqual(await fs.promises.readFile(out,'utf8'),'CCCCDDDD');assert.strictEqual(requests[requests.length-1].range,undefined);
  });
});
t('服务端压缩响应按解码后的内容下载，不错误比较压缩长度',()=>serve((req,res)=>{
  const bytes=zlib.gzipSync('TEXT'.repeat(1000));res.writeHead(200,{'Content-Encoding':'gzip','Content-Length':bytes.length});res.end(bytes);
},async({root,url})=>{const out=path.join(root,'out');await get(url,out);assert.strictEqual(await fs.promises.readFile(out,'utf8'),'TEXT'.repeat(1000));}));
t('取消后关闭句柄；临时删除失败会重试且不残留',()=>serve((req,res)=>{
  res.writeHead(200,{'Content-Length':100000,ETag:'"one"'});res.write('AAAA');
},async({root,url})=>{
  const original=fs.promises.rm;let failures=0;
  fs.promises.rm=async(file,...args)=>{if(String(file).startsWith(root)&&failures++<2)throw Object.assign(new Error('busy'),{code:'EPERM'});return original.call(fs.promises,file,...args);};
  try{
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),100);
    await assert.rejects(()=>get(url,path.join(root,'out'),ctrl),/取消/);clearTimeout(timer);
    assert.deepStrictEqual(await fs.promises.readdir(root),[]);assert.ok(failures>=3);
  }finally{fs.promises.rm=original;}
}));
done();
