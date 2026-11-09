import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { MODEL_ASSETS } from '../public/js/model-assets.js';
import { verifiedAsset } from '../public/js/predict.js';
import { decodeWeightShard } from '../public/js/model-weights.js';

globalThis.crypto = webcrypto;
const root = new URL('../public/', import.meta.url);
let mode = 'valid', network = 0;
globalThis.fetch = async url => {
    network++;
    if (mode === 'missing') return new Response('Missing', { status: 404 });
    const bytes = new Uint8Array(await readFile(new URL(url)));
    if (mode === 'corrupt') bytes[0] ^= 1;
    return new Response(mode === 'partial' ? bytes.subarray(0, 10) : bytes);
};
for (const asset of MODEL_ASSETS) assert.equal((await verifiedAsset(asset)).byteLength, asset.bytes);
console.log('PASS: hashes and byte sizes of runtime, topology, labels, metadata and every shard');
const asset = MODEL_ASSETS.find(x => x.path.endsWith('.bin.gz'));
for (const value of ['corrupt', 'partial', 'missing']) {
    mode = value;
    await assert.rejects(verifiedAsset(asset), /model|Berkas/);
    console.log('PASS:', value, 'model asset rejected');
}
network = 0;
globalThis.caches = { open: async () => ({ match: async () => new Response(await readFile(new URL(asset.path, root))) }) };
assert.equal((await verifiedAsset(asset, true)).byteLength, asset.bytes);
assert.equal(network, 0);
globalThis.caches.open = async () => { throw new DOMException('Test quota exhausted', 'QuotaExceededError'); };
await assert.rejects(verifiedAsset(asset, true), { name: 'QuotaExceededError' });
assert.equal(network, 0);
console.log('PASS: cache-only reads have no network fallback; storage failure propagates');
const metadata = JSON.parse(await readFile(new URL('models/banana/metadata.json', root)));
assert(metadata.weight_bytes <= 15000000 && metadata.precision_conversion === 'none');
let decodedBytes = 0;
for (const shard of metadata.decoded_shards) {
    const buffer = await readFile(new URL('models/banana/' + shard.path, root));
    const result = await decodeWeightShard(buffer, shard); decodedBytes += result.length;
}
assert.equal(decodedBytes, metadata.decoded_weight_bytes);
const compressed = await readFile(new URL('models/banana/' + metadata.decoded_shards[0].path, root));
await assert.rejects(decodeWeightShard(compressed, { ...metadata.decoded_shards[0], sha256: '0'.repeat(64) }), /identik/);
console.log('PASS: all lossless shards decode to original FP32 hashes; weight budget under 15 MB');
