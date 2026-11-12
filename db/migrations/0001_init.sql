-- =====================================================================
-- Autonomous Buyer OS — relational schema (v1.0.0)
-- Stage 2 artifact. Owner: srd-v2. Requirement mapping: traceability.csv
-- columns 6 (data_entities).
--
-- Dialect: SQLite-compatible DDL, which is what the pipeline verifier loads
-- (python sqlite3). Production target is Render Postgres; srd.md §4.8 lists
-- the six constructs that change in the port (STRICT tables, partial-index
-- syntax is identical, triggers become plpgsql, grants replace triggers for
-- R-034, JSONB replaces TEXT+json_valid, TIMESTAMPTZ replaces ISO text).
--
-- Invariants that this file *enforces* rather than documents:
--   I1  money is INTEGER minor units + ISO-4217; no REAL column exists;
--   I2  verdict / verdict_clause / audit_event are append-only (triggers);
--   I3  no purchase authorization row may exist while its browser session is
--       still open (trigger, R-084 / T-084);
--   I4  a purchase authorization cannot reach CAPTURED without a stored
--       verdict for that checkout (trigger, R-004 / R-011);
--   I5  captured_minor <= amount_minor and captured_minor <= redeemed_minor
--       accounting (CHECK constraints, R-076 / R-090);
--   I6  one OPEN escalation per verdict, one OPEN browser session per
--       checkout, one OPEN negotiation per checkout (partial unique indexes);
--   I7  an offer's stored total equals qty*unit+shipping (CHECK, R-066);
--   I8  a checkout row cannot point at a mandate of a different principal
--       (trigger, tenancy boundary).
-- =====================================================================

-- ---------------------------------------------------------------- principal
CREATE TABLE IF NOT EXISTS principal (
    id                TEXT PRIMARY KEY,
    email             TEXT NOT NULL UNIQUE,
    display_name      TEXT NOT NULL,
    account_currency  TEXT NOT NULL DEFAULT 'USD'
                      CHECK (account_currency ~ '^[A-Z]{3}$'),
    paypal_payer_id   TEXT,
    paypal_vault_id   TEXT,
    vault_status      TEXT NOT NULL DEFAULT 'NONE'
                      CHECK (vault_status IN ('NONE','SETUP_PENDING','ACTIVE','REVOKED')),
    vault_updated_at  TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (email LIKE '%_@_%')
);

CREATE TABLE IF NOT EXISTS principal_key (
    id            TEXT PRIMARY KEY,
    principal_id  TEXT NOT NULL REFERENCES principal(id) ON DELETE RESTRICT,
    jwk JSONB NOT NULL,
    thumbprint    TEXT NOT NULL UNIQUE,
    alg           TEXT NOT NULL DEFAULT 'ES256' CHECK (alg = 'ES256'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_principal_key_principal ON principal_key(principal_id);

-- ---------------------------------------------------------------- agent
CREATE TABLE IF NOT EXISTS agent (
    id               TEXT PRIMARY KEY,
    principal_id     TEXT NOT NULL REFERENCES principal(id) ON DELETE RESTRICT,
    display_name     TEXT NOT NULL,
    key_thumbprint   TEXT NOT NULL UNIQUE,
    status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
    last_seen_at     TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_principal_status ON agent(principal_id, status);

-- ---------------------------------------------------------------- merchant
CREATE TABLE IF NOT EXISTS merchant (
    id                  TEXT PRIMARY KEY,
    domain              TEXT NOT NULL UNIQUE,
    display_name        TEXT NOT NULL,
    paypal_merchant_id  TEXT,
    key_thumbprint      TEXT UNIQUE,
    execution_class     TEXT NOT NULL
                        CHECK (execution_class IN ('API_HOLD','GATED_CLICK','HANDOFF')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchant_class ON merchant(execution_class);

CREATE TABLE IF NOT EXISTS merchant_policy (
    id                   TEXT PRIMARY KEY,
    merchant_id          TEXT NOT NULL REFERENCES merchant(id) ON DELETE RESTRICT,
    sku                  TEXT NOT NULL,
    list_price_minor     INTEGER NOT NULL CHECK (list_price_minor > 0),
    floor_price_minor    INTEGER NOT NULL CHECK (floor_price_minor > 0),
    max_discount_bp      INTEGER NOT NULL CHECK (max_discount_bp BETWEEN 0 AND 10000),
    min_qty              INTEGER NOT NULL DEFAULT 1 CHECK (min_qty >= 1),
    max_qty              INTEGER NOT NULL CHECK (max_qty >= 1),
    allow_free_shipping  INTEGER NOT NULL DEFAULT 0 CHECK (allow_free_shipping IN (0,1)),
    max_rounds           INTEGER NOT NULL DEFAULT 6 CHECK (max_rounds BETWEEN 1 AND 10),
    version              TEXT NOT NULL,
    signature            TEXT NOT NULL,
    valid_from           INTEGER NOT NULL,
    valid_to             INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (floor_price_minor <= list_price_minor),
    CHECK (min_qty <= max_qty),
    CHECK (valid_to > valid_from),
    UNIQUE (merchant_id, sku, version)
);

CREATE INDEX IF NOT EXISTS idx_policy_lookup ON merchant_policy(merchant_id, sku, valid_to);

-- ---------------------------------------------------------------- mandate
CREATE TABLE IF NOT EXISTS mandate (
    id                      TEXT PRIMARY KEY,
    principal_id            TEXT NOT NULL REFERENCES principal(id) ON DELETE RESTRICT,
    agent_id                TEXT NOT NULL REFERENCES agent(id) ON DELETE RESTRICT,
    vct                     TEXT NOT NULL DEFAULT 'mandate.checkout.open.1'
                            CHECK (vct = 'mandate.checkout.open.1'),
    version                 INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    prev_version_id         TEXT REFERENCES mandate(id),
    status                  TEXT NOT NULL DEFAULT 'DRAFT'
                            CHECK (status IN ('DRAFT','ACTIVE','REVOKED','EXPIRED')),
    currency                TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    purchase_total_minor    INTEGER NOT NULL CHECK (purchase_total_minor BETWEEN 1 AND 5000000),
    per_txn_minor           INTEGER NOT NULL CHECK (per_txn_minor >= 1),
    max_txns                INTEGER NOT NULL CHECK (max_txns BETWEEN 1 AND 20),
    meter_total_minor       INTEGER NOT NULL DEFAULT 0 CHECK (meter_total_minor BETWEEN 0 AND 50000),
    meter_per_call_minor    INTEGER NOT NULL DEFAULT 0 CHECK (meter_per_call_minor BETWEEN 0 AND 5000),
    meter_max_calls         INTEGER NOT NULL DEFAULT 0 CHECK (meter_max_calls BETWEEN 0 AND 500),
    unknown_attribute_policy TEXT NOT NULL DEFAULT 'escalate'
                            CHECK (unknown_attribute_policy IN ('deny','escalate','allow')),
    constraints JSONB NOT NULL,
    nonce                   TEXT NOT NULL CHECK (length(nonce) BETWEEN 16 AND 64),
    iat_epoch               INTEGER NOT NULL,
    exp_epoch               INTEGER NOT NULL,
    signature               TEXT,
    signed_payload_sha256   TEXT CHECK (signed_payload_sha256 IS NULL
                                        OR length(signed_payload_sha256) = 64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at              TEXT,
    CHECK (exp_epoch > iat_epoch),
    CHECK (exp_epoch - iat_epoch <= 2592000),           -- 30-day ceiling, ENFORCED
    CHECK (per_txn_minor <= purchase_total_minor),
    CHECK (meter_per_call_minor <= meter_total_minor OR meter_total_minor = 0),
    CHECK (status <> 'ACTIVE' OR signature IS NOT NULL),
    CHECK (status <> 'REVOKED' OR revoked_at IS NOT NULL),
    UNIQUE (principal_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_mandate_status_exp ON mandate(status, exp_epoch);
CREATE INDEX IF NOT EXISTS idx_mandate_agent ON mandate(agent_id, status);

CREATE TABLE IF NOT EXISTS mandate_clause (
    id          TEXT PRIMARY KEY,
    mandate_id  TEXT NOT NULL REFERENCES mandate(id) ON DELETE CASCADE,
    clause_key  TEXT NOT NULL,
    expression JSONB NOT NULL,
    human_text  TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (mandate_id, clause_key)
);

-- Mutable counters live here, never on the mandate row, so the signed payload
-- and the spend ledger cannot be confused (R-003, R-072).
CREATE TABLE IF NOT EXISTS mandate_usage (
    mandate_id                TEXT PRIMARY KEY REFERENCES mandate(id) ON DELETE CASCADE,
    purchase_committed_minor  INTEGER NOT NULL DEFAULT 0 CHECK (purchase_committed_minor >= 0),
    txns_used                 INTEGER NOT NULL DEFAULT 0 CHECK (txns_used >= 0),
    meter_debited_minor       INTEGER NOT NULL DEFAULT 0 CHECK (meter_debited_minor >= 0),
    meter_calls_used          INTEGER NOT NULL DEFAULT 0 CHECK (meter_calls_used >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- negotiation
CREATE TABLE IF NOT EXISTS negotiation_session (
    id           TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principal(id) ON DELETE RESTRICT,
    merchant_id  TEXT NOT NULL REFERENCES merchant(id) ON DELETE RESTRICT,
    checkout_id  TEXT UNIQUE,            -- NULL until the buyer requests checkout
    sku          TEXT NOT NULL,
    qty          INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 10),
    policy_id    TEXT NOT NULL REFERENCES merchant_policy(id),
    status       TEXT NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN','AGREED','DECLINED','EXPIRED')),
    rounds       INTEGER NOT NULL DEFAULT 0 CHECK (rounds >= 0),
    round_cap    INTEGER NOT NULL DEFAULT 6 CHECK (round_cap BETWEEN 1 AND 10),
    deadline_at  INTEGER NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at    TIMESTAMPTZ,
    CHECK (rounds <= round_cap)
);

CREATE INDEX IF NOT EXISTS idx_negotiation_open ON negotiation_session(status, deadline_at);

CREATE TABLE IF NOT EXISTS negotiation_turn (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL REFERENCES negotiation_session(id) ON DELETE CASCADE,
    round_no       INTEGER NOT NULL CHECK (round_no >= 1),
    actor          TEXT NOT NULL CHECK (actor IN ('BUYER','SELLER')),
    message        TEXT NOT NULL,
    price_minor    INTEGER CHECK (price_minor IS NULL OR price_minor > 0),
    qty             INTEGER CHECK (qty IS NULL OR qty >= 1),
    ask_discount_bp INTEGER CHECK (ask_discount_bp IS NULL
                                   OR ask_discount_bp BETWEEN 0 AND 10000),
    claim_verdict   TEXT CHECK (claim_verdict IS NULL
                                OR claim_verdict IN ('SUPPORTED','REJECTED','NONE')),
    concessions JSONB,
    guard_result   TEXT NOT NULL CHECK (guard_result IN ('OK','CLAMPED','REJECTED')),
    model_used     INTEGER NOT NULL DEFAULT 0 CHECK (model_used IN (0,1)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, round_no, actor)
);

CREATE INDEX IF NOT EXISTS idx_turn_session ON negotiation_turn(session_id, round_no);

CREATE TABLE IF NOT EXISTS offer (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL UNIQUE REFERENCES negotiation_session(id) ON DELETE RESTRICT,
    principal_id      TEXT NOT NULL REFERENCES principal(id) ON DELETE RESTRICT,
    merchant_id       TEXT NOT NULL REFERENCES merchant(id) ON DELETE RESTRICT,
    policy_id         TEXT NOT NULL REFERENCES merchant_policy(id) ON DELETE RESTRICT,
    sku               TEXT NOT NULL,
    qty               INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 10),
    unit_price_minor  INTEGER NOT NULL CHECK (unit_price_minor > 0),
    shipping_minor    INTEGER NOT NULL DEFAULT 0 CHECK (shipping_minor >= 0),
    total_minor       INTEGER NOT NULL CHECK (total_minor > 0),
    currency          TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    free_shipping     INTEGER NOT NULL DEFAULT 0 CHECK (free_shipping IN (0,1)),
    policy_version    TEXT NOT NULL,
    cart_hash         TEXT CHECK (cart_hash IS NULL
                                  OR cart_hash ~ '^sha256:[0-9a-f]{64}$'),
    nonce             TEXT NOT NULL UNIQUE,
    iat_epoch         INTEGER NOT NULL,
    exp_epoch         INTEGER NOT NULL,
    signature         TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'SIGNED'
                      CHECK (status IN ('SIGNED','CONSUMED','EXPIRED','REVOKED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (total_minor = qty * unit_price_minor + shipping_minor),
    CHECK (exp_epoch > iat_epoch),
    CHECK (free_shipping = 0 OR shipping_minor = 0)
);

CREATE INDEX IF NOT EXISTS idx_offer_exp ON offer(status, exp_epoch);

-- ---------------------------------------------------------------- checkout
CREATE TABLE IF NOT EXISTS checkout (
    id               TEXT PRIMARY KEY,
    principal_id     TEXT NOT NULL REFERENCES principal(id) ON DELETE RESTRICT,
    mandate_id       TEXT NOT NULL REFERENCES mandate(id) ON DELETE RESTRICT,
    merchant_id      TEXT REFERENCES merchant(id),
    merchant_domain  TEXT NOT NULL,
    request_key      TEXT NOT NULL CHECK (length(request_key) BETWEEN 16 AND 64),
    cart_hash        TEXT CHECK (cart_hash IS NULL OR cart_hash ~ '^sha256:[0-9a-f]{64}$'),
    offer_id         TEXT REFERENCES offer(id),
    total_minor      INTEGER CHECK (total_minor IS NULL OR total_minor > 0),
    currency         TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    execution_class  TEXT NOT NULL DEFAULT 'API_HOLD'
                     CHECK (execution_class IN ('API_HOLD','GATED_CLICK','HANDOFF')),
    status           TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','AUTHORIZED','DECIDED','SETTLE_PENDING',
                                       'SETTLED','FAILED_PAYPAL','NEEDS_ATTENTION','ABANDONED')),
    attention_reason TEXT,
    correlation_id   TEXT NOT NULL UNIQUE,
    settled_at       TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (mandate_id, request_key),
    CHECK (status NOT IN ('DECIDED','SETTLE_PENDING','SETTLED') OR cart_hash IS NOT NULL),
    CHECK (status NOT IN ('AUTHORIZED','DECIDED','SETTLE_PENDING','SETTLED')
           OR total_minor IS NOT NULL),
    CHECK (status <> 'NEEDS_ATTENTION' OR attention_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_checkout_cart ON checkout(cart_hash);
CREATE INDEX IF NOT EXISTS idx_checkout_status_created ON checkout(status, created_at);
CREATE INDEX IF NOT EXISTS idx_checkout_principal ON checkout(principal_id, created_at);

-- I8: tenancy boundary. A checkout may only reference a mandate owned by the
-- same principal; the database refuses the row rather than trusting the service.

CREATE TABLE IF NOT EXISTS meter_session (
    id               TEXT PRIMARY KEY,
    principal_id     TEXT NOT NULL REFERENCES principal(id) ON DELETE RESTRICT,
    mandate_id       TEXT NOT NULL REFERENCES mandate(id) ON DELETE RESTRICT,
    checkout_id      TEXT UNIQUE REFERENCES checkout(id),
    currency         TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    authorized_minor INTEGER NOT NULL CHECK (authorized_minor >= 0),
    debited_minor    INTEGER NOT NULL DEFAULT 0 CHECK (debited_minor >= 0),
    redeemed_minor   INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_minor >= 0),
    released_minor   INTEGER NOT NULL DEFAULT 0 CHECK (released_minor >= 0),
    captured_minor   INTEGER NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
    voided_minor     INTEGER NOT NULL DEFAULT 0 CHECK (voided_minor >= 0),
    status           TEXT NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN','CLOSING','CLOSED','FAILED','RECONCILE_BLOCKED')),
    close_key        TEXT,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_debit_at    TIMESTAMPTZ,
    closed_at        TIMESTAMPTZ,
    CHECK (captured_minor <= authorized_minor),
    CHECK (redeemed_minor <= debited_minor),
    CHECK (debited_minor <= authorized_minor),
    CHECK (captured_minor <= redeemed_minor),
    CHECK (voided_minor + captured_minor <= authorized_minor),
    CHECK (status <> 'CLOSED' OR (captured_minor = redeemed_minor AND closed_at IS NOT NULL)),
    CHECK (status <> 'CLOSED' OR captured_minor + voided_minor = authorized_minor)
);

CREATE INDEX IF NOT EXISTS idx_meter_status ON meter_session(status, opened_at);
CREATE INDEX IF NOT EXISTS idx_meter_mandate ON meter_session(mandate_id, status);

CREATE TABLE IF NOT EXISTS paypal_authorization (
    id                TEXT PRIMARY KEY,
    purpose           TEXT NOT NULL CHECK (purpose IN ('PURCHASE','METER')),
    checkout_id       TEXT REFERENCES checkout(id) ON DELETE RESTRICT,
    meter_session_id  TEXT REFERENCES meter_session(id) ON DELETE RESTRICT,
    order_id          TEXT NOT NULL UNIQUE,
    authorization_id  TEXT UNIQUE,
    amount_minor      INTEGER NOT NULL CHECK (amount_minor > 0),
    currency          TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    captured_minor    INTEGER NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
    status            TEXT NOT NULL DEFAULT 'CREATED'
                      CHECK (status IN ('CREATED','AUTHORIZED','CAPTURED',
                                        'PARTIALLY_CAPTURED','VOIDED','EXPIRED')),
    expires_at        INTEGER,
    final_capture     INTEGER NOT NULL DEFAULT 1 CHECK (final_capture IN (0,1)),
    idempotency_key   TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (captured_minor <= amount_minor),
    CHECK ((purpose = 'PURCHASE' AND checkout_id IS NOT NULL AND meter_session_id IS NULL)
        OR (purpose = 'METER'    AND meter_session_id IS NOT NULL AND checkout_id IS NULL)),
    CHECK (status <> 'CAPTURED' OR captured_minor > 0),
    CHECK (status <> 'PARTIALLY_CAPTURED' OR captured_minor > 0),
    CHECK (status NOT IN ('CREATED','AUTHORIZED','EXPIRED') OR captured_minor = 0)
);

CREATE INDEX IF NOT EXISTS idx_auth_status_exp ON paypal_authorization(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_checkout ON paypal_authorization(checkout_id);

-- I3 (R-084): the browser must be gone before a purchase authorization exists.

-- I4 (R-004/R-011): no purchase capture without a stored verdict.
-- Both entry points are covered: an INSERT that arrives already captured (the
-- shape a replay or a hand-written migration would take) and an UPDATE.

-- ---------------------------------------------------------------- verdict
CREATE TABLE IF NOT EXISTS verdict (
    id              TEXT PRIMARY KEY,
    checkout_id     TEXT NOT NULL UNIQUE REFERENCES checkout(id) ON DELETE RESTRICT,
    decision        TEXT NOT NULL CHECK (decision IN ('CAPTURE','VOID','ESCALATE')),
    reason_codes    JSONB NOT NULL CHECK (jsonb_typeof(reason_codes) = 'array'),
    evidence_hash   TEXT NOT NULL CHECK (length(evidence_hash) = 64),
    mandate_version INTEGER NOT NULL,
    offer_id        TEXT,
    policy_version  TEXT,
    auditor_version TEXT NOT NULL,
    latency_us      INTEGER NOT NULL CHECK (latency_us >= 0),
    correlation_id  TEXT NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    bench_version   TEXT,
    CHECK (decision = 'CAPTURE' OR jsonb_array_length(reason_codes) >= 1)
);

CREATE INDEX IF NOT EXISTS idx_verdict_decision ON verdict(decision, decided_at);
CREATE INDEX IF NOT EXISTS idx_verdict_hash ON verdict(evidence_hash);

CREATE TABLE IF NOT EXISTS verdict_clause (
    id          TEXT PRIMARY KEY,
    verdict_id  TEXT NOT NULL REFERENCES verdict(id) ON DELETE RESTRICT,
    clause_key  TEXT NOT NULL,
    clause_id   TEXT,
    expression JSONB NOT NULL,
    observed JSONB,
    source      TEXT NOT NULL
                CHECK (source IN ('catalog','merchant_claim_untrusted','absent','offer:accepted')),
    result      TEXT NOT NULL CHECK (result IN ('PASS','FAIL','UNKNOWN')),
    code        TEXT CHECK (code IS NULL OR code ~ '^MV-R[0-9]{3}$'),
    UNIQUE (verdict_id, clause_key),
    CHECK ((result = 'UNKNOWN') = (source IN ('absent','merchant_claim_untrusted'))
           OR result = 'PASS' OR result = 'FAIL')
);

CREATE INDEX IF NOT EXISTS idx_clause_verdict ON verdict_clause(verdict_id, result);

CREATE TABLE IF NOT EXISTS escalation (
    id                  TEXT PRIMARY KEY,
    verdict_id          TEXT NOT NULL REFERENCES verdict(id) ON DELETE RESTRICT,
    status              TEXT NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('OPEN','APPROVED','DECLINED','EXPIRED')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          INTEGER NOT NULL,
    approval_signature  TEXT,
    signed_payload_sha256 TEXT,
    approved_by_key_id  TEXT REFERENCES principal_key(id),
    decline_reason      TEXT,
    decided_at          TIMESTAMPTZ,
    CHECK (status <> 'APPROVED' OR (approval_signature IS NOT NULL
                                    AND approved_by_key_id IS NOT NULL)),
    CHECK (status <> 'DECLINED' OR decline_reason IS NOT NULL),
    CHECK (status = 'OPEN' OR decided_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_escalation_open
    ON escalation(verdict_id) WHERE status = 'OPEN';

-- ---------------------------------------------------------------- catalogue
CREATE TABLE IF NOT EXISTS catalog_snapshot (
    id               TEXT PRIMARY KEY,
    verdict_id       TEXT NOT NULL REFERENCES verdict(id) ON DELETE RESTRICT,
    product_id       TEXT NOT NULL,
    merchant_domain  TEXT NOT NULL,
    sku              TEXT,
    attrs JSONB NOT NULL,
    price_minor      INTEGER CHECK (price_minor IS NULL OR price_minor >= 0),
    currency         TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    source           TEXT NOT NULL CHECK (source IN ('live','cache','fixture')),
    record_hash      TEXT NOT NULL CHECK (length(record_hash) = 64),
    fetched_at       TIMESTAMPTZ NOT NULL,
    UNIQUE (verdict_id, product_id)
);

-- ---------------------------------------------------------------- browser
CREATE TABLE IF NOT EXISTS browser_session (
    id                  TEXT PRIMARY KEY,
    checkout_id         TEXT NOT NULL REFERENCES checkout(id) ON DELETE RESTRICT,
    principal_id        TEXT NOT NULL REFERENCES principal(id) ON DELETE RESTRICT,
    kernel_session_id   TEXT NOT NULL UNIQUE,
    live_view_url       TEXT,
    replay_url          TEXT,
    egress_allowlist JSONB NOT NULL,
    status              TEXT NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('OPEN','DELETING','DELETED','FAILED')),
    timeout_s           INTEGER NOT NULL DEFAULT 300 CHECK (timeout_s BETWEEN 30 AND 300),
    step_script_version TEXT NOT NULL,
    sealed_cart_hash    TEXT CHECK (sealed_cart_hash IS NULL
                                    OR (sealed_cart_hash ~ '^sha256:[0-9a-f]{64}$')),
    sealed_total_minor  INTEGER CHECK (sealed_total_minor IS NULL OR sealed_total_minor > 0),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,
    CHECK (status <> 'DELETED' OR deleted_at IS NOT NULL)
);

-- I6: at most one live session per checkout; retries create new rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_browser_open
    ON browser_session(checkout_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_browser_checkout ON browser_session(checkout_id, opened_at);

CREATE TABLE IF NOT EXISTS browser_step (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES browser_session(id) ON DELETE CASCADE,
    step_index      INTEGER NOT NULL CHECK (step_index >= 0),
    action          TEXT NOT NULL
                    CHECK (action IN ('click','type','select','scroll','extract','seal')),
    selector        TEXT,
    value_hash      TEXT,
    result          TEXT NOT NULL CHECK (result IN ('OK','FALLBACK','STOPPED','REFUSED')),
    screenshot_hash TEXT,
    fallback_used   INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0,1)),
    http_status     INTEGER,
    duration_ms     INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_step_result ON browser_step(result);

CREATE TABLE IF NOT EXISTS shipping_profile (
    id          TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL UNIQUE REFERENCES principal(id) ON DELETE CASCADE,
    ciphertext  TEXT NOT NULL,
    key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- meter

CREATE TABLE IF NOT EXISTS meter_entry (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES meter_session(id) ON DELETE RESTRICT,
    entry_no    INTEGER NOT NULL CHECK (entry_no >= 1),
    call_hash   TEXT NOT NULL,
    price_minor INTEGER NOT NULL CHECK (price_minor > 0),
    voucher_id  TEXT,                             -- FK added below (circular with voucher)
    state       TEXT NOT NULL DEFAULT 'DEBITED'
                CHECK (state IN ('DEBITED','REDEEMED','EXPIRED','CAPTURED','RELEASED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at  TIMESTAMPTZ,
    UNIQUE (session_id, entry_no)
);

-- The same call may be retried and debited again (T-074), so call_hash is
-- indexed, not unique; the unique key is the per-session entry sequence.
CREATE INDEX IF NOT EXISTS idx_entry_call ON meter_entry(session_id, call_hash);
CREATE INDEX IF NOT EXISTS idx_entry_state ON meter_entry(state);

CREATE TABLE IF NOT EXISTS voucher (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES meter_session(id) ON DELETE RESTRICT,
    entry_id     TEXT NOT NULL UNIQUE REFERENCES meter_entry(id) ON DELETE RESTRICT,
    nonce        TEXT NOT NULL UNIQUE,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    currency     TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    call_hash    TEXT NOT NULL,
    exp_epoch    INTEGER NOT NULL,
    signature    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'ISSUED'
                 CHECK (status IN ('ISSUED','REDEEMED','EXPIRED','VOID')),
    redeemed_at  TIMESTAMPTZ,
    redeemed_by  TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (status <> 'REDEEMED' OR redeemed_at IS NOT NULL)
);

ALTER TABLE meter_entry
    ADD CONSTRAINT fk_entry_voucher FOREIGN KEY (voucher_id) REFERENCES voucher(id);

CREATE INDEX IF NOT EXISTS idx_voucher_exp ON voucher(status, exp_epoch);

-- A voucher must be worth exactly the price the meter debited for that entry.

-- ---------------------------------------------------------------- evidence
CREATE TABLE IF NOT EXISTS evidence_bundle (
    id                TEXT PRIMARY KEY,
    verdict_id        TEXT NOT NULL REFERENCES verdict(id) ON DELETE RESTRICT,
    dispute_id        TEXT,
    hash              TEXT NOT NULL CHECK (length(hash) = 64),
    storage_uri       TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','QUEUED','SUBMITTED','REJECTED')),
    attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at   INTEGER,
    submitted_at      TIMESTAMPTZ,
    provider_response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (verdict_id, dispute_id)
);

CREATE INDEX IF NOT EXISTS idx_bundle_status ON evidence_bundle(status, next_attempt_at);

-- ---------------------------------------------------------------- audit
CREATE TABLE IF NOT EXISTS audit_event (
    id            TEXT PRIMARY KEY,
    actor         TEXT NOT NULL,
    actor_role    TEXT NOT NULL
                  CHECK (actor_role IN ('principal','agent','merchant','operator','service')),
    action        TEXT NOT NULL,
    subject_type  TEXT NOT NULL,
    subject_id    TEXT NOT NULL,
    correlation_id TEXT,
    payload JSONB,
    payload_hash  TEXT NOT NULL CHECK (length(payload_hash) = 64),
    prev_hash     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_event(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_event(created_at);

-- ---------------------------------------------------------------- platform
CREATE TABLE IF NOT EXISTS benchmark_run (
    id           TEXT PRIMARY KEY,
    commit_sha   TEXT NOT NULL,
    bench_version TEXT NOT NULL,
    ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    cases        INTEGER NOT NULL CHECK (cases > 0),
    violations   INTEGER NOT NULL CHECK (violations >= 0),
    recall       REAL NOT NULL CHECK (recall BETWEEN 0 AND 1),
    specificity  REAL NOT NULL CHECK (specificity BETWEEN 0 AND 1),
    p95_ms       REAL NOT NULL CHECK (p95_ms >= 0),
    results_hash TEXT NOT NULL CHECK (length(results_hash) = 64)
);

CREATE INDEX IF NOT EXISTS idx_bench_ran ON benchmark_run(ran_at);

CREATE TABLE IF NOT EXISTS idempotency_record (
    id            TEXT PRIMARY KEY,
    scope         TEXT NOT NULL,
    key           TEXT NOT NULL,
    request_hash  TEXT NOT NULL,
    response_code INTEGER,
    response_body JSONB,
    checkout_id   TEXT REFERENCES checkout(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    INTEGER NOT NULL,
    UNIQUE (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_idem_expiry ON idempotency_record(expires_at);

CREATE TABLE IF NOT EXISTS webhook_event (
    id                 TEXT PRIMARY KEY,      -- PayPal event id (dedupe key)
    event_type         TEXT NOT NULL,
    resource_type      TEXT NOT NULL,
    resource_id        TEXT NOT NULL,
    transmission_id    TEXT,
    signature_verified INTEGER NOT NULL DEFAULT 0 CHECK (signature_verified IN (0,1)),
    status             TEXT NOT NULL DEFAULT 'RECEIVED'
                       CHECK (status IN ('RECEIVED','PROCESSED','IGNORED','FAILED')),
    attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    payload_hash       TEXT NOT NULL CHECK (length(payload_hash) = 64),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_resource ON webhook_event(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_webhook_status ON webhook_event(status, received_at);

-- ---------------------------------------------------------------- append-only
-- R-034 / T-034. Grants do this in Postgres; the SQLite-compatible artifact
-- carries the same rule as triggers so the property is testable on any engine.

-- ---------------------------------------------------------------- read model
-- One row per checkout, joined across the four components. Backs the cockpit
-- grid and the timeline (R-012, R-080, R-082). Justified as a view, not a
-- materialised table: at demo scale the whole table is a few thousand rows and
-- a view cannot drift from the money tables (ADR-008).
CREATE OR REPLACE VIEW v_checkout_timeline AS
SELECT
    c.id                AS checkout_id,
    c.principal_id      AS principal_id,
    c.mandate_id        AS mandate_id,
    c.merchant_domain   AS merchant_domain,
    c.status            AS checkout_status,
    c.execution_class   AS execution_class,
    c.total_minor       AS total_minor,
    c.currency          AS currency,
    c.correlation_id    AS correlation_id,
    c.created_at        AS created_at,
    c.settled_at        AS settled_at,
    v.id                AS verdict_id,
    v.decision          AS decision,
    v.reason_codes      AS reason_codes,
    v.evidence_hash     AS evidence_hash,
    v.decided_at        AS decided_at,
    v.latency_us        AS latency_us,
    (SELECT a.authorization_id FROM paypal_authorization a
      WHERE a.checkout_id = c.id AND a.purpose = 'PURCHASE'
      ORDER BY a.created_at DESC LIMIT 1) AS authorization_id,
    (SELECT a.status FROM paypal_authorization a
      WHERE a.checkout_id = c.id AND a.purpose = 'PURCHASE'
      ORDER BY a.created_at DESC LIMIT 1) AS authorization_status,
    (SELECT a.captured_minor FROM paypal_authorization a
      WHERE a.checkout_id = c.id AND a.purpose = 'PURCHASE'
      ORDER BY a.created_at DESC LIMIT 1) AS captured_minor,
    (SELECT COUNT(*) FROM browser_step s
      JOIN browser_session bs ON bs.id = s.session_id
      WHERE bs.checkout_id = c.id) AS browser_steps,
    (SELECT bs.deleted_at FROM browser_session bs
      WHERE bs.checkout_id = c.id ORDER BY bs.opened_at DESC LIMIT 1) AS browser_deleted_at,
    (SELECT m.id FROM meter_session m WHERE m.checkout_id = c.id) AS meter_session_id,
    (SELECT m.redeemed_minor FROM meter_session m WHERE m.checkout_id = c.id) AS meter_redeemed_minor,
    (SELECT m.captured_minor FROM meter_session m WHERE m.checkout_id = c.id) AS meter_captured_minor,
    (SELECT n.id FROM negotiation_session n WHERE n.checkout_id = c.id) AS negotiation_id,
    (SELECT n.rounds FROM negotiation_session n WHERE n.checkout_id = c.id) AS negotiation_rounds,
    (SELECT o.unit_price_minor FROM offer o WHERE o.id = c.offer_id) AS offer_unit_price_minor,
    (SELECT e.status FROM escalation e WHERE e.verdict_id = v.id
      ORDER BY e.requested_at DESC LIMIT 1) AS escalation_status
FROM checkout c
LEFT JOIN verdict v ON v.checkout_id = c.id;

-- =====================================================================
-- plpgsql triggers: the SQLite RAISE(ABORT) rules, same semantics
-- =====================================================================

CREATE OR REPLACE FUNCTION fn_checkout_same_principal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT principal_id FROM mandate WHERE id = NEW.mandate_id) <> NEW.principal_id THEN
        RAISE EXCEPTION 'TENANCY: checkout.principal_id must equal mandate.principal_id';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_checkout_same_principal
BEFORE INSERT ON checkout
FOR EACH ROW EXECUTE FUNCTION fn_checkout_same_principal();

CREATE OR REPLACE FUNCTION fn_checkout_active_mandate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT status FROM mandate WHERE id = NEW.mandate_id) <> 'ACTIVE' THEN
        RAISE EXCEPTION 'MV-R014: checkout requires an ACTIVE mandate';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_checkout_active_mandate
BEFORE INSERT ON checkout
FOR EACH ROW EXECUTE FUNCTION fn_checkout_active_mandate();

CREATE OR REPLACE FUNCTION fn_auth_after_browser_deleted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.purpose = 'PURCHASE' AND EXISTS (
        SELECT 1 FROM browser_session bs
        WHERE bs.checkout_id = NEW.checkout_id AND bs.deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'R084: browser session still open at authorization insert';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_auth_after_browser_deleted
BEFORE INSERT ON paypal_authorization
FOR EACH ROW EXECUTE FUNCTION fn_auth_after_browser_deleted();

CREATE OR REPLACE FUNCTION fn_capture_requires_verdict() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.purpose = 'PURCHASE'
       AND NEW.status IN ('CAPTURED','PARTIALLY_CAPTURED')
       AND NOT EXISTS (SELECT 1 FROM verdict v WHERE v.checkout_id = NEW.checkout_id)
    THEN
        RAISE EXCEPTION 'R004: capture attempted without a stored verdict';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_capture_requires_verdict_insert
BEFORE INSERT ON paypal_authorization
FOR EACH ROW EXECUTE FUNCTION fn_capture_requires_verdict();

CREATE TRIGGER trg_capture_requires_verdict
BEFORE UPDATE OF status ON paypal_authorization
FOR EACH ROW EXECUTE FUNCTION fn_capture_requires_verdict();

CREATE OR REPLACE FUNCTION fn_voucher_price_matches_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.amount_minor <> (SELECT price_minor FROM meter_entry WHERE id = NEW.entry_id) THEN
        RAISE EXCEPTION 'R075: voucher amount differs from the debited price';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_voucher_price_matches_entry
BEFORE INSERT ON voucher
FOR EACH ROW EXECUTE FUNCTION fn_voucher_price_matches_entry();

CREATE OR REPLACE FUNCTION fn_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'R034: % is append-only', TG_TABLE_NAME;
END $$;

CREATE TRIGGER trg_verdict_append_only BEFORE UPDATE OR DELETE ON verdict
FOR EACH ROW EXECUTE FUNCTION fn_append_only();
CREATE TRIGGER trg_verdict_clause_append_only BEFORE UPDATE OR DELETE ON verdict_clause
FOR EACH ROW EXECUTE FUNCTION fn_append_only();
CREATE TRIGGER trg_audit_append_only BEFORE UPDATE OR DELETE ON audit_event
FOR EACH ROW EXECUTE FUNCTION fn_append_only();
