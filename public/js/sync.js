import { requestApi } from './api.js';
import { encode } from './crypto.js';
import { acknowledgeScan, scansFor } from './db.js';

export async function syncScans(ownerId, token, isActive) {
    if (!token || String(ownerId).startsWith('demo:')) return;
    const queued = (await scansFor(ownerId)).filter(scan => !scan.is_synced);
    // A single 5 MB image remains below PHP's usual 8 MB POST limit after base64 encoding.
    for (const scan of queued) {
        if (!isActive()) return;
        if (!(scan.image_blob instanceof Blob)) continue;
        const batch = [{
            client_uuid: scan.client_uuid,
            image_base64: encode(new Uint8Array(await scan.image_blob.arrayBuffer())),
            predicted_class: scan.predicted_class,
            confidence_score: scan.confidence_score,
            prediction_source: scan.prediction_source,
            model_version: scan.model_version,
            triage_phase: scan.triage_phase,
            created_at: scan.created_at,
        }];
        if (!isActive()) return;
        const result = await requestApi('history/sync', { method: 'POST', body: batch, token });
        if (!Array.isArray(result.synced) || !Array.isArray(result.failed)) {
            throw new Error('Sinkronisasi belum dikonfirmasi oleh server.');
        }
        for (const item of result.synced) {
            if (item.scan_id && batch.some(scan => scan.client_uuid === item.client_uuid)) {
                await acknowledgeScan(ownerId, item);
            }
        }
    }
}
