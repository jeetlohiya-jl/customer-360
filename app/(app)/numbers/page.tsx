import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getExtractConfig } from "@/lib/extract/config";
import { gmailMessageUrl } from "@/lib/search/params";
import { CATEGORY_LABEL, describeValue, describeYearly, KIND_LABEL } from "@/lib/metrics/format";
import { groupMetrics, type MetricRow } from "@/lib/metrics/group";
import { reviewMetric } from "./actions";

type CustomerRow = { customer_id: string; customer_name: string; facts: number };
type SP = { customer?: string; category?: string; ok?: string; error?: string };

const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Customer numbers (0018): size, volumes, usage, forecasts and spend read from customer emails. Access is enforced in the database. */
export default async function NumbersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  if (!getExtractConfig().enabled) {
    return (
      <div className="page-head">
        <span className="eyebrow">Customer numbers</span>
        <h1 className="h1">Not switched on yet.</h1>
      </div>
    );
  }
  const sp = await searchParams;
  const customer = sp.customer && UUID.test(sp.customer) ? sp.customer : undefined;
  const category = sp.category && CATEGORY_LABEL[sp.category] ? sp.category : undefined;
  const qs = (extra: Record<string, string | undefined> = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ customer, category, ...extra })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/numbers?${s}` : "/numbers";
  };
  const supabase = await createSupabaseServerClient();
  const [{ data, error }, { data: custData }] = await Promise.all([
    supabase.rpc("customer_metrics", { p_customer: customer ?? null, p_category: category ?? null, p_limit: 1000 }),
    supabase.rpc("facts_customers"),
  ]);
  const rows = (data ?? []) as MetricRow[];
  const groups = groupMetrics(rows);
  const customers = (custData ?? []) as CustomerRow[];
  const current = customers.find((c) => c.customer_id === customer);
  const here = qs();

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Customer numbers{current ? ` · ${current.customer_name}` : ""}</span>
        <h1 className="h1">
          How big they are and <em>what they need.</em>
        </h1>
        <p className="lead">
          Production, packaging usage, forecasts, order volumes, spend and size, as stated in emails. The newest figure for each
          measure is shown first; &quot;differs&quot; means an earlier email gave a figure more than 20% apart. Yearly figures are worked
          out from the stated period (daily figures assume 260 working days).
        </p>
        {current ? <p className="small"><Link href={`/facts?customer=${current.customer_id}`}>All facts for {current.customer_name}</Link></p> : null}
      </div>
      {sp.ok ? <p className="notice">Saved.</p> : null}
      {sp.error || error ? <p className="notice alert" role="alert">That could not be completed.</p> : null}

      <section className="card section">
        <form method="get" action="/numbers" className="form-row">
          <select name="customer" defaultValue={customer ?? ""} aria-label="Customer">
            <option value="">All customers</option>
            {customers.map((c) => <option key={c.customer_id} value={c.customer_id}>{c.customer_name}</option>)}
          </select>
          <select name="category" defaultValue={category ?? ""} aria-label="Category">
            <option value="">All kinds of number</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button type="submit" className="btn-primary">Apply</button>
          <Link href="/numbers" className="small">Clear</Link>
        </form>
      </section>

      <section className="card section">
        <span className="eyebrow">{groups.length ? `${groups.length} measures from ${rows.length} figures` : "No numbers yet"}</span>
        {groups.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Customer</th><th>Kind of number</th><th>Measure</th><th>Figure</th><th>Per year</th><th>Said</th><th>Evidence</th><th>Check</th></tr></thead>
              <tbody>
                {groups.map((g) => {
                  const x = g.latest;
                  const href = x.is_mine && x.gmail_message_id ? gmailMessageUrl(x.gmail_message_id, x.mailbox_email ?? user.email) : null;
                  return (
                    <tr key={g.key}>
                      <td><Link href={qs({ customer: x.customer_id })} prefetch={false}>{x.customer_name}</Link></td>
                      <td>{CATEGORY_LABEL[x.category] ?? x.category}</td>
                      <td>{x.metric}{x.scope ? <span className="small"> · {x.scope}</span> : null}</td>
                      <td>
                        <strong>{describeValue(x)}</strong>
                        <br /><span className="small">{KIND_LABEL[x.kind] ?? x.kind}{x.as_of ? ` · for ${x.as_of}` : ""}</span>
                        {g.conflict ? (
                          <><br /><span className="small">differs: {describeValue(g.conflict)} on {fmt.format(new Date(g.conflict.message_at))}</span></>
                        ) : null}
                        {g.earlier.length ? (
                          <details>
                            <summary className="small">{g.earlier.length} earlier</summary>
                            {g.earlier.map((e) => (
                              <p className="small" key={e.metric_id}>{fmt.format(new Date(e.message_at))}: {describeValue(e)} ({KIND_LABEL[e.kind] ?? e.kind})</p>
                            ))}
                          </details>
                        ) : null}
                      </td>
                      <td className="small">{describeYearly(x) ?? ""}</td>
                      <td className="small">{fmt.format(new Date(x.message_at))} · {x.party === "cirkla" ? "Cirkla" : x.party === "customer" ? "customer" : "unclear"}</td>
                      <td className="small">
                        {x.evidence_quote ? `"${x.evidence_quote}"` : x.summary}
                        {href ? <> · <a href={href} target="_blank" rel="noreferrer noopener">open in Gmail</a></> : null}
                      </td>
                      <td className="small">
                        {x.review_state === "confirmed" ? "checked" : x.review_state === "needs_review" ? "needs review" : `AI (${Math.round(Number(x.confidence) * 100)}%)`}
                        {x.review_state !== "confirmed" && (x.is_mine || user.role === "admin") ? (
                          <form action={reviewMetric} className="inline">
                            <input type="hidden" name="metricId" value={x.metric_id} />
                            <input type="hidden" name="back" value={here} />
                            <button type="submit" name="action" value="confirm" className="btn-secondary">Correct</button>
                            <button type="submit" name="action" value="reject" className="btn-ghost">Wrong</button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small">Numbers appear here as emails are read. Past emails are read again by the one-off run in docs/phases/phase-11-customer-numbers.md.</p>
        )}
      </section>
    </>
  );
}
