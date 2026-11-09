// Real Chromium + real weights. No authenticated API or production database writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures/real-model');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.bin': 'application/octet-stream', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const prefix = url.pathname.startsWith('/__fixtures__/') ? fixtures : path.join(root, 'public');
    const relative = url.pathname.startsWith('/__fixtures__/') ? url.pathname.slice(14) : url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(prefix, relative);
    if (!file.startsWith(prefix + path.sep) || file.endsWith('.php')) { response.writeHead(503, { 'Cache-Control': 'no-store' }); response.end('{}'); return; }
    fs.readFile(file, (error, bytes) => { response.writeHead(error ? 404 : 200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); response.end(error ? 'Not found' : bytes); });
});

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const exceptions = [];
        page.on('pageerror', error => exceptions.push(error.message));
        await page.goto(base + '/index.html');
        const numerical = await page.evaluate(async () => {
            const prediction = await import('/js/predict.js');
            const pre = await import('/js/model-preprocess.js');
            const { uploadPhoto } = await import('/js/camera.js');
            const loadStarted = performance.now();
            const { tf, model, metadata } = await prediction.loadLocalModel();
            const load_ms = performance.now() - loadStarted;
            const refs = await (await fetch('/__fixtures__/reference.json')).json();
            const results = [];
            async function canvasFor(file) {
                const image = new Image(); image.src = '/__fixtures__/' + file; await image.decode();
                const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; canvas.getContext('2d').drawImage(image, 0, 0); return canvas;
            }
            for (const ref of refs.fixtures) {
                const blob = await (await fetch('/__fixtures__/' + ref.file)).blob();
                const file = new File([blob], ref.file, { type: ref.file.endsWith('.jpg') ? 'image/jpeg' : 'image/png' });
                const prepared = await uploadPhoto(file, document.createElement('canvas'));
                const canvas = prepared.input, rgb = pre.canvasRgb(canvas);
                const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', rgb))].map(x => x.toString(16).padStart(2, '0')).join('');
                let pixel_max_error = 0;
                if (ref.resized_rgb_file) {
                    const expected = new Uint8Array(await (await fetch('/__fixtures__/' + ref.resized_rgb_file)).arrayBuffer());
                    for (let i = 0; i < rgb.length; i++) pixel_max_error = Math.max(pixel_max_error, Math.abs(rgb[i] - expected[i]));
                }
                const input = pre.normalizedInput(tf, rgb, metadata), output = model.predict(input);
                const probabilities = tf.tidy(() => tf.softmax(output.div(metadata.temperature)));
                const logits = [...await output.data()], scores = [...await probabilities.data()]; probabilities.dispose(); input.dispose(); output.dispose();
                const result = await prediction.predict(canvas);
                results.push({ file: ref.file, split: ref.split, pixel_match: hash === ref.resized_rgb_sha256, pixel_max_error, prepared_dimensions: [canvas.width, canvas.height],
                    max_logit_error: Math.max(...logits.map((x, i) => Math.abs(x - ref.logits[i]))),
                    max_probability_error: Math.max(...scores.map((x, i) => Math.abs(x - ref.probabilities[i]))),
                    confidence_error: Math.abs(result.confidence_score - Math.max(...ref.probabilities)),
                    class_match: result.class_name === metadata.labels[ref.predicted_index], source: result.prediction_source });
            }
            const canvas = await canvasFor(refs.fixtures[0].file);
            await prediction.predict(canvas);
            const before = tf.memory().numTensors;
            const latencies = [];
            for (let i = 0; i < 20; i++) { const start = performance.now(); await prediction.predict(canvas); latencies.push(performance.now() - start); }
            const after = tf.memory().numTensors;
            let invalid = false, transparent = false;
            try { await prediction.predict(document.createElement('canvas')); } catch { invalid = true; }
            const empty = document.createElement('canvas'); empty.width = empty.height = 224;
            try { await prediction.predict(empty); } catch { transparent = true; }
            return { results, backend: tf.getBackend(), before, after, invalid, transparent, userAgent: navigator.userAgent, load_ms, repeated_inference_ms: latencies };
        });
        fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
        fs.writeFileSync(path.join(root, 'reports/real-model-numerical.json'), JSON.stringify(numerical, null, 2));
        console.log('JPEG decoder differences:', JSON.stringify(numerical.results.filter(x => !x.pixel_match)));
        assert(numerical.results.every(x => x.split === 'decode_probe' ? x.pixel_max_error <= 1 : x.pixel_match), 'Pillow resize exact; native JPEG decode differs by at most one RGB level');
        assert(numerical.results.every(x => JSON.stringify(x.prepared_dimensions) === '[224,224]'));
        assert(numerical.results.every(x => x.class_match && x.source === 'local'), 'Real class predictions');
        assert(numerical.results.every(x => x.max_logit_error < (x.split === 'decode_probe' ? 0.01 : 0.0003) && x.max_probability_error < 0.00003 && x.confidence_error < 0.00003), 'Numerical parity');
        assert.equal(numerical.before, numerical.after, 'Tensor memory remains constant');
        assert(numerical.invalid && numerical.transparent);
        console.log('PASS real inference:', JSON.stringify({ images: numerical.results.length, max_logit_error: Math.max(...numerical.results.map(x => x.max_logit_error)), max_confidence_error: Math.max(...numerical.results.map(x => x.confidence_error)), tensors: [numerical.before, numerical.after], backend: numerical.backend }));
        await page.evaluate(async () => { await (await import('/js/offline.js')).prepareLocalOffline(); });
        await page.waitForFunction(() => !!navigator.serviceWorker.controller);
        const cacheAudit = await page.evaluate(async () => {
            const keys = await caches.keys(); const urls = [];
            for (const key of keys) for (const req of await (await caches.open(key)).keys()) urls.push(req.url);
            return { keys, urls };
        });
        assert(!cacheAudit.urls.some(url => url.includes('/api/')));
        // Keep test fixture in memory; an actual user picks a local File while offline.
        const imageBytes = fs.readFileSync(path.join(fixtures, 'raw_e9abdeb7f9b0_00341.png'));
        const fixtureBase64 = imageBytes.toString('base64');
        await context.setOffline(true);
        await page.reload();
        const offlinePrediction = await page.evaluate(async b64 => {
            await (await import('/js/offline.js')).prepareLocalOffline();
            const image = new Image(); image.src = 'data:image/png;base64,' + b64; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d').drawImage(image, 0, 0);
            return (await import('/js/predict.js')).predict(canvas);
        }, fixtureBase64);
        assert.equal(offlinePrediction.prediction_source, 'local');
        console.log('PASS offline reload + new runtime/model load + real prediction; private APIs absent from cache');
        await context.setOffline(false);
        const report = { numerical, cacheAudit, offlinePrediction, exceptions, physical_android: 'NOT TESTED', physical_airplane_mode: 'NOT TESTED' };
        fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
        fs.writeFileSync(path.join(root, 'reports/real-model-verification.json'), JSON.stringify(report, null, 2));
        assert.deepEqual(exceptions, []);
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
