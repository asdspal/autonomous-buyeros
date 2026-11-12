import { SignJWT, jwtVerify } from 'jose';
import type { Pool } from 'pg';
import { canonical, isPublicP256Jwk, rfc7638Thumbprint, verifyEs256 } from '@buyeros/core';

export const DEMO_PRINCIPAL_ID = 'prn_demo';
const COOKIE_BASE = 'buyeros_session';
const COOKIE_HOST = '__Host-buyeros_session';

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw) throw new Error('SESSION_SECRET is not set');
  return new TextEncoder().encode(raw);
}

function cookieName(): string {
  return process.env.NODE_ENV === 'production' ? COOKIE_HOST : COOKIE_BASE;
}

export async function issueSessionToken(principalId = DEMO_PRINCIPAL_ID): Promise<string> {
  return new SignJWT({ sub: principalId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret());
}

export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function sessionPrincipal(request: Request): Promise<string | null> {
  const token = readCookie(request, cookieName()) ?? readCookie(request, COOKIE_BASE);
  if (!token) return null;
  return verifySessionToken(token);
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${cookieName()}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure}`;
}

export function clearedCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${cookieName()}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

export function serviceAuthorised(request: Request): boolean {
  const token = request.headers.get('x-service-token');
  return Boolean(token && process.env.SERVICE_TOKEN && token === process.env.SERVICE_TOKEN);
}

export function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const allowed = new Set<string>([new URL(request.url).origin]);
  if (process.env.APP_ORIGIN) allowed.add(process.env.APP_ORIGIN);
  return allowed.has(origin);
}

export interface AgentAuth {
  ok: boolean;
  agentThumbprint?: string;
  code?: 'UNAUTHENTICATED' | 'MV-R016';
}

export async function agentAuth(
  request: Request,
  parsedBody: unknown,
  db: Pool,
): Promise<AgentAuth> {
  const jwkHeader = request.headers.get('x-agent-jwk');
  const signature = request.headers.get('x-agent-signature');
  if (!jwkHeader || !signature) return { ok: false, code: 'UNAUTHENTICATED' };
  let jwk: unknown;
  try {
    jwk = JSON.parse(jwkHeader);
  } catch {
    return { ok: false, code: 'MV-R016' };
  }
  if (!isPublicP256Jwk(jwk)) return { ok: false, code: 'MV-R016' };
  const thumbprint = rfc7638Thumbprint(jwk);
  const agent = await db.query(
    "SELECT id FROM agent WHERE key_thumbprint = $1 AND status = 'ACTIVE'",
    [thumbprint],
  );
  if (!agent.rowCount) return { ok: false, code: 'MV-R016' };
  const valid = await verifyEs256(
    new TextEncoder().encode(canonical(parsedBody)),
    signature,
    jwk,
  );
  if (!valid) return { ok: false, code: 'MV-R016' };
  return { ok: true, agentThumbprint: thumbprint };
}
