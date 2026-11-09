<?php
declare(strict_types=1);
require_once dirname(__DIR__, 3) . '/lib/consultations.php';
require_once dirname(__DIR__, 3) . '/lib/crypto.php';

authEndpoint('GET', static function (): array {
    $hash = bearerHash();
    $pdo = authDatabase();
    $user = requireAccount($pdo, $hash);
    $id = objectId($_GET['consultation_id'] ?? null);
    participantTicket($pdo, $user, $id);
    return ['key' => base64_encode(ticketKey($id)), 'key_version' => 1];
});
