import { canonical } from './jcs.js';

export interface BrowserSigner {
  publicJwk: JsonWebKey;
  sign(payload: unknown): Promise<string>;
}

export async function createBrowserSigner(): Promise<BrowserSigner> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  return {
    publicJwk,
    async sign(payload: unknown): Promise<string> {
      const bytes = new TextEncoder().encode(canonical(payload));
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        bytes,
      );
      const bytesOut = new Uint8Array(signature);
      let binary = '';
      for (const byte of bytesOut) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
  };
}
