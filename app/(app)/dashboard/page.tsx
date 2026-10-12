import { requireUser } from "@/lib/auth/session";
import { PHASE, featureSummary } from "@/lib/features";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser();
  const { error } = await searchParams;
  const features = featureSummary();

  return (
    <>
      <h1>Dashboard</h1>
      {error === "forbidden" ? (
        <p className="alert" role="alert">
          That page is for administrators.
        </p>
      ) : null}
      <div className="grid">
        <section className="card">
          <h2>Your account</h2>
          <dl>
            <dt>Email</dt>
            <dd>{user.email}</dd>
            <dt>Role</dt>
            <dd>{user.role}</dd>
            <dt>Status</dt>
            <dd>{user.status}</dd>
          </dl>
        </section>
        <section className="card">
          <h2>Build status</h2>
          <dl>
            <dt>Phase</dt>
            <dd>{PHASE}: skeleton, sign-in, secure configuration</dd>
            <dt>Gmail</dt>
            <dd>
              <span className="badge off">{features.gmail}</span> No mailbox access in this phase
            </dd>
            <dt>Slack</dt>
            <dd>
              <span className="badge off">{features.slack}</span> Not connected
            </dd>
          </dl>
        </section>
      </div>
    </>
  );
}
