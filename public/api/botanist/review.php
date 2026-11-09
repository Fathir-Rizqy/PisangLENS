<?php
declare(strict_types=1);
require_once dirname(__DIR__, 3) . '/lib/consultations.php';

authEndpoint('POST', static function (): array {
    $pdo = authDatabase();
    $user = requireAccount($pdo, bearerHash(), 'botani');
    if (!(bool) $user['is_verified']) authError(403);
    $body = authBody();
    $ticketId = objectId($body['consultation_id'] ?? null);
    $scanId = objectId($body['scan_id'] ?? null);
    $outcome = $body['review_outcome'] ?? null;
    if (!in_array($outcome, ['valid', 'undetermined', 'unusable'], true)) authError(422);
    $label = $body['corrected_label'] ?? null;
    if (($outcome === 'valid' && !in_array($label, LEAF_CLASSES, true)) || ($outcome !== 'valid' && $label !== null)) authError(422);
    $note = authText($body, 'review_note', 2000);
    $pdo->beginTransaction();
    try {
        $ticket = participantTicket($pdo, $user, $ticketId, true);
        if ((string) $ticket['scan_id'] !== $scanId) { $pdo->rollBack(); authError(403); }
        $query = $pdo->prepare('SELECT predicted_class, prediction_source, model_version FROM scans WHERE id = ? FOR UPDATE');
        $query->execute([$scanId]);
        $scan = $query->fetch();
        if (!$scan || $scan['prediction_source'] === 'mock' || str_contains($scan['model_version'], 'mock')) { $pdo->rollBack(); authError(422); }
        $query = $pdo->prepare('SELECT id FROM retraining_queue WHERE scan_id = ?');
        $query->execute([$scanId]);
        if ($query->fetchColumn()) { $pdo->rollBack(); authError(409); }
        $query = $pdo->prepare('INSERT INTO retraining_queue (scan_id, consultation_id, original_label, corrected_label, review_outcome, reviewed_by, reviewed_at, review_note, status) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?)');
        $status = $outcome === 'valid' ? 'pending' : 'rejected';
        $query->execute([$scanId, $ticketId, $scan['predicted_class'], $label, $outcome, $user['id'], $note, $status]);
        $id = (string) $pdo->lastInsertId();
        $pdo->commit();
        return ['queue_id' => $id, 'status' => $status];
    } catch (Throwable $error) { if ($pdo->inTransaction()) $pdo->rollBack(); throw $error; }
});
