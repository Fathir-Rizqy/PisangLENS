-- Additive migration. Run once on an existing database; never re-import schema.sql.
CREATE TABLE IF NOT EXISTS retraining_queue (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    scan_id BIGINT UNSIGNED NOT NULL UNIQUE,
    consultation_id BIGINT UNSIGNED NOT NULL,
    original_label VARCHAR(64) NOT NULL,
    corrected_label VARCHAR(64) NULL,
    review_outcome ENUM('valid', 'undetermined', 'unusable') NOT NULL,
    reviewed_by BIGINT UNSIGNED NOT NULL,
    reviewed_at DATETIME NOT NULL,
    review_note VARCHAR(2000) NOT NULL,
    status ENUM('pending', 'approved', 'rejected') NOT NULL,
    approved_by BIGINT UNSIGNED NULL,
    decided_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (status, review_outcome),
    CHECK (review_outcome != 'valid' OR (corrected_label IS NOT NULL AND corrected_label IN ('Healthy', 'Pestalotiopsis Leaf Blight', 'Sigatoka', 'Cordana Leaf Spot'))),
    CHECK (status != 'approved' OR (review_outcome = 'valid' AND corrected_label IS NOT NULL AND approved_by IS NOT NULL AND decided_at IS NOT NULL)),
    FOREIGN KEY (scan_id) REFERENCES scans(id),
    FOREIGN KEY (consultation_id) REFERENCES consultations(id),
    FOREIGN KEY (reviewed_by) REFERENCES users(id),
    FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
