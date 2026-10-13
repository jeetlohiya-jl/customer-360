import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerRecord, NameKind } from "./matcher";

/**
 * Loads the customer master through the signed-in admin's session (Row Level
 * Security limits these tables to admins). Pages through results because the
 * Data API returns at most 1,000 rows per request.
 */
const PAGE = 1000;
const MAX_ROWS = 50_000;

async function fetchAll<T>(supabase: SupabaseClient, table: string, columns: string, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase.from(table).select(columns).order(order).range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read ${table}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export interface CustomerRow {
  id: string;
  canonical_name: string;
  normalized_name: string;
  notes: string | null;
  status: "active" | "inactive";
  updated_at: string;
}
export interface AliasRow {
  id: string;
  customer_id: string;
  alias: string;
  kind: Exclude<NameKind, "canonical">;
  normalized: string;
  source: string;
}
export interface IdentifierRow {
  id: string;
  customer_id: string;
  kind: "domain" | "email";
  value: string;
  shared: boolean;
  source: string;
}

export interface CustomerMaster {
  customers: CustomerRow[];
  aliases: AliasRow[];
  identifiers: IdentifierRow[];
  distinctions: [string, string][];
  rejections: string[];
}

export async function loadCustomerMaster(supabase: SupabaseClient): Promise<CustomerMaster> {
  const [customers, aliases, identifiers, distinctions, rejections] = await Promise.all([
    fetchAll<CustomerRow>(supabase, "customers", "id, canonical_name, normalized_name, notes, status, updated_at", "normalized_name"),
    fetchAll<AliasRow>(supabase, "customer_aliases", "id, customer_id, alias, kind, normalized, source", "normalized"),
    fetchAll<IdentifierRow>(supabase, "customer_identifiers", "id, customer_id, kind, value, shared, source", "value"),
    fetchAll<{ customer_a: string; customer_b: string }>(supabase, "customer_distinctions", "customer_a, customer_b", "customer_a"),
    fetchAll<{ normalized: string }>(supabase, "name_rejections", "normalized", "normalized"),
  ]);
  return {
    customers,
    aliases,
    identifiers,
    distinctions: distinctions.map((d) => [d.customer_a, d.customer_b] as [string, string]),
    rejections: rejections.map((r) => r.normalized),
  };
}

export function toRecords(master: CustomerMaster): CustomerRecord[] {
  const byCustomer = new Map<string, CustomerRecord>();
  for (const c of master.customers) {
    byCustomer.set(c.id, { id: c.id, canonicalName: c.canonical_name, status: c.status, names: [], domains: [], emails: [] });
  }
  for (const a of master.aliases) byCustomer.get(a.customer_id)?.names.push({ value: a.alias, kind: a.kind });
  for (const i of master.identifiers) {
    const rec = byCustomer.get(i.customer_id);
    if (!rec) continue;
    if (i.kind === "domain") rec.domains.push({ value: i.value, shared: i.shared });
    else rec.emails.push(i.value);
  }
  return [...byCustomer.values()];
}
