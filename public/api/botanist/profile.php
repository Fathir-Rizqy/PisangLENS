<?php

declare(strict_types=1);

require_once dirname(__DIR__, 3) . '/lib/auth.php';

$method = $_SERVER['REQUEST_METHOD'] ?? '';
if (!in_array($method, ['GET', 'POST'], true)) {
    header('Allow: GET, POST');
    authError(405);
}

authEndpoint($method, static function () use ($method): array {
    $tokenHash = bearerHash();
    $pdo = authDatabase();
    $account = requireAccount($pdo, $tokenHash);
    if ($account['role'] !== 'botani') {
        authError(403);
    }

    if ($method === 'POST') {
        $body = authBody();
        $fields = ['name' => 150, 'institution' => 150, 'province' => 100, 'city' => 100];
        if (!$body || array_diff(array_keys($body), array_keys($fields))) {
            authError(422);
        }
        $assignments = [];
        $values = [];
        foreach ($fields as $field => $limit) {
            if (array_key_exists($field, $body)) {
                $assignments[] = $field . ' = ?';
                $values[] = authText($body, $field, $limit);
            }
        }
        $values[] = $account['id'];
        $update = $pdo->prepare("UPDATE users SET " . implode(', ', $assignments) . " WHERE id = ? AND role = 'botani'");
        $update->execute($values);
    }

    $query = $pdo->prepare(
        "SELECT id, name, email, institution, province, city, is_verified,
         CASE WHEN is_verified = 1 THEN 'approved'
              WHEN verification_rejected_at IS NOT NULL THEN 'rejected'
              ELSE 'pending' END AS verification_status,
         DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at
         FROM users WHERE id = ? AND role = 'botani'"
    );
    $query->execute([$account['id']]);
    $profile = $query->fetch();
    if (!$profile) {
        authError(403);
    }
    $profile['is_verified'] = (int) $profile['is_verified'];
    return $profile;
});
