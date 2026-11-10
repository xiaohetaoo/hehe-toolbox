'use strict';
const path = require('path');
const { fileURLToPath, URL } = require('url');

const PAGES = ['index.html', 'splash.html', 'ruler.html', 'pin.html', 'snip.html'];

function isTrustedPage(url, appRoot) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:' || parsed.host) return false;
    const normalize = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
    const actual = normalize(fileURLToPath(parsed));
    return PAGES.some(page => actual === normalize(path.join(appRoot, page)));
  } catch (e) { return false; }
}

function isTrustedSender(event, appRoot) {
  try {
    const frame = event && event.senderFrame;
    return !!frame && frame === event.sender.mainFrame && isTrustedPage(frame.url, appRoot);
  } catch (e) { return false; }
}

module.exports = { isTrustedPage, isTrustedSender };
