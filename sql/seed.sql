-- Set @admin_name, @admin_email, and @admin_password_hash in this MySQL
-- session before sourcing this file. Use PHP password_hash() to generate
-- the hash locally. Missing inputs leave the database unchanged.
INSERT INTO users (name, email, password_hash, role, is_verified)
SELECT @admin_name, @admin_email, @admin_password_hash, 'admin', TRUE
FROM DUAL
WHERE @admin_name <> '' AND @admin_email <> '' AND @admin_password_hash <> '';
