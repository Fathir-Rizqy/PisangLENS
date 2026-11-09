// Real PHP/MySQL browser regression for profile saves overlapping profile refreshes.
// Requires Node 22, PHP 8.3, configured local MySQL and Chrome. Retains a labelled test account.

const {spawn}=require('node:child_process');
const {writeFileSync,mkdtempSync}=require('node:fs');
const {randomBytes}=require('node:crypto');
const {join,resolve}=require('node:path');
process.chdir(resolve(__dirname,'..'));
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const base='http://127.0.0.1:18641';
const seed=Date.now();
const contextPath='storage/profile-4c-test-'+seed+'.json';
let php,chrome,socket,token;
async function api(path,body,auth,status=200){
 const response=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(auth?{Authorization:'Bearer '+auth}:{})},body:JSON.stringify(body)});
 assert.equal(response.status,status,path);
 return response.json();
}
async function wait(fn,label){for(let i=0;i<100;i++){try{if(await fn())return;}catch{}await sleep(100);}throw Error('Timed out '+label);}
(async()=>{
 php=spawn('php',['-S','127.0.0.1:18641','-t','public'],{windowsHide:true,stdio:'ignore'});
 await wait(async()=>{try{return(await fetch(base)).ok;}catch{return false;}},'PHP');
 const account={name:'Uji Profil 4C '+seed,email:'profile-4c-'+seed+'@example.test',password:randomBytes(24).toString('base64url'),role:'botani',institution:'Institusi Profil Sebelum',province:'Jawa Barat',city:'Kota Bandung',license_number:'UJI-PROFILE-4C'};
 await api('auth/register.php',account);
 writeFileSync(contextPath,JSON.stringify(account,null,2));
 const profile=mkdtempSync(join(tmpdir(),'pisanglens-profile-4c-'));
 chrome=spawn(process.env.PISANGLENS_TEST_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-first-run','--disable-background-networking','--remote-debugging-port=18642','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let tab;
 await wait(async()=>{try{tab=(await(await fetch('http://127.0.0.1:18642/json/list')).json()).find(t=>t.type==='page');return tab;}catch{return false;}},'Chrome');
 socket=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 let seq=0;const pending=new Map();
 socket.onmessage=event=>{const data=JSON.parse(event.data);const item=pending.get(data.id);if(!item)return;pending.delete(data.id);data.error?item.reject(new Error(data.error.message)):item.resolve(data.result);};
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result.value;};
 await cdp('Page.navigate',{url:base+'/index.html'});
 await wait(()=>evaluate('document.readyState==="complete"&&!!document.querySelector("form")'),'login');
 await evaluate('(()=>{const f=document.querySelector("form");f.elements.email.value='+JSON.stringify(account.email)+';f.elements.password.value='+JSON.stringify(account.password)+';f.querySelector("button").click();})()');
 await wait(()=>evaluate('document.getElementById("profile-name")?.textContent==='+JSON.stringify(account.name)),'profile');
 token=await evaluate('JSON.parse(sessionStorage.getItem("pisanglens-staff-session")).token');
 await evaluate('location.hash="akun"');
 await wait(()=>evaluate('!document.getElementById("profile-refresh").disabled'),'refresh idle');
 let paused;let posts=0;let failNextPost=false;let failedPost=false;
 socket.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.method!=='Fetch.requestPaused')return;const req=data.params;if(req.request.method==='GET'&&!paused){paused=req.requestId;}else{if(req.request.method==='POST')posts++;if(req.request.method==='POST'&&failNextPost){failedPost=true;void cdp('Fetch.failRequest',{requestId:req.requestId,errorReason:'Failed'});}else void cdp('Fetch.continueRequest',{requestId:req.requestId});}});
 await cdp('Fetch.enable',{patterns:[{urlPattern:'*/api/botanist/profile.php*',requestStage:'Request'}]});
 await evaluate('(()=>{const f=document.getElementById("profile-form");f.elements.institution.value="Institusi Profil Simpan Saat Refresh";f.elements.institution.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("profile-refresh").click();})()');
 await wait(()=>paused,'paused live GET');

 await evaluate('document.querySelector("#profile-form button").click()');
 await wait(()=>evaluate('document.getElementById("profile-status").textContent.includes("tersimpan di server")'),'save during GET');
 assert.equal(posts,1,'Exactly one real POST must be sent while refresh is pending');
 assert.equal((await api('botanist/profile.php',undefined,token)).institution,'Institusi Profil Simpan Saat Refresh');
 await cdp('Fetch.continueRequest',{requestId:paused});
 await wait(()=>evaluate('!document.getElementById("profile-refresh").disabled'),'GET released');
 await cdp('Fetch.disable');
 console.log('PASS: Save during real pending GET sends POST and persists to MySQL');
 await cdp('Page.reload');
 await wait(()=>evaluate('document.getElementById("profile-institution")?.textContent==="Institusi Profil Simpan Saat Refresh"'),'saved profile after reload');

 // Delay a real GET response produced before the next POST to prove it cannot overwrite the save.
 paused=null;posts=0;
 await cdp('Fetch.enable',{patterns:[{urlPattern:'*/api/botanist/profile.php*',requestStage:'Response'}]});
 await evaluate('document.getElementById("profile-refresh").click()');
 await wait(()=>paused,'old GET response paused');
 await evaluate('(()=>{const f=document.getElementById("profile-form");f.elements.institution.value="Institusi Profil Terbaru 4C";f.elements.province.value="DI Yogyakarta";f.elements.city.value="Kabupaten Sleman";f.elements.institution.dispatchEvent(new Event("input",{bubbles:true}));f.querySelector("button").click();})()');
 await wait(()=>evaluate('document.getElementById("profile-status").textContent.includes("tersimpan di server")'),'second saved profile');
 await cdp('Fetch.continueRequest',{requestId:paused});
 await wait(()=>evaluate('!document.getElementById("profile-refresh").disabled'),'stale GET released');
 assert.equal(await evaluate('document.getElementById("profile-institution").textContent'),'Institusi Profil Terbaru 4C');
 assert.equal(await evaluate('document.getElementById("profile-form").elements.institution.value'),'Institusi Profil Terbaru 4C');
 await cdp('Fetch.disable');
 console.log('PASS: delayed old GET cannot overwrite the newer server-confirmed profile');

 // Fail the next real POST before it reaches the server.
 await cdp('Fetch.enable',{patterns:[{urlPattern:'*/api/botanist/profile.php*',requestStage:'Request'}]});
 failNextPost=true;
 await evaluate('(()=>{const f=document.getElementById("profile-form");f.elements.institution.value="Perubahan Belum Tersimpan";f.elements.institution.dispatchEvent(new Event("input",{bubbles:true}));f.querySelector("button").click();})()');
 await wait(()=>failedPost,'failed POST');
 await wait(()=>evaluate('!document.querySelector("#profile-form button").disabled'),'failed request completed');
 assert.ok(!(await evaluate('document.getElementById("profile-status").textContent')).includes('tersimpan di server'));
 assert.equal((await api('botanist/profile.php',undefined,token)).institution,'Institusi Profil Terbaru 4C');
 failNextPost=false;
 await cdp('Fetch.disable');
 console.log('PASS: failed request keeps edits and never reports a successful server save');
 await evaluate('document.getElementById("staff-logout").click()');
 await wait(()=>evaluate('location.pathname==="/index.html"&&document.readyState==="complete"'),'logout');
 await evaluate('(()=>{const f=document.querySelector("form");f.elements.email.value='+JSON.stringify(account.email)+';f.elements.password.value='+JSON.stringify(account.password)+';f.querySelector("button").click();})()');
 await wait(()=>evaluate('document.getElementById("profile-institution")?.textContent==="Institusi Profil Terbaru 4C"'),'relogin profile');
 token=await evaluate('JSON.parse(sessionStorage.getItem("pisanglens-staff-session")).token');
 const saved=await api('botanist/profile.php',undefined,token);
 assert.equal(saved.city,'Kabupaten Sleman');assert.equal(saved.province,'DI Yogyakarta');assert.equal(saved.email,account.email);assert.equal(saved.is_verified,0);
 console.log('PASS: saved institution/region persist after reload, logout and real login; identity and verification preserved');
 await wait(()=>evaluate('!document.getElementById("profile-refresh").disabled'),'profile refresh idle');
 await api('auth/logout.php',{},token);
 token=null;
 await evaluate('document.getElementById("profile-refresh").click()');
 await wait(()=>evaluate('location.pathname==="/index.html"&&location.search.includes("role=botani")&&document.readyState==="complete"'),'server-invalidated session login redirect');
 assert.equal(await evaluate('sessionStorage.getItem("pisanglens-staff-session")'),null);
 console.log('PASS: real server-invalidated session returns 401 and redirects to Botanist login with no stale staff token');

 console.log('RETAINED TEST PROFILE '+account.email);
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(async()=>{if(token){try{await api('auth/logout.php',{},token);}catch{}}socket?.close();chrome?.kill();php?.kill();await sleep(200);});
