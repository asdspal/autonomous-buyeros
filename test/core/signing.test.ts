import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBrowserSigner } from '../../packages/core/src/mandate/signing.js';
import { verifyEs256 } from '../../packages/core/src/keys.js';
import { canonical } from '../../packages/core/src/mandate/jcs.js';

test('the browser signer never exports a private key', async () => {
  const signer = await createBrowserSigner();
  assert.equal(signer.publicJwk.kty, 'EC');
  assert.equal(signer.publicJwk.crv, 'P-256');
  assert.equal('d' in signer.publicJwk, false);
  assert.equal(JSON.stringify(signer.publicJwk).includes('"d"'), false);
});

test('a signature from the browser signer verifies server-side', async () => {
  const signer = await createBrowserSigner();
  const payload = { vct: 'mandate.checkout.open.1', total_minor: 25000, nonce: 'n_browser_000001' };
  const signature = await signer.sign(payload);
  const ok = await verifyEs256(
    new TextEncoder().encode(canonical(payload)),
    signature,
    signer.publicJwk as { kty: string; crv: string; x: string; y: string },
  );
  assert.equal(ok, true);

  const tampered = { ...payload, total_minor: 25001 };
  const bad = await verifyEs256(
    new TextEncoder().encode(canonical(tampered)),
    signature,
    signer.publicJwk as { kty: string; crv: string; x: string; y: string },
  );
  assert.equal(bad, false);
});

test('two signers produce different keys and signatures', async () => {
  const a = await createBrowserSigner();
  const b = await createBrowserSigner();
  assert.notDeepEqual(a.publicJwk, b.publicJwk);
  const payload = { a: 1 };
  assert.notEqual(await a.sign(payload), await b.sign(payload));
});
