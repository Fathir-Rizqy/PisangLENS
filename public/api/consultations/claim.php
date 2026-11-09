<?php
declare(strict_types=1);
require_once dirname(__DIR__, 3) . '/lib/consultations.php';

authEndpoint('POST', static function (): array {
    $hash = bearerHash();
    $pdo = authDatabase();
    $user = requireAccount($pdo, $hash, 'botani');
    $id = objectId(authBody()['consultation_id'] ?? null);
    $update = $pdo->prepare("UPDATE consultations SET botani_id = ? WHERE id = ? AND botani_id IS NULL AND status = 'open'");
    $update->execute([$user['id'], $id]);
    if ($update->rowCount() !== 1) {
        $query = $pdo->prepare('SELECT botani_id FROM consultations WHERE id = ?');
        $query->execute([$id]);
        $ticket = $query->fetch();
        if (!$ticket) authError(403);
        if ((string) $ticket['botani_id'] !== (string) $user['id']) authError(409);
    }
    $ticket = participantTicket($pdo, $user, $id);
    return ['consultation_id' => $ticket['id'], 'status' => $ticket['status']];
});
