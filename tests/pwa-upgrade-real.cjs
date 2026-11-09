// The exact previous worker/update client from Git HEAD must upgrade without data loss.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '..'), publicRoot = path.join(root, 'public');
const legacyWorker = execFileSync('git', ['show', 'HEAD:public/sw.js'], { cwd: root });
const legacyClient = execFileSync('git', ['show', 'HEAD:public/js/app-update.js'], { cwd: root });
let release = 1, browser;
const server = http.createServer((request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname;
    const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.css': 'text/css', '.svg': 'image/svg+xml' };
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Content-Type', types[path.extname(name)] || 'application/octet-stream');
    if (name === '/' || name === '/index.html') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><body><h1>Isolated upgrade test</h1><script type="module" src="/js/app-update.js"></script></body></html>'); return; }
    if (release === 1 && name === '/sw.js') { response.end(legacyWorker); return; }
    if (release === 1 && name === '/js/app-update.js') { response.end(legacyClient); return; }
    const file = path.resolve(publicRoot, '.' + name);
    if (!file.startsWith(publicRoot + '/')) { response.writeHead(404); response.end(); return; }
    fs.readFile(file, (error, bytes) => { if (error) response.statusCode = 404; response.end(error ? 'Missing' : bytes); });
});
async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ args: ['--no-sandbox', '--use-angle=swiftshader'] });
    const context = await browser.newContext(), page = await context.newPage();
    await page.goto(base + '/index.html');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.evaluate(async () => {
        const cache = await caches.open('unrelated-public-test'); await cache.put('/preserve.txt', new Response('Keep unrelated caches'));
        await new Promise((resolve, reject) => { const request = indexedDB.open('upgrade-owner-test', 1); request.onupgradeneeded = () => request.result.createObjectStore('scans'); request.onerror = reject; request.onsuccess = () => { const db = request.result, tx = db.transaction('scans', 'readwrite'); tx.objectStore('scans').put({ owner: 'isolated-farmer', unsynced: true }, 'scan'); tx.oncomplete = () => { db.close(); resolve(); }; }; });
    });
    release = 2;
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
    await page.waitForFunction(async () => (await caches.keys()).includes('pisanglens-shell-v15-real2'), null, { timeout: 30000 });
    await page.waitForFunction(() => document.body.textContent.includes('Versi baru PisangLENS tersedia'));
    await page.waitForFunction(async () => { const registration = await navigator.serviceWorker.getRegistration(); return registration.active?.state === 'activated' && !registration.installing && !registration.waiting; });
    console.log('Upgrade caches:', await page.evaluate(() => caches.keys()));
    const state = await page.evaluate(async () => {
        const keys = await caches.keys();
        const data = await new Promise((resolve, reject) => { const request = indexedDB.open('upgrade-owner-test', 1); request.onerror = reject; request.onsuccess = () => { const db = request.result, read = db.transaction('scans').objectStore('scans').get('scan'); read.onsuccess = () => { db.close(); resolve(read.result); }; }; });
        return { keys, data };
    });
    assert(state.keys.includes('unrelated-public-test'));
    assert.deepEqual(state.data, { owner: 'isolated-farmer', unsynced: true });
    await page.locator('aside button').click();
    await page.waitForLoadState('load');
    await page.evaluate(async () => { await (await import('/js/offline.js')).prepareLocalOffline(); });
    const finalKeys = await page.evaluate(() => caches.keys());
    assert(!finalKeys.some(name => name.startsWith('pisanglens-shell-') && name !== 'pisanglens-shell-v15-real2'));
    fs.writeFileSync(path.join(root, 'reports/pwa-upgrade-verification.json'), JSON.stringify({ status: 'passed', exact_previous_classic_worker_upgraded: true, previous_update_client_compatible: true, unsynced_indexeddb_preserved: true, unrelated_cache_preserved: true, old_shell_cache_removed: true, update_notice_shown: true, real_model_prepared: true }, null, 2));
    console.log('PASS: previous classic PWA upgrades, update notice works, unsynced data/unrelated caches survive, real model prepares');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
