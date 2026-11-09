<?php
declare(strict_types=1);
require_once dirname(__DIR__, 3) . '/lib/consultations.php';

authEndpoint('GET', static function (): array {
    $hash = bearerHash();
    $pdo = authDatabase();
    $user = requireAccount($pdo, $hash);
    if ($user['role'] === 'petani') {
        $condition = 'c.petani_id = ?';
    } elseif ($user['role'] === 'botani' && (bool) $user['is_verified']) {
        $condition = "(c.botani_id = ? OR (c.botani_id IS NULL AND c.status = 'open'))";
    } else {
        authError(403);
    }
    $query = $pdo->prepare(
        "SELECT c.id, c.botani_id, c.status, c.created_at, c.scan_id,
         s.predicted_class, s.confidence_score, s.prediction_source,
         (s.prediction_source = 'mock') AS prediction_simulated
         FROM consultations c JOIN scans s ON s.id = c.scan_id WHERE $condition ORDER BY c.id DESC"
    );
    $query->execute([$user['id']]);
    $tickets = $query->fetchAll();
    if ($user['role'] === 'botani') {
        foreach ($tickets as &$ticket) {
            if ((string) $ticket['botani_id'] !== (string) $user['id']) {
                unset($ticket['scan_id'], $ticket['predicted_class'], $ticket['confidence_score'], $ticket['prediction_source']);
            }
        }
    }
    return $tickets;
});
