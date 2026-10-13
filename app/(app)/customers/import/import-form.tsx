"use client";

import Link from "next/link";
import { useActionState } from "react";
import { commitImportAction, previewImportAction, type ImportState } from "../actions";

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  update: "Adds to existing",
  possible_duplicate: "Possible duplicate",
  rejected: "Rejected",
};

export function ImportForm() {
  const [previewState, preview, previewing] = useActionState<ImportState, FormData>(previewImportAction, {});
  const [commitState, commit, committing] = useActionState<ImportState, FormData>(commitImportAction, {});

  if (commitState.done) {
    const d = commitState.done;
    return (
      <section className="card section">
        <p className="notice" role="status">
          Import complete: {d.created} created, {d.updated} updated, {d.aliases_added} names and {d.identifiers_added} domains or emails added,{" "}
          {d.distinctions_added} pairs marked as different businesses. {d.skipped} skipped, {d.rejected} rejected rows not imported.
        </p>
        <Link href="/customers" className="btn-primary">View customers</Link>
      </section>
    );
  }

  // After a failed commit, show the re-checked preview from the commit.
  const state = commitState.preview && commitState.csv === previewState.csv ? commitState : previewState;
  const p = state.preview;

  return (
    <>
      <section className="card section">
        <span className="eyebrow">01 · Choose a file</span>
        <form action={preview} className="form-row">
          <input type="file" name="file" accept=".csv,text/csv" required aria-label="Customer CSV file" />
          <button type="submit" className="btn-secondary" disabled={previewing}>
            {previewing ? "Checking…" : "Check file"}
          </button>
        </form>
        {previewState.error ? <p className="notice alert mt-16" role="alert">{previewState.error}</p> : null}
      </section>

      {p && state.csv ? (
        <section className="card section">
          <span className="eyebrow">02 · Review before saving · {state.fileName}</span>
          {p.fileErrors.length ? (
            <p className="notice alert mt-16" role="alert">{p.fileErrors.join(" ")}</p>
          ) : (
            <form action={commit}>
              <input type="hidden" name="csv" value={state.csv} />
              <div className="stats">
                <span className="stat"><strong>{p.summary.new}</strong>new</span>
                <span className="stat"><strong>{p.summary.update}</strong>add to existing</span>
                <span className="stat"><strong>{p.summary.possible_duplicate}</strong>possible duplicates</span>
                <span className="stat"><strong>{p.summary.rejected}</strong>rejected</span>
              </div>
              {p.ignoredColumns.length ? <p className="small">Ignored columns: {p.ignoredColumns.join(", ")}.</p> : null}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th>Customer</th>
                      <th>Result</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.rows.map((r) => (
                      <tr key={r.line}>
                        <td className="mono">{r.line}</td>
                        <td>
                          {r.canonicalName || <span className="small">(no name)</span>}
                          {r.names.length ? <div className="fine">also: {r.names.map((n) => n.value).join(", ")}</div> : null}
                          {r.domains.length || r.emails.length ? (
                            <div className="fine">{[...r.domains.map((d) => d.value + (d.shared ? " (shared)" : "")), ...r.emails].join(", ")}</div>
                          ) : null}
                        </td>
                        <td>
                          <span className={r.status === "rejected" ? "pill warn" : r.status === "possible_duplicate" ? "pill warn" : "pill"}>
                            {STATUS_LABEL[r.status]}
                          </span>
                        </td>
                        <td>
                          {r.errors.length ? <ul className="row-errors">{r.errors.map((e) => <li key={e}>{e}</li>)}</ul> : null}
                          {r.warnings.length ? <ul className="row-warnings">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
                          {r.status === "possible_duplicate" ? (
                            <>
                              <ul className="row-warnings">
                                {r.candidates.map((c) => (
                                  <li key={`${c.customerId ?? c.line}`}>Similar to {c.line ? `line ${c.line}` : "existing"}: {c.name} ({c.reason})</li>
                                ))}
                              </ul>
                              <select name={`decision_${r.line}`} defaultValue="" required aria-label={`Decision for line ${r.line}`} className="mt-16">
                                <option value="" disabled>Choose…</option>
                                <option value="create">Different business: create it</option>
                                {r.candidates.filter((c) => c.customerId).map((c) => (
                                  <option key={c.customerId} value={`merge:${c.customerId}`}>Same as {c.name}: add as its alias</option>
                                ))}
                                <option value="skip">Skip this row</option>
                              </select>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {commitState.error ? <p className="notice alert mt-16" role="alert">{commitState.error}</p> : null}
              <div className="card-actions">
                <button type="submit" className="btn-primary" disabled={committing}>
                  {committing ? "Importing…" : "Import accepted rows"}
                </button>
                <span className="fine">Rejected rows are left out. Fix them in the file and import it again at any time.</span>
              </div>
            </form>
          )}
        </section>
      ) : null}
    </>
  );
}
