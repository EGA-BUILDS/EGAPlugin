import type { OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";

export type AuthzFailure = "owner" | "scope" | "audience" | "expired";

/**
 * Re-checks the authorization context that the OAuth provider attached to a
 * protected request. `OAuthProvider.requiredScopes` is advertised, not enforced,
 * so the MCP handler must verify the owner subject, scope, resource audience and
 * expiry itself on every call.
 */
export function authzFailure(
  ctx: {
    props?: { githubUserId?: unknown };
    auth?: OAuthResourceAuth;
  },
  ownerId: string,
  resource: string,
  requiredScope: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): AuthzFailure | null {
  const subject = String(ctx.props?.githubUserId ?? "");
  if (subject === "" || subject !== String(ownerId)) return "owner";

  const scopes = Array.isArray(ctx.auth?.scope) ? ctx.auth.scope : [];
  if (!scopes.includes(requiredScope)) return "scope";

  if (ctx.auth?.audience !== resource) return "audience";

  const expiresAt = ctx.auth?.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= nowSeconds) {
    return "expired";
  }

  return null;
}
