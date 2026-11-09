import assert from 'node:assert/strict';

const storage = () => {
    const values = new Map();
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key),
    };
};
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.document = { querySelector: () => null };
const auth = await import('../public/js/auth.js');
const profile = { ownerId: '12', demo: false };
const tokenKey = 'pisanglens-farmer-token';
const noticeKey = 'pisanglens-logout-notice';
localStorage.setItem(auth.PROFILE_KEY, JSON.stringify(profile));
sessionStorage.setItem(tokenKey, JSON.stringify({ ownerId: '12', token: 'test-token', expiresAt: new Date(Date.now() + 60000).toISOString() }));
globalThis.fetch = async () => { throw new TypeError('Network unavailable'); };
await assert.rejects(auth.logout(profile));
assert.equal(localStorage.getItem(auth.PROFILE_KEY), null);
assert.equal(sessionStorage.getItem(tokenKey), null);
assert.match(sessionStorage.getItem(noticeKey), /belum dapat dikonfirmasi/);
console.log('PASS: failed server logout clears local credentials and records an explicit warning');

sessionStorage.removeItem(noticeKey);
globalThis.fetch = async () => new Response('{"status":"error"}', { status: 401 });
await auth.logoutStaff({ token: 'already-expired-token' });
assert.equal(sessionStorage.getItem(noticeKey), null);
console.log('PASS: an already-invalid server session is accepted as logged out');
