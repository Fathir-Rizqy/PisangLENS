<?php
declare(strict_types=1);
require_once dirname(__DIR__, 3) . '/lib/consultations.php';

authEndpoint('GET', static function (): array {
    $hash = bearerHash();
    $pdo = authDatabase();
    $user = requireAccount($pdo, $hash);
    $id = objectId($_GET['consultation_id'] ?? null);
    participantTicket($pdo, $user, $id);
    $after = $_GET['after_id'] ?? '0';
    if (!is_string($after) || !preg_match('/^[0-9]{1,19}$/D', $after)) authError(422);
    $query = $pdo->prepare('SELECT id, sender_id, encrypted_message, created_at FROM chat_messages WHERE consultation_id = ? AND id > ? ORDER BY id LIMIT 200');
    $query->execute([$id, $after]);
    $messages = $query->fetchAll();
    foreach ($messages as &$message) $message['encrypted_message'] = json_decode($message['encrypted_message'], true, 8, JSON_THROW_ON_ERROR);
    return $messages;
});
