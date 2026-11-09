<?php
declare(strict_types=1);
require_once dirname(__DIR__, 3) . '/lib/consultations.php';

authEndpoint('POST', static function (): array {
    $hash = bearerHash();
    $pdo = authDatabase();
    $user = requireAccount($pdo, $hash, 'petani');
    $batch = authBody(35 * 1024 * 1024, true);
    if (count($batch) > 5) authError(422);
    $synced = [];
    $failed = [];
    $settings = require dirname(__DIR__, 3) . '/config/config.php';
    foreach ($batch as $item) {
        $scan = $item instanceof stdClass ? get_object_vars($item) : [];
        $uuid = $scan['client_uuid'] ?? null;
        try {
            if (!is_string($uuid) || !preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iD', $uuid)) throw new InvalidArgumentException();
            $pdo->beginTransaction();
            $lock = $pdo->prepare('SELECT id FROM users WHERE id = ? FOR UPDATE');
            $lock->execute([$user['id']]);
            $existing = $pdo->prepare('SELECT id FROM scans WHERE user_id = ? AND client_uuid = ?');
            $existing->execute([$user['id'], $uuid]);
            $id = $existing->fetchColumn();
            if (!$id) {
                if (!in_array($scan['predicted_class'] ?? null, LEAF_CLASSES, true) ||
                    !in_array($scan['prediction_source'] ?? null, ['mock', 'local', 'server'], true) ||
                    (!is_int($scan['confidence_score'] ?? null) && !is_float($scan['confidence_score'] ?? null)) ||
                    $scan['confidence_score'] < 0 || $scan['confidence_score'] > 1 ||
                    !is_string($scan['model_version'] ?? null) || strlen($scan['model_version']) > 100 || trim($scan['model_version']) === '' ||
                    !in_array($scan['triage_phase'] ?? null, [null, 'tumbuh', 'berbuah'], true) ||
                    !is_string($scan['image_base64'] ?? null) || !is_string($scan['created_at'] ?? null)) throw new InvalidArgumentException();
                if (!preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/D', $scan['created_at'])) throw new InvalidArgumentException();
                $created = new DateTimeImmutable($scan['created_at']);
                $dateErrors = DateTimeImmutable::getLastErrors();
                if ($dateErrors && ($dateErrors['warning_count'] || $dateErrors['error_count'])) throw new InvalidArgumentException();
                $bytes = base64_decode($scan['image_base64'], true);
                if ($bytes === false || strlen($bytes) > 5 * 1024 * 1024) throw new InvalidArgumentException();
                $mime = (new finfo(FILEINFO_MIME_TYPE))->buffer($bytes);
                $extension = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'][$mime] ?? null;
                $size = @getimagesizefromstring($bytes);
                if (!$extension || !$size || $size[0] * $size[1] > 16000000) throw new InvalidArgumentException();
                $image = @imagecreatefromstring($bytes);
                if ($image === false) throw new InvalidArgumentException();
                imagedestroy($image);
                $directory = $settings['uploads_dir'];
                if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) throw new RuntimeException('Upload storage unavailable.');
                $filename = bin2hex(random_bytes(24)) . '.' . $extension;
                $file = fopen($directory . '/' . $filename, 'xb');
                if ($file === false) throw new RuntimeException('Upload storage unavailable.');
                try {
                    if (fwrite($file, $bytes) !== strlen($bytes)) throw new RuntimeException('Upload write failed.');
                } finally { fclose($file); }
                $insert = $pdo->prepare('INSERT INTO scans (user_id, client_uuid, image_path, predicted_class, confidence_score, prediction_source, model_version, triage_phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
                $insert->execute([$user['id'], $uuid, $filename, $scan['predicted_class'], $scan['confidence_score'], $scan['prediction_source'], $scan['model_version'], $scan['triage_phase'] ?? null, $created->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s')]);
                $id = $pdo->lastInsertId();
            }
            $pdo->commit();
            $synced[] = ['client_uuid' => $uuid, 'scan_id' => (string) $id];
        } catch (Throwable $error) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            $failed[] = ['client_uuid' => is_string($uuid) ? $uuid : null, 'reason' => 'Pemindaian belum dapat disimpan. Periksa format foto dan data.'];
        }
    }
    return ['synced' => $synced, 'failed' => $failed, 'status' => 'ok'];
});
