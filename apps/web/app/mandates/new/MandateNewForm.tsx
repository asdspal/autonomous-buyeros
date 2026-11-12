'use client';

import { useEffect, useMemo, useState } from 'react';
import { createBrowserSigner, type BrowserSigner } from '@buyeros/core';
import type { MandateDraft } from '@buyeros/core';

function money(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

function clauseRows(draft: MandateDraft): Array<[string, string]> {
  const c = draft.constraints;
  const rows: Array<[string, string]> = [
    ['Total spend', money(c.budget.total_minor, c.budget.currency)],
    ['Per transaction', money(c.budget.per_txn_minor, c.budget.currency)],
    ['Transactions', String(c.budget.max_txns)],
    ['Tool allowance', money(c.metering.total_minor, c.metering.currency)],
    ['Tool calls', String(c.metering.max_calls)],
    ['Merchants', c.merchants.mode === 'any' ? 'any' : c.merchants.domain_hashes.join(', ')],
    ['Shipping', `within ${c.shipping.deadline_days} days`],
    ['Unknown attributes', c.unknown_attribute_policy],
    ['Refundable', c.refundability?.min ?? 'any'],
  ];
  for (const item of c.items) {
    rows.push([`Item ${item.spec_id}`, `at most ${item.max_qty}`]);
    for (const [attr, spec] of Object.entries(item.required_attrs)) {
      rows.push([attr, JSON.stringify(spec)]);
    }
  }
  return rows;
}

export default function MandateNewForm() {
  const [signer, setSigner] = useState<BrowserSigner | null>(null);
  const [brief, setBrief] = useState('Machine-washable rug for at most $250 from shop-a.example, plus a few paid lookups.');
  const [draft, setDraft] = useState<MandateDraft | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [previousMandateId, setPreviousMandateId] = useState<string | null>(null);
  const [version, setVersion] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    createBrowserSigner()
      .then((value) => setSigner(value))
      .catch(() => setError('This browser cannot generate a P-256 signing key.'));
  }, []);

  const rows = useMemo(() => (draft ? clauseRows(draft) : []), [draft]);

  async function compile() {
    setBusy(true);
    setError(null);
    setResult(null);
    setMissing([]);
    try {
      const response = await fetch('/api/mandates/compile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brief }),
      });
      const body = await response.json();
      if (!response.ok) {
        setDraft(null);
        setMissing(body.missing ?? []);
        setError(body.error?.message ?? 'The brief could not be compiled.');
        return;
      }
      setDraft(body.mandate);
      setSource(body.source);
      setConfirmed(false);
    } catch {
      setError('The compiler is unreachable.');
    } finally {
      setBusy(false);
    }
  }

  function edit(mutate: (next: MandateDraft) => void) {
    if (!draft) return;
    const next = structuredClone(draft);
    mutate(next);
    next.mandate_id = `mdt_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    next.nonce = `n_${crypto.randomUUID().replaceAll('-', '')}`;
    setDraft(next);
    setConfirmed(false);
    setResult(null);
  }

  async function sign() {
    if (!signer || !draft || !confirmed) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const signature = await signer.sign(draft);
      const response = await fetch('/api/mandates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mandate: draft,
          signature,
          publicJwk: signer.publicJwk,
          previousMandateId: previousMandateId ?? undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error?.message ?? 'The mandate was refused.');
        return;
      }
      setPreviousMandateId(body.mandateId);
      setVersion(body.version);
      setResult(`Mandate ${body.mandateId} is ACTIVE (version ${body.version}) with ${body.clauses} clauses.`);
    } catch {
      setError('Signing or registration failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>New mandate</h2>
      <p>
        The signing key is generated in this page and is non-extractable. Only the public key is
        sent to the server.
      </p>

      <label htmlFor="brief">Brief</label>
      <textarea
        id="brief"
        name="brief"
        rows={4}
        value={brief}
        onChange={(event) => setBrief(event.target.value)}
        style={{ display: 'block', width: '100%', margin: '0.5rem 0 1rem' }}
      />

      <button type="button" onClick={compile} disabled={busy || brief.trim().length < 3}>
        {busy ? 'Working…' : 'Compile draft'}
      </button>
      {source ? <p className="budget">compiled by: {source}</p> : null}
      {missing.length ? (
        <p role="alert">Missing: {missing.join(', ')}. Add it to the brief and compile again.</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}

      {draft ? (
        <>
          <h3>Read every clause before signing</h3>
          <p className="budget">Editing any value re-signs a new version; the previous version is revoked.</p>
          <table>
            <caption className="sr-only">Mandate clauses, editable before signing</caption>
            <thead>
              <tr>
                <th scope="col">Clause</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row"><label htmlFor="total">Total spend (minor)</label></th>
                <td>
                  <input
                    id="total"
                    type="number"
                    min={1}
                    value={draft.constraints.budget.total_minor}
                    onChange={(event) =>
                      edit((next) => {
                        const value = Math.max(1, Number(event.target.value) || 1);
                        next.constraints.budget.total_minor = value;
                        next.constraints.budget.per_txn_minor = Math.min(
                          next.constraints.budget.per_txn_minor,
                          value,
                        );
                      })
                    }
                  />
                </td>
              </tr>
              <tr>
                <th scope="row"><label htmlFor="perTxn">Per transaction (minor)</label></th>
                <td>
                  <input
                    id="perTxn"
                    type="number"
                    min={1}
                    value={draft.constraints.budget.per_txn_minor}
                    onChange={(event) =>
                      edit((next) => {
                        next.constraints.budget.per_txn_minor = Math.max(1, Number(event.target.value) || 1);
                      })
                    }
                  />
                </td>
              </tr>
              <tr>
                <th scope="row"><label htmlFor="maxTxns">Transactions</label></th>
                <td>
                  <input
                    id="maxTxns"
                    type="number"
                    min={1}
                    max={20}
                    value={draft.constraints.budget.max_txns}
                    onChange={(event) =>
                      edit((next) => {
                        next.constraints.budget.max_txns = Math.min(20, Math.max(1, Number(event.target.value) || 1));
                      })
                    }
                  />
                </td>
              </tr>
              <tr>
                <th scope="row"><label htmlFor="meterTotal">Tool allowance (minor)</label></th>
                <td>
                  <input
                    id="meterTotal"
                    type="number"
                    min={0}
                    value={draft.constraints.metering.total_minor}
                    onChange={(event) =>
                      edit((next) => {
                        next.constraints.metering.total_minor = Math.max(0, Number(event.target.value) || 0);
                      })
                    }
                  />
                </td>
              </tr>
              <tr>
                <th scope="row"><label htmlFor="maxCalls">Tool calls</label></th>
                <td>
                  <input
                    id="maxCalls"
                    type="number"
                    min={0}
                    max={500}
                    value={draft.constraints.metering.max_calls}
                    onChange={(event) =>
                      edit((next) => {
                        next.constraints.metering.max_calls = Math.min(500, Math.max(0, Number(event.target.value) || 0));
                      })
                    }
                  />
                </td>
              </tr>
              <tr>
                <th scope="row"><label htmlFor="unknownPolicy">Unknown attributes</label></th>
                <td>
                  <select
                    id="unknownPolicy"
                    value={draft.constraints.unknown_attribute_policy}
                    onChange={(event) =>
                      edit((next) => {
                        next.constraints.unknown_attribute_policy = event.target
                          .value as 'deny' | 'escalate' | 'allow';
                      })
                    }
                  >
                    <option value="deny">deny</option>
                    <option value="escalate">escalate</option>
                    <option value="allow">allow</option>
                  </select>
                </td>
              </tr>
              {rows.map(([clause, value]) => (
                <tr key={`${clause}-${value}`}>
                  <th scope="row">{clause}</th>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="budget">current version to sign: {version + (previousMandateId ? 1 : 0)}</p>

          <p>
            <input
              id="confirm"
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{' '}
            <label htmlFor="confirm">I have read every clause and confirm this mandate.</label>
          </p>
          <button type="button" onClick={sign} disabled={!confirmed || busy || !signer}>
            Sign and activate
          </button>
        </>
      ) : null}

      {result ? <p role="status">{result}</p> : null}
    </section>
  );
}
