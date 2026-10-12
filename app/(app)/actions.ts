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
