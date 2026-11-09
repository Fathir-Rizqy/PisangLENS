import { requestApi } from './api.js';
import './app-update.js';
import { initializeRegionExamples } from './region-examples.js';

export const PROFILE_KEY = 'pisanglens-farmer-profile';
const TOKEN_KEY = 'pisanglens-farmer-token';
const STAFF_KEY = 'pisanglens-staff-session';
const LOGOUT_NOTICE_KEY = 'pisanglens-logout-notice';
const ROLE_PAGES = {
    admin: 'admin-verifikasi.html',
    botani: 'botani-akun.html',
};

export function activeProfile() {
    const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null');
    return profile?.role === 'petani' && profile.ownerId ? profile : null;
}

export function sessionToken(profile) {
    const session = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null');
    if (!profile.demo && session?.ownerId === profile.ownerId &&
        Date.parse(session.expiresAt) > Date.now()) return session.token;
    return null;
}

export function forgetToken() {
    sessionStorage.removeItem(TOKEN_KEY);
}

export async function logout(profile) {
    const token = sessionToken(profile);
    forgetToken();
    localStorage.removeItem(PROFILE_KEY);
    await revokeSession(token);
}

function enter(profile, session) {
    forgetToken();
    sessionStorage.removeItem(STAFF_KEY);
    if (session) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(session));
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    location.assign('petani-kamera.html');
}

export function staffSession(role) {
    try {
        const session = JSON.parse(sessionStorage.getItem(STAFF_KEY) ?? 'null');
        return session?.role === role && session.token && Date.parse(session.expires_at) > Date.now()
            ? session : null;
    } catch {
        return null;
    }
}

export function forgetStaffSession() {
    sessionStorage.removeItem(STAFF_KEY);
}

export async function logoutStaff(session) {
    forgetStaffSession();
    await revokeSession(session.token);
}

async function revokeSession(token) {
    if (!token) return;
    try {
        await requestApi('auth/logout', { method: 'POST', token });
    } catch (error) {
        if (error.status === 401) return;
        sessionStorage.setItem(LOGOUT_NOTICE_KEY, 'Sesi lokal telah ditutup. Keluar dari server belum dapat dikonfirmasi.');
        throw error;
    }
}

function validate(form, registration) {
    const { email, name, password, confirmation } = form.elements;
    email.value = email.value.trim();
    if (!email.value || !email.validity.valid) {
        email.focus();
        throw new Error('Masukkan alamat email yang valid.');
    }
    if (registration && (!name.value.trim() || !name.validity.valid)) {
        name.focus();
        throw new Error('Masukkan nama lengkap.');
    }
    if (!password.value.trim()) {
        password.focus();
        throw new Error('Masukkan kata sandi.');
    }
    if (registration && password.value !== confirmation.value) {
        confirmation.focus();
        throw new Error('Kedua kata sandi harus sama.');
    }
    const bytes = new TextEncoder().encode(password.value).length;
    if (bytes > 72 || (registration && bytes < 8)) {
        password.focus();
        throw new Error('Gunakan kata sandi sepanjang 8–72 byte.');
    }
    return { email: email.value, password: password.value };
}

const form = document.querySelector('#login-form, #register-form');
if (form) {
    const status = document.querySelector('#auth-status');
    const logoutNotice = sessionStorage.getItem(LOGOUT_NOTICE_KEY);
    if (logoutNotice) {
        status.textContent = logoutNotice;
        sessionStorage.removeItem(LOGOUT_NOTICE_KEY);
    }
    const submit = form.querySelector('button[type="submit"]');
    const registration = form.id === 'register-form';
    const refreshRegionExamples = registration ? initializeRegionExamples(form) : () => {};
    const licenseField = document.querySelector('#license-field');
    function updateLicenseField() {
        const required = form.elements.role.value === 'botani';
        licenseField.hidden = !required;
        form.elements.license_number.disabled = !required;
        form.elements.license_number.required = required;
        document.querySelector('#professional-fields').hidden = !required;
        for (const field of ['institution', 'province', 'city']) {
            form.elements[field].disabled = !required;
            form.elements[field].required = required;
        }
    }
    if (registration) {
        if (new URLSearchParams(location.search).get('role') === 'botani') form.elements.role.value = 'botani';
        form.elements.role.addEventListener('change', updateLicenseField);
        updateLicenseField();
    } else {
        const role = new URLSearchParams(location.search).get('role');
        if (role === 'admin') location.replace('admin-masuk.html');
        const label = { petani: 'Petani', botani: 'Botani' }[role];
        if (label) document.querySelector('#login-title').textContent = `Masuk ${label}`;
    }
    form.addEventListener('submit', async event => {
        event.preventDefault();
        status.textContent = registration ? 'Mendaftarkan akun…' : 'Memeriksa akun…';
        submit.disabled = true;
        try {
            const body = validate(form, registration);
            if (registration) {
                const { role, name, license_number } = form.elements;
                body.name = name.value.trim();
                body.role = role.value;
                if (body.role === 'botani') {
                    body.license_number = license_number.value.trim();
                    if (!body.license_number || !license_number.validity.valid) {
                        license_number.focus();
                        throw new Error('Masukkan nomor lisensi botani.');
                    }
                    for (const field of ['institution', 'province', 'city']) {
                        const input = form.elements[field];
                        if (!input.value.trim() || !input.validity.valid) {
                            input.focus();
                            throw new Error('Lengkapi institusi, provinsi, dan kota/kabupaten.');
                        }
                        body[field] = input.value.trim();
                    }
                }
                const result = await requestApi('auth/register', {
                    method: 'POST', body,
                });
                if (result.status !== 'ok') {
                    throw new Error('Pendaftaran belum dikonfirmasi.');
                }
                form.reset();
                refreshRegionExamples();
                updateLicenseField();
                status.textContent = body.role === 'botani'
                    ? 'Pendaftaran berhasil. Admin perlu memverifikasi akun sebelum akses botani tersedia.'
                    : 'Pendaftaran berhasil. Silakan masuk melalui halaman masuk.';
                return;
            }
            const result = await requestApi('auth/login', { method: 'POST', body });
            if (!result.token || !result.user_id || !(Date.parse(result.expires_at) > Date.now())) {
                throw new Error('Sesi masuk tidak dapat diverifikasi.');
            }
            if (document.querySelector('[data-login-role="admin"]') && result.role !== 'admin') {
                await requestApi('auth/logout', { method: 'POST', token: result.token });
                throw new Error('Akun ini tidak memiliki akses Admin.');
            }
            if (Object.hasOwn(ROLE_PAGES, result.role)) {
                forgetToken();
                localStorage.removeItem(PROFILE_KEY);
                sessionStorage.setItem(STAFF_KEY, JSON.stringify(result));
                location.assign(ROLE_PAGES[result.role]);
                return;
            }
            if (result.role !== 'petani') throw new Error('Peran akun tidak dikenal.');
            const ownerId = String(result.user_id);
            enter({ ownerId, role: 'petani', name: result.name, demo: false }, {
                ownerId, token: result.token, expiresAt: result.expires_at,
            });
        } catch (error) {
            status.textContent = error.message;
        } finally {
            submit.disabled = false;
        }
    });
}
