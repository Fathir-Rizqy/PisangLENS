<?php

declare(strict_types=1);

require_once dirname(__DIR__, 3) . '/lib/auth.php';

authEndpoint('POST', static function (): array {
    $tokenHash = bearerHash();
    $pdo = authDatabase();
    $user = requireAccount($pdo, $tokenHash, 'admin');
    $body = authBody();
    $type = $body['approval_type'] ?? null;
    if ($type === 'retraining') {
        $target = $body['target_id'] ?? null;
        $decision = $body['decision'] ?? null;
        if ((!is_int($target) && !is_string($target)) || !preg_match('/^[1-9][0-9]{0,18}$/D', (string) $target) || !in_array($decision, ['approve', 'reject'], true)) authError(422);
        $status = $decision === 'approve' ? 'approved' : 'rejected';
        $update = $pdo->prepare("UPDATE retraining_queue q JOIN scans s ON s.id = q.scan_id
            SET q.status = ?, q.approved_by = ?, q.decided_at = UTC_TIMESTAMP()
            WHERE q.id = ? AND q.status = 'pending' AND q.review_outcome = 'valid'
            AND q.corrected_label IN ('Healthy', 'Pestalotiopsis Leaf Blight', 'Sigatoka', 'Cordana Leaf Spot')
            AND s.prediction_source <> 'mock' AND s.model_version NOT LIKE '%mock%'");
        $update->execute([$status, $user['id'], (string) $target]);
        if ($update->rowCount() !== 1) authError(409);
        return ['updated_status' => $status];
    }
    $target = $body['target_id'] ?? null;
    $decision = $body['decision'] ?? null;
    if ($type !== 'botanist_license' || !in_array($decision, ['approve', 'reject'], true) ||
        (!is_int($target) && !is_string($target)) ||
        !preg_match('/^[1-9][0-9]{0,19}$/D', (string) $target) ||
        (strlen((string) $target) === 20 && strcmp((string) $target, '18446744073709551615') > 0)) {
        authError(422);
    }

    $update = $pdo->prepare(
        'UPDATE users SET is_verified = ?, verification_rejected_at = IF(? = 1, NULL, UTC_TIMESTAMP())
         WHERE id = CAST(? AS UNSIGNED) AND role = ? AND is_verified = 0 AND verification_rejected_at IS NULL'
    );
    $approved = $decision === 'approve' ? 1 : 0;
    $update->execute([$approved, $approved, $target, 'botani']);
    if ($update->rowCount() !== 1) {
        $lookup = $pdo->prepare('SELECT id FROM users WHERE id = CAST(? AS UNSIGNED) AND role = ?');
        $lookup->execute([$target, 'botani']);
        authError($lookup->fetch() ? 409 : 403);
    }
    return ['updated_status' => $approved ? 'approved' : 'rejected'];
});
