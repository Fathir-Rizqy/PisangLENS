import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { openConversation } from '../public/js/chat.js';
import { encryptMessage } from '../public/js/crypto.js';
import { requestApi } from '../public/js/api.js';

// Minimal DOM stubs keep these checks independent of browser packages.
class Element {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.textContent = '';
        this.hidden = false;
        this.disabled = false;
    }

    append(...children) {
        this.children.push(...children);
    }

    replaceChildren(...children) {
        this.children = [...children];
    }

    set innerHTML(value) {
        throw new Error('Messages must render through textContent.');
    }
}

class Form extends Element {
    constructor() {
        super('form');
        this.button = new Element('button');
        this.elements = { message: { value: '' } };
        this.listeners = new Set();
        this.resetCount = 0;
    }

    querySelector(selector) {
        assert.equal(selector, 'button');
        return this.button;
    }

    addEventListener(type, callback) {
        assert.equal(type, 'submit');
        this.listeners.add(callback);
    }

    removeEventListener(type, callback) {
        assert.equal(type, 'submit');
        this.listeners.delete(callback);
    }

    reset() {
        this.resetCount++;
        this.elements.message.value = '';
    }

    async submit() {
        for (const callback of [...this.listeners]) {
            await callback({ preventDefault() {} });
        }
    }
}

const originalDocument = globalThis.document;
globalThis.document = {
    visibilityState: 'hidden',
    createElement: tagName => new Element(tagName),
};
if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

const key = {
    key: Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64'),
    key_version: 1,
};
const disposers = new Set();

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function waitFor(predicate, description) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + description);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

function surface() {
    return { list: new Element('ul'), status: new Element('p'), form: new Form() };
}

function start(service, target, onSent = () => {}) {
    const dispose = openConversation({
        service,
        ticket: { id: 1, status: 'open' },
        ...target,
        senderId: 7,
        active: () => true,
        demo: false,
        onSent,
    });
    disposers.add(dispose);
    return () => { dispose(); disposers.delete(dispose); };
}

function basicService(overrides = {}) {
    return {
        key: async () => key,
        messages: async () => [],
        send: async () => ({ message_id: 1 }),
        ...overrides,
    };
}

async function check(name, operation) {
    try {
        await operation();
        console.log('PASS: ' + name);
    } finally {
        for (const dispose of [...disposers]) {
            dispose();
            disposers.delete(dispose);
        }
    }
}

try {
    await check('disposed send acknowledgement preserves the replacement form and button', async () => {
        const target = surface();
        const oldAck = deferred();
        const newAck = deferred();
        let oldStarted = false;
        let newStarted = false;
        let oldSent = 0;
        const disposeOld = start(basicService({
            send: async () => { oldStarted = true; return oldAck.promise; },
        }), target, () => oldSent++);
        await waitFor(() => !target.form.hidden, 'old conversation');
        target.form.elements.message.value = 'Old conversation message';
        const oldSubmission = target.form.submit();
        await waitFor(() => oldStarted, 'old send request');

        disposeOld();
        start(basicService({
            send: async () => { newStarted = true; return newAck.promise; },
        }), target);
        await waitFor(() => !target.form.hidden, 'replacement conversation');
        target.form.elements.message.value = 'Replacement conversation message';
        const newSubmission = target.form.submit();
        await waitFor(() => newStarted, 'replacement send request');
        const resets = target.form.resetCount;
        const status = target.status.textContent;
        oldAck.resolve({ message_id: 1 });
        await oldSubmission;

        assert.equal(target.form.elements.message.value, 'Replacement conversation message');
        assert.equal(target.form.resetCount, resets);
        assert.equal(target.form.button.disabled, true);
        assert.equal(target.status.textContent, status);
        assert.equal(oldSent, 0);
        newAck.resolve({ message_id: 2 });
        await newSubmission;
    });

    await check('disposed post-send refresh cannot overwrite a replacement conversation', async () => {
        const target = surface();
        const oldRefresh = deferred();
        let reads = 0;
        let refreshStarted = false;
        let oldSent = 0;
        const disposeOld = start(basicService({
            messages: async () => {
                reads++;
                if (reads === 1) return [];
                refreshStarted = true;
                return oldRefresh.promise;
            },
        }), target, () => oldSent++);
        await waitFor(() => !target.form.hidden, 'old conversation');
        target.form.elements.message.value = 'Acknowledged old message';
        const oldSubmission = target.form.submit();
        await waitFor(() => refreshStarted, 'post-send refresh');
        disposeOld();
        start(basicService(), target);
        await waitFor(() => !target.form.hidden, 'replacement conversation');
        target.form.elements.message.value = 'Replacement draft';
        const status = target.status.textContent;
        oldRefresh.resolve([]);
        await oldSubmission;
        assert.equal(target.status.textContent, status);
        assert.equal(target.form.elements.message.value, 'Replacement draft');
        assert.equal(target.form.button.disabled, false);
        assert.equal(oldSent, 0);
    });

    await check('lost acknowledgements retry the same encrypted payload without duplicating a message', async () => {
        const target = surface();
        const stored = [];
        const submitted = [];
        let sentEvents = 0;
        start(basicService({
            messages: async (_id, after) => stored.filter(message => message.id > after),
            send: async (_id, payload) => {
                submitted.push(structuredClone(payload));
                if (submitted.length === 1) {
                    stored.push({ id: 1, sender_id: 7, encrypted_message: payload });
                    throw new Error('Acknowledgement lost');
                }
                return { message_id: 1 };
            },
        }), target, () => sentEvents++);
        await waitFor(() => !target.form.hidden, 'conversation');
        target.form.elements.message.value = 'A message sent exactly once';
        await target.form.submit();
        assert.equal(target.form.elements.message.value, 'A message sent exactly once');
        assert.equal(target.form.button.disabled, false);
        assert.match(target.status.textContent, /Acknowledgement lost/);
        await target.form.submit();
        assert.equal(submitted.length, 2);
        assert.deepEqual(submitted[0], submitted[1]);
        assert.equal(stored.length, 1);
        assert.equal(target.list.children.length, 1);
        assert.equal(target.list.children[0].textContent, 'Anda: A message sent exactly once');
        assert.equal(target.form.elements.message.value, '');
        assert.equal(sentEvents, 1);
    });

    await check('decrypted message markup remains literal text', async () => {
        const target = surface();
        const text = '<img src=x onerror=alert(1)> & <script>example</script>';
        const payload = await encryptMessage(text, key);
        start(basicService({
            messages: async () => [{ id: 1, sender_id: 8, encrypted_message: payload }],
        }), target);
        await waitFor(() => !target.form.hidden, 'decrypted conversation');
        assert.equal(target.list.children.length, 1);
        assert.equal(target.list.children[0].tagName, 'LI');
        assert.equal(target.list.children[0].textContent, 'Peserta: ' + text);
        assert.equal(target.list.children[0].children.length, 0);
    });

    await check('tampered authenticated ciphertext reveals no message and disables sending', async () => {
        const target = surface();
        const payload = await encryptMessage('Private plaintext', key);
        const ciphertext = Buffer.from(payload.ciphertext, 'base64');
        ciphertext[ciphertext.length - 1] ^= 1;
        payload.ciphertext = ciphertext.toString('base64');
        start(basicService({
            messages: async () => [{ id: 1, sender_id: 8, encrypted_message: payload }],
        }), target);
        await waitFor(() => target.status.textContent.includes('tidak dapat diverifikasi'), 'decryption failure');
        assert.equal(target.list.children.length, 0);
        assert.equal(target.form.hidden, true);
        assert.ok(!target.status.textContent.includes('Private plaintext'));
    });

    await check('disposed chat still prevents native plaintext form navigation', async () => {
        const target = surface();
        let sends = 0;
        const dispose = start(basicService({ send: async () => { sends++; return { message_id: 1 }; } }), target);
        await waitFor(() => !target.form.hidden, 'conversation');
        dispose();
        target.form.elements.message.value = 'Unsent private draft';
        let prevented = false;
        for (const listener of target.form.listeners) await listener({ preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        assert.equal(sends, 0);
    });

    await check('repeated disposal cannot erase a newer chat draft', async () => {
        const target = surface();
        const disposeOld = start(basicService(), target);
        await waitFor(() => !target.form.hidden, 'old conversation');
        disposeOld();
        start(basicService(), target);
        await waitFor(() => !target.form.hidden, 'new conversation');
        target.form.elements.message.value = 'Keep this new draft';
        disposeOld();
        assert.equal(target.form.elements.message.value, 'Keep this new draft');
        assert.equal(target.form.hidden, false);
    });

    await check('API timeout aborts the private request and reports an uncertain outcome', async () => {
        const originalFetch = globalThis.fetch;
        const originalSetTimeout = globalThis.setTimeout;
        const originalClearTimeout = globalThis.clearTimeout;
        let timeoutCallback;
        let requestedSignal;
        let cleared = false;
        const timer = {};
        globalThis.setTimeout = (callback, delay) => {
            assert.equal(delay, 15000);
            timeoutCallback = callback;
            return timer;
        };
        globalThis.clearTimeout = value => { assert.equal(value, timer); cleared = true; };
        globalThis.fetch = async (url, options) => {
            assert.equal(url, 'api/consultations/send.php');
            assert.equal(options.cache, 'no-store');
            assert.equal(options.credentials, 'omit');
            assert.equal(options.headers.Authorization, 'Bearer test-token');
            requestedSignal = options.signal;
            return new Promise((_, reject) => {
                options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            });
        };
        try {
            const request = requestApi('consultations/send', {
                method: 'POST', token: 'test-token', body: { consultation_id: 1 },
            });
            assert.equal(requestedSignal.aborted, false);
            timeoutCallback();
            await assert.rejects(request, /Layanan belum merespons/);
            assert.equal(requestedSignal.aborted, true);
            assert.equal(cleared, true);
        } finally {
            globalThis.fetch = originalFetch;
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
        }
    });
} finally {
    for (const dispose of disposers) dispose();
    globalThis.document = originalDocument;
}
