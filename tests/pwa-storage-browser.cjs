const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '..'), publicRoot = path.join(root, 'public');
let failShard = true;
const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(publicRoot + '/') || (failShard && pathname.endsWith('group1-shard1of5.bin.gz'))) { response.writeHead(503); response.end('Unavailable'); return; }
    const types = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
    fs.readFile(file, (error, data) => { response.writeHead(error ? 404 : 200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); response.end(error ? 'Not found' : data); });
});
let browser;
async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ args: ['--no-sandbox', '--use-angle=swiftshader'] });
    const context = await browser.newContext(), page = await context.newPage();
    await page.goto(origin + '/index.html');
    async function prepare() { return page.evaluate(async () => { try { await (await import('/js/offline.js')).prepareLocalOffline(); return { ok: true }; } catch (error) { return { ok: false, error: error.message }; } }); }
    assert.equal((await prepare()).ok, false);
    console.log('PASS: incomplete model download cannot establish offline readiness');
    failShard = false;
    assert.equal((await prepare()).ok, true);
    console.log('PASS: failed download recovers with full integrity checks');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.evaluate(async () => { const { MODEL_CACHE } = await import('/js/model-assets.js'); await (await caches.open(MODEL_CACHE)).delete(location.origin + '/models/banana/group1-shard1of5.bin.gz'); });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1024 });
    const quota = await prepare();
    assert.equal(quota.ok, false);
    assert(quota.error.includes('Penyimpanan penuh'), quota.error);
    console.log('PASS: actual Chromium storage-quota failure prevents offline readiness');
    await cdp.send('Storage.overrideQuotaForOrigin', { origin });
    assert.equal((await prepare()).ok, true);
    const bytes = await page.evaluate(async () => { const { MODEL_CACHE } = await import('/js/model-assets.js'); const response = await (await caches.open(MODEL_CACHE)).match(location.origin + '/models/banana/group1-shard1of5.bin.gz'); return (await response.arrayBuffer()).byteLength; });
    assert.equal(bytes, fs.statSync(path.join(publicRoot, 'models/banana/group1-shard1of5.bin.gz')).size);
    fs.writeFileSync(path.join(root, 'reports/pwa-storage-verification.json'), JSON.stringify({ status: 'passed', incomplete_download_rejected: true, retry_recovers: true, chromium_quota_failure_rejected: true, quota_recovery: true }, null, 2));
    console.log('PASS: storage recovery preserves a complete verified package');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
