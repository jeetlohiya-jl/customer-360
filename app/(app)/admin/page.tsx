import { requireAdmin } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { changeRole } from "../actions";
import { getExtractConfig } from "@/lib/extract/config";
import { retryFailedExtraction } from "../facts/actions";

type UserRow = { id: string; email: string; role: string; status: string; created_at: string };
type AuditRow = { id: number; at: string; action: string; target: string | null; actor_email: string | null };

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const me = await requireAdmin();
  const { error, ok } = await searchParams;
  const supabase = await createSupabaseServerClient();

  // Both reads are bounded and go through RLS (admins only).
  const [{ data: users }, { data: audit }, { data: scans }] = await Promise.all([
    supabase.from("app_users").select("id, email, role, status, created_at").order("email").limit(200),
    supabase.rpc("recent_audit", { max_rows: 50 }),
    supabase.rpc("scan_jobs_overview"),
  ]);
  const extractOn = getExtractConfig().enabled;
  const { data: extraction } = extractOn ? await supabase.rpc("extraction_overview") : { data: null };
  const { data: failuresData } = extractOn ? await supabase.rpc("extraction_failures") : { data: null };
  const failures = (failuresData ?? []) as { code: string; failed: number; retrying: number }[];
  type ExtractRow = { month: string; cap_usd: number; spent_usd: number; reserved_usd: number; paused: boolean; pending: number; extracted: number; skipped: number; failed: number; needs_reconnect: number; facts_auto: number; facts_needs_review: number; facts_reviewed: number };
  const ex = ((extraction ?? []) as ExtractRow[])[0];
  type ScanRow = { mailbox_email: string; status: string; created_at: string; finished_at: string | null; enumerated: number; matched: number; in_review: number; unmatched: number; failed: number; excluded: number };

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Admin</span>
        <h1 className="h1">
          People and <em>access.</em>
        </h1>
      </div>
      {error ? (
        <p className="notice alert" role="alert">
          Could not complete that change: {error}
        </p>
      ) : null}
      {ok ? <p className="notice">Role updated.</p> : null}

      <section className="card section">
        <span className="eyebrow">01 · Users</span>
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Change role</th>
            </tr>
          </thead>
          <tbody>
            {((users ?? []) as UserRow[]).map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>{u.status}</td>
                <td>
                  <form action={changeRole} className="inline">
                    <input type="hidden" name="userId" value={u.id} />
                    <select name="role" defaultValue={u.role} aria-label={`Role for ${u.email}`}>
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                    <button type="submit" className="btn-secondary" disabled={u.id === me.id}>
                      Save
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>

      <section className="card section">
        <span className="eyebrow">Mailbox scans · counts only</span>
        <p className="small">Admins see how each scan is progressing, never which emails were linked.</p>
        {((scans ?? []) as ScanRow[]).length === 0 ? (
          <p className="small mt-16">No scans yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Mailbox</th>
                  <th>Status</th>
                  <th>Examined</th>
                  <th>Linked</th>
                  <th>Review</th>
                  <th>No customer</th>
                  <th>Excluded</th>
                  <th>Failed</th>
                </tr>
              </thead>
              <tbody>
                {((scans ?? []) as ScanRow[]).map((j) => (
                  <tr key={`${j.mailbox_email}-${j.created_at}`}>
                    <td>{j.mailbox_email}</td>
                    <td>{j.status}</td>
                    <td>{j.enumerated}</td>
                    <td>{j.matched}</td>
                    <td>{j.in_review}</td>
                    <td>{j.unmatched}</td>
                    <td>{j.excluded}</td>
                    <td>{j.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {extractOn && ex ? (
        <section className="card section">
          <span className="eyebrow">Fact extraction · counts only</span>
          <div className="stats mt-16">
            <span className="stat"><strong>${Number(ex.spent_usd).toFixed(2)}</strong>of ${Number(ex.cap_usd).toFixed(0)} this month{ex.paused ? " (paused)" : ""}</span>
            <span className="stat"><strong>{ex.extracted}</strong>emails processed</span>
            <span className="stat"><strong>{ex.pending}</strong>waiting</span>
            <span className="stat"><strong>{ex.skipped}</strong>skipped</span>
            <span className="stat"><strong>{ex.failed}</strong>failed</span>
            <span className="stat"><strong>{ex.needs_reconnect}</strong>need reconnect</span>
            <span className="stat"><strong>{ex.facts_needs_review}</strong>facts to review</span>
          </div>
          {failures.length ? (
            <div className="table-wrap mt-16">
              <table>
                <thead><tr><th>Error code</th><th>Failed</th><th>Retrying</th></tr></thead>
                <tbody>{failures.map((x) => <tr key={x.code}><td><code>{x.code}</code></td><td>{x.failed}</td><td>{x.retrying}</td></tr>)}</tbody>
              </table>
            </div>
          ) : null}
          {ex.failed ? (
            <form action={retryFailedExtraction} className="card-actions"><button type="submit" className="btn-secondary">Retry failed emails</button></form>
          ) : null}
        </section>
      ) : null}

      <section className="card section">
        <span className="eyebrow">02 · Recent audit events</span>
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When (UTC)</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {((audit ?? []) as AuditRow[]).map((a) => (
              <tr key={a.id}>
                <td>{new Date(a.at).toISOString().replace("T", " ").slice(0, 19)}</td>
                <td>{a.actor_email ?? "system"}</td>
                <td>{a.action}</td>
                <td>{a.target ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>
    </>
  );
}
