import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { signOut } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="shell">
      <header className="topbar">
        <nav>
          <Link href="/dashboard" className="brand">
            Customer 360
          </Link>
          <Link href="/dashboard">Dashboard</Link>
          {user.role === "admin" ? <Link href="/admin">Admin</Link> : null}
        </nav>
        <div className="who">
          <span>{user.email}</span>
          <span className="badge">{user.role}</span>
          <form action={signOut}>
            <button type="submit" className="link">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}
