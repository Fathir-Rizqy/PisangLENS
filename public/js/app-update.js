// All role pages check for public-shell updates, including returning PWA users.
if (globalThis.navigator?.serviceWorker) {
    const workers = navigator.serviceWorker;
    let controller = workers.controller;
    let notice;
    workers.addEventListener('controllerchange', () => {
        const previous = controller;
        controller = workers.controller;
        if (!previous || notice) return;
        notice = document.createElement('aside');
        notice.className = 'panel message';
        notice.setAttribute('role', 'status');
        const text = document.createElement('p');
        text.textContent = 'Versi baru PisangLENS tersedia. Simpan isian yang belum terkirim, lalu muat ulang.';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Muat ulang aplikasi';
        button.addEventListener('click', () => location.reload());
        notice.append(text, button);
        document.body.prepend(notice);
    });
    void workers.register(new URL('../sw.js', import.meta.url), { updateViaCache: 'none' })
        .then(registration => registration.update()).catch(() => {
            // Offline/readiness feedback is handled by the existing Farmer indicator.
        });
}
