import Link from "next/link";
import { requireAdmin } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { removeRejection, resolveReview } from "../actions";

type QueueItem = {
  id: string;
  observed: string;
  candidates: { customer_id: string; score: number; evidence: string }[];
  reason: string;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  expires_at: string;
};

const OK: Record<string, string> = {
  same_customer: "Saved as an approved name. It won't be asked again.",
  not_a_customer: "Marked as not a customer. It won't be asked again.",
  rejection_removed: "Rejection removed; the name can be proposed again.",
};

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireAdmin();
  const { ok, error } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const [{ data: queue }, { data: customers }, { data: rejections }] = await Promise.all([
    supabase.rpc("review_queue_list", { p_limit: 200 }),
    supabase.from("customers").select("id, canonical_name").eq("status", "active").order("normalized_name").limit(1000),
    supabase.from("name_rejections").select("normalized, decided_at").order("decided_at", { ascending: false }).limit(100),
  ]);
  const items = (queue ?? []) as QueueItem[];
  const nameOf = new Map((customers ?? []).map((c) => [c.id, c.canonical_name]));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">
          <Link href="/customers">Customers</Link> · Review
        </span>
        <h1 className="h1">
          Uncertain <em>matches.</em>
        </h1>
        <p className="lead">
          One decision per spelling applies everywhere. Only the name as written is shown, never an email. Unreviewed items expire after 30 days.
        </p>
      </div>

      {ok && OK[ok] ? <p className="notice">{OK[ok]}</p> : null}
      {error ? <p className="notice alert" role="alert">Not saved: {error === "invalid" ? "that request was not valid." : error}</p> : null}

      <section className="card section">
        <span className="eyebrow">01 · Queue · {items.length} open</span>
        {items.length === 0 ? (
          <p className="small mt-16">Nothing to review. In this stage, names reach the queue from <Link href="/customers/check">Check names</Link>.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name as written</th>
                  <th>Why it is here</th>
                  <th>Seen</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td><strong>{it.observed}</strong></td>
                    <td className="small">
                      {it.reason}
                      {it.candidates.length ? (
                        <div className="fine">Suggested: {it.candidates.map((c) => nameOf.get(c.customer_id) ?? "inactive customer").join(", ")}</div>
                      ) : null}
                    </td>
                    <td className="small">
                      {it.occurrences}× · {day(it.first_seen)} to {day(it.last_seen)}
                      <div className="fine">expires {day(it.expires_at)}</div>
                    </td>
                    <td>
                      <form action={resolveReview} className="form-row">
                        <input type="hidden" name="itemId" value={it.id} />
                        <input type="hidden" name="action" value="same_customer" />
                        <select name="customerId" defaultValue={it.candidates[0]?.customer_id ?? ""} required aria-label={`Customer for ${it.observed}`}>
                          <option value="" disabled>Choose customer…</option>
                          {it.candidates.filter((c) => nameOf.has(c.customer_id)).map((c) => (
                            <option key={`s-${c.customer_id}`} value={c.customer_id}>{nameOf.get(c.customer_id)} (suggested)</option>
                          ))}
                          {(customers ?? []).filter((c) => !it.candidates.some((x) => x.customer_id === c.id)).map((c) => (
                            <option key={c.id} value={c.id}>{c.canonical_name}</option>
                          ))}
                        </select>
                        <button type="submit" className="btn-secondary">Same customer</button>
                      </form>
                      <form action={resolveReview} className="form-row">
                        <input type="hidden" name="itemId" value={it.id} />
                        <input type="hidden" name="action" value="not_a_customer" />
                        <button type="submit" className="btn-ghost">Not a customer</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card cream section">
        <span className="eyebrow">02 · Marked &quot;not a customer&quot;</span>
        <p className="small">These spellings are never proposed again. Remove one to undo the decision.</p>
        <div className="tags mt-16">
          {(rejections ?? []).length === 0 ? <span className="small">None.</span> : null}
          {(rejections ?? []).map((r) => (
            <span className="tag" key={r.normalized}>
              {r.normalized}
              <form action={removeRejection}>
                <input type="hidden" name="normalized" value={r.normalized} />
                <button type="submit" aria-label={`Undo: ${r.normalized}`}>×</button>
              </form>
            </span>
          ))}
        </div>
        <p className="fine mt-16">To undo a &quot;same customer&quot; decision, remove the name from that customer&apos;s page.</p>
      </section>
    </>
  );
}
