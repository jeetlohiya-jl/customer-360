import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getExtractConfig } from "@/lib/extract/config";
import { addAlias, addIdentifier, removeAlias, removeIdentifier, setStatus, unmarkDistinct } from "../actions";

const OK: Record<string, string> = {
  alias: "Name added.",
  alias_removed: "Name removed.",
  identifier: "Domain or email added.",
  identifier_removed: "Domain or email removed.",
  status: "Status updated.",
  distinct_removed: "The two customers may be proposed as matches again.",
};

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { ok, error } = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();

  const supabase = await createSupabaseServerClient();
  const [{ data: customer }, { data: aliases }, { data: identifiers }, { data: distinctions }] = await Promise.all([
    supabase.from("customers").select("id, canonical_name, notes, status, created_at, updated_at").eq("id", id).maybeSingle(),
    supabase.from("customer_aliases").select("id, alias, kind, source").eq("customer_id", id).order("alias"),
    supabase.from("customer_identifiers").select("id, kind, value, shared, source").eq("customer_id", id).order("value"),
    supabase.from("customer_distinctions").select("customer_a, customer_b").or(`customer_a.eq.${id},customer_b.eq.${id}`),
  ]);
  if (!customer) notFound();

  const otherIds = (distinctions ?? []).map((d) => (d.customer_a === id ? d.customer_b : d.customer_a));
  const { data: others } = otherIds.length
    ? await supabase.from("customers").select("id, canonical_name").in("id", otherIds)
    : { data: [] as { id: string; canonical_name: string }[] };

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">
          <Link href="/customers">Customers</Link> · {customer.status}
        </span>
        <h1 className="h1">{customer.canonical_name}</h1>
        {customer.notes ? <p className="lead">{customer.notes}</p> : null}
        {getExtractConfig().enabled ? (
          <p className="small"><Link href={`/facts?customer=${customer.id}`}>Customer facts for {customer.canonical_name}</Link></p>
        ) : null}
      </div>

      {ok && OK[ok] ? <p className="notice">{OK[ok]}</p> : null}
      {error ? <p className="notice alert" role="alert">Not changed: {error === "invalid" ? "that request was not valid." : error}</p> : null}

      <div className="grid section">
        <div className="card">
          <span className="eyebrow">Approved names</span>
          <h3>Names that link to this customer</h3>
          <div className="tags">
            {(aliases ?? []).length === 0 ? <span className="small">Only the customer name itself.</span> : null}
            {(aliases ?? []).map((a) => (
              <span className="tag" key={a.id} title={`${a.kind}, added by ${a.source}`}>
                {a.alias}
                <form action={removeAlias}>
                  <input type="hidden" name="customerId" value={customer.id} />
                  <input type="hidden" name="aliasId" value={a.id} />
                  <button type="submit" aria-label={`Remove ${a.alias}`}>×</button>
                </form>
              </span>
            ))}
          </div>
          <form action={addAlias} className="form-row">
            <input type="hidden" name="customerId" value={customer.id} />
            <input type="text" name="alias" required maxLength={200} placeholder="Another name" aria-label="Another name" />
            <select name="kind" defaultValue="alias" aria-label="Kind of name">
              <option value="alias">alias</option>
              <option value="trading">trading name</option>
              <option value="legal">legal name</option>
            </select>
            <button type="submit" className="btn-secondary">Add</button>
          </form>
        </div>

        <div className="card">
          <span className="eyebrow">Verified domains and emails</span>
          <h3>Strong evidence for matching</h3>
          <div className="tags">
            {(identifiers ?? []).length === 0 ? <span className="small">None yet. Matching relies on names only.</span> : null}
            {(identifiers ?? []).map((i) => (
              <span className="tag" key={i.id}>
                {i.value}
                {i.shared ? " (shared)" : ""}
                <form action={removeIdentifier}>
                  <input type="hidden" name="customerId" value={customer.id} />
                  <input type="hidden" name="identifierId" value={i.id} />
                  <button type="submit" aria-label={`Remove ${i.value}`}>×</button>
                </form>
              </span>
            ))}
          </div>
          <form action={addIdentifier} className="form-row">
            <input type="hidden" name="customerId" value={customer.id} />
            <select name="kind" defaultValue="domain" aria-label="Domain or email">
              <option value="domain">domain</option>
              <option value="email">email</option>
            </select>
            <input type="text" name="value" required maxLength={254} placeholder="acme.com" aria-label="Domain or email" />
            <label>
              <input type="checkbox" name="shared" /> shared (distributor, group)
            </label>
            <button type="submit" className="btn-secondary">Add</button>
          </form>
        </div>
      </div>

      <div className="grid section">
        <div className="card cream">
          <span className="eyebrow">Different businesses</span>
          <h3>Never proposed as this customer</h3>
          <div className="tags">
            {(others ?? []).length === 0 ? <span className="small">None.</span> : null}
            {(others ?? []).map((o) => (
              <span className="tag" key={o.id}>
                <Link href={`/customers/${o.id}`}>{o.canonical_name}</Link>
                <form action={unmarkDistinct}>
                  <input type="hidden" name="customerId" value={customer.id} />
                  <input type="hidden" name="otherId" value={o.id} />
                  <button type="submit" aria-label={`Allow ${o.canonical_name} to be proposed again`}>×</button>
                </form>
              </span>
            ))}
          </div>
        </div>
        <div className="card cream">
          <span className="eyebrow">Status</span>
          <h3>{customer.status === "active" ? "Active: used for matching" : "Inactive: not matched"}</h3>
          <form action={setStatus} className="form-row">
            <input type="hidden" name="customerId" value={customer.id} />
            <input type="hidden" name="status" value={customer.status === "active" ? "inactive" : "active"} />
            <button type="submit" className="btn-secondary">{customer.status === "active" ? "Mark inactive" : "Mark active"}</button>
          </form>
          <p className="fine">Customers are never deleted. Marking a customer inactive also removes its stored email links (they return if a later scan runs after reactivation). Every change is recorded in the audit log.</p>
        </div>
      </div>
    </>
  );
}
