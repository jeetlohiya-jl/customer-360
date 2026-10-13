import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { gmailMessageUrl, pageHref, paginate, parseSearchParams, rpcArgs, type SearchParams } from "@/lib/search/params";

type Row = {
  link_id: string;
  customer_id: string;
  customer_name: string;
  mailbox_email: string;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  message_at: string;
  direction: "inbound" | "outbound";
  customer_addresses: string[];
  link_status: string;
  matched_on: string[];
};
type LinkedCustomer = { customer_id: string; customer_name: string; link_count: number };
type CountRow = { customer_id: string; customer_name: string; link_count: number; mailbox_count: number };

const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/**
 * Stage 3.2 search. Employees search their OWN customer-linked email
 * references; the database enforces this. Admins additionally see aggregate
 * counts per customer (no message references, no per-mailbox split).
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const parsed = parseSearchParams(await searchParams);
  const params: SearchParams = parsed.ok ? parsed.params : {};
  const supabase = await createSupabaseServerClient();

  const [{ data: customersData }, search] = await Promise.all([
    supabase.rpc("my_linked_customers"),
    parsed.ok ? supabase.rpc("search_my_links", rpcArgs(params)) : Promise.resolve({ data: [], error: null }),
  ]);
  const customers = (customersData ?? []) as LinkedCustomer[];
  const failed = Boolean(search.error);
  const { rows, next } = paginate(((search.data ?? []) as Row[]) ?? []);
  const myMailbox = rows[0]?.mailbox_email;

  let counts: CountRow[] = [];
  let countsFailed = false;
  if (user.role === "admin" && parsed.ok) {
    const r = await supabase.rpc("admin_link_counts", {
      p_query: params.q ?? null,
      p_customer: null,
      p_from: params.from ?? null,
      p_to: params.to ?? null,
      p_limit: 100,
      p_offset: 0,
    });
    counts = (r.data ?? []) as CountRow[];
    countsFailed = Boolean(r.error);
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Search · your mailbox only</span>
        <h1 className="h1">
          Find customer <em>emails.</em>
        </h1>
        <p className="lead">
          Searches the customer list (names, aliases, domains) and the customer contact addresses on your linked emails. Email subjects and
          content are not stored, so words from inside an email will not be found.
        </p>
      </div>

      <section className="card section">
        <form method="get" action="/search">
          <div className="form-row">
            <label htmlFor="q">Customer, domain or contact</label>
            <input id="q" name="q" type="search" defaultValue={params.q ?? ""} maxLength={100} placeholder="e.g. acme, acme.com, jane@" />
          </div>
          <div className="form-row">
            <label htmlFor="customer">Customer</label>
            <select id="customer" name="customer" defaultValue={params.customer ?? ""}>
              <option value="">Any customer</option>
              {customers.map((c) => (
                <option key={c.customer_id} value={c.customer_id}>
                  {c.customer_name} ({c.link_count})
                </option>
              ))}
            </select>
            <label htmlFor="direction">Direction</label>
            <select id="direction" name="direction" defaultValue={params.direction ?? ""}>
              <option value="">Both</option>
              <option value="inbound">From customer</option>
              <option value="outbound">To customer</option>
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="from">From (UTC)</label>
            <input id="from" name="from" type="date" defaultValue={params.from ?? ""} />
            <label htmlFor="to">To (UTC)</label>
            <input id="to" name="to" type="date" defaultValue={params.to ?? ""} />
            <label htmlFor="mailbox">Mailbox</label>
            <select id="mailbox" name="mailbox" defaultValue={params.mailbox ?? ""}>
              <option value="">My mailbox</option>
              <option value={user.email}>{user.email}</option>
            </select>
          </div>
          <div className="card-actions">
            <button type="submit" className="btn-primary">Search</button>
            <Link href="/search" className="small">Clear</Link>
          </div>
        </form>
      </section>

      {!parsed.ok ? (
        <p className="notice alert" role="alert">
          {parsed.errors.join(" ")}
        </p>
      ) : null}
      {failed ? (
        <p className="notice alert" role="alert">
          Search could not be completed. Check the filters and try again.
        </p>
      ) : null}

      {parsed.ok && !failed ? (
        <section className="card section">
          <span className="eyebrow">
            {rows.length === 0 ? "No results" : `${rows.length}${next ? "+" : ""} results`}
            {params.cursor ? " · later page" : ""}
          </span>
          {rows.length === 0 ? (
            <p className="small">
              Nothing matched. Remember that only customer names, aliases, domains and contact addresses are searchable, and only emails from
              your own mailbox appear here.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date (UTC)</th>
                    <th>Customer</th>
                    <th>Direction</th>
                    <th>Customer contact</th>
                    <th>Matched on</th>
                    <th>Open</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const href = gmailMessageUrl(r.gmail_message_id, r.mailbox_email);
                    return (
                      <tr key={r.link_id}>
                        <td>{fmt.format(new Date(r.message_at))}</td>
                        <td>{r.customer_name}</td>
                        <td>{r.direction === "inbound" ? "from customer" : "to customer"}</td>
                        <td className="small">{r.customer_addresses.join(", ") || "not stored"}</td>
                        <td className="small">{r.matched_on.length ? r.matched_on.join(", ") : "filters"}</td>
                        <td>
                          {href ? (
                            <a href={href} target="_blank" rel="noreferrer noopener">
                              Gmail
                            </a>
                          ) : (
                            "n/a"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="card-actions">
            {params.cursor ? <Link href={pageHref(params)} className="small">First page</Link> : null}
            {next ? <Link href={pageHref(params, next)} className="btn-secondary">Next page</Link> : null}
          </div>
          <p className="fine">
            Gmail links open only when you are signed in to {myMailbox ?? "your own mailbox"} in this browser.
          </p>
        </section>
      ) : null}

      {user.role === "admin" && parsed.ok ? (
        <section className="card section">
          <span className="eyebrow">Admin · counts only, all mailboxes combined</span>
          <h3>Linked emails per customer</h3>
          <p className="small">
            Totals across every scanned mailbox for the search text and dates above. No individual emails, addresses or per-mailbox figures are
            shown to admins.
          </p>
          {countsFailed ? (
            <p className="notice alert" role="alert">Counts could not be loaded.</p>
          ) : counts.length === 0 ? (
            <p className="small">No linked emails match.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Linked emails</th>
                    <th>Mailboxes</th>
                  </tr>
                </thead>
                <tbody>
                  {counts.map((c) => (
                    <tr key={c.customer_id}>
                      <td>{c.customer_name}</td>
                      <td>{c.link_count}</td>
                      <td>{c.mailbox_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
