import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerEnv } from "@/lib/env";
import { checkWorkspaceUser } from "@/lib/auth/domain";

/**
 * OAuth callback. Exchanges the code for a session, then enforces Workspace
 * membership on the server. Any failure signs the user out.
 */
export async function GET(request: NextRequest) {
  const env = getServerEnv();
  const base = env.APP_BASE_URL;
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.redirect(`${base}/login?error=callback`);

  const supabase = await createSupabaseServerClient();
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) return NextResponse.redirect(`${base}/login?error=callback`);

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return NextResponse.redirect(`${base}/login?error=callback`);

  const check = checkWorkspaceUser(data.user, env.WORKSPACE_DOMAIN);
  if (!check.ok) {
    await supabase.auth.signOut();
    // Log the reason code only; never the email address or token.
    console.warn(JSON.stringify({ event: "sign_in_rejected", reason: check.reason }));
    return NextResponse.redirect(`${base}/login?error=domain`);
  }

  // Audit the sign-in (security definer function; writes actor = auth.uid()).
  // It refuses anyone who is not active: not invited (0014), suspended or departed.
  const { error: signInError } = await supabase.rpc("record_sign_in");
  if (signInError) {
    await supabase.auth.signOut();
    console.warn(JSON.stringify({ event: "sign_in_rejected", reason: "not_invited_or_inactive" }));
    return NextResponse.redirect(`${base}/login?error=not_invited`);
  }
  return NextResponse.redirect(`${base}/dashboard`);
}
