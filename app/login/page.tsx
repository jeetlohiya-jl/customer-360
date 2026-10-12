import { signInWithGoogle } from "./actions";

const MESSAGES: Record<string, string> = {
  domain: "Only Cirkla Google Workspace accounts can sign in.",
  inactive: "Your access is not active. Ask an administrator.",
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
    <main className="center">
      <div className="card narrow">
        <h1>Customer 360</h1>
        <p className="muted">Sign in with your Cirkla Google Workspace account.</p>
        {message ? (
          <p className="alert" role="alert">
            {message}
          </p>
        ) : null}
        <form action={signInWithGoogle}>
          <button type="submit" className="primary">
            Sign in with Google
          </button>
        </form>
        <p className="fine">Sign-in reads your name and email only. It does not access your mailbox.</p>
      </div>
    </main>
  );
}
