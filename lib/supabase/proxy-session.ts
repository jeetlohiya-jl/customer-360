import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Refreshes the Supabase session cookie and returns the verified user id
 * (or null). Used only by proxy.ts.
 *
 * getClaims() verifies the JWT signature (locally with asymmetric signing
 * keys, otherwise via the Auth server), so a forged cookie is rejected.
 */
export async function refreshSession(
  request: NextRequest,
  response: NextResponse,
  supabaseUrl: string,
  supabaseKey: string,
): Promise<{ response: NextResponse; userId: string | null }> {
  const current = response;
  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        cookiesToSet.forEach(({ name, value, options }) => current.cookies.set(name, value, options));
        Object.entries(headers ?? {}).forEach(([key, value]) => current.headers.set(key, value));
      },
    },
  });

  const { data, error } = await supabase.auth.getClaims();
  const userId = !error && typeof data?.claims?.sub === "string" ? data.claims.sub : null;
  return { response: current, userId };
}
