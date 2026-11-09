<?php
declare(strict_types=1);
require_once dirname(__DIR__, 3) . '/lib/auth.php';
require_once dirname(__DIR__, 3) . '/lib/botanists.php';
authEndpoint('GET', static function (): array {
    $hash = bearerHash(); $pdo = authDatabase();
    requireAccount($pdo, $hash, 'petani');
    return botanistDirectory($pdo, false);
});
