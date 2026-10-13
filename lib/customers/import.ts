/**
 * Customer CSV import: preview (validation + duplicate detection) and the
 * commit payload sent to public.import_customers(). Pure functions.
 *
 * The server re-runs the preview at commit time against fresh data and never
 * trusts a preview sent back from the browser.
 */
import { CsvError, parseCsv, splitList } from "./csv";
import { buildIndex, findNames, type CustomerRecord, type NameKind } from "./matcher";
import { isFreemailDomain, normalizeDomain, normalizeEmail, normalizeName, emailDomain } from "./normalize";

export const CSV_COLUMNS = [
  "canonical_name",
  "legal_names",
  "trading_names",
  "aliases",
  "domains",
  "shared_domains",
  "emails",
  "notes",
  "status",
] as const;

export type RowStatus = "new" | "update" | "possible_duplicate" | "rejected";

export interface Candidate {
  customerId?: string; // existing customer
  line?: number; // another row in this file
  name: string;
  reason: string;
}

export interface PreviewRow {
  line: number;
  status: RowStatus;
  canonicalName: string;
  normalized: string;
  names: { value: string; kind: Exclude<NameKind, "canonical"> }[];
  domains: { value: string; shared: boolean }[];
  emails: string[];
  notes: string | null;
  statusValue: "active" | "inactive" | null;
  existingId?: string;
  candidates: Candidate[];
  errors: string[];
  warnings: string[];
}

export interface Preview {
  rows: PreviewRow[];
  summary: Record<RowStatus, number> & { total: number };
  ignoredColumns: string[];
  fileErrors: string[];
}

export interface ExistingData {
  customers: CustomerRecord[]; // all customers, active and inactive
  distinctions: [string, string][];
  workspaceDomain: string;
}

const emptySummary = () => ({ total: 0, new: 0, update: 0, possible_duplicate: 0, rejected: 0 });

export function previewImport(csvText: string, existing: ExistingData): Preview {
  let table: string[][];
  try {
    table = parseCsv(csvText);
  } catch (e) {
    return { rows: [], summary: emptySummary(), ignoredColumns: [], fileErrors: [e instanceof CsvError ? e.message : "Could not read the file."] };
  }
  if (table.length === 0) return { rows: [], summary: emptySummary(), ignoredColumns: [], fileErrors: ["The file is empty."] };

  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = new Map<string, number>();
  header.forEach((h, i) => {
    if ((CSV_COLUMNS as readonly string[]).includes(h) && !col.has(h)) col.set(h, i);
  });
  const fileErrors: string[] = [];
  if (!col.has("canonical_name")) fileErrors.push('The header row must include a "canonical_name" column.');
  const ignoredColumns = header.filter((h) => h && !(CSV_COLUMNS as readonly string[]).includes(h));
  if (fileErrors.length) return { rows: [], summary: emptySummary(), ignoredColumns, fileErrors };
  if (table.length === 1) return { rows: [], summary: emptySummary(), ignoredColumns, fileErrors: ["The file has a header but no customer rows."] };

  const ws = existing.workspaceDomain.toLowerCase();
  const get = (r: string[], c: string) => (col.has(c) ? (r[col.get(c)!] ?? "").trim() : "");

  // Lookups over existing customers.
  const ownerOfName = new Map<string, { id: string; canonical: boolean }>();
  const ownerOfDomain = new Map<string, string>();
  const ownerOfEmail = new Map<string, string>();
  const byId = new Map(existing.customers.map((c) => [c.id, c]));
  for (const c of existing.customers) {
    ownerOfName.set(normalizeName(c.canonicalName), { id: c.id, canonical: true });
    for (const n of c.names) {
      const k = normalizeName(n.value);
      if (k && !ownerOfName.has(k)) ownerOfName.set(k, { id: c.id, canonical: false });
    }
    for (const d of c.domains) ownerOfDomain.set(d.value, c.id);
    for (const e of c.emails) ownerOfEmail.set(e, c.id);
  }

  // Lookups within the file.
  const fileName = new Map<string, number>();
  const fileDomain = new Map<string, number>();
  const fileEmail = new Map<string, number>();

  const rows: PreviewRow[] = [];
  table.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const canonicalName = get(r, "canonical_name");
    const normalized = normalizeName(canonicalName);

    if (!canonicalName) errors.push("Missing canonical_name.");
    else if (!normalized) errors.push("canonical_name has no letters or digits.");
    else if (canonicalName.length > 200) errors.push("canonical_name is longer than 200 characters.");

    const names: PreviewRow["names"] = [];
    const seenNames = new Set([normalized]);
    for (const [column, kind] of [["legal_names", "legal"], ["trading_names", "trading"], ["aliases", "alias"]] as const) {
      for (const value of splitList(get(r, column))) {
        const n = normalizeName(value);
        if (!n) {
          errors.push(`${column}: "${value}" has no letters or digits.`);
          continue;
        }
        if (value.length > 200) {
          errors.push(`${column}: a name is longer than 200 characters.`);
          continue;
        }
        if (seenNames.has(n)) continue;
        seenNames.add(n);
        names.push({ value, kind });
      }
    }

    const domains: PreviewRow["domains"] = [];
    for (const [column, shared] of [["domains", false], ["shared_domains", true]] as const) {
      for (const value of splitList(get(r, column))) {
        const d = normalizeDomain(value);
        if (!d) errors.push(`${column}: "${value}" is not a valid domain.`);
        else if (d === ws) errors.push(`${column}: ${d} is Cirkla's own domain.`);
        else if (isFreemailDomain(d)) errors.push(`${column}: ${d} is a free email provider, not a customer domain.`);
        else if (domains.some((x) => x.value === d)) errors.push(`${d} is listed twice in this row.`);
        else domains.push({ value: d, shared });
      }
    }

    const emails: string[] = [];
    for (const value of splitList(get(r, "emails"))) {
      const e = normalizeEmail(value);
      if (!e) errors.push(`emails: "${value}" is not a valid email address.`);
      else if (emailDomain(e) === ws) errors.push(`emails: ${e} is a Cirkla address.`);
      else if (!emails.includes(e)) emails.push(e);
    }

    const statusRaw = get(r, "status").toLowerCase();
    let statusValue: PreviewRow["statusValue"] = null;
    if (statusRaw === "active" || statusRaw === "inactive") statusValue = statusRaw;
    else if (statusRaw) errors.push('status must be "active" or "inactive".');

    const notesRaw = get(r, "notes");
    if (notesRaw.length > 1000) errors.push("notes are longer than 1,000 characters.");
    const notes = notesRaw || null;

    if (domains.length === 0 && emails.length === 0 && errors.length === 0) {
      warnings.push("No domain or email: matching will rely on names only.");
    }

    // Conflicts inside the file.
    if (normalized && fileName.has(normalized)) errors.push(`Same customer name as line ${fileName.get(normalized)}.`);
    for (const n of names) {
      const k = normalizeName(n.value);
      if (fileName.has(k)) errors.push(`"${n.value}" is already used on line ${fileName.get(k)}.`);
    }
    for (const d of domains) if (fileDomain.has(d.value)) errors.push(`${d.value} is already used on line ${fileDomain.get(d.value)}.`);
    for (const e of emails) if (fileEmail.has(e)) errors.push(`${e} is already used on line ${fileEmail.get(e)}.`);

    // Existing customers: same name means update; anything owned by another customer is a conflict.
    let existingId: string | undefined;
    const sameName = normalized ? ownerOfName.get(normalized) : undefined;
    if (sameName) {
      existingId = sameName.id;
      if (!sameName.canonical) warnings.push(`Matches an existing alias of "${byId.get(sameName.id)?.canonicalName}"; details will be added to that customer.`);
    }
    for (const n of names) {
      const o = ownerOfName.get(normalizeName(n.value));
      if (o && o.id !== existingId) errors.push(`"${n.value}" already belongs to "${byId.get(o.id)?.canonicalName}".`);
    }
    for (const d of domains) {
      const o = ownerOfDomain.get(d.value);
      if (o && o !== existingId) errors.push(`${d.value} already belongs to "${byId.get(o)?.canonicalName}".`);
    }
    for (const e of emails) {
      const o = ownerOfEmail.get(e);
      if (o && o !== existingId) errors.push(`${e} already belongs to "${byId.get(o)?.canonicalName}".`);
    }

    if (errors.length === 0) {
      if (normalized) fileName.set(normalized, line);
      for (const n of names) fileName.set(normalizeName(n.value), line);
      for (const d of domains) fileDomain.set(d.value, line);
      for (const e of emails) fileEmail.set(e, line);
    }

    rows.push({
      line,
      status: errors.length ? "rejected" : existingId ? "update" : "new",
      canonicalName,
      normalized,
      names,
      domains,
      emails,
      notes,
      statusValue,
      existingId,
      candidates: [],
      errors,
      warnings,
    });
  });

  // Possible duplicates: similar names to existing customers or to earlier rows.
  const existingIndex = buildIndex({ customers: existing.customers, distinctions: existing.distinctions, rejections: [], includeInactive: true });
  const newRows = rows.filter((r) => r.status === "new");
  const fileIndex = buildIndex({
    customers: newRows.map((r) => ({
      id: `row:${r.line}`,
      canonicalName: r.canonicalName,
      status: "active" as const,
      names: r.names,
      domains: [],
      emails: [],
    })),
    distinctions: [],
    rejections: [],
  });

  for (const r of newRows) {
    for (const h of findNames(existingIndex, r.canonicalName)) {
      if (h.evidence === "E3-generic") continue;
      const c = byId.get(h.customerId)!;
      r.candidates.push({
        customerId: c.id,
        name: c.canonicalName,
        reason: h.evidence === "E4" ? `similar spelling ("${h.observed}" vs "${h.matched}")` : `contains the name "${h.matched}"`,
      });
    }
    for (const h of findNames(fileIndex, r.canonicalName, { exclude: `row:${r.line}` })) {
      const otherLine = Number(h.customerId.slice(4));
      if (otherLine >= r.line || h.evidence === "E3-generic") continue;
      r.candidates.push({ line: otherLine, name: rows.find((x) => x.line === otherLine)!.canonicalName, reason: `similar to line ${otherLine}` });
    }
    if (r.candidates.length) r.status = "possible_duplicate";
  }

  const summary = emptySummary();
  for (const r of rows) {
    summary.total++;
    summary[r.status]++;
  }
  return { rows, summary, ignoredColumns, fileErrors: [] };
}

export interface CommitRow {
  ref: number;
  action: "create" | "update";
  customer_id: string | null;
  canonical_name: string;
  names: { value: string; kind: "legal" | "trading" | "alias" }[];
  domains: { value: string; shared: boolean }[];
  emails: string[];
  notes: string | null;
  status: "active" | "inactive" | null;
  distinct_from_customers: string[];
  distinct_from_refs: number[];
}

export interface CommitPlan {
  rows: CommitRow[];
  counts: { create: number; update: number; skipped: number; rejected: number };
  missingDecisions: number[];
  invalidDecisions: number[];
}

/**
 * Decisions apply to possible duplicates only: "create", "skip", or
 * "merge:<customer id>" (one of that row's existing candidates).
 */
export function planCommit(preview: Preview, decisions: Record<number, string>): CommitPlan {
  const counts = { create: 0, update: 0, skipped: 0, rejected: 0 };
  const missingDecisions: number[] = [];
  const invalidDecisions: number[] = [];
  const out: CommitRow[] = [];
  const created = new Set<number>();

  const base = (r: PreviewRow): Omit<CommitRow, "action" | "customer_id"> => ({
    ref: r.line,
    canonical_name: r.canonicalName,
    names: r.names,
    domains: r.domains,
    emails: r.emails,
    notes: r.notes,
    status: r.statusValue,
    distinct_from_customers: [],
    distinct_from_refs: [],
  });

  for (const r of preview.rows) {
    if (r.status === "rejected") {
      counts.rejected++;
      continue;
    }
    if (r.status === "new") {
      out.push({ ...base(r), action: "create", customer_id: null });
      created.add(r.line);
      counts.create++;
      continue;
    }
    if (r.status === "update") {
      out.push({ ...base(r), action: "update", customer_id: r.existingId! });
      counts.update++;
      continue;
    }
    const d = decisions[r.line];
    if (!d) {
      missingDecisions.push(r.line);
      continue;
    }
    if (d === "skip") {
      counts.skipped++;
      continue;
    }
    if (d === "create") {
      out.push({
        ...base(r),
        action: "create",
        customer_id: null,
        distinct_from_customers: r.candidates.flatMap((c) => (c.customerId ? [c.customerId] : [])),
        distinct_from_refs: r.candidates.flatMap((c) => (c.line ? [c.line] : [])),
      });
      created.add(r.line);
      counts.create++;
      continue;
    }
    const target = d.startsWith("merge:") ? d.slice(6) : "";
    if (!target || !r.candidates.some((c) => c.customerId === target)) {
      invalidDecisions.push(r.line);
      continue;
    }
    // Merge: the row's name becomes an alias of the existing customer; notes and status are not changed.
    out.push({
      ...base(r),
      action: "update",
      customer_id: target,
      names: [{ value: r.canonicalName, kind: "alias" }, ...r.names],
      notes: null,
      status: null,
    });
    counts.update++;
  }

  for (const row of out) row.distinct_from_refs = row.distinct_from_refs.filter((ref) => created.has(ref));
  return { rows: out, counts, missingDecisions, invalidDecisions };
}
