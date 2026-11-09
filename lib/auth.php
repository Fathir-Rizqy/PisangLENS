<?php

declare(strict_types=1);

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/response.php';

function authError(int $status): never
{
    if ($status === 401) {
        header('WWW-Authenticate: Bearer');
    }
    respondJson(['status' => 'error'], $status);
}

function authEndpoint(string $method, callable $handler): never
{
    ini_set('display_errors', '0');
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== $method) {
        header('Allow: ' . $method);
        authError(405);
    }
    // Bearer credentials are never taken from cookies. Also reject browser cross-site requests.
    if (($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') {
        authError(403);
    }

    try {
        respondJson($handler());
    } catch (Throwable $error) {
        error_log('PisangLens auth failure (' . get_class($error) . ', ' . $error->getCode() . ').');
        authError(500);
    }
}

function authDatabase(): PDO
{
    $config = dirname(__DIR__) . '/config/config.php';
    if (!is_file($config)) {
        authError(503);
    }
    $settings = require $config;
    return openDatabase($settings['database']);
}

function authBody(int $maxBytes = 8192, bool $batch = false): array
{
    $contentType = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
    if ($contentType !== 'application/json') {
        authError(415);
    }
    $raw = file_get_contents('php://input', false, null, 0, $maxBytes + 1);
    if ($raw === false || strlen($raw) > $maxBytes) {
        authError(400);
    }
    try {
        $body = json_decode($raw, false, 8, JSON_THROW_ON_ERROR);
    } catch (JsonException) {
        authError(400);
    }
    if ($batch && is_array($body)) return $body;
    if (!$body instanceof stdClass || $batch) {
        authError(400);
    }
    return get_object_vars($body);
}

function authText(array $body, string $key, int $max): string
{
    $value = $body[$key] ?? null;
    if (!is_string($value)) {
        authError(422);
    }
    $value = trim($value);
    if ($value === '' || !mb_check_encoding($value, 'UTF-8') ||
        mb_strlen($value, 'UTF-8') > $max || preg_match('/[\x00-\x1F\x7F]/', $value)) {
        authError(422);
    }
    return $value;
}

function authEmail(array $body): string
{
    $email = strtolower(authText($body, 'email', 254));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        authError(422);
    }
    return $email;
}

function authPassword(array $body, int $minBytes = 1): string
{
    $password = $body['password'] ?? null;
    // PHP 8.3's default bcrypt hash accepts at most 72 bytes.
    if (!is_string($password) || strlen($password) < $minBytes || strlen($password) > 72 ||
        trim($password) === '' || str_contains($password, "\0")) {
        authError(422);
    }
    return $password;
}

function bearerToken(): string
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (!preg_match('/^Bearer ([a-f0-9]{64})$/iD', $header, $matches)) {
        authError(401);
    }
    return $matches[1];
}

function bearerHash(): string
{
    return hash('sha256', bearerToken());
}

function startAuthSession(?string $token = null): void
{
    $path = dirname(__DIR__) . '/storage/sessions';
    if (!is_dir($path) && !mkdir($path, 0700, true) && !is_dir($path)) {
        throw new RuntimeException('Session storage is unavailable.');
    }
    // The Bearer token carries the native session ID. Cookies and URL session IDs are disabled.
    session_save_path($path);
    session_id($token ?? bin2hex(random_bytes(32)));
    if (!session_start([
        'use_cookies' => false,
        'use_only_cookies' => false,
        'use_strict_mode' => true,
        'use_trans_sid' => false,
        'cache_limiter' => '',
        'sid_length' => 64,
        'sid_bits_per_character' => 4,
        'gc_maxlifetime' => 8 * 60 * 60,
    ])) {
        throw new RuntimeException('Session could not be started.');
    }
}

function checkAuthSession(array $user): void
{
    $token = bearerToken();
    startAuthSession($token);
    $valid = hash_equals($token, session_id()) &&
        (string) ($_SESSION['user_id'] ?? '') === (string) $user['id'] &&
        ($_SESSION['expires_at'] ?? 0) > time();
    session_write_close();
    if (!$valid) {
        authError(401);
    }
}

function requireAccount(PDO $pdo, string $tokenHash, ?string $role = null): array
{
    $query = $pdo->prepare(
        'SELECT users.id, users.role, users.is_verified FROM auth_tokens
         JOIN users ON users.id = auth_tokens.user_id
         WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP()'
    );
    $query->execute([$tokenHash]);
    $user = $query->fetch();
    if (!$user) {
        authError(401);
    }
    checkAuthSession($user);
    if ($role !== null && ($user['role'] !== $role || !(bool) $user['is_verified'])) {
        authError(403);
    }
    return $user;
}
