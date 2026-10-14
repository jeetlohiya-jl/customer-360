import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { signOut } from "./actions";
import { getExtractConfig } from "@/lib/extract/config";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div>
      <header className="topbar">
        <nav>
          <Link href="/dashboard" className="brand">
            <span className="brand-mark">Cirkla</span>
            <span className="brand-name">
              Customer <em>360</em>
            </span>
          </Link>
          <Link href="/dashboard" className="navlink">
            Dashboard
          </Link>
          <Link href="/my-customers" className="navlink">
            My customer emails
          </Link>
          <Link href="/search" className="navlink">
            Search
          </Link>
          {getExtractConfig().enabled ? (
            <Link href="/facts" className="navlink">
              Customer facts
            </Link>
          ) : null}
          {user.role === "admin" ? (
            <>
              <Link href="/customers" className="navlink">
                Customers
              </Link>
              <Link href="/admin" className="navlink">
                Admin
              </Link>
            </>
          ) : null}
        </nav>
        <div className="who">
          <span>{user.email}</span>
          <span className="pill">{user.role}</span>
          <form action={signOut}>
            <button type="submit" className="btn-ghost">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}
