"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerEnv } from "@/lib/env";
import { signInScopeString } from "@/lib/auth/scopes";

/**
 * Starts Google sign-in. Requests identity scopes only, and asks Google to
 * restrict the account picker to the Workspace domain (hd). The hd hint is a
 * convenience; the real check happens in /auth/callback and in the database.
 */
export async function signInWithGoogle() {
  const env = getServerEnv();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${env.APP_BASE_URL}/auth/callback`,
      scopes: signInScopeString(),
      queryParams: { hd: env.WORKSPACE_DOMAIN, prompt: "select_account" },
    },
  });
  if (error || !data.url) redirect("/login?error=oauth_start");
  redirect(data.url);
}
