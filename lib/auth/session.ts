import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AppRole = "member" | "admin";

export interface CurrentUser {
  id: string;
  email: string;
  role: AppRole;
  status: "active" | "suspended" | "departed";
}

/**
 * Authoritative check for protected pages: verifies the session token
 * (getClaims checks the JWT signature, locally when the project uses signing
 * keys, otherwise with the Auth server, the same check proxy.ts makes), then
 * loads the app_users row through RLS. A user without an active app_users row
 * (not invited, suspended, departed) is signed out, so access changes still
 * apply on the next page load. Wrapped in React cache() so the layout and the
 * page share one lookup per request.
 */
export const requireUser = cache(async function requireUser(): Promise<CurrentUser> {
  const supabase = await createSupabaseServerClient();
  const { data: auth, error } = await supabase.auth.getClaims();
  const userId = !error && typeof auth?.claims?.sub === "string" ? auth.claims.sub : null;
  if (!userId) redirect("/login");

  const { data: row } = await supabase
    .from("app_users")
    .select("id, email, role, status")
    .eq("id", userId)
    .maybeSingle();

  if (!row || row.status !== "active") {
    await supabase.auth.signOut();
    redirect("/login?error=inactive");
  }
  return row as CurrentUser;
});

export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/dashboard?error=forbidden");
  return user;
}
