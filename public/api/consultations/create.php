<?php
declare(strict_types=1);
require_once dirname(__DIR__, 3) . '/lib/consultations.php';

authEndpoint('POST', static function (): array {
    $hash = bearerHash();
    $pdo = authDatabase();
    $user = requireAccount($pdo, $hash, 'petani');
    $id = objectId(authBody()['scan_id'] ?? null);
    $pdo->beginTransaction();
    $lock = $pdo->prepare('SELECT id FROM users WHERE id = ? FOR UPDATE');
    $lock->execute([$user['id']]);
    $query = $pdo->prepare('SELECT * FROM scans WHERE id = ? AND user_id = ?');
    $query->execute([$id, $user['id']]);
    $scan = $query->fetch();
    if (!$scan || !consultationEligible($scan)) {
        authError(403);
    }
    $query = $pdo->prepare('SELECT id AS consultation_id, status FROM consultations WHERE scan_id = ?');
    $query->execute([$id]);
    $ticket = $query->fetch();
    if (!$ticket) {
        $insert = $pdo->prepare('INSERT INTO consultations (scan_id, petani_id) VALUES (?, ?)');
        $insert->execute([$id, $user['id']]);
        $query->execute([$id]);
        $ticket = $query->fetch();
    }
    $pdo->commit();
    return $ticket;
});
