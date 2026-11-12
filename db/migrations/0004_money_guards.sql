-- 0004: close the money path on the update path too, and expose a boot assertion.
CREATE OR REPLACE FUNCTION fn_auth_after_browser_deleted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.purpose = 'PURCHASE' AND EXISTS (
        SELECT 1 FROM browser_session bs
        WHERE bs.checkout_id = NEW.checkout_id AND bs.deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'R084: browser session still open at authorization %', TG_OP;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auth_update_after_browser_deleted ON paypal_authorization;
CREATE TRIGGER trg_auth_update_after_browser_deleted
BEFORE UPDATE ON paypal_authorization
FOR EACH ROW EXECUTE FUNCTION fn_auth_after_browser_deleted();

CREATE OR REPLACE FUNCTION assert_money_guards() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    missing text[] := ARRAY[]::text[];
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_capture_requires_verdict_insert') THEN
        missing := missing || 'capture-insert-guard';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_capture_requires_verdict') THEN
        missing := missing || 'capture-update-guard';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_auth_after_browser_deleted') THEN
        missing := missing || 'browser-open-guard';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_auth_update_after_browser_deleted') THEN
        missing := missing || 'browser-open-update-guard';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_verdict_append_only') THEN
        missing := missing || 'verdict-append-only';
    END IF;
    IF array_length(missing, 1) IS NOT NULL THEN
        RAISE EXCEPTION 'MONEY_GUARDS_MISSING: %', array_to_string(missing, ',');
    END IF;
END $$;
