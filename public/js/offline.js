import { loadLocalModel } from './predict.js';
import { MODEL_VERSION } from './model-assets.js';

export async function prepareLocalOffline() {
    if (!navigator.serviceWorker || !globalThis.caches || !crypto.subtle) throw new Error('Gunakan localhost atau HTTPS dengan penyimpanan peramban aktif.');
    let existing = await navigator.serviceWorker.getRegistration(new URL('../', import.meta.url));
    try { existing = await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { updateViaCache: 'none' }); }
    catch (error) { if (!existing?.active) throw error; }
    let timer;
    const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Persiapan halaman belum selesai. Coba lagi.')), 20000); }),
    ]).finally(() => clearTimeout(timer));
    const updating = registration.installing || registration.waiting;
    if (updating && updating.state !== 'activated') {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { updating.removeEventListener('statechange', changed); reject(new Error('Pembaruan aplikasi belum selesai. Coba lagi.')); }, 20000);
            function changed() {
                if (updating.state === 'activated' || updating.state === 'redundant') {
                    clearTimeout(timeout); updating.removeEventListener('statechange', changed);
                    updating.state === 'activated' ? resolve() : reject(new Error('Pembaruan halaman gagal. Coba lagi saat daring.'));
                }
            }
            updating.addEventListener('statechange', changed); changed();
        });
    }
    const channel = new MessageChannel();
    const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { channel.port1.close(); reject(new Error('Unduhan belum selesai. Periksa jaringan, lalu coba lagi.')); }, 120000);
        channel.port1.onmessage = event => { clearTimeout(timeout); channel.port1.close(); event.data.ok ? resolve(event.data) : reject(new Error(event.data.error)); };
        registration.active.postMessage({ type: 'PREPARE_OFFLINE' }, [channel.port2]);
    });
    if (result.model_version !== MODEL_VERSION) throw new Error('Versi aplikasi berubah. Muat ulang untuk melanjutkan.');
    // Runtime, topology and every shard must be readable from Cache API, with no network fallback.
    await loadLocalModel({ cacheOnly: true });
    return result;
}
