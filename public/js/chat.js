import { decryptMessage, encryptMessage } from './crypto.js';

const guardedForms = new WeakSet();

export function openConversation({ service, ticket, list, status, form, senderId, active, demo, onSent = () => {}, onUpdate = () => {} }) {
    // Keep plaintext out of native GET form submissions after a page is suspended.
    if (!guardedForms.has(form)) {
        form.addEventListener('submit', event => event.preventDefault());
        guardedForms.add(form);
    }
    let disposed = false;
    let reading;
    let sending = false;
    let pending;
    let lastId = 0;
    const messages = [];
    const button = form.querySelector('button');
    button.disabled = false;
    form.elements.message.disabled = false;
    form.hidden = true;
    list.replaceChildren();
    status.textContent = 'Memuat percakapan…';
    const valid = () => !disposed && active();

    async function readMessages() {
        try {
            if (service.list) {
                const tickets = await service.list();
                if (!Array.isArray(tickets)) throw new Error('Konsultasi belum dapat dimuat. Coba lagi.');
                const latest = tickets.find(item => String(item.id) === String(ticket.id));
                if (!latest) throw new Error('Konsultasi tidak tersedia untuk akun ini.');
                if (!valid()) return false;
                Object.assign(ticket, latest);
                onUpdate(ticket);
            }
            const key = await service.key(ticket.id);
            let page;
            do {
                page = await service.messages(ticket.id, lastId);
                if (!Array.isArray(page)) throw new Error('Pesan belum dapat dibaca.');
                for (const message of page) {
                    if (!valid()) return false;
                    const text = await decryptMessage(message.encrypted_message, key);
                    if (!valid()) return false;
                    messages.push({ ...message, text });
                    lastId = message.id;
                }
            } while (page.length === 200);
            if (!valid()) return false;
            list.replaceChildren();
            for (const message of messages) {
                const row = document.createElement('li');
                row.textContent = `${String(message.sender_id) === String(senderId) ? 'Anda' : 'Peserta'}: ${message.text}`;
                list.append(row);
            }
            form.hidden = ticket.status === 'closed';
            const description = demo ? 'Simulasi percakapan · Pesan tersimpan lokal.' : 'Percakapan terenkripsi · Kunci dikelola server.';
            status.textContent = messages.length ? description : 'Belum ada pesan. ' + description;
            return true;
        } catch (error) {
            if (valid()) {
                list.replaceChildren();
                form.hidden = true;
                status.textContent = error.name === 'OperationError' ? 'Pesan tidak dapat diverifikasi atau didekripsi.' : error.message;
            }
            return false;
        }
    }

    function read() {
        if (!valid()) return Promise.resolve(false);
        if (reading) return reading;
        const operation = readMessages().finally(() => { if (reading === operation) reading = null; });
        reading = operation;
        return operation;
    }

    async function send(event) {
        event.preventDefault();
        const text = form.elements.message.value.trim();
        if (!text || sending || !valid() || ticket.status === 'closed') return;
        if (new TextEncoder().encode(text).length > 4000) {
            status.textContent = 'Pesan maksimal 4000 byte.';
            return;
        }
        sending = true;
        button.disabled = true;
        try {
            if (!pending || pending.text !== text) pending = { text, payload: await encryptMessage(text, await service.key(ticket.id)) };
            if (!valid()) return;
            const sent = await service.send(ticket.id, pending.payload);
            if (!sent.message_id) throw new Error('Pengiriman belum dikonfirmasi. Coba lagi untuk memeriksa pengiriman.');
            if (!valid()) return;
            pending = null;
            form.reset();
            // An in-flight poll can contain a snapshot from before this send.
            if (reading) await reading;
            const loaded = await read();
            if (!valid()) return;
            if (loaded) status.textContent = demo ? 'Pesan simulasi tersimpan lokal.' : 'Pesan diterima server.';
            onSent();
        } catch (error) { if (valid()) status.textContent = error.message; }
        finally { sending = false; if (valid()) button.disabled = false; }
    }
    form.addEventListener('submit', send);
    void read();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void read(); }, 8000);
    const resume = () => { if (document.visibilityState === 'visible') void read(); };
    document.addEventListener?.('visibilitychange', resume);
    globalThis.addEventListener?.('online', resume);
    return () => {
        if (disposed) return;
        disposed = true;
        clearInterval(timer);
        document.removeEventListener?.('visibilitychange', resume);
        globalThis.removeEventListener?.('online', resume);
        form.removeEventListener('submit', send);
        form.hidden = true;
        form.reset();
        list.replaceChildren();
    };
}
