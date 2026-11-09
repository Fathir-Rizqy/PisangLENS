<?php
declare(strict_types=1);
// Operator-only private dataset snapshot. Never served by the public webroot.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once dirname(__DIR__) . '/lib/db.php';
$target = $argv[1] ?? '';
if ($target === '' || file_exists($target)) { fwrite(STDERR, "Usage: php scripts/export-training.php NEW_PRIVATE_DIRECTORY\n"); exit(1); }
$parent = realpath(dirname($target));
$publicRoot = realpath(dirname(__DIR__) . '/public');
if (!$parent || ($publicRoot && str_starts_with($parent . '/', $publicRoot . '/'))) throw new RuntimeException('Create the parent directory outside the webroot first.');
$target = $parent . '/' . basename($target);
$settings = require dirname(__DIR__) . '/config/config.php';
$pdo = openDatabase($settings['database']);
$query = $pdo->prepare("SELECT q.id AS review_id, q.scan_id, q.corrected_label, q.reviewed_by, q.reviewed_at, q.approved_by, q.decided_at, s.image_path, s.model_version
    FROM retraining_queue q JOIN scans s ON s.id = q.scan_id
    WHERE q.status = 'approved' AND q.review_outcome = 'valid' AND q.approved_by IS NOT NULL
    AND q.corrected_label IN ('Cordana Leaf Spot', 'Healthy', 'Pestalotiopsis Leaf Blight', 'Sigatoka')
    AND s.prediction_source <> 'mock' AND s.model_version NOT LIKE '%mock%' ORDER BY q.id");
$query->execute();
$rows = $query->fetchAll();
$uploadRoot = realpath($settings['uploads_dir']);
if (!$uploadRoot || !mkdir($target, 0700) || !mkdir($target . '/images', 0700)) throw new RuntimeException('Private output unavailable.');
$target = realpath($target);
if ($publicRoot && str_starts_with($target . '/', $publicRoot . '/')) throw new RuntimeException('Training data must be outside the webroot.');
$labels = ['Cordana Leaf Spot', 'Healthy', 'Pestalotiopsis Leaf Blight', 'Sigatoka'];
$records = [];
foreach ($rows as $row) {
    $file = realpath($uploadRoot . '/' . basename($row['image_path']));
    if (!$file || dirname($file) !== $uploadRoot || !is_file($file) || filesize($file) > 5 * 1024 * 1024) throw new RuntimeException('Source image unavailable.');
    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($file);
    $extension = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'][$mime] ?? null;
    if (!$extension || !getimagesize($file)) throw new RuntimeException('Invalid source image.');
    $relative = 'images/' . $row['review_id'] . '.' . $extension;
    if (!copy($file, $target . '/' . $relative) || !chmod($target . '/' . $relative, 0600)) throw new RuntimeException('Snapshot copy failed.');
    unset($row['image_path']);
    $records[] = $row + ['file' => $relative, 'sha256' => hash_file('sha256', $file), 'label_id' => array_search($row['corrected_label'], $labels, true)];
}
$manifest = ['format' => 'pisanglens-approved-v1', 'labels' => $labels, 'created_at' => gmdate('c'), 'records' => $records];
file_put_contents($target . '/manifest.json', json_encode($manifest, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR), LOCK_EX);
chmod($target . '/manifest.json', 0600);
fwrite(STDOUT, json_encode(['approved_images' => count($records), 'manifest' => $target . '/manifest.json'], JSON_THROW_ON_ERROR) . "\n");
