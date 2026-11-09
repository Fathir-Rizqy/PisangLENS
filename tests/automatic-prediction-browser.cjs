// Isolated Chrome regression. No authentication or database writes.
const assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {mkdtempSync,writeFileSync,readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');const{join}=require('node:path');
const {randomBytes}=require('node:crypto');
const root=process.cwd(),seed=Date.now(),base='http://127.0.0.1:18870';
const processes=[],browsers=[],tokens=new Set();const pause=ms=>new Promise(r=>setTimeout(r,ms));
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


async function main(){
 processes.push(spawn('php',['-S','127.0.0.1:18870','-t','public'],{windowsHide:true,stdio:'ignore'}));
 await waitFor(async()=>{try{return(await fetch(base)).ok}catch{return false}},'PHP');
 const f=await browser(18871);
 await f.go('/index.html');
 await f.evaluate("localStorage.setItem('pisanglens-farmer-profile',JSON.stringify({ownerId:'demo:petani',role:'petani',name:'Regression only',demo:true}))");
 await f.send('Network.enable');await f.send('Network.setBypassServiceWorker',{bypass:true});
 const apiRequests=[];
 f.socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Network.requestWillBeSent'&&new URL(m.params.request.url).pathname.startsWith('/api/'))apiRequests.push(m.params.request.url)});
 // Preserve the exact removed-selector failure as an isolated legacy-module fixture.
 const current=readFileSync('public/js/petani.js','utf8');
 const old={stdout:current.replace('const prediction = await predict(source.input);', "document.getElementById('prediction-scenario').value; const prediction = await predict(source.input);")};
 assert.notEqual(old.stdout,current);
 f.socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Fetch.requestPaused')void f.send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/javascript'}],body:Buffer.from(old.stdout).toString('base64')})});
 await f.send('Fetch.enable',{patterns:[{urlPattern:'*/js/petani.js*',requestStage:'Request'}]});
 await f.go('/petani-kamera.html');await f.upload();
 await f.evaluate("document.getElementById('predict').click()");
 await f.check("document.getElementById('prediction-message').textContent.includes(\"Cannot read properties of null (reading 'value')\")",'exact old-module null.value reproduced');
 await f.send('Fetch.disable');await f.send('Page.reload');
 await f.check("!!document.getElementById('farmer-app')&&!document.getElementById('farmer-app').hidden",'current module loaded');
 await f.upload();await f.evaluate("document.getElementById('predict').click()");
 await f.check("document.getElementById('result-summary').textContent.includes('Healthy')&&document.getElementById('result-summary').textContent.includes('94%')&&document.getElementById('result-summary').textContent.includes('bukan hasil analisis foto')",'automatic prediction result without selector or errors');
 assert.equal(await f.evaluate("document.getElementById('prediction-scenario')"),null);
 await f.evaluate("document.getElementById('save-scan').click()");
 await f.check("document.getElementById('save-message').textContent.includes('disimpan')",'local history saves');
 await f.evaluate("location.hash='riwayat'");
 await f.check("document.querySelector('#history-list img')?.naturalWidth>0",'history image and result');
 await f.send('Page.reload');await f.check("document.querySelector('#history-list img')?.naturalWidth>0",'history persists after reload');
 await f.evaluate("location.hash='kamera'");await f.upload();
 await f.evaluate("(async()=>{(await import('/js/predict.js')).setPredictionScenario('disease');document.getElementById('predict').click()})()");
 await f.check("Boolean(document.querySelector('#result-consult a'))",'consultation eligibility');
 await f.evaluate("document.querySelector('#result-consult a').click()");
 await f.check("!document.getElementById('consultation-form').hidden",'local consultation draft opens');
 await f.evaluate("document.getElementById('first-message').value='Isolated regression question';document.querySelector('#consultation-form button').click()");
 await f.check("document.getElementById('consultation-messages').textContent.includes('Isolated regression question')",'isolated local consultation works');
 await f.evaluate("location.hash='kamera';const d=new DataTransfer();d.items.add(new File(['bad'],'bad.png',{type:'image/png'}));const i=document.getElementById('image-file');i.files=d.files;i.dispatchEvent(new Event('change'))");
 await f.check("document.getElementById('photo-message').textContent.includes('tidak dapat dibuka')&&document.getElementById('predict').disabled",'invalid image handling');
 assert.deepEqual(f.runtimeErrors,[]);assert.deepEqual(apiRequests,[]);
 console.log('PASS: no uncaught browser exceptions and zero API requests/database writes');
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>{for(const b of browsers)b.socket.close();for(const p of processes)p.kill()});
