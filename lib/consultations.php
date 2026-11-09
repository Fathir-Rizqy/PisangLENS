<?php

declare(strict_types=1);

require_once __DIR__ . '/auth.php';

const LEAF_CLASSES = ['Healthy', 'Pestalotiopsis Leaf Blight', 'Sigatoka', 'Cordana Leaf Spot'];

function objectId(mixed $id): string
{
    if ((!is_int($id) && !is_string($id)) || !preg_match('/^[1-9][0-9]{0,18}$/D', (string) $id)) {
        authError(422);
    }
    return (string) $id;
}

function consultationEligible(array $scan): bool
{
    return (float) $scan['confidence_score'] < 0.8 ||
        (in_array($scan['predicted_class'], LEAF_CLASSES, true) && $scan['predicted_class'] !== 'Healthy');
}

function participantTicket(PDO $pdo, array $user, string $id, bool $lock = false): array
{
    $query = $pdo->prepare('SELECT * FROM consultations WHERE id = ?' . ($lock ? ' FOR UPDATE' : ''));
    $query->execute([$id]);
    $ticket = $query->fetch();
    $farmer = $ticket && $user['role'] === 'petani' && (string) $ticket['petani_id'] === (string) $user['id'];
    $botanist = $ticket && $user['role'] === 'botani' && (bool) $user['is_verified'] &&
        (string) $ticket['botani_id'] === (string) $user['id'];
    if (!$farmer && !$botanist) {
        authError(403);
    }
    return $ticket;
}
