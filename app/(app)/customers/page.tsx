import Link from "next/link";
import { requireAdmin } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadCustomerMaster } from "@/lib/customers/data";
import { normalizeName } from "@/lib/customers/normalize";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; error?: string }> }) {
  await requireAdmin();
  const { q, error } = await searchParams;
  const supabase = await createSupabaseServerClient();
  // In parallel: the customer list and the review queue are independent.
  const [master, { data: queue }] = await Promise.all([
    loadCustomerMaster(supabase),
    supabase.rpc("review_queue_list", { p_limit: 500 }),
  ]);

  const aliasesBy = new Map<string, string[]>();
  for (const a of master.aliases) aliasesBy.set(a.customer_id, [...(aliasesBy.get(a.customer_id) ?? []), a.alias]);
  const idsBy = new Map<string, string[]>();
  for (const i of master.identifiers) idsBy.set(i.customer_id, [...(idsBy.get(i.customer_id) ?? []), i.value]);

  const term = q ? normalizeName(q.slice(0, 100)) : "";
  const rows = master.customers.filter(
    (c) =>
      !term ||
      c.normalized_name.includes(term) ||
      (aliasesBy.get(c.id) ?? []).some((a) => normalizeName(a).includes(term)) ||
      (idsBy.get(c.id) ?? []).some((v) => v.includes(q!.trim().toLowerCase())),
  );
  const active = master.customers.filter((c) => c.status === "active").length;

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Customers</span>
        <h1 className="h1">
          The <em>customer list.</em>
        </h1>
        <p className="lead">The approved list every match is checked against. Only admins can see or change it.</p>
        <nav className="subnav" aria-label="Customer tools">
          <Link href="/customers/import">Import a CSV</Link>
          <Link href="/customers/review">Review queue ({(queue ?? []).length})</Link>
          <Link href="/customers/check">Check names</Link>
        </nav>
      </div>

      {error ? (
        <p className="notice alert" role="alert">
          {error === "invalid" ? "That request was not valid." : error}
        </p>
      ) : null}

      <div className="stats">
        <span className="stat"><strong>{master.customers.length}</strong>customers</span>
        <span className="stat"><strong>{active}</strong>active</span>
        <span className="stat"><strong>{master.aliases.length}</strong>approved names</span>
        <span className="stat"><strong>{master.identifiers.length}</strong>domains and emails</span>
      </div>

      <section className="card section">
        <form className="form-row" role="search">
          <input type="search" name="q" defaultValue={q ?? ""} placeholder="Search names, aliases, domains" aria-label="Search customers" />
          <button type="submit" className="btn-secondary">Search</button>
          {q ? <Link href="/customers" className="small">Clear</Link> : null}
        </form>
        {rows.length === 0 ? (
          <p className="small mt-16">
            {master.customers.length === 0 ? "No customers yet. Start with Import a CSV." : "No customers match that search."}
          </p>
        ) : (
          <div className="table-wrap mt-16">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Other names</th>
                  <th>Domains and emails</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 500).map((c) => (
                  <tr key={c.id}>
                    <td><Link href={`/customers/${c.id}`} prefetch={false}>{c.canonical_name}</Link></td>
                    <td className="small">{(aliasesBy.get(c.id) ?? []).slice(0, 4).join(", ")}{(aliasesBy.get(c.id)?.length ?? 0) > 4 ? " …" : ""}</td>
                    <td className="small">{(idsBy.get(c.id) ?? []).slice(0, 3).join(", ")}{(idsBy.get(c.id)?.length ?? 0) > 3 ? " …" : ""}</td>
                    <td><span className={c.status === "active" ? "pill" : "pill off"}>{c.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 500 ? <p className="fine">Showing the first 500 of {rows.length}. Narrow the search to see more.</p> : null}
          </div>
        )}
      </section>
    </>
  );
}
