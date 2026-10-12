import { requireAdmin } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { changeRole } from "../actions";

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
  const [{ data: users }, { data: audit }] = await Promise.all([
    supabase.from("app_users").select("id, email, role, status, created_at").order("email").limit(200),
    supabase.rpc("recent_audit", { max_rows: 50 }),
  ]);

  return (
    <>
      <h1>Admin</h1>
      {error ? (
        <p className="alert" role="alert">
          Could not complete that change: {error}
        </p>
      ) : null}
      {ok ? <p className="ok">Role updated.</p> : null}

      <section className="card">
        <h2>Users</h2>
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
                    <button type="submit" disabled={u.id === me.id}>
                      Save
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Recent audit events</h2>
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
      </section>
    </>
  );
}
