export function scanPhoto(container, scan, token, active = () => true) {
    const image = document.createElement('img');
    image.className = 'scan-thumbnail';
    image.alt = 'Foto daun pada pemindaian';
    const status = document.createElement('p');
    status.textContent = 'Memuat foto…';
    container.append(image, status);
    let url;
    let disposed = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    image.onerror = () => { image.hidden = true; status.textContent = 'Foto tidak dapat ditampilkan.'; };
    void (async () => {
        try {
            let blob = scan.image_blob;
            const scanId = scan.server_scan_id ?? scan.scan_id;
            if (!(blob instanceof Blob) && token && scanId) {
                const response = await fetch(`api/scans/image.php?scan_id=${encodeURIComponent(scanId)}`, {
                    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit', signal: controller.signal,
                });
                if (!response.ok) throw new Error('Foto tidak tersedia.');
                blob = await response.blob();
            }
            if (disposed || !active()) return;
            if (!(blob instanceof Blob)) throw new Error('Foto belum tersedia.');
            url = URL.createObjectURL(blob);
            image.src = url;
            status.textContent = '';
        } catch {
            if (!disposed && active()) { image.hidden = true; status.textContent = 'Foto belum tersedia atau akses dibatasi.'; }
        } finally { clearTimeout(timeout); }
    })();
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); if (url) URL.revokeObjectURL(url); image.remove(); status.remove(); };
}
