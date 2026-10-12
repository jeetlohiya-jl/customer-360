/**
 * Workspace membership checks. Pure functions so they can be unit-tested.
 *
 * Two independent checks must both pass:
 *  1. The verified email address is exactly <local>@<workspace domain>
 *     (no subdomains, no look-alike suffixes).
 *  2. Google's hosted-domain ("hd") claim equals the workspace domain. This
 *     proves the account is managed by the Cirkla Google Workspace, not a
 *     consumer Google account that happens to use a company address.
 *
 * The database enforces the same rules in a trigger on auth.users
 * (supabase/migrations/0002_identity.sql), so a bypass of this code still
 * cannot create a user.
 */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isWorkspaceEmail(email: string | null | undefined, domain: string): boolean {
  if (!email) return false;
  const normalized = normalizeEmail(email);
  const parts = normalized.split("@");
  if (parts.length !== 2) return false;
  const [local, host] = parts;
  if (!local || !host) return false;
  if (/\s/.test(normalized)) return false;
  return host === domain.trim().toLowerCase();
}

/** Minimal shape of the Supabase user object fields we rely on. */
export interface AuthUserLike {
  email?: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: { provider?: string; providers?: string[] } | null;
  user_metadata?: { custom_claims?: { hd?: string } | null; hd?: string } | null;
}

export type WorkspaceCheckFailure =
  | "no_email"
  | "email_not_verified"
  | "wrong_provider"
  | "wrong_email_domain"
  | "missing_hosted_domain"
  | "wrong_hosted_domain";

export type WorkspaceCheckResult = { ok: true } | { ok: false; reason: WorkspaceCheckFailure };

export function hostedDomainOf(user: AuthUserLike): string | undefined {
  const hd = user.user_metadata?.custom_claims?.hd ?? user.user_metadata?.hd;
  return typeof hd === "string" ? hd.trim().toLowerCase() : undefined;
}

export function checkWorkspaceUser(user: AuthUserLike, domain: string): WorkspaceCheckResult {
  const wanted = domain.trim().toLowerCase();
  if (!user.email) return { ok: false, reason: "no_email" };
  if (!user.email_confirmed_at) return { ok: false, reason: "email_not_verified" };
  if (user.app_metadata?.provider !== "google") return { ok: false, reason: "wrong_provider" };
  if (!isWorkspaceEmail(user.email, wanted)) return { ok: false, reason: "wrong_email_domain" };
  const hd = hostedDomainOf(user);
  if (!hd) return { ok: false, reason: "missing_hosted_domain" };
  if (hd !== wanted) return { ok: false, reason: "wrong_hosted_domain" };
  return { ok: true };
}
