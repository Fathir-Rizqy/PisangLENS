let database;

function openDatabase() {
    database ??= new Promise((resolve, reject) => {
        const request = indexedDB.open('pisanglens-phase-one', 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore('scans', { keyPath: ['owner_user_id', 'client_uuid'] })
                .createIndex('owner', 'owner_user_id');
            request.result.createObjectStore('mock');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }).catch(error => {
        database = undefined;
        throw error;
    });
    return database;
}

async function run(store, mode, operation) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        let result;
        let failure;
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(failure ?? transaction.error);
        operation(transaction.objectStore(store), value => { result = value; }, error => {
            failure = error;
            transaction.abort();
        });
    });
}

export function saveScan(scan) {
    return run('scans', 'readwrite', store => store.put(scan));
}

export function scansFor(userId) {
    return run('scans', 'readonly', (store, finish) => {
        const request = store.index('owner').getAll(userId);
        request.onsuccess = () => finish(request.result.sort((a, b) => b.created_at.localeCompare(a.created_at)));
    });
}

export function acknowledgeScan(userId, { client_uuid, scan_id }) {
    return run('scans', 'readwrite', store => {
        const request = store.get([userId, client_uuid]);
        request.onsuccess = () => {
            const scan = request.result;
            if (scan) store.put({ ...scan, is_synced: true, server_scan_id: scan_id });
        };
    });
}

// A read/write transaction serializes simulated server changes across tabs.
export function mockTransaction(initialState, update, key = 'state') {
    return run('mock', 'readwrite', (store, finish, abort) => {
        const request = store.get(key);
        request.onsuccess = () => {
            try {
                const state = request.result ?? initialState();
                finish(update(state));
                store.put(state, key);
            } catch (error) {
                abort(error);
            }
        };
    });
}
