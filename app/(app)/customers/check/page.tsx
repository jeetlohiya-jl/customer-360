import Link from "next/link";
import { requireAdmin } from "@/lib/auth/session";
import { NameCheck } from "./name-check";

export default async function CheckPage() {
  await requireAdmin();
  return (
    <>
      <div className="page-head">
        <span className="eyebrow">
          <Link href="/customers">Customers</Link> · Check names
        </span>
        <h1 className="h1">
          Test the <em>matching rules.</em>
        </h1>
        <p className="lead">
          Paste customer names or email addresses, one per line (for example from a sales sheet). Nothing is saved unless you send uncertain names to the review queue. No Gmail is read.
        </p>
      </div>
      <NameCheck />
    </>
  );
}
