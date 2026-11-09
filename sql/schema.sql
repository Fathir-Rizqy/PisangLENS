-- Import into an existing PisangLens database.
CREATE TABLE users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('petani', 'botani', 'admin') NOT NULL,
    license_number VARCHAR(100) NULL,
    -- Registration explicitly sets verified for farmers and pending for botanists.
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    verification_rejected_at DATETIME NULL,
    institution VARCHAR(150) NULL,
    province VARCHAR(100) NULL,
    city VARCHAR(100) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE auth_tokens (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE scans (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    client_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    image_path VARCHAR(255) NOT NULL,
    predicted_class VARCHAR(64) NOT NULL,
    confidence_score DOUBLE NOT NULL CHECK (confidence_score BETWEEN 0 AND 1),
    prediction_source ENUM('mock', 'local', 'server') NOT NULL,
    model_version VARCHAR(100) NOT NULL,
    triage_phase VARCHAR(32) NULL,
    created_at DATETIME NOT NULL,
    synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, client_uuid),
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE consultations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    scan_id BIGINT UNSIGNED NOT NULL UNIQUE,
    petani_id BIGINT UNSIGNED NOT NULL,
    botani_id BIGINT UNSIGNED NULL,
    status ENUM('open', 'answered', 'closed') NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (scan_id) REFERENCES scans (id),
    FOREIGN KEY (petani_id) REFERENCES users (id),
    FOREIGN KEY (botani_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE chat_messages (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    consultation_id BIGINT UNSIGNED NOT NULL,
    sender_id BIGINT UNSIGNED NOT NULL,
    encrypted_message JSON NOT NULL,
    message_iv VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (consultation_id, id),
    UNIQUE KEY unique_ticket_iv (consultation_id, message_iv),
    FOREIGN KEY (consultation_id) REFERENCES consultations (id),
    FOREIGN KEY (sender_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
