<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

ini_set('display_errors', '0');
ini_set('log_errors', '0');
ini_set('zend.exception_ignore_args', '1');
require_once dirname(__DIR__) . '/lib/db.php';

$pdo = null;
$input = [];
$password = '';

try {
    if (count($argv) > 2 || (isset($argv[1]) && $argv[1] !== '--dry-run')) {
        throw new InvalidArgumentException('Use admin-account.ps1 to enter credentials interactively.');
    }
    $raw = stream_get_contents(STDIN, 8193);
    if ($raw === false || strlen($raw) > 8192) {
        throw new InvalidArgumentException('Invalid provisioning input.');
    }
    $input = json_decode($raw, true, 4, JSON_THROW_ON_ERROR);
    $raw = '';
    if (!is_array($input)) {
        throw new InvalidArgumentException('Invalid provisioning input.');
    }
    $email = $input['email'] ?? '';
    if (!is_string($email) || strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        throw new InvalidArgumentException('Enter a valid Admin email address.');
    }
    $email = strtolower($email);
    $mode = $input['mode'] ?? null;
    if (!in_array($mode, ['create', 'reset'], true)) {
        throw new InvalidArgumentException('Choose create or reset.');
    }
    $password = $input['new_password'] ?? null;
    if (!is_string($password) || strlen($password) < 8 || strlen($password) > 72 ||
        trim($password) === '' || str_contains($password, "\0")) {
        throw new InvalidArgumentException('The password must contain 8-72 UTF-8 bytes and no NUL characters.');
    }
    $settings = require dirname(__DIR__) . '/config/config.php';
    $database = $settings['database'];
    $parts = [];
    if (!str_starts_with($database['dsn'], 'mysql:')) {
        throw new InvalidArgumentException('Only the local MySQL configuration is supported.');
    }
    foreach (explode(';', substr($database['dsn'], 6)) as $part) {
        $pair = explode('=', $part, 2);
        if (count($pair) === 2) { $parts[trim($pair[0])] = trim($pair[1]); }
    }
    if (!in_array($parts['host'] ?? '', ['localhost', '127.0.0.1', '::1'], true)) {
        throw new InvalidArgumentException('Provisioning is restricted to a local MySQL host.');
    }
    if (!is_string($input['database_username'] ?? null) || trim($input['database_username']) === '' ||
        !is_string($input['database_password'] ?? null)) {
        throw new InvalidArgumentException('Enter a local database administration account.');
    }
    $database['username'] = $input['database_username'];
    $database['password'] = $input['database_password'];
    $pdo = openDatabase($database);
    $pdo->beginTransaction();
    $query = $pdo->prepare('SELECT id, role FROM users WHERE email = ? FOR UPDATE');
    $query->execute([$email]);
    $user = $query->fetch();
    if ($user && $user['role'] !== 'admin') {
        throw new InvalidArgumentException('That email belongs to a non-Admin account. It cannot be changed by this tool.');
    }
    if ($mode === 'create' && $user) {
        throw new InvalidArgumentException('That Admin already exists. Run without -Create to reset its password.');
    }
    if ($mode === 'reset' && !$user) {
        throw new InvalidArgumentException('No Admin exists at that email. Use -Create only to create a new Admin.');
    }
    $hash = password_hash($password, PASSWORD_DEFAULT);
    if ($mode === 'create') {
        $name = $input['name'] ?? null;
        if (!is_string($name) || trim($name) === '' || !mb_check_encoding($name, 'UTF-8') ||
            mb_strlen($name, 'UTF-8') > 150 || preg_match('/[\x00-\x1F\x7F]/', $name)) {
            throw new InvalidArgumentException('Enter a valid full name of at most 150 characters.');
        }
        $insert = $pdo->prepare("INSERT INTO users (name, email, password_hash, role, is_verified) VALUES (?, ?, ?, 'admin', 1)");
        $insert->execute([trim($name), $email, $hash]);
    } else {
        $update = $pdo->prepare("UPDATE users SET password_hash = ? WHERE id = ? AND role = 'admin'");
        $update->execute([$hash, $user['id']]);
        $revoke = $pdo->prepare('DELETE FROM auth_tokens WHERE user_id = ?');
        $revoke->execute([$user['id']]);
    }
    if (in_array('--dry-run', $argv, true)) {
        $pdo->rollBack();
        fwrite(STDOUT, "Checks passed for $email. Dry run rolled back all database writes.\n");
    } else {
        $pdo->commit();
        fwrite(STDOUT, "Admin password set for $email. Sign in at /admin-masuk.html.\n");
    }
} catch (InvalidArgumentException $error) {
    if ($pdo instanceof PDO && $pdo->inTransaction()) { $pdo->rollBack(); }
    fwrite(STDERR, $error->getMessage() . "\n");
    exit(1);
} catch (Throwable) {
    if ($pdo instanceof PDO && $pdo->inTransaction()) { $pdo->rollBack(); }
    fwrite(STDERR, "Provisioning failed. Check local MySQL access and privileges for users/password_hash and auth_tokens. No changes were committed.\n");
    exit(1);
} finally {
    $password = '';
    $input = [];
    unset($database, $settings, $hash);
}
