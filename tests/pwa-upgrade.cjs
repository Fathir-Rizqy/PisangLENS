// Browser regression for public-shell upgrades. Uses a synthetic localhost fixture only.
// Requires Node 22 and installed Chrome. No PHP, MySQL, real accounts or credentials.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { readFileSync, existsSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const currentWorker = readFileSync(join(root, 'public/sw.js'), 'utf8');
const updateClient = readFileSync(join(root, 'public/js/app-update.js'), 'utf8');
const legacyWorker = `
const name = 'pisanglens-shell-legacy-test';
const urls = ['/', '/index.html', '/js/ui.js'];
self.addEventListener('install', event => event.waitUntil(caches.open(name).then(cache => cache.addAll(urls))));
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET' || !urls.includes(new URL(event.request.url).pathname)) return;
    event.respondWith(caches.open(name).then(async cache => await cache.match(event.request) || fetch(event.request)));
});
`;
let release = 1;
let chrome;
let socket;
let server;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, label) {
    for (let attempt = 0; attempt < 100; attempt++) {
        try { if (await check()) return; } catch {}
        await delay(100);
    }
    throw new Error('Timed out: ' + label);
}

async function main() {
    server = createServer((request, response) => {
        const path = new URL(request.url, 'http://fixture.test').pathname;
        response.setHeader('Cache-Control', 'no-cache');
        if (path === '/sw.js') {
            response.setHeader('Content-Type', 'text/javascript');
            const nextWorker = currentWorker.replace(
                /(const cacheName = `\$\{cachePrefix\})[^`]+(`;)/,
                (_, prefix, suffix) => prefix + 'upgrade-test-next' + suffix
            );
            response.end(release === 1 ? legacyWorker : release === 2 ? currentWorker : nextWorker);
        } else if (path === '/js/ui.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end('window.appVersion = ' + release + ';');
        } else if (path === '/js/app-update.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end(updateClient);
        } else if (path === '/' || path === '/index.html') {
            response.setHeader('Content-Type', 'text/html');
            const bootstrap = release === 1
                ? '<script>navigator.serviceWorker.register("./sw.js")</script>'
                : '<script type="module" src="js/app-update.js"></script>';
            response.end('<!doctype html><h1 id="version">Fixture ' + release +
                '</h1><input id="draft" aria-label="Unsaved fixture draft"><script src="js/ui.js"></script>' + bootstrap);
        } else if (path.endsWith('.js')) {
            response.setHeader('Content-Type', 'text/javascript');
            response.end('// Synthetic public asset.');
        } else if (path.endsWith('.webmanifest')) {
            response.setHeader('Content-Type', 'application/manifest+json');
            response.end('{"name":"Upgrade fixture"}');
        } else {
            response.setHeader('Content-Type', 'text/plain');
            response.end('Synthetic public asset.');
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const profile = mkdtempSync(join(tmpdir(), 'pisanglens-pwa-upgrade-'));
    chrome = spawn(process.env.PISANGLENS_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
        '--headless=new', '--no-first-run', '--disable-background-networking',
        '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    await waitFor(() => existsSync(portFile), 'Chrome debugging port');
    const port = readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
    const tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const tab = tabs.find(item => item.type === 'page');
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0;
    const pending = new Map();
    socket.onmessage = event => {
        const result = JSON.parse(event.data);
        const request = pending.get(result.id);
        if (!request) return;
        pending.delete(result.id);
        clearTimeout(request.timeout);
        if (result.error) request.reject(new Error(result.error.message));
        else request.resolve(result.result);
    };
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence;
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
        pending.set(id, { resolve, reject, timeout });
        socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
        const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
    };

    await cdp('Page.navigate', { url: origin + '/' });
    await waitFor(() => evaluate('document.readyState === "complete" && navigator.serviceWorker.ready.then(r => !!r.active)'), 'legacy shell install');
    await cdp('Page.reload');
    await waitFor(() => evaluate('!!navigator.serviceWorker.controller && window.appVersion === 1'), 'legacy shell controller');

    release = 2;
    await evaluate('(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); })()');
    await waitFor(() => evaluate('(async () => { const r = await navigator.serviceWorker.getRegistration(); return !r.waiting && !(await caches.keys()).includes("pisanglens-shell-legacy-test"); })()'), 'upgrade activates while original tab remains open');
    assert.equal(await evaluate('window.appVersion'), 1, 'Activation must not silently discard the open document');
    await cdp('Page.reload');
    await waitFor(() => evaluate('window.appVersion === 2 && document.getElementById("version").textContent === "Fixture 2"'), 'single reload receives new HTML and JavaScript');
    console.log('PASS: cached legacy shell upgrades in one reload without closing tabs');

    await evaluate('document.getElementById("draft").value = "Unsaved synthetic draft"');
    release = 3;
    await evaluate('(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); })()');
    await waitFor(() => evaluate('!!document.querySelector("aside[role=status] button")'), 'controller update notice');
    assert.equal(await evaluate('window.appVersion'), 2);
    assert.equal(await evaluate('document.getElementById("draft").value'), 'Unsaved synthetic draft');
    console.log('PASS: update notice preserves the current document and unsent draft');
    await evaluate('document.querySelector("aside[role=status] button").click()');
    await waitFor(() => evaluate('window.appVersion === 3 && document.getElementById("version").textContent === "Fixture 3"'), 'explicit reload receives next release');
    assert.equal(await evaluate('document.querySelectorAll("aside[role=status]").length'), 0);
    console.log('PASS: explicit reload loads the update without repeated update prompts');

    const cachesArePublic = await evaluate(`(async () => {
        await fetch('/api/consultations/key.php?consultation_id=synthetic');
        const names = await caches.keys();
        if (names.length !== 1) return false;
        const requests = await (await caches.open(names[0])).keys();
        return requests.length > 0 && requests.every(request => !new URL(request.url).pathname.startsWith('/api/'));
    })()`);
    assert.equal(cachesArePublic, true);
    console.log('PASS: only the current public shell is cached; API requests stay outside Cache API');
    console.log('Retained isolated Chrome profile: ' + profile);
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
}).finally(async () => {
    socket?.close();
    chrome?.kill();
    server?.closeAllConnections();
    server?.close();
    await delay(150);
});
