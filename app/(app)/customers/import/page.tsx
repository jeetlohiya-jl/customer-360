import Link from "next/link";
import { requireAdmin } from "@/lib/auth/session";
import { ImportForm } from "./import-form";

export default async function ImportPage() {
  await requireAdmin();
  return (
    <>
      <div className="page-head">
        <span className="eyebrow">
          <Link href="/customers">Customers</Link> · Import
        </span>
        <h1 className="h1">
          Import the <em>customer list.</em>
        </h1>
        <p className="lead">
          Upload a CSV. You will see every row checked before anything is saved, and the import is all or nothing.
        </p>
      </div>
      <section className="card cream section">
        <span className="eyebrow">CSV columns</span>
        <p className="small">
          <code>canonical_name</code> is required. Optional: <code>legal_names</code>, <code>trading_names</code>, <code>aliases</code>,{" "}
          <code>domains</code>, <code>shared_domains</code>, <code>emails</code>, <code>notes</code>, <code>status</code> (active or inactive).
          Separate several values in one cell with <code>;</code>. Maximum 5,000 rows, 2 MB.
        </p>
        <pre className="mono mt-16">
          canonical_name,aliases,domains,emails,notes{"\n"}Acme Packaging Limited,Acme Pack;APL,acmepack.com,orders@acmepack.com,Ohio processor
        </pre>
      </section>
      <ImportForm />
    </>
  );
}
