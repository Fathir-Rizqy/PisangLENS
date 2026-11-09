// Lossless storage: transpose the four bytes of each FP32 value, then gzip.
// No float is rounded or quantized. The browser verifies decoded bytes too.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const source = process.argv[2] || path.join(root, 'conversion/e03-large-seed42-fp32');
const output = process.argv[3] || path.join(root, 'public/models/banana');
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const descriptor = JSON.parse(fs.readFileSync(path.join(source, 'model.json')));
const metadata = JSON.parse(fs.readFileSync(path.join(source, 'metadata.json')));
assertFloat32();
function assertFloat32() {
    if (descriptor.weightsManifest.length !== 1 || descriptor.weightsManifest[0].weights.some(w => w.dtype !== 'float32')) throw Error('Expected original FP32 weights only');
}
fs.mkdirSync(output, { recursive: true });
const decoded = [];
let storedBytes = 0, decodedBytes = 0;
for (const name of descriptor.weightsManifest[0].paths) {
    const original = fs.readFileSync(path.join(source, name));
    if (original.length % 4) throw Error('Unaligned FP32 shard');
    const words = original.length / 4, shuffled = Buffer.alloc(original.length);
    for (let byte = 0; byte < 4; byte++) for (let word = 0; word < words; word++) shuffled[byte * words + word] = original[word * 4 + byte];
    const packed = zlib.gzipSync(shuffled, { level: 9 });
    const restored = Buffer.alloc(original.length), unzipped = zlib.gunzipSync(packed);
    for (let byte = 0; byte < 4; byte++) for (let word = 0; word < words; word++) restored[word * 4 + byte] = unzipped[byte * words + word];
    if (!restored.equals(original)) throw Error('Lossless roundtrip failed');
    const packedName = name + '.gz';
    fs.writeFileSync(path.join(output, packedName), packed);
    decoded.push({ path: packedName, bytes: original.length, sha256: sha(original) });
    storedBytes += packed.length; decodedBytes += original.length;
}
const packedMetadata = { ...metadata, model_version: 'e03-large-seed42-fd0e0c2b-v2-lossless',
    loader: 'tf.loadLayersModel with verified lossless IO', weight_encoding: 'gzip-byte-shuffle-f32-v1',
    weight_bytes: storedBytes, decoded_weight_bytes: decodedBytes, decoded_shards: decoded, shards: decoded.map(x => x.path), precision_conversion: 'none' };
descriptor.weightsManifest[0].paths = packedMetadata.shards;
descriptor.userDefinedMetadata = packedMetadata;
descriptor.convertedBy += '; lossless gzip byte packing';
fs.writeFileSync(path.join(output, 'model.json'), JSON.stringify(descriptor));
fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(packedMetadata, null, 2));
fs.writeFileSync(path.join(output, 'labels.json'), JSON.stringify(packedMetadata.labels, null, 2));
const names = ['model.json', 'metadata.json', 'labels.json', ...packedMetadata.shards];
const files = names.map(name => { const bytes = fs.readFileSync(path.join(output, name)); return { path: name, bytes: bytes.length, sha256: sha(bytes) }; });
fs.writeFileSync(path.join(output, 'assets.json'), JSON.stringify({ model_version: packedMetadata.model_version, files }, null, 2));
if (storedBytes > 15000000) throw Error('Model exceeds the 15 MB weight budget');
console.log(JSON.stringify({ lossless: true, stored_weight_bytes: storedBytes, decoded_weight_bytes: decodedBytes, all_decoded_shards_match: true }));
