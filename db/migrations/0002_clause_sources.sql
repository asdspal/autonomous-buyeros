-- 0002: widen verdict_clause.source to the auditor's actual vocabulary.
-- 0001 was ported from a stage-2 schema whose source CHECK listed only the
-- attribute sources; the auditor also records mandate/cart/vault/offer sources,
-- and refusing them would force the service to mislabel evidence.
ALTER TABLE verdict_clause DROP CONSTRAINT IF EXISTS verdict_clause_source_check;
ALTER TABLE verdict_clause
    ADD CONSTRAINT verdict_clause_source_check CHECK (source IN (
        'catalog',
        'merchant_claim_untrusted',
        'absent',
        'offer:accepted',
        'mandate',
        'cart',
        'cart:computed',
        'vault',
        'offer',
        'offer:computed',
        'merchant_key_registry'
    ));
