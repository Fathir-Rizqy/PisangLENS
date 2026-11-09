<?php

declare(strict_types=1);

function openDatabase(array $settings): PDO
{
    if (!isset($settings['dsn'], $settings['username'], $settings['password'])) {
        throw new RuntimeException('Database credentials have not been configured.');
    }

    try {
        $pdo = new PDO($settings['dsn'], $settings['username'], $settings['password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        $pdo->exec("SET time_zone = '+00:00'");
        return $pdo;
    } catch (PDOException $error) {
        throw new RuntimeException('Database connection failed.', 0, $error);
    }
}
