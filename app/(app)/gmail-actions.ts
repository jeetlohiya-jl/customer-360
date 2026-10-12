"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { beginAuthorization, disconnect, gmailEnv } from "@/lib/gmail/connection";

/** Server Actions carry Next.js's built-in Origin check (CSRF protection). */

export async function connectGmail() {
  const user = await requireUser();
  const env = gmailEnv();
  if (!env) redirect("/dashboard?gmail=disabled");
  const { url, cookie } = beginAuthorization(user, env);
  (await cookies()).set(cookie.name, cookie.value, cookie.options);
  redirect(url);
}

export async function disconnectGmail() {
  const user = await requireUser();
  const revoked = await disconnect(user);
  redirect(`/dashboard?gmail=${revoked ? "disconnected" : "disconnected_local"}`);
}
