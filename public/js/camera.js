import { MIN_LUMA, MAX_LUMA } from './config.js';
import { resizeRgb } from './model-preprocess.js';

export async function openCamera(video) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Buka aplikasi melalui localhost atau HTTPS untuk menggunakan kamera.');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream;
    try {
        await video.play();
    } catch (error) {
        closeCamera(video);
        throw error;
    }
}

export function closeCamera(video) {
    video.srcObject?.getTracks().forEach(track => track.stop());
    video.srcObject = null;
}

export function meanLuminance(pixels) {
    let total = 0;
    for (let i = 0; i < pixels.length; i += 4) {
        total += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    }
    return total / (pixels.length / 4);
}

export async function capture(video, preview) {
    const { videoWidth: width, videoHeight: height } = video;
    if (!width || !height || video.readyState < 2) throw new Error('Tunggu hingga pratinjau kamera tersedia.');
    return preparePhoto(video, width, height, preview);
}

export async function uploadPhoto(file, preview) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        throw new Error('Pilih foto berformat JPG, PNG, atau WEBP.');
    }
    if (!file.size || file.size > 5 * 1024 * 1024) {
        throw new Error('Foto harus berisi gambar dan berukuran maksimal 5 MB.');
    }
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('Foto tidak dapat dibuka. Pilih berkas gambar lain.'));
            image.src = url;
        });
        return await preparePhoto(image, image.naturalWidth, image.naturalHeight, preview);
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function preparePhoto(source, width, height, preview) {
    if (!width || !height || width * height > 16000000) throw new Error('Gunakan foto hingga 16 megapiksel.');
    const input = document.createElement('canvas');
    input.width = width;
    input.height = height;
    const context = input.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0);
    const rgb = resizeRgb(context.getImageData(0, 0, width, height));
    const pixels = new Uint8ClampedArray(224 * 224 * 4);
    for (let i = 0; i < rgb.length / 3; i++) { pixels.set(rgb.subarray(i * 3, i * 3 + 3), i * 4); pixels[i * 4 + 3] = 255; }
    const luminance = meanLuminance(pixels);
    if (luminance < MIN_LUMA || luminance > MAX_LUMA) {
        throw new Error(luminance < MIN_LUMA
            ? 'Foto terlalu gelap. Cari cahaya yang lebih merata dan potret ulang.'
            : 'Foto terlalu terang. Hindari cahaya langsung dan potret ulang.');
    }
    // Keep the existing 224×224 predict(canvas) interface and release the full-size bitmap.
    input.width = input.height = 224;
    context.putImageData(new ImageData(pixels, 224, 224), 0, 0);
    const scale = Math.min(1, 800 / Math.max(width, height));
    preview.width = Math.max(1, Math.round(width * scale));
    preview.height = Math.max(1, Math.round(height * scale));
    preview.getContext('2d').drawImage(source, 0, 0, preview.width, preview.height);
    const image = await new Promise(resolve => preview.toBlob(resolve, 'image/jpeg', 0.82));
    if (!image) throw new Error('Foto tidak dapat disimpan. Silakan potret ulang.');
    return { input, image };
}
