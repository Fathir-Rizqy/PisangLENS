export const SHELL_CACHE = 'pisanglens-shell-v15-real2';
export const SHELL_PATHS = [
    './', 'index.html', 'manifest.webmanifest', 'petani-daftar.html', 'petani-kamera.html',
    'admin-verifikasi.html', 'admin-masuk.html', 'botani-akun.html',
    'css/app.css', 'css/dashboard.css', 'icons/daun.svg',
    ...['config', 'predict', 'predict-mock', 'model-assets', 'worker-assets', 'model-layers', 'model-preprocess', 'model-weights', 'offline', 'shell-assets',
        'api', 'auth', 'staff', 'botani', 'dashboard', 'camera', 'crypto', 'db', 'dictionary', 'petani', 'sync',
        'consultations', 'chat', 'photos', 'directory', 'region-examples', 'app-update', 'learning'].map(name => `js/${name}.js`),
    'js/petani.js?v=real-3',
];
