CREATE TABLE IF NOT EXISTS rate_limit (
    scope        TEXT NOT NULL,
    identity     TEXT NOT NULL,
    window_start BIGINT NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
    PRIMARY KEY (scope, identity, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit(window_start);
