'use strict';
const { t, done, assert, readSrc, extractFn } = require('./lib/harness');
const path = require('path');
const { pathToFileURL } = require('url');
const { AsyncLocalStorage } = require('async_hooks');
const security = require('../lib/window-security');
const { scanBrace } = require('../lib/src-scan');
const root = path.resolve(__dirname, '..');
const source = readSrc('main.js', { raw: true });
const page = name => pathToFileURL(path.join(root, name)).href;

t('应用页面接受查询参数，拒绝目录前缀碰撞、外部 HTML、data 和网络 URL', () => {
  for (const name of ['index.html', 'splash.html', 'pin.html', 'snip.html', 'ruler.html']) {
    assert.strictEqual(security.isTrustedPage(page(name) + '?tool=hash#x', root), true);
  }
  for (const url of [page('other.html'), page('sub/index.html'), page('../other/index.html'), 'data:text/html,test', 'https://example.com', 'file://server/share/index.html', 'file://']) {
    assert.strictEqual(security.isTrustedPage(url, root), false, url);
  }
});

t('IPC 只接受受信任页面的主框架', () => {
  const frame = { url: page('index.html') }, sender = { mainFrame: frame };
  assert.strictEqual(security.isTrustedSender({ sender, senderFrame: frame }, root), true);
  assert.strictEqual(security.isTrustedSender({ sender, senderFrame: {url:frame.url} }, root), false);
  assert.strictEqual(security.isTrustedSender({ sender, senderFrame: {url:page('other.html')} }, root), false);
  assert.strictEqual(security.isTrustedSender({}, root), false);
});

t('真实 IPC 包装拒绝外部页面，关闭进程开关时两个结束进程通道都拒绝', async () => {
  const capStart = source.indexOf('const CAP_GATED_CHANNELS = {');
  const capOpen = source.indexOf('{', capStart);
  const caps = new Function('return ' + source.slice(capOpen, scanBrace(source, capOpen)))();
  const block = source.slice(source.indexOf('const handle = (ch, fn)'), source.indexOf('/* 执行外部命令的通用入口。'));
  const handlers = {}, calls = [];
  let enabled = false;
  const handle = new Function('ipcMain', 'CAP_GATED_CHANNELS', 'dangerousEnabled', 'dangerousDenied', 'dangerousDeniedAdvice', 'als', 'errorInfo', 'windowSecurity', '__dirname', block + ';return handle;')(
    {handle:(ch,fn)=>{handlers[ch]=fn;}}, caps, ()=>enabled, ()=> 'disabled', ()=> 'enable', new AsyncLocalStorage(), require('../lib/errors'), security, root);
  for (const ch of ['proc:kill', 'file:unlock', 'fs:read-text']) handle(ch, () => { calls.push(ch); return true; });
  const frame = {url:page('index.html')}, event = {sender:{mainFrame:frame},senderFrame:frame};
  for (const ch of ['proc:kill', 'file:unlock']) assert.strictEqual((await handlers[ch](event)).code, 'CAP_DENIED');
  enabled = true;
  assert.strictEqual((await handlers['file:unlock'](event)).ok, true);
  const external = {url:page('untrusted.html')};
  assert.strictEqual((await handlers['fs:read-text']({sender:{mainFrame:external},senderFrame:external})).code, 'UNTRUSTED_SENDER');
  assert.deepStrictEqual(calls, ['file:unlock']);
});

t('窗口拒绝所有页面发起的导航，权限只授予应用页面', () => {
  const events = {}, permissions = {};
  const wc = {url:page('index.html'), getURL(){return this.url;}, setWindowOpenHandler(fn){events.open=fn;}, on(name,fn){events[name]=fn;},
    session:{setPermissionRequestHandler(fn){permissions.request=fn;},setPermissionCheckHandler(fn){permissions.check=fn;}}};
  const window = {isDestroyed:()=>false,webContents:wc};
  const harden = new Function('fmtErr','windowSecurity','__dirname', extractFn(source,'function hardenWindow(')+';return hardenWindow;')(String,security,root);
  harden(window);
  for (const event of ['will-navigate','will-frame-navigate']) {
    let denied=false; events[event]({preventDefault(){denied=true;}},page('untrusted.html'));
    assert.strictEqual(denied,true);
  }
  assert.strictEqual(events.open().action,'deny');
  assert.strictEqual(permissions.check(wc,'media'),true);
  wc.url=page('untrusted.html');
  assert.strictEqual(permissions.check(wc,'media'),false);
  permissions.request(wc,'media',granted=>assert.strictEqual(granted,false));
});
done();
