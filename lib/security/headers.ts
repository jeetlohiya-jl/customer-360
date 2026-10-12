/**
 * Security headers.
 *
 * - STATIC_SECURITY_HEADERS apply to every response (set in next.config.ts).
 * - The Content-Security-Policy carries a per-request nonce, so it is built
 *   in proxy.ts for every page request.
 */

export const STATIC_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

/** CSP applied to API responses, which never render HTML. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

export interface CspOptions {
  nonce: string;
  isDev: boolean;
  supabaseUrl?: string;
}

export function buildCsp({ nonce, isDev, supabaseUrl }: CspOptions): string {
  if (!/^[A-Za-z0-9+/=]{16,}$/.test(nonce)) {
    throw new Error("CSP nonce must be a base64 string of at least 16 characters");
  }
  let supabaseOrigin = "";
  if (supabaseUrl) {
    try {
      supabaseOrigin = new URL(supabaseUrl).origin;
    } catch {
      supabaseOrigin = "";
    }
  }
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(isDev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", `'nonce-${nonce}'`],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'", ...(supabaseOrigin ? [supabaseOrigin] : [])],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'", "https://accounts.google.com", ...(supabaseOrigin ? [supabaseOrigin] : [])],
    "frame-ancestors": ["'none'"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (!isDev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
