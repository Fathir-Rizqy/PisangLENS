<?php

declare(strict_types=1);

require_once dirname(__DIR__, 3) . '/lib/auth.php';

authEndpoint('GET', static function (): array {
    $tokenHash = bearerHash();
    $pdo = authDatabase();
    requireAccount($pdo, $tokenHash, 'admin');
    $type = $_GET['type'] ?? '';
    if ($type === 'retraining') {
        $query = $pdo->prepare("SELECT q.id, q.scan_id, q.consultation_id, q.original_label, q.corrected_label,
            q.review_note, q.review_outcome, q.status, q.reviewed_at, u.name AS reviewer_name, s.model_version
            FROM retraining_queue q JOIN scans s ON s.id = q.scan_id JOIN users u ON u.id = q.reviewed_by
            WHERE q.status = 'pending' AND q.review_outcome = 'valid' AND s.prediction_source <> 'mock'
            AND s.model_version NOT LIKE '%mock%' ORDER BY q.reviewed_at, q.id");
        $query->execute();
        return $query->fetchAll();
    }
    if ($type !== 'botanist') {
        authError(422);
    }
    $query = $pdo->prepare(
        "SELECT id, name, email, license_number, institution, province, city,
         DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at FROM users
         WHERE role = ? AND is_verified = 0 AND verification_rejected_at IS NULL ORDER BY created_at, id"
    );
    $query->execute(['botani']);
    return $query->fetchAll();
});
