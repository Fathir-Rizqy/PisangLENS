<?php

declare(strict_types=1);

function ticketKey(string $id): string
{
    $settings = require dirname(__DIR__) . '/config/config.php';
    $path = $settings['chat_master_key_file'] ?? dirname(__DIR__) . '/storage/chat-master.key';
    $master = is_file($path) ? file_get_contents($path) : false;
    if ($master === false || strlen($master) !== 32) {
        throw new RuntimeException('Chat master key is unavailable.');
    }
    return hash_hkdf('sha256', $master, 32, 'pisanglens-consultation-v1', $id);
}
