import { NextResponse, type NextRequest } from "next/server";
import { API_CSP, buildCsp, generateNonce } from "@/lib/security/headers";
import { refreshSession } from "@/lib/supabase/proxy-session";
import { getPublicEnv } from "@/lib/env";

/**
 * Runs before every matched request (Next.js 16 "proxy", formerly middleware):
 *  1. Sets a per-request nonce Content-Security-Policy.
 *  2. Refreshes the Supabase session cookie.
 *  3. Redirects unauthenticated requests for protected pages to /login.
 *
 * This is a fast first gate only. Pages still call requireUser(), and the
 * database enforces Row Level Security, so nothing relies on this alone.
 */

const PUBLIC_PATHS = ["/login", "/auth/callback", "/api/health"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const env = getPublicEnv();

  if (pathname.startsWith("/api/")) {
    const res = NextResponse.next();
    res.headers.set("Content-Security-Policy", API_CSP);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  const nonce = generateNonce();
  const csp = buildCsp({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const base = NextResponse.next({ request: { headers: requestHeaders } });
  const { response, userId } = await refreshSession(
    request,
    base,
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

  let finalResponse = response;
  if (!userId && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    finalResponse = NextResponse.redirect(url);
    // Keep any refreshed/cleared auth cookies on the redirect.
    response.cookies.getAll().forEach((c) => finalResponse.cookies.set(c));
  }

  finalResponse.headers.set("Content-Security-Policy", csp);
  finalResponse.headers.set("Cache-Control", "private, no-store");
  return finalResponse;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|robots.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
