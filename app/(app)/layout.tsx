import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { signOut } from "./actions";

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
