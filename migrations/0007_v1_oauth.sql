-- Single-use authorization codes and rotating refresh tokens share a replay ledger.
CREATE TABLE v1_oauth_code_uses (
  jti TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX v1_oauth_code_uses_expiry ON v1_oauth_code_uses(expires_at);
