// Pillow 13 RGB8 bilinear antialias: separable filter, 22-bit fixed coefficients.
// Reference: https://github.com/python-pillow/Pillow/blob/main/src/libImaging/Resample.c
function coefficients(input, output) {
    const scale = input / output, support = Math.max(1, scale), inverseSupport = 1 / support;
    return Array.from({ length: output }, (_, position) => {
        const center = (position + 0.5) * scale;
        const start = Math.max(0, Math.trunc(center - support + 0.5));
        const end = Math.min(input, Math.trunc(center + support + 0.5));
        const weights = [];
        let sum = 0;
        for (let i = start; i < end; i++) { const w = Math.max(0, 1 - Math.abs((i - center + 0.5) * inverseSupport)); weights.push(w); sum += w; }
        return { start, weights: weights.map(w => Math.floor(w / sum * 4194304 + 0.5)) };
    });
}

export function resizeRgb(imageData, size = 224) {
    const { width, height, data } = imageData;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16000000 || data.length !== width * height * 4 || size !== 224) throw new Error('Gunakan foto hingga 16 megapiksel.');
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) throw new Error('Foto transparan tidak didukung. Gunakan JPG atau foto tanpa transparansi.');
    let current = new Uint8Array(width * height * 3), w = width, h = height;
    for (let i = 0; i < width * height; i++) current.set(data.subarray(i * 4, i * 4 + 3), i * 3);
    // Pillow 13 selects vertical first for tall images. Intermediate rounding matters.
    const horizontalFirst = !((height - size) > 0 && (height - size) > (width - size) * 2);
    for (const horizontal of horizontalFirst ? [true, false] : [false, true]) {
        const input = horizontal ? w : h;
        if (input === size) continue;
        const nextWidth = horizontal ? size : w, nextHeight = horizontal ? h : size;
        const output = new Uint8Array(nextWidth * nextHeight * 3), coefs = coefficients(input, size);
        for (let y = 0; y < nextHeight; y++) for (let x = 0; x < nextWidth; x++) {
            const { start, weights } = coefs[horizontal ? x : y];
            for (let channel = 0; channel < 3; channel++) {
                let value = 2097152;
                for (let k = 0; k < weights.length; k++) value += current[((horizontal ? y : start + k) * w + (horizontal ? start + k : x)) * 3 + channel] * weights[k];
                output[(y * nextWidth + x) * 3 + channel] = Math.min(255, Math.max(0, Math.floor(value / 4194304)));
            }
        }
        current = output; w = nextWidth; h = nextHeight;
    }
    return current;
}

export function canvasRgb(canvas) {
    if (!canvas || !canvas.width || !canvas.height || typeof canvas.getContext !== 'function') throw new Error('Foto belum tersedia.');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Foto tidak dapat dibaca di peramban ini.');
    return resizeRgb(context.getImageData(0, 0, canvas.width, canvas.height));
}

export function normalizedInput(tf, rgb, metadata) {
    return tf.tidy(() => tf.tensor4d(rgb, [1, 224, 224, 3], 'float32').div(255).sub(tf.tensor1d(metadata.mean)).div(tf.tensor1d(metadata.std)));
}
