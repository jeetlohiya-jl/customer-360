import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { OAUTH_COOKIE, completeAuthorization, gmailEnv } from "@/lib/gmail/connection";
import { getServerEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Google redirects here after the Gmail consent screen. The signed-in user
 * must be the same one who started the flow (checked via the signed cookie).
 * Only a result code is logged: never the code, tokens or email content.
 */
export async function GET(request: NextRequest) {
  const base = getServerEnv().APP_BASE_URL;
  const env = gmailEnv();
  if (!env) return NextResponse.redirect(`${base}/dashboard?gmail=disabled`);

  const user = await requireUser();
  const p = request.nextUrl.searchParams;
  const result = await completeAuthorization(
    user,
    env,
    { code: p.get("code"), state: p.get("state"), error: p.get("error") },
    request.cookies.get(OAUTH_COOKIE)?.value,
  );
  console.info(JSON.stringify({ event: "gmail_callback", result }));

  const res = NextResponse.redirect(`${base}/dashboard?gmail=${result}`);
  res.cookies.set(OAUTH_COOKIE, "", { path: "/api/oauth/gmail", maxAge: 0 });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
