<?php

declare(strict_types=1);

require_once dirname(__DIR__, 3) . '/lib/auth.php';

authEndpoint('POST', static function (): array {
    $tokenHash = bearerHash();
    $pdo = authDatabase();
    requireAccount($pdo, $tokenHash);
    $delete = $pdo->prepare('DELETE FROM auth_tokens WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP()');
    $delete->execute([$tokenHash]);
    if ($delete->rowCount() !== 1) {
        authError(401);
    }
    startAuthSession(bearerToken());
    $_SESSION = [];
    session_destroy();
    return ['status' => 'ok'];
});
