// Local integration test. Creates and retains labelled accounts, scans and messages.
// Requires Node 22, PHP 8.3, Chrome, MySQL and a configured local application.
// Supply PISANGLENS_TEST_DB_USER and optionally PISANGLENS_TEST_DB_PASSWORD.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
process.chdir(root);
const databaseUser = process.env.PISANGLENS_TEST_DB_USER;
if (!databaseUser) throw new Error('Set PISANGLENS_TEST_DB_USER for local test provisioning.');
const databasePassword = process.env.PISANGLENS_TEST_DB_PASSWORD ?? '';
const base = 'http://127.0.0.1:18710';
const processes = [];
const browsers = [];
const tokens = new Set();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const seed = Date.now();
const password = randomBytes(24).toString('base64url');
const accounts = Object.fromEntries(['admin', 'farmer', 'botanist', 'rival', 'legacy', 'otherfarmer'].map(role =>
    [role, { email: `checkpoint4-${role}-${seed}@example.test`, name: `Uji Checkpoint 4 ${role} ${seed}`, password }]));
const contextPath = join(root, 'storage', `checkpoint4-test-${seed}.json`);
writeFileSync(contextPath, JSON.stringify({ accounts, base }, null, 2));

function sql(query) {
    const result = spawnSync('mysql', [
        '--no-defaults', '--protocol=TCP', '--host=127.0.0.1',
        '--user=' + databaseUser, '--batch', '--raw', '--skip-column-names', 'pisanglens',
    ], { input: query, encoding: 'utf8', windowsHide: true, env: { ...process.env, MYSQL_PWD: databasePassword } });
    if (result.status !== 0) throw new Error('Local MySQL test audit failed.');
    return result.stdout.trim();
}

async function api(path, { body, token, status = 200, origin = base } = {}) {
    const response = await fetch(origin + '/api/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, status, path + ' unexpected HTTP status');
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
    return JSON.parse(text);
}

async function waitFor(check, label) {
    for (let attempt = 0; attempt < 120; attempt++) {
        if (await check()) return;
        await pause(150);
    }
    throw new Error('Timed out: ' + label);
}

async function browser(port) {
    const profile = mkdtempSync(join(tmpdir(), 'pisanglens-checkpoint4-'));
    const child = spawn(process.env.PISANGLENS_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
        '--headless=new', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-first-run', '--disable-background-networking',
        '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    processes.push(child);
    let target;
    await waitFor(async () => {
        try {
            target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(tab => tab.type === 'page');
            return Boolean(target);
        } catch { return false; }
    }, 'Chrome startup');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0;
    const pending = new Map();
    const runtimeErrors = [];
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text);
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timeout);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
    };
    function send(method, params = {}) {
        const id = ++sequence;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Chrome command timed out: ' + method)); }, 25000);
            pending.set(id, { resolve, reject, timeout });
            socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async function evaluate(expression) {
        const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
        return response.result.value;
    }
    async function check(expression, label) {
        await waitFor(() => evaluate(expression), label);
        console.log('PASS browser: ' + label);
    }
    async function go(path) {
        await send('Page.navigate', { url: base + path });
        await waitFor(() => evaluate('location.pathname === ' + JSON.stringify(path.split('?')[0].split('#')[0]) + ' && document.readyState === "complete"'), 'page ' + path);
    }
    async function login(account, admin = false) {
        await go(admin ? '/admin-masuk.html' : '/index.html');
        assert.equal(await evaluate("Boolean(document.querySelector('#demo-login, #run-prediction, a[href*=\"demo=\"]'))"), false);
        assert.equal(await evaluate("/Simulasi masuk|Uji simulasi prediksi|Simulasi Admin/.test(document.body.textContent)"), false);
        await evaluate(`(()=>{const f=document.querySelector('form');f.elements.email.value=${JSON.stringify(account.email)};f.elements.password.value=${JSON.stringify(password)};f.querySelector('button').click();})()`);
    }
    async function register(account, role) {
        await go('/petani-daftar.html');
        const fields = { ...account, password, confirmation: password, role, institution: 'Institusi Uji Checkpoint 4', province: 'Jawa Barat', city: 'Kota Bandung', license_number: 'UJI-C4' };
        await evaluate(`(()=>{const f=document.querySelector('form');f.elements.role.value=${JSON.stringify(role)};f.elements.role.dispatchEvent(new Event('change'));for(const [key,value] of Object.entries(${JSON.stringify(fields)}))f.elements[key].value=value;f.querySelector('button').click();})()`);
        await check("document.getElementById('auth-status').textContent.includes('Pendaftaran berhasil')", role + ' real registration');
    }
    async function upload() {
        const png = await evaluate("(()=>{const c=document.createElement('canvas');c.width=320;c.height=240;const x=c.getContext('2d');x.fillStyle='#609060';x.fillRect(0,0,320,240);return c.toDataURL('image/png').split(',')[1]})()");
        const imagePath = join(root, 'storage', `checkpoint4-test-image-${seed}-${randomBytes(4).toString('hex')}.png`);
        writeFileSync(imagePath, Buffer.from(png, 'base64'));
        const document = await send('DOM.getDocument');
        const input = await send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#image-file' });
        await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [imagePath] });
        await check("!document.getElementById('predict').disabled", 'normal image upload and quality checks');
    }
    async function farmerToken() {
        const token = await evaluate("JSON.parse(sessionStorage.getItem('pisanglens-farmer-token')).token");
        tokens.add(token);
        return token;
    }
    async function staffToken() {
        const token = await evaluate("JSON.parse(sessionStorage.getItem('pisanglens-staff-session')).token");
        tokens.add(token);
        return token;
    }
    await send('Runtime.enable');
    const instance = { runtimeErrors, send, evaluate, check, go, login, register, upload, farmerToken, staffToken, socket, profile };
    browsers.push(instance);
    return instance;
}

async function main() {
    const snapshotQuery = "SELECT id,SHA2(CONCAT_WS('|',name,email,password_hash,role,COALESCE(license_number,''),is_verified,COALESCE(verification_rejected_at,''),COALESCE(institution,''),COALESCE(province,''),COALESCE(city,''),created_at),256) FROM users ORDER BY id";
    const before = sql(snapshotQuery).split(/\r?\n/);
    const provision = spawnSync('php', ['scripts/admin-account.php'], {
        input: JSON.stringify({ email: accounts.admin.email, name: accounts.admin.name, mode: 'create', database_username: databaseUser, database_password: databasePassword, new_password: password }),
        encoding: 'utf8', windowsHide: true,
    });
    assert.equal(provision.status, 0, 'Secure local test Admin provisioning');
    const legacy = spawnSync('php', ['-r', '$v=json_decode(stream_get_contents(STDIN),true);require "lib/db.php";$s=require "config/config.php";$s["database"]["username"]=$v["db_user"];$s["database"]["password"]=$v["db_password"];$p=openDatabase($s["database"]);$q=$p->prepare("INSERT INTO users(name,email,password_hash,role,license_number,is_verified) VALUES(?,?,?,\'botani\',\'UJI-LEGACY\',0)");$q->execute([$v["name"],$v["email"],password_hash($v["password"],PASSWORD_DEFAULT)]);'], {
        input: JSON.stringify({ ...accounts.legacy, db_user: databaseUser, db_password: databasePassword }),
        encoding: 'utf8', windowsHide: true,
    });
    assert.equal(legacy.status, 0, 'Legacy profile fixture');
    for (const port of [18710, 18711]) processes.push(spawn('php', ['-S', '127.0.0.1:' + port, '-t', 'public'], { windowsHide: true, stdio: 'ignore' }));
    await waitFor(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'PHP server');
    const farmer = await browser(18720);
    const botanist = await browser(18721);
    const admin = await browser(18722);

    await botanist.login(accounts.legacy);
    await botanist.check("document.getElementById('profile-institution')?.textContent==='Belum diisi'", 'legacy profile missing-data state');
    await botanist.evaluate("location.hash='akun'");
    await botanist.check("document.querySelectorAll('#account-detail dt').length===7", 'seven labelled profile fields');
    await botanist.evaluate("(()=>{const f=document.getElementById('profile-form');f.elements.institution.value='Institusi Legacy Uji';f.elements.province.value='DI Yogyakarta';f.elements.province.dispatchEvent(new Event('input'));f.elements.city.value='Kabupaten Sleman';f.querySelector('button').click();})()");
    await botanist.check("document.getElementById('profile-status').textContent.includes('tersimpan di server') && document.getElementById('profile-province').textContent==='DI Yogyakarta'", 'authenticated legacy completion preserves custom region');
    await botanist.send('Page.reload');
    await botanist.check("document.getElementById('profile-city')?.textContent==='Kabupaten Sleman'", 'profile persistence after reload');
    await botanist.evaluate("document.getElementById('staff-logout').click()");
    await botanist.check("location.pathname==='/index.html'", 'legacy Botanist logout');

    await farmer.register(accounts.farmer, 'petani');
    await farmer.login(accounts.farmer);
    await farmer.check("document.getElementById('account-mode')?.textContent==='Akun petani'", 'real Farmer session');
    let farmerToken = await farmer.farmerToken();
    await botanist.register(accounts.botanist, 'botani');
    await botanist.login(accounts.botanist);
    await botanist.check("document.getElementById('profile-verification')?.textContent==='Menunggu verifikasi'", 'new Botanist pending status from server');
    let botToken = await botanist.staffToken();
    await botanist.evaluate("location.hash='akun'");
    await botanist.check("document.querySelectorAll('datalist[id$=province-examples] option').length===3 && document.getElementById('profile-region-help').textContent.includes('contoh terbatas')", 'region examples explicitly limited');
    assert.equal(await farmer.evaluate("document.querySelector('#prediction-scenario')===null && !document.body.textContent.includes('Skenario uji')"), true);
    await farmer.evaluate("window.injectTestFile=file=>{const d=new DataTransfer();d.items.add(file);const i=document.getElementById('image-file');i.files=d.files;i.dispatchEvent(new Event('change'))}");
    for (const [file, error] of [
        ["new File(['text'],'bad.txt',{type:'text/plain'})", 'berformat'],
        ["new File(['broken'],'bad.png',{type:'image/png'})", 'tidak dapat dibuka'],
        ["new File([new Uint8Array(5242881)],'large.png',{type:'image/png'})", 'maksimal 5 MB'],
    ]) {
        await farmer.evaluate('injectTestFile(' + file + ')');
        await farmer.check('document.getElementById("photo-message").textContent.includes(' + JSON.stringify(error) + ') && document.getElementById("predict").disabled', 'invalid photo rejected: ' + error);
    }
    for (const [gray, error] of [[10, 'terlalu gelap'], [250, 'terlalu terang']]) {
        await farmer.evaluate(`(async()=>{const c=document.createElement('canvas');c.width=c.height=224;const x=c.getContext('2d');x.fillStyle='rgb(${gray},${gray},${gray})';x.fillRect(0,0,224,224);injectTestFile(new File([await new Promise(r=>c.toBlob(r,'image/png'))],'quality.png',{type:'image/png'}))})()`);
        await farmer.check('document.getElementById("photo-message").textContent.includes(' + JSON.stringify(error) + ') && document.getElementById("predict").disabled', error);
    }
    await farmer.evaluate("window.originalCamera=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError')};document.getElementById('camera-start').click()");
    await farmer.check("document.getElementById('photo-message').textContent.includes('Izin kamera ditolak')", 'camera permission error');
    await farmer.evaluate("navigator.mediaDevices.getUserMedia=window.originalCamera;document.getElementById('camera-start').click()");
    await farmer.check("document.getElementById('camera-video').readyState>=2&&!document.getElementById('camera-capture').hidden", 'Chrome virtual camera opens');
    await farmer.evaluate("document.getElementById('camera-capture').click()");
    await farmer.check("!document.getElementById('image-preview').hidden&&!document.getElementById('predict').disabled", 'Chrome virtual camera captures');
    await farmer.upload();
    await farmer.evaluate("document.getElementById('predict').click()");
    await farmer.check("document.getElementById('result-summary').textContent.includes('Healthy') && document.getElementById('result-consult').children.length===0", 'Healthy high-confidence behavior');
    assert.equal(await farmer.evaluate("document.getElementById('result-summary').textContent.includes('Simulasi prediksi \\u2014 bukan hasil analisis foto')"), true);
    await farmer.evaluate("(async()=>{(await import('/js/predict.js')).setPredictionScenario('failure');document.getElementById('predict').click()})()");
    await farmer.check("document.getElementById('prediction-message').textContent.includes('gagal') && !document.getElementById('predict').disabled", 'internal prediction error is recoverable');
    await farmer.evaluate("(async()=>{(await import('/js/predict.js')).setPredictionScenario('disease');document.getElementById('predict').click()})()");
    await farmer.check("document.querySelector('#result-consult a') && document.getElementById('result-summary').textContent.includes('Simulasi prediksi')", 'disease prediction remains labelled simulation');
    await farmer.evaluate("document.querySelector('#result-consult a').click()");
    await farmer.check("!document.getElementById('consultation-form').hidden && document.getElementById('consultation-detail').textContent.includes('Konsultasi nyata') && document.querySelector('#consultation-photo img')?.naturalWidth>0", 'photo and initial question draft');
    assert.equal((await api('consultations/list.php', { token: farmerToken })).length, 0, 'Selecting consultation must not submit an empty ticket');
    await farmer.evaluate(`document.getElementById('first-message').value='C4 farmer message ${seed}';document.querySelector('#consultation-form button').click()`);
    await farmer.check(`document.getElementById('consultation-messages').textContent.includes('C4 farmer message ${seed}')`, 'photo and encrypted initial question submitted together');
    await farmer.check("document.getElementById('consultation-detail').textContent.includes('Menunggu Botani')", 'waiting status derived from existing assignment');
    const tickets = await api('consultations/list.php', { token: farmerToken });
    assert.equal(tickets.length, 1);
    const ticket = tickets[0];
    assert.equal(ticket.prediction_source, 'mock');
    assert.equal(sql('SELECT COUNT(*) FROM consultations WHERE scan_id=' + ticket.scan_id), '1');
    const repeat = await api('consultations/create.php', { token: farmerToken, body: { scan_id: ticket.scan_id } });
    assert.equal(String(repeat.consultation_id), String(ticket.id));
    await api('consultations/claim.php', { token: botToken, body: { consultation_id: ticket.id }, status: 403 });
    await api('admin/queue.php?type=botanist', { token: farmerToken, status: 403 });
    await api('botanist/profile.php', { token: farmerToken, status: 403 });

    await admin.login(accounts.admin, true);
    await admin.check("document.getElementById('admin-mode')?.textContent==='Akun Admin'", 'protected Admin login');
    const adminToken = await admin.staffToken();
    await api('botanist/profile.php', { token: adminToken, status: 403 });
    await admin.evaluate("location.hash='verifikasi'");
    await admin.check(`Array.from(document.querySelectorAll('#verification-list li')).some(row=>row.textContent.includes(${JSON.stringify(accounts.botanist.email)}))`, 'new registration visible in pending queue');
    const rowExpression = `Array.from(document.querySelectorAll('#verification-list li')).find(row=>row.textContent.includes(${JSON.stringify(accounts.botanist.email)}))`;
    assert.ok(await admin.evaluate(`['Asal institusi','Provinsi','Kabupaten/Kota','Tanggal pendaftaran','Status verifikasi'].every(label=>${rowExpression}.textContent.includes(label))`));
    await admin.evaluate(`${rowExpression}.querySelector('button').click()`);
    await admin.check("document.getElementById('verification-confirm').open", 'Admin decision confirmation');
    await admin.evaluate("document.getElementById('confirm-decision').click()");
    await admin.check("document.getElementById('decision-feedback').textContent.includes('Keputusan tersimpan di server.')", 'Admin approval persisted');
    await botanist.evaluate("document.getElementById('profile-refresh').click()");
    await botanist.check("document.getElementById('profile-verification').textContent==='Terverifikasi'", 'verification refresh without relogin');
    assert.equal(await botanist.staffToken(), botToken);
    await botanist.evaluate("location.hash='antrean'");
    const ticketRow = `Array.from(document.querySelectorAll('#ticket-list li')).find(row=>row.textContent.includes('Tiket ${ticket.id} ·'))`;
    await botanist.check(`Boolean(${ticketRow})`, 'server ticket visible in separate Botanist browser session');
    assert.ok(await botanist.evaluate(`${ticketRow}.textContent.includes('Simulasi prediksi')`));
    await api('consultations/key.php?consultation_id=' + ticket.id, { token: botToken, status: 403 });
    await botanist.evaluate(`${ticketRow}.querySelector('button').click()`);
    await botanist.check(`!document.getElementById('reply-form').hidden && document.querySelector('#ticket-photo img')?.naturalWidth>0 && document.getElementById('chat-messages').textContent.includes('C4 farmer message ${seed}')`, 'claim, protected photo and decrypt Farmer message');
    await botanist.evaluate(`document.querySelector('#reply-form textarea').value='<b>C4 Botanist reply ${seed}</b>';document.querySelector('#reply-form button').click()`);
    await botanist.check(`document.getElementById('chat-messages').textContent.includes('<b>C4 Botanist reply ${seed}</b>') && !document.querySelector('#chat-messages b')`, 'real reply rendered as literal text');
    await farmer.check(`document.getElementById('consultation-messages').textContent.includes('C4 Botanist reply ${seed}')`, 'Farmer receives reply in separate browser session');
    await farmer.check("document.getElementById('consultation-detail').textContent.includes('Dibalas Botani')", 'active ticket status refresh');
    await farmer.evaluate(`document.getElementById('first-message').value='C4 Farmer follow-up ${seed}';document.querySelector('#consultation-form button').click()`);
    await botanist.check(`document.getElementById('chat-messages').textContent.includes('C4 Farmer follow-up ${seed}')`, 'Botanist receives continued Farmer reply');
    await farmer.send('Page.reload');
    await botanist.send('Page.reload');
    await farmer.check(`document.getElementById('consultation-messages')?.textContent.includes('C4 Botanist reply ${seed}')`, 'Farmer conversation restored after reload');
    await botanist.check(`document.getElementById('chat-messages')?.textContent.includes('C4 farmer message ${seed}')`, 'Botanist conversation restored after reload');
    assert.equal(sql('SELECT COUNT(*) FROM chat_messages WHERE consultation_id=' + ticket.id), '3');

    // Actual Back/Forward Cache restoration must restart participant chat, not just profile polling.
    for (const [client, page, formId] of [[farmer, '/petani-kamera.html', 'consultation-form'], [botanist, '/botani-akun.html', 'reply-form']]) {
        await client.evaluate("window.checkpoint4Back=false;window.addEventListener('pageshow',e=>{if(e.persisted)window.checkpoint4Back=true})");
        const history = await client.send('Page.getNavigationHistory');
        const entry = history.entries[history.currentIndex];
        await client.go('/index.html');
        await client.send('Page.navigateToHistoryEntry', { entryId: entry.id });
        await client.check(`location.pathname===${JSON.stringify(page)} && !document.getElementById(${JSON.stringify(formId)})?.hidden && !document.getElementById(${JSON.stringify(formId)}).elements.message.disabled`, 'chat composer restored after browser Back');
        console.log('PASS browser: Back restored conversation (' + ((await client.evaluate('window.checkpoint4Back')) ? 'BFCache' : 'normal navigation') + ')');
    }
    await botanist.evaluate(`document.querySelector('#reply-form textarea').value='C4 after Back ${seed}';document.querySelector('#reply-form button').click()`);
    await farmer.check(`document.getElementById('consultation-messages').textContent.includes('C4 after Back ${seed}')`, 'live replies continue after BFCache restoration');

    // A new login must reopen the owned conversation from consultation history.
    await farmer.evaluate("document.getElementById('logout').click()");
    await farmer.check("location.pathname==='/index.html'", 'Farmer logout before persistence login');
    tokens.delete(farmerToken);
    await farmer.login(accounts.farmer);
    await farmer.check("document.getElementById('account-mode')?.textContent==='Akun petani'", 'Farmer relogin');
    farmerToken = await farmer.farmerToken();
    await farmer.evaluate("location.hash='konsultasi'");
    await farmer.check("Boolean(document.querySelector('#consultation-list button'))", 'persisted consultation history after relogin');
    await farmer.evaluate("document.querySelector('#consultation-list button').click()");
    await farmer.check(`document.getElementById('consultation-messages').textContent.includes('C4 after Back ${seed}')`, 'conversation history after fresh login');
    await botanist.evaluate("document.getElementById('staff-logout').click()");
    await botanist.check("location.pathname==='/index.html'", 'Botanist logout before persistence login');
    tokens.delete(botToken);
    await botanist.login(accounts.botanist);
    await botanist.check("document.getElementById('profile-verification')?.textContent==='Terverifikasi'", 'Botanist relogin');
    botToken = await botanist.staffToken();
    await botanist.evaluate("location.hash='ditangani'");
    const assigned = `Array.from(document.querySelectorAll('#assigned-list li')).find(row=>row.textContent.includes('Tiket ${ticket.id} ·'))`;
    await botanist.check(`Boolean(${assigned})`, 'owned ticket persists after new Botanist login');
    await botanist.evaluate(`${assigned}.querySelector('button').click()`);
    await botanist.check(`document.getElementById('chat-messages').textContent.includes('C4 after Back ${seed}')`, 'Botanist persisted encrypted conversation after relogin');
    assert.equal(sql("SELECT COUNT(*) FROM chat_messages WHERE consultation_id=" + ticket.id + " AND CAST(encrypted_message AS CHAR) LIKE '%C4 farmer message%'"), '0');

    await api('auth/register.php', { body: { ...accounts.rival, password, role: 'botani', license_number: 'UJI-RIVAL', institution: 'Institusi Rival Uji', province: 'Jawa Tengah', city: 'Kota Semarang' } });
    const rival = await api('auth/login.php', { body: { email: accounts.rival.email, password } });
    tokens.add(rival.token);
    await api('consultations/claim.php', { token: rival.token, body: { consultation_id: ticket.id }, status: 403 });
    await api('admin/approve.php', { token: adminToken, body: { target_id: rival.user_id, approval_type: 'botanist_license', decision: 'approve' } });
    await api('consultations/messages.php?consultation_id=' + ticket.id, { token: rival.token, status: 403 });
    await api('consultations/key.php?consultation_id=' + ticket.id, { token: rival.token, status: 403 });
    await api('consultations/claim.php', { token: rival.token, body: { consultation_id: ticket.id }, status: 409 });
    const deniedPhoto = await fetch(base + '/api/scans/image.php?scan_id=' + ticket.scan_id, { headers: { Authorization: 'Bearer ' + rival.token } });
    assert.equal(deniedPhoto.status, 403);
    const anonymousPhoto = await fetch(base + '/api/scans/image.php?scan_id=' + ticket.scan_id);
    assert.equal(anonymousPhoto.status, 401);
    await api('botanist/profile.php', { token: botToken, body: { is_verified: 1 }, status: 422 });
    await api('botanist/profile.php', { token: botToken, body: { user_id: rival.user_id, institution: 'forged' }, status: 422 });
    await api('auth/register.php', { body: { ...accounts.otherfarmer, password, role: 'petani' } });
    const otherFarmer = await api('auth/login.php', { body: { email: accounts.otherfarmer.email, password } });
    tokens.add(otherFarmer.token);
    await api('consultations/messages.php?consultation_id=' + ticket.id, { token: otherFarmer.token, status: 403 });
    await api('consultations/key.php?consultation_id=' + ticket.id, { token: otherFarmer.token, status: 403 });
    await api('consultations/create.php', { token: otherFarmer.token, body: { scan_id: ticket.scan_id }, status: 403 });
    const otherImage = await fetch(base + '/api/scans/image.php?scan_id=' + ticket.scan_id, { headers: { Authorization: 'Bearer ' + otherFarmer.token } });
    assert.equal(otherImage.status, 403);
    const corrupted = JSON.parse(sql('SELECT encrypted_message FROM chat_messages WHERE consultation_id=' + ticket.id + ' ORDER BY id LIMIT 1'));
    const bytes = Buffer.from(corrupted.ciphertext, 'base64');
    bytes[bytes.length - 1] ^= 1;
    corrupted.ciphertext = bytes.toString('base64');
    const beforeInvalid = sql('SELECT COUNT(*) FROM chat_messages WHERE consultation_id=' + ticket.id);
    await api('consultations/send.php', { token: farmerToken, body: { consultation_id: ticket.id, encrypted_message: corrupted }, status: 422 });
    assert.equal(sql('SELECT COUNT(*) FROM chat_messages WHERE consultation_id=' + ticket.id), beforeInvalid);
    console.log('PASS API/MySQL: participant privacy, live verification, role separation and profile ownership');

    await farmer.evaluate("document.getElementById('consultation-back').click();location.hash='kamera';");
    await farmer.upload();
    await farmer.evaluate("(async()=>{(await import('/js/predict.js')).setPredictionScenario('low');document.getElementById('predict').click()})()");
    await farmer.check("document.querySelector('.result.amber') && document.querySelector('#result-consult a')", 'low-confidence eligibility regression');
    await farmer.evaluate("document.querySelector('#result-consult a').click()");
    await farmer.check("!document.getElementById('consultation-form').hidden", 'low-confidence server consultation');
    await farmer.evaluate(`document.getElementById('first-message').value='C4 low-confidence question ${seed}';document.querySelector('#consultation-form button').click()`);
    await farmer.check(`document.getElementById('consultation-messages').textContent.includes('C4 low-confidence question ${seed}')`, 'low-confidence first question persisted');
    const lowTicket = (await api('consultations/list.php', { token: farmerToken })).find(row => String(row.id) !== String(ticket.id));
    const claim = async (origin, token) => {
        const response = await fetch(origin + '/api/consultations/claim.php', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ consultation_id: lowTicket.id }),
        });
        assert.equal(response.headers.get('cache-control'), 'no-store');
        return response.status;
    };
    const claims = await Promise.all([claim(base, botToken), claim('http://127.0.0.1:18711', rival.token)]);
    assert.deepEqual(claims.sort(), [200, 409]);
    await farmer.evaluate("location.hash='riwayat'");
    await farmer.check("document.querySelectorAll('#history-list li').length===2 && document.querySelector('#history-list img')?.naturalWidth>0", 'history with scan thumbnails');
    await farmer.evaluate("location.hash='direktori'");
    await farmer.check("document.querySelector('#farmer-directory [data-directory-list]').children.length>0", 'verified Botanist directory');
    await farmer.evaluate("const p=document.querySelector('#farmer-directory [data-province]');p.value='Jawa Barat';p.dispatchEvent(new Event('change'));");
    await farmer.check("Array.from(document.querySelectorAll('#farmer-directory [data-directory-list] li')).every(row=>row.textContent.includes('Jawa Barat'))", 'Farmer region filtering');
    await admin.evaluate("location.hash='direktori'");
    await admin.check("document.querySelector('#admin-directory [data-directory-list]').textContent.includes('hari sejak bergabung')", 'Admin membership dates and duration');
    await admin.evaluate("const p=document.querySelector('#admin-directory [data-province]');p.value='Jawa Barat';p.dispatchEvent(new Event('change'));const s=document.querySelector('#admin-directory [data-verification]');s.value='approved';s.dispatchEvent(new Event('change'));");
    await admin.check("Array.from(document.querySelectorAll('#admin-directory [data-directory-list] li')).every(row=>row.textContent.includes('Terverifikasi')&&row.textContent.includes('Jawa Barat'))", 'Admin region/status filtering');
    for (const client of [botanist, admin]) {
        assert.equal(await client.evaluate("Array.from(document.querySelectorAll('.dashboard-layout a')).some(a=>/halaman masuk/i.test(a.textContent))"), false);
        for (const width of [360, 1280]) {
            await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 360 });
            await client.check("document.documentElement.scrollWidth<=innerWidth", 'dashboard responsive width ' + width);
        }
    }
    await farmer.check("(async()=>{const cache=await caches.open('pisanglens-shell-v12');const keys=await cache.keys();return keys.length===31&&keys.every(r=>!r.url.includes('/api/'));})()", 'private API responses excluded from shell cache');

    await botanist.evaluate("document.getElementById('staff-logout').click()");
    await botanist.check("location.pathname==='/index.html' && location.search==='?role=botani'", 'Botanist logout role redirect');
    await api('botanist/profile.php', { token: botToken, status: 401 });
    tokens.delete(botToken);
    await farmer.evaluate("document.getElementById('logout').click()");
    await farmer.check("location.pathname==='/index.html'", 'Farmer logout');
    await api('consultations/list.php', { token: farmerToken, status: 401 });
    tokens.delete(farmerToken);
    const counts = () => sql('SELECT COUNT(*) FROM scans; SELECT COUNT(*) FROM consultations; SELECT COUNT(*) FROM chat_messages; SELECT SUM(is_verified) FROM users;');
    const demoBefore = counts();
    assert.equal(await farmer.evaluate("document.querySelector('#demo-login, #run-prediction, a[href*=\"demo=\"]') === null"), true);
    // Internal test fixture only: the public UI no longer offers demonstration login.
    await farmer.evaluate("localStorage.setItem('pisanglens-farmer-profile', JSON.stringify({ownerId:'demo:petani',role:'petani',name:'Petani Demo',demo:true}));location.assign('petani-kamera.html')");
    await farmer.check("document.getElementById('account-mode')?.textContent.includes('Simulasi masuk')", 'explicit Farmer demo');
    await farmer.upload();
    await farmer.evaluate("(async()=>{(await import('/js/predict.js')).setPredictionScenario('disease');document.getElementById('predict').click()})()");
    await farmer.check("Boolean(document.querySelector('#result-consult a'))", 'demo consultation eligibility');
    await farmer.evaluate("document.querySelector('#result-consult a').click()");
    await farmer.check("document.getElementById('consultation-detail').textContent.includes('Simulasi konsultasi lokal') && !document.getElementById('consultation-form').hidden", 'local demo ticket');
    await farmer.evaluate("document.getElementById('first-message').value='Demo C4 first message';document.querySelector('#consultation-form button').click()");
    await farmer.check("document.getElementById('consultation-messages').textContent.includes('Demo C4 first message')", 'local Farmer demo send');
    await farmer.go('/botani-akun.html?demo=1#antrean');
    await farmer.check("document.querySelectorAll('#ticket-list li').length===1", 'shared local demonstration identity');
    await farmer.evaluate("document.querySelector('#ticket-list button').click()");
    await farmer.check("!document.getElementById('reply-form').hidden && document.querySelector('#ticket-photo img')?.naturalWidth>0", 'demo Botanist claim and image');
    await farmer.evaluate("document.querySelector('#reply-form textarea').value='Demo C4 reply';document.querySelector('#reply-form button').click()");
    await farmer.check("document.getElementById('chat-messages').textContent.includes('Demo C4 reply')", 'local Botanist demo reply');
    await farmer.go('/petani-kamera.html#konsultasi');
    await farmer.check("document.getElementById('consultation-messages')?.textContent.includes('Demo C4 reply')", 'local conversation survives role navigation');
    await admin.go('/admin-verifikasi.html?demo=1#verifikasi');
    await admin.check("document.querySelectorAll('#verification-list li').length===2", 'Admin simulation queue');
    await admin.evaluate("document.querySelector('#verification-list button').click();document.getElementById('confirm-decision').click()");
    await admin.check("Boolean(document.querySelector('#decision-feedback .approved'))", 'simulated approval');
    await admin.evaluate("document.querySelectorAll('#verification-list button')[1].click();document.getElementById('confirm-decision').click()");
    await admin.check("Boolean(document.querySelector('#decision-feedback .rejected'))", 'simulated rejection');
    assert.equal(counts(), demoBefore, 'Simulation wrote to real tables');
    console.log('PASS MySQL: all demo actions leave real scans, tickets, messages and verification counts intact');
    await admin.go('/admin-verifikasi.html');
    await admin.check("document.getElementById('admin-mode')?.textContent==='Akun Admin'", 'return to real Admin');
    await admin.evaluate("document.getElementById('staff-logout').click()");
    await admin.check("location.pathname==='/admin-masuk.html'", 'Admin logout role redirect');
    await api('admin/queue.php?type=botanist', { token: adminToken, status: 401 });
    tokens.delete(adminToken);
    const after = sql(snapshotQuery).split(/\r?\n/);
    for (const row of before) assert.ok(after.includes(row), 'Pre-existing account changed');
    console.log('PASS MySQL: all pre-existing users preserved; test records retained');
    for (const client of browsers) assert.deepEqual(client.runtimeErrors, [], 'Uncaught browser JavaScript error');
    console.log('PASS browser: no uncaught JavaScript errors in any role session');
    console.log('Private test context: ' + contextPath);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
    for (const token of tokens) {
        try { await api('auth/logout.php', { body: {}, token }); } catch {}
    }
    for (const client of browsers) client.socket.close();
    for (const child of processes) child.kill();
});
