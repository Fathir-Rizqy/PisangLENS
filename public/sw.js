importScripts('./js/worker-assets.js');
const { MODEL_ASSETS, MODEL_CACHE, MODEL_VERSION, SHELL_CACHE, SHELL_PATHS } = self.PISANGLENS_WORKER_ASSETS;

const cachePrefix = 'pisanglens-shell-';
const cacheName = SHELL_CACHE;
const shellUrls = SHELL_PATHS.map(path => new URL(path, self.registration.scope).href);
const modelUrls = MODEL_ASSETS.map(asset => new URL(asset.path, self.registration.scope).href);

self.addEventListener('install', event => {
    event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(
        shellUrls.map(url => new Request(url, { cache: 'reload' }))
    )).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(
        keys.filter(key => key.startsWith(cachePrefix) && key !== cacheName)
            .map(key => caches.delete(key))
    )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);
    if (request.method !== 'GET' || request.headers.has('Authorization') || url.pathname.includes('/api/')) return;
    // Navigation Requests can retain #riwayat/#kamera when reopening an app.
    url.hash = '';
    const key = url.href;
    if (modelUrls.includes(key)) {
        event.respondWith(caches.open(MODEL_CACHE).then(async cache => (await cache.match(key)) ?? fetch(request)));
        return;
    }
    if (!shellUrls.includes(key)) return;

    event.respondWith(caches.open(cacheName).then(async cache => {
        const response = await cache.match(key);
        return response ?? fetch(request);
    }));
});

async function validAsset(response, asset) {
    if (!response?.ok) return false;
    const bytes = await response.clone().arrayBuffer();
    if (bytes.byteLength !== asset.bytes) return false;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    return hash === asset.sha256;
}

let preparing;
async function prepareAssets() {
    const shell = await caches.open(SHELL_CACHE);
    for (const url of shellUrls) if (!(await shell.match(url))?.ok) throw new Error('Halaman aplikasi belum lengkap. Muat ulang saat daring.');
    const cache = await caches.open(MODEL_CACHE);
    for (let index = 0; index < MODEL_ASSETS.length; index++) {
        const asset = MODEL_ASSETS[index], url = modelUrls[index];
        if (await validAsset(await cache.match(url), asset)) continue;
        const response = await fetch(new Request(url, { cache: 'reload', credentials: 'omit' }));
        if (!await validAsset(response, asset)) throw new Error('Unduhan model tidak lengkap atau rusak.');
        await cache.put(url, response);
        if (!await validAsset(await cache.match(url), asset)) throw new Error('Penyimpanan model tidak dapat diverifikasi.');
    }
    // A partial new package never discards an older, complete model cache.
    for (const name of await caches.keys()) {
        if ((name.startsWith('pisanglens-model-') && name !== MODEL_CACHE) || (name.startsWith(cachePrefix) && name !== cacheName)) await caches.delete(name);
    }
    return { model_version: MODEL_VERSION, assets: MODEL_ASSETS.length, shell_assets: shellUrls.length };
}

self.addEventListener('message', event => {
    if (event.data?.type !== 'PREPARE_OFFLINE' || !event.ports[0]) return;
    if (!preparing) preparing = prepareAssets().finally(() => { preparing = null; });
    event.waitUntil(preparing.then(result => event.ports[0].postMessage({ ok: true, ...result }))
        .catch(error => event.ports[0].postMessage({ ok: false, error: error.name === 'QuotaExceededError' ? 'Penyimpanan penuh. Sediakan ruang penyimpanan dan coba lagi.' : error.message })));
});
