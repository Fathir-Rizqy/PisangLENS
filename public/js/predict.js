import { USE_MOCK_PREDICTION } from './config.js';
import { MODEL_ASSETS, MODEL_CACHE, MODEL_VERSION } from './model-assets.js';
import { registerModelLayers } from './model-layers.js';
import { canvasRgb, normalizedInput } from './model-preprocess.js';
import { decodeWeightShard } from './model-weights.js';

let runtimePromise;
let modelPromise;
const base = new URL('../', import.meta.url);

export async function verifiedAsset(asset, cacheOnly = false) {
    const url = new URL(asset.path, base).href;
    const response = cacheOnly ? await (await caches.open(MODEL_CACHE)).match(url) : await fetch(url, { cache: 'no-cache', credentials: 'omit' });
    if (!response?.ok) throw new Error('Berkas model belum lengkap. Siapkan ulang saat daring.');
    const buffer = await response.arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (buffer.byteLength !== asset.bytes || digest !== asset.sha256) throw new Error('Berkas model rusak atau berbeda versi. Siapkan ulang saat daring.');
    return buffer;
}

async function loadRuntime(cacheOnly) {
    if (!runtimePromise) runtimePromise = (async () => {
        const asset = MODEL_ASSETS.find(item => item.path === 'vendor/tf.min.js');
        const data = await verifiedAsset(asset, cacheOnly);
        if (!globalThis.tf) {
            const url = URL.createObjectURL(new Blob([data], { type: 'text/javascript' }));
            try {
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = url;
                    script.onload = () => { script.remove(); resolve(); };
                    script.onerror = () => { script.remove(); reject(new Error('Runtime AI lokal tidak dapat dimuat.')); };
                    document.head.append(script);
                });
            } finally { URL.revokeObjectURL(url); }
        }
        const tf = globalThis.tf;
        if (tf?.version?.tfjs !== '4.22.0') throw new Error('Versi runtime AI tidak sesuai. Muat ulang aplikasi.');
        try { await tf.setBackend('webgl'); } catch { await tf.setBackend('cpu'); }
        await tf.ready();
        registerModelLayers(tf);
        return tf;
    })().catch(error => { runtimePromise = null; throw error; });
    return runtimePromise;
}

export async function loadLocalModel({ cacheOnly = false } = {}) {
    if (!modelPromise) modelPromise = (async () => {
        const tf = await loadRuntime(cacheOnly);
        const assets = MODEL_ASSETS.filter(item => item.path.startsWith('models/banana/'));
        const buffers = new Map(await Promise.all(assets.map(async asset => [asset.path.split('/').pop(), await verifiedAsset(asset, cacheOnly)])));
        const json = name => JSON.parse(new TextDecoder().decode(buffers.get(name)));
        const descriptor = json('model.json'), metadata = json('metadata.json'), labels = json('labels.json');
        if (metadata.model_version !== MODEL_VERSION || labels.length !== 4 || JSON.stringify(labels) !== JSON.stringify(metadata.labels) || metadata.output !== 'logits' || metadata.temperature <= 0 || metadata.layout !== 'NHWC') throw new Error('Kontrak model lokal tidak sesuai.');
        const manifest = descriptor.weightsManifest;
        if (manifest.length !== 1 || manifest[0].paths.some(name => !buffers.has(name))) throw new Error('Bobot model belum lengkap.');
        if (metadata.weight_encoding !== 'gzip-byte-shuffle-f32-v1') throw new Error('Format paket bobot tidak sesuai.');
        const decoded = await Promise.all(manifest[0].paths.map(name => {
            const specification = metadata.decoded_shards.find(item => item.path === name);
            if (!specification) throw new Error('Kontrak dekompresi bobot tidak lengkap.');
            return decodeWeightShard(buffers.get(name), specification);
        }));
        const size = decoded.reduce((n, bytes) => n + bytes.byteLength, 0);
        if (size !== metadata.decoded_weight_bytes) throw new Error('Jumlah bobot model tidak sesuai.');
        const weights = new Uint8Array(size);
        let offset = 0;
        for (const part of decoded) { weights.set(part, offset); offset += part.length; }
        const model = await tf.loadLayersModel(tf.io.fromMemory({ modelTopology: descriptor.modelTopology, weightSpecs: manifest[0].weights, weightData: weights.buffer }));
        try {
            if (JSON.stringify(model.inputs[0].shape) !== '[null,224,224,3]' || JSON.stringify(model.outputs[0].shape) !== '[null,4]') throw new Error('Bentuk tensor model tidak sesuai.');
            const warm = tf.tidy(() => model.predict(tf.zeros([1, 224, 224, 3])));
            try { if (![...await warm.data()].every(Number.isFinite)) throw new Error('Uji model lokal gagal.'); }
            finally { warm.dispose(); }
            return { tf, model, metadata, labels };
        } catch (error) { model.dispose(); throw error; }
    })().catch(error => { modelPromise = null; throw error; });
    return modelPromise;
}

export async function predict(canvas) {
    const rgb = canvasRgb(canvas);
    if (USE_MOCK_PREDICTION) {
        const { predictMock } = await import('./predict-mock.js');
        return predictMock(canvas);
    }
    let probabilities;
    try {
        const { tf, model, metadata, labels } = await loadLocalModel();
        probabilities = tf.tidy(() => tf.softmax(model.predict(normalizedInput(tf, rgb, metadata)).div(metadata.temperature)));
        const scores = [...await probabilities.data()];
        if (scores.length !== 4 || scores.some(x => !Number.isFinite(x) || x < 0 || x > 1) || Math.abs(scores.reduce((a, b) => a + b, 0) - 1) > 0.00001) throw new Error('Keluaran model tidak valid.');
        const index = scores.indexOf(Math.max(...scores));
        return { class_name: labels[index], confidence_score: scores[index], prediction_source: 'local', model_version: MODEL_VERSION };
    } catch (error) { throw new Error(`Analisis AI lokal gagal. ${error.message}`); }
    finally { probabilities?.dispose(); }
}
