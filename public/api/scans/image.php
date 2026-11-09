<?php
declare(strict_types=1);
require_once dirname(__DIR__, 3) . '/lib/consultations.php';

authEndpoint('GET', static function (): array {
    $hash = bearerHash();
    $pdo = authDatabase();
    $user = requireAccount($pdo, $hash);
    $id = objectId($_GET['scan_id'] ?? null);
    $query = $pdo->prepare('SELECT s.user_id, s.image_path, c.botani_id FROM scans s LEFT JOIN consultations c ON c.scan_id = s.id WHERE s.id = ?');
    $query->execute([$id]);
    $scan = $query->fetch();
    $curatedAdmin = false;
    if ($scan && $user['role'] === 'admin') {
        $curation = $pdo->prepare('SELECT q.id FROM retraining_queue q JOIN scans s ON s.id = q.scan_id WHERE q.scan_id = ? AND s.prediction_source <> ? LIMIT 1');
        $curation->execute([$id, 'mock']);
        $curatedAdmin = (bool) $curation->fetchColumn();
    }
    if (!$scan || !(($user['role'] === 'petani' && (string) $scan['user_id'] === (string) $user['id']) ||
        ($user['role'] === 'botani' && (bool) $user['is_verified'] && (string) $scan['botani_id'] === (string) $user['id']) || $curatedAdmin)) authError(403);
    $settings = require dirname(__DIR__, 3) . '/config/config.php';
    $root = realpath($settings['uploads_dir']);
    $path = $root ? realpath($root . '/' . basename($scan['image_path'])) : false;
    if (!$path || dirname($path) !== $root || !is_file($path)) authError(404);
    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($path);
    if (!in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true)) authError(404);
    header('Content-Type: ' . $mime);
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('Content-Length: ' . filesize($path));
    readfile($path);
    exit;
});
