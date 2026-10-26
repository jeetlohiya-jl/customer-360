"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth/session";

/** Server Actions get Next.js's built-in Origin check against CSRF. */

export async function signOut() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}

const roleChange = z.object({
  userId: z.uuid(),
  role: z.enum(["member", "admin"]),
});

const inviteForm = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  note: z.string().trim().max(200).optional(),
});

/** Invite-only access (0014): the database checks admin rights, the domain, and audits. */
export async function inviteUser(formData: FormData) {
  await requireAdmin();
  const parsed = inviteForm.safeParse({ email: formData.get("email"), note: formData.get("note") || undefined });
  if (!parsed.success) redirect("/admin?error=invalid%20email");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("access_invite", { p_email: parsed.data.email, p_note: parsed.data.note ?? null });
  if (error) redirect(`/admin?error=${encodeURIComponent(error.message.slice(0, 80))}`);
  revalidatePath("/admin");
  redirect("/admin?ok=invited");
}

export async function revokeAccess(formData: FormData) {
  await requireAdmin();
  const parsed = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).safeParse({ email: formData.get("email") });
  if (!parsed.success) redirect("/admin?error=invalid%20email");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("access_revoke", { p_email: parsed.data.email });
  if (error) redirect(`/admin?error=${encodeURIComponent(error.message.slice(0, 80))}`);
  revalidatePath("/admin");
  redirect("/admin?ok=revoked");
}

export async function changeRole(formData: FormData) {
  await requireAdmin();
  const parsed = roleChange.safeParse({ userId: formData.get("userId"), role: formData.get("role") });
  if (!parsed.success) redirect("/admin?error=invalid");

  const supabase = await createSupabaseServerClient();
  // The database re-checks that the caller is an active admin, blocks removing
  // the last admin, and writes the audit entry.
  const { error } = await supabase.rpc("set_user_role", {
    target_user: parsed.data.userId,
    new_role: parsed.data.role,
  });
  if (error) redirect(`/admin?error=${encodeURIComponent(error.message.slice(0, 80))}`);
  revalidatePath("/admin");
  redirect("/admin?ok=role");
}
