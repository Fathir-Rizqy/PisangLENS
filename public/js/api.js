export async function requestApi(path, { method = 'GET', body, token, query } = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    let responseText;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const suffix = query ? `?${new URLSearchParams(query)}` : '';
        response = await fetch(`api/${path}.php${suffix}`, {
            method, headers, cache: 'no-store', credentials: 'omit', body: JSON.stringify(body), signal: controller.signal,
        });
        responseText = await response.text();
    } catch (error) {
        throw new Error(error.name === 'AbortError' ? 'Layanan belum merespons. Periksa hasil sebelum mencoba lagi.' : 'Layanan tidak dapat dijangkau. Periksa koneksi dan coba lagi.');
    } finally { clearTimeout(timer); }
    if (!response.ok) {
        const messages = {
            400: 'Periksa kembali data yang dimasukkan.',
            401: 'Autentikasi gagal. Periksa data masuk atau masuk kembali.',
            403: 'Akun ini tidak memiliki akses.',
            404: 'Layanan belum tersedia.',
            409: 'Data sudah digunakan atau berubah. Periksa dan coba lagi.',
            415: 'Format permintaan tidak didukung.',
            422: 'Data belum dapat diterima. Periksa kembali isian.',
            503: 'Layanan belum dikonfigurasi atau tidak tersedia.',
        };
        const error = new Error(messages[response.status] ?? 'Layanan belum dapat memproses permintaan.');
        error.status = response.status;
        throw error;
    }
    try {
        return JSON.parse(responseText);
    } catch {
        throw new Error('Respons layanan tidak dapat dibaca.');
    }
}
