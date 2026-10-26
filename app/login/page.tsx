import { signInWithGoogle } from "./actions";

const MESSAGES: Record<string, string> = {
  domain: "Only Cirkla Google Workspace accounts can sign in.",
  inactive: "Your access is not active. Ask a Customer 360 admin.",
  not_invited: "Customer 360 is invite-only. Ask a Customer 360 admin to invite you, then sign in again.",
  oauth_start: "Sign-in could not start. Try again.",
  callback: "Sign-in did not complete. Try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message = error ? (MESSAGES[error] ?? MESSAGES.callback) : null;

  return (
    <main className="signin">
      <div className="signin-card">
        <span className="eyebrow-chip">
          <span className="dot" />
          Internal · Cirkla Google Workspace
        </span>
        <h1 className="display">
          Customer <em>360.</em>
        </h1>
        <p className="lead">Customer knowledge from Cirkla&apos;s email, in one place.</p>
        {message ? (
          <p className="notice alert" role="alert">
            {message}
          </p>
        ) : null}
        <form action={signInWithGoogle}>
          <button type="submit" className="btn-primary btn-block">
            Sign in with Google
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 7h10m0 0L7 2m5 5L7 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </form>
        <p className="fine">Signing in reads your name and email only. Mailbox access is a separate step you choose later.</p>
      </div>
    </main>
  );
}
