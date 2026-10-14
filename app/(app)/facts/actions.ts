"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin, requireUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getExtractConfig } from "@/lib/extract/config";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const back = (formData: FormData) => {
  const r = String(formData.get("back") ?? "/facts");
  return r.startsWith("/facts") && !r.startsWith("//") ? r : "/facts";
};
const withParam = (url: string, k: string, v: string) => `${url}${url.includes("?") ? "&" : "?"}${k}=${v}`;

/** Confirm or reject one fact. The database checks the caller is its mailbox owner or an admin. */
export async function reviewFact(formData: FormData) {
  await requireUser();
  if (!getExtractConfig().enabled) redirect("/facts");
  const id = String(formData.get("factId") ?? "");
  const action = String(formData.get("action") ?? "");
  if (!UUID.test(id) || !["confirm", "reject"].includes(action)) redirect(withParam(back(formData), "error", "invalid"));
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("fact_review", { p_fact: id, p_action: action, p_changes: {}, p_note: null });
  if (error) redirect(withParam(back(formData), "error", "review_failed"));
  revalidatePath("/facts");
  redirect(withParam(back(formData), "ok", action));
}

const blank = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === "" ? undefined : String(v).trim());
const correction = z
  .object({
    fact_type: z.enum(["requirement", "order", "pricing", "delivery", "quality_issue", "follow_up"]).optional(),
    stance: z.enum(["request", "proposal", "commitment", "report", "cancellation"]).optional(),
    status: z.enum(["open", "resolved", "cancelled", "not_applicable", "unknown"]).optional(),
    product: z.string().max(120).optional(),
    quantity: z.coerce.number().nonnegative().max(1e11).optional(),
    unit: z.string().max(24).optional(),
    unit_price: z.coerce.number().nonnegative().max(1e9).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    summary: z.string().min(1).max(300).optional(),
  })
  .refine((c) => c.unit_price === undefined || c.currency !== undefined, { message: "a price needs a currency" });

/** Correct a fact: only the listed fields; the database re-checks every value and who may do it. */
export async function correctFact(formData: FormData) {
  await requireUser();
  if (!getExtractConfig().enabled) redirect("/facts");
  const id = String(formData.get("factId") ?? "");
  const raw: Record<string, string | undefined> = {};
  for (const k of ["fact_type", "stance", "status", "product", "quantity", "unit", "unit_price", "currency", "due_date", "summary"]) raw[k] = blank(formData.get(k));
  if (raw.currency) raw.currency = raw.currency.toUpperCase();
  const parsed = correction.safeParse(raw);
  if (!UUID.test(id) || !parsed.success) redirect(withParam(back(formData), "error", "invalid_correction"));
  const changes = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  const note = blank(formData.get("note"))?.slice(0, 300) ?? null;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("fact_review", { p_fact: id, p_action: "correct", p_changes: changes, p_note: note });
  if (error) redirect(withParam(back(formData), "error", "review_failed"));
  revalidatePath("/facts");
  redirect(withParam(back(formData), "ok", "correct"));
}

/** Admin: send failed extraction items back to the queue (after a fix). Audited in the database. */
export async function retryFailedExtraction() {
  await requireAdmin();
  if (!getExtractConfig().enabled) redirect("/admin");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("extraction_retry_failed");
  redirect(error ? "/admin?error=retry_failed" : "/admin?ok=retry");
}
