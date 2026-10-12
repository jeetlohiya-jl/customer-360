/**
 * OAuth scopes requested at sign-in.
 *
 * Sign-in only proves identity. Mailbox access is a separate, later step
 * (Phase 2, behind FEATURE_GMAIL) with its own OAuth client and consent.
 */
export const SIGN_IN_SCOPES = ["openid", "email", "profile"] as const;

const GMAIL_SCOPE_PATTERN = /googleapis\.com\/auth\/gmail|(^|\s)gmail\./i;

export function containsGmailScope(scopes: readonly string[] | string): boolean {
  const list = typeof scopes === "string" ? scopes.split(/\s+/) : scopes;
  return list.some((s) => GMAIL_SCOPE_PATTERN.test(s));
}

/** Throws if anything other than identity scopes is requested. */
export function signInScopeString(): string {
  if (containsGmailScope(SIGN_IN_SCOPES)) {
    throw new Error("Gmail scopes must never be requested at sign-in");
  }
  return SIGN_IN_SCOPES.join(" ");
}
