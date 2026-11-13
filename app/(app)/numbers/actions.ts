"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getExtractConfig } from "@/lib/extract/config";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const back = (formData: FormData) => {
  const r = String(formData.get("back") ?? "/numbers");
  return r.startsWith("/numbers") && !r.startsWith("//") ? r : "/numbers";
};
const withParam = (url: string, k: string, v: string) => `${url}${url.includes("?") ? "&" : "?"}${k}=${v}`;

/** Confirm or reject one customer number. The database checks the caller is its mailbox owner or an admin. */
export async function reviewMetric(formData: FormData) {
  await requireUser();
  if (!getExtractConfig().enabled) redirect("/numbers");
  const id = String(formData.get("metricId") ?? "");
  const action = String(formData.get("action") ?? "");
  if (!UUID.test(id) || !["confirm", "reject"].includes(action)) redirect(withParam(back(formData), "error", "invalid"));
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("metric_review", { p_metric: id, p_action: action });
  if (error) redirect(withParam(back(formData), "error", "review_failed"));
  revalidatePath("/numbers");
  redirect(withParam(back(formData), "ok", action));
}
