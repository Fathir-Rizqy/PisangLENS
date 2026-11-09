import { requestApi } from './api.js';

export function initializeDirectory({ root, admin = false, demo = false, token, valid = () => true }) {
    const province = root.querySelector('[data-province]');
    const city = root.querySelector('[data-city]');
    const filterStatus = root.querySelector('[data-verification]');
    const list = root.querySelector('[data-directory-list]');
    const message = root.querySelector('[data-directory-status]');
    const refresh = root.querySelector('[data-directory-refresh]');
    let records = [];
    let request = 0;
    const date = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium' });
    function options(select, field, items, label) {
        const previous = select.value;
        select.replaceChildren(new Option(label, ''));
        for (const value of [...new Set(items.map(item => item[field]).filter(Boolean))].sort()) select.add(new Option(value, value));
        if ([...select.options].some(option => option.value === previous)) select.value = previous;
    }
    function render() {
        if (!valid()) { list.replaceChildren(); return; }
        const matches = records.filter(item => (!province.value || item.province === province.value) &&
            (!city.value || item.city === city.value) && (!filterStatus?.value || item.verification_status === filterStatus.value));
        list.replaceChildren();
        for (const item of matches) {
            const card = document.createElement('li');
            const title = document.createElement('h3');
            title.textContent = item.name;
            const info = document.createElement('p');
            info.textContent = `${item.institution || 'Institusi belum diisi'} · ${[item.province, item.city].filter(Boolean).join(', ') || 'Wilayah belum diisi'}`;
            card.append(title, info);
            if (admin) {
                const meta = document.createElement('p');
                const joined = new Date(item.created_at);
                const known = item.created_at && Number.isFinite(joined.getTime());
                const days = known ? Math.max(0, Math.floor((Date.now() - joined) / 86400000)) : null;
                const labels = { approved: 'Terverifikasi', rejected: 'Ditolak', pending: 'Menunggu' };
                meta.textContent = `${labels[item.verification_status] || 'Belum tersedia'} · Bergabung ${known ? date.format(joined) : 'belum tersedia'} · ${days === null ? 'Durasi belum tersedia' : days + ' hari sejak bergabung'}`;
                card.append(meta);
            }
            list.append(card);
        }
        message.textContent = `${demo ? 'Simulasi direktori · Data contoh. ' : ''}${matches.length ? '' : 'Tidak ada botani sesuai filter.'}`;
    }
    province.addEventListener('change', () => {
        city.value = '';
        options(city, 'city', records.filter(item => !province.value || item.province === province.value), 'Semua kota/kabupaten');
        render();
    });
    city.addEventListener('change', render);
    filterStatus?.addEventListener('change', render);
    async function load() {
        const version = ++request;
        list.replaceChildren();
        refresh.disabled = true;
        message.textContent = 'Memuat direktori…';
        try {
            records = demo ? [{ name: 'Botani Contoh (simulasi)', institution: 'Institusi Contoh', province: 'Wilayah Contoh', city: 'Kota Contoh', verification_status: 'approved', created_at: null }]
                : await requestApi(admin ? 'admin/botanists' : 'botanist/directory', { token });
            if (version !== request || !valid()) return;
            options(province, 'province', records, 'Semua provinsi');
            options(city, 'city', records.filter(item => !province.value || item.province === province.value), 'Semua kota/kabupaten');
            render();
        } catch (error) { if (version === request && valid()) message.textContent = error.message; }
        finally { refresh.disabled = false; }
    }
    refresh.addEventListener('click', load);
    return load;
}
