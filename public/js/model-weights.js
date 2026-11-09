export async function decodeWeightShard(buffer, specification) {
    if (!globalThis.DecompressionStream) throw new Error('Peramban belum mendukung paket model. Gunakan Chrome versi terbaru.');
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    const shuffled = new Uint8Array(await new Response(stream).arrayBuffer());
    if (shuffled.byteLength !== specification.bytes || shuffled.byteLength % 4) throw new Error('Ukuran bobot hasil dekompresi tidak sesuai.');
    const decoded = new Uint8Array(shuffled.length), words = shuffled.length / 4;
    for (let byte = 0; byte < 4; byte++) for (let word = 0; word < words; word++) decoded[word * 4 + byte] = shuffled[byte * words + word];
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', decoded))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (hash !== specification.sha256) throw new Error('Bobot FP32 hasil dekompresi tidak identik.');
    return decoded;
}
