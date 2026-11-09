import { requestApi } from './api.js';
import { activeProfile, forgetToken, logout, PROFILE_KEY, sessionToken } from './auth.js';
import { capture, closeCamera, openCamera, uploadPhoto } from './camera.js';
import { CONFIDENCE_THRESHOLD, FALLBACK, MOCK_PREDICTION_LABEL, USE_MOCK_PREDICTION } from './config.js';
import { consultationEligible, consultationService, consultationStatus } from './consultations.js';
import { openConversation } from './chat.js';
import { encryptMessage } from './crypto.js';
import { scanPhoto } from './photos.js';
import { initializeDirectory } from './directory.js';
import { saveScan, scansFor } from './db.js';
import { conditions } from './dictionary.js';
import { predict } from './predict.js';
import { prepareLocalOffline } from './offline.js';
import { syncScans } from './sync.js';

const element = id => document.getElementById(id);
const profile = readProfile();
if (profile) initialize(profile);
else location.replace('index.html');

function readProfile() {
    try {
        return activeProfile();
    } catch {
        return null;
    }
}

function initialize(account) {
    const views = [...document.querySelectorAll('.view')];
    const links = [...document.querySelectorAll('#farmer-nav a')];
    const video = element('camera-video');
    const preview = element('image-preview');
    const fileInput = element('image-file');
    const predictButton = element('predict');
    const cameraStart = element('camera-start');
    const cameraCapture = element('camera-capture');
    const cameraStop = element('camera-stop');
    const consultationForm = element('consultation-form');

    const percentage = new Intl.NumberFormat('id-ID', { style: 'percent' });
    const date = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    let view;
    let photo;
    let result;
    let selectedScan;
    let cameraOpening = false;
    let photoBusy = false;
    let saving = false;
    let syncing = false;
    let historyRequest = 0;
    let consultationRequest = 0;
    let currentTicket;
    let currentService;
    let submittingConsultation = false;
    let firstSubmission;
    let disposeChat = () => {};
    let disposeConsultationPhoto = () => {};
    let photoCleanups = [];
    const conversationKey = 'pisanglens-farmer-ticket:' + account.ownerId;

    element('greeting').textContent = `Halo, ${account.name || 'Petani'}`;
    element('account-mode').textContent = account.demo ? 'Simulasi masuk · Profil demo lokal' : 'Akun petani';
    element('guidance').textContent = FALLBACK;
    element('prediction-mode').textContent = USE_MOCK_PREDICTION ? MOCK_PREDICTION_LABEL
        : 'Foto dianalisis oleh model AI di perangkat ini. Hasil merupakan identifikasi awal kondisi daun.';
    element('farmer-app').hidden = false;
    element('farmer-nav').hidden = false;
    const loadDirectory = initializeDirectory({ root: element('farmer-directory'), demo: account.demo, token: sessionToken(account), valid: sameAccount });

    function sameAccount() {
        return readProfile()?.ownerId === account.ownerId;
    }

    function enforceAccount() {
        if (!sameAccount()) {
            stopCamera();
            disposeChat();
            photoCleanups.forEach(dispose => dispose());
            element('farmer-app').hidden = true;
            element('farmer-nav').hidden = true;
            forgetToken();
            location.replace('index.html');
        }
    }

    function sessionError(error, target) {
        if (error.status === 401) {
            forgetToken();
            element('session-message').textContent = 'Sesi daring berakhir. Masuk kembali untuk menggunakan layanan server.';
        }
        element(target).textContent = error.message;
    }

    function stopCamera() {
        closeCamera(video);
        video.hidden = true;
        cameraStop.hidden = true;
        cameraCapture.hidden = true;
        cameraStart.disabled = cameraOpening;
    }

    function changeView() {
        const requested = location.hash.slice(1);
        view = views.some(section => section.id === requested) ? requested : 'kamera';
        for (const section of views) section.hidden = section.id !== view;
        for (const link of links) {
            if (link.hash === `#${view}`) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        }
        if (view !== 'kamera') stopCamera();
        if (view !== 'konsultasi') { consultationRequest++; disposeChat(); disposeConsultationPhoto(); currentTicket = null; sessionStorage.removeItem(conversationKey); }
        if (view !== 'riwayat') { historyRequest++; photoCleanups.forEach(dispose => dispose()); photoCleanups = []; }
        if (view === 'direktori') void loadDirectory();
        if (view === 'riwayat') void showHistory();
        if (view === 'konsultasi') void showConsultation();
    }

    async function loadPhoto(load) {
        if (photoBusy || saving) return;
        photoBusy = true;
        photo = null;
        result = null;
        preview.hidden = true;
        predictButton.disabled = true;
        fileInput.disabled = true;
        cameraCapture.disabled = true;
        element('prediction-result').hidden = true;
        element('prediction-message').textContent = '';
        element('photo-message').textContent = 'Memeriksa foto…';
        try {
            photo = await load();
            preview.hidden = false;
            predictButton.disabled = false;
            element('photo-message').textContent = 'Foto siap. Pilih Analisis foto untuk melanjutkan.';
        } catch (error) {
            element('photo-message').textContent = error.message;
        } finally {
            photoBusy = false;
            fileInput.disabled = false;
            cameraCapture.disabled = false;
        }
    }

    cameraStart.addEventListener('click', async () => {
        cameraOpening = true;
        cameraStart.disabled = true;
        element('photo-message').textContent = 'Meminta akses kamera…';
        try {
            await openCamera(video);
            if (view !== 'kamera' || !sameAccount()) return;
            video.hidden = false;
            cameraStop.hidden = false;
            cameraCapture.hidden = false;
            element('photo-message').textContent = 'Arahkan kamera ke daun.';
        } catch (error) {
            const permission = ['NotAllowedError', 'SecurityError'].includes(error.name);
            element('photo-message').textContent = permission
                ? 'Izin kamera ditolak. Aktifkan izin di peramban atau unggah foto.'
                : `${error.name === 'Error' ? error.message : 'Kamera tidak dapat dibuka.'} Anda dapat mengunggah foto.`;
        } finally {
            cameraOpening = false;
            if (video.hidden || view !== 'kamera') stopCamera();
        }
    });
    cameraStop.addEventListener('click', stopCamera);
    cameraCapture.addEventListener('click', async () => {
        await loadPhoto(() => capture(video, preview));
        if (photo) stopCamera();
    });
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        stopCamera();
        void loadPhoto(() => uploadPhoto(file, preview));
    });

    predictButton.addEventListener('click', async () => {
        if (!photo || saving) return;
        result = null;
        const source = photo;
        predictButton.disabled = true;
        element('prediction-result').hidden = true;
        element('prediction-message').textContent = 'Memproses permintaan…';
        try {
            const prediction = await predict(source.input);
            if (photo !== source || !sameAccount()) return;
            result = {
                owner_user_id: account.ownerId,
                client_uuid: crypto.randomUUID(),
                image_blob: source.image,
                predicted_class: prediction.class_name,
                confidence_score: prediction.confidence_score,
                prediction_source: prediction.prediction_source,
                model_version: prediction.model_version,
                created_at: new Date().toISOString(),
                is_synced: false,
            };
            const low = isLow(result);
            const healthy = result.predicted_class === 'Healthy';
            const summary = element('result-summary');
            summary.className = `result ${low ? 'amber' : healthy ? 'healthy' : 'disease'}`;
            const status = low ? 'Keyakinan model rendah' : healthy ? 'Kondisi sehat' : 'Terindikasi penyakit';
            summary.textContent = `${status} · ${scanLabel(result)}`;
            element('result-consult').replaceChildren();
            if (consultationEligible(result)) {
                const retake = document.createElement('button');
                retake.type = 'button';
                retake.className = 'secondary';
                retake.textContent = 'Potret ulang';
                retake.addEventListener('click', () => (video.hidden ? cameraStart : cameraCapture).focus());
                element('result-consult').append(consultationLink(result), retake);
            }
            element('save-scan').disabled = false;
            element('save-message').textContent = '';
            element('prediction-result').hidden = false;
            element('prediction-message').textContent = '';
        } catch (error) {
            element('prediction-message').textContent = error.message;
        } finally {
            predictButton.disabled = photoBusy || !photo;
        }
    });

    element('save-scan').addEventListener('click', async () => {
        if (!result || saving || !sameAccount()) return;
        saving = true;
        element('save-scan').disabled = true;
        fileInput.disabled = true;
        cameraCapture.disabled = true;
        result.triage_phase = element('phase').value;
        try {
            await saveScan(result);
            element('save-message').textContent = 'Pemindaian disimpan di riwayat lokal.';
            if (view === 'riwayat') void showHistory();
            void trySync();
        } catch {
            element('save-message').textContent = 'Riwayat tidak dapat disimpan di peramban. Coba lagi.';
            element('save-scan').disabled = false;
        } finally {
            saving = false;
            fileInput.disabled = false;
            cameraCapture.disabled = false;
        }
    });

    function scanLabel(scan) {
        const simulation = scan.prediction_source === 'mock' ? ' · ' + MOCK_PREDICTION_LABEL : '';
        return `${scan.predicted_class} · Keyakinan ${percentage.format(scan.confidence_score)}${simulation}`;
    }

    function consultationLink(scan) {
        const link = document.createElement('a');
        link.className = 'action-link';
        link.href = '#konsultasi';
        link.textContent = 'Konsultasi botani';
        link.addEventListener('click', event => {
            event.preventDefault();
            selectedScan = scan;
            firstSubmission = null;
            currentTicket = null;
            sessionStorage.removeItem(conversationKey);
            element('first-message').value = '';
            if (location.hash === '#konsultasi') void showConsultation();
            else location.hash = 'konsultasi';
        });
        return link;
    }

    async function showHistory() {
        const request = ++historyRequest;
        photoCleanups.forEach(dispose => dispose());
        photoCleanups = [];
        const list = element('history-list');
        list.replaceChildren();
        element('history-message').textContent = 'Memuat riwayat…';
        try {
            const scans = await scansFor(account.ownerId);
            let ticketStateAvailable = true;
            const tickets = await allTickets().catch(() => { ticketStateAvailable = false; return []; });
            if (request !== historyRequest || !sameAccount()) return;
            for (const scan of scans) {
                const row = document.createElement('li');
                const title = document.createElement('strong');
                const detail = document.createElement('p');
                title.textContent = scanLabel(scan);
                const ticket = tickets.find(item => !item.simulation && scan.server_scan_id && String(item.scan_id) === String(scan.server_scan_id))
                    ?? tickets.find(item => item.client_uuid === scan.client_uuid);
                detail.textContent = `${date.format(new Date(scan.created_at))} · ${syncLabel(scan)} · Konsultasi ${ticket ? consultationStatus(ticket.status) : !ticketStateAvailable ? 'belum dapat diperiksa' : consultationEligible(scan) ? 'belum dibuat' : 'tidak diperlukan'}`;
                const photoContainer = document.createElement('div');
                row.append(photoContainer, title, detail);
                photoCleanups.push(scanPhoto(photoContainer, scan, sessionToken(account), () => sameAccount() && request === historyRequest));
                const details = document.createElement('details');
                details.className = 'scan-detail';
                const summary = document.createElement('summary');
                summary.textContent = 'Detail pemindaian';
                const metadata = document.createElement('p');
                metadata.textContent = `Sumber: ${scan.prediction_source} · Versi: ${scan.model_version || 'Belum tersedia'} · Fase: ${scan.triage_phase || 'Belum dipilih'}`;
                details.append(summary, metadata);
                if (consultationEligible(scan)) details.append(consultationLink(scan));
                row.append(details);
                list.append(row);
            }
            element('history-message').textContent = scans.length ? '' : 'Belum ada pemindaian tersimpan.';
        } catch {
            if (request === historyRequest) element('history-message').textContent = 'Riwayat lokal tidak dapat dibuka.';
        }
    }

    async function trySync() {
        const token = sessionToken(account);
        if (syncing || !token || !navigator.onLine || !sameAccount()) return;
        syncing = true;
        try {
            await syncScans(account.ownerId, token, () => sameAccount() && sessionToken(account) === token);
            if (!sameAccount()) return;
            if (view === 'riwayat') await showHistory();
            if (view === 'konsultasi' && !currentTicket) await showConsultation();
        } catch (error) {
            if (sameAccount()) sessionError(error, 'session-message');
        } finally {
            syncing = false;
        }
    }

    function service(demoMode) {
        return consultationService({ demo: demoMode, token: sessionToken(account), ownerId: account.ownerId });
    }

    async function allTickets() {
        const local = await service(true).list();
        const token = sessionToken(account);
        if (account.demo) return local;
        if (!token) throw new Error('Masuk kembali untuk memuat konsultasi dari server. Riwayat lokal tetap tersimpan.');
        return [...local, ...await service(false).list()];
    }

    function showConversation(ticket, simulated) {
        disposeChat();
        disposeConsultationPhoto();
        currentTicket = ticket;
        sessionStorage.setItem(conversationKey, String(ticket.id));
        currentService = service(simulated);
        element('consultation-list').replaceChildren();
        element('consultation-back').hidden = false;
        element('consultation-retry').hidden = true;
        const updateDetail = updated => {
            const stage = updated.status === 'closed' ? 'Ditutup' : updated.status === 'answered' ? 'Dibalas Botani'
                : updated.botani_id ? 'Ditangani Botani' : 'Menunggu Botani';
            element('consultation-detail').textContent = `${simulated ? 'Simulasi konsultasi lokal · ' : 'Konsultasi nyata · '}${updated.prediction_source === 'mock' ? MOCK_PREDICTION_LABEL + ' · ' : ''}Status: ${stage}`;
        };
        updateDetail(ticket);
        disposeConsultationPhoto = scanPhoto(element('consultation-photo'), ticket, simulated ? null : sessionToken(account),
            () => sameAccount() && view === 'konsultasi' && currentTicket === ticket);
        consultationForm.querySelector('button').textContent = 'Kirim pesan';
        disposeChat = openConversation({
            service: currentService, ticket, list: element('consultation-messages'), status: element('consultation-message'),
            form: consultationForm, senderId: account.ownerId, demo: simulated,
            active: () => sameAccount() && view === 'konsultasi' && currentTicket?.id === ticket.id,
            onUpdate: updateDetail,
        });
    }

    async function showConsultation() {
        const request = ++consultationRequest;
        disposeChat();
        disposeConsultationPhoto();
        consultationForm.hidden = true;
        element('consultation-retry').hidden = true;
        element('consultation-message').textContent = '';
        element('consultation-list').replaceChildren();
        try {
            if (selectedScan) {
                let scan = selectedScan;
                if (!consultationEligible(scan)) throw new Error('Hasil sehat dengan keyakinan tinggi tidak memerlukan konsultasi.');
                element('consultation-detail').textContent = 'Menyiapkan konsultasi…';
                const existing = (await scansFor(account.ownerId)).find(item => item.client_uuid === scan.client_uuid);
                if (request !== consultationRequest || !sameAccount()) return;
                if (existing) scan = existing;
                else await saveScan({ ...scan, triage_phase: scan.triage_phase ?? element('phase').value });
                const tickets = await allTickets();
                if (request !== consultationRequest || !sameAccount()) return;
                const ticket = tickets.find(item => !item.simulation && scan.server_scan_id && String(item.scan_id) === String(scan.server_scan_id))
                    ?? tickets.find(item => item.client_uuid === scan.client_uuid);
                if (ticket) {
                    selectedScan = null;
                    showConversation(ticket, Boolean(ticket.simulation));
                    return;
                }
                currentTicket = null;
                selectedScan = scan;
                element('consultation-back').hidden = false;
                element('consultation-detail').textContent = `${account.demo ? 'Simulasi konsultasi lokal' : 'Konsultasi nyata'} · ${scanLabel(scan)}. Tulis pertanyaan, lalu kirim foto dan pertanyaan untuk membuka tiket.`;
                disposeConsultationPhoto = scanPhoto(element('consultation-photo'), scan, sessionToken(account), () => sameAccount() && selectedScan === scan && view === 'konsultasi');
                consultationForm.querySelector('button').textContent = 'Kirim foto dan pertanyaan';
                consultationForm.querySelector('button').disabled = submittingConsultation;
                consultationForm.elements.message.disabled = submittingConsultation;
                consultationForm.hidden = false;
                return;
            }
            const tickets = await allTickets();
            if (request !== consultationRequest || !sameAccount()) return;
            const restored = tickets.find(ticket => String(ticket.id) === sessionStorage.getItem(conversationKey));
            if (restored) {
                showConversation(restored, Boolean(restored.simulation));
                return;
            }
            currentTicket = null;
            element('consultation-back').hidden = true;
            element('consultation-detail').textContent = tickets.length ? 'Pilih konsultasi untuk membuka percakapan.' : 'Belum ada konsultasi. Buka hasil penyakit atau keyakinan rendah dari Kamera atau Riwayat.';
            for (const ticket of tickets) {
                const row = document.createElement('li');
                const text = document.createElement('p');
                const button = document.createElement('button');
                text.textContent = `${ticket.simulation ? 'Simulasi konsultasi lokal · ' : 'Konsultasi nyata · '}${ticket.prediction_source === 'mock' ? MOCK_PREDICTION_LABEL + ' · ' : ''}${ticket.predicted_class || 'Pemindaian daun'} · ${consultationStatus(ticket.status)}`;
                button.type = 'button';
                button.textContent = 'Buka percakapan';
                button.addEventListener('click', () => showConversation(ticket, Boolean(ticket.simulation)));
                row.append(text, button);
                element('consultation-list').append(row);
            }
        } catch (error) {
            if (request !== consultationRequest || !sameAccount()) return;
            element('consultation-detail').textContent = 'Konsultasi belum dapat dimuat. Coba lagi saat layanan tersedia.';
            element('consultation-retry').hidden = !selectedScan;
            sessionError(error, 'consultation-message');
        }
    }

    consultationForm.addEventListener('submit', async event => {
        if (!selectedScan) return;
        event.preventDefault();
        if (submittingConsultation || !sameAccount()) return;
        const text = consultationForm.elements.message.value.trim();
        if (!text || new TextEncoder().encode(text).length > 4000) {
            element('consultation-message').textContent = 'Tulis pertanyaan sepanjang 1–4000 byte.';
            return;
        }
        const draft = selectedScan;
        const request = ++consultationRequest;
        const button = consultationForm.querySelector('button');
        const active = () => sameAccount() && request === consultationRequest && view === 'konsultasi';
        submittingConsultation = true;
        button.disabled = true;
        consultationForm.elements.message.disabled = true;
        element('consultation-message').textContent = 'Mengirim foto dan pertanyaan…';
        try {
            let scan = (await scansFor(account.ownerId)).find(item => item.client_uuid === draft.client_uuid) || draft;
            if (!account.demo && !scan.server_scan_id) {
                const token = sessionToken(account);
                if (!token) throw new Error('Masuk kembali untuk mengirim konsultasi daring.');
                await syncScans(account.ownerId, token, sameAccount);
                scan = (await scansFor(account.ownerId)).find(item => item.client_uuid === draft.client_uuid);
            }
            if (!active()) return;
            if (!account.demo && !scan?.server_scan_id) throw new Error('Foto belum dikonfirmasi server. Pertanyaan belum terkirim; coba lagi.');
            const targetService = service(account.demo);
            const created = await targetService.create(scan);
            if (!created.consultation_id) throw new Error('Tiket belum dikonfirmasi server.');
            if (!firstSubmission || firstSubmission.text !== text || String(firstSubmission.id) !== String(created.consultation_id)) {
                firstSubmission = { id: created.consultation_id, text,
                    payload: await encryptMessage(text, await targetService.key(created.consultation_id)) };
            }
            if (!active()) return;
            const sent = await targetService.send(created.consultation_id, firstSubmission.payload);
            if (!sent.message_id) throw new Error('Pertanyaan belum dikonfirmasi. Coba lagi untuk memeriksa pengiriman.');
            // Keep the acknowledged ticket ID even if the following list request fails.
            sessionStorage.setItem(conversationKey, String(created.consultation_id));
            if (!active()) return;
            const tickets = await targetService.list();
            const ticket = tickets.find(item => String(item.id) === String(created.consultation_id));
            if (!ticket) throw new Error('Pertanyaan diterima server, tetapi tiket belum dapat dimuat. Muat ulang konsultasi.');
            selectedScan = null;
            firstSubmission = null;
            consultationForm.reset();
            showConversation(ticket, account.demo);
        } catch (error) {
            if (active()) sessionError(error, 'consultation-message');
        } finally {
            submittingConsultation = false;
            if (active() || (sameAccount() && selectedScan && !currentTicket && view === 'konsultasi')) {
                button.disabled = false;
                consultationForm.elements.message.disabled = false;
            }
        }
    });

    element('consultation-back').addEventListener('click', () => { selectedScan = null; firstSubmission = null; currentTicket = null; sessionStorage.removeItem(conversationKey); void showConsultation(); });
    element('consultation-retry').addEventListener('click', () => void showConsultation());
    element('consultation-refresh').addEventListener('click', async () => {
        if (!currentTicket) return void showConsultation();
        try {
            const tickets = await currentService.list();
            const ticket = tickets.find(item => String(item.id) === String(currentTicket.id));
            if (ticket && sameAccount() && view === 'konsultasi') showConversation(ticket, Boolean(ticket.simulation));
        } catch (error) { sessionError(error, 'consultation-message'); }
    });

    element('dictionary-search').addEventListener('input', showDictionary);
    element('logout').addEventListener('click', async () => {
        element('logout').disabled = true;
        sessionStorage.removeItem(conversationKey);
        element('farmer-app').hidden = true;
        element('farmer-nav').hidden = true;
        stopCamera();
        try {
            await logout(account);
        } catch (error) {
            console.warn('Server logout could not be confirmed.', error);
        } finally {
            location.replace('index.html');
        }
    });
    window.addEventListener('hashchange', changeView);
    window.addEventListener('storage', event => {
        if (event.key === PROFILE_KEY || event.key === null) enforceAccount();
    });
    window.addEventListener('pageshow', event => {
        enforceAccount();
        if (event.persisted && sameAccount()) { changeView(); void trySync(); void prepareOffline(); }
    });
    window.addEventListener('pagehide', () => { consultationRequest++; stopCamera(); disposeChat(); disposeConsultationPhoto(); photoCleanups.forEach(dispose => dispose()); });
    window.addEventListener('online', trySync);
    window.addEventListener('offline', () => {
        if (view === 'konsultasi') void showConsultation();
    });
    showDictionary();
    changeView();
    void prepareOffline();
    void trySync();
}

function isLow(scan) {
    return scan.confidence_score < CONFIDENCE_THRESHOLD;
}

function syncLabel(scan) {
    if (scan.prediction_source === 'mock') return `${scan.is_synced ? 'Tersinkron' : 'Tersimpan lokal'} · ${MOCK_PREDICTION_LABEL}`;
    return scan.is_synced ? 'Tersinkron' : 'Belum tersinkron';
}

function showDictionary() {
    const search = element('dictionary-search').value.trim().toLocaleLowerCase('id');
    const list = element('dictionary-list');
    list.replaceChildren();
    const matches = conditions.filter(item => `${item.name} ${item.terms}`.toLocaleLowerCase('id').includes(search));
    element('dictionary-count').textContent = matches.length ? `${matches.length} kondisi` : 'Kondisi tidak ditemukan.';
    for (const item of matches) {
        const card = document.createElement('article');
        const image = document.createElement('img');
        const heading = document.createElement('h3');
        const description = document.createElement('p');
        const guidance = document.createElement('p');
        card.className = 'dictionary-card';
        image.src = `icons/daun.svg#${item.sample}`;
        image.alt = '';
        image.width = 240;
        image.height = 112;
        heading.textContent = item.name;
        description.textContent = `${item.description} Gambar berupa ilustrasi.`;
        guidance.textContent = FALLBACK;
        card.append(image, heading, description, guidance);
        list.append(card);
    }
}

async function prepareOffline() {
    const status = element('offline-state');
    const detail = element('offline-detail');
    if (!navigator.serviceWorker) {
        detail.textContent = '· Persiapan memerlukan localhost atau HTTPS dengan dukungan service worker.';
        return;
    }
    status.textContent = 'Menyiapkan';
    detail.textContent = '· Memeriksa penyimpanan halaman.';
    const retry = element('offline-retry');
    if (retry) retry.disabled = true;
    try {
        await prepareLocalOffline();
        status.textContent = 'Siap luring';
        detail.textContent = '· Model AI lokal dan berkas aplikasi sudah diverifikasi.';
    } catch (error) {
        status.textContent = 'Gagal';
        detail.textContent = '· ' + error.message;
    } finally {
        if (retry) { retry.disabled = false; retry.onclick = () => void prepareOffline(); }
    }
}
