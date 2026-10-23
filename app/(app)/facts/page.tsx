import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getExtractConfig } from "@/lib/extract/config";
import { decodeCursor, encodeCursor, gmailMessageUrl } from "@/lib/search/params";
import { correctFact, reviewFact } from "./actions";

type Fact = {
  fact_id: string; customer_id: string; customer_name: string; fact_type: string; stance: string; party: string; basis: string;
  status: string; status_basis: string; stale: boolean; resolves_fact_id: string | null;
  product: string | null; quantity: number | null; unit: string | null; unit_price: number | null; currency: string | null; price_basis: string | null;
  due_date: string | null; due_text: string | null; reference: string | null; summary: string; evidence_quote: string | null;
  confidence: number; review_state: string; message_at: string; direction: string; is_mine: boolean; source_owner_email: string | null; gmail_message_id: string | null;
};
type ReviewRow = { fact_id: string; customer_id: string; customer_name: string; fact_type: string; stance: string; status: string; summary: string; evidence_quote: string | null; confidence: number; review_reasons: string[]; message_at: string; is_mine: boolean };
type CustomerRow = { customer_id: string; customer_name: string; facts: number; open_facts: number; needs_review: number; last_fact_at: string };

const TYPE: Record<string, string> = { requirement: "Requirement", order: "Order", pricing: "Pricing", delivery: "Delivery", quality_issue: "Quality issue", follow_up: "Follow-up" };
const STANCE: Record<string, string> = { request: "Requested", proposal: "Proposed", commitment: "Agreed", report: "Reported", cancellation: "Cancelled" };
const REASON: Record<string, string> = {
  low_confidence: "low confidence", commitment_needs_check: "commitment to check", inferred_status: "status inferred, not stated",
  quote_not_found: "quote not in email", no_quote: "no quote", number_not_in_text: "number not in email", date_not_in_text: "date not in email",
  unknown_currency: "unknown currency", price_without_currency: "price without currency", stance_downgraded: "AI said agreed; wording is a request or offer",
  inferred_commitment: "commitment only inferred", commitment_unverified: "commitment without evidence", unknown_related_fact: "unknown earlier fact",
  other_customer: "may be another company", truncated_email: "long email, cut", possible_injection: "email tries to instruct the AI",
};
const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function statusLabel(f: Fact): string {
  if (f.status === "not_applicable" || f.status === "unknown") return "";
  const s = f.status === "open" && f.stale ? "open, no recent update" : f.status;
  return `${s} (${f.status_basis === "inferred" ? "inferred" : "stated"})`;
}
function details(f: Fact): string {
  return [
    f.product,
    f.quantity !== null ? `${Number(f.quantity).toLocaleString("en-US")}${f.unit ? ` ${f.unit}` : ""}` : null,
    f.unit_price !== null ? `${f.currency} ${f.unit_price}${f.price_basis ? ` ${f.price_basis}` : ""}` : null,
    f.due_date ? `due ${f.due_date}` : f.due_text,
    f.reference,
  ].filter(Boolean).join(" · ");
}

type SP = { q?: string; customer?: string; type?: string; status?: string; stance?: string; review?: string; from?: string; to?: string; after?: string; ok?: string; error?: string };

/** Stage C (behind FEATURE_EXTRACT): inspect, search and review stored customer facts. Access is enforced in the database. */
export default async function FactsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  if (!getExtractConfig().enabled) {
    return (
      <div className="page-head">
        <span className="eyebrow">Customer facts</span>
        <h1 className="h1">Not switched on yet.</h1>
        <p className="lead">Fact extraction is built but disabled until it is approved.</p>
      </div>
    );
  }
  const sp = await searchParams;
  const f = {
    q: sp.q && sp.q.trim().length >= 2 ? sp.q.trim().slice(0, 100) : undefined,
    customer: sp.customer && UUID.test(sp.customer) ? sp.customer : undefined,
    type: sp.type && TYPE[sp.type] ? sp.type : undefined,
    status: sp.status && ["open", "resolved", "cancelled"].includes(sp.status) ? sp.status : undefined,
    stance: sp.stance && STANCE[sp.stance] ? sp.stance : undefined,
    review: sp.review && ["unreviewed", "needs_review", "reviewed"].includes(sp.review) ? sp.review : undefined,
    from: sp.from && DAY.test(sp.from) ? sp.from : undefined,
    to: sp.to && DAY.test(sp.to) ? sp.to : undefined,
  };
  const cursor = sp.after ? decodeCursor(sp.after) : undefined;
  const qs = (extra: Record<string, string | undefined> = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/facts?${s}` : "/facts";
  };
  const here = qs({ after: sp.after });
  const PAGE = 50;
  const supabase = await createSupabaseServerClient();
  const [{ data: factsData, error }, { data: queueData }, { data: custData }] = await Promise.all([
    supabase.rpc("facts_search", {
      p_query: f.q ?? null, p_customer: f.customer ?? null, p_type: f.type ?? null, p_status: f.status ?? null,
      p_from: f.from ?? null, p_to: f.to ?? null, p_cursor_at: cursor?.at ?? null, p_cursor_id: cursor?.id ?? null,
      p_limit: PAGE + 1, p_stance: f.stance ?? null, p_review: f.review ?? null,
    }),
    supabase.rpc("facts_review_queue", { p_limit: 50 }),
    supabase.rpc("facts_customers"),
  ]);
  const all = (factsData ?? []) as Fact[];
  const facts = all.slice(0, PAGE);
  const next = all.length > PAGE ? encodeCursor({ at: facts[PAGE - 1].message_at, id: facts[PAGE - 1].fact_id }) : undefined;
  const queue = ((queueData ?? []) as ReviewRow[]).filter((r) => !f.customer || r.customer_id === f.customer);
  const customers = (custData ?? []) as CustomerRow[];
  const current = customers.find((c) => c.customer_id === f.customer);

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Customer facts{current ? ` · ${current.customer_name}` : ""}</span>
        <h1 className="h1">
          What customers <em>asked, agreed and reported.</em>
        </h1>
        <p className="lead">
          Extracted by AI from customer emails, each with a short quote as evidence. &quot;Requested&quot; and &quot;Proposed&quot; are
          not agreements. &quot;AI-extracted&quot; means no person has checked it yet.
        </p>
      </div>
      {sp.ok ? <p className="notice">Saved.</p> : null}
      {sp.error || error ? <p className="notice alert" role="alert">That could not be completed. Check the values and try again.</p> : null}

      <section className="card section">
        <form method="get" action="/facts">
          <div className="form-row">
            <input name="q" type="search" defaultValue={f.q ?? ""} maxLength={100} placeholder="Product, PO, lot, words in a fact" aria-label="Search facts" />
            <select name="customer" defaultValue={f.customer ?? ""} aria-label="Customer">
              <option value="">All customers</option>
              {customers.map((c) => <option key={c.customer_id} value={c.customer_id}>{c.customer_name} ({c.facts})</option>)}
            </select>
            <select name="type" defaultValue={f.type ?? ""} aria-label="Fact type">
              <option value="">All types</option>
              {Object.entries(TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select name="stance" defaultValue={f.stance ?? ""} aria-label="Stance">
              <option value="">Any stance</option>
              {Object.entries(STANCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="form-row">
            <select name="status" defaultValue={f.status ?? ""} aria-label="Status">
              <option value="">Any status</option>
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select name="review" defaultValue={f.review ?? ""} aria-label="Review state">
              <option value="">Any review state</option>
              <option value="unreviewed">AI-extracted, unchecked</option>
              <option value="needs_review">Needs review</option>
              <option value="reviewed">Reviewed by a person</option>
            </select>
            <label htmlFor="from">From</label>
            <input id="from" name="from" type="date" defaultValue={f.from ?? ""} />
            <label htmlFor="to">To</label>
            <input id="to" name="to" type="date" defaultValue={f.to ?? ""} />
            <button type="submit" className="btn-primary">Apply</button>
            <Link href="/facts" className="small">Clear</Link>
          </div>
        </form>
      </section>

      {!f.customer && customers.length ? (
        <section className="card section">
          <span className="eyebrow">Customers with facts · {customers.length}</span>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Customer</th><th>Facts</th><th>Open</th><th>Needs review</th><th>Latest</th></tr></thead>
              <tbody>
                {customers.slice(0, 50).map((c) => (
                  <tr key={c.customer_id}>
                    <td><Link href={qs({ customer: c.customer_id })}>{c.customer_name}</Link></td>
                    <td>{c.facts}</td><td>{c.open_facts}</td><td>{c.needs_review}</td><td>{fmt.format(new Date(c.last_fact_at))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {queue.length ? (
        <section className="card section">
          <span className="eyebrow">Needs review · {queue.length}</span>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Customer</th><th>Fact</th><th>Why</th><th>Evidence</th><th>Decision</th></tr></thead>
              <tbody>
                {queue.map((r) => (
                  <tr key={r.fact_id}>
                    <td>{fmt.format(new Date(r.message_at))}</td>
                    <td>{r.customer_name}</td>
                    <td>{TYPE[r.fact_type] ?? r.fact_type} · {STANCE[r.stance] ?? r.stance}: {r.summary}</td>
                    <td className="small">{r.review_reasons.map((x) => REASON[x] ?? x).join("; ")}</td>
                    <td className="small">{r.evidence_quote ? `"${r.evidence_quote}"` : "none"}</td>
                    <td>
                      <form action={reviewFact} className="inline">
                        <input type="hidden" name="factId" value={r.fact_id} />
                        <input type="hidden" name="back" value={here} />
                        <button type="submit" name="action" value="confirm" className="btn-secondary">Correct</button>
                        <button type="submit" name="action" value="reject" className="btn-ghost">Wrong</button>
                      </form>
                      <details>
                        <summary className="small">Fix it</summary>
                        <form action={correctFact} className="form-row">
                          <input type="hidden" name="factId" value={r.fact_id} />
                          <input type="hidden" name="back" value={here} />
                          <select name="stance" defaultValue="" aria-label="Stance">
                            <option value="">Stance unchanged</option>
                            {Object.entries(STANCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                          </select>
                          <select name="status" defaultValue="" aria-label="Status">
                            <option value="">Status unchanged</option>
                            <option value="open">Open</option><option value="resolved">Resolved</option><option value="cancelled">Cancelled</option>
                          </select>
                          <input name="quantity" type="text" inputMode="decimal" placeholder="Quantity" aria-label="Quantity" />
                          <input name="unit_price" type="text" inputMode="decimal" placeholder="Unit price" aria-label="Unit price" />
                          <input name="currency" type="text" maxLength={3} placeholder="USD" aria-label="Currency" />
                          <input name="due_date" type="date" aria-label="Due date" />
                          <input name="summary" type="text" maxLength={300} placeholder="Corrected summary" aria-label="Summary" />
                          <input name="note" type="text" maxLength={300} placeholder="Note (optional)" aria-label="Note" />
                          <button type="submit" className="btn-secondary">Save correction</button>
                        </form>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="card section">
        <span className="eyebrow">{facts.length ? `${facts.length}${next ? "+" : ""} facts${cursor ? " · later page" : ""}` : "No facts match"}</span>
        {facts.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Email date</th><th>Customer</th><th>Type</th><th>What</th><th>Details</th><th>Status</th><th>Evidence and source</th><th>Check</th></tr></thead>
              <tbody>
                {facts.map((x) => {
                  const href = x.is_mine && x.gmail_message_id ? gmailMessageUrl(x.gmail_message_id, user.email) : null;
                  return (
                    <tr key={x.fact_id}>
                      <td>{fmt.format(new Date(x.message_at))}</td>
                      <td><Link href={qs({ customer: x.customer_id, after: undefined })}>{x.customer_name}</Link></td>
                      <td>{TYPE[x.fact_type] ?? x.fact_type}</td>
                      <td>{STANCE[x.stance] ?? x.stance}{x.basis === "inferred" ? " (inferred)" : ""} by {x.party === "cirkla" ? "Cirkla" : x.party}: {x.summary}</td>
                      <td className="small">{details(x)}</td>
                      <td>{statusLabel(x)}</td>
                      <td className="small">
                        {x.evidence_quote ? `"${x.evidence_quote}"` : ""}
                        <br />
                        {x.direction === "inbound" ? "from customer" : x.direction === "internal" ? "internal (Cirkla only)" : "to customer"}
                        {x.source_owner_email ? ` · ${x.source_owner_email}` : x.is_mine ? " · your mailbox" : ""}
                        {href ? <> · <a href={href} target="_blank" rel="noreferrer noopener">open in Gmail</a></> : null}
                      </td>
                      <td className="small">{x.review_state === "needs_review" ? "needs review" : x.review_state === "auto" ? `AI-extracted (${Math.round(x.confidence * 100)}%)` : "reviewed"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        <div className="card-actions">
          {cursor ? <Link href={qs()} className="small">First page</Link> : null}
          {next ? <Link href={qs({ after: next })} className="btn-secondary">Next page</Link> : null}
        </div>
      </section>
    </>
  );
}
