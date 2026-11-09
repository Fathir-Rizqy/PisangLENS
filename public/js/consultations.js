import { requestApi } from './api.js';
import { mockTransaction } from './db.js';

const classes = ['Healthy', 'Pestalotiopsis Leaf Blight', 'Sigatoka', 'Cordana Leaf Spot'];
export function consultationEligible(scan) {
    return scan.confidence_score < 0.8 ||
        (classes.includes(scan.predicted_class) && scan.predicted_class !== 'Healthy');
}

function mockState(update) {
    return mockTransaction(() => ({ tickets: [], messages: {}, keys: {} }), update, 'revision-consultations');
}

export function consultationService({ demo, token, ownerId, botanist = false }) {
    const permitted = ticket => botanist ? ticket.owner_user_id === 'demo:petani' : ticket.owner_user_id === ownerId;
    return {
        async list() {
            if (!demo) return requestApi('consultations/list', { token });
            return mockState(state => state.tickets.filter(permitted));
        },
        async create(scan) {
            if (!demo) return requestApi('consultations/create', { method: 'POST', token, body: { scan_id: scan.server_scan_id } });
            return mockState(state => {
                let ticket = state.tickets.find(item => item.client_uuid === scan.client_uuid && item.owner_user_id === ownerId);
                if (!ticket) {
                    const id = 'demo-' + crypto.randomUUID();
                    ticket = { ...scan, id, owner_user_id: ownerId, scan_id: null, botani_id: null, status: 'open', simulation: true };
                    state.tickets.unshift(ticket);
                    state.messages[id] = [];
                    state.keys[id] = { key: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))), key_version: 1 };
                }
                return { consultation_id: ticket.id, status: ticket.status };
            });
        },
        async claim(id) {
            if (!demo) return requestApi('consultations/claim', { method: 'POST', token, body: { consultation_id: id } });
            return mockState(state => {
                const ticket = state.tickets.find(item => item.id === id && permitted(item));
                if (!ticket || ticket.status === 'closed') throw new Error('Tiket simulasi tidak tersedia.');
                ticket.botani_id = 'demo';
                return { consultation_id: id, status: ticket.status };
            });
        },
        async key(id) {
            if (!demo) return requestApi('consultations/key', { token, query: { consultation_id: id } });
            return mockState(state => {
                const ticket = state.tickets.find(item => item.id === id && permitted(item));
                if (!ticket || (botanist && ticket.botani_id !== 'demo')) throw new Error('Akses simulasi dibatasi.');
                return state.keys[id];
            });
        },
        async messages(id, after = 0) {
            if (!demo) return requestApi('consultations/messages', { token, query: { consultation_id: id, after_id: after } });
            await this.key(id);
            return mockState(state => state.messages[id].filter(message => message.id > after));
        },
        async send(id, payload) {
            if (!demo) return requestApi('consultations/send', { method: 'POST', token, body: { consultation_id: id, encrypted_message: payload } });
            await this.key(id);
            return mockState(state => {
                const ticket = state.tickets.find(item => item.id === id);
                if (ticket.status === 'closed') throw new Error('Konsultasi simulasi telah ditutup.');
                const existing = state.messages[id].find(item => item.encrypted_message.iv === payload.iv);
                if (existing) return { message_id: existing.id };
                const message = { id: state.messages[id].length + 1, sender_id: botanist ? 'demo' : ownerId, encrypted_message: payload };
                state.messages[id].push(message);
                if (botanist) ticket.status = 'answered';
                return { message_id: message.id, status: 'ok' };
            });
        },
    };
}

export const consultationStatus = status => ({ open: 'Terbuka', answered: 'Dibalas', closed: 'Ditutup' }[status] ?? 'Belum tersedia');
