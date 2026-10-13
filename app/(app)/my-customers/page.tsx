import { requireUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { gmailMessageUrl } from "@/lib/search/params";

type Link = {
  customer_id: string;
  customer_name: string;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  message_at: string;
  direction: "inbound" | "outbound";
  customer_addresses: string[];
  evidence: { type: string; value: string }[];
  link_status: string;
};

const EVIDENCE: Record<string, string> = {
  E1: "approved address",
  E2: "verified domain",
  E3: "customer name",
  review: "reviewer decision",
};

const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });

/** The signed-in employee's OWN customer-linked emails. Nobody else's are reachable here. */
export default async function MyCustomersPage() {
  const user = await requireUser();
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.rpc("my_message_links", { p_customer: null, p_limit: 1000 });
  const links = (data ?? []) as Link[];

  const byCustomer = new Map<string, { name: string; links: Link[] }>();
  for (const l of links) {
    const g = byCustomer.get(l.customer_id) ?? { name: l.customer_name, links: [] };
    g.links.push(l);
    byCustomer.set(l.customer_id, g);
  }
  const groups = [...byCustomer.values()].sort((a, b) => b.links.length - a.links.length);

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Your mailbox</span>
        <h1 className="h1">
          Your customer-linked <em>emails.</em>
        </h1>
        <p className="lead">
          References only: which customer, when, which direction and why it matched. No subjects or content are stored. Only you can see this list.
        </p>
      </div>
      {groups.length === 0 ? (
        <p className="small">Nothing yet. Results appear here after a scan of your mailbox.</p>
      ) : (
        groups.map((g) => (
          <section className="card section" key={g.name}>
            <span className="eyebrow">{g.links.length} emails · latest {fmt.format(new Date(g.links[0].message_at))}</span>
            <h3>{g.name}</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date (UTC)</th>
                    <th>Direction</th>
                    <th>Customer contact</th>
                    <th>Matched by</th>
                    <th>Open</th>
                  </tr>
                </thead>
                <tbody>
                  {g.links.slice(0, 50).map((l) => (
                    <tr key={l.gmail_message_id}>
                      <td>{fmt.format(new Date(l.message_at))}</td>
                      <td>{l.direction === "inbound" ? "from customer" : "to customer"}</td>
                      <td className="small">{l.customer_addresses.join(", ") || "not stored"}</td>
                      <td className="small">{l.evidence.map((e) => `${EVIDENCE[e.type] ?? e.type}: ${e.value}`).join("; ")}</td>
                      <td>
                        {gmailMessageUrl(l.gmail_message_id, user.email) ? (
                          <a href={gmailMessageUrl(l.gmail_message_id, user.email) ?? undefined} target="_blank" rel="noreferrer noopener">
                            Gmail
                          </a>
                        ) : (
                          "n/a"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {g.links.length > 50 ? <p className="fine">Showing the latest 50 of {g.links.length}.</p> : null}
            </div>
          </section>
        ))
      )}
    </>
  );
}
