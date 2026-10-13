"use server";

/**
 * Customer master actions (Stage 3.0). Every action:
 *  - checks the caller is an admin here (fast fail) AND in the database
 *    function it calls (authoritative), which also writes the audit entry;
 *  - re-validates input on the server; nothing from the browser is trusted;
 *  - never touches Gmail.
 * Server Actions carry Next.js's built-in Origin check against CSRF.
 */
import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerEnv } from "@/lib/env";
import { loadCustomerMaster, toRecords } from "@/lib/customers/data";
import { planCommit, previewImport, type Preview } from "@/lib/customers/import";
import { buildIndex, checkLine, type Decision } from "@/lib/customers/matcher";
import { CSV_LIMITS } from "@/lib/customers/csv";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const short = (msg: string | undefined) => (msg ?? "unknown error").slice(0, 200);

async function existingData() {
  const supabase = await createSupabaseServerClient();
  const master = await loadCustomerMaster(supabase);
  return {
    supabase,
    master,
    existing: { customers: toRecords(master), distinctions: master.distinctions, workspaceDomain: getServerEnv().WORKSPACE_DOMAIN },
  };
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

export interface ImportState {
  csv?: string;
  fileName?: string;
  preview?: Preview;
  error?: string;
  done?: Record<string, number>;
}

export async function previewImportAction(_prev: ImportState, formData: FormData): Promise<ImportState> {
  await requireAdmin();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
  if (file.size > CSV_LIMITS.maxBytes) return { error: "The file is larger than 2 MB." };
  const csv = await file.text();
  const { existing } = await existingData();
  return { csv, fileName: file.name.slice(0, 120), preview: previewImport(csv, existing) };
}

export async function commitImportAction(prev: ImportState, formData: FormData): Promise<ImportState> {
  await requireAdmin();
  const csv = formData.get("csv");
  if (typeof csv !== "string" || csv.length === 0 || csv.length > CSV_LIMITS.maxBytes) return { error: "The file is missing; upload it again." };

  const decisions: Record<number, string> = {};
  for (const [key, value] of formData.entries()) {
    const m = /^decision_(\d{1,5})$/.exec(key);
    if (m && typeof value === "string" && /^(create|skip|merge:[0-9a-f-]{36})$/.test(value)) decisions[Number(m[1])] = value;
  }

  // Re-run the preview against the database as it is now.
  const { supabase, existing } = await existingData();
  const preview = previewImport(csv, existing);
  const state: ImportState = { csv, fileName: prev.fileName, preview };
  if (preview.fileErrors.length) return { ...state, error: preview.fileErrors.join(" ") };

  const plan = planCommit(preview, decisions);
  if (plan.missingDecisions.length) return { ...state, error: `Choose what to do with line(s) ${plan.missingDecisions.join(", ")}.` };
  if (plan.invalidDecisions.length) return { ...state, error: `Line(s) ${plan.invalidDecisions.join(", ")} have an invalid choice.` };
  if (plan.rows.length === 0) return { ...state, error: "Nothing to import: every row was rejected or skipped." };

  const { data, error } = await supabase.rpc("import_customers", { p_rows: plan.rows, p_file_sha256: sha256(csv) });
  if (error) return { ...state, error: `Nothing was imported. ${short(error.message)}` };

  revalidatePath("/customers");
  const result = data as Record<string, number>;
  return { done: { ...result, skipped: plan.counts.skipped, rejected: plan.counts.rejected } };
}

// ---------------------------------------------------------------------------
// Single edits on the customer page
// ---------------------------------------------------------------------------

const uuid = z.uuid();

async function callAndReturn(path: string, fn: string, args: Record<string, unknown>, ok: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc(fn, args);
  if (error) redirect(`${path}?error=${encodeURIComponent(short(error.message))}`);
  revalidatePath(path);
  redirect(`${path}?ok=${ok}`);
}

export async function addAlias(formData: FormData) {
  await requireAdmin();
  const p = z
    .object({ customerId: uuid, alias: z.string().trim().min(1).max(200), kind: z.enum(["legal", "trading", "alias"]) })
    .safeParse({ customerId: formData.get("customerId"), alias: formData.get("alias"), kind: formData.get("kind") });
  if (!p.success) redirect("/customers?error=invalid");
  await callAndReturn(`/customers/${p.data.customerId}`, "customer_add_alias", { p_customer: p.data.customerId, p_alias: p.data.alias, p_kind: p.data.kind }, "alias");
}

export async function removeAlias(formData: FormData) {
  await requireAdmin();
  const p = z.object({ customerId: uuid, aliasId: uuid }).safeParse({ customerId: formData.get("customerId"), aliasId: formData.get("aliasId") });
  if (!p.success) redirect("/customers?error=invalid");
  await callAndReturn(`/customers/${p.data.customerId}`, "customer_remove_alias", { p_alias_id: p.data.aliasId }, "alias_removed");
}

export async function addIdentifier(formData: FormData) {
  await requireAdmin();
  const p = z
    .object({
      customerId: uuid,
      kind: z.enum(["domain", "email"]),
      value: z.string().trim().min(3).max(254),
      shared: z.enum(["on"]).optional(),
    })
    .safeParse({
      customerId: formData.get("customerId"),
      kind: formData.get("kind"),
      value: formData.get("value"),
      shared: formData.get("shared") ?? undefined,
    });
  if (!p.success) redirect("/customers?error=invalid");
  await callAndReturn(
    `/customers/${p.data.customerId}`,
    "customer_add_identifier",
    { p_customer: p.data.customerId, p_kind: p.data.kind, p_value: p.data.value, p_shared: p.data.shared === "on" },
    "identifier",
  );
}

export async function removeIdentifier(formData: FormData) {
  await requireAdmin();
  const p = z.object({ customerId: uuid, identifierId: uuid }).safeParse({ customerId: formData.get("customerId"), identifierId: formData.get("identifierId") });
  if (!p.success) redirect("/customers?error=invalid");
  await callAndReturn(`/customers/${p.data.customerId}`, "customer_remove_identifier", { p_identifier_id: p.data.identifierId }, "identifier_removed");
}

export async function setStatus(formData: FormData) {
  await requireAdmin();
  const p = z.object({ customerId: uuid, status: z.enum(["active", "inactive"]) }).safeParse({ customerId: formData.get("customerId"), status: formData.get("status") });
  if (!p.success) redirect("/customers?error=invalid");
  await callAndReturn(`/customers/${p.data.customerId}`, "customer_set_status", { p_customer: p.data.customerId, p_status: p.data.status }, "status");
}

export async function unmarkDistinct(formData: FormData) {
  await requireAdmin();
  const p = z.object({ customerId: uuid, otherId: uuid }).safeParse({ customerId: formData.get("customerId"), otherId: formData.get("otherId") });
  if (!p.success) redirect("/customers?error=invalid");
  await callAndReturn(`/customers/${p.data.customerId}`, "customers_unmark_distinct", { p_a: p.data.customerId, p_b: p.data.otherId }, "distinct_removed");
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

export async function resolveReview(formData: FormData) {
  await requireAdmin();
  const p = z
    .object({ itemId: uuid, action: z.enum(["same_customer", "not_a_customer"]), customerId: uuid.optional() })
    .safeParse({
      itemId: formData.get("itemId"),
      action: formData.get("action"),
      customerId: formData.get("customerId") || undefined,
    });
  if (!p.success) redirect("/customers/review?error=invalid");
  if (p.data.action === "same_customer" && !p.data.customerId) redirect("/customers/review?error=Choose%20a%20customer");
  await callAndReturn(
    "/customers/review",
    "review_resolve",
    { p_item: p.data.itemId, p_action: p.data.action, p_customer: p.data.customerId ?? null },
    p.data.action,
  );
}

export async function removeRejection(formData: FormData) {
  await requireAdmin();
  const p = z.string().trim().min(1).max(120).safeParse(formData.get("normalized"));
  if (!p.success) redirect("/customers/review?error=invalid");
  await callAndReturn("/customers/review", "name_rejection_remove", { p_normalized: p.data }, "rejection_removed");
}

// ---------------------------------------------------------------------------
// Name checker (no Gmail: the admin pastes names, e.g. from a sales sheet)
// ---------------------------------------------------------------------------

const CHECK_LIMITS = { maxLines: 500, maxChars: 50_000 } as const;

export interface CheckResult {
  line: string;
  decision: Decision;
  matches: { customer: string; observed: string; evidence: string; score: number }[];
}
export interface CheckState {
  text?: string;
  results?: CheckResult[];
  queued?: { queued: number; skipped: number };
  error?: string;
}

function readLines(text: unknown): string[] | string {
  if (typeof text !== "string" || !text.trim()) return "Paste at least one name.";
  if (text.length > CHECK_LIMITS.maxChars) return "Paste at most 50,000 characters.";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > CHECK_LIMITS.maxLines) return "Paste at most 500 lines.";
  return lines;
}

async function runCheck(lines: string[]) {
  const { master, existing } = await existingData();
  const index = buildIndex({ customers: existing.customers, distinctions: master.distinctions, rejections: master.rejections, workspaceDomain: existing.workspaceDomain });
  const customerNames = new Map(master.customers.map((c) => [c.id, c.canonical_name]));
  return lines.map((line) => ({ line, ...checkLine(index, line), customerNames }));
}

export async function checkNamesAction(_prev: CheckState, formData: FormData): Promise<CheckState> {
  await requireAdmin();
  const text = formData.get("text");
  const lines = readLines(text);
  if (typeof lines === "string") return { error: lines, text: typeof text === "string" ? text : "" };
  const checked = await runCheck(lines);
  return {
    text: text as string,
    results: checked.map((c) => ({
      line: c.line,
      decision: c.decision,
      matches: [
        ...c.names.map((h) => ({ customer: c.customerNames.get(h.customerId) ?? "?", observed: h.observed, evidence: h.evidence, score: Math.round(h.score * 100) / 100 })),
        ...(c.address ? [{ customer: c.customerNames.get(c.address.customerId) ?? "?", observed: c.address.address, evidence: c.address.evidence, score: 1 }] : []),
      ],
    })),
  };
}

/** Sends uncertain single-customer NAME matches to the review queue. Lines naming two customers are not queued. */
export async function queueUncertainAction(prev: CheckState, formData: FormData): Promise<CheckState> {
  await requireAdmin();
  const lines = readLines(formData.get("text"));
  if (typeof lines === "string") return { ...prev, error: lines };
  const checked = await runCheck(lines);
  const supabase = await createSupabaseServerClient();
  let queued = 0;
  let skipped = 0;
  for (const c of checked) {
    if (c.decision.outcome !== "review" || c.decision.customerIds.length !== 1 || c.names.length !== 1) {
      if (c.decision.outcome === "review") skipped++;
      continue;
    }
    const hit = c.names[0];
    const { data, error } = await supabase.rpc("review_queue_add", {
      p_observed: hit.observed,
      p_candidates: [{ customer_id: hit.customerId, score: hit.score, evidence: hit.evidence }],
      p_reason: c.decision.reason,
    });
    if (error) return { ...prev, error: short(error.message) };
    if (data) queued++;
    else skipped++;
  }
  revalidatePath("/customers/review");
  return { ...prev, queued: { queued, skipped } };
}
