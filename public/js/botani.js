import { MOCK_PREDICTION_LABEL } from './config.js';
import { staffSession, logoutStaff, forgetStaffSession } from './auth.js';
import { initializeDashboard } from './dashboard.js';
import { consultationService, consultationStatus } from './consultations.js';
import { openConversation } from './chat.js';
import { scanPhoto } from './photos.js';
import { requestApi } from './api.js';
import { initializeRegionExamples } from './region-examples.js';
import { expertReview } from './learning.js';

const demo = new URLSearchParams(location.search).get('demo') === '1';
const session = demo ? null : staffSession('botani');
const el = id => document.getElementById(id);
if (!demo && !session) location.replace('index.html?role=botani');
else initialize();

function initialize() {
    initializeDashboard();
    const panel = el('staff-panel');
    const refresh = el('load-tickets');
    const service = consultationService({ demo, token: session?.token, botanist: true });
    let allowed = demo;
    let selected;
    let busy = false;
    let generation = 0;
    let disposeChat = () => {};
    let disposePhoto = () => {};
    let disposeReview = () => {};
    let refreshingProfile = false;
    let savingProfile = false;
    let profileRevision = 0;
    const profileForm = el('profile-form');
    const refreshRegions = initializeRegionExamples(profileForm);
    let profileDirty = false;
    const conversationKey = 'pisanglens-botani-ticket:' + (demo ? 'demo' : session.user_id);

    panel.hidden = false;
    el('botanist-name').textContent = demo ? 'Botani Demo' : session.name;
    el('staff-status').textContent = demo ? 'Simulasi botani · Tiket dan foto dari demo petani di peramban ini. Semua perubahan tersimpan lokal.'
        : 'Memeriksa status akun dari server…';
    el('botanist-badge').textContent = demo ? 'Simulasi Botani' : 'Memeriksa akun';
    el('botanist-badge').classList.add(allowed ? 'approved' : 'pending');
    refresh.disabled = !allowed;
    if (!allowed) {
        el('ticket-status').textContent = 'Verifikasi admin diperlukan untuk mengakses tiket.';
        el('assigned-status').textContent = 'Verifikasi admin diperlukan untuk mengakses konsultasi.';
    }

    function clearPrivate() {
        generation++;
        selected = null;
        disposeChat();
        disposePhoto();
        disposeReview();
        el('ticket-list').replaceChildren();
        el('assigned-list').replaceChildren();
        el('ticket-detail').replaceChildren();
    }
    function valid() {
        if (demo || staffSession('botani')?.token === session.token) return true;
        clearPrivate();
        panel.hidden = true;
        location.replace('index.html?role=botani');
        return false;
    }
    function failure(error, target) {
        if (error.status === 401) {
            allowed = false;
            clearPrivate();
            forgetStaffSession();
            panel.hidden = true;
            location.replace('index.html?role=botani');
            return;
        }
        if (error.status === 403) { allowed = false; clearPrivate(); refresh.disabled = true; }
        el(target).textContent = error.message;
    }
    function showDetail(ticket) {
        const confidence = ticket.confidence_score == null ? 'belum tersedia'
            : new Intl.NumberFormat('id-ID', { style: 'percent' }).format(Number(ticket.confidence_score));
        el('ticket-detail').textContent = `${ticket.predicted_class || 'Kelas belum tersedia'} · Keyakinan ${confidence} · ${consultationStatus(ticket.status)}${demo ? ' · Simulasi konsultasi lokal' : ' · Konsultasi nyata'}${ticket.prediction_source === 'mock' ? ' · ' + MOCK_PREDICTION_LABEL : ''}`;
    }

    async function loadTickets() {
        if (busy || !allowed || !valid()) return;
        busy = true;
        const request = generation;
        let restore;
        refresh.disabled = true;
        el('ticket-status').textContent = 'Memuat tiket…';
        el('assigned-status').textContent = 'Memuat konsultasi…';
        el('ticket-list').replaceChildren();
        el('assigned-list').replaceChildren();
        try {
            const tickets = await service.list();
            if (!valid() || request !== generation) return;
            const current = selected && tickets.find(ticket => String(ticket.id) === String(selected.id));
            if (current) {
                selected.status = current.status;
                showDetail(current);
                if (current.status === 'closed') el('reply-form').hidden = true;
            }
            for (const ticket of tickets) {
                const mine = String(ticket.botani_id) === String(demo ? 'demo' : session.user_id);
                if (ticket.botani_id && !mine) continue;
                if (mine && !selected && location.hash === '#obrolan' && sessionStorage.getItem(conversationKey) === String(ticket.id)) restore = ticket;
                const row = document.createElement('li');
                const title = document.createElement('p');
                title.textContent = `Tiket ${ticket.id}${demo ? ' · Simulasi konsultasi lokal' : ' · Konsultasi nyata'}${Number(ticket.prediction_simulated) || ticket.prediction_source === 'mock' ? ' · ' + MOCK_PREDICTION_LABEL : ''}`;
                const badge = document.createElement('span');
                badge.className = 'badge';
                badge.textContent = consultationStatus(ticket.status);
                row.append(badge, title);
                if (mine || ticket.status === 'open') {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.textContent = mine ? 'Buka obrolan' : 'Ambil tiket';
                    button.addEventListener('click', () => void openTicket(ticket, mine));
                    row.append(button);
                }
                el(mine ? 'assigned-list' : 'ticket-list').append(row);
            }
            el('ticket-status').textContent = el('ticket-list').children.length ? '' : 'Belum ada tiket tersedia.';
            el('assigned-status').textContent = el('assigned-list').children.length ? '' : 'Belum ada konsultasi yang Anda tangani.';
        } catch (error) {
            failure(error, 'ticket-status');
            el('assigned-status').textContent = el('ticket-status').textContent;
        } finally { busy = false; refresh.disabled = !allowed; }
        if (restore && valid()) void openTicket(restore, true);
    }

    async function openTicket(ticket, mine) {
        if (busy || !allowed || !valid()) return;
        busy = true;
        clearPrivate();
        const request = generation;
        try {
            if (!mine) {
                const claimed = await service.claim(ticket.id);
                if (String(claimed.consultation_id) !== String(ticket.id)) throw new Error('Pengambilan tiket belum dikonfirmasi.');
            }
            const tickets = await service.list();
            const owned = tickets.find(item => String(item.id) === String(ticket.id) &&
                String(item.botani_id) === String(demo ? 'demo' : session.user_id));
            if (!owned) throw new Error('Tiket belum ditugaskan kepada akun Anda.');
            if (!valid() || request !== generation) return;
            selected = owned;
            sessionStorage.setItem(conversationKey, String(owned.id));
            showDetail(owned);
            disposePhoto = scanPhoto(el('ticket-photo'), owned, demo ? null : session.token, valid);
            location.hash = 'obrolan';
            disposeReview = expertReview(el('training-review'), { ticket: owned, token: session?.token, demo,
                active: () => valid() && location.hash === '#obrolan' && selected?.id === owned.id });
            disposeChat = openConversation({
                service, ticket: owned, list: el('chat-messages'), status: el('chat-status'), form: el('reply-form'),
                senderId: demo ? 'demo' : session.user_id, demo,
                active: () => valid() && location.hash === '#obrolan' && selected?.id === owned.id,
                onSent: () => void loadTickets(),
                onUpdate: ticket => {
                    if (valid() && selected && String(ticket.id) === String(selected.id)) {
                        selected.status = ticket.status;
                        showDetail({ ...selected, ...ticket });
                    }
                },
            });
        } catch (error) { failure(error, 'ticket-status'); }
        finally { busy = false; if (selected) void loadTickets(); }
    }

    refresh.addEventListener('click', () => void loadTickets());
    window.addEventListener('hashchange', () => {
        if (location.hash === '#antrean' || location.hash === '#ditangani') void loadTickets();
        if (location.hash === '#akun') void refreshProfile();
    });
    el('staff-logout').addEventListener('click', async () => {
        sessionStorage.removeItem(conversationKey);
        clearPrivate(); panel.hidden = true;
        try { if (!demo) await logoutStaff(session); }
        catch (error) { console.warn('Logout could not be confirmed.', error); }
        finally { location.replace('index.html?role=botani'); }
    });
    let poll;
    function startPolling() {
        clearInterval(poll);
        poll = setInterval(() => {
            if (document.visibilityState !== 'visible' || !valid()) return;
            void refreshProfile(false);
            if (location.hash === '#antrean' || location.hash === '#ditangani') void loadTickets();
        }, 8000);
    }
    window.addEventListener('pagehide', () => { clearInterval(poll); clearPrivate(); panel.hidden = true; });
    window.addEventListener('pageshow', () => { if (valid()) { panel.hidden = false; startPolling(); void refreshProfile(); } });
    profileForm.addEventListener('input', () => { profileDirty = true; });
    el('profile-refresh').addEventListener('click', () => void refreshProfile());
    profileForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (!valid() || savingProfile) return;
        const body = {};
        for (const field of ['name', 'institution', 'province', 'city']) {
            const input = profileForm.elements[field];
            if (!input.value.trim() || !input.validity.valid) {
                input.focus();
                el('profile-status').textContent = 'Lengkapi semua informasi profil sesuai batas panjang isian.';
                return;
            }
            body[field] = input.value.trim();
        }
        const button = profileForm.querySelector('button');
        const revision = ++profileRevision;
        button.disabled = true;
        savingProfile = true;
        el('profile-refresh').disabled = true;
        for (const field of ['name', 'institution', 'province', 'city']) profileForm.elements[field].disabled = true;
        el('profile-status').textContent = 'Menyimpan profil…';
        try {
            const profile = demo ? { ...body, email: 'botani-demo@example.test', is_verified: 1, verification_status: 'approved', created_at: null }
                : await requestApi('botanist/profile', { method: 'POST', token: session.token, body });
            if (!valid() || revision !== profileRevision) return;
            profileDirty = false;
            renderProfile(profile);
            el('profile-status').textContent = demo ? 'Profil simulasi diperbarui di halaman ini.' : 'Profil Anda tersimpan di server.';
        } catch (error) { failure(error, 'profile-status'); }
        finally {
            savingProfile = false;
            button.disabled = false;
            el('profile-refresh').disabled = refreshingProfile;
            for (const field of ['name', 'institution', 'province', 'city']) profileForm.elements[field].disabled = false;
        }
    });

    function renderProfile(profile) {
        const previouslyAllowed = allowed;
        allowed = demo || Number(profile.is_verified) === 1;
        const labels = { approved: 'Terverifikasi', pending: 'Menunggu verifikasi', rejected: 'Ditolak' };
        const status = labels[profile.verification_status] || 'Belum tersedia';
        for (const field of ['name', 'email', 'institution', 'province', 'city']) {
            el('profile-' + field).textContent = profile[field] || 'Belum diisi';
            if (!profileDirty && profileForm.elements[field]) profileForm.elements[field].value = profile[field] || '';
        }
        refreshRegions();
        el('profile-verification').textContent = demo ? 'Simulasi · ' + status : status;
        const joined = profile.created_at ? new Date(profile.created_at) : null;
        el('profile-joined').textContent = joined && Number.isFinite(joined.getTime())
            ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium' }).format(joined) : 'Belum tersedia';
        el('botanist-name').textContent = profile.name || 'Ruang Botani';
        el('botanist-badge').textContent = demo ? 'Simulasi Botani' : status;
        el('botanist-badge').className = 'badge ' + (allowed ? 'approved' : 'pending');
        el('staff-status').textContent = demo ? 'Simulasi botani · Data dan percakapan lokal di peramban ini.'
            : allowed ? 'Akun botani terverifikasi.' : status + ' · Akses tiket dibatasi hingga akun disetujui.';
        refresh.disabled = !allowed;
        if (!allowed) {
            clearPrivate();
            el('ticket-status').textContent = 'Verifikasi admin diperlukan untuk mengakses tiket.';
            el('assigned-status').textContent = 'Verifikasi admin diperlukan untuk mengakses konsultasi.';
        } else if (!previouslyAllowed || (
            location.hash === '#obrolan' && !selected && sessionStorage.getItem(conversationKey)
        )) {
            void loadTickets();
        }
        el('profile-mode').textContent = demo ? 'Simulasi profil · Perubahan hanya berlaku pada halaman ini.' : 'Perubahan disimpan untuk akun Anda yang sedang masuk.';
    }

    async function refreshProfile(showLoading = true) {
        if (refreshingProfile || savingProfile || !valid()) return;
        if (demo) {
            if (el('profile-name').textContent === 'Memuat…') renderProfile({ name: 'Botani Demo', email: 'botani-demo@example.test', is_verified: 1, verification_status: 'approved', created_at: null });
            void loadTickets();
            return;
        }
        refreshingProfile = true;
        const revision = profileRevision;
        el('profile-refresh').disabled = true;
        if (showLoading) el('profile-status').textContent = 'Memuat profil terbaru…';
        try {
            const profile = await requestApi('botanist/profile', { token: session.token });
            if (!valid() || revision !== profileRevision) return;
            renderProfile(profile);
            if (showLoading) el('profile-status').textContent = 'Status akun diperbarui dari server.';
        } catch (error) {
            if (revision === profileRevision) failure(error, 'profile-status');
        }
        finally { refreshingProfile = false; el('profile-refresh').disabled = savingProfile; }
    }
    void refreshProfile();
    startPolling();
    if (demo) void loadTickets();
}
