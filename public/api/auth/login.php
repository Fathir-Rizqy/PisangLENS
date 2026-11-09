<?php

declare(strict_types=1);

require_once dirname(__DIR__, 3) . '/lib/auth.php';

authEndpoint('POST', static function (): array {
    $body = authBody();
    $email = authEmail($body);
    $password = authPassword($body);
    $pdo = authDatabase();
    $query = $pdo->prepare('SELECT id, name, role, is_verified, password_hash, institution, province, city FROM users WHERE email = ?');
    $query->execute([$email]);
    $user = $query->fetch();
    // An unused bcrypt hash keeps unknown accounts on the same verification path.
    $hash = $user['password_hash'] ?? '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi';
    if (!password_verify($password, $hash) || !$user) {
        authError(401);
    }

    startAuthSession();
    if (!session_regenerate_id(true)) {
        throw new RuntimeException('Session could not be renewed.');
    }
    $token = session_id();
    $expires = time() + 8 * 60 * 60;
    $_SESSION = ['user_id' => $user['id'], 'expires_at' => $expires];
    session_write_close();
    $insert = $pdo->prepare('INSERT INTO auth_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)');
    $insert->execute([$user['id'], hash('sha256', $token), gmdate('Y-m-d H:i:s', $expires)]);
    return [
        'token' => $token,
        'user_id' => $user['id'],
        'role' => $user['role'],
        'is_verified' => (int) $user['is_verified'],
        'name' => $user['name'],
        'institution' => $user['institution'],
        'province' => $user['province'],
        'city' => $user['city'],
        'expires_at' => gmdate('Y-m-d\TH:i:s\Z', $expires),
    ];
});
