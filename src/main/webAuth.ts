/**
 * webAuth — autenticación y perímetro para el modo web headless (spec v1.2).
 *
 * Reglas:
 *  - Bearer OBLIGATORIO contra env WEB_TOKEN (timingSafeEqual; sin token en el
 *    servidor el proceso ni arranca). Se acepta `Authorization: Bearer <t>` o
 *    `?token=<t>` (los WebSocket de navegador no pueden fijar headers).
 *  - Host/Origin limitado a la tailnet: 100.78.144.4, localhost/127.0.0.1
 *    (dev/smoke) o MagicDNS de env WEB_HOSTNAMES (coma-separado). → ERR-W02.
 *  - Rate-limit de auth: 10 fallos / 60s por IP → 429 ERR-W09 durante 60s.
 *  - `tailscale whois` solo best-effort para log, nunca bloquea ni retrasa auth.
 */
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WEB_TAILNET_IP, type CthError, type WebErrorCode } from '../shared/webBridge';

const FAIL_WINDOW_MS = 60_000;
const FAIL_LIMIT = 10;
const BLOCK_MS = 60_000;

interface FailRec { count: number; firstAt: number; blockedUntil: number }
const fails = new Map<string, FailRec>();

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

/** Token esperado. null = no configurado (el server debe rehusar arrancar). */
export function expectedToken(): string | null {
  const t = process.env.WEB_TOKEN?.trim();
  return t ? t : null;
}

function providedToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string') {
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  try {
    const u = new URL(req.url ?? '/', 'http://x');
    const q = u.searchParams.get('token')?.trim();
    if (q) return q;
  } catch { /* url rara: sin token por query */ }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Hostnames extra (MagicDNS) desde env WEB_HOSTNAMES="a,b". */
export function extraHostnames(): string[] {
  return (process.env.WEB_HOSTNAMES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/:\d+$/, ''))
    .filter(Boolean);
}

function hostOf(value: string | undefined): string {
  if (!value) return '';
  const v = value.trim().toLowerCase();
  // Origin trae esquema ("http://host:port"); Host trae "host:port".
  const noScheme = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  return noScheme.split('/')[0].split(':')[0];
}

/** ¿Host/Origin dentro del perímetro tailnet? */
export function isHostAllowed(req: IncomingMessage): boolean {
  const allow = new Set<string>([
    WEB_TAILNET_IP, // 100.78.144.4
    'localhost',
    '127.0.0.1',
    '::1',
    ...extraHostnames()
  ]);
  const host = hostOf(req.headers.host);
  if (host && allow.has(host)) return true;
  const origin = hostOf(
    typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  );
  // Sin Origin (curl, tests, WS no-browser) manda el Host. Con Origin, ambos
  // deben estar permitidos para evitar DNS-rebinding vía Host válido.
  if (!origin) return host !== '' && allow.has(host);
  return allow.has(host) && allow.has(origin);
}

export function isRateLimited(ip: string): boolean {
  const r = fails.get(ip);
  return !!r && Date.now() < r.blockedUntil;
}

export function recordAuthFail(ip: string): boolean {
  const now = Date.now();
  let r = fails.get(ip);
  if (!r || now - r.firstAt > FAIL_WINDOW_MS) r = { count: 0, firstAt: now, blockedUntil: 0 };
  r.count += 1;
  if (r.count >= FAIL_LIMIT) r.blockedUntil = now + BLOCK_MS;
  fails.set(ip, r);
  return now < r.blockedUntil;
}

export function recordAuthOk(ip: string): void {
  fails.delete(ip);
}

export function err(code: WebErrorCode, message: string, http: number): CthError {
  return { code, message, http };
}

/** Best-effort: quién es esta IP según tailscale, solo para log. Nunca falla. */
export function logTailscaleWhois(ip: string): void {
  if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip === '::1') return;
  execFile('tailscale', ['whois', ip], { timeout: 2000 }, (e, stdout) => {
    if (e) return;
    const first = stdout.split('\n').find((l) => l.trim());
    if (first) console.log(`[web] tailscale whois ${ip}: ${first.trim().slice(0, 160)}`);
  });
}

export interface AuthResult {
  ok: boolean;
  /** Código listo para responder cuando ok=false. */
  error?: CthError;
}

/** Cadena completa: rate-limit → host → bearer. Efectos: contadores + whois-log. */
export function checkAuth(req: IncomingMessage): AuthResult {
  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    return { ok: false, error: err('ERR-W09', 'too many auth failures, retry later', 429) };
  }
  if (!isHostAllowed(req)) {
    const limited = recordAuthFail(ip);
    return {
      ok: false,
      error: limited
        ? err('ERR-W09', 'too many auth failures, retry later', 429)
        : err('ERR-W02', 'host not in tailnet allowlist', 403)
    };
  }
  const expected = expectedToken();
  const got = providedToken(req);
  if (!expected || !got || !safeEqual(got, expected)) {
    const limited = recordAuthFail(ip);
    return {
      ok: false,
      error: limited
        ? err('ERR-W09', 'too many auth failures, retry later', 429)
        : err('ERR-W01', 'missing or invalid bearer token', 401)
    };
  }
  recordAuthOk(ip);
  logTailscaleWhois(ip);
  return { ok: true };
}

export function writeJsonError(res: ServerResponse, error: CthError): void {
  const body = JSON.stringify({ ok: false, error });
  res.writeHead(error.http, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}
