export function encode(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

export function decode(value) {
    return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

async function importKey(ticketKey, usage) {
    return crypto.subtle.importKey('raw', decode(ticketKey.key), 'AES-GCM', false, [usage]);
}

export async function encryptMessage(text, ticketKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await importKey(ticketKey, 'encrypt');
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    return { alg: 'AES-GCM', key_version: ticketKey.key_version, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}

export async function decryptMessage(payload, ticketKey) {
    if (payload.alg !== 'AES-GCM' || payload.key_version !== ticketKey.key_version) {
        throw new Error('Format atau versi kunci pesan tidak cocok.');
    }
    const key = await importKey(ticketKey, 'decrypt');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(payload.iv) }, key, decode(payload.ciphertext));
    return new TextDecoder().decode(plaintext);
}
