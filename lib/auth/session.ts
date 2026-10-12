import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AppRole = "member" | "admin";

export interface CurrentUser {
  id: string;
  email: string;
  role: AppRole;
  status: "active" | "departed";
}

/**
 * Authoritative check for protected pages: asks the Auth server for the user
 * (getUser), then loads the app_users row through RLS. A user without an
 * active app_users row is signed out. Wrapped in React cache() so the layout
 * and the page share one lookup per request.
 */
export const requireUser = cache(async function requireUser(): Promise<CurrentUser> {
  const supabase = await createSupabaseServerClient();
  const { data: auth, error } = await supabase.auth.getUser();
  if (error || !auth.user) redirect("/login");

  const { data: row } = await supabase
    .from("app_users")
    .select("id, email, role, status")
    .eq("id", auth.user.id)
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
