<?php

declare(strict_types=1);

// Copy to config.php and fill in deployment-specific values locally.
return [
    'database' => [
        'dsn' => 'mysql:host=127.0.0.1;port=3306;dbname=pisanglens;charset=utf8mb4',
        'username' => null,
        'password' => null,
    ],
    'uploads_dir' => dirname(__DIR__) . '/storage/uploads',
    'chat_master_key_file' => dirname(__DIR__) . '/storage/chat-master.key',
];
