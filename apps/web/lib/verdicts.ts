import type { Pool } from 'pg';

export interface StoredVerdict {
  verdict_id: string;
  checkout_id: string;
  decision: string;
  reason_codes: string[];
  evidence_hash: string;
  latency_us: number;
  auditor_version: string;
  decided_at: string;
  correlation_id: string;
  clauses: Array<{
    clause_id: string | null;
    clause_key: string;
    expression: unknown;
    observed: unknown;
    source: string;
    result: string;
    code: string | null;
  }>;
}

export async function loadVerdict(db: Pool, verdictId: string): Promise<StoredVerdict | null> {
  const verdict = await db.query(
    `SELECT id, checkout_id, decision, reason_codes, evidence_hash, latency_us,
            auditor_version, decided_at, correlation_id
       FROM verdict WHERE id = $1`,
    [verdictId],
  );
  if (!verdict.rowCount) return null;
  const row = verdict.rows[0] as {
    id: string;
    checkout_id: string;
    decision: string;
    reason_codes: string[];
    evidence_hash: string;
    latency_us: number;
    auditor_version: string;
    decided_at: string;
    correlation_id: string;
  };
  const clauses = await db.query(
    `SELECT clause_id, clause_key, expression, observed, source, result, code
       FROM verdict_clause WHERE verdict_id = $1 ORDER BY clause_key`,
    [verdictId],
  );
  return {
    verdict_id: row.id,
    checkout_id: row.checkout_id,
    decision: row.decision,
    reason_codes: row.reason_codes,
    evidence_hash: row.evidence_hash,
    latency_us: row.latency_us,
    auditor_version: row.auditor_version,
    decided_at: String(row.decided_at),
    correlation_id: row.correlation_id,
    clauses: clauses.rows as StoredVerdict['clauses'],
  };
}
