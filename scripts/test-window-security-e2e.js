'use strict';
const { t, done, assert, ROOT } = require('./lib/harness');
const fs = require('fs'), os = require('os'), path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { rmDir } = require('./lib/test-fs');

async function probe(root, appRoot) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { AsyncLocalStorage } = require('async_hooks');
  const { readSrc, extractFn } = require(path.join(root, 'scripts/lib/harness'));
  const source = readSrc('main.js', { raw: true });
  const security = require(path.join(root, 'lib/window-security'));
  const wrapper = source.slice(source.indexOf('const handle = (ch, fn)'), source.indexOf('/* 执行外部命令的通用入口。'));
  const handle = new Function('ipcMain', 'CAP_GATED_CHANNELS', 'dangerousEnabled', 'dangerousDenied',
    'dangerousDeniedAdvice', 'als', 'errorInfo', 'windowSecurity', '__dirname', wrapper + ';return handle;')(
    ipcMain, {}, () => true, String, String, new AsyncLocalStorage(), require(path.join(root, 'lib/errors')), security, appRoot);
  const harden = new Function('fmtErr', 'windowSecurity', '__dirname',
    extractFn(source, 'function hardenWindow(') + ';return hardenWindow;')(String, security, appRoot);
  let calls = 0;
  handle('review:ping', () => { calls++; return { value: 'pong' }; });
  app.setPath('userData', path.join(appRoot, 'profile'));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false,
  } });
  harden(win);
  await win.loadFile(path.join(appRoot, 'index.html'));
  const trusted = await win.webContents.executeJavaScript('window.hehe.invoke("review:ping")');
  const original = win.webContents.getURL();
  await win.webContents.executeJavaScript('document.querySelector("a").click()');
  await new Promise(resolve => setTimeout(resolve, 200));
  const fileBlocked = win.webContents.getURL() === original;
  await win.webContents.executeJavaScript('document.querySelector("a").href="data:text/html,untrusted";document.querySelector("a").click()');
  await new Promise(resolve => setTimeout(resolve, 200));
  const dataBlocked = win.webContents.getURL() === original;
  // Main-process loads are intentionally allowed; IPC must still reject a foreign page.
  await win.loadFile(path.join(appRoot, 'foreign.html'));
  const foreign = await win.webContents.executeJavaScript('window.hehe.invoke("review:ping")');
  process.stdout.write(JSON.stringify({ trusted, fileBlocked, dataBlocked, foreign, calls }) + '\n');
  win.destroy(); app.quit();
}
t('真实隐藏 Electron 窗口拒绝 file/data 跳转，外部页面不能调用 IPC', async () => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hehe-window-security-'));
  try {
    await fs.promises.writeFile(path.join(temp, 'index.html'), '<!doctype html><a href="foreign.html">open</a>');
    await fs.promises.writeFile(path.join(temp, 'foreign.html'), '<!doctype html><p>foreign page</p>');
    const helper = path.join(temp, 'probe.cjs');
    await fs.promises.writeFile(helper, 'const path=require("path");(' + probe.toString() + ')('
      + JSON.stringify(ROOT) + ',' + JSON.stringify(temp) + ').catch(e=>{console.error(e);process.exit(1);});');
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await execFile(require('electron'), [helper], { timeout: 30000, windowsHide: true, env });
    const result = JSON.parse(stdout.trim().split(/\r?\n/).find(line => line.startsWith('{')));
    assert.strictEqual(result.trusted.ok, true);
    assert.strictEqual(result.fileBlocked, true); assert.strictEqual(result.dataBlocked, true);
    assert.strictEqual(result.foreign.code, 'UNTRUSTED_SENDER'); assert.strictEqual(result.calls, 1);
  } finally { rmDir(temp); }
});
done();
