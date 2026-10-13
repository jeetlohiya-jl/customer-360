"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerEnv } from "@/lib/env";

/**
 * The mailbox owner controls their own scan. The database re-checks: active
 * user, own active Gmail connection, mailbox on the approved list, one scan at
 * a time; and writes the audit entries.
 */
async function call(fn: "scan_start" | "scan_cancel" | "scan_resume", ok: string) {
  await requireUser();
  if (getServerEnv().FEATURE_SCAN !== "on") redirect("/dashboard?scan=disabled");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc(fn);
  if (error) redirect(`/dashboard?scan_error=${encodeURIComponent(error.message.slice(0, 120))}`);
  revalidatePath("/dashboard");
  redirect(`/dashboard?scan=${ok}`);
}

export async function startScan() {
  await call("scan_start", "started");
}
export async function cancelScan() {
  await call("scan_cancel", "cancel_requested");
}
export async function resumeScan() {
  await call("scan_resume", "resumed");
}
