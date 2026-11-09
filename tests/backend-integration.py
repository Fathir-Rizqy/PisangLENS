"""Isolated PHP/MySQL regression. Creates a NEW database and /tmp app copy only.

Requires PHP 8.3 (pdo_mysql, mbstring, fileinfo, gd), MySQL CLI and local socket.
Set PHP_BINARY, PHP_EXTENSION_DIR, MYSQL_BINARY, MYSQL_SOCKET as needed.
Never points at the application's config/config.php or existing user database.
"""
import base64
import copy
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
work = Path(tempfile.mkdtemp(prefix='pisanglens-backend-'))
database = 'pisanglens_codex_test_' + secrets.token_hex(5)
mysql = [os.environ.get('MYSQL_BINARY', 'mysql'), '--no-defaults', '--socket=' + os.environ.get('MYSQL_SOCKET', '/var/run/mysqld/mysqld.sock'), '-u', 'root']
php = [os.environ.get('PHP_BINARY', 'php')]
if os.environ.get('PHP_EXTENSION_DIR'):
    php += ['-n', '-d', 'extension_dir=' + os.environ['PHP_EXTENSION_DIR']]
    for extension in ['mbstring', 'pdo', 'mysqlnd', 'pdo_mysql', 'fileinfo', 'gd']: php += ['-d', 'extension=' + extension]
checks, tokens = [], []


def sql(query, use=True):
    return subprocess.run(mysql + ([database] if use else []), input=query, text=True, capture_output=True, check=True).stdout


def check(condition, name):
    assert condition, name
    checks.append(name); print('PASS:', name, flush=True)


def api(path, body=None, token=None, expected=200, raw=False):
    headers = {'Accept': 'application/json'}
    if token: headers['Authorization'] = 'Bearer ' + token
    if body is not None: headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(base + '/api/' + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try: response = urllib.request.urlopen(request, timeout=20)
    except urllib.error.HTTPError as error: response = error
    content = response.read()
    assert response.status == expected, f'{path}: expected {expected}, got {response.status}'
    assert response.headers.get('Cache-Control') == 'no-store', path + ' must be no-store'
    return content if raw else json.loads(content)


server = None
try:
    sql('CREATE DATABASE ' + database + ' CHARACTER SET utf8mb4;', False)
    sql((ROOT / 'sql/schema.sql').read_text())
    sql((ROOT / 'sql/continuous-learning-2026-11-07.sql').read_text())
    for directory in ['public', 'lib', 'config', 'scripts']:
        shutil.copytree(ROOT / directory, work / directory, ignore=shutil.ignore_patterns('__pycache__', 'config.php'))
    settings = "<?php return ['database'=>['dsn'=>'mysql:unix_socket=" + os.environ.get('MYSQL_SOCKET', '/var/run/mysqld/mysqld.sock') + ';dbname=' + database + ";charset=utf8mb4','username'=>'root','password'=>''],'uploads_dir'=>__DIR__.'/../storage/uploads','chat_master_key_file'=>__DIR__.'/../storage/chat-master.key'];"
    (work / 'config/config.php').write_text(settings)
    (work / 'storage').mkdir(mode=0o700)
    (work / 'storage/chat-master.key').write_bytes(secrets.token_bytes(32))
    (work / 'storage/chat-master.key').chmod(0o600)
    password = secrets.token_urlsafe(18)
    (work / 'browser-credentials.json').write_text(json.dumps({'password': password}))
    (work / 'browser-credentials.json').chmod(0o600)
    hashed = subprocess.run(php + ['-r', "echo password_hash(stream_get_contents(STDIN), PASSWORD_DEFAULT);"], input=password, text=True, capture_output=True, check=True).stdout
    sql("INSERT INTO users(name,email,password_hash,role,is_verified) VALUES('Isolated Admin','admin@example.test','" + hashed + "','admin',1);")
    with socket.socket() as sock: sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    log = (work / 'php.log').open('w')
    server = subprocess.Popen(php + ['-S', f'127.0.0.1:{port}', '-t', str(work / 'public')], stdout=log, stderr=log)
    for _ in range(100):
        try: urllib.request.urlopen(base + '/index.html', timeout=1); break
        except OSError: time.sleep(.1)
    else: raise RuntimeError('Isolated PHP did not start')

    def login(email):
        value = api('auth/login.php', {'email': email, 'password': password}); tokens.append(value['token']); return value

    accounts = {}
    for role, name in [('petani', 'farmer-a'), ('petani', 'farmer-b'), ('botani', 'botanist-a'), ('botani', 'botanist-b')]:
        body = {'name': name, 'email': name + '@example.test', 'password': password, 'role': role}
        if role == 'botani': body.update(license_number='TEST', institution='Test lab', province='Test province', city='Test city')
        api('auth/register.php', body); accounts[name] = login(body['email'])
    api('auth/register.php', {'role': 'admin'}, expected=403)
    api('admin/queue.php?type=botanist', expected=401)
    api('admin/queue.php?type=botanist', token=accounts['farmer-a']['token'], expected=403)
    api('consultations/list.php', token=accounts['botanist-a']['token'], expected=403)
    admin = login('admin@example.test')
    for row in api('admin/queue.php?type=botanist', token=admin['token']):
        api('admin/approve.php', {'target_id': row['id'], 'approval_type': 'botanist_license', 'decision': 'approve'}, admin['token'])
    check(len(api('admin/queue.php?type=botanist', token=admin['token'])) == 0, 'registration, login, RBAC and Admin Botanist verification')
    a, b, expert, other = [accounts[name]['token'] for name in ['farmer-a', 'farmer-b', 'botanist-a', 'botanist-b']]
    image = base64.b64encode((ROOT / 'tests/fixtures/real-model/raw_e9abdeb7f9b0_00748.png').read_bytes()).decode()
    scans = []
    for source in ['local', 'mock', 'local']:
        scans.append({'client_uuid': secrets.token_hex(4) + '-1234-4234-8234-' + secrets.token_hex(6), 'image_base64': image,
            'predicted_class': 'Pestalotiopsis Leaf Blight', 'confidence_score': .5958182634728052,
            'prediction_source': source, 'model_version': 'e03-large-seed42-fd0e0c2b-v1' if source == 'local' else 'phase-1-mock',
            'created_at': '2026-11-07T07:00:00Z', 'triage_phase': 'tumbuh'})
    synced = api('history/sync.php', scans + [{'client_uuid': 'invalid'}], a)
    check(len(synced['synced']) == 3 and len(synced['failed']) == 1, 'scan upload and partial sync acknowledgement')
    check(api('history/sync.php', [scans[0]], a)['synced'][0]['scan_id'] == synced['synced'][0]['scan_id'], 'idempotent account-scoped history sync')
    ids = [row['scan_id'] for row in synced['synced']]
    check(api('scans/image.php?scan_id=' + ids[0], token=a, raw=True) == base64.b64decode(image), 'owner retrieves protected image')
    for token in [b, expert, admin['token']]: api('scans/image.php?scan_id=' + ids[0], token=token, expected=403)
    api('consultations/create.php', {'scan_id': ids[0]}, b, expected=403)
    tickets = [str(api('consultations/create.php', {'scan_id': scan_id}, a)['consultation_id']) for scan_id in ids]
    check(str(api('consultations/create.php', {'scan_id': ids[0]}, a)['consultation_id']) == tickets[0], 'consultation eligibility and idempotent create')
    api('consultations/key.php?consultation_id=' + tickets[0], token=other, expected=403)
    for ticket in tickets: api('consultations/claim.php', {'consultation_id': ticket}, expert)
    api('consultations/claim.php', {'consultation_id': tickets[0]}, other, expected=409)
    key = api('consultations/key.php?consultation_id=' + tickets[0], token=a)
    encrypt_code = "import{webcrypto}from'node:crypto';import{readFileSync}from'node:fs';globalThis.crypto=webcrypto;const{encryptMessage}=await import('./public/js/crypto.js');console.log(JSON.stringify(await encryptMessage('Isolated encrypted regression',JSON.parse(readFileSync(0,'utf8')))));"
    encrypted = json.loads(subprocess.run(['node', '--input-type=module', '-e', encrypt_code], input=json.dumps(key), text=True, cwd=ROOT, capture_output=True, check=True).stdout)
    message = api('consultations/send.php', {'consultation_id': tickets[0], 'encrypted_message': encrypted}, a)
    check(api('consultations/send.php', {'consultation_id': tickets[0], 'encrypted_message': encrypted}, a)['message_id'] == message['message_id'], 'encrypted first message and idempotent retry')
    altered = copy.deepcopy(encrypted); altered['ciphertext'] = altered['ciphertext'][:-4] + 'AAAA'
    api('consultations/send.php', {'consultation_id': tickets[0], 'encrypted_message': altered}, a, expected=422)
    api('consultations/messages.php?consultation_id=' + tickets[0], token=b, expected=403)
    api('consultations/key.php?consultation_id=' + tickets[0], token=admin['token'], expected=403)
    api('consultations/send.php', {'consultation_id': tickets[0], 'encrypted_message': {**encrypted, 'iv': 'bad'}}, expert, expected=422)
    check('Isolated encrypted regression' not in sql('SELECT encrypted_message FROM chat_messages;'), 'ciphertext in MySQL; tampering and cross-account chat access rejected')
    review = {'consultation_id': tickets[0], 'scan_id': ids[0], 'review_outcome': 'valid', 'corrected_label': 'Sigatoka', 'review_note': 'Expert verified the visible disease.'}
    for token in [a, other]: api('botanist/review.php', review, token, expected=403)
    api('botanist/review.php', {**review, 'corrected_label': 'Invalid class'}, expert, expected=422)
    api('botanist/review.php', {**review, 'scan_id': ids[2]}, expert, expected=403)
    api('botanist/review.php', {**review, 'scan_id': ids[1], 'consultation_id': tickets[1]}, expert, expected=422)
    reviewed = api('botanist/review.php', review, expert)
    api('botanist/review.php', review, expert, expected=409)
    api('botanist/review.php', {**review, 'scan_id': ids[2], 'consultation_id': tickets[2], 'review_outcome': 'unusable', 'corrected_label': None}, expert)
    queued = api('admin/queue.php?type=retraining', token=admin['token'])
    check(len(queued) == 1 and queued[0]['corrected_label'] == 'Sigatoka', 'only assigned verified Botanist can curate; mock/invalid/unusable excluded')
    check(api('scans/image.php?scan_id=' + ids[0], token=admin['token'], raw=True) == base64.b64decode(image), 'Admin image access is restricted to curation queue')
    api('admin/approve.php', {'target_id': reviewed['queue_id'], 'approval_type': 'retraining', 'decision': 'approve'}, a, expected=403)
    decision = {'target_id': reviewed['queue_id'], 'approval_type': 'retraining', 'decision': 'approve'}
    api('admin/approve.php', decision, admin['token']); api('admin/approve.php', decision, admin['token'], expected=409)
    check(not api('admin/queue.php?type=retraining', token=admin['token']), 'Admin approval is atomic and does not retrain or publish the active model')
    export = subprocess.run(php + [str(work / 'scripts/export-training.php'), str(work / 'approved')], capture_output=True, text=True, check=True)
    manifest = json.loads((work / 'approved/manifest.json').read_text())
    check(len(manifest['records']) == 1 and manifest['records'][0]['label_id'] == 3, 'private export contains approved human label in the exact model order')
    api('auth/logout.php', {}, a); api('consultations/list.php', token=a, expected=401)
    check(True, 'logout invalidates server session')
    report = {'status': 'passed', 'checks': checks, 'php_version': subprocess.run(php + ['-r', 'echo PHP_VERSION;'], capture_output=True, text=True, check=True).stdout,
        'mysql_version': sql('SELECT VERSION();').strip().splitlines()[-1], 'isolated_database': database, 'private_test_directory': str(work), 'production_data_touched': False}
    (ROOT / 'reports/backend-verification.json').write_text(json.dumps(report, indent=2))
    (work / 'context.json').write_text(json.dumps({'base': base, 'database': database, 'work': str(work)}))
    print('Private test directory:', work)
finally:
    for token in tokens:
        try: api('auth/logout.php', {}, token)
        except Exception: pass
    if server: server.terminate(); server.wait(timeout=10)
