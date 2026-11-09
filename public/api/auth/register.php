<?php

declare(strict_types=1);

require_once dirname(__DIR__, 3) . '/lib/auth.php';

authEndpoint('POST', static function (): array {
    $body = authBody();
    $role = $body['role'] ?? null;
    if ($role === 'admin') {
        authError(403);
    }
    if (!in_array($role, ['petani', 'botani'], true)) {
        authError(422);
    }
    $name = authText($body, 'name', 150);
    $email = authEmail($body);
    $password = authPassword($body, 8);
    $license = $role === 'botani' ? authText($body, 'license_number', 100) : null;
    $institution = $role === 'botani' ? authText($body, 'institution', 150) : null;
    $province = $role === 'botani' ? authText($body, 'province', 100) : null;
    $city = $role === 'botani' ? authText($body, 'city', 100) : null;
    $pdo = authDatabase();
    $insert = $pdo->prepare(
        'INSERT INTO users (name, email, password_hash, role, license_number, is_verified, institution, province, city)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    try {
        $insert->execute([$name, $email, password_hash($password, PASSWORD_DEFAULT), $role, $license, $role === 'petani' ? 1 : 0, $institution, $province, $city]);
    } catch (PDOException $error) {
        if (($error->errorInfo[1] ?? null) === 1062) {
            authError(409);
        }
        throw $error;
    }
    return ['status' => 'ok'];
});
