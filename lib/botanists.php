<?php
declare(strict_types=1);

function botanistDirectory(PDO $pdo, bool $admin): array
{
    $where = ['role = ?'];
    $args = ['botani'];
    if (!$admin) $where[] = 'is_verified = 1';
    foreach (['province', 'city'] as $field) {
        if (isset($_GET[$field]) && $_GET[$field] !== '') {
            if (!is_string($_GET[$field]) || mb_strlen($_GET[$field]) > 100) authError(422);
            $where[] = "$field = ?";
            $args[] = $_GET[$field];
        }
    }
    if ($admin && isset($_GET['status']) && $_GET['status'] !== '') {
        $statuses = ['approved' => 'is_verified = 1', 'pending' => 'is_verified = 0 AND verification_rejected_at IS NULL', 'rejected' => 'is_verified = 0 AND verification_rejected_at IS NOT NULL'];
        if (!is_string($_GET['status']) || !isset($statuses[$_GET['status']])) authError(422);
        $where[] = '(' . $statuses[$_GET['status']] . ')';
    }
    $columns = 'id, name, institution, province, city';
    if ($admin) $columns .= ", DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at, CASE WHEN is_verified = 1 THEN 'approved' WHEN verification_rejected_at IS NOT NULL THEN 'rejected' ELSE 'pending' END AS verification_status";
    $query = $pdo->prepare('SELECT ' . $columns . ' FROM users WHERE ' . implode(' AND ', $where) . ' ORDER BY name, id');
    $query->execute($args);
    return $query->fetchAll();
}
