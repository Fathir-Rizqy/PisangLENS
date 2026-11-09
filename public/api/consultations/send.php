<?php
declare(strict_types=1);
require_once dirname(__DIR__, 3) . '/lib/consultations.php';
require_once dirname(__DIR__, 3) . '/lib/crypto.php';

authEndpoint('POST', static function (): array {
    $hash = bearerHash();
    $pdo = authDatabase();
    $user = requireAccount($pdo, $hash);
    $body = authBody();
    $id = objectId($body['consultation_id'] ?? null);
    $payload = $body['encrypted_message'] ?? null;
    if (!$payload instanceof stdClass) authError(422);
    $payload = get_object_vars($payload);
    if (($payload['alg'] ?? '') !== 'AES-GCM' || ($payload['key_version'] ?? null) !== 1 ||
        !is_string($payload['iv'] ?? null) || !is_string($payload['ciphertext'] ?? null)) authError(422);
    $iv = base64_decode($payload['iv'], true);
    $cipher = base64_decode($payload['ciphertext'], true);
    if ($iv === false || strlen($iv) !== 12 || $cipher === false || strlen($cipher) < 17 || strlen($cipher) > 4096) authError(422);
    $pdo->beginTransaction();
    try {
        $ticket = participantTicket($pdo, $user, $id, true);
        if ($ticket['status'] === 'closed') authError(409);
        $plaintext = openssl_decrypt(substr($cipher, 0, -16), 'aes-256-gcm', ticketKey($id), OPENSSL_RAW_DATA, $iv, substr($cipher, -16));
        if ($plaintext === false || trim($plaintext) === '' || !mb_check_encoding($plaintext, 'UTF-8')) authError(422);
        $canonical = ['alg' => 'AES-GCM', 'key_version' => 1, 'iv' => base64_encode($iv), 'ciphertext' => base64_encode($cipher)];
        $encoded = json_encode($canonical, JSON_THROW_ON_ERROR);
        $existing = $pdo->prepare('SELECT id, sender_id, encrypted_message FROM chat_messages WHERE consultation_id = ? AND message_iv = ?');
        $existing->execute([$id, $canonical['iv']]);
        $message = $existing->fetch();
        if ($message) {
            if ((string) $message['sender_id'] !== (string) $user['id'] ||
                json_decode($message['encrypted_message'], true) != $canonical) authError(409);
            $messageId = $message['id'];
        } else {
            $insert = $pdo->prepare('INSERT INTO chat_messages (consultation_id, sender_id, encrypted_message, message_iv) VALUES (?, ?, ?, ?)');
            $insert->execute([$id, $user['id'], $encoded, $canonical['iv']]);
            $messageId = $pdo->lastInsertId();
        }
        if ($user['role'] === 'botani') {
            $query = $pdo->prepare("UPDATE consultations SET status = 'answered' WHERE id = ?");
            $query->execute([$id]);
        }
        $pdo->commit();
        return ['message_id' => (string) $messageId, 'status' => 'ok'];
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
});
