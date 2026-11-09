import { requestApi } from './api.js';
import { forgetStaffSession, logoutStaff, staffSession } from './auth.js';
import { initializeDashboard } from './dashboard.js';
import { initializeDirectory } from './directory.js';
import { initializeLearningQueue } from './learning.js';

const demo = new URLSearchParams(location.search).get('demo') === '1';
const session = demo ? null : staffSession('admin');
if (!demo && !session) location.replace('admin-masuk.html');
else initialize();

function initialize() {
    initializeDashboard();
    const panel = document.querySelector('#staff-panel');
    const status = document.querySelector('#staff-status');
    const queue = document.querySelector('#verification-list');
    const refresh = document.querySelector('#refresh-queue');
    const dialog = document.querySelector('#verification-confirm');
    const feedback = document.querySelector('#decision-feedback');
    const mockAccounts = [
        { id: 'demo-1', name: 'Ratna (contoh)', email: 'ratna@example.test', license_number: 'SIM-001' },
        { id: 'demo-2', name: 'Dewi (contoh)', email: 'dewi@example.test', license_number: 'SIM-002' },
    ];
    let busy = false;
    let pending;
    let generation = 0;
    panel.hidden = false;
    initializeLearningQueue({ token: session?.token, demo, active: () => demo || staffSession('admin')?.token === session.token });
    const loadDirectory = initializeDirectory({
        root: document.querySelector('#admin-directory'), admin: true, demo, token: session?.token,
        valid: () => demo || staffSession('admin')?.token === session.token,
    });
    window.addEventListener('hashchange', () => { if (location.hash === '#direktori') void loadDirectory(); });
    if (location.hash === '#direktori') void loadDirectory();
    document.querySelector('#admin-mode').textContent = demo ? 'Simulasi Admin' : 'Akun Admin';
    const notice = demo ? 'Simulasi Admin · Data contoh. Keputusan hanya berlaku di halaman ini; muat ulang akan mengatur ulang simulasi.' : '';

    function valid() {
        if (demo || staffSession('admin')?.token === session.token) return true;
        panel.hidden = true;
        queue.replaceChildren();
        location.replace('admin-masuk.html');
        return false;
    }

    document.querySelector('#staff-logout').addEventListener('click', async () => {
        generation++;
        panel.hidden = true;
        try { if (!demo) await logoutStaff(session); }
        catch (error) { console.warn('Server logout could not be confirmed.', error); }
        finally { location.replace('admin-masuk.html'); }
    });
    window.addEventListener('pagehide', () => {
        generation++;
        panel.hidden = true;
        queue.replaceChildren();
        dialog.close();
    });
    window.addEventListener('pageshow', () => {
        if (valid()) { panel.hidden = false; void refreshQueue(); }
    });
    refresh.addEventListener('click', () => void refreshQueue());
    document.querySelector('#cancel-decision').addEventListener('click', () => dialog.close());
    document.querySelector('#confirm-decision').addEventListener('click', () => {
        const action = pending;
        dialog.close();
        if (action) void decide(action.item, action.decision);
    });
    void refreshQueue();

    async function refreshQueue() {
        if (busy || !valid()) return;
        const request = generation;
        busy = true;
        refresh.disabled = true;
        queue.replaceChildren();
        status.textContent = [notice, 'Memuat antrean…'].filter(Boolean).join(' ');
        try {
            const items = demo ? mockAccounts.filter(item => !item.decision) : await requestApi('admin/queue', {
                token: session.token, query: { type: 'botanist' },
            });
            if (!valid() || request !== generation) return;
            if (!Array.isArray(items)) throw new Error('Antrean belum dapat dibaca.');
            for (const item of items) {
                const row = document.createElement('li');
                const badge = document.createElement('span');
                badge.className = 'badge pending';
                badge.textContent = demo ? 'Menunggu · Simulasi' : 'Menunggu verifikasi';
                const name = document.createElement('h2');
                name.textContent = item.name;
                const nameLabel = document.createElement('p');
                nameLabel.className = 'eyebrow';
                nameLabel.textContent = 'Nama lengkap';
                const heading = document.createElement('div');
                heading.className = 'verification-card-heading';
                const identity = document.createElement('div');
                identity.append(nameLabel, name);
                heading.append(identity, badge);
                const detail = document.createElement('dl');
                detail.className = 'verification-details';
                const joined = item.created_at ? new Date(item.created_at) : null;
                const registrationDate = joined && Number.isFinite(joined.getTime())
                    ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium' }).format(joined) : 'Belum tersedia';
                for (const [label, value] of [['Email', item.email], ['Nomor lisensi', item.license_number], ['Asal institusi', item.institution || 'Belum diisi'], ['Provinsi', item.province || 'Belum diisi'], ['Kabupaten/Kota', item.city || 'Belum diisi'], ['Tanggal pendaftaran', registrationDate], ['Status verifikasi', 'Menunggu verifikasi']]) {
                    const field = document.createElement('div');
                    const term = document.createElement('dt');
                    const description = document.createElement('dd');
                    term.textContent = label;
                    description.textContent = value;
                    field.append(term, description);
                    detail.append(field);
                }
                const actions = document.createElement('div');
                actions.className = 'actions';
                for (const [decision, label] of [['approve', 'Setujui'], ['reject', 'Tolak']]) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.textContent = label;
                    button.className = decision === 'reject' ? 'secondary' : '';
                    button.addEventListener('click', () => {
                        if (busy || !valid()) return;
                        pending = { item, decision };
                        document.querySelector('#confirmation-detail').textContent =
                            `${label} permohonan ${item.name}?${demo ? ' Keputusan ini adalah simulasi.' : ''}`;
                        dialog.showModal();
                    });
                    actions.append(button);
                }
                row.append(heading, detail, actions);
                queue.append(row);
            }
            status.textContent = [notice, items.length ? 'Tinjau permohonan pada bagian Verifikasi Botani.' : 'Tidak ada permintaan yang menunggu.'].filter(Boolean).join(' ');
        } catch (error) {
            showError(error);
        } finally {
            busy = false;
            refresh.disabled = false;
        }
    }

    async function decide(item, decision) {
        if (busy || !valid()) return;
        const request = generation;
        busy = true;
        refresh.disabled = true;
        for (const button of queue.querySelectorAll('button')) button.disabled = true;
        status.textContent = [notice, 'Menyimpan keputusan…'].filter(Boolean).join(' ');
        let succeeded = false;
        try {
            if (demo) item.decision = decision;
            else {
                const result = await requestApi('admin/approve', {
                    method: 'POST', token: session.token,
                    body: { target_id: item.id, approval_type: 'botanist_license', decision },
                });
                if (result.updated_status !== (decision === 'approve' ? 'approved' : 'rejected')) {
                    throw new Error('Keputusan belum dikonfirmasi oleh server.');
                }
            }
            if (!valid() || request !== generation) return;
            const badge = document.createElement('span');
            badge.className = 'badge ' + (decision === 'approve' ? 'approved' : 'rejected');
            badge.textContent = decision === 'approve' ? 'Disetujui' : 'Ditolak';
            feedback.replaceChildren(badge, document.createTextNode(` ${item.name} · ${demo ? 'Keputusan simulasi di halaman ini.' : 'Keputusan tersimpan di server.'}`));
            succeeded = true;
        } catch (error) {
            if (request === generation) showError(error);
        } finally {
            busy = false;
            refresh.disabled = false;
            for (const button of queue.querySelectorAll('button')) button.disabled = false;
        }
        if (succeeded) await refreshQueue();
    }

    function showError(error) {
        status.textContent = error.message;
        if (error.status === 401 || error.status === 403) {
            forgetStaffSession();
            queue.replaceChildren();
            feedback.replaceChildren();
            panel.hidden = true;
            location.replace('admin-masuk.html');
        }
    }
}
