"use client";

import Link from "next/link";
import { useActionState } from "react";
import { checkNamesAction, queueUncertainAction, type CheckState } from "../actions";

const LABEL = { link: "Links", review: "Review", none: "No match" } as const;
const EVIDENCE: Record<string, string> = {
  E1: "approved address",
  E2: "verified domain",
  "E2-shared": "shared domain",
  E3: "exact name",
  "E3-generic": "generic name",
  E4: "similar spelling",
  E5: "look-alike domain",
};

export function NameCheck() {
  const [checkState, check, checking] = useActionState<CheckState, FormData>(checkNamesAction, {});
  const [queueState, queue, queueing] = useActionState<CheckState, FormData>(queueUncertainAction, {});
  const results = checkState.results ?? [];
  const reviewCount = results.filter((r) => r.decision.outcome === "review").length;

  return (
    <>
      <section className="card section">
        <form action={check}>
          <textarea name="text" defaultValue={checkState.text ?? ""} required maxLength={50000} aria-label="Names or emails, one per line" placeholder={"Acme Packaging Ltd\nACME PACKAGNG\norders@acmepack.com"} />
          <div className="card-actions">
            <button type="submit" className="btn-primary" disabled={checking}>{checking ? "Checking…" : "Check"}</button>
            <span className="fine">Up to 500 lines.</span>
          </div>
        </form>
        {checkState.error ? <p className="notice alert mt-16" role="alert">{checkState.error}</p> : null}
      </section>

      {results.length ? (
        <section className="card section">
          <div className="stats">
            <span className="stat"><strong>{results.filter((r) => r.decision.outcome === "link").length}</strong>link</span>
            <span className="stat"><strong>{reviewCount}</strong>review</span>
            <span className="stat"><strong>{results.filter((r) => r.decision.outcome === "none").length}</strong>no match</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Result</th>
                  <th>Matched</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i}>
                    <td>{r.line}</td>
                    <td>
                      <span className={`outcome-${r.decision.outcome}`}>{LABEL[r.decision.outcome]}</span>
                      <div className="fine">{r.decision.reason}</div>
                    </td>
                    <td className="small">
                      {r.matches.map((m, j) => (
                        <div key={j}>
                          {m.customer} <span className="fine">· {EVIDENCE[m.evidence] ?? m.evidence} · &quot;{m.observed}&quot;{m.evidence === "E4" ? ` · ${m.score}` : ""}</span>
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {reviewCount ? (
            <form action={queue} className="card-actions">
              <input type="hidden" name="text" value={checkState.text ?? ""} />
              <button type="submit" className="btn-secondary" disabled={queueing}>
                {queueing ? "Sending…" : `Send uncertain names to the review queue`}
              </button>
              <span className="fine">Only single-customer name matches are queued; lines naming two customers are not.</span>
            </form>
          ) : null}
          {queueState.queued ? (
            <p className="notice mt-16" role="status">
              {queueState.queued.queued} sent to the <Link href="/customers/review">review queue</Link>; {queueState.queued.skipped} not queued.
            </p>
          ) : null}
          {queueState.error ? <p className="notice alert mt-16" role="alert">{queueState.error}</p> : null}
        </section>
      ) : null}
    </>
  );
}
